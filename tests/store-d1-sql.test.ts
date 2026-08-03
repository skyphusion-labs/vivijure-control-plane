// The un-stubbable seam for store-d1.ts (cf#103 follow-up).
//
// WHY THIS FILE EXISTS: every other test in this suite builds MemoryStore, a hand-written fake.
// That proves the DECISION paths and cannot, even in principle, catch a malformed SQL string,
// because no test ever hands the SQL to a SQL engine. v1.2.0 shipped
// VALUES (?1, ?2, module_upgrade, queued, ?3, ?4) -- unquoted literals, which SQLite parses as
// COLUMN REFERENCES -- and 468 green tests plus a live deploy did not catch it. The route returned
// 500 on every valid release in production.
//
// So this drives the REAL D1Store against a REAL SQLite built from the REAL migrations. It is not
// a copy of the statements (a copy drifts and re-encodes the same assumption); it instantiates the
// shipped class and calls the shipped methods. Any bare identifier, mistyped column, or constraint
// violation in ANY store method is now a failing test rather than a production 500.
//
// node:sqlite is built into Node -- no new runtime or dev dependency. It needs
// --experimental-sqlite on Node 22 (what CI pins); the flag is an accepted no-op on Node 24, so
// vitest.config.ts passes it unconditionally.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { D1Store } from "../src/store-d1";
// The shim + migrated-db helpers live in sqlite-d1.ts so the #38 reclaim SEQUENCE rehearsal drives
// the SAME store harness these store-half proofs do.
import { d1Over, freshMigratedDb as freshDb } from "./sqlite-d1";
import { TEST_PROVISION_FACTS } from "./memory-store";

