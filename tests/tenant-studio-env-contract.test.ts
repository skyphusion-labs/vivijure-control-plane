import { TEST_VPC_DOORS } from "./door-fixture";
// The link between the studio's platform-env contract and what the provisioner actually binds (#116).
//
// THE DEFECT THIS EXISTS TO PREVENT: two hand-maintained lists with nothing connecting them. The
// studio reads ORCHESTRATOR_VAR_KEYS; the provisioner bound a separately-written set. They drifted,
// and the drift was invisible until a tenant's FIRST RENDER -- R2_S3_ENDPOINT was never bound, the
// keyframe rendered and landed in R2, and then presign threw inside the keyframe->clips handoff on
// every poll, forever, as an opaque 500.
//
// Two assertions do the linking:
//   1. EXHAUSTIVE: every key in the core contract has a deliberate, documented disposition. Adding a
//      var to ORCHESTRATOR_VAR_KEYS fails here until someone decides what a tenant should do with it.
//   2. HONOURED: everything marked `provisioned` is really in the upload the provisioner sends.
// Assertion 2 reads the RECORDED UPLOAD, not the source array, so "we wrote it down" cannot pass for
// "we bound it".

import { describe, it, expect, vi } from "vitest";
import { kekRing } from "../src/token-crypto";
import { assertDispositionCoversContract } from "../src/tenant-studio-env";
import {
  REQUIRED_TENANT_STUDIO_VARS,
  TENANT_STUDIO_VAR_DISPOSITION,
  r2S3Endpoint,
} from "../src/tenant-studio-env";
import { runProvisionJob, type ProvisionDeps } from "../src/provisioner";
import { endpointBackedPlan, vpcBackedPlan } from "../src/runpod";
import type { CfApi } from "../src/cf-api";
import { MemoryStore, TEST_PROVISION_FACTS } from "./memory-store";

const MIGRATIONS = [{ name: "0001_init.sql", sql: "CREATE TABLE IF NOT EXISTS projects (id TEXT);" }];
// The endpoints a provision actually yields, DERIVED rather than hand-listed (cp#396).
//
// It used to be a four-entry literal, and that is precisely how the transport split shipped once
// with every provision broken and a green suite: a fixture that hardcodes what it should derive
// cannot fail when the plan moves. Built from endpointBackedPlan() so this file cannot claim a
// shape the code is no longer able to produce.
const ENDPOINTS = endpointBackedPlan().map((spec, i) => ({
  key: spec.key,
  label: spec.label,
  id: `ep${i + 1}`,
  name: `n${i + 1}`,
  endpointVar: spec.endpointVar,
}));
const R2_ENDPOINT = "https://acct123.r2.cloudflarestorage.com";

