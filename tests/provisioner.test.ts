// Provisioner behavior (#53). Fakes stand in for Cloudflare and RunPod, so what these prove is the
// STEP MACHINE: ordering, idempotency, honest failure, custody, teardown. They are NOT evidence
// that the CF calls themselves are shaped right; only a real provision against real CF proves that,
// and that gate is called out separately in the PR rather than implied by a green suite.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PROVISION_STEPS,
  runProvisionJob,
  teardownTenant,
  tenantBucketName,
  tenantD1Name,
  type ProvisionDeps,
} from "../src/provisioner";
import { CfApiError } from "../src/cf-api";
import type { CfApi } from "../src/cf-api";
import type { Tenant } from "../src/store";
import { sha256Hex } from "../src/crypto";
import { decryptStudioToken } from "../src/token-crypto";
import { MemoryStore, recordingStore } from "./memory-store";
import { expectProvisionFailure } from "./provision-assert";

// The var contract the pinned release declares (cf#85). Every entry must have a disposition in
// tenant-studio-env.ts or the provision refuses, so this fixture doubles as a check that the two
// stay in step.
const REQUIRED_VARS = ["AUTH_MODE", "R2_S3_ENDPOINT", "R2_S3_BUCKET"];

const MIGRATIONS = [
  { name: "0001_init.sql", sql: "CREATE TABLE IF NOT EXISTS projects (id TEXT);" },
];

let store: MemoryStore;
let calls: string[];
let logs: { event: string; fields: Record<string, unknown> }[];

