// cp#164: the plane SETS the abuse-report URL the tenant studio panel READS.
//
// WHAT THIS SUITE IS FOR. vivijure-cf v1.10.0 ships the reader and this plane wrote the var
// nowhere, so the reader had nothing to read and no hosted tenant studio could show a reporter
// where to go. The discriminating tests below assert what the plane SENT -- to the provision
// upload and to the settings patch -- because that is the claim that fails against the behaviour
// the issue filed. A test that only read final state would pass against a plane that writes
// nothing, as long as something else had put the binding there.
//
// A NOTE ON METHOD, kept from cp#136 because it is what makes these worth running: every claim
// about what the plane does or does not send is made with a RECORDING PROXY over the write call,
// and each negative claim is paired with a POSITIVE CONTROL asserting the proxy records at all.
//
// WHAT THESE CANNOT PROVE, stated so a green run is not over-read: the CfApi here is a fake, so
// these prove the decision paths (what is sent, through which credential, what is refused, what a
// short readback or an absent reader does). They prove nothing about what Cloudflare does with the
// request; the settings-PATCH wire shape is measured in tests/cf-api-settings-patch.test.ts, and
// the live-probe facts it rests on (inherit preserves a secret_text binding, an omitted non-secret
// binding is DROPPED) were established on cp#112. The end-to-end claim -- host.abuse_report_url on
// a live tenant GET /api/modules -- is an ARTIFACT check against the testbed, recorded on the PR.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeEach, vi } from "vitest";
import type { CfApi, WorkerBinding } from "../src/cf-api";
import type { ControlPlaneEnv } from "../src/env";
import type { ProvisionDeps } from "../src/provisioner";
import type { Tenant } from "../src/store";
import { encryptStudioToken, kekRing } from "../src/token-crypto";
import {
  ABUSE_REPORT_ASSET,
  ABUSE_REPORT_PATH,
  ABUSE_REPORT_URL_VAR,
  READBACK_BUDGET_MS,
  abuseReportUrlBindings,
  applyAbuseReportUrl,
  hostedAbuseReportUrl,
  preflightAbuseReportUrl,
  withAbuseReportUrl,
} from "../src/tenant-abuse-report";
import { MemoryStore } from "./memory-store";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEK = btoa("0123456789abcdef0123456789abcdef");
const RING = kekRing(KEK);
const SCRIPT = "tenant-hero-studio";
const URL_OURS = "https://studio.vivijure.com/report-abuse";

/** A real tenant binding census, including the secrets the plane cannot reproduce. */
const LIVE_BINDINGS = [
  { type: "assets", name: "ASSETS" },
  { type: "d1", name: "DB" },
  { type: "dispatch_namespace", name: "MODULE_DISPATCH" },
  { type: "plain_text", name: "AUTH_MODE" },
  { type: "plain_text", name: "R2_S3_BUCKET" },
  { type: "r2_bucket", name: "R2_RENDERS" },
  { type: "ratelimit", name: "SPEND_RATE_LIMITER" },
  { type: "secret_text", name: "R2_S3_SECRET_ACCESS_KEY" },
  { type: "secret_text", name: "STUDIO_API_TOKEN" },
];
const LIVE_SECRETS = ["R2_S3_SECRET_ACCESS_KEY", "RUNPOD_API_KEY", "STUDIO_API_TOKEN"];

let store: MemoryStore;
/** THE RECORDING PROXY: every settings patch the plane issued, and through which credential. */
let patched: { via: "cf" | "scriptUpload"; bindings: WorkerBinding[] }[];
/** What the fake studio answers with for host.abuse_report_url, one entry per read. */
let served: (string | null)[];

interface Census {
  before: { type: string; name: string }[];
  after: { type: string; name: string }[];
  secretsBefore: string[];
  secretsAfter: string[];
}

const census = (over: Partial<Census> = {}): Census => ({
  before: LIVE_BINDINGS,
  // The AFTER census is what Cloudflare returns once the patch has landed, so by default it carries
  // the var. A fixture whose after-state equalled its before-state would make every green result in
  // this file unreachable, and the readback assertions vacuous.
  after: [...LIVE_BINDINGS, { type: "plain_text", name: ABUSE_REPORT_URL_VAR }],
  secretsBefore: LIVE_SECRETS,
  secretsAfter: LIVE_SECRETS,
  ...over,
});

