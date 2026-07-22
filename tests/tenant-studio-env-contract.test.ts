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
import { assertDispositionCoversContract } from "../src/tenant-studio-env";
import {
  REQUIRED_TENANT_STUDIO_VARS,
  TENANT_STUDIO_VAR_DISPOSITION,
  r2S3Endpoint,
} from "../src/tenant-studio-env";
import { runProvisionJob, type ProvisionDeps } from "../src/provisioner";
import type { CfApi } from "../src/cf-api";
import { MemoryStore } from "./memory-store";

const MIGRATIONS = [{ name: "0001_init.sql", sql: "CREATE TABLE IF NOT EXISTS projects (id TEXT);" }];
const ENDPOINTS = [
  { key: "backend", label: "Render", id: "ep1", name: "n1", endpointVar: "RUNPOD_ENDPOINT_ID" },
  { key: "upscale", label: "Upscale", id: "ep2", name: "n2", endpointVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { key: "lipsync", label: "Lipsync", id: "ep3", name: "n3", endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID" },
  { key: "audio-upscale", label: "Audio", id: "ep4", name: "n4", endpointVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
];
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
    runpod: { createEndpoints: vi.fn(async () => ENDPOINTS) },
    tokenMinter: {
      mintBucketToken: vi.fn(async () => ({ id: "tok-1", value: "SECRET" })),
      revoke: vi.fn(async () => undefined),
      revokeByName: vi.fn(async () => false),
    },
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
    kek: btoa("0123456789abcdef0123456789abcdef"),
    spendDailyCeiling: "5.00",
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

async function provisionAndCaptureStudioBindings() {
  const { deps, store, uploads } = recordingDeps();
  await store.createAccount("acct_1", "a@b.com");
  const tenant = await store.createTenant("ten_1", "hero", "acct_1", "pending");
  const job = await store.createProvisionJob("job_1", tenant.id, "provision");

  const res = await runProvisionJob(deps, job.id, tenant, "rpa_keyA");
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
});
