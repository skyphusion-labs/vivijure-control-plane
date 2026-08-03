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
import type { Tenant, ProvisionJob } from "../src/store";
import { jobHasLiveDriver } from "../src/store";
import { encryptStudioToken, kekRing } from "../src/token-crypto";
import { MemoryStore, TEST_PROVISION_FACTS } from "./memory-store";

const KEK = btoa("0123456789abcdef0123456789abcdef");
const RING = kekRing(KEK);
const MIGRATIONS = [{ name: "0001_init.sql", sql: "CREATE TABLE IF NOT EXISTS projects (id TEXT);" }];
// All four, because the module catalog maps a module onto each one; a short list fails at
// modules_upload rather than testing what this file is about.
const ENDPOINTS = [
  { key: "backend", label: "Render", id: "ep1", name: "n1", endpointVar: "RUNPOD_ENDPOINT_ID" },
  { key: "upscale", label: "Upscale", id: "ep2", name: "n2", endpointVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { key: "lipsync", label: "Lipsync", id: "ep3", name: "n3", endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID" },
  { key: "audio-upscale", label: "Audio", id: "ep4", name: "n4", endpointVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
];

/**
 * The R2 S3 secret the provisioner derives from a minted token value.
 *
 * Recomputed here from the DOCUMENTED rule (SHA-256 hex of the token value) rather than imported,
 * because sha256Hex is private to provisioner.ts. Derived, not transcribed: a hardcoded digest would
 * be two single-engine tests that agree with each other and could both be wrong together.
 */
async function expectedS3Secret(tokenValue: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenValue));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
  const cf = fakeCf();
  return {
    store,
    cf,
    // Same object as cf: the fallback path, so a test asserting on cf's log sees the upload.
    scriptUploadCf: cf,
    videoFinishServiceId: null,
    runpod: { createEndpoints: vi.fn(async () => ENDPOINTS), convergeTemplateImages: vi.fn(async () => []) },
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
        requiredVars: [],
      })),
    },
    moduleBundle: { fetch: vi.fn(async () => ({ mainModule: "i.js", moduleText: "export default {}", compatibilityDate: "2026-06-01" })) },
    moduleNamespace: "vivijure-tenant-modules",
    r2Endpoint: "https://acct.r2.cloudflarestorage.com",
    namespace: "vivijure-tenants",
    release: "v1.0.0",
    tenantScriptName: (slug: string) => `tenant-${slug}-studio`,
    kek: RING,
    spendDailyCeiling: null,
    // cp#183: the fixture plane configures a per-tenant storage ceiling, because a plane that caps
    // nothing is the state that lane exists to end. Tests covering unset or malformed override it.
    storageQuota: { bytes: "107374182400", invalid: null },
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
    // Reaching the studio upload means the D1 was created and recorded several steps earlier; the
    // module upload binds it as TELEMETRY_DB (cp#248).
    await store.setTenantD1(t.id, "d1-uuid-hero");
    await store.setTenantStudioToken(t.id, await encryptStudioToken(RING, "the-studio-token"));
    await store.setTenantScript(t.id, "tenant-hero-studio", "v1.0.0");
  }
  return (await store.getTenantById(t.id)) as Tenant;
}

