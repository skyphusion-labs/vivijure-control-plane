// The RunPod job -> tenant index harvest (cp#270, for cp#225).
//
// WHAT MATTERS HERE is not that a harvest reads rows. It is the three states a harvest can be in and
// the fact that they are DISTINGUISHABLE: complete-with-rows, complete-with-no-table, and
// incomplete. Collapsing any two of them is how an index that outlives its source ends up silently
// short of it, and the source is deleted moments later.

import { describe, it, expect, vi } from "vitest";
import { harvestTenantJobLog, HARVEST_ROW_CAP, TENANT_JOB_LOG_TABLE } from "../src/runpod-job-index";

/** D1's wire shape: an array of statement results, each carrying its own `results` array. */
const d1 = (rows: Record<string, unknown>[]) => [{ results: rows }];

/**
 * A scripted tenant D1. The FIRST query is always the sqlite_master existence probe and the second
 * is the SELECT, so scripting them positionally is what lets a test say "the table is there but the
 * read fails" -- the case that must fail a teardown.
 */
function fakeD1(opts: { tableExists: boolean; rows?: Record<string, unknown>[]; selectThrows?: boolean }) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const queryD1 = vi.fn(async (_db: string, sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes("sqlite_master")) {
      return opts.tableExists ? d1([{ name: TENANT_JOB_LOG_TABLE }]) : d1([]);
    }
    if (opts.selectThrows) throw new Error("D1_ERROR: database is locked");
    return d1(opts.rows ?? []);
  });
  return { cf: { queryD1 }, calls };
}

const job = (id: string, over: Record<string, unknown> = {}) => ({
  job_id: id,
  module: "keyframe",
  outcome: "completed",
  submitted_at: 1_750_000_000,
  terminal_at: 1_750_000_100,
  ...over,
});

describe("harvestTenantJobLog", () => {
  it("reads the log and returns ids and machine labels only", async () => {
    const { cf } = fakeD1({ tableExists: true, rows: [job("j1"), job("j2", { outcome: "failed" })] });
    const res = await harvestTenantJobLog(cf, "db-1");

    expect(res.complete).toBe(true);
    expect(res.tableAbsent).toBe(false);
    expect(res.rows.map((r) => r.job_id)).toEqual(["j1", "j2"]);
    expect(res.rows[1].outcome).toBe("failed");
    // The whole row surface, asserted explicitly: if a future edit widens what is copied out of a
    // tenant database, this fails rather than the widening landing unnoticed.
    expect(Object.keys(res.rows[0]).sort()).toEqual([
      "job_id",
      "module",
      "outcome",
      "submitted_at",
      "terminal_at",
    ]);
  });

  it("asks sqlite_master BY DATA, never by error text, and binds the table name", async () => {
    // The classification must not depend on a vendor error string: "no such table" is free to
    // change, and it also matches genuinely broken states. vivijure-cf hit exactly this and fixed it
    // the same way.
    const { cf, calls } = fakeD1({ tableExists: true, rows: [] });
    await harvestTenantJobLog(cf, "db-1");

    expect(calls[0].sql).toContain("sqlite_master");
    expect(calls[0].params).toEqual(["table", TENANT_JOB_LOG_TABLE]);
  });

  it("NO TABLE is a COMPLETE harvest of nothing, and does not read further", async () => {
    // The population rollbackFailedProvision tears down: a provision that died before its
    // migrations ran. Treating this as an error would make every failed provision unreapable.
    const { cf, calls } = fakeD1({ tableExists: false });
    const res = await harvestTenantJobLog(cf, "db-1");

    expect(res).toEqual({ complete: true, rows: [], tableAbsent: true });
    expect(calls).toHaveLength(1);
  });

  it("distinguishes NO TABLE from a table with NO ROWS", async () => {
    // Both are complete harvests of nothing and they mean different things: never provisioned
    // versus ran and submitted nothing. Only tableAbsent tells them apart.
    const { cf } = fakeD1({ tableExists: true, rows: [] });
    const res = await harvestTenantJobLog(cf, "db-1");

    expect(res.complete).toBe(true);
    expect(res.rows).toEqual([]);
    expect(res.tableAbsent).toBe(false);
  });

  it("DETECTS the ceiling instead of silently truncating, and reports incomplete", async () => {
    // Selecting exactly `cap` cannot distinguish "there were cap" from "there were more". The query
    // asks for cap + 1 so the difference is observable; the extra row is discarded.
    const rows = Array.from({ length: HARVEST_ROW_CAP + 1 }, (_, i) => job(`j${i}`));
    const { cf, calls } = fakeD1({ tableExists: true, rows });
    const res = await harvestTenantJobLog(cf, "db-1");

    expect(res.complete).toBe(false);
    expect(res.rows).toHaveLength(HARVEST_ROW_CAP);
    expect(calls[1].params).toEqual([HARVEST_ROW_CAP + 1]);
  });

  it("CONTROL: exactly at the ceiling is COMPLETE, so the guard is not off by one", async () => {
    // Without this, an implementation that reported every full read as incomplete would pass the
    // test above and block teardowns forever.
    const rows = Array.from({ length: HARVEST_ROW_CAP }, (_, i) => job(`j${i}`));
    const { cf } = fakeD1({ tableExists: true, rows });
    const res = await harvestTenantJobLog(cf, "db-1");

    expect(res.complete).toBe(true);
    expect(res.rows).toHaveLength(HARVEST_ROW_CAP);
  });

  it("a read that FAILS throws rather than reporting an empty harvest", async () => {
    // The most dangerous shape: the table exists, the read fails, and a swallowed error would report
    // a complete harvest of zero rows moments before the source is deleted.
    const { cf } = fakeD1({ tableExists: true, selectThrows: true });
    await expect(harvestTenantJobLog(cf, "db-1")).rejects.toThrow("database is locked");
  });

  it("skips a row with no job id rather than storing a null key", async () => {
    const { cf } = fakeD1({ tableExists: true, rows: [job("j1"), job("", {}), { module: "own-gpu" }] });
    const res = await harvestTenantJobLog(cf, "db-1");
    expect(res.rows.map((r) => r.job_id)).toEqual(["j1"]);
  });

  it("carries NULLs through as null rather than inventing values", async () => {
    // submitted_at is legitimately NULL upstream (a legacy poll token with no submit time), and
    // migration 0014 is explicit that it is never a fabricated value. Preserve that.
    const { cf } = fakeD1({
      tableExists: true,
      rows: [job("j1", { submitted_at: null, terminal_at: null, outcome: "submitted" })],
    });
    const res = await harvestTenantJobLog(cf, "db-1");

    expect(res.rows[0].submitted_at).toBeNull();
    expect(res.rows[0].terminal_at).toBeNull();
    expect(res.rows[0].outcome).toBe("submitted");
  });
});
