// Poll-driven provision continuation, its lease, and the lost-invocation reap (#112).
//
// WHY THIS EXISTS: a provision does not fit in one invocation. Run 4 of the cf#99 finale spent 22 of
// its ~30 waitUntil seconds before the module install even started, then the runtime cancelled the
// invocation mid-probe. Nothing wrote a terminal state, because the catch that writes one only runs
// if the function is still running, so the job said "running" forever and the tenant was stranded at
// "provisioning" with no error and no retry path.
//
// The fix is to stop trying to fit: work until the budget is spent, persist progress, and let the
// next poll drive the rest. That introduces exactly one new hazard -- overlapping polls -- so the
// lease contention case is tested as hard as the happy path.

import { describe, it, expect, vi } from "vitest";
import {
  PROVISION_STEPS,
  continueProvisionJob,
  runProvisionJob,
  readTenantEndpoints,
  type ProvisionDeps,
} from "../src/provisioner";
import type { CfApi } from "../src/cf-api";
import type { Tenant } from "../src/store";
import { encryptStudioToken } from "../src/token-crypto";
import { MemoryStore } from "./memory-store";

const KEK = btoa("0123456789abcdef0123456789abcdef");
const MIGRATIONS = [{ name: "0001_init.sql", sql: "CREATE TABLE IF NOT EXISTS projects (id TEXT);" }];
// All four, because the module catalog maps a module onto each one; a short list fails at
// modules_upload rather than testing what this file is about.
const ENDPOINTS = [
  { key: "backend", label: "Render", id: "ep1", name: "n1", endpointVar: "RUNPOD_ENDPOINT_ID" },
  { key: "upscale", label: "Upscale", id: "ep2", name: "n2", endpointVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { key: "lipsync", label: "Lipsync", id: "ep3", name: "n3", endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID" },
  { key: "audio-upscale", label: "Audio", id: "ep4", name: "n4", endpointVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
];

/** A clock the test drives by hand, so a 15s budget costs no real time. */
function fakeClock(step = 0) {
  let t = 0;
  return { now: () => (t += step), set: (v: number) => (t = v) };
}

function fakeCf(over: Record<string, unknown> = {}) {
  return {
    createD1: vi.fn(async () => ({ uuid: "db-1" })),
    queryD1: vi.fn(async () => [{ results: [] }]),
    createR2Bucket: vi.fn(async () => undefined),
    r2BucketExists: vi.fn(async () => false),
    uploadUserWorker: vi.fn(async () => undefined),
    putScriptSecret: vi.fn(async () => undefined),
    createDispatchNamespace: vi.fn(async () => undefined),
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
      { type: "plain_text", name: "RUNPOD_ENDPOINT_ID" },
      { type: "plain_text", name: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
      { type: "plain_text", name: "MUSETALK_RUNPOD_ENDPOINT_ID" },
      { type: "plain_text", name: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
    ]),
    getScriptSecretNames: vi.fn(async () => ["R2_S3_SECRET_ACCESS_KEY", "STUDIO_API_TOKEN"]),
    createAssetsUploadSession: vi.fn(async () => ({ jwt: "j", buckets: [] })),
    uploadAssetBucket: vi.fn(async () => ({ jwt: "j2" })),
    ...over,
  } as unknown as CfApi;
}

function deps(store: MemoryStore, over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    store,
    cf: fakeCf(),
    runpod: { createEndpoints: vi.fn(async () => ENDPOINTS) },
    tokenMinter: {
      mintBucketToken: vi.fn(async () => ({ id: "tok-1", value: "SECRET" })),
      revoke: vi.fn(async () => undefined),
    },
    bundle: { fetch: vi.fn(async () => ({ mainModule: "i.js", moduleText: "export default {}", compatibilityDate: "2026-06-01" })) },
    moduleBundle: { fetch: vi.fn(async () => ({ mainModule: "i.js", moduleText: "export default {}", compatibilityDate: "2026-06-01" })) },
    moduleNamespace: "vivijure-tenant-modules",
    r2Endpoint: "https://acct.r2.cloudflarestorage.com",
    namespace: "vivijure-tenants",
    release: "v1.0.0",
    tenantScriptName: (slug: string) => `tenant-${slug}-studio`,
    kek: KEK,
    spendDailyCeiling: null,
    probeTenantRoot: vi.fn(async () => ({ status: 200 })),
    // 201 on install is the studio's real success code; 200 is a FAILURE there. Modelled exactly,
    // because a fake that is generous about status codes proves nothing about the caller.
    callTenantStudio: vi.fn(async (_s: string, init: { path: string }) => {
      if (init.path === "/api/modules/installed") {
        return { status: 200, text: JSON.stringify({ modules: [{ name: "keyframe" }] }) };
      }
      if (init.path === "/api/modules/install") return { status: 201, text: "{}" };
      return { status: 200, text: "{}" };
    }),
    log: () => undefined,
    ...over,
  } as unknown as ProvisionDeps;
}

async function seedTenant(store: MemoryStore, opts: { throughStudio?: boolean } = {}) {
  await store.createAccount("acct_1", "a@b.com");
  const t = await store.createTenant("ten_1", "hero", "acct_1", "provisioning");
  if (opts.throughStudio) {
    await store.setTenantEndpoints(t.id, JSON.stringify(ENDPOINTS));
    await store.setTenantStudioToken(t.id, await encryptStudioToken(KEK, "the-studio-token"));
    await store.setTenantScript(t.id, "tenant-hero-studio", "v1.0.0");
  }
  return (await store.getTenantById(t.id)) as Tenant;
}

describe("the job lease (#112 concurrency guard)", () => {
  it("CONTENTION: of two racing pollers, exactly ONE wins the claim", async () => {
    // Without this, both polls drive the provisioner and we double-mint credentials.
    const store = new MemoryStore();
    await seedTenant(store);
    const job = await store.createProvisionJob("job_1", "ten_1", "provision");

    const results = await Promise.all([store.claimJob(job.id, 60), store.claimJob(job.id, 60)]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a second poller is refused while the lease is LIVE", async () => {
    const store = new MemoryStore();
    await seedTenant(store);
    const job = await store.createProvisionJob("job_1", "ten_1", "provision");

    expect(await store.claimJob(job.id, 60)).toBe(true);
    expect(await store.claimJob(job.id, 60)).toBe(false);
  });

  it("an EXPIRED lease is reclaimable, so a dead driver does not freeze the job", async () => {
    const store = new MemoryStore();
    await seedTenant(store);
    const job = await store.createProvisionJob("job_1", "ten_1", "provision");

    expect(await store.claimJob(job.id, -1)).toBe(true); // already expired
    expect(await store.claimJob(job.id, 60)).toBe(true);
  });

  it("a FINISHED job cannot be claimed at all", async () => {
    const store = new MemoryStore();
    await seedTenant(store);
    const job = await store.createProvisionJob("job_1", "ten_1", "provision");
    await store.finishJob(job.id, "succeeded", null, null);

    expect(await store.claimJob(job.id, 60)).toBe(false);
  });
});

describe("runProvisionJob budget yielding", () => {
  it("THE #112 GATE: running out of budget YIELDS, it does not fail the job", async () => {
    // The old behaviour was worse than a failure: nothing was written at all.
    const store = new MemoryStore();
    const t = await seedTenant(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    // Clock jumps a full budget per reading, so the first mark() is already over.
    const res = await runProvisionJob(deps(store), job.id, t, "rpa_keyA", MIGRATIONS, fakeClock(20_000), 15_000);

    expect(res).toMatchObject({ ok: false, yielded: true });
    const after = store.jobs.get("job_1")!;
    expect(after.status).toBe("running");
    expect(after.error_message).toBeNull();
    expect(JSON.parse(after.steps_done).length).toBeGreaterThan(0); // progress persisted
  });

  it("finishes in one invocation when the budget is ample (no behaviour change)", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision");

    const res = await runProvisionJob(deps(store), job.id, t, "rpa_keyA", MIGRATIONS, fakeClock(0), 15_000);

    expect(res).toEqual({ ok: true, status: "awaiting_invoke_key" });
    expect(store.jobs.get("job_1")!.status).toBe("succeeded");
    expect(JSON.parse(store.jobs.get("job_1")!.steps_done)).toEqual([...PROVISION_STEPS]);
  });
});

describe("continueProvisionJob", () => {
  it("RESUMES a job stranded after wfp_upload and drives it to succeeded, with NO key A", async () => {
    // Exactly run 4: the invocation died inside modules_install. Key A is gone forever by design.
    const store = new MemoryStore();
    const t = await seedTenant(store, { throughStudio: true });
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const stepsDone = ["d1_create", "d1_migrate", "r2_bucket", "r2_token", "runpod_endpoints", "wfp_upload"];
    await store.updateJobProgress(job.id, "wfp_upload", JSON.stringify(stepsDone));

    const res = await continueProvisionJob(deps(store), job.id, t, stepsDone, fakeClock(0), 15_000);

    expect(res).toEqual({ ok: true, status: "awaiting_invoke_key" });
    expect(store.jobs.get("job_1")!.status).toBe("succeeded");
    expect(store.tenants.get(t.id)!.status).toBe("awaiting_invoke_key");
  });

  it("does NOT redo steps already recorded", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store, { throughStudio: true });
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const stepsDone = [...PROVISION_STEPS].slice(0, PROVISION_STEPS.indexOf("modules_install"));
    const d = deps(store);

    await continueProvisionJob(d, job.id, t, stepsDone, fakeClock(0), 15_000);

    // modules_upload was already done, so the module bundles must NOT be fetched again.
    expect((d as unknown as { moduleBundle: { fetch: ReturnType<typeof vi.fn> } }).moduleBundle.fetch).not.toHaveBeenCalled();
  });

  it("REFUSES honestly when the job never reached the studio upload (key A is unrecoverable)", async () => {
    // A continuation cannot mint endpoints: key A lives only in the request that carried it. Saying
    // so beats waiting forever for a driver that can never succeed.
    const store = new MemoryStore();
    const t = await seedTenant(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const stepsDone = ["d1_create", "d1_migrate"];

    const res = await continueProvisionJob(deps(store), job.id, t, stepsDone, fakeClock(0), 15_000);

    expect(res).toMatchObject({ ok: false });
    expect((res as { message: string }).message).toMatch(/start provisioning again/);
    expect(store.jobs.get("job_1")!.status).toBe("failed");
  });

  it("yields again if one continuation is still not enough", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store, { throughStudio: true });
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const stepsDone = ["d1_create", "d1_migrate", "r2_bucket", "r2_token", "runpod_endpoints", "wfp_upload"];

    const res = await continueProvisionJob(deps(store), job.id, t, stepsDone, fakeClock(20_000), 15_000);

    expect(res).toMatchObject({ ok: false, yielded: true });
    // The invariant that matters: a yield must never look like a failure to anyone reading the row.
    const after = store.jobs.get("job_1")!;
    expect(after.status).not.toBe("failed");
    expect(after.error_message).toBeNull();
    expect(after.finished_at).toBeNull();
  });
});

describe("readTenantEndpoints", () => {
  it("reads the stored objects, endpointVar and all", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store, { throughStudio: true });
    expect(readTenantEndpoints(t).map((e) => e.endpointVar)).toEqual([
      "RUNPOD_ENDPOINT_ID",
      "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID",
      "MUSETALK_RUNPOD_ENDPOINT_ID",
      "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID",
    ]);
  });

  it("treats a malformed row as NO endpoints rather than guessing (the #92 lesson)", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store);
    await store.setTenantEndpoints(t.id, JSON.stringify(["ep1", "ep2"])); // ids only, no endpointVar
    const reread = (await store.getTenantById(t.id)) as Tenant;
    expect(readTenantEndpoints(reread)).toEqual([]);
  });
});