describe("the job lease (#112 concurrency guard)", () => {
  it("CONTENTION: of two racing pollers, exactly ONE wins the claim", async () => {
    // Without this, both polls drive the provisioner and we double-mint credentials.
    const store = new MemoryStore();
    await seedTenant(store);
    const job = await store.createProvisionJob("job_1", "ten_1", "provision", TEST_PROVISION_FACTS);

    const results = await Promise.all([store.claimJob(job.id, 60), store.claimJob(job.id, 60)]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a second poller is refused while the lease is LIVE", async () => {
    const store = new MemoryStore();
    await seedTenant(store);
    const job = await store.createProvisionJob("job_1", "ten_1", "provision", TEST_PROVISION_FACTS);

    expect(await store.claimJob(job.id, 60)).toBe(true);
    expect(await store.claimJob(job.id, 60)).toBe(false);
  });

  it("an EXPIRED lease is reclaimable, so a dead driver does not freeze the job", async () => {
    const store = new MemoryStore();
    await seedTenant(store);
    const job = await store.createProvisionJob("job_1", "ten_1", "provision", TEST_PROVISION_FACTS);

    expect(await store.claimJob(job.id, -1)).toBe(true); // already expired
    expect(await store.claimJob(job.id, 60)).toBe(true);
  });

  it("a FINISHED job cannot be claimed at all", async () => {
    const store = new MemoryStore();
    await seedTenant(store);
    const job = await store.createProvisionJob("job_1", "ten_1", "provision", TEST_PROVISION_FACTS);
    await store.finishJob(job.id, "succeeded", null, null);

    expect(await store.claimJob(job.id, 60)).toBe(false);
  });
});

describe("jobHasLiveDriver (#44 upgrade guard)", () => {
  const now = Date.now();
  const liveLease = new Date(now + 60_000).toISOString().replace("T", " ").slice(0, 19);
  const expiredLease = new Date(now - 60_000).toISOString().replace("T", " ").slice(0, 19);

  const job = (overrides: Partial<ProvisionJob>): ProvisionJob => ({
    id: "job_1",
    tenant_id: "ten_1",
    kind: "module_upgrade",
    status: "queued",
    step: null,
    steps_done: "[]",
    error_step: null,
    error_message: null,
    attempts: 0,
    lease_until: null,
    from_release: "v1.0.0",
    to_release: "v1.1.0",
    // kind is module_upgrade here: an upgrade carries no provision mode.
    runpod_mode: null,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    finished_at: null,
    ...overrides,
  });

  it("queued with a live lease blocks; queued with no lease does not (#44 self-heal)", () => {
    expect(jobHasLiveDriver(job({ status: "queued", lease_until: liveLease }), now)).toBe(true);
    expect(jobHasLiveDriver(job({ status: "queued", lease_until: null }), now)).toBe(false);
  });

  it("running with an expired lease does not block", () => {
    expect(jobHasLiveDriver(job({ status: "running", lease_until: expiredLease }), now)).toBe(false);
  });

  it("terminal statuses never block", () => {
    expect(jobHasLiveDriver(job({ status: "succeeded" }), now)).toBe(false);
    expect(jobHasLiveDriver(job({ status: "failed" }), now)).toBe(false);
  });
});

describe("runProvisionJob budget yielding", () => {
  it("THE #112 GATE: running out of budget YIELDS, it does not fail the job", async () => {
    // The old behaviour was worse than a failure: nothing was written at all.
    const store = new MemoryStore();
    const t = await seedTenant(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
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
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);

    const res = await runProvisionJob(deps(store), job.id, t, "rpa_keyA", fakeClock(0), 15_000);

    expect(res).toEqual({ ok: true, status: "awaiting_invoke_key" });
    expect(store.jobs.get("job_1")!.status).toBe("succeeded");
    expect(JSON.parse(store.jobs.get("job_1")!.steps_done)).toEqual([...PROVISION_STEPS]);
  });
});

describe("cp#158: a yielding driver HANDS THE LEASE BACK instead of leaving it to expire", () => {
  /**
   * THE LATENCY, filed out of cp#148 and measured in dead time rather than in wrongness.
   *
   * A yield means this driver is done writing and the next poll is meant to carry on. But the lease
   * it leaves behind is a fresh JOB_LEASE_SECONDS (updateJobProgress re-arms it on every mark), so
   * claimJob refuses every poll for up to a full minute while NOTHING is driving the job. On the
   * cp#124 cadence that is up to a minute added to a provision, per yield, for no reason anyone
   * chose.
   *
   * These assertions fail on the pre-cp#158 provisioner: the lease is live and the claim is refused.
   */
  it("the job is claimable IMMEDIATELY after a yield, with no lease left to wait out", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);

    // THE CONTROL, taken BEFORE the yield: the same store, the same claim, on a job whose lease is
    // live. If claimJob said yes to everything this suite would prove nothing about the release.
    const control = await store.createProvisionJob("job_control", t.id, "provision", TEST_PROVISION_FACTS);
    await store.setJobRunning(control.id);
    expect(await store.claimJob(control.id, 60)).toBe(false);

    const res = await runProvisionJob(deps(store), job.id, t, "rpa_keyA", fakeClock(20_000), 15_000);
    expect(res).toMatchObject({ ok: false, yielded: true });

    const after = store.jobs.get("job_1")!;
    // The row still reads as a live, progressing job to everyone else -- it just is not LEASED.
    expect(after.status).toBe("running");
    expect(after.error_message).toBeNull();
    expect(after.lease_until).toBeNull();
    expect(await store.claimJob("job_1", 60)).toBe(true);
  });

  it("a RESUMED driver hands it back too, so a multi-yield provision pays the wait exactly never", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store, { throughStudio: true });
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
    await store.setJobRunning(job.id);
    const stepsDone = ["d1_create", "d1_migrate", "r2_bucket", "r2_token", "runpod_endpoints", "wfp_upload"];

    const res = await continueProvisionJob(deps(store), job.id, t, stepsDone, fakeClock(20_000), 15_000);

    expect(res).toMatchObject({ ok: false, yielded: true });
    expect(store.jobs.get("job_1")!.lease_until).toBeNull();
    expect(await store.claimJob("job_1", 60)).toBe(true);
  });

  it("the heartbeat does NOT outlive the yield and re-arm the released lease", async () => {
    // WHAT THIS PROVES, stated exactly: the interval is cleared, so no beat lands after the driver
    // has gone. It does NOT prove the ORDER of stop-then-release inside the yield branch; that
    // ordering guards a sub-millisecond interleaving (a beat landing between the release write and
    // the clearInterval) that cannot be staged without instrumenting the timer, and it is written
    // that way because the cost of getting it wrong is a full lease term of dead time.
    vi.useFakeTimers();
    try {
      const store = new MemoryStore();
      const t = await seedTenant(store);
      const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);

      const res = await runProvisionJob(deps(store), job.id, t, "rpa_keyA", fakeClock(20_000), 15_000);
      expect(res).toMatchObject({ ok: false, yielded: true });

      // Three heartbeat intervals past the yield. A timer that outlived its driver shows up here.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.jobs.get("job_1")!.lease_until).toBeNull();
      expect(await store.claimJob("job_1", 60)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a driver whose job was already FINISHED by someone else cannot write to it on the way out", async () => {
    // The terminal-job predicate, same as renewJobLease and updateJobProgress carry. finishJob NULLs
    // the lease anyway, so what this actually proves is that the release does not touch a closed
    // record: the store refuses it rather than the column happening to look right.
    const store = new MemoryStore();
    const t = await seedTenant(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
    await store.finishJob(job.id, "failed", "d1_create", "taken by a poll");

    expect(await store.releaseJobLease(job.id)).toBe(false);
    expect(store.jobs.get("job_1")!.status).toBe("failed");
  });
});

