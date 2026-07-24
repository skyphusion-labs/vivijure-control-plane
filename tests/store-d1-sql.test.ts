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
    const job = await store.createProvisionJob("job_3", "ten_1", "provision");
    expect(job.kind).toBe("provision");
    expect(job.status).toBe("queued");
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
});