/** Records what was uploaded for the STUDIO script, so assertions read the real payload. */
function recordingDeps() {
  const uploads: { scriptName: string; bindings: { type: string; name: string; text?: string }[] }[] = [];
  const store = new MemoryStore();
  const cf = {
    createD1: vi.fn(async () => ({ uuid: "db-1" })),
    queryD1: vi.fn(async () => [{ results: [] }]),
    createR2Bucket: vi.fn(async () => undefined),
    r2BucketExists: vi.fn(async () => false),
    createDispatchNamespace: vi.fn(async () => undefined),
    putScriptSecret: vi.fn(async () => undefined),
    uploadUserWorker: vi.fn(async (args: { scriptName: string; bindings: { type: string; name: string; text?: string }[] }) => {
      uploads.push({ scriptName: args.scriptName, bindings: args.bindings ?? [] });
    }),
    getScriptBindings: vi.fn(async () => {
      const studio = uploads.find((u) => u.scriptName.endsWith("-studio"));
      return (studio?.bindings ?? []).map((b) => ({ type: b.type, name: b.name }));
    }),
    getScriptSecretNames: vi.fn(async () => ["R2_S3_SECRET_ACCESS_KEY", "STUDIO_API_TOKEN"]),
    createAssetsUploadSession: vi.fn(async () => ({ jwt: "j", buckets: [] })),
    uploadAssetBucket: vi.fn(async () => ({ jwt: "j2" })),
  } as unknown as CfApi;

  const deps = {
    store,
    cf,
    // cf#118: the studio-script upload runs on scriptUploadCf. Pointed at the SAME fake here, which
    // is production's fallback when no upload credential is configured -- so `uploads` still
    // captures the bindings this file exists to assert on.
    scriptUploadCf: cf,
    // cp#396: this plane has one tier, so the fixture must carry a pool or every case fails on a
    // refusal none of them is about. Ids mirror the endpoint-backed plan keys.
    sharedPool: {
      endpoints: [
        { key: "backend", label: "Render", id: "pool-1", name: "vivijure-prod-backend", endpointVar: "RUNPOD_ENDPOINT_ID" },
        { key: "lipsync", label: "Lip sync", id: "pool-3", name: "vivijure-prod-lipsync", endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID" },
        { key: "wan-train", label: "Cast LoRA training (Wan)", id: "pool-4", name: "vivijure-prod-wan-train", endpointVar: "RUNPOD_WAN_TRAIN_ENDPOINT_ID" },
      ],
      ids: new Set(["pool-1", "pool-3", "pool-4"]),
      names: new Set(["vivijure-prod-backend", "vivijure-prod-lipsync", "vivijure-prod-wan-train"]),
    },
    sharedPoolInvokeKey: "rpa_poolkey",
    videoFinishServiceId: null,
    mediaDoorUrls: {},
    vpcDoors: TEST_VPC_DOORS,
    runpod: { createEndpoints: vi.fn(async () => ENDPOINTS), convergeTemplateImages: vi.fn(async () => []) },
    tokenMinter: {
      mintBucketToken: vi.fn(async () => ({ id: "tok-1", value: "SECRET" })),
      mintAigToken: vi.fn(async () => ({ id: "aig-1", value: "AIG_SECRET" })),
      revoke: vi.fn(async () => undefined),
      revokeByName: vi.fn(async () => false),
    },
    // Default: no gateway named (cf#98). Tests that want the studio GATEWAY_ID pair set this.
    aiGatewayId: null as string | null,
    bundle: {
      fetch: vi.fn(async () => ({
        mainModule: "i.js",
        moduleText: "export default {}",
        compatibilityDate: "2026-06-01",
        migrations: MIGRATIONS,
        requiredVars: Object.keys(TENANT_STUDIO_VAR_DISPOSITION),
      })),
    },
    moduleBundle: { fetch: vi.fn(async () => ({ mainModule: "i.js", moduleText: "export default {}", compatibilityDate: "2026-06-01" })) },
    moduleNamespace: "vivijure-tenant-modules",
    r2Endpoint: R2_ENDPOINT,
    namespace: "vivijure-tenants",
    release: "v1.0.0",
    tenantScriptName: (slug: string) => `tenant-${slug}-studio`,
    kek: kekRing(btoa("0123456789abcdef0123456789abcdef")),
    spendDailyCeiling: "5.00",
    // cp#183: a real plane configures a ceiling, and the disposition census below asserts that a
    // var marked `provisioned` is really uploaded. This one is `conditional`, so it is present in
    // the upload because the plane sets it, which is what the hosted deploy does.
    storageQuota: { bytes: "107374182400", invalid: null },
    probeTenantRoot: vi.fn(async () => ({ status: 200 })),
    callTenantStudio: vi.fn(async (_s: string, init: { path: string }) => {
      if (init.path === "/api/modules/installed") return { status: 200, text: JSON.stringify({ modules: [{ name: "keyframe" }] }) };
      if (init.path === "/api/modules/install") return { status: 201, text: "{}" };
      return { status: 200, text: "{}" };
    }),
    log: () => undefined,
  } as unknown as ProvisionDeps;

  return { deps, store, uploads };
}

async function provisionAndCaptureStudioBindings(over: Partial<ProvisionDeps> = {}) {
  const { deps, store, uploads } = recordingDeps();
  Object.assign(deps, over);
  await store.createAccount("acct_1", "a@b.com");
  const tenant = await store.createTenant("ten_1", "hero", "acct_1", "pending");
  const job = await store.createProvisionJob("job_1", tenant.id, "provision", TEST_PROVISION_FACTS);

  const res = await runProvisionJob(deps, job.id, tenant);
  expect(res, "provision should succeed in the fake").toMatchObject({ ok: true });

  const studio = uploads.find((u) => u.scriptName === "tenant-hero-studio");
  expect(studio, "no studio upload was recorded").toBeTruthy();
  return studio!.bindings;
}

describe("the tenant studio platform-env contract (#116)", () => {
  it("every recorded disposition carries a real reason, not a placeholder", () => {
    for (const [key, entry] of Object.entries(TENANT_STUDIO_VAR_DISPOSITION)) {
      expect(entry.why.length, `${key} has no reason`).toBeGreaterThan(10);
    }
  });

  it("EXHAUSTIVE: a var the pinned release declares with no disposition is REFUSED", () => {
    // This is the #116 guard, relocated (cf#85). It used to compare against ORCHESTRATOR_VAR_KEYS
    // imported from the studio SOURCE tree; that import crossed the repo seam the extraction removes,
    // so the check now runs against what the pinned ARTIFACT declares in manifest.required_vars.
    //
    // The purpose is identical and must stay identical: a new studio var gets a deliberate decision
    // instead of being silently unbound. "Looks optional" is what produced #116.
    const undecided = "SOME_BRAND_NEW_STUDIO_VAR";
    expect(TENANT_STUDIO_VAR_DISPOSITION[undecided]).toBeUndefined();
    expect(() => assertDispositionCoversContract([undecided])).toThrow(/no disposition/);
    // and it names the offender, so the fix is obvious from the failure alone
    expect(() => assertDispositionCoversContract([undecided])).toThrow(new RegExp(undecided));
  });

  it("POSITIVE CONTROL: a contract of vars we HAVE decided passes", () => {
    // Without this, the refusal above would also pass if the assertion rejected everything.
    const decided = Object.keys(TENANT_STUDIO_VAR_DISPOSITION);
    expect(decided.length).toBeGreaterThan(0);
    expect(() => assertDispositionCoversContract(decided)).not.toThrow();
  });

  it("THE #116 GATE: every `provisioned` var is really in the studio upload", async () => {
    const bindings = await provisionAndCaptureStudioBindings();
    const names = new Set(bindings.map((b) => b.name));

    for (const required of REQUIRED_TENANT_STUDIO_VARS) {
      expect(names.has(required), `provisioner never bound ${required} onto the tenant studio`).toBe(true);
    }
  });

  it("binds R2_S3_ENDPOINT to the account S3 endpoint, the value presign actually needs", async () => {
    const bindings = await provisionAndCaptureStudioBindings();
    const ep = bindings.find((b) => b.name === "R2_S3_ENDPOINT");

    expect(ep, "R2_S3_ENDPOINT missing -- this is #116 itself").toBeTruthy();
    expect(ep!.type).toBe("plain_text"); // an identifier, not a credential
    expect(ep!.text).toBe(R2_ENDPOINT);
  });

  it("binds ALL FOUR values r2-presign requires, since three of four still throws", async () => {
    // The live failure had 3 of 4. Assert the whole set rather than the one we happened to lose.
    const names = new Set((await provisionAndCaptureStudioBindings()).map((b) => b.name));
    for (const v of ["R2_S3_ACCESS_KEY_ID", "R2_S3_SECRET_ACCESS_KEY", "R2_S3_ENDPOINT", "R2_S3_BUCKET"]) {
      expect(names.has(v), `presign needs ${v}`).toBe(true);
    }
  });

  it("does NOT bind the not-hosted vars (binding Access or demo vars would be wrong, not merely noisy)", async () => {
    const names = new Set((await provisionAndCaptureStudioBindings()).map((b) => b.name));
    const notHosted = Object.entries(TENANT_STUDIO_VAR_DISPOSITION)
      .filter(([, v]) => v.disposition === "not-hosted")
      .map(([k]) => k);

    for (const key of notHosted) {
      expect(names.has(key), `${key} is not-hosted but was bound`).toBe(false);
    }
    // ALLOW_UNAUTHENTICATED specifically: binding it would open the studio.
    expect(names.has("ALLOW_UNAUTHENTICATED")).toBe(false);
  });

  it("constructs the S3 endpoint from the account id rather than minting or storing one", () => {
    expect(r2S3Endpoint("abc123")).toBe("https://abc123.r2.cloudflarestorage.com");
  });

  // cf#98: planner/chat need env.AI on the STUDIO, not only on plan-enhance modules.
  it("binds Workers AI onto the studio so planner/chat are not a 500 (cf#98)", async () => {
    const bindings = await provisionAndCaptureStudioBindings();
    const ai = bindings.find((b) => b.name === "AI");
    expect(ai, "studio missing AI binding -- cf#98").toBeTruthy();
    expect(ai!.type).toBe("ai");
  });

  it("binds GATEWAY_ID + CF_AIG_TOKEN on the studio when the plane names a gateway (cf#98)", async () => {
    const { deps, store, uploads } = recordingDeps();
    (deps as { aiGatewayId: string | null }).aiGatewayId = "vivijure-hosted";
    await store.createAccount("acct_1", "a@b.com");
    const tenant = await store.createTenant("ten_1", "hero", "acct_1", "pending");
    const job = await store.createProvisionJob("job_1", tenant.id, "provision", TEST_PROVISION_FACTS);
    const res = await runProvisionJob(deps, job.id, tenant);
    expect(res).toMatchObject({ ok: true });
    const studio = uploads.find((u) => u.scriptName === "tenant-hero-studio");
    expect(studio).toBeTruthy();
    const names = new Set(studio!.bindings.map((b) => b.name));
    expect(names.has("AI")).toBe(true);
    expect(names.has("GATEWAY_ID")).toBe(true);
    expect(names.has("CF_AIG_TOKEN")).toBe(true);
    expect(studio!.bindings.find((b) => b.name === "GATEWAY_ID")).toMatchObject({
      type: "plain_text",
      text: "vivijure-hosted",
    });
    // Credential must not land as plain_text (dashboard/CLI readable).
    expect(studio!.bindings.find((b) => b.name === "CF_AIG_TOKEN")).toMatchObject({
      type: "secret_text",
    });
  });

  it("does NOT half-bind the gateway pair when the plane names no gateway", async () => {
    // both-or-neither: AI alone is fine (Workers AI local); GATEWAY_ID without a token is a trap.
    const names = new Set((await provisionAndCaptureStudioBindings()).map((b) => b.name));
    expect(names.has("AI")).toBe(true);
    expect(names.has("GATEWAY_ID")).toBe(false);
    expect(names.has("CF_AIG_TOKEN")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// cp#183 REGRESSION: the disposition table against the PINNED release contract.
//
// WHAT ACTUALLY HAPPENED, and why an assertion derived from our own table could not catch it. The
// two exhaustive checks above walk TENANT_STUDIO_VAR_DISPOSITION, so they are green by
// construction no matter what a release declares. vivijure-cf v1.12.0 added R2_STORAGE_QUOTA_BYTES
// to ORCHESTRATOR_VAR_KEYS, which stamps it into the release manifest as a required_var; this plane
// had no disposition for it; and assertDispositionCoversContract -- correctly -- then threw on
// EVERY provision and EVERY studio upgrade against the pinned release. The guard worked. Nothing
// on this side answered it, and no test here could have said so, because every list this suite
// reads is one we write.
//
// WHAT THIS SNAPSHOT IS, stated honestly rather than implied: the required_vars of the pinned
// artifact, read out of R2 on 2026-07-27 (studio-releases/v1.12.0/manifest.json). It is a RECORDED
// SAMPLE. It catches a regression -- someone deleting a disposition, or a var this plane already
// knows about going missing -- and it CANNOT catch the next var a future vivijure-cf release adds.
// That gap is structural to a snapshot, and the only real closure is a deploy-time check against
// the manifest the plane is actually pinned to; filed separately rather than pretended away here.
const PINNED_RELEASE_REQUIRED_VARS_V1_12_0 = [
  "ABUSE_REPORT_URL",
  "ACCESS_AUD",
  "ACCESS_TEAM_DOMAIN",
  "ALLOW_UNAUTHENTICATED",
  "AUTH_MODE",
  "DEMO_ARTIFACT_ORIGIN",
  "DEMO_ASSISTANT_MODEL",
  "DEMO_CHAT_GLOBAL_DAILY",
  "DEMO_CHAT_PER_IP_DAILY",
  "DEMO_RENDER_ENABLED",
  "DEMO_RENDER_GLOBAL_DAILY",
  "DEMO_RENDER_PER_IP_DAILY",
  "DEMO_RENDER_QUEUE_DEPTH",
  "FILM_CLIP_DURATION_FLOOR",
  "PLANNER_AI_MOCK",
  "R2_S3_BUCKET",
  "R2_S3_ENDPOINT",
  "R2_STORAGE_QUOTA_BYTES",
  "SPEND_DAILY_CEILING",
  "SPEND_LIMIT_FAIL_CLOSED",
];

describe("the pinned release contract, not just our own table (cp#183)", () => {
  it("has a disposition for every var the PINNED release declares", () => {
    // This is the assertion that was red on main: R2_STORAGE_QUOTA_BYTES had no entry, so this
    // threw exactly as the provision path did.
    expect(() => assertDispositionCoversContract(PINNED_RELEASE_REQUIRED_VARS_V1_12_0)).not.toThrow();
  });

  it("CONTROL: a var with no disposition still REFUSES, naming it", () => {
    // Without this the check above could pass because the assertion accepts everything, which is
    // the vacuous-negative shape that let the real defect through in the first place.
    expect(() =>
      assertDispositionCoversContract([...PINNED_RELEASE_REQUIRED_VARS_V1_12_0, "SOME_FUTURE_VAR"]),
    ).toThrow(/SOME_FUTURE_VAR/);
  });

  it("names the storage ceiling explicitly, so deleting its entry fails HERE", () => {
    expect(TENANT_STUDIO_VAR_DISPOSITION.R2_STORAGE_QUOTA_BYTES?.disposition).toBe("conditional");
  });
});

// ---------------------------------------------------------------------------------------------
// THE TRANSPORT CONTRACT (cp#396). What a tenant studio must carry once a capability can be served
// by our own iron instead of RunPod.
//
// STATED AS EXACTLY-ONE-TRANSPORT-PER-CAPABILITY, and deliberately not as "the four endpoint vars
// are present". The old shape could be satisfied by binding four vars; this one can go RED for the
// right reason, because it asserts an ABSENCE that a wrong implementation would violate.
//
// WHERE THE BINDING LIVES IS PART OF THE CONTRACT. Upscale is a MODULE capability: the studio
// dispatches to a module worker, and the module worker is what reaches RunPod or a door. A
// vpc_service binding attached to the STUDIO under a name nothing reads would upload clean and
// change nothing -- which is exactly how the first attempt at this split was built. So the studio
// must carry NEITHER the retired endpoint vars NOR the door bindings.
describe("the tenant studio transport contract (cp#396)", () => {
  it("binds an endpoint var for every ENDPOINT-BACKED capability, and its id is real", async () => {
    const bindings = await provisionAndCaptureStudioBindings();
    const byName = new Map(bindings.map((b) => [b.name, b]));
    for (const spec of endpointBackedPlan()) {
      const bound = byName.get(spec.endpointVar);
      expect(bound, `studio missing ${spec.endpointVar}`).toBeTruthy();
      expect(bound!.type).toBe("plain_text");
      // NOT merely present: an EMPTY endpoint id binds clean and dies at the first render, which is
      // the failure shape the whole transport split exists to make impossible.
      expect(bound!.text, `${spec.endpointVar} is bound but empty`).toBeTruthy();
    }
  });

  it("binds NO endpoint var for a VPC-BACKED capability: there is no endpoint to name", async () => {
    // The retired vars. Their PRESENCE would mean an endpoint id reached a capability that has no
    // endpoint, which is the precise defect the split removes.
    const names = new Set((await provisionAndCaptureStudioBindings()).map((b) => b.name));
    expect(names.has("VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID")).toBe(false);
    expect(names.has("AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID")).toBe(false);
  });

  it("binds NO door on the STUDIO: the door belongs to the MODULE worker", async () => {
    // A vpc_service binding here would be inert -- vivijure-cf reads FINISH_UPSCALE_VPC in
    // modules/finish-upscale, never in the studio. Inert and silent is worse than absent, because
    // it looks configured.
    const bindings = await provisionAndCaptureStudioBindings();
    const names = new Set(bindings.map((b) => b.name));
    for (const capability of vpcBackedPlan()) {
      for (const door of capability.doors) {
        expect(names.has(door.bindingName), door.bindingName + " bound on the studio").toBe(false);
        expect(names.has(door.doorTokenBinding), door.doorTokenBinding + " bound on the studio").toBe(false);
      }
    }
    // CONTROL: the studio DOES still carry the video-finish door, which it genuinely reads
    // (render-frames.ts, video-finish-availability.ts). Without this the assertion above would
    // also pass on a studio carrying no vpc_service binding for any reason at all.
    const withFinish = await provisionAndCaptureStudioBindings({ videoFinishServiceId: "svc-video-finish" });
    expect(withFinish.some((b) => b.name === "VIDEO_FINISH_VPC" && b.type === "vpc_service")).toBe(true);
  });

  it("EXACTLY ONE TRANSPORT per capability, counted across the whole plan", () => {
    // The summary claim, asserted as BOTH numbers. One figure cannot distinguish a capability that
    // was DROPPED from one that MOVED transport, and telling those apart is the entire point.
    expect(endpointBackedPlan()).toHaveLength(3);
    expect(vpcBackedPlan()).toHaveLength(2);
    expect(endpointBackedPlan().map((c) => c.key).sort()).toEqual(["backend", "lipsync", "wan-train"]);
    expect(vpcBackedPlan().map((c) => c.key).sort()).toEqual(["audio-upscale", "upscale"]);
  });
});