describe("continueProvisionJob", () => {
  it("RESUMES a job stranded after wfp_upload and drives it to succeeded, with NO key A", async () => {
    // Exactly run 4: the invocation died inside modules_install. Key A is gone forever by design.
    const store = new MemoryStore();
    const t = await seedTenant(store, { throughStudio: true });
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
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
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
    const stepsDone = [...PROVISION_STEPS].slice(0, PROVISION_STEPS.indexOf("modules_install"));
    const d = deps(store);

    await continueProvisionJob(d, job.id, t, stepsDone, fakeClock(0), 15_000);

    // modules_upload was already done, so the module bundles must NOT be fetched again.
    expect((d as unknown as { moduleBundle: { fetch: ReturnType<typeof vi.fn> } }).moduleBundle.fetch).not.toHaveBeenCalled();
  });


  // ---------------------------------------------------------------------------------------------
  // cp#301: a resume must use the release the TENANT is on, never the plane's current pin.
  //
  // WHY NO EXISTING TEST COULD SEE THIS: `seedTenant({throughStudio:true})` records
  // studio_release "v1.0.0" and the `deps()` fixture sets `release: "v1.0.0"`. They are THE SAME
  // VALUE, so every assertion passed identically whether the code read the tenant or the plane.
  // The instrument was fully capable; the two inputs had simply never been allowed to differ.
  // Making them differ is the entire fixture change, and it is what turns these into tests.
  it("uses the TENANT's studio release for module bundles, not the plane's advanced pin", async () => {
    // The operator advanced STUDIO_RELEASE between this tenant's studio upload and the poll that
    // resumes it. Real: the pin moved v1.13.0 -> v1.19.3 in one day on 2026-08-03.
    const store = new MemoryStore();
    const t = await seedTenant(store, { throughStudio: true }); // studio_release = v1.0.0
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
    const stepsDone = ["d1_create", "d1_migrate", "r2_bucket", "r2_token", "runpod_endpoints", "wfp_upload"];
    await store.updateJobProgress(job.id, "wfp_upload", JSON.stringify(stepsDone));
    const d = deps(store, { release: "v2.0.0" } as Partial<ProvisionDeps>);

    const res = await continueProvisionJob(d, job.id, t, stepsDone, fakeClock(0), 15_000);

    expect(res).toEqual({ ok: true, status: "awaiting_invoke_key" });
    // EVERY module bundle fetch must ask for the tenant's release. Asserting on the calls rather
    // than on a count, because "it fetched something" is not the claim.
    const fetches = (d as unknown as { moduleBundle: { fetch: ReturnType<typeof vi.fn> } }).moduleBundle.fetch.mock.calls;
    expect(fetches.length).toBeGreaterThan(0); // floor: a vacuous pass proves nothing
    for (const call of fetches) expect(call[0]).toBe("v1.0.0");
    // and the recorded column must be a RECORD of what shipped, not a restatement of the pin.
    expect(store.tenants.get(t.id)!.modules_release).toBe("v1.0.0");
  });

  it("REFUSES a resume when no studio release is recorded, rather than falling back to the pin", async () => {
    // A fallback to deps.release would convert "I cannot tell which release this tenant is on" into
    // a confident wrong answer, which is the mismatch the fix exists to prevent. Structurally
    // unreachable today (guard 1 proves wfp_upload completed, which writes the column) -- asserted
    // anyway, because it must STAY a refusal when cp#301's re-mint work opens the earlier region.
    const store = new MemoryStore();
    const t = await seedTenant(store, { throughStudio: true });
    await store.setTenantStudioRelease(t.id, null);
    const stranded = (await store.getTenantById(t.id)) as Tenant;
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
    const stepsDone = ["d1_create", "d1_migrate", "r2_bucket", "r2_token", "runpod_endpoints", "wfp_upload"];
    const d = deps(store, { release: "v2.0.0" } as Partial<ProvisionDeps>);

    const res = await continueProvisionJob(d, job.id, stranded, stepsDone, fakeClock(0), 15_000);

    expect(res).toMatchObject({ ok: false });
    expect((res as { message: string }).message).toMatch(/no studio release recorded/);
    // NOT merely "it failed": it must not have shipped anything from the wrong release first.
    expect((d as unknown as { moduleBundle: { fetch: ReturnType<typeof vi.fn> } }).moduleBundle.fetch).not.toHaveBeenCalled();
  });

  // ---- cp#301 item 2: the restructured preamble --------------------------------------------------
  //
  // THE PROPERTY THIS BLOCK EXISTS TO PROVE, and it is the one the issue has been burned by three
  // times: this change makes NO state admissible that was refused before. It changes the REASON a
  // resume is refused, never the answer. Admitting the pre-upload region needs the credential
  // re-mint and a full re-run of wfp_upload (item 3); admitting it here would reach that step unable
  // to reconstruct s3Secret and bind a studio to a dead R2 secret.
  //
  // E-STATES ARE NAMED IN EVERY CASE so this suite and the table on the issue can be compared line
  // by line. E0 = nothing marked, E1..E5 = through d1_create..runpod_endpoints, E6 = through
  // wfp_upload (the first admissible state), E7/E8 = beyond it.

  describe("resume preamble, restructured (cp#301 item 2)", () => {
    // Progress prefixes, by E-id. Contiguous by construction, because mark() only ever appends.
    const E: Record<string, string[]> = {
      E0: [],
      E1: ["d1_create"],
      E2: ["d1_create", "d1_migrate"],
      E3: ["d1_create", "d1_migrate", "r2_bucket"],
      E4: ["d1_create", "d1_migrate", "r2_bucket", "r2_token"],
      E5: ["d1_create", "d1_migrate", "r2_bucket", "r2_token", "runpod_endpoints"],
      E6: ["d1_create", "d1_migrate", "r2_bucket", "r2_token", "runpod_endpoints", "wfp_upload"],
    };

    /**
     * Build a tenant row CONSISTENT with a progress prefix, the way production would leave it.
     *
     * The consistency is the point. runProvisionJob writes each resource id immediately BEFORE
     * marking its step, so a row and its progress record always agree; a fixture that disagrees is
     * a state the world cannot produce, and the integrity checks refuse it (see the dedicated cases
     * below, which drive exactly that on purpose).
     */
    async function at(steps: string[], mode: string | null = "shared") {
      const store = new MemoryStore();
      await store.createAccount("acct_1", "a@b.com");
      const t = await store.createTenant("ten_1", "hero", "acct_1", "provisioning");
      if (steps.includes("d1_create")) await store.setTenantD1(t.id, "d1-uuid-hero");
      if (steps.includes("r2_bucket")) await store.setTenantBucket(t.id, "vivijure-tenant-hero");
      // setTenantR2Token runs INSIDE step 4, so a row whose progress claims it always carries an id.
      if (steps.includes("r2_token")) await store.setTenantR2Token(t.id, "tok-OLD");
      if (steps.includes("runpod_endpoints")) await store.setTenantEndpoints(t.id, JSON.stringify(ENDPOINTS));
      if (steps.includes("wfp_upload")) {
        await store.setTenantStudioToken(t.id, await encryptStudioToken(RING, "the-studio-token"));
        await store.setTenantScript(t.id, "tenant-hero-studio", "v1.0.0");
      }
      const job = await store.createProvisionJob("job_1", t.id, "provision", {
        runpodMode: mode as never,
        toRelease: "v1.0.0",
      });
      if (mode === null) {
        // The pre-migration-0022 shape. SYNTHETIC and labelled: the current writer always records a
        // mode, so this stands in for every job row that existed on the plane before 0022 applied.
        store.jobs.get(job.id)!.runpod_mode = null;
      }
      const tenant = (await store.getTenantById(t.id))!;
      return { store, job, tenant };
    }

    const resume = async (steps: string[], mode: string | null = "shared") => {
      const { store, job, tenant } = await at(steps, mode);
      const d = deps(store);
      const res = await continueProvisionJob(d, job.id, tenant, steps, fakeClock(0), 15_000);
      const bundleFetch = (d as unknown as { moduleBundle: { fetch: ReturnType<typeof vi.fn> } })
        .moduleBundle.fetch;
      return { res, store, d, bundleFetch, message: (res as { message?: string }).message ?? "" };
    };

    /**
     * A plane whose POOL IS ARMED, which is the only plane on which a shared job can exist.
     *
     * Without this, the endpoints step has neither a key nor a pool and returns runpod_key_required,
     * so a test would exercise the refusal instead of the path it means to drive.
     */
    const pooledDeps = (store: MemoryStore, over: Partial<ProvisionDeps> = {}) =>
      deps(store, { sharedPool: { endpoints: ENDPOINTS, ids: new Set(), names: new Set() }, ...over } as Partial<ProvisionDeps>);

    const resumePooled = async (steps: string[], over: Partial<ProvisionDeps> = {}) => {
      const { store, job, tenant } = await at(steps, "shared");
      const d = pooledDeps(store, over);
      const res = await continueProvisionJob(d, job.id, tenant, steps, fakeClock(0), 15_000);
      const f = d as unknown as {
        cf: { uploadUserWorker: ReturnType<typeof vi.fn> };
        tokenMinter: { mintBucketToken: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> };
        bundle: { fetch: ReturnType<typeof vi.fn> };
      };
      return {
        res, store, d,
        upload: f.cf.uploadUserWorker,
        mint: f.tokenMinter.mintBucketToken,
        revoke: f.tokenMinter.revoke,
        bundleFetch: f.bundle.fetch,
        message: (res as { message?: string }).message ?? "",
      };
    };

    /**
     * The refusal each mode must produce in the PRE-UPLOAD region.
     *
     * ASSERTING THE MESSAGE IS THE POINT, and `ok: false` is not enough. Measured while building
     * this: with the shared refusal deleted, a resume at E0..E4 still fails -- one guard further
     * down, on the endpoints it does not have -- so every `ok: false` assertion stayed GREEN while
     * the boundary was wide open. A check that cannot tell an intact boundary from a relaxed one is
     * decorative, and that is precisely the defect this whole change exists to prevent.
     */
    const PRE_UPLOAD_REFUSAL: Record<string, RegExp> = {
      shared: /shared pool and needs no key of its own/,
      dedicated: /the RunPod key needed to finish it is never stored/,
    };

    // THE DEDICATED INVARIANT, and it is now the PERMANENT one. Every pre-upload state refuses for a
    // tenant that brought its own RunPod account, because key A lives in the request that carried it
    // and no continuation can hold it.
    //
    // THE SHARED HALF OF THIS LOOP MOVED, it was not dropped: cp#301 item 3 makes those states the
    // supported path, and they are asserted in the item 3 block below with assertions that check the
    // credential was re-minted and rebound. `ok: true` would be exactly as blind there as `ok: false`
    // was here.
    for (const id of ["E0", "E1", "E2", "E3", "E4", "E5"]) {
      it(`${id} (dedicated) is REFUSED IN THE PRE-UPLOAD REGION, permanently`, async () => {
        const { res, message, bundleFetch } = await resume(E[id], "dedicated");
        expect(res).toMatchObject({ ok: false });
        // WHICH refusal, not merely that one happened. Measured while building item 2: with the
        // boundary deleted, every `ok: false` assertion here stayed green because a relaxed boundary
        // still fails one guard further down.
        expect(message).toMatch(PRE_UPLOAD_REFUSAL.dedicated);
        // And nothing downstream ran: no release was fetched, so no bytes could have shipped.
        expect(bundleFetch).not.toHaveBeenCalled();
      });
    }

    // ...and the first admissible state still completes, so the invariant is two-sided rather than
    // "everything refuses", which any broken preamble would also satisfy.
    it("E6 (through wfp_upload) still RESUMES TO COMPLETION -- the control", async () => {
      const { res, store } = await resume(E.E6, "shared");
      expect(res).toMatchObject({ ok: true, status: "awaiting_invoke_key" });
      expect(store.jobs.get("job_1")!.status).toBe("succeeded");
    });

    // EACH REFUSAL NAMES ITS OWN CAUSE. Before this change all four states below produced ONE
    // message, which named a RunPod key regardless of whether the tenant ever had one.
    it("E4 dedicated: the key-A message, VERBATIM and unchanged", async () => {
      const { message } = await resume(E.E4, "dedicated");
      expect(message).toBe(
        "provisioning was interrupted before the studio was uploaded, and the RunPod key needed to " +
          "finish it is never stored; start provisioning again to continue",
      );
    });

    it("E4 shared is no longer refused at all (cp#301 item 3 made it the supported path)", async () => {
      // The refusal this replaced named a RunPod key that a pooled tenant never had. Kept as a case
      // rather than deleted, so the contract move is visible in the suite rather than only in git.
      const { res, message } = await resumePooled(E.E4);
      expect(res).toMatchObject({ ok: true });
      expect(message).not.toMatch(/the RunPod key needed to finish it/);
    });

    it("E4 with NO recorded mode (pre-0022 row): its own refusal, not a guess", async () => {
      const { message } = await resume(E.E4, null);
      expect(message).toMatch(/before the plane recorded which RunPod shape/);
      // NOT narrowed to dedicated. readRunPodMode would have done exactly that, which is why the
      // preamble deliberately does not use it.
      expect(message).not.toMatch(/the RunPod key needed to finish it/);
    });

    it("E4 with an UNRECOGNISED mode refuses on its own branch, never falling through to shared", async () => {
      const { message } = await resume(E.E4, "elastic");
      expect(message).toMatch(/unrecognised RunPod shape/);
      expect(message).toMatch(/"elastic"/);
      expect(message).not.toMatch(/not supported yet/);
    });

    // ---- THE INTEGRITY CHECKS ------------------------------------------------------------------

    it("a HOLED progress record refuses rather than inferring a step from its length", async () => {
      // SYNTHETIC, and it cannot be otherwise: mark() only appends, so no code path produces a hole.
      // It stands in for a hand-edited or partially-written row. The reason it must refuse is that
      // inferStep maps done.length to a step BY INDEX, so a hole yields a plausible WRONG step name
      // instead of an error, and every complete() below it silently means "in the set".
      const { store, job, tenant } = await at(E.E4, "shared");
      const holed = ["d1_create", "r2_bucket", "r2_token"];
      const res = await continueProvisionJob(deps(store), job.id, tenant, holed, fakeClock(0), 15_000);
      expect(res).toMatchObject({ ok: false });
      expect((res as { message: string }).message).toMatch(/job progress is not contiguous/);
    });

    // GUARD 5, promoted from a struct field whose refusal lived one module away. Both directions,
    // and they are NOT the same kind of state, which is stated on each.
    // GUARD 5, SPLIT IN ITEM 3. The two directions are different kinds of state and only one is
    // corruption, so they are two named refusals and item 3 relaxes exactly one.
    it("progress claims d1_create but the row has NO database id: refuses, permanently", async () => {
      // NOT PRODUCIBLE. setTenantD1 runs immediately BEFORE mark("d1_create"), so no code path marks
      // that step without the id. This stands in for a corrupted or hand-edited row.
      const { store, job } = await at(E.E4, "shared");
      const rowWithoutD1 = { ...(await store.getTenantById("ten_1"))!, d1_database_id: null };
      const res = await continueProvisionJob(deps(store), job.id, rowWithoutD1, E.E4, fakeClock(0), 15_000);
      expect(res).toMatchObject({ ok: false });
      expect((res as { message: string }).message).toMatch(/no database id, so this row is inconsistent/);
    });

    it("the row has a database id but progress does not claim the step: ADOPTS it, does not refuse", async () => {
      // PRODUCIBLE: a driver that died between setTenantD1 and mark leaves exactly this, and
      // createD1 is adopt-on-exists so re-running the step lands on the same database. Refusing it
      // would strand a tenant that is fine. Ruled on the issue and split out of the case above.
      const { store, job, tenant } = await at(E.E1, "shared");
      const d = pooledDeps(store);
      const res = await continueProvisionJob(d, job.id, tenant, E.E0, fakeClock(0), 15_000);
      expect(res, "a recoverable disagreement must not be refused").toMatchObject({ ok: true });
    });

    it("a job row that no longer exists refuses by name rather than throwing on a null", async () => {
      const { store, tenant } = await at(E.E4, "shared");
      const res = await continueProvisionJob(deps(store), "job_gone", tenant, E.E4, fakeClock(0), 15_000);
      expect(res).toMatchObject({ ok: false });
      expect((res as { message: string }).message).toMatch(/no longer exists/);
    });

    // ---- PAST THE BOUNDARY: absence is CORRUPTION, and now says so ------------------------------

    it("E6 with unreadable endpoints_json blames the data, not an unfinished step", async () => {
      const { store, job, tenant } = await at(E.E6, "shared");
      const res = await continueProvisionJob(
        deps(store), job.id, { ...tenant, endpoints_json: "not json" }, E.E6, fakeClock(0), 15_000,
      );
      expect(res).toMatchObject({ ok: false });
      expect((res as { message: string }).message).toMatch(/cannot be read, although the provision got past/);
    });

    it("E6 with no studio token blames the write that did not land", async () => {
      const { store, job, tenant } = await at(E.E6, "shared");
      const res = await continueProvisionJob(
        deps(store), job.id, { ...tenant, studio_token_enc: null }, E.E6, fakeClock(0), 15_000,
      );
      expect(res).toMatchObject({ ok: false });
      expect((res as { message: string }).message).toMatch(/although the provision got past the step that/);
    });
  });

  // ---- cp#301 item 3: the pooled pre-upload resume ---------------------------------------------
  //
  // These are the states item 2 refused and this change ADMITS. `ok: true` is not the assertion --
  // it is exactly as blind here as `ok: false` was for the boundary in item 2, because a resume that
  // completes with a DEAD R2 binding also returns success. What each case asserts is that the
  // credential was RE-MINTED and that the worker was REBOUND with it.

  describe("pooled pre-upload resume (cp#301 item 3)", () => {
    const E: Record<string, string[]> = {
      E0: [],
      E1: ["d1_create"],
      E2: ["d1_create", "d1_migrate"],
      E3: ["d1_create", "d1_migrate", "r2_bucket"],
      E4: ["d1_create", "d1_migrate", "r2_bucket", "r2_token"],
      E5: ["d1_create", "d1_migrate", "r2_bucket", "r2_token", "runpod_endpoints"],
    };

    async function at(steps: string[], mode: string | null = "shared", toRelease = "v1.0.0") {
      const store = new MemoryStore();
      await store.createAccount("acct_1", "a@b.com");
      const t = await store.createTenant("ten_1", "hero", "acct_1", "provisioning");
      if (steps.includes("d1_create")) await store.setTenantD1(t.id, "d1-uuid-hero");
      if (steps.includes("r2_bucket")) await store.setTenantBucket(t.id, "vivijure-tenant-hero");
      if (steps.includes("r2_token")) await store.setTenantR2Token(t.id, "tok-OLD");
      if (steps.includes("runpod_endpoints")) await store.setTenantEndpoints(t.id, JSON.stringify(ENDPOINTS));
      const job = await store.createProvisionJob("job_1", t.id, "provision", {
        runpodMode: mode as never,
        toRelease,
      });
      return { store, job, tenant: (await store.getTenantById(t.id))! };
    }

    const pooled = (store: MemoryStore, over: Partial<ProvisionDeps> = {}) =>
      deps(store, { sharedPool: { endpoints: ENDPOINTS, ids: new Set(), names: new Set() }, ...over } as Partial<ProvisionDeps>);

    const drive = async (steps: string[], over: Partial<ProvisionDeps> = {}, toRelease = "v1.0.0") => {
      const { store, job, tenant } = await at(steps, "shared", toRelease);
      const d = pooled(store, over);
      const res = await continueProvisionJob(d, job.id, tenant, steps, fakeClock(0), 15_000);
      const f = d as unknown as {
        cf: { uploadUserWorker: ReturnType<typeof vi.fn> };
        tokenMinter: { mintBucketToken: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> };
        bundle: { fetch: ReturnType<typeof vi.fn> };
      };
      return {
        res, store,
        upload: f.cf.uploadUserWorker, mint: f.tokenMinter.mintBucketToken,
        revoke: f.tokenMinter.revoke, bundleFetch: f.bundle.fetch,
        message: (res as { message?: string }).message ?? "",
      };
    };

    /**
     * The STUDIO upload, located by script name rather than by position.
     *
     * uploadUserWorker is called for the studio AND once per module, so `.at(-1)` is a MODULE upload
     * whose bindings carry no R2 secret at all -- it returns undefined, which reads as "the secret
     * was not bound" when the truth is "you read the wrong call". Cost me two failing assertions
     * before I looked at what I was indexing.
     */
    const studioUpload = (upload: ReturnType<typeof vi.fn>) => {
      const i = upload.mock.calls.findIndex(
        (c) => (c[0] as { scriptName?: string } | undefined)?.scriptName === "tenant-hero-studio",
      );
      if (i < 0) return null;
      const args = upload.mock.calls[i][0] as { bindings: { name: string; text?: string }[] };
      return {
        secret: args.bindings.find((b) => b.name === "R2_S3_SECRET_ACCESS_KEY")?.text,
        order: upload.mock.invocationCallOrder[i] as number,
      };
    };

    // EVERY ADMITTED STATE, and the assertion is the CREDENTIAL, not the status. A resume that
    // completed while binding a stale or empty secret returns ok:true and produces a studio that
    // cannot read its own bucket, which is the outcome this whole issue exists to prevent.
    for (const id of ["E0", "E1", "E2", "E3", "E4", "E5"]) {
      it(`${id} (shared) RESUMES, re-mints the bucket credential, and REBINDS the worker with it`, async () => {
        const { res, mint, upload } = await drive(E[id]);
        expect(res).toMatchObject({ ok: true, status: "awaiting_invoke_key" });
        // The value is never stored, so a resume that did not re-mint has nothing to bind.
        expect(mint, "the bucket credential must be re-minted on every resume").toHaveBeenCalled();
        // sha256("SECRET"), the fake minter's value. The worker must carry THIS, not an empty
        // binding and not a stale one.
        expect(upload).toHaveBeenCalled();
        expect(studioUpload(upload)?.secret, "the worker must be rebound with the newly minted secret")
          .toBe(await expectedS3Secret("SECRET"));
      });
    }

    // THE E5 ORDERING CASE, and it is the reason the mint/revoke order was inverted. At E5 a Worker
    // may already exist bound to the OLD secret, and the row cannot say so.
    it("E5: revokes the OLD grant only AFTER the worker has been rebound (mint -> rebind -> revoke)", async () => {
      const { res, upload, revoke } = await drive(E.E5);
      expect(res).toMatchObject({ ok: true });
      expect(revoke, "the old grant must be revoked").toHaveBeenCalledWith("tok-OLD");
      const uploadedAt = studioUpload(upload)!.order;
      // THE FIRST revoke of the OLD token, not the last. Measured: an earlier draft read
      // `.at(-1)`, and a mutation that ADDED a revoke before the mint while leaving the deferred one
      // in place produced ZERO failures -- the last revoke was still correctly ordered, so the
      // assertion could not see the early one at all. The hazard is that the old grant dies before
      // the rebind, so EVERY revoke of it must be after, which means indexing the first.
      const firstOldRevoke = revoke.mock.calls.findIndex((c) => c[0] === "tok-OLD");
      const revokedAt = revoke.mock.invocationCallOrder[firstOldRevoke] as number;
      // ORDER, not merely both-happened. Revoking first is what leaves a live Worker holding a dead
      // credential: silent, deferred, and invisible to every check we run.
      expect(revokedAt, "revoke must come after the rebind, never before").toBeGreaterThan(uploadedAt);
    });

    // A resume must build the release the JOB recorded, not the plane pin at poll time.
    it("builds from the JOB release, not deps.release", async () => {
      const { res, bundleFetch } = await drive(E.E4, { release: "v9.9.9" } as Partial<ProvisionDeps>, "v1.13.0");
      expect(res).toMatchObject({ ok: true });
      expect(bundleFetch).toHaveBeenCalledWith("v1.13.0");
      expect(bundleFetch).not.toHaveBeenCalledWith("v9.9.9");
    });

    it("REFUSES when the job recorded no release, rather than falling back to the plane pin", async () => {
      const { store, job, tenant } = await at(E.E4, "shared", "");
      store.jobs.get(job.id)!.to_release = null;
      const d = pooled(store);
      const res = await continueProvisionJob(d, job.id, tenant, E.E4, fakeClock(0), 15_000);
      expect(res).toMatchObject({ ok: false });
      expect((res as { message: string }).message).toMatch(/did not record which release/);
      expect((d as unknown as { bundle: { fetch: ReturnType<typeof vi.fn> } }).bundle.fetch)
        .not.toHaveBeenCalled();
    });

    // The pool can be withdrawn between the provision and the resume. Admitting the state must not
    // mean assuming the tier is still there.
    it("REFUSES when the plane no longer offers the pool the job was created for", async () => {
      const { store, job, tenant } = await at(E.E2, "shared");
      const res = await continueProvisionJob(deps(store), job.id, tenant, E.E2, fakeClock(0), 15_000);
      expect(res).toMatchObject({ ok: false, step: "runpod_endpoints" });
      expect((res as { message: string }).message).toBe("runpod_key_required");
    });
  });

  it("REFUSES honestly when the job never reached the studio upload (key A is unrecoverable)", async () => {
    // A continuation cannot mint endpoints: key A lives only in the request that carried it. Saying
    // so beats waiting forever for a driver that can never succeed.
    const store = new MemoryStore();
    const t0 = await seedTenant(store);
    // THE D1 ID IS PART OF THE FIXTURE, not decoration (cp#301 item 2). This case claims progress
    // through d1_create, and runProvisionJob calls setTenantD1 IMMEDIATELY BEFORE mark("d1_create"),
    // so a row whose progress says that step completed always carries the id. Without this the
    // fixture asserts the key-A refusal from a state production cannot produce, and the integrity
    // check added by item 2 refuses it first -- correctly, which is how this was found.
    await store.setTenantD1(t0.id, "d1-uuid-hero");
    const t = (await store.getTenantById(t0.id))!;
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
    const stepsDone = ["d1_create", "d1_migrate"];

    const res = await continueProvisionJob(deps(store), job.id, t, stepsDone, fakeClock(0), 15_000);

    expect(res).toMatchObject({ ok: false });
    expect((res as { message: string }).message).toMatch(/start provisioning again/);
    expect(store.jobs.get("job_1")!.status).toBe("failed");
  });

  it("yields again if one continuation is still not enough", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store, { throughStudio: true });
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
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
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
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
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);

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

describe("cp#248e: provision RECORDS the module release", () => {
  // WHY THIS EXISTS. setTenantModulesRelease was called only by the module-UPGRADE path, so a
  // tenant that had never been upgraded carried modules_release = NULL forever while its resident
  // module scripts were plainly at deps.release. Found on a real provisioned tenant
  // (hosted-phase1, 2026-08-01): studio_release v1.13.0, modules_release NULL, and its modules
  // demonstrably at v1.13.0 because all five recording ones answered telemetry.job_log = true.
  //
  // It is not cosmetic. smoke-render.ts opens every smoke with tenant.modules_release under the
  // stated invariant "the pixels came from the module bytes recorded in modules_release", so on a
  // freshly provisioned tenant a smoke could not name the bytes that produced its pixels.
  //
  // BOTH completion paths are asserted, because they are different functions: a provision that
  // fits in one invocation finishes in runProvisionJob, and one that yields finishes in
  // continueProvisionJob. A fix in only one populates the column exactly for the tenants whose
  // provision happened to be fast, which reads correct until the slow case appears.

  it("the single-invocation path records deps.release", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);

    // PRECONDITION, asserted rather than assumed: it starts NULL, so a pass cannot come from a
    // fixture that was already carrying the value.
    expect(store.tenants.get(t.id)!.modules_release).toBeNull();

    const res = await runProvisionJob(deps(store), job.id, t, "rpa_keyA", fakeClock(0), 15_000);

    expect(res).toEqual({ ok: true, status: "awaiting_invoke_key" });
    expect(store.tenants.get(t.id)!.modules_release).toBe("v1.0.0");
  });

  it("the RESUMED path records it too", async () => {
    const store = new MemoryStore();
    const t = await seedTenant(store, { throughStudio: true });
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
    const stepsDone = ["d1_create", "d1_migrate", "r2_bucket", "r2_token", "runpod_endpoints", "wfp_upload"];
    await store.updateJobProgress(job.id, "wfp_upload", JSON.stringify(stepsDone));

    expect(store.tenants.get(t.id)!.modules_release).toBeNull();

    const res = await continueProvisionJob(deps(store), job.id, t, stepsDone, fakeClock(0), 15_000);

    expect(res).toEqual({ ok: true, status: "awaiting_invoke_key" });
    expect(store.tenants.get(t.id)!.modules_release).toBe("v1.0.0");
  });

  it("a provision that YIELDS before modules_install claims NO release", async () => {
    // The negative that gives the two positives their meaning. A release recorded for modules that
    // were never installed would be a worse lie than NULL: it asserts uniformity nothing achieved.
    const store = new MemoryStore();
    const t = await seedTenant(store);
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);

    // A clock that burns the whole budget on every reading forces a yield at the first boundary.
    const res = await runProvisionJob(deps(store), job.id, t, "rpa_keyA", fakeClock(60_000), 15_000);

    expect(res).toMatchObject({ ok: false, yielded: true });
    expect(store.tenants.get(t.id)!.modules_release).toBeNull();
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
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
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
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
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
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
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
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
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
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
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
    const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
    let reads = 0;
    const counting = { now: () => (reads++, 0) };

    await runProvisionJob(deps(store), job.id, t, "rpa_keyA", counting, 10_000_000);

    const marks = JSON.parse(store.jobs.get("job_1")!.steps_done).length;
    // 1 read for startedAt + exactly 1 per mark. If instrumentation ever adds its own read, this
    // fails and the yield-timing tests above become untrustworthy.
    expect(reads).toBe(marks + 1);
  });
});