/** Answers the FIRST census with `before` and the second with `after`, so a short readback is expressible. */
function fakeCf(via: "cf" | "scriptUpload", c: Census): CfApi {
  let bindingReads = 0;
  let secretReads = 0;
  return {
    getScriptBindings: vi.fn(async () => {
      bindingReads += 1;
      return bindingReads === 1 ? c.before : c.after;
    }),
    getScriptSecretNames: vi.fn(async () => {
      secretReads += 1;
      return secretReads === 1 ? c.secretsBefore : c.secretsAfter;
    }),
    patchScriptSettings: vi.fn(async (_ns: string, _script: string, bindings: WorkerBinding[]) => {
      patched.push({ via, bindings });
    }),
    uploadUserWorker: vi.fn(async () => {
      throw new Error("cp#164 must not re-upload the studio: no bytes, no release change");
    }),
  } as unknown as CfApi;
}

/** A studio that answers /api/modules with `served`, one entry per call. */
function studio(): ProvisionDeps["callTenantStudio"] {
  let call = 0;
  return vi.fn(async (_s: string, init: { path: string }) => {
    if (init.path !== "/api/modules") return { status: 200, text: "{}" };
    const url = served[Math.min(call, served.length - 1)];
    call += 1;
    const host = url === null ? {} : { abuse_report_url: url };
    return { status: 200, text: JSON.stringify({ host }) };
  }) as unknown as ProvisionDeps["callTenantStudio"];
}

/**
 * A clock the sleep MOVES, so the readback retry budget is exercised without a real wait.
 *
 * This is the seam that makes the cp#164 propagation-race fix testable at all: the loop is bounded
 * by wall time, so a test that could not move the clock could only assert the happy path.
 */
let clock: number;

function deps(c: Census = census(), over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    store,
    // The write credential is DELIBERATELY a different object from `cf` (cf#118): the readback must
    // go through the reader, and a test sharing one object could not tell them apart.
    cf: fakeCf("cf", c),
    scriptUploadCf: fakeCf("scriptUpload", c),
    namespace: "vivijure-tenants",
    kek: RING,
    abuseReportUrl: URL_OURS,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    log: () => undefined,
    callTenantStudio: studio(),
    ...over,
  } as unknown as ProvisionDeps;
}

async function seedTenant(over: Partial<Tenant> = {}): Promise<Tenant> {
  await store.createAccount("acct_1", "a@b.com");
  const t = await store.createTenant("ten_1", "hero", "acct_1", "provisioning");
  await store.setTenantStudioToken(t.id, await encryptStudioToken(RING, "the-studio-token"));
  await store.setTenantScript(t.id, SCRIPT, "v1.10.0");
  await store.setTenantStatus(t.id, "live");
  const row = (await store.getTenantById(t.id)) as Tenant;
  return { ...row, ...over };
}

const sentVar = (b: WorkerBinding[]) => b.find((x) => x.name === ABUSE_REPORT_URL_VAR);
const env = (host: string): ControlPlaneEnv => ({ CONTROL_PLANE_HOST: host }) as unknown as ControlPlaneEnv;

beforeEach(() => {
  store = new MemoryStore();
  clock = Date.parse("2026-07-27T12:00:00.000Z");
  patched = [];
  // Default: a v1.10.0-or-later studio with no var yet, which then serves what the plane bound.
  served = [null, URL_OURS];
});