/** A fake CF that RECORDS ordering, so the teardown-order invariant is testable. */
function fakeCf(over: Partial<Record<string, unknown>> = {}) {
  const cf = {
    createD1: vi.fn(async (name: string) => (calls.push(`createD1:${name}`), { uuid: "db-1" })),
    queryD1: vi.fn(async () => (calls.push("queryD1"), {})),
    deleteD1: vi.fn(async () => void calls.push("deleteD1")),
    exportD1: vi.fn(async () => ({ signed_url: "https://x" })),
    createR2Bucket: vi.fn(async (n: string) => void calls.push(`createR2:${n}`)),
    deleteR2Bucket: vi.fn(async () => void calls.push("deleteR2Bucket")),
    r2BucketExists: vi.fn(async () => false),
    mintR2Token: vi.fn(async () => (calls.push("mintR2Token"), { id: "tok-1", value: "TOKEN_VALUE_SECRET" })),
    revokeToken: vi.fn(async () => void calls.push("revokeToken")),
    uploadUserWorker: vi.fn(async () => void calls.push("uploadUserWorker")),
    deleteUserWorker: vi.fn(async () => void calls.push("deleteUserWorker")),
    putScriptSecret: vi.fn(async () => void calls.push("putScriptSecret")),
    getScriptBindings: vi.fn(async () => [
      { type: "assets", name: "ASSETS" },
      { type: "d1", name: "DB" },
      { type: "r2_bucket", name: "R2_RENDERS" },
      { type: "plain_text", name: "AUTH_MODE" },
      // #116: the verify census now covers the platform-env contract, so the fake must carry
      // the vars a real upload carries.
      { type: "plain_text", name: "R2_S3_BUCKET" },
      { type: "plain_text", name: "R2_S3_ENDPOINT" },
      { type: "ratelimit", name: "SPEND_RATE_LIMITER" },
      { type: "dispatch_namespace", name: "MODULE_DISPATCH" },
      { type: "plain_text", name: "RUNPOD_ENDPOINT_ID" },
      { type: "plain_text", name: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
      { type: "plain_text", name: "MUSETALK_RUNPOD_ENDPOINT_ID" },
      { type: "plain_text", name: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
    ]),
    createDispatchNamespace: vi.fn(async () => void calls.push("createDispatchNamespace")),
    listNamespaceScripts: vi.fn(async () => [] as string[]),
    getScriptSecretNames: vi.fn(async () => ["R2_S3_SECRET_ACCESS_KEY", "RUNPOD_API_KEY", "STUDIO_API_TOKEN"]),
    createAssetsUploadSession: vi.fn(async () => ({ jwt: "jwt-1", buckets: [] })),
    uploadAssetBucket: vi.fn(async () => ({ jwt: "jwt-final" })),
    ...over,
  };
  return cf as unknown as CfApi;
}

const ENDPOINTS = [
  { key: "backend", label: "Render", id: "ep1", name: "n1", endpointVar: "RUNPOD_ENDPOINT_ID" },
  { key: "upscale", label: "Upscale", id: "ep2", name: "n2", endpointVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { key: "lipsync", label: "Lip sync", id: "ep3", name: "n3", endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID" },
  { key: "audio-upscale", label: "Audio upscale", id: "ep4", name: "n4", endpointVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
];

function deps(over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    store,
    cf: fakeCf(),
    runpod: { createEndpoints: vi.fn(async () => (calls.push("runpod.createEndpoints"), ENDPOINTS)) },
    tokenMinter: {
      mintBucketToken: vi.fn(async () => (calls.push("mintR2Token"), { id: "tok-1", value: "TOKEN_VALUE_SECRET" })),
      revoke: vi.fn(async () => void calls.push("revokeToken")),
    },
    bundle: {
      fetch: vi.fn(async () => ({
        mainModule: "index.js",
        moduleText: "export default {}",
        compatibilityDate: "2026-06-01",
        migrations: MIGRATIONS,
        requiredVars: REQUIRED_VARS,
      })),
    },
    moduleBundle: {
      fetch: vi.fn(async () => ({
        mainModule: "index.js",
        moduleText: "export default {}",
        compatibilityDate: "2026-06-01",
        compatibilityFlags: ["nodejs_compat"],
      })),
    },
    r2Endpoint: "https://acct.r2.cloudflarestorage.com",
    namespace: "vivijure-tenants",
    moduleNamespace: "vivijure-tenant-modules",
    release: "v1.0.0",
    tenantScriptName: (slug: string) => `tenant-${slug}-studio`,
    // A valid base64 32-byte key so token-crypto importKey(AES-GCM-256) accepts it.
    kek: btoa("0123456789abcdef0123456789abcdef"),
    spendDailyCeiling: null,
    // cf#114: provisioning never probes /ready (key B does not exist yet at that point) -- this is
    // here because the ProvisionDeps contract requires it. It THROWS rather than returning a benign
    // shape: if provisioning ever starts calling it, that must surface as a failure, not a silent pass.
    callTenantModule: vi.fn(async () => {
      throw new Error("callTenantModule must not be used during provisioning");
    }),
    callTenantStudio: vi.fn(async (_script: string, init: { method: string; path: string }) => {
      if (init.path === "/api/modules/install") return { status: 201, text: '{"ok":true}' };
      if (init.path === "/api/modules/installed")
        return {
          status: 200,
          text: JSON.stringify({
            ok: true,
            modules: [
              { name: "keyframe" },
              { name: "own-gpu" },
              { name: "finish-upscale" },
              { name: "finish-lipsync" },
              { name: "speech-upscale" },
            ],
          }),
        };
      return { status: 200, text: "" }; // GET / (serving probe)
    }),
    log: (event, fields) => void logs.push({ event, fields }),
    ...over,
  };
}

async function tenant(): Promise<Tenant> {
  await store.createAccount("acct_1", "a@b.com");
  return await store.createTenant("ten_1", "hero", "acct_1", "pending");
}

beforeEach(() => {
  store = new MemoryStore();
  calls = [];
  logs = [];
});

describe("runProvisionJob", () => {
  it("runs the steps in order and parks at awaiting_invoke_key, not live", async () => {
    const t = await tenant();
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const res = await runProvisionJob(deps(), job.id, t, "rpa_keyA");

    expect(res).toEqual({ ok: true, status: "awaiting_invoke_key" });
    // NOT live: the studio exists but cannot render until key B lands.
    expect(store.tenants.get(t.id)?.status).toBe("awaiting_invoke_key");
    expect(store.jobs.get("job_1")?.status).toBe("succeeded");
    expect(JSON.parse(store.jobs.get("job_1")!.steps_done)).toEqual([...PROVISION_STEPS]);
  });

  it("threads the REAL minted R2 credential into the RunPod templates (never a placeholder)", async () => {
    // The satellite templates carry this credential and a render reads it; the live e2e once
    // provisioned endpoints with placeholder creds, which would have failed at the tenant's first
    // render. The seam now takes the credential, so prove it is the mint, S3-derived.
    const t = await tenant();
    const d = deps();
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const res = await runProvisionJob(d, job.id, t, "rpa_keyA");
    expect(res.ok).toBe(true);

    const createEndpoints = d.runpod.createEndpoints as ReturnType<typeof vi.fn>;
    expect(createEndpoints).toHaveBeenCalledTimes(1);
    const [key, slug, r2] = createEndpoints.mock.calls[0] as [
      string,
      string,
      { endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string },
    ];
    expect(key).toBe("rpa_keyA");
    expect(slug).toBe("hero");
    expect(r2.endpoint).toBe("https://acct.r2.cloudflarestorage.com");
    expect(r2.accessKeyId).toBe("tok-1");
    // R2 S3 semantics: the secret access key is the SHA-256 hex of the token value.
    expect(r2.secretAccessKey).toBe(await sha256Hex("TOKEN_VALUE_SECRET"));
    expect(r2.bucket).toBe("vivijure-tenant-hero");
    // And the worker secret is the SAME derivation -- template and worker cannot disagree.
    const upload = (d.cf.uploadUserWorker as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      bindings: { name: string; text?: string }[];
    };
    const secret = upload.bindings.find((b) => b.name === "R2_S3_SECRET_ACCESS_KEY");
    expect(secret?.text).toBe(r2.secretAccessKey);
  });

  it("wires ASSETS + the endpoint-id vars + STUDIO_API_TOKEN, and persists the ENCRYPTED token value", async () => {
    const t = await tenant();
    const d = deps();
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const res = await runProvisionJob(d, job.id, t, "rpa_keyA");
    expect(res.ok).toBe(true);

    const upload = (d.cf.uploadUserWorker as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      bindings: { type: string; name: string; text?: string }[];
    };
    const byName = new Map(upload.bindings.map((b) => [b.name, b]));
    // env.ASSETS must be declared or the studio 1101s on every static path.
    expect(byName.get("ASSETS")?.type).toBe("assets");
    // Each endpoint id is wired into the var the studio reads it from (spec.endpointVar).
    expect(byName.get("RUNPOD_ENDPOINT_ID")?.text).toBe("ep1");
    expect(byName.get("VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID")?.text).toBe("ep2");
    // The studio auth token is a SECRET on the tenant worker.
    expect(byName.get("STUDIO_API_TOKEN")?.type).toBe("secret_text");
    const tokenValue = byName.get("STUDIO_API_TOKEN")!.text!;
    // The spend limiter must be BOUND or the studio fail-closes every render (503). Parity with
    // self-host: 30 req / 60s.
    expect(byName.get("SPEND_RATE_LIMITER")).toMatchObject({ type: "ratelimit", simple: { limit: 30, period: 60 } });

    // ...and the SAME value is persisted control-plane-side, ENCRYPTED (never plaintext at rest).
    const enc = store.tenants.get(t.id)!.studio_token_enc!;
    expect(enc).toBeTruthy();
    expect(enc).not.toContain(tokenValue); // ciphertext, not the token
    expect(await decryptStudioToken(btoa("0123456789abcdef0123456789abcdef"), enc)).toBe(tokenValue);
  });

  it("FAILS the provision (verify) when the tenant root does not SERVE, even if every binding exists", async () => {
    const t = await tenant();
    const d = deps({
      callTenantStudio: vi.fn(async (_s: string, init: { path: string }) => {
        if (init.path === "/") return { status: 502, text: "" }; // studio does not SERVE
        if (init.path === "/api/modules/install") return { status: 201, text: "{}" };
        return { status: 200, text: JSON.stringify({ modules: [{ name: "keyframe" }] }) };
      }),
    });
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const res = await runProvisionJob(d, job.id, t, "rpa_keyA");
    expect(res).toMatchObject({ ok: false, step: "verify" });
    expect(store.tenants.get(t.id)?.status).toBe("failed");
  });

  it("NEVER PASSES the transient key A to the store at all, and never logs it", async () => {
    // Asserts on the WRITE HISTORY, not the surviving state. The earlier version of this test
    // checked final state and a sabotage run that wrote key A into the job row PASSED, because the
    // next progress update overwrote it first. On a real D1 that write is durable and replicated;
    // "overwritten a moment later" is not custody. The key must never reach the store at all.
    const t = await tenant();
    const rec = recordingStore(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    await runProvisionJob(deps({ store: rec.store }), job.id, t, "rpa_KEY_A_MUST_NOT_PERSIST");

    expect(rec.journal.join("\n")).not.toContain("rpa_KEY_A_MUST_NOT_PERSIST");
    expect(JSON.stringify(logs)).not.toContain("rpa_KEY_A_MUST_NOT_PERSIST");
    expect(rec.journal.length).toBeGreaterThan(0); // control: the proxy is actually recording
  });

  it("NEVER PASSES the minted R2 credential VALUE to the store (only its id)", async () => {
    const t = await tenant();
    const rec = recordingStore(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    await runProvisionJob(deps({ store: rec.store }), job.id, t, "rpa_keyA");

    expect(store.tenants.get(t.id)?.r2_token_id).toBe("tok-1"); // the id IS kept: teardown revokes by it
    expect(rec.journal.join("\n")).not.toContain("TOKEN_VALUE_SECRET");
    expect(JSON.stringify(logs)).not.toContain("TOKEN_VALUE_SECRET");
  });

  it("binds a per-tenant BUCKET, never a shared bucket with a prefix", async () => {
    const t = await tenant();
    const d = deps();
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    await runProvisionJob(d, job.id, t, "rpa_keyA");

    const upload = (d.cf.uploadUserWorker as unknown as { mock: { calls: [{ bindings: { name: string; bucket_name?: string }[] }][] } }).mock.calls[0][0];
    const r2 = upload.bindings.filter((b) => b.bucket_name);
    expect(r2.length).toBeGreaterThan(0);
    for (const b of r2) expect(b.bucket_name).toBe(tenantBucketName("hero"));
  });

  it("STOPS honestly at runpod_endpoints when resuming without key A (never fakes it)", async () => {
    const t = await tenant();
    const d = deps();
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const res = await runProvisionJob(d, job.id, t, null);

    expect(res).toEqual({ ok: false, step: "runpod_endpoints", message: "runpod_key_required" });
    expect(d.runpod.createEndpoints).not.toHaveBeenCalled();
    expect(calls).not.toContain("uploadUserWorker"); // and does not sail on past it
  });

  it("surfaces the REAL step error verbatim, not a cosmetic one", async () => {
    const t = await tenant();
    const quotaError = new CfApiError("d1.create", 400, [{ message: "workers.api.error.d1_quota_exceeded" }]);
    const d = deps({ cf: fakeCf({ createD1: vi.fn(async () => { throw quotaError; }) }) });
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const res = await runProvisionJob(d, job.id, t, "rpa_keyA");

    expect(res.ok).toBe(false);
    {
      const fail = expectProvisionFailure(res);
      expect(fail.step).toBe("d1_create");
      expect(fail.message).toContain("d1_quota_exceeded"); // CF's own words reach the tenant
    }
    expect(store.jobs.get("job_1")).toMatchObject({ status: "failed", error_step: "d1_create" });
    expect(store.tenants.get(t.id)?.status).toBe("failed");
  });

  it("FAILS the provision when post-upload verification finds a missing binding", async () => {
    const t = await tenant();
    // The upload "succeeded" but the worker is not what we asked for. Trusting our own write here
    // is exactly the reads-safe-but-isn't trap; we ask the API what it actually built.
    const d = deps({ cf: fakeCf({ getScriptBindings: vi.fn(async () => [{ type: "d1", name: "DB" }]) }) });
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const res = await runProvisionJob(d, job.id, t, "rpa_keyA");

    expect(res.ok).toBe(false);
    {
      const fail = expectProvisionFailure(res);
      expect(fail.step).toBe("verify");
      expect(fail.message).toContain("R2_RENDERS");
    }
    expect(store.tenants.get(t.id)?.status).toBe("failed");
  });

  it("re-running is safe: it revokes the previous R2 token rather than leaving live grants behind", async () => {
    const t = await tenant();
    await store.setTenantR2Token(t.id, "tok-old");
    const fresh = (await store.getTenantById(t.id))!;
    const d = deps();
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    await runProvisionJob(d, job.id, fresh, "rpa_keyA");

    expect(d.tokenMinter.revoke).toHaveBeenCalledWith("tok-old");
    expect(calls.indexOf("revokeToken")).toBeLessThan(calls.indexOf("mintR2Token"));
    expect(store.tenants.get(t.id)?.r2_token_id).toBe("tok-1");
  });

  it("uses deterministic per-tenant resource names (idempotency depends on it)", async () => {
    const t = await tenant();
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    await runProvisionJob(deps(), job.id, t, "rpa_keyA");
    expect(calls).toContain(`createD1:${tenantD1Name("hero")}`);
    expect(calls).toContain(`createR2:${tenantBucketName("hero")}`);
  });
});

describe("teardownTenant", () => {
  async function provisioned(): Promise<Tenant> {
    const t = await tenant();
    await store.setTenantD1(t.id, "db-1");
    await store.setTenantBucket(t.id, "vivijure-tenant-hero");
    await store.setTenantR2Token(t.id, "tok-1");
    return (await store.getTenantById(t.id))!;
  }

  it("pulls the WORKER FIRST, so no request can hit a half-deleted studio", async () => {
    const d = deps();
    await teardownTenant(d, await provisioned(), { deleteData: true });
    expect(calls[0]).toBe("deleteUserWorker");
    expect(calls.indexOf("deleteUserWorker")).toBeLessThan(calls.indexOf("deleteD1"));
  });

  // The stored name is what was ACTUALLY created; the derivation is what we WOULD create today.
  // Routing already treats the stored name as authoritative (tenants.ts), so teardown must too, or
  // the two halves disagree about which script the tenant owns and a scheme change orphans a LIVE
  // user Worker in the namespace.
  it("deletes the STORED script_name, not the recomputed derivation", async () => {
    const d = deps();
    const t = await provisioned();
    // A row created under an older naming scheme: stored and derived deliberately disagree.
    const legacy = { ...t, script_name: "tenant-hero-studio-legacy" };
    await teardownTenant(d, legacy, { deleteData: true });
    expect(d.cf.deleteUserWorker).toHaveBeenCalledWith(expect.anything(), "tenant-hero-studio-legacy");
    expect(d.cf.deleteUserWorker).not.toHaveBeenCalledWith(expect.anything(), "tenant-hero-studio");
  });

  it("falls back to the derivation when the row carries no script_name", async () => {
    const d = deps();
    const t = await provisioned();
    await teardownTenant(d, { ...t, script_name: null }, { deleteData: true });
    expect(d.cf.deleteUserWorker).toHaveBeenCalledWith(expect.anything(), "tenant-hero-studio");
  });

  it("revokes the R2 token: an un-revoked token outliving its bucket is an orphaned grant", async () => {
    const d = deps();
    const res = await teardownTenant(d, await provisioned(), { deleteData: true });
    expect(res.ok).toBe(true);
    expect(d.tokenMinter.revoke).toHaveBeenCalledWith("tok-1");
  });

  it("KEEPS GOING after a failure and reports every one (a first-error stop strands credentials)", async () => {
    const d = deps({
      cf: fakeCf({ deleteUserWorker: vi.fn(async () => { throw new Error("script busy"); }) }),
    });
    const res = await teardownTenant(d, await provisioned(), { deleteData: true });

    expect(res.ok).toBe(false);
    expect(res.failures).toEqual([{ resource: "worker", error: expect.stringContaining("script busy") }]);
    // The credential is STILL revoked even though the first step failed.
    expect(d.tokenMinter.revoke).toHaveBeenCalledWith("tok-1");
    expect(calls).toContain("deleteD1");
  });

  it("REPORTS a non-empty bucket honestly instead of stranding it silently (live-verified constraint)", async () => {
    // Real R2 refuses to delete a non-empty bucket, and its REST API cannot empty one (no object
    // endpoint). So a tenant who ever rendered CANNOT have their bucket deleted by this path. The
    // requirement is that we say so, loudly, rather than report a clean teardown that did not
    // happen. Found on real R2 during the #53 live verify; the fake happily deleted anything.
    const notEmpty = new CfApiError("r2.deleteBucket", 400, [
      { message: "The bucket you tried to delete is not empty" },
    ]);
    const d = deps({ cf: fakeCf({ deleteR2Bucket: vi.fn(async () => { throw notEmpty; }) }) });
    const res = await teardownTenant(d, await provisioned(), { deleteData: true });

    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.resource)).toContain("r2_bucket");
    expect(res.failures.find((f) => f.resource === "r2_bucket")?.error).toContain("not empty");
    // and the rest of the teardown still completed: the credential is revoked either way
    expect(d.tokenMinter.revoke).toHaveBeenCalledWith("tok-1");
  });

  it("NEVER touches the tenant's RunPod account: their endpoints are theirs", async () => {
    const d = deps();
    await teardownTenant(d, await provisioned(), { deleteData: true });
    expect(calls.some((c) => c.startsWith("runpod"))).toBe(false);
  });

  it("can keep the data (export offer) while still pulling the worker and the credential", async () => {
    const d = deps();
    await teardownTenant(d, await provisioned(), { deleteData: false });
    expect(calls).toContain("deleteUserWorker");
    expect(calls).toContain("revokeToken");
    expect(calls).not.toContain("deleteD1");
    expect(calls).not.toContain("deleteR2Bucket");
  });
});

describe("assets_config (the hosted-only parity defect, #77/#78)", () => {
  const withBundle = (assetsConfig: Record<string, unknown> | undefined) =>
    deps({
      bundle: {
        fetch: vi.fn(async () => ({
          mainModule: "worker.js",
          moduleText: "export default {}",
          compatibilityDate: "2026-06-01",
          migrations: MIGRATIONS,
          requiredVars: REQUIRED_VARS,
          assetsConfig,
          assets: [{ path: "/index.html", base64: "eA==", contentType: "text/html", hash: "h1", size: 1 }],
        })),
      },
    });

  const uploadArg = (d: ProvisionDeps) =>
    (d.cf.uploadUserWorker as unknown as { mock: { calls: [{ assetsConfig?: Record<string, unknown> }][] } })
      .mock.calls[0][0];

  it("passes the release's OWN asset handling to the tenant upload", async () => {
    // Without this, every tenant got CF defaults while a self-hoster running the SAME release got
    // html_handling="none" -- a blank page at the tenant's root (#374 loop), hosted-only, on
    // identical code. The upload SUCCEEDS either way, which is why nothing else caught it.
    const t = await tenant();
    const d = withBundle({ html_handling: "none", run_worker_first: true });
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    await runProvisionJob(d, job.id, t, "rpa_keyA");
    expect(uploadArg(d).assetsConfig).toEqual({ html_handling: "none", run_worker_first: true });
  });

  it("passes {} THROUGH rather than substituting the core's values (the empty-object corollary)", async () => {
    // {} is meaningful, not missing: it means the release was built with CF defaults, so the tenant
    // gets CF defaults. Substituting here would re-create the hardcode one layer up, which is the
    // drift the manifest exists to prevent.
    const t = await tenant();
    const d = withBundle({});
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    await runProvisionJob(d, job.id, t, "rpa_keyA");
    expect(uploadArg(d).assetsConfig).toEqual({});
  });

  it("never invents a config when the release carries none", async () => {
    const t = await tenant();
    const d = withBundle(undefined);
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    await runProvisionJob(d, job.id, t, "rpa_keyA");
    expect(uploadArg(d).assetsConfig).toBeUndefined();
  });
});

// cf#99: the studio-to-endpoint bridge. Same fakes-stand-in-for-CF discipline as above: these prove
// the STEP MACHINE (upload the module scripts, bind MODULE_DISPATCH on the studio, drive the studio's
// own install route, verify non-empty, sweep on teardown). A real provision against real CF is what
// proves the CF calls are shaped right; that gate is called out in the PR, not implied here.
describe("cf#99 tenant module bridge", () => {
  const uploads = (d: ProvisionDeps) =>
    (d.cf.uploadUserWorker as unknown as {
      mock: { calls: [{ namespace: string; scriptName: string; bindings: { type: string; name: string; text?: string }[] }][] };
    }).mock.calls.map((c) => c[0]);

  it("uploads all 5 tenant module scripts into the modules namespace, tenant-id-prefixed", async () => {
    const t = await tenant();
    const d = deps();
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    await runProvisionJob(d, job.id, t, "rpa_keyA");

    const moduleUploads = uploads(d).filter((u) => u.namespace === "vivijure-tenant-modules");
    expect(moduleUploads.map((u) => u.scriptName).sort()).toEqual(
      [
        `${t.id}-finish-lipsync`,
        `${t.id}-finish-upscale`,
        `${t.id}-keyframe`,
        `${t.id}-own-gpu`,
        `${t.id}-speech-upscale`,
      ].map((n) => n.replace(/_/g, "-")).sort(),
    );
    // The studio upload is the FIRST uploadUserWorker (its namespace is the tenants namespace).
    expect(uploads(d)[0].namespace).toBe("vivijure-tenants");
  });

  it("wires each module's RUNPOD_ENDPOINT_ID to its endpoint, and does NOT bind key B at upload", async () => {
    const t = await tenant();
    const d = deps();
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    await runProvisionJob(d, job.id, t, "rpa_keyA");

    const byScript = new Map(
      uploads(d)
        .filter((u) => u.namespace === "vivijure-tenant-modules")
        .map((u) => [u.scriptName, u.bindings]),
    );
    const pre = (n: string) => `${t.id}-${n}`.replace(/_/g, "-");
    // keyframe + own-gpu ride the backend endpoint (ep1); the finishers/audio get their own.
    const epOf = (script: string, name: string) => byScript.get(script)!.find((b) => b.name === name)?.text;
    expect(epOf(pre("keyframe"), "RUNPOD_ENDPOINT_ID")).toBe("ep1");
    expect(epOf(pre("own-gpu"), "RUNPOD_ENDPOINT_ID")).toBe("ep1");
    expect(epOf(pre("finish-upscale"), "RUNPOD_ENDPOINT_ID")).toBe("ep2");
    expect(epOf(pre("finish-lipsync"), "RUNPOD_ENDPOINT_ID")).toBe("ep3");
    expect(epOf(pre("speech-upscale"), "RUNPOD_ENDPOINT_ID")).toBe("ep4");
    // Key B is NOT present at upload -- it lands in installInvokeKey (custody: the key never rides
    // the module upload, only a rotate-in-place secret PUT after it is verified).
    for (const bindings of byScript.values()) {
      expect(bindings.find((b) => b.name === "RUNPOD_API_KEY")).toBeUndefined();
    }
  });

  it("binds MODULE_DISPATCH -> the modules namespace on the STUDIO worker (upload metadata, not code)", async () => {
    const t = await tenant();
    const d = deps();
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    await runProvisionJob(d, job.id, t, "rpa_keyA");

    const studio = uploads(d).find((u) => u.namespace === "vivijure-tenants")!;
    const md = studio.bindings.find((b) => b.name === "MODULE_DISPATCH") as
      | { type: string; namespace?: string }
      | undefined;
    expect(md?.type).toBe("dispatch_namespace");
    expect(md?.namespace).toBe("vivijure-tenant-modules");
  });

  it("drives the studio's own install route for each module and verifies a non-empty installed set", async () => {
    const t = await tenant();
    const d = deps();
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const res = await runProvisionJob(d, job.id, t, "rpa_keyA");
    expect(res.ok).toBe(true);

    const studioCalls = (d.callTenantStudio as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1] as { method: string; path: string; body?: string },
    );
    const installs = studioCalls.filter((c) => c.path === "/api/modules/install");
    expect(installs).toHaveLength(5);
    // Each install carries the tenant-prefixed script name (not the bare module name).
    const scriptNames = installs.map((c) => JSON.parse(c.body!).script_name).sort();
    expect(scriptNames).toEqual(
      ["keyframe", "own-gpu", "finish-upscale", "finish-lipsync", "speech-upscale"]
        .map((n) => `${t.id}-${n}`.replace(/_/g, "-"))
        .sort(),
    );
    // And the installed-list verify ran.
    expect(studioCalls.some((c) => c.path === "/api/modules/installed")).toBe(true);
  });

  it("FAILS the provision (modules_install) when a module does not pass the studio's conformance gate", async () => {
    const t = await tenant();
    const d = deps({
      callTenantStudio: vi.fn(async (_s: string, init: { path: string }) => {
        if (init.path === "/api/modules/install")
          return { status: 422, text: JSON.stringify({ ok: false, error: "conformance failed" }) };
        return { status: 200, text: "" };
      }),
    });
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const res = await runProvisionJob(d, job.id, t, "rpa_keyA");
    expect(res).toMatchObject({ ok: false, step: "modules_install" });
    expect(expectProvisionFailure(res).message).toContain("conformance failed");
    expect(store.tenants.get(t.id)?.status).toBe("failed");
  });

  it("FAILS the provision (verify) when the studio reports ZERO installed modules", async () => {
    const t = await tenant();
    const d = deps({
      callTenantStudio: vi.fn(async (_s: string, init: { path: string }) => {
        if (init.path === "/api/modules/install") return { status: 201, text: "{}" };
        if (init.path === "/api/modules/installed") return { status: 200, text: JSON.stringify({ modules: [] }) };
        return { status: 200, text: "" };
      }),
    });
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const res = await runProvisionJob(d, job.id, t, "rpa_keyA");
    expect(res).toMatchObject({ ok: false, step: "verify" });
    expect(expectProvisionFailure(res).message).toContain("zero installed modules");
  });

  it("teardown sweeps the tenant's module scripts by prefix and censuses that zero remain", async () => {
    const t = await tenant();
    await store.setTenantD1(t.id, "db-1");
    await store.setTenantBucket(t.id, "vivijure-tenant-hero");
    const fresh = (await store.getTenantById(t.id))!;
    const pfx = `${t.id}-`.replace(/_/g, "-");
    const resident = [`${pfx}keyframe`, `${pfx}own-gpu`, "other-tenant-keyframe"];
    let deleted: string[] = [];
    const d = deps({
      cf: fakeCf({
        listNamespaceScripts: vi.fn(async (ns: string) =>
          ns === "vivijure-tenant-modules" ? resident.filter((n) => !deleted.includes(n)) : [],
        ),
        deleteUserWorker: vi.fn(async (ns: string, script: string) => {
          calls.push("deleteUserWorker");
          if (ns === "vivijure-tenant-modules") deleted.push(script);
        }),
      }),
    });
    const res = await teardownTenant(d, fresh, { deleteData: true });
    // Only THIS tenant's scripts are swept; the other tenant's script is untouched.
    expect(deleted.sort()).toEqual([`${pfx}keyframe`, `${pfx}own-gpu`].sort());
    expect(deleted).not.toContain("other-tenant-keyframe");
    expect(res.ok).toBe(true);
  });

  it("teardown reports a module script that will not evict (census still finds it)", async () => {
    const t = await tenant();
    await store.setTenantD1(t.id, "db-1");
    const fresh = (await store.getTenantById(t.id))!;
    const pfx = `${t.id}-`.replace(/_/g, "-");
    const d = deps({
      cf: fakeCf({
        listNamespaceScripts: vi.fn(async (ns: string) => (ns === "vivijure-tenant-modules" ? [`${pfx}keyframe`] : [])),
        deleteUserWorker: vi.fn(async (_ns: string, script: string) => {
          if (script.startsWith(pfx)) throw new Error("module script busy");
        }),
      }),
    });
    const res = await teardownTenant(d, fresh, { deleteData: true });
    expect(res.ok).toBe(false);
    const census = res.failures.find((f) => f.resource === "modules_census");
    expect(census?.error).toContain(`${pfx}keyframe`);
  });
});
