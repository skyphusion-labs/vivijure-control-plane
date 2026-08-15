import { TEST_VPC_DOORS } from "./door-fixture";
// cp#137 remediation: the RunPod rebuild path (src/tenant-runpod-reprovision.ts).
//
// WHAT THESE PROVE AND WHAT THEY DO NOT. Fakes stand in for Cloudflare and RunPod, so this suite
// proves the STEP MACHINE and the CUSTODY rules: what order things happen in, which writes land,
// which refusals fire, and that no secret reaches a store, a log, or an error. It is NOT evidence
// that the CF settings PATCH or the RunPod template PATCH are shaped right on the wire -- only the
// live run against the real account proves that, and it is called out in the PR rather than implied
// by a green suite here.
//
// BIAS: every guard is watched REFUSING, and each refusal targets the real path rather than a
// stand-in that could not have succeeded anyway. Every negative assertion is paired with a POSITIVE
// CONTROL, because a suite where everything refuses reads green while the feature is dead.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CfApi } from "../src/cf-api";
import type { ProvisionDeps } from "../src/provisioner";
import {
  preflightRunPodReprovision,
  redactSecrets,
  reprovisionTenantRunPod,
  ReprovisionError,
  type ReprovisionContext,
} from "../src/tenant-runpod-reprovision";
import type { Tenant } from "../src/store";
import { kekRing, encryptStudioToken } from "../src/token-crypto";
import { MemoryStore, recordingStore } from "./memory-store";

/** The two values that must never escape. Distinctive on purpose: a grep over any output finds them. */
const KEY_A = "rpa_KEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const R2_TOKEN_VALUE = "R2TOKENVALUE_SUPERSECRET_0123456789";

const KEK = btoa("0123456789abcdef0123456789abcdef");
const R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";

