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
    bundle: {
      fetch: vi.fn(async () => ({
        mainModule: "i.js",
        moduleText: "export default {}",
        compatibilityDate: "2026-06-01",
        migrations: MIGRATIONS,
        requiredVars: [],
      })),
    },
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
    const res = await runProvisionJob(deps(store), job.id, t, "rpa_keyA", fakeClock(20_000), 15_000);

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

    const res = await runProvisionJob(deps(store), job.id, t, "rpa_keyA", fakeClock(0), 15_000);

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

// ---- the runpod_endpoints -> wfp_upload strand (cp#18) ------------------------------------------
//
// THE STRAND: mark() checked the invocation budget AFTER every step uniformly, runpod_endpoints
// included. A yield there left a job with 4 BILLABLE RunPod endpoints created but the studio never
// uploaded -- and continueProvisionJob (a poll, no key A) can only resume from wfp_upload onward, so
// that job was permanently unresumable. The fix carries runpod_endpoints THROUGH to wfp_upload in the
// same invocation, so the yield boundary lines up with the resume boundary and no such window exists.
//
// These force the budget to cross EXACTLY at the runpod_endpoints boundary (and nowhere earlier), then
// prove (a) the yield never lands inside the window, and (b) the resulting job is driven to succeeded
// by a keyless poll -- the real-world recovery that was impossible before.
describe("the runpod_endpoints -> wfp_upload yield strand (cp#18)", () => {
  // Reads: [start, d1_create, d1_migrate, r2_bucket, r2_token, runpod_endpoints, wfp_upload, ...].
  // Under 15s through r2_token, over 15s at runpod_endpoints: the budget is crossed in the window.
  const CROSS_AT_RUNPOD = [0, 100, 200, 300, 400, 20_000, 20_100, 20_200, 20_300, 20_400, 20_500];

  it("never yields in the unresumable window: a yield past runpod_endpoints carries wfp_upload too", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const d = deps(store);

    const res = await runProvisionJob(d, job.id, t, "rpa_keyA", scriptedClock(CROSS_AT_RUNPOD), 15_000);

    // The budget WAS crossed and the billable endpoints WERE created: this is genuinely the window.
    expect(res).toMatchObject({ ok: false, yielded: true });
    expect((d as unknown as { runpod: { createEndpoints: ReturnType<typeof vi.fn> } }).runpod.createEndpoints).toHaveBeenCalledTimes(1);
    const done = JSON.parse(store.jobs.get("job_1")!.steps_done) as string[];
    expect(done).toContain("runpod_endpoints");
    // THE INVARIANT: endpoints created implies the studio was uploaded, because only from wfp_upload
    // onward can a keyless continueProvisionJob carry the job forward. RED on today code (yield lands
    // right after runpod_endpoints, wfp_upload absent).
    expect(done).toContain("wfp_upload");
  });

  it("the yielded job is RESUMABLE to succeeded by a keyless poll", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision");

    // First invocation crosses the budget at the runpod_endpoints boundary and yields.
    const first = await runProvisionJob(deps(store), job.id, t, "rpa_keyA", scriptedClock(CROSS_AT_RUNPOD), 15_000);
    expect(first).toMatchObject({ ok: false, yielded: true });

    // A poll picks it up with NO key A, exactly as production polls never carry one.
    const stepsDone = JSON.parse(store.jobs.get("job_1")!.steps_done) as string[];
    const resumed = (await store.getTenantById(t.id)) as Tenant;
    const res = await continueProvisionJob(deps(store), job.id, resumed, stepsDone, fakeClock(0), 15_000);

    // GREEN only when the first invocation reached wfp_upload; on today code the poll REFUSES (no
    // key A) and the job is stranded failed with 4 endpoints live.
    expect(res).toEqual({ ok: true, status: "awaiting_invoke_key" });
    expect(store.jobs.get("job_1")!.status).toBe("succeeded");
    expect(store.tenants.get(t.id)!.status).toBe("awaiting_invoke_key");
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

// ---- per-step timing instrumentation (cp#18) ----------------------------------------------------
//
// THE GAP: elapsedMs was logged ONLY on yield, so a provision that SUCCEEDED recorded no timing
// anywhere, and D1 could not fill it in (steps_done holds NAMES, updated_at is overwritten by every
// progress write). cp#18 must be MEASURED rather than argued, and the measurement did not exist.
//
// These tests are about the NUMBERS being right and the SUCCESS path being covered. The control at
// the bottom is about the instrument not having changed the thing it measures.

/** A clock that returns a scripted sequence, so every stepMs below is an exact expected value. */
function scriptedClock(times: readonly number[]) {
  let i = 0;
  return { now: () => times[Math.min(i++, times.length - 1)] };
}

type StepLog = { step: string; stepMs: number; elapsedMs: number; phase: string };

const stepLogs = (logs: { event: string; fields: Record<string, unknown> }[]): StepLog[] =>
  logs.filter((l) => l.event === "provision.step").map((l) => l.fields as unknown as StepLog);

describe("per-step provision timing (cp#18)", () => {
  it("records timing on the SUCCESS path -- the entire gap this closes", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const logs: { event: string; fields: Record<string, unknown> }[] = [];

    const res = await runProvisionJob(
      deps(store, { log: (event, fields) => void logs.push({ event, fields }) }),
      job.id,
      t,
      "rpa_keyA",
      // A budget nothing can exhaust: this run must SUCCEED, because success is the path that
      // previously produced no timing at all.
      scriptedClock([0]),
      10_000_000,
    );

    expect(res).toMatchObject({ ok: true });
    // Not "some logs": one per step actually completed, which is what makes the record usable.
    const steps = stepLogs(logs);
    expect(steps.length).toBe(JSON.parse(store.jobs.get("job_1")!.steps_done).length);
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) expect(s).toMatchObject({ phase: "provision" });
  });

  it("stepMs is THIS step alone; elapsedMs stays cumulative", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    // now() is read once at start, then exactly once per mark. Deltas are uneven on purpose: a
    // cumulative-vs-per-step bug is invisible against evenly spaced readings.
    const times = [0, 100, 350, 1_350, 1_400, 6_400, 6_450, 6_500, 6_600, 6_700, 6_800];

    await runProvisionJob(
      deps(store, { log: (event, fields) => void logs.push({ event, fields }) }),
      job.id,
      t,
      "rpa_keyA",
      scriptedClock(times),
      10_000_000,
    );

    const steps = stepLogs(logs);
    steps.forEach((s, i) => {
      // Derived from the SCRIPT, not read off the output: this fails if stepMs ever goes cumulative.
      expect(s.stepMs).toBe(times[i + 1] - times[i]);
      expect(s.elapsedMs).toBe(times[i + 1] - times[0]);
    });
    // And the two numbers genuinely diverge in this run, so the assertion above is not vacuous.
    expect(steps.some((s) => s.stepMs !== s.elapsedMs)).toBe(true);
  });

  it("resolves the two steps cp#18 is actually about, by name", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const logs: { event: string; fields: Record<string, unknown> }[] = [];

    await runProvisionJob(
      deps(store, { log: (event, fields) => void logs.push({ event, fields }) }),
      job.id,
      t,
      "rpa_keyA",
      scriptedClock([0]),
      10_000_000,
    );

    const byStep = new Map(stepLogs(logs).map((s) => [s.step, s]));
    // Option (1) in cp#18 treats these two as one atomic couplet. That is viable only if their
    // combined worst case fits the 15s budget, which cannot be argued without these two numbers.
    expect(byStep.has("runpod_endpoints")).toBe(true);
    expect(byStep.has("wfp_upload")).toBe(true);
    for (const step of ["runpod_endpoints", "wfp_upload"]) {
      expect(typeof byStep.get(step)!.stepMs).toBe("number");
      expect(Number.isFinite(byStep.get(step)!.stepMs)).toBe(true);
    }
  });

  it("logs the timing of the step that TRIGGERS the yield, before throwing", async () => {
    // The step that blew the budget is the most interesting measurement in the whole run. Logging
    // after the budget check would silently drop exactly that one.
    const store = new MemoryStore();
    const t = await seedTenant(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const logs: { event: string; fields: Record<string, unknown> }[] = [];

    const res = await runProvisionJob(
      deps(store, { log: (event, fields) => void logs.push({ event, fields }) }),
      job.id,
      t,
      "rpa_keyA",
      scriptedClock([0, 20_000]),
      15_000,
    );

    expect(res).toMatchObject({ ok: false, yielded: true });
    const steps = stepLogs(logs);
    expect(steps.length).toBe(1);
    expect(steps[0]).toMatchObject({ stepMs: 20_000, elapsedMs: 20_000 });
    // The yielded event still carries what it always did.
    expect(logs.some((l) => l.event === "provision.yielded")).toBe(true);
  });

  it("tags the RESUME path so its steps are distinguishable from a first invocation", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store, { throughStudio: true });
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    const logs: { event: string; fields: Record<string, unknown> }[] = [];

    await continueProvisionJob(
      deps(store, { log: (event, fields) => void logs.push({ event, fields }) }),
      job.id,
      t,
      PROVISION_STEPS.slice(0, PROVISION_STEPS.indexOf("wfp_upload") + 1),
      scriptedClock([0]),
      10_000_000,
    );

    const steps = stepLogs(logs);
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) expect(s.phase).toBe("resume");
  });

  // ---- THE CONTROL ----
  //
  // Instrumenting a thing must not change the thing. The budget check now reuses the timestamp the
  // log line already read, rather than reading the clock a second time -- and that detail is
  // load-bearing here, because these tests drive a clock that ADVANCES ON EVERY READ. A second read
  // per mark would make every yield fire earlier and quietly invalidate the measurement.
  it("CONTROL: one clock read per mark, so yield timing is unchanged", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision");
    let reads = 0;
    const counting = { now: () => (reads++, 0) };

    await runProvisionJob(deps(store), job.id, t, "rpa_keyA", counting, 10_000_000);

    const marks = JSON.parse(store.jobs.get("job_1")!.steps_done).length;
    // 1 read for startedAt + exactly 1 per mark. If instrumentation ever adds its own read, this
    // fails and the yield-timing tests above become untrustworthy.
    expect(reads).toBe(marks + 1);
  });
});