describe("the value is DERIVED from this deploy, never ours by construction", () => {
  it("is the plane's own host plus the intake path", () => {
    expect(hostedAbuseReportUrl(env("studio.vivijure.com"))).toBe("https://studio.vivijure.com/report-abuse");
  });

  it("follows a DIFFERENT operator's host, which is the parity property this rests on", () => {
    // The load-bearing half of the hosted/self-host caveat: another operator running this plane
    // publishes THEIR intake page. If this ever returned our host for their deploy, their tenants
    // would send reporters to an address that cannot act on their content.
    expect(hostedAbuseReportUrl(env("studio.example.coop"))).toBe("https://studio.example.coop/report-abuse");
  });

  it("names NOTHING when the plane does not know its own host", () => {
    // Not a degrade with an opinion attached: unset renders nothing on the panel, which is correct.
    expect(hostedAbuseReportUrl(env(""))).toBeNull();
    expect(hostedAbuseReportUrl(env("   "))).toBeNull();
  });

  it("points at a page this repository actually SHIPS", () => {
    // The un-stubbable link. A derived URL is only as good as the asset behind it, and a rename of
    // public/report-abuse.html would otherwise leave every tenant advertising a 404.
    const asset = join(HERE, "..", "public", ABUSE_REPORT_ASSET);
    expect(existsSync(asset)).toBe(true);
    // CONTROL: the file is the real page, not an empty stub that would satisfy existsSync.
    expect(readFileSync(asset, "utf8")).toContain("mailto:");
    // The path and the asset are the same name; the assets handler serves the extensionless form
    // (verified live 2026-07-27: /report-abuse is 200, /report-abuse.html 307s to it).
    expect(`${ABUSE_REPORT_PATH}.html`).toBe(`/${ABUSE_REPORT_ASSET}`);
  });

  it("hardcodes no host and no address in the code that decides the binding", () => {
    // Belt to the derivation braces, and it guards the exact caveat cp#130 wrote down: our abuse
    // address must never be a literal on a path that can reach a studio. Comments are stripped,
    // because the prose above deliberately DOES name the address while explaining why the code
    // must not.
    const src = readFileSync(join(HERE, "..", "src", "tenant-abuse-report.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    // CONTROL: the stripped source is still the module, not an empty string that matches nothing.
    expect(code).toContain("ABUSE_REPORT_URL");
    expect(code).toContain("publicOrigin");
    expect(code).not.toMatch(/skyphusion|vivijure\.com/);
  });
});

describe("the projection: plane config -> studio var", () => {
  it("binds the var as plain_text with the derived URL", () => {
    expect(abuseReportUrlBindings(URL_OURS)).toEqual([
      { type: "plain_text", name: ABUSE_REPORT_URL_VAR, text: URL_OURS },
    ]);
  });

  it("binds NOTHING when there is no URL: absent IS the state", () => {
    expect(abuseReportUrlBindings(null)).toEqual([]);
  });

  it("RE-DERIVES rather than inheriting, so a stale URL is DROPPED", () => {
    // An omitted non-secret binding is dropped (cp#112 live probe), so omitting IS the clear. This
    // is why the var cannot travel as `inherit`: a plane that stopped publishing an intake page
    // would otherwise leave every tenant advertising one.
    const carried: WorkerBinding[] = [
      { type: "inherit", name: "AUTH_MODE" },
      { type: "inherit", name: ABUSE_REPORT_URL_VAR },
      { type: "inherit", name: "DB" },
    ];
    expect(withAbuseReportUrl(carried, null).map((b) => b.name)).toEqual(["AUTH_MODE", "DB"]);
  });

  it("re-states it as plain_text, so the VALUE comes from plane config and converges a stale one", () => {
    const carried: WorkerBinding[] = [
      { type: "inherit", name: "AUTH_MODE" },
      { type: "inherit", name: ABUSE_REPORT_URL_VAR },
    ];
    expect(withAbuseReportUrl(carried, URL_OURS)).toEqual([
      { type: "inherit", name: "AUTH_MODE" },
      { type: "plain_text", name: ABUSE_REPORT_URL_VAR, text: URL_OURS },
    ]);
  });
});

describe("the existing-tenant door: converging a live studio", () => {
  it("SENDS the var -- the reader stops having nothing to read", async () => {
    // THE DISCRIMINATING TEST. It asserts what was PASSED to the write call, not what a later read
    // returned, and it is the assertion that fails against the behaviour this issue filed.
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightAbuseReportUrl(d, t);
    expect(pre.ok, JSON.stringify(pre)).toBe(true);
    if (!pre.ok) return;
    const result = await applyAbuseReportUrl(d, t, pre.context);

    expect(patched).toHaveLength(1);
    expect(sentVar(patched[0].bindings)).toEqual({
      type: "plain_text",
      name: ABUSE_REPORT_URL_VAR,
      text: URL_OURS,
    });
    expect(result.ok).toBe(true);
    expect(result.already_present).toBe(false);
    expect(result.reader_live).toBe(true);
    expect(result.served_url_before).toBeNull();
    expect(result.served_url_after).toBe(URL_OURS);
  });

  it("writes through the UPLOAD credential and reads back through the OTHER one", async () => {
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightAbuseReportUrl(d, t);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    await applyAbuseReportUrl(d, t, pre.context);
    expect(patched.map((p) => p.via)).toEqual(["scriptUpload"]);
    // The census reads go through `cf`, twice each: before and after.
    expect((d.cf.getScriptBindings as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect((d.scriptUploadCf.getScriptBindings as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("carries every other binding as `inherit`, so it handles NO secret value", async () => {
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightAbuseReportUrl(d, t);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    await applyAbuseReportUrl(d, t, pre.context);

    const sent = patched[0].bindings;
    // CONTROL: the patch is the full censused set plus nothing, so a dropped binding is visible.
    expect(sent.map((b) => b.name).sort()).toEqual(
      [...LIVE_BINDINGS.map((b) => b.name), ABUSE_REPORT_URL_VAR].sort(),
    );
    // Everything except our own var travels as inherit -- and no binding carries a `text` value,
    // which is what lets this run against a tenant whose secrets the plane cannot reproduce.
    for (const b of sent.filter((x) => x.name !== ABUSE_REPORT_URL_VAR)) {
      expect(b.type).toBe("inherit");
      expect((b as { text?: string }).text).toBeUndefined();
    }
  });

  it("never uploads the studio bytes: no release change smuggled in as a config fix", async () => {
    // The fake throws on uploadUserWorker, so a re-upload would fail this loudly rather than
    // silently moving the tenant onto whatever release the plane is pinned to.
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightAbuseReportUrl(d, t);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    await expect(applyAbuseReportUrl(d, t, pre.context)).resolves.toBeTruthy();
  });

  it("converges a tenant carrying a STALE url instead of reporting already-present", async () => {
    const stale = "https://studio.old-host.example/report-abuse";
    served = [stale, URL_OURS];
    const t = await seedTenant();
    const d = deps(census({ before: [...LIVE_BINDINGS, { type: "plain_text", name: ABUSE_REPORT_URL_VAR }] }));
    const pre = await preflightAbuseReportUrl(d, t);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    const result = await applyAbuseReportUrl(d, t, pre.context);

    expect(result.already_present).toBe(true);
    // Patched ANYWAY, with the currently derived URL: idempotent by convergence, not by skipping.
    expect(sentVar(patched[0].bindings)).toEqual({
      type: "plain_text",
      name: ABUSE_REPORT_URL_VAR,
      text: URL_OURS,
    });
    expect(result.served_url_before).toBe(stale);
    expect(result.served_url_after).toBe(URL_OURS);
  });

  it("REFUSES green when the studio NEVER projects it back, after the whole retry budget", async () => {
    // A bundle older than the vivijure-cf v1.10.0 reader takes the var and shows nobody anything.
    // That is the cf#98 / cp#112 failure family -- applied and reaching no one -- and the ONLY
    // honest detection is asking the studio afterwards, because the panel emits the key only when
    // the var is set, so its absence beforehand proves nothing.
    served = [null, null];
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightAbuseReportUrl(d, t);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    const result = await applyAbuseReportUrl(d, t, pre.context);

    // CONTROL: the write itself was clean -- the var IS bound and nothing was stranded. Only the
    // reader is missing, which is exactly the distinction the operator needs.
    expect(result.var_present_after).toBe(true);
    expect(result.missing_bindings).toEqual([]);
    expect(result.reader_live).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("RETRIES the readback, so a studio that catches up a moment later reports GREEN", async () => {
    // THE LIVE FINDING (cp#164 acceptance run, 2026-07-27). The first converge on the testbed bound
    // the var cleanly and the studio still served nothing; sixty seconds later the same call
    // returned reader_live true, twice. The settings PATCH had not reached the isolate answering the
    // next dispatch. Without this retry the route reports a SUCCESSFUL converge as a failure and
    // tells the operator to move a live tenant's bytes for no reason.
    served = [null, null, null, URL_OURS];
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightAbuseReportUrl(d, t);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    const result = await applyAbuseReportUrl(d, t, pre.context);

    expect(result.reader_live).toBe(true);
    expect(result.ok).toBe(true);
    // CONTROL: it really did have to ask more than once, so this is the retry working and not the
    // first read happening to succeed.
    expect(result.readback_attempts).toBeGreaterThan(1);
    expect(result.readback_elapsed_ms).toBeGreaterThan(0);
  });

  it("does NOT sleep when the very first read already sees it", async () => {
    // The common case must stay instant: an operator converging a current studio should not pay a
    // retry budget for a race that did not happen.
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightAbuseReportUrl(d, t);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    const result = await applyAbuseReportUrl(d, t, pre.context);
    expect(result.readback_attempts).toBe(1);
    expect(result.readback_elapsed_ms).toBe(0);
  });

  it("gives up INSIDE the budget rather than running forever", async () => {
    served = [null, null];
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightAbuseReportUrl(d, t);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    const result = await applyAbuseReportUrl(d, t, pre.context);
    expect(result.readback_elapsed_ms).toBeLessThanOrEqual(READBACK_BUDGET_MS);
    expect(result.readback_attempts).toBeGreaterThan(1);
  });

  it("REFUSES green when the studio echoes something other than what we bound", async () => {
    served = [null, "https://somewhere.else.example/report"];
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightAbuseReportUrl(d, t);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    const result = await applyAbuseReportUrl(d, t, pre.context);
    expect(result.reader_live).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("reports a SHORT readback rather than a success flag", async () => {
    // The strand every write path fears: a binding set that came back smaller than it went in.
    const t = await seedTenant();
    const d = deps(
      census({
        after: LIVE_BINDINGS.filter((b) => b.name !== "DB").concat([
          { type: "plain_text", name: ABUSE_REPORT_URL_VAR },
        ]),
        secretsAfter: LIVE_SECRETS.filter((n) => n !== "RUNPOD_API_KEY"),
      }),
    );
    const pre = await preflightAbuseReportUrl(d, t);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    const result = await applyAbuseReportUrl(d, t, pre.context);
    expect(result.missing_bindings).toEqual(["DB"]);
    expect(result.missing_secrets).toEqual(["RUNPOD_API_KEY"]);
    expect(result.ok).toBe(false);
  });
});

describe("the refusals, all checked BEFORE anything is written", () => {
  it("passes a healthy live tenant -- the positive control every refusal below needs", async () => {
    const pre = await preflightAbuseReportUrl(deps(), await seedTenant());
    expect(pre.ok).toBe(true);
    expect(patched).toEqual([]);
  });

  it("refuses a tenant with no studio script: it needs a provision, not a patch", async () => {
    const t = await seedTenant({ script_name: null });
    const pre = await preflightAbuseReportUrl(deps(), t);
    expect(pre.ok).toBe(false);
    if (pre.ok) return;
    expect(pre.refusal.code).toBe("not_provisioned");
    expect(patched).toEqual([]);
  });

  it("refuses a deleted tenant", async () => {
    const t = await seedTenant({ deleted_at: "2026-07-01T00:00:00.000Z" });
    const pre = await preflightAbuseReportUrl(deps(), t);
    expect(pre.ok).toBe(false);
    if (pre.ok) return;
    expect(pre.refusal.code).toBe("tenant_deleted");
  });

  it("refuses when the plane cannot name its own intake page", async () => {
    const pre = await preflightAbuseReportUrl(deps(census(), { abuseReportUrl: null }), await seedTenant());
    expect(pre.ok).toBe(false);
    if (pre.ok) return;
    expect(pre.refusal.code).toBe("plane_has_no_intake_url");
    expect(patched).toEqual([]);
  });

  it("refuses when there is no studio token to read the studio with", async () => {
    const t = await seedTenant({ studio_token_enc: null });
    const pre = await preflightAbuseReportUrl(deps(), t);
    expect(pre.ok).toBe(false);
    if (pre.ok) return;
    expect(pre.refusal.code).toBe("tenant_studio_token_missing");
  });

  it("refuses when the stored studio token cannot be decrypted", async () => {
    const t = await seedTenant({ studio_token_enc: "not-ciphertext-this-plane-can-open" });
    const pre = await preflightAbuseReportUrl(deps(), t);
    expect(pre.ok).toBe(false);
    if (pre.ok) return;
    expect(pre.refusal.code).toBe("tenant_studio_token_unreadable");
  });

  it("refuses a studio that does not answer readably, rather than writing blind", async () => {
    const d = deps(census(), {
      callTenantStudio: vi.fn(async () => ({ status: 503, text: "" })) as unknown as ProvisionDeps["callTenantStudio"],
    });
    const pre = await preflightAbuseReportUrl(d, await seedTenant());
    expect(pre.ok).toBe(false);
    if (pre.ok) return;
    expect(pre.refusal.code).toBe("studio_not_serving");
    expect(patched).toEqual([]);
  });
});
