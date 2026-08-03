// The UN-STUBBABLE seam for the proxy's three store methods (cp#290).
//
// Every route test in this repo drives MemoryStore, a hand-written fake. A fake proves the DECISION
// path and can never catch a malformed statement, a mistyped column, or a constraint that behaves
// differently from the one in the fake's author's head -- this repo shipped a 500 on every valid
// release exactly that way. So these run the SHIPPED D1Store against a REAL SQLite built from the
// REAL migration ledger, including 0021.
//
// The idempotency guard is the one that matters most here: `WHERE terminal_at IS NULL` is what
// stands between one job and a triple charge, and it is a property of the SQL, not of the caller.

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { D1Store } from "../src/store-d1";
import { d1Over, freshMigratedDb as freshDb } from "./sqlite-d1";

const OPEN = {
  job_id: "job-1",
  tenant_id: "ten_1",
  tenant_slug: "rehearsal",
  module: "keyframe",
  endpoint_id: "pool-backend",
  submitted_at: 1_750_000_000_000,
  webhook_token_sha256: "a".repeat(64),
};

const row = (db: DatabaseSync, jobId = "job-1") =>
  db.prepare("SELECT * FROM runpod_job_index WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;

describe("the proxy's index statements execute against real SQLite", () => {
  let db: DatabaseSync;
  let store: D1Store;

  beforeEach(async () => {
    db = freshDb();
    store = new D1Store(d1Over(db));
    await store.createAccount("acct_1", "a@b.com");
    await store.createTenant("ten_1", "rehearsal", "acct_1", "live");
  });

  it("opens a row labelled source='proxy' with the endpoint that prices it", async () => {
    await store.openRunpodProxyJob(OPEN);
    expect(row(db)).toMatchObject({
      job_id: "job-1",
      tenant_id: "ten_1",
      tenant_slug: "rehearsal",
      module: "keyframe",
      endpoint_id: "pool-backend",
      outcome: "submitted",
      source: "proxy",
      terminal_at: null,
      webhook_token_sha256: "a".repeat(64),
    });
  });

  it("resolves the callback token to its job, and answers null for an unknown one", async () => {
    await store.openRunpodProxyJob(OPEN);
    expect(await store.findRunpodProxyJobByWebhookToken("a".repeat(64))).toMatchObject({
      job_id: "job-1",
      endpoint_id: "pool-backend",
      terminal_at: null,
    });
    // The ONLY thing an unverified caller may learn.
    expect(await store.findRunpodProxyJobByWebhookToken("b".repeat(64))).toBeNull();
  });

  it("closes ONCE: the second and third deliveries change nothing and report 0", async () => {
    await store.openRunpodProxyJob(OPEN);
    const close = {
      job_id: "job-1",
      outcome: "completed",
      status_raw: "COMPLETED",
      execution_ms: 5000,
      delay_ms: 900,
      terminal_at: 1_750_000_100_000,
    };
    expect(await store.closeRunpodProxyJob(close)).toBe(1);
    // A slow-looking receiver gets three byte-identical deliveries (measured 2026-08-02). Without
    // the guard, that is one job counted three times.
    expect(await store.closeRunpodProxyJob({ ...close, execution_ms: 999_999 })).toBe(0);
    expect(await store.closeRunpodProxyJob({ ...close, execution_ms: 999_999 })).toBe(0);
    expect(row(db)).toMatchObject({ outcome: "completed", status_raw: "COMPLETED", execution_ms: 5000 });
  });

  it("reports 0 rather than throwing for a job it never opened (a forged or raced callback)", async () => {
    expect(await store.closeRunpodProxyJob({
      job_id: "never-seen",
      outcome: "completed",
      status_raw: "COMPLETED",
      execution_ms: 1,
      delay_ms: 1,
      terminal_at: 1,
    })).toBe(0);
  });

  it("keeps NULL and 0 distinguishable through the SQL layer, not just in the parser", async () => {
    await store.openRunpodProxyJob(OPEN);
    await store.openRunpodProxyJob({ ...OPEN, job_id: "job-2", webhook_token_sha256: "c".repeat(64) });
    // CANCELLED reports neither field; a real COMPLETED can genuinely report zero.
    await store.closeRunpodProxyJob({
      job_id: "job-1", outcome: "cancelled", status_raw: "CANCELLED",
      execution_ms: null, delay_ms: null, terminal_at: 2,
    });
    await store.closeRunpodProxyJob({
      job_id: "job-2", outcome: "completed", status_raw: "COMPLETED",
      execution_ms: 0, delay_ms: 0, terminal_at: 2,
    });
    expect(row(db, "job-1")).toMatchObject({ execution_ms: null, delay_ms: null });
    expect(row(db, "job-2")).toMatchObject({ execution_ms: 0, delay_ms: 0 });
  });

  it("a colliding open can never BLANK a closed row's terminal facts", async () => {
    await store.openRunpodProxyJob(OPEN);
    await store.closeRunpodProxyJob({
      job_id: "job-1", outcome: "completed", status_raw: "COMPLETED",
      execution_ms: 42, delay_ms: 1, terminal_at: 7,
    });
    await store.openRunpodProxyJob({ ...OPEN, webhook_token_sha256: "d".repeat(64) });
    expect(row(db)).toMatchObject({ outcome: "completed", terminal_at: 7, execution_ms: 42 });
  });

  it("the UNIQUE index refuses two open jobs sharing one callback credential", async () => {
    await store.openRunpodProxyJob(OPEN);
    await expect(
      store.openRunpodProxyJob({ ...OPEN, job_id: "job-2" }),
    ).rejects.toThrow(/UNIQUE/i);
    // CONTROL: a different token inserts cleanly, so the rejection above is the constraint firing
    // rather than the second insert being broken for some unrelated reason.
    await store.openRunpodProxyJob({ ...OPEN, job_id: "job-3", webhook_token_sha256: "e".repeat(64) });
    expect(row(db, "job-3")).toBeDefined();
  });

  it("the harvest path still labels its own rows, so the two origins stay distinguishable", async () => {
    await store.indexRunpodJobs("ten_1", "rehearsal", [
      { job_id: "job-harvested", module: "own-gpu", outcome: "completed", submitted_at: 1, terminal_at: 2 },
    ]);
    expect(row(db, "job-harvested")).toMatchObject({ source: "harvest" });
    await store.openRunpodProxyJob(OPEN);
    expect(row(db)).toMatchObject({ source: "proxy" });
  });
});

// ------------------------------------------------------------------------------------------------
// The SWEEP's queries (cp#290). Same reason as everything above: MemoryStore mirrors the predicate
// by hand, and a hand-mirrored predicate is my assumption about the SQL rather than the SQL.
// ------------------------------------------------------------------------------------------------

describe("the sweep's work-queue statements execute against real SQLite", () => {
  let db: DatabaseSync;
  let store: D1Store;

  beforeEach(async () => {
    db = freshDb();
    store = new D1Store(d1Over(db));
    await store.createAccount("acct_1", "a@b.com");
    await store.createTenant("ten_1", "rehearsal", "acct_1", "live");
  });

  const open = (jobId: string, submittedAt: number, endpoint: string | null = "pool-backend") =>
    store.openRunpodProxyJob({
      job_id: jobId,
      tenant_id: "ten_1",
      tenant_slug: "rehearsal",
      module: "keyframe",
      endpoint_id: endpoint as string,
      submitted_at: submittedAt,
      webhook_token_sha256: jobId.padEnd(64, "0"),
    });

  it("returns open proxy rows older than the ceiling, oldest first", async () => {
    await open("job-old", 1000);
    await open("job-new", 5000);
    await open("job-young", 9000);
    const rows = await store.listOpenRunpodProxyJobs(8000, 10);
    expect(rows.map((r) => r.job_id)).toEqual(["job-old", "job-new"]);
    expect(rows[0]).toMatchObject({ tenant_id: "ten_1", endpoint_id: "pool-backend", submitted_at: 1000 });
  });

  it("EXCLUDES a closed row, which is what makes this a work queue rather than a log", async () => {
    await open("job-1", 1000);
    await open("job-2", 1000);
    await store.closeRunpodProxyJob({
      job_id: "job-1", outcome: "completed", status_raw: "COMPLETED",
      execution_ms: 5, delay_ms: 1, terminal_at: 2000,
    });
    expect((await store.listOpenRunpodProxyJobs(8000, 10)).map((r) => r.job_id)).toEqual(["job-2"]);
  });

  it("EXCLUDES a harvested row: the sweep cannot ask about a job it did not submit", async () => {
    await store.indexRunpodJobs("ten_1", "rehearsal", [
      { job_id: "job-harvested", module: "own-gpu", outcome: "submitted", submitted_at: 1000, terminal_at: null },
    ]);
    await open("job-proxy", 1000);
    // CONTROL: the proxy row IS returned, so the exclusion above is the source filter rather than
    // a query that returns nothing.
    expect((await store.listOpenRunpodProxyJobs(8000, 10)).map((r) => r.job_id)).toEqual(["job-proxy"]);
    expect(await store.countOpenRunpodProxyJobs(8000)).toBe(1);
  });

  it("the COUNT uses the same predicate as the LIST, so the cap is the only difference", async () => {
    for (let i = 0; i < 5; i++) await open(`job-${i}`, 1000 + i);
    expect(await store.countOpenRunpodProxyJobs(8000)).toBe(5);
    expect((await store.listOpenRunpodProxyJobs(8000, 2)).length).toBe(2);
    // If these two ever diverge, a truncated run reports as complete coverage, which is the exact
    // failure the pair exists to make visible.
    expect(await store.countOpenRunpodProxyJobs(8000)).toBeGreaterThan(
      (await store.listOpenRunpodProxyJobs(8000, 2)).length,
    );
  });

  it("writes `unknown` as a real terminal, distinguishable from a measured outcome", async () => {
    await open("job-lost", 1000);
    expect(
      await store.closeRunpodProxyJob({
        job_id: "job-lost", outcome: "unknown", status_raw: "",
        execution_ms: null, delay_ms: null, terminal_at: 9999,
      }),
    ).toBe(1);
    expect(row(db, "job-lost")).toMatchObject({
      outcome: "unknown", status_raw: "", execution_ms: null, delay_ms: null, terminal_at: 9999,
    });
    // And it is closed, so the sweep does not re-examine it every tick forever.
    expect(await store.countOpenRunpodProxyJobs(99999)).toBe(0);
  });
});