describe("cp#148: the lease means A DRIVER IS ALIVE, not A STEP BOUNDARY HAPPENED RECENTLY", () => {
  /**
   * THE REGRESSION, as the cp#117 rehearsal met it live.
   *
   * runpod_endpoints is ONE uninterrupted await with no mark inside it, so it renewed nothing while
   * it ran. On the slow scratch account it ran ~87s, the 60s lease lapsed at ~68s under a perfectly
   * healthy driver, and the cp#124 first poll at 90s found a free claim. It won it, ran
   * continueProvisionJob, which refuses anything short of wfp_upload, and that refusal wrote
   * finishJob(failed) + setTenantStatus(failed) + a destructive rollback. The driver never "ended at
   * runpod_endpoints"; the job was taken away from it while it was still working.
   *
   * The test drives the SAME shape: hold createEndpoints open, advance 90 seconds, and require the
   * poll to lose. It fails on the pre-cp#148 provisioner, where claimJob returns true here.
   */
  it("a poll CANNOT claim the job while the driver is still inside a long runpod_endpoints step", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore();
      const tenant = await seedTenant(store);
      const job = await store.createProvisionJob("job_1", "ten_1", "provision", TEST_PROVISION_FACTS);

      // TWO promises, not a spin loop. The test has to wait for the driver to be INSIDE the RunPod
      // step, and polling for it (drain microtasks, check the spy) is both flaky and self-defeating:
      // r2_token awaits crypto.subtle.digest, which settles on the event loop, so a tight loop
      // starves the very thing it is waiting for. CI proved it, on a slower runner than this box.
      // The step announces its own entry instead, and the test parks on that.
      let entered!: () => void;
      const inRunPod = new Promise<void>((r) => {
        entered = r;
      });
      let release!: () => void;
      const slowRunPod = new Promise<void>((r) => {
        release = r;
      });
      const createEndpoints = vi.fn(async () => {
        entered();
        await slowRunPod;
        return ENDPOINTS;
      });
      const d = deps(store, { runpod: { createEndpoints, convergeTemplateImages: vi.fn(async () => []) } });

      // THE POSITIVE CONTROL, and it is the point of the whole test: a second job, driven by nobody,
      // takes the same 60s lease at the same instant. If 90 seconds of this harness clock did not
      // really expire an un-heartbeated lease, the assertion below would pass for the wrong reason.
      const idle = await store.createProvisionJob("job_control", "ten_1", "provision", TEST_PROVISION_FACTS);
      await store.setJobRunning(idle.id);

      const run = runProvisionJob(d, job.id, tenant, "key-A", fakeClock(1));

      // The CF prefix (d1 .. r2_token) runs on its own; park until the driver is inside RunPod.
      await inRunPod;
      expect(createEndpoints).toHaveBeenCalledTimes(1);

      // 90s: the cp#124 first poll, a full 30s past the lease the last mark left behind.
      await vi.advanceTimersByTimeAsync(90_000);

      const mid = (await store.getJob(job.id)) as ProvisionJob;
      expect(mid.status).toBe("running");
      expect(jobHasLiveDriver(mid, Date.now())).toBe(true);
      expect(await store.claimJob(job.id, 60)).toBe(false);

      // The control: same clock, same 60s lease, no driver. This one IS claimable, so the false
      // above is the heartbeat and nothing else.
      expect(jobHasLiveDriver((await store.getJob(idle.id)) as ProvisionJob, Date.now())).toBe(false);
      expect(await store.claimJob(idle.id, 60)).toBe(true);

      release();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("the provision CARRIES THROUGH runpod_endpoints to wfp_upload despite the slow step", async () => {
    // The outcome the issue asks for: the boundary is reachable regardless of prefix duration,
    // rather than the prefix being made faster and hoped about.
    vi.useFakeTimers();
    try {
      const store = new MemoryStore();
      const tenant = await seedTenant(store);
      const job = await store.createProvisionJob("job_1", "ten_1", "provision", TEST_PROVISION_FACTS);

      // TWO promises, not a spin loop. The test has to wait for the driver to be INSIDE the RunPod
      // step, and polling for it (drain microtasks, check the spy) is both flaky and self-defeating:
      // r2_token awaits crypto.subtle.digest, which settles on the event loop, so a tight loop
      // starves the very thing it is waiting for. CI proved it, on a slower runner than this box.
      // The step announces its own entry instead, and the test parks on that.
      let entered!: () => void;
      const inRunPod = new Promise<void>((r) => {
        entered = r;
      });
      let release!: () => void;
      const slowRunPod = new Promise<void>((r) => {
        release = r;
      });
      const createEndpoints = vi.fn(async () => {
        entered();
        await slowRunPod;
        return ENDPOINTS;
      });
      const d = deps(store, { runpod: { createEndpoints, convergeTemplateImages: vi.fn(async () => []) } });

      const run = runProvisionJob(d, job.id, tenant, "key-A", fakeClock(1));
      await inRunPod;
      expect(createEndpoints).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(110_000);
      release();
      const outcome = await run;

      expect(outcome).toEqual({ ok: true, status: "awaiting_invoke_key" });
      const finished = (await store.getJob(job.id)) as ProvisionJob;
      expect(finished.status).toBe("succeeded");
      expect(JSON.parse(finished.steps_done) as string[]).toContain("wfp_upload");
      // A finished job releases its lease, so the next caller is not locked out by a dead heartbeat.
      expect(finished.lease_until).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a heartbeat CANNOT resurrect a job somebody else already finished", async () => {
    const store = new MemoryStore();
    await seedTenant(store);
    const job = await store.createProvisionJob("job_1", "ten_1", "provision", TEST_PROVISION_FACTS);

    // Control first: while the job is live, the renew really does work. Without this the refusal
    // below would pass against a renewJobLease that never renews anything.
    await store.setJobRunning(job.id);
    expect(await store.renewJobLease(job.id, 60)).toBe(true);

    await store.finishJob(job.id, "failed", "runpod_endpoints", "keyless refusal");
    expect(await store.renewJobLease(job.id, 60)).toBe(false);
    expect((await store.getJob(job.id))?.lease_until).toBeNull();
  });

  it("a LATE mark from a driver that lost its job does not overwrite the terminal record", async () => {
    const store = new MemoryStore();
    await seedTenant(store);
    const job = await store.createProvisionJob("job_1", "ten_1", "provision", TEST_PROVISION_FACTS);
    await store.setJobRunning(job.id);
    await store.updateJobProgress(job.id, "r2_token", JSON.stringify(["d1_create", "r2_token"]));
    await store.finishJob(job.id, "failed", "runpod_endpoints", "keyless refusal");

    // The losing driver runs on to the end of its invocation and marks the next step.
    await store.updateJobProgress(job.id, "wfp_upload", JSON.stringify(["d1_create", "r2_token", "wfp_upload"]));

    const after = (await store.getJob(job.id)) as ProvisionJob;
    expect(after.status).toBe("failed");
    expect(after.step).toBe("r2_token");
    expect(JSON.parse(after.steps_done) as string[]).not.toContain("wfp_upload");
    expect(after.lease_until).toBeNull();
  });

  /**
   * THE STRETCH THE LIVE FIXTURE ACTUALLY DIED IN (prod D1, cp#117 rehearsal job
   * job_1cc93d7e8d7cf62a78d79441): steps_done runs THROUGH runpod_endpoints and error_step is
   * wfp_upload, which is inferStep over those five steps. So the driver survived the ~87s RunPod
   * call and recorded it, and the poll that killed the job arrived during the STUDIO UPLOAD after
   * it, with the lease lapsed a second time.
   *
   * The fatal window was therefore the SECOND long stretch, not the first, which is the whole
   * argument for a general heartbeat over anything keyed to runpod_endpoints. This test drives that
   * exact shape, and it is why the fix is not step-specific.
   */
  it("a poll CANNOT claim the job while the driver is still uploading the studio (the live fixture)", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore();
      const tenant = await seedTenant(store);
      const job = await store.createProvisionJob("job_1", "ten_1", "provision", TEST_PROVISION_FACTS);

      let entered!: () => void;
      const inUpload = new Promise<void>((r) => {
        entered = r;
      });
      let release!: () => void;
      const slowUpload = new Promise<void>((r) => {
        release = r;
      });
      const uploadUserWorker = vi.fn(async () => {
        entered();
        await slowUpload;
      });
      // cf and scriptUploadCf are the same object in the shipping default (the no-upload-credential
      // fallback), so both are overridden with the one slow client.
      const cf = fakeCf({ uploadUserWorker });
      const d = deps(store, { cf, scriptUploadCf: cf });

      const run = runProvisionJob(d, job.id, tenant, "key-A", fakeClock(1));
      await inUpload;

      // The prod row, reproduced: five steps recorded, the sixth in flight.
      const midJob = (await store.getJob(job.id)) as ProvisionJob;
      expect(JSON.parse(midJob.steps_done) as string[]).toEqual([
        "d1_create",
        "d1_migrate",
        "r2_bucket",
        "r2_token",
        "runpod_endpoints",
      ]);

      await vi.advanceTimersByTimeAsync(90_000);

      const mid = (await store.getJob(job.id)) as ProvisionJob;
      expect(mid.status).toBe("running");
      expect(jobHasLiveDriver(mid, Date.now())).toBe(true);
      expect(await store.claimJob(job.id, 60)).toBe(false);

      release();
      expect(await run).toEqual({ ok: true, status: "awaiting_invoke_key" });
    } finally {
      vi.useRealTimers();
    }
  });
});