const ENDPOINTS_NEW = [
  { key: "backend", label: "Render", id: "new-backend", name: "vivijure-hero-backend", endpointVar: "RUNPOD_ENDPOINT_ID" },
  { key: "upscale", label: "Upscale", id: "new-upscale", name: "vivijure-hero-upscale", endpointVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { key: "lipsync", label: "Lip sync", id: "new-lipsync", name: "vivijure-hero-lipsync", endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID" },
  { key: "audio-upscale", label: "Audio", id: "new-audio", name: "vivijure-hero-audio-upscale", endpointVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
];

/** What the record claimed before the rebuild: the cp#137 situation, four ids RunPod does not have. */
const ENDPOINTS_DEAD = ENDPOINTS_NEW.map((e) => ({ ...e, id: `dead-${e.key}` }));

const CONVERGED = [
  { key: "backend" as const, name: "vivijure-hero-backend", template_id: "tpl-1", image_before: "ghcr.io/skyphusion-labs/vivijure-backend:1.0.2", image_after: "ghcr.io/skyphusion-labs/vivijure-backend:1.0.11", changed: true },
];

/** Bindings a live tenant studio carries, as censused on the real one (cp#112). */
const BINDINGS_LIVE = [
  { type: "assets", name: "ASSETS" },
  { type: "d1", name: "DB" },
  { type: "r2_bucket", name: "R2_RENDERS" },
  { type: "plain_text", name: "AUTH_MODE" },
  { type: "plain_text", name: "R2_S3_BUCKET" },
  { type: "plain_text", name: "R2_S3_ENDPOINT" },
  { type: "ratelimit", name: "SPEND_RATE_LIMITER" },
  { type: "dispatch_namespace", name: "MODULE_DISPATCH" },
  { type: "vpc_service", name: "VIDEO_FINISH_VPC" },
  { type: "plain_text", name: "RUNPOD_ENDPOINT_ID" },
  { type: "plain_text", name: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { type: "plain_text", name: "MUSETALK_RUNPOD_ENDPOINT_ID" },
  { type: "plain_text", name: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
];
/** The four secrets a live tenant studio holds. Only two are in the binding census. */
const SECRETS_LIVE = ["R2_S3_ACCESS_KEY_ID", "R2_S3_SECRET_ACCESS_KEY", "RUNPOD_API_KEY", "STUDIO_API_TOKEN"];

let store: MemoryStore;
let calls: string[];
let logs: { event: string; fields: Record<string, unknown> }[];
let patched: { name: string; type: string; text?: string }[];

/**
 * The cp#137 situation, seeded through the STORE rather than hand-built: a tenant that finished
 * provisioning, is live, and whose four recorded endpoint ids RunPod no longer has. Built with the
 * store's own writers so the row is one the real code could have produced.
 */
async function liveTenant(over: Partial<Tenant> = {}): Promise<Tenant> {
  await store.createAccount("acct_1", "a@b.com");
  const t = await store.createTenant("ten_abc", "hero", "acct_1", "provisioning");
  await store.setTenantD1(t.id, "db-1");
  await store.setTenantBucket(t.id, "vivijure-tenant-hero");
  await store.setTenantR2Token(t.id, "old-token-id");
  await store.setTenantEndpoints(t.id, JSON.stringify(ENDPOINTS_DEAD));
  await store.setTenantScript(t.id, "tenant-hero-studio", "v1.10.0");
  await store.setTenantModulesRelease(t.id, "v1.6.0");
  await store.setTenantStudioToken(t.id, await encryptStudioToken(kekRing(KEK), "studio-token-plaintext"));
  await store.setTenantStatus(t.id, "live");
  const row = (await store.getTenantById(t.id)) as Tenant;
  if (over.status && over.status !== row.status) await store.setTenantStatus(t.id, over.status);
  return { ...row, ...over };
}

function fakeCf(over: Record<string, unknown> = {}) {
  return {
    getScriptBindings: vi.fn(async () => (calls.push("getScriptBindings"), BINDINGS_LIVE)),
    getScriptSecretNames: vi.fn(async () => (calls.push("getScriptSecretNames"), SECRETS_LIVE)),
    patchScriptSettings: vi.fn(async (_ns: string, _script: string, bindings: { name: string; type: string; text?: string }[]) => {
      calls.push("patchScriptSettings");
      patched = bindings;
    }),
    uploadUserWorker: vi.fn(async () => void calls.push("uploadUserWorker")),
    createDispatchNamespace: vi.fn(async () => void calls.push("createDispatchNamespace")),
    ...over,
  } as unknown as CfApi;
}

function deps(over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  const cf = fakeCf();
  return {
    store,
    cf,
    scriptUploadCf: cf,
    videoFinishServiceId: null,
    runpod: {
      createEndpoints: vi.fn(async () => (calls.push("createEndpoints"), ENDPOINTS_NEW)),
      convergeTemplateImages: vi.fn(async () => (calls.push("convergeTemplateImages"), CONVERGED)),
    },
    bundle: { fetch: vi.fn(async () => { throw new Error("the rebuild path must never fetch a STUDIO bundle"); }) },
    moduleBundle: {
      fetch: vi.fn(async () => ({
        mainModule: "index.js",
        moduleText: "export default {}",
        compatibilityDate: "2026-06-01",
        compatibilityFlags: ["nodejs_compat"],
      })),
    },
    tokenMinter: {
      mintBucketToken: vi.fn(async () => (calls.push("mintBucketToken"), { id: "fresh-token-id", value: R2_TOKEN_VALUE })),
      revoke: vi.fn(async () => void calls.push("revokeToken")),
      revokeByName: vi.fn(async () => true),
    },
    r2Endpoint: R2_ENDPOINT,
    now: () => 1_000_000,
    sleep: async () => {},
    fetch: (async () => { throw new Error("unit test made a real fetch"); }) as unknown as typeof fetch,
    namespace: "vivijure-tenants",
    moduleNamespace: "vivijure-tenant-modules",
    release: "v9.9.9-PLANE-DEFAULT",
    tenantScriptName: (slug: string) => `tenant-${slug}-studio`,
    kek: kekRing(KEK),
    spendDailyCeiling: "25",
    callTenantStudio: vi.fn(async (_script: string, init: { method: string; path: string }) => {
      calls.push(`studio:${init.method} ${init.path}`);
      if (init.path === "/api/modules/install") return { status: 201, text: "{}" };
      if (init.path === "/api/modules/installed") {
        return { status: 200, text: JSON.stringify({ modules: [{ name: "keyframe" }] }) };
      }
      return { status: 200, text: "ok" };
    }),
    callTenantModule: vi.fn(async () => ({ status: 200, text: JSON.stringify({ ready: true, module: "keyframe" }) })),
    vpcDoors: TEST_VPC_DOORS,
    log: (event: string, fields: Record<string, unknown>) => void logs.push({ event, fields }),
    ...over,
  } as unknown as ProvisionDeps;
}

const context = (over: Partial<ReprovisionContext> = {}): ReprovisionContext => ({
  script: "tenant-hero-studio",
  studioApiToken: "studio-token-plaintext",
  bucket: "vivijure-tenant-hero",
  modulesRelease: "v1.6.0",
  bundles: new Map(),
  recorded: ENDPOINTS_DEAD,
  ...over,
});

beforeEach(() => {
  store = new MemoryStore();
  calls = [];
  logs = [];
  patched = [];
});

describe("cp#137 rebuild: order and the record", () => {
  it("converges templates BEFORE creating endpoints, and mints the credential in between", async () => {
    const tenant = await liveTenant();
    const d = deps();

    const result = await reprovisionTenantRunPod(d, tenant, context(), KEY_A);

    // The ORDER is the design: a template still on a stale image decides what the rebuilt endpoint
    // runs, and the credential has to exist before either is written.
    expect(calls.indexOf("convergeTemplateImages")).toBeLessThan(calls.indexOf("mintBucketToken"));
    expect(calls.indexOf("mintBucketToken")).toBeLessThan(calls.indexOf("createEndpoints"));
    expect(calls.indexOf("createEndpoints")).toBeLessThan(calls.indexOf("patchScriptSettings"));
    // revoke-then-mint, so a re-run leaves no trail of live grants behind it.
    //
    // PRESENCE FIRST, THEN ORDER, and that is not belt-and-braces: indexOf returns -1 for a call
    // that never happened, and -1 is less than every real index, so an ordering assertion ALONE goes
    // green when the revoke is deleted outright. Caught by mutating the revoke away and watching
    // this test pass.
    expect(calls).toContain("revokeToken");
    expect(calls.indexOf("revokeToken")).toBeLessThan(calls.indexOf("mintBucketToken"));
    expect(d.tokenMinter.revoke).toHaveBeenCalledWith("old-token-id");

    expect(result.missing_bindings).toEqual([]);
    expect(result.missing_secrets).toEqual([]);
    expect(result.endpoints_after.map((e) => e.id)).toEqual(["new-backend", "new-upscale", "new-lipsync", "new-audio"]);
    expect(result.endpoints_before.map((e) => e.id)).toEqual([
      "dead-backend", "dead-upscale", "dead-lipsync", "dead-audio-upscale",
    ]);
    expect(result.previous_r2_token_revoked).toBe(true);
    expect(result.r2_token_id).toBe("fresh-token-id");
    // The record now names what RunPod actually has.
    const after = await store.getTenantById("ten_abc");
    expect(JSON.parse(after!.endpoints_json!).map((e: { id: string }) => e.id)).toEqual([
      "new-backend", "new-upscale", "new-lipsync", "new-audio",
    ]);
    expect(after!.r2_token_id).toBe("fresh-token-id");
  });

  it("writes awaiting_invoke_key FIRST, before anything is touched", async () => {
    const tenant = await liveTenant();
    const seen: string[] = [];
    const d = deps({
      runpod: {
        // Reads the row at the moment the first RunPod call happens. If the status write came later,
        // this would still say "live" -- a record claiming a capability mid-rewire, which is the exact
        // defect cp#137 is about.
        convergeTemplateImages: vi.fn(async () => {
          const row = await store.getTenantById("ten_abc");
          seen.push(row!.status);
          return CONVERGED;
        }),
        createEndpoints: vi.fn(async () => ENDPOINTS_NEW),
      },
    });

    const result = await reprovisionTenantRunPod(d, tenant, context(), KEY_A);

    expect(seen).toEqual(["awaiting_invoke_key"]);
    // And it STAYS there on success: the tenant cannot render until key B is re-minted for the new ids.
    expect(result.status).toBe("awaiting_invoke_key");
    expect((await store.getTenantById("ten_abc"))!.status).toBe("awaiting_invoke_key");
    expect(result.next_step).toContain("new-backend");
    expect(result.next_step).toContain("/invoke-key");
    // WHO performs it, asserted rather than left to prose drift (cp#169). The install route is
    // owner-authenticated, so an operator following this sentence with the admin token gets a 401.
    // The old wording said "POST it to ..." to a caller who cannot; this fails against that wording.
    expect(result.next_step).toContain("THE ACCOUNT OWNER");
    expect(result.next_step).toContain("owner-authenticated");
  });

  it("leaves the tenant at awaiting_invoke_key when a step dies, never at live or failed", async () => {
    const tenant = await liveTenant();
    const d = deps({
      runpod: {
        createEndpoints: vi.fn(async () => { throw new Error("RunPod said no"); }),
        convergeTemplateImages: vi.fn(async () => CONVERGED),
      },
    });

    await expect(reprovisionTenantRunPod(d, tenant, context(), KEY_A)).rejects.toThrow(ReprovisionError);
    const row = await store.getTenantById("ten_abc");
    expect(row!.status).toBe("awaiting_invoke_key");
    // The failure names the step an operator has to act on.
    await expect(reprovisionTenantRunPod(d, tenant, context(), KEY_A)).rejects.toMatchObject({
      step: "runpod_endpoints",
    });
  });

  it("refuses to record an empty endpoint set", async () => {
    const tenant = await liveTenant();
    const d = deps({
      runpod: { createEndpoints: vi.fn(async () => []), convergeTemplateImages: vi.fn(async () => CONVERGED) },
    });

    await expect(reprovisionTenantRunPod(d, tenant, context(), KEY_A)).rejects.toThrow(/no endpoints/i);
    // POSITIVE CONTROL: the record still names the OLD ids rather than an empty array. A blank
    // endpoints_json would make the tenant unresumable AND unreconcilable.
    const row = await store.getTenantById("ten_abc");
    expect(JSON.parse(row!.endpoints_json!)).toHaveLength(4);
  });
});

describe("cp#137 rebuild: the studio patch carries everything it does not replace", () => {
  it("inherits every binding and secret except the four vars and the two R2 secrets", async () => {
    const tenant = await liveTenant();

    await reprovisionTenantRunPod(deps(), tenant, context(), KEY_A);

    const byName = new Map(patched.map((b) => [b.name, b]));
    // THE ONE THAT MATTERS: RUNPOD_API_KEY (key B) and STUDIO_API_TOKEN are NOT in the binding
    // census, only in the secret list. A patch built from the bindings alone would silently DROP
    // them, and a dropped key B means a studio that cannot dispatch and cannot be repaired without
    // the customer re-pasting. Measured on a live probe (cp#112): an omitted binding is dropped.
    expect(byName.get("RUNPOD_API_KEY")).toEqual({ type: "inherit", name: "RUNPOD_API_KEY" });
    expect(byName.get("STUDIO_API_TOKEN")).toEqual({ type: "inherit", name: "STUDIO_API_TOKEN" });
    // Untouched platform bindings travel as inherit, so no value is handled here.
    expect(byName.get("DB")).toEqual({ type: "inherit", name: "DB" });
    expect(byName.get("VIDEO_FINISH_VPC")).toEqual({ type: "inherit", name: "VIDEO_FINISH_VPC" });
    expect(byName.get("SPEND_RATE_LIMITER")).toEqual({ type: "inherit", name: "SPEND_RATE_LIMITER" });
    // The four endpoint vars are REPLACED with the new ids, as plain_text (an id is not a secret).
    expect(byName.get("RUNPOD_ENDPOINT_ID")).toEqual({ type: "plain_text", name: "RUNPOD_ENDPOINT_ID", text: "new-backend" });
    expect(byName.get("MUSETALK_RUNPOD_ENDPOINT_ID")).toEqual({
      type: "plain_text", name: "MUSETALK_RUNPOD_ENDPOINT_ID", text: "new-lipsync",
    });
    // The R2 credential is replaced with the fresh mint, as secret_text.
    expect(byName.get("R2_S3_ACCESS_KEY_ID")).toEqual({
      type: "secret_text", name: "R2_S3_ACCESS_KEY_ID", text: "fresh-token-id",
    });
    expect(byName.get("R2_S3_SECRET_ACCESS_KEY")?.type).toBe("secret_text");
    // Nothing appears twice: a duplicate name in a settings PATCH is undefined behaviour.
    expect(patched.map((b) => b.name).length).toBe(new Set(patched.map((b) => b.name)).size);
  });

  it("refuses when the readback comes back short, rather than trusting the write", async () => {
    const tenant = await liveTenant();
    let reads = 0;
    const cf = fakeCf({
      // Second census (the readback) has lost a secret. The PATCH still answered 200.
      getScriptSecretNames: vi.fn(async () => (reads++ === 0 ? SECRETS_LIVE : SECRETS_LIVE.filter((s) => s !== "RUNPOD_API_KEY"))),
    });
    const d = deps({ cf, scriptUploadCf: cf });

    // REFUSES rather than reporting: a studio that just lost key B cannot render whatever happens
    // next, so the pass stops there instead of churning five module scripts on top of it.
    const caught = await reprovisionTenantRunPod(d, tenant, context(), KEY_A).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(ReprovisionError);
    expect((caught as ReprovisionError).step).toBe("studio_bindings");
    expect((caught as ReprovisionError).message).toContain("secrets lost: RUNPOD_API_KEY");
    // and it stopped BEFORE touching the modules
    expect(calls).not.toContain("uploadUserWorker");
  });

  it("refuses when an endpoint var did not land", async () => {
    const tenant = await liveTenant();
    let reads = 0;
    const cf = fakeCf({
      getScriptBindings: vi.fn(async () =>
        reads++ === 0 ? BINDINGS_LIVE : BINDINGS_LIVE.filter((b) => b.name !== "MUSETALK_RUNPOD_ENDPOINT_ID"),
      ),
    });
    const d = deps({ cf, scriptUploadCf: cf });

    const caught = await reprovisionTenantRunPod(d, tenant, context(), KEY_A).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(ReprovisionError);
    expect((caught as ReprovisionError).step).toBe("studio_bindings");
    expect((caught as ReprovisionError).message).toContain("endpoint vars absent: MUSETALK_RUNPOD_ENDPOINT_ID");
    expect(calls).not.toContain("uploadUserWorker");
  });

  it("re-uploads the modules at the TENANT's recorded release, never the plane default", async () => {
    const tenant = await liveTenant();
    const d = deps();

    const result = await reprovisionTenantRunPod(d, tenant, context(), KEY_A);

    expect(result.modules_release).toBe("v1.6.0");
    const fetches = (d.moduleBundle.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(fetches.length).toBeGreaterThan(0);
    // POSITIVE CONTROL on the negative: the plane default is a real string in this dep bundle, so
    // "never v9.9.9" is a claim the fixture could actually violate.
    expect(d.release).toBe("v9.9.9-PLANE-DEFAULT");
    expect(fetches).not.toContain("v9.9.9-PLANE-DEFAULT");
    expect(new Set(fetches)).toEqual(new Set(["v1.6.0"]));
  });
});

describe("cp#137 rebuild: custody", () => {
  it("never PASSES key A or the minted R2 secret to the store", async () => {
    const tenant = await liveTenant();
    // A recording proxy over every store call, because the point is not what the row ENDS UP
    // holding: a write-then-clear would pass a point-in-time read of the final state and still have
    // handed the secret to the store.
    const { store: recorded, journal } = recordingStore(store);
    const d = deps({ store: recorded });

    await reprovisionTenantRunPod(d, tenant, context(), KEY_A);

    const everything = journal.join("\n");
    // CONTROL FIRST: the proxy is recording, and it saw the writes this pass is supposed to make.
    // Without this, a broken proxy would make every assertion below vacuously true.
    expect(journal.some((c) => c.startsWith("setTenantEndpoints("))).toBe(true);
    expect(journal.some((c) => c.startsWith("setTenantR2Token("))).toBe(true);
    expect(everything).toContain("fresh-token-id");
    // The actual claim.
    expect(everything).not.toContain(KEY_A);
    expect(everything).not.toContain(R2_TOKEN_VALUE);
  });

  it("never writes key A or the minted secret into a log line", async () => {
    const tenant = await liveTenant();

    await reprovisionTenantRunPod(deps(), tenant, context(), KEY_A);

    const serialized = JSON.stringify(logs);
    // CONTROL: this pass DOES log, and logs the ids, so "no secret in the logs" is not just an
    // empty-log tautology.
    expect(logs.map((l) => l.event)).toContain("reprovision.done");
    expect(serialized).toContain("new-backend");
    expect(serialized).not.toContain(KEY_A);
    expect(serialized).not.toContain(R2_TOKEN_VALUE);
  });

  it("scrubs an upstream error that quotes the key back at us", async () => {
    const tenant = await liveTenant();
    const d = deps({
      runpod: {
        // Exactly what a chatty upstream does: echo the request it was given. RunPod's own error text
        // is passed through verbatim by design, so this is a live risk rather than a hypothetical.
        createEndpoints: vi.fn(async () => {
          throw new Error(`endpoints.create: 401 {"authorization":"Bearer ${KEY_A}","r2":"${R2_TOKEN_VALUE}"}`);
        }),
        convergeTemplateImages: vi.fn(async () => CONVERGED),
      },
    });

    const caught = await reprovisionTenantRunPod(d, tenant, context(), KEY_A).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(ReprovisionError);
    const message = (caught as ReprovisionError).message;
    // The CONTROL that makes this test discriminating: the scrubber must have actually fired. Without
    // it, a no-op redactSecrets would pass "does not contain the key" only if the fixture never
    // contained it in the first place.
    expect(message).toContain("[redacted]");
    expect(message).not.toContain(KEY_A);
    expect(message).not.toContain(R2_TOKEN_VALUE);
    // and the useful half of the upstream sentence survives
    expect(message).toContain("401");
    // the log line for the same failure is scrubbed too
    expect(JSON.stringify(logs)).not.toContain(KEY_A);
    expect(JSON.stringify(logs)).not.toContain(R2_TOKEN_VALUE);
  });

  it("redactSecrets ignores short and empty needles instead of redacting everything", () => {
    // A blank needle would match at every position and turn any message into noise; a 3-character
    // one would eat ordinary words. Both would make the scrubber useless in the direction that
    // matters (an unreadable error is as bad as a leaked one).
    expect(redactSecrets("nothing to hide", ["", null, undefined, "abc"])).toBe("nothing to hide");
    expect(redactSecrets(`before ${KEY_A} after`, [KEY_A])).toBe("before [redacted] after");
  });
});

describe("cp#137 rebuild: preflight refuses before writing anything", () => {
  const cases: { name: string; over: Partial<Tenant>; code: string }[] = [
    { name: "a deleted tenant", over: { deleted_at: "2026-07-01 00:00:00" }, code: "tenant_deleted" },
    { name: "a suspended tenant", over: { suspended_at: "2026-07-01 00:00:00" }, code: "tenant_suspended" },
    { name: "a tenant mid-provision", over: { status: "provisioning" }, code: "tenant_not_reprovisionable" },
    { name: "a tenant with no studio script", over: { script_name: null }, code: "not_provisioned" },
    // cp#288: this row was ABSENT until the proxy-binding work leaned on it. The refusal is what
    // makes `runpodMode` provably 'dedicated' at the runModuleSteps call below it, and nothing
    // gated it -- so the guard could have been removed by someone tidying with the suite still
    // green, and the proxy pair would then have been bound on a pooled tenant.
    { name: "a tenant on the shared pool", over: { runpod_mode: "shared" }, code: "tenant_on_shared_pool" },
    { name: "a tenant with no bucket", over: { r2_bucket_name: null }, code: "tenant_bucket_missing" },
    { name: "a tenant with no recorded module release", over: { modules_release: null }, code: "modules_release_unknown" },
    { name: "a tenant with no studio token", over: { studio_token_enc: null }, code: "tenant_studio_token_missing" },
  ];

  for (const c of cases) {
    it(`refuses ${c.name}`, async () => {
      const tenant = await liveTenant(c.over);
      const d = deps();

      const pre = await preflightRunPodReprovision(d, tenant);

      expect(pre.ok).toBe(false);
      expect(pre.ok === false && pre.refusal.code).toBe(c.code);
      // A refusal writes NOTHING: not a status, not a token, not a RunPod call.
      expect(calls.filter((x) => x !== "studio:GET /")).toEqual([]);
      expect((await store.getTenantById("ten_abc"))!.status).toBe(c.over.status ?? "live");
    });
  }

  it("refuses a studio that is not serving, and accepts one that is (positive control)", async () => {
    const tenant = await liveTenant();

    const broken = await preflightRunPodReprovision(
      deps({ callTenantStudio: vi.fn(async () => ({ status: 503, text: "down" })) }),
      tenant,
    );
    expect(broken.ok).toBe(false);
    expect(broken.ok === false && broken.refusal.code).toBe("tenant_studio_not_serving");

    // The control: the SAME preflight, same tenant, a studio that answers -> ok, with the tenant's
    // own release carried through. Without this, "refuses" could mean "always refuses".
    const good = await preflightRunPodReprovision(deps(), tenant);
    expect(good.ok).toBe(true);
    expect(good.ok === true && good.context.modulesRelease).toBe("v1.6.0");
    expect(good.ok === true && good.context.recorded.map((e) => e.id)).toEqual([
      "dead-backend", "dead-upscale", "dead-lipsync", "dead-audio-upscale",
    ]);
  });

  it("refuses when a module bundle is missing at the tenant's release", async () => {
    const tenant = await liveTenant();
    const d = deps({
      moduleBundle: { fetch: vi.fn(async () => { throw new Error("404 no such bundle"); }) },
    });

    const pre = await preflightRunPodReprovision(d, tenant);

    expect(pre.ok).toBe(false);
    expect(pre.ok === false && pre.refusal.code).toBe("module_bundle_unavailable");
    // Refused BEFORE the first RunPod write, which is the whole reason the fetch happens in preflight.
    expect(calls).not.toContain("convergeTemplateImages");
    expect(calls).not.toContain("mintBucketToken");
  });

  it("accepts a tenant already at awaiting_invoke_key, so a failed pass can be re-run", async () => {
    const tenant = await liveTenant({ status: "awaiting_invoke_key" });

    const pre = await preflightRunPodReprovision(deps(), tenant);

    expect(pre.ok).toBe(true);
  });
});