describe("store-d1 statements execute against real SQLite", () => {
  let db: DatabaseSync;
  let store: D1Store;

  beforeEach(async () => {
    db = freshDb();
    store = new D1Store(d1Over(db));
    await store.createAccount("acct_1", "a@b.com");
    await store.createTenant("ten_1", "rehearsal", "acct_1", "live");
  });

  // THE REGRESSION. This is the exact call that returned 500 in production.
  it("createModuleUpgradeJob inserts a real row with literal kind and status", async () => {
    const job = await store.createModuleUpgradeJob("job_1", "ten_1", null, "v1.6.0");

    expect(job.kind).toBe("module_upgrade");
    expect(job.status).toBe("queued");
    expect(job.to_release).toBe("v1.6.0");
    // from_release NULL is load-bearing: it is what makes a failed upgrade rollback-able when
    // modules_release has already been cleared.
    expect(job.from_release).toBeNull();

    // Read it back through SQL rather than trusting the RETURNING row, so a driver that fabricated
    // the row without committing would still fail.
    const back = db.prepare("SELECT kind, status FROM provision_jobs WHERE id = ?1").get("job_1") as {
      kind: string;
      status: string;
    };
    expect(back).toEqual({ kind: "module_upgrade", status: "queued" });
  });

  it("createModuleUpgradeJob records both ends of the move", async () => {
    const job = await store.createModuleUpgradeJob("job_2", "ten_1", "v1.5.0", "v1.6.0");
    expect(job.from_release).toBe("v1.5.0");
    expect(job.to_release).toBe("v1.6.0");
  });

  // The CONTROL. This statement was always correct; if it ever fails, the harness is broken rather
  // than the code, and a green regression above would be meaningless.
  it("createProvisionJob still inserts (control)", async () => {
    const job = await store.createProvisionJob("job_3", "ten_1", "provision", TEST_PROVISION_FACTS);
    expect(job.kind).toBe("provision");
    expect(job.status).toBe("queued");
  });

  // cp#301: the provision facts must survive the round trip through REAL SQLite, not just through
  // the memory store. The memory store is a hand-written mirror, so a column that exists in the
  // migration and is missing from the INSERT would pass every suite that never touches SQLite.
  it("createProvisionJob persists runpod_mode and to_release (cp#301)", async () => {
    const job = await store.createProvisionJob("job_facts", "ten_1", "provision", {
      runpodMode: "shared",
      toRelease: "v1.19.3",
    });
    expect(job.runpod_mode).toBe("shared");
    expect(job.to_release).toBe("v1.19.3");

    // Read it back through SQL rather than trusting the RETURNING row, for the reason the module
    // upgrade case above already gives: RETURNING can describe a row the statement did not commit.
    const back = db
      .prepare("SELECT runpod_mode, to_release FROM provision_jobs WHERE id = ?1")
      .get("job_facts") as { runpod_mode: string | null; to_release: string | null };
    expect(back).toEqual({ runpod_mode: "shared", to_release: "v1.19.3" });
  });

  // The NULL that the column exists to preserve. A job row written before migration 0022 carries no
  // mode, and a consumer must be able to tell that from a recorded 'dedicated'. Constructed by
  // writing the pre-0022 shape directly, which is the one state the current code CANNOT produce and
  // is therefore labelled synthetic rather than pretending otherwise: it stands in for every job row
  // that existed on the plane before this migration applied.
  it("a pre-0022 job row reads runpod_mode NULL, distinguishable from 'dedicated' (cp#301)", async () => {
    db.prepare(
      "INSERT INTO provision_jobs (id, tenant_id, kind, status) VALUES ('job_old', 'ten_1', 'provision', 'queued')",
    ).run();
    const old = await store.getJob("job_old");
    expect(old?.runpod_mode ?? null).toBeNull();

    const fresh = await store.createProvisionJob("job_new", "ten_1", "provision", {
      runpodMode: "dedicated",
      toRelease: "v1.0.0",
    });
    expect(fresh.runpod_mode).toBe("dedicated");
    // The distinction is the whole design of the column: absent is not dedicated.
    expect(old?.runpod_mode).not.toBe(fresh.runpod_mode);
  });

  it("the tenant row the jobs hang off is really there (control)", async () => {
    const t = await store.getTenantBySlug("rehearsal");
    expect(t?.id).toBe("ten_1");
  });

  // ---- the operator smoke-render spend guard (cp#45) --------------------------------------------
  //
  // THIS IS WHERE THE GUARD IS ACTUALLY TESTED. openSmokeRender is one conditional INSERT whose
  // whole job is to refuse; a MemoryStore mirroring it proves only that I wrote the same rule twice.
  // These drive the shipped statements against a real SQL engine, which is the only thing that can
  // catch a predicate that parses but does not mean what it reads like.

  const BOUNDS = { cooldownSeconds: 1800, dailyCap: 20, inFlightSeconds: 1200 };
  /** Backdate a row so the time-based predicates are reachable without waiting. */
  const backdate = (id: string, seconds: number) =>
    db.prepare("UPDATE smoke_renders SET created_at = datetime('now', '-' || ?2 || ' seconds') WHERE id = ?1").run(id, seconds);

  it("openSmokeRender inserts a real row (the INSERT ... SELECT ... WHERE ... RETURNING parses)", async () => {
    const row = await store.openSmokeRender("smk_1", "ten_1", "v1.5.0", BOUNDS);
    expect(row).toMatchObject({ id: "smk_1", tenant_id: "ten_1", status: "running", modules_release: "v1.5.0" });

    // Read back through SQL, not through RETURNING: a statement that fabricated a row without
    // committing would still fail here.
    const back = db.prepare("SELECT status, artifact_sha256 FROM smoke_renders WHERE id = ?1").get("smk_1");
    expect(back).toEqual({ status: "running", artifact_sha256: null });
  });

  it("REFUSES a second open while one is in flight, and writes nothing", async () => {
    // COOLDOWN ZEROED DELIBERATELY. With the default cooldown this test passed even when the
    // in-flight predicate was deleted outright -- the cooldown was doing the refusing and the
    // assertion could not tell. A mutation pass caught that: an assertion that cannot fail for the
    // reason it names is not testing the thing in its own title.
    const noCooldown = { ...BOUNDS, cooldownSeconds: 0 };
    await store.openSmokeRender("smk_1", "ten_1", null, noCooldown);
    expect(await store.openSmokeRender("smk_2", "ten_1", null, noCooldown)).toBeNull();
    const n = db.prepare("SELECT COUNT(*) AS n FROM smoke_renders").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("REFUSES inside the cooldown even once the first render is terminal", async () => {
    await store.openSmokeRender("smk_1", "ten_1", null, BOUNDS);
    await store.finishSmokeRender("smk_1", { status: "failed", error: "x" });
    expect(await store.openSmokeRender("smk_2", "ten_1", null, BOUNDS)).toBeNull();
  });

  it("ALLOWS a new render once the cooldown has elapsed (the bound is a delay, not a lockout)", async () => {
    await store.openSmokeRender("smk_1", "ten_1", null, BOUNDS);
    await store.finishSmokeRender("smk_1", { status: "failed", error: "x" });
    backdate("smk_1", BOUNDS.cooldownSeconds + 60);
    expect(await store.openSmokeRender("smk_2", "ten_1", null, BOUNDS)).not.toBeNull();
  });

  it("stops blocking on an in-flight row that outlived the in-flight window", async () => {
    await store.openSmokeRender("smk_1", "ten_1", null, BOUNDS);
    // Still 'running', but old enough that it can no longer wedge the route for this tenant.
    backdate("smk_1", BOUNDS.inFlightSeconds + BOUNDS.cooldownSeconds + 60);
    expect(await store.openSmokeRender("smk_2", "ten_1", null, BOUNDS)).not.toBeNull();
  });

  it("enforces the PLATFORM-WIDE daily cap across different tenants", async () => {
    await store.createTenant("ten_2", "other", "acct_1", "live");
    const open = { cooldownSeconds: 0, dailyCap: 2, inFlightSeconds: 0 };
    expect(await store.openSmokeRender("smk_1", "ten_1", null, open)).not.toBeNull();
    expect(await store.openSmokeRender("smk_2", "ten_2", null, open)).not.toBeNull();
    expect(await store.openSmokeRender("smk_3", "ten_2", null, open)).toBeNull();

    // And a row older than the window stops counting against the cap.
    backdate("smk_1", 86_400 + 60);
    expect(await store.openSmokeRender("smk_4", "ten_2", null, open)).not.toBeNull();
  });

  it("names WHICH bound was hit, and says nothing when none was", async () => {
    expect(await store.describeSmokeRenderRefusal("ten_1", BOUNDS)).toBeNull();

    await store.openSmokeRender("smk_1", "ten_1", null, BOUNDS);
    expect(await store.describeSmokeRenderRefusal("ten_1", BOUNDS)).toContain("already running");

    await store.finishSmokeRender("smk_1", { status: "failed", error: "x" });
    expect(await store.describeSmokeRenderRefusal("ten_1", BOUNDS)).toContain("cooldown");

    backdate("smk_1", BOUNDS.cooldownSeconds + 60);
    expect(await store.describeSmokeRenderRefusal("ten_1", { ...BOUNDS, dailyCap: 1 })).toContain("cap of 1");
  });

  it("records the submitted studio ids", async () => {
    await store.openSmokeRender("smk_1", "ten_1", null, BOUNDS);
    await store.setSmokeRenderSubmitted("smk_1", "film-123", "bundles/smoke.tar.gz");
    expect(await store.getSmokeRender("smk_1")).toMatchObject({
      studio_job_id: "film-123",
      bundle_key: "bundles/smoke.tar.gz",
    });
  });

  it("writes the whole artifact record on success, and finishes write-once", async () => {
    await store.openSmokeRender("smk_1", "ten_1", null, BOUNDS);
    await store.finishSmokeRender("smk_1", {
      status: "succeeded",
      artifact: { key: "clips/smoke1_keyframe.png", bytes: 12, sha256: "abc123", contentType: "image/png" },
    });
    expect(await store.getSmokeRender("smk_1")).toMatchObject({
      status: "succeeded",
      artifact_key: "clips/smoke1_keyframe.png",
      artifact_bytes: 12,
      artifact_sha256: "abc123",
      artifact_content_type: "image/png",
    });

    // A late poll must not overwrite an outcome already recorded: the UPDATE is guarded on running.
    await store.finishSmokeRender("smk_1", { status: "failed", error: "a later poll disagreeing" });
    expect(await store.getSmokeRender("smk_1")).toMatchObject({ status: "succeeded", error_message: null });
  });

  it("records a failure with its reason", async () => {
    await store.openSmokeRender("smk_1", "ten_1", null, BOUNDS);
    await store.finishSmokeRender("smk_1", { status: "failed", error: "CUDA out of memory" });
    expect(await store.getSmokeRender("smk_1")).toMatchObject({
      status: "failed",
      error_message: "CUDA out of memory",
      artifact_sha256: null,
    });
  });

  it("the smoke_renders table is really there and empty to start (control)", async () => {
    const n = db.prepare("SELECT COUNT(*) AS n FROM smoke_renders").get() as { n: number };
    expect(n.n).toBe(0);
  });

  // ---- cp#95: the rotation seam ----------------------------------------------------------------
  //
  // These two statements are the ONLY reason a KEK rotation is not a hand-written script, so they
  // are the ones that must be executed by a real engine rather than mimicked by a fake. The CAS in
  // particular cannot be proven by MemoryStore at all: it turns on `meta.changes` from a 0-row
  // UPDATE, which is a SUCCESSFUL statement doing nothing -- exactly the shape a fake would be
  // written to return true for.

  it("listEncryptedStudioTokens returns every row carrying ciphertext, whatever its status", async () => {
    await store.createTenant("ten_2", "parked", "acct_1", "deleted");
    await store.createTenant("ten_3", "no-token", "acct_1", "live");
    await store.setTenantStudioToken("ten_1", "enc-live");
    await store.setTenantStudioToken("ten_2", "enc-parked");

    const rows = await store.listEncryptedStudioTokens();

    // The parked row is the point. A status filter here would leave real ciphertext behind and let a
    // census answer "safe to promote" over a row still encrypted under the outgoing key.
    expect(rows.map((r) => r.id)).toEqual(["ten_1", "ten_2"]);
    expect(rows.find((r) => r.id === "ten_2")).toMatchObject({ slug: "parked", studio_token_enc: "enc-parked" });
  });

  it("listEncryptedStudioTokens skips rows with no token, and an EMPTY string is no token", async () => {
    await store.setTenantStudioToken("ten_1", "");
    expect(await store.listEncryptedStudioTokens()).toEqual([]);
  });

  it("setTenantStudioTokenIfUnchanged WRITES when the ciphertext still matches", async () => {
    await store.setTenantStudioToken("ten_1", "enc-old");
    expect(await store.setTenantStudioTokenIfUnchanged("ten_1", "enc-old", "enc-new")).toBe(true);
    expect((await store.getTenantById("ten_1"))!.studio_token_enc).toBe("enc-new");
  });

  it("setTenantStudioTokenIfUnchanged REFUSES when the row changed underneath it", async () => {
    await store.setTenantStudioToken("ten_1", "enc-old");
    await store.setTenantStudioToken("ten_1", "enc-reminted-by-a-provision");

    // A 0-row UPDATE raises nothing. Reporting success off the absence of an error would call a race
    // a rotation and silently revert a freshly minted customer token.
    expect(await store.setTenantStudioTokenIfUnchanged("ten_1", "enc-old", "enc-new")).toBe(false);
    expect((await store.getTenantById("ten_1"))!.studio_token_enc).toBe("enc-reminted-by-a-provision");
  });

  it("setTenantStudioTokenIfUnchanged REFUSES for a tenant id that does not exist", async () => {
    expect(await store.setTenantStudioTokenIfUnchanged("ten_missing", "enc-old", "enc-new")).toBe(false);
  });
  // cp#136: the finish-tier declaration, against a REAL engine and the REAL migration ledger. The
  // memory stub cannot prove that migration 0011 applies, that the column defaults to 0, or that the
  // three columns move together in one statement.
  it("setTenantVideoFinishUnreachable writes and clears all three columns together", async () => {
    const fresh = (await store.getTenantById("ten_1"))!;
    // The DEFAULT, which is the honest state for every existing row the migration touched: a tenant
    // nobody has declared anything about is reachable.
    expect(fresh.video_finish_unreachable).toBe(0);
    expect(fresh.video_finish_unreachable_reason).toBeNull();
    expect(fresh.video_finish_unreachable_at).toBeNull();

    await store.setTenantVideoFinishUnreachable("ten_1", {
      reason: "the CF account holding this studio is gone",
      at: "2026-07-26T12:00:00.000Z",
    });
    const marked = (await store.getTenantById("ten_1"))!;
    expect(marked.video_finish_unreachable).toBe(1);
    expect(marked.video_finish_unreachable_reason).toBe("the CF account holding this studio is gone");
    expect(marked.video_finish_unreachable_at).toBe("2026-07-26T12:00:00.000Z");

    await store.setTenantVideoFinishUnreachable("ten_1", null);
    const cleared = (await store.getTenantById("ten_1"))!;
    expect(cleared.video_finish_unreachable).toBe(0);
    // A reason standing under a cleared flag is a label outliving its cause, which is the failure
    // mode this whole issue is about.
    expect(cleared.video_finish_unreachable_reason).toBeNull();
    expect(cleared.video_finish_unreachable_at).toBeNull();
  });
});


/**
 * The driver heartbeat, against real S'L (cp#148).
 *
 * MemoryStore can only prove the DECISION. These prove the STATEMENTS, and both properties that
 * carry the fix are S'L properties: the status predicate that refuses a terminal job, and the column
 * the UPDATE deliberately leaves alone.
 */
describe("runpod_job_index.source is a TOTAL vocabulary: 'proxy' | 'harvest', never NULL (cp#288)", () => {
  let db: DatabaseSync;
  let store: D1Store;

  beforeEach(() => {
    db = freshDb();
    store = new D1Store(d1Over(db));
  });

  const sourcesOf = (): (string | null)[] =>
    db.prepare("SELECT source FROM runpod_job_index ORDER BY job_id").all().map((r: any) => r.source);

  it("the harvester writes 'harvest' explicitly, so the backfill is not undone on the next run", async () => {
    await store.indexRunpodJobs("ten_a", "slug-a", [
      { job_id: "j1", module: "keyframe", outcome: "completed", submitted_at: 1, terminal_at: 2 },
    ]);
    expect(sourcesOf()).toEqual(["harvest"]);
  });

  // THE ONE THAT MATTERS. The migration backfills history; this is what stops the column going
  // three-valued again the moment the harvester runs. Asserted as "no NULL anywhere" rather than
  // "row j1 says harvest", because the property is about the COLUMN, not about one row.
  it("no row is left NULL after a harvest", async () => {
    await store.indexRunpodJobs("ten_a", "slug-a", [
      { job_id: "j1", module: "keyframe", outcome: "submitted", submitted_at: 1, terminal_at: null },
      { job_id: "j2", module: "own-gpu", outcome: "failed", submitted_at: 3, terminal_at: 4 },
    ]);
    expect(sourcesOf()).not.toContain(null);
    expect(sourcesOf()).toHaveLength(2);
  });

  // source is a fact about ORIGIN, so the EXISTING value wins -- the opposite direction from every
  // other column in this upsert, which prefers `excluded` so a fresher value refines an older one.
  // A row the proxy opened at submit must not be relabelled by a later harvest of the same job.
  it("a later harvest does NOT relabel a row the proxy already claimed", async () => {
    db.prepare(
      "INSERT INTO runpod_job_index (job_id, tenant_id, tenant_slug, harvested_at, source) " +
        "VALUES (?, ?, ?, datetime('now'), 'proxy')",
    ).run("j1", "ten_a", "slug-a");
    await store.indexRunpodJobs("ten_a", "slug-a", [
      { job_id: "j1", module: "keyframe", outcome: "completed", submitted_at: 1, terminal_at: 2 },
    ]);
    expect(sourcesOf()).toEqual(["proxy"]);
    // CONTROL: the harvest really did land, so the assertion above is about precedence and not
    // about the write having silently done nothing.
    const row: any = db.prepare("SELECT module, outcome FROM runpod_job_index WHERE job_id = ?").get("j1");
    expect(row.module).toBe("keyframe");
    expect(row.outcome).toBe("completed");
  });

  // The migration's backfill statement, exercised against a row in the state it exists to close.
  it("the backfill closes a legacy NULL row and leaves a proxy row alone", () => {
    db.prepare(
      "INSERT INTO runpod_job_index (job_id, tenant_id, tenant_slug, harvested_at, source) " +
        "VALUES ('legacy', 't', 's', datetime('now'), NULL)",
    ).run();
    db.prepare(
      "INSERT INTO runpod_job_index (job_id, tenant_id, tenant_slug, harvested_at, source) " +
        "VALUES ('pushed', 't', 's', datetime('now'), 'proxy')",
    ).run();
    // CONTROL FIRST: the NULL state is genuinely reachable, so the fix below is not vacuous.
    expect(sourcesOf()).toContain(null);
    db.prepare("UPDATE runpod_job_index SET source = 'harvest' WHERE source IS NULL").run();
    expect(sourcesOf()).toEqual(["harvest", "proxy"]);
  });
});

describe("releaseJobLease, the yield hand-back (cp#158)", () => {
  let db: DatabaseSync;
  let store: D1Store;

  beforeEach(async () => {
    db = freshDb();
    store = new D1Store(d1Over(db));
    await store.createAccount("acct_1", "a@b.com");
    await store.createTenant("ten_1", "rehearsal", "acct_1", "provisioning");
    await store.createProvisionJob("job_1", "ten_1", "provision", TEST_PROVISION_FACTS);
  });

  const row = () =>
    db
      .prepare(
        "SELECT status, lease_until, updated_at, " +
          "CASE WHEN lease_until > datetime('now') THEN 1 ELSE 0 END AS live " +
          "FROM provision_jobs WHERE id = 'job_1'",
      )
      .get() as { status: string; lease_until: string | null; updated_at: string; live: number };

  it("clears a LIVE lease, so the next poll can claim the job with nothing to wait out", async () => {
    await store.setJobRunning("job_1");
    expect(row().live).toBe(1); // control: there really was a lease to release

    expect(await store.releaseJobLease("job_1")).toBe(true);

    expect(row().lease_until).toBeNull();
    expect(row().status).toBe("running");
    // The consequence, asserted through the shipped statement rather than inferred from the column.
    expect(await store.claimJob("job_1", 60)).toBe(true);
  });

  it("does NOT touch updated_at: a yield is not progress", async () => {
    // Same reason renewJobLease leaves it alone. updated_at is the clock the lost-driver rule reads,
    // and a yield that bumped it would push out the moment a job nobody resumes is declared lost.
    await store.setJobRunning("job_1");
    db.prepare("UPDATE provision_jobs SET updated_at = '2020-01-01 00:00:00' WHERE id = 'job_1'").run();

    expect(await store.releaseJobLease("job_1")).toBe(true);

    expect(row().updated_at).toBe("2020-01-01 00:00:00");
  });

  it("REFUSES a terminal job: a driver that lost its job cannot write to the closed record", async () => {
    await store.setJobRunning("job_1");
    await store.finishJob("job_1", "failed", "runpod_endpoints", "keyless refusal");

    expect(await store.releaseJobLease("job_1")).toBe(false);
    expect(row().status).toBe("failed");
  });

  it("REFUSES a job id that does not exist", async () => {
    expect(await store.releaseJobLease("job_missing")).toBe(false);
  });
});

describe("renewJobLease and the terminal-job guard (cp#148)", () => {
  let db: DatabaseSync;
  let store: D1Store;

  beforeEach(async () => {
    db = freshDb();
    store = new D1Store(d1Over(db));
    await store.createAccount("acct_1", "a@b.com");
    await store.createTenant("ten_1", "rehearsal", "acct_1", "provisioning");
    await store.createProvisionJob("job_1", "ten_1", "provision", TEST_PROVISION_FACTS);
  });

  const row = () =>
    db
      .prepare(
        "SELECT status, step, steps_done, lease_until, updated_at, " +
          "CASE WHEN lease_until > datetime('now') THEN 1 ELSE 0 END AS live " +
          "FROM provision_jobs WHERE id = 'job_1'",
      )
      .get() as {
      status: string;
      step: string | null;
      steps_done: string;
      lease_until: string | null;
      updated_at: string;
      live: number;
    };

  it("renews a lapsed lease, and the renewed lease really is in the future", async () => {
    await store.setJobRunning("job_1");
    // Expire it exactly the way a long unmarked step does, then heartbeat.
    db.prepare("UPDATE provision_jobs SET lease_until = datetime('now', '-30 seconds') WHERE id = 'job_1'").run();
    expect(row().live).toBe(0);

    expect(await store.renewJobLease("job_1", 60)).toBe(true);
    expect(row().live).toBe(1);
  });

  it("does NOT touch updated_at, so a live-but-wedged driver is still declared lost", async () => {
    // updated_at is the PROGRESS clock MAX_JOB_STALE_MS reads. A heartbeat that bumped it would make
    // a driver that is alive and getting nowhere immortal.
    await store.setJobRunning("job_1");
    db.prepare("UPDATE provision_jobs SET updated_at = '2020-01-01 00:00:00' WHERE id = 'job_1'").run();

    expect(await store.renewJobLease("job_1", 60)).toBe(true);

    expect(row().updated_at).toBe("2020-01-01 00:00:00");
    expect(row().live).toBe(1);
  });

  it("REFUSES a terminal job, so a driver that lost its job cannot re-arm the record", async () => {
    await store.setJobRunning("job_1");
    await store.finishJob("job_1", "failed", "runpod_endpoints", "keyless refusal");

    expect(await store.renewJobLease("job_1", 60)).toBe(false);
    expect(row().lease_until).toBeNull();
  });

  it("REFUSES a job id that does not exist", async () => {
    expect(await store.renewJobLease("job_missing", 60)).toBe(false);
  });

  it("updateJobProgress WRITES on a running job (control) and REFUSES on a terminal one", async () => {
    await store.setJobRunning("job_1");
    await store.updateJobProgress("job_1", "r2_token", JSON.stringify(["d1_create", "r2_token"]));
    expect(row().step).toBe("r2_token");

    await store.finishJob("job_1", "failed", "runpod_endpoints", "keyless refusal");
    // The losing driver runs on to the end of its invocation and marks its next step.
    await store.updateJobProgress("job_1", "wfp_upload", JSON.stringify(["d1_create", "r2_token", "wfp_upload"]));

    const after = row();
    expect(after.status).toBe("failed");
    expect(after.step).toBe("r2_token");
    expect(after.steps_done).not.toContain("wfp_upload");
    expect(after.lease_until).toBeNull();
  });
});
