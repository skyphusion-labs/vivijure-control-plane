// cp#185 part two: the meter's SQL, against a REAL engine seeded from the REAL migrations.
//
// Everything above this file is pure and was tested against doubles. A double agrees with whatever
// the code did, so the properties that live in the SCHEMA and in the statements -- idempotency,
// monotonic watermark, period-keyed summation, the truncation guard -- are proven here or not at
// all. The whole ingest-then-read path runs end to end so the two halves are proven to AGREE, which
// is the seam a per-half test cannot reach.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { d1Over, freshMigratedDb } from "./sqlite-d1";
import { LlmSpendD1 } from "../src/store-d1";
import { ingestLlmSpend } from "../src/llm-spend-ingest";
import type { GatewayLogReader, GatewayLogRow } from "../src/llm-spend-rollup";

const row = (over: Partial<GatewayLogRow> = {}): GatewayLogRow => ({
  id: "log_1",
  created_at: "2026-07-28T09:00:00.000Z",
  model: "claude-opus-4-8",
  cost: 0.000145,
  tokens_in: 9,
  tokens_out: 4,
  cached: false,
  metadata: { tenant_id: "ten_abc", slug: "acme" },
  ...over,
});

const readerOf = (pages: GatewayLogRow[][], total: number | null = 5, oldest: string | null = null): GatewayLogReader => ({
  async list({ page }) {
    return { rows: pages[page - 1] ?? [], totalCount: total };
  },
  async probe() {
    return { total, oldest };
  },
});

function harness(cap?: number) {
  const db = freshMigratedDb();
  const store = new LlmSpendD1(d1Over(db), cap);
  let n = 0;
  let clock = Date.parse("2026-07-28T10:00:00.000Z");
  return {
    db,
    store,
    tick: (ms: number) => (clock += ms),
    run: (reader: GatewayLogReader, pageCap?: number) =>
      ingestLlmSpend({ store, reader, now: () => clock, newId: () => "llmp_" + ++n, pageCap }),
    count: (sql: string) => (db.prepare(sql).get() as { n: number }).n,
  };
}

const DAY = { windowStart: "2026-07-28T00:00:00.000Z", windowEnd: "2026-07-29T00:00:00.000Z" };

describe("ingest -> read, end to end against real SQL", () => {
  it("CONTROL: one clean run makes one complete, billable window", async () => {
    const h = harness();
    await h.run(readerOf([[row({ id: "a", cost: 0.000145 }), row({ id: "b", cost: 0.000255 })]]));
    const out = await h.store.readTenantLlmSpend({ tenantId: "ten_abc", ...DAY });
    expect(out.complete).toBe(true);
    expect(out.reason).toBeNull();
    // 145 + 255 micro-USD, converted ONCE at ingest. Integers all the way down.
    expect(out.cost_micro_usd).toBe(400);
    expect(out.requests).toBe(2);
    expect(out.periods).toBe(1);
  });

  it("scopes to the tenant on the ROW, never to whoever asked", async () => {
    const h = harness();
    await h.run(
      readerOf([
        [
          row({ id: "a", cost: 0.000145, metadata: { tenant_id: "ten_abc", slug: "acme" } }),
          row({ id: "b", cost: 0.000900, metadata: { tenant_id: "ten_xyz", slug: "other" } }),
        ],
      ]),
    );
    expect((await h.store.readTenantLlmSpend({ tenantId: "ten_abc", ...DAY })).cost_micro_usd).toBe(145);
    expect((await h.store.readTenantLlmSpend({ tenantId: "ten_xyz", ...DAY })).cost_micro_usd).toBe(900);
    // A tenant with no rows in a window that WAS observed gets an honest complete zero.
    const none = await h.store.readTenantLlmSpend({ tenantId: "ten_nobody", ...DAY });
    expect(none).toMatchObject({ complete: true, cost_micro_usd: 0, requests: 0 });
  });

  // An unattributed row is real money attributable to nobody. It must never be spread across
  // tenants and must never vanish.
  it("keeps an UNATTRIBUTED row out of every tenant's total while still storing it", async () => {
    const h = harness();
    await h.run(readerOf([[row({ id: "a", cost: 0.000145 }), row({ id: "b", cost: 0.000500, metadata: null })]]));
    expect((await h.store.readTenantLlmSpend({ tenantId: "ten_abc", ...DAY })).cost_micro_usd).toBe(145);
    expect(h.count("SELECT COUNT(*) AS n FROM llm_spend_events WHERE tenant_id IS NULL")).toBe(1);
  });

  // THE PROPERTY THAT LIVES IN THE SCHEMA. The gateway's created_at filter is second-granular, so
  // the whole second holding the watermark comes back every run. Re-delivery has to be free.
  it("a re-run over rows already written double-bills nothing", async () => {
    const h = harness();
    const pages = [[row({ id: "a", cost: 0.000145 }), row({ id: "b", cost: 0.000255 })]];
    const first = await h.run(readerOf(pages));
    expect(first.eventsWritten).toBe(2);

    h.tick(900_000);
    const second = await h.run(readerOf(pages));
    // The engine ignored both duplicates. This is the assertion that would catch an OR IGNORE that
    // had been dropped, or a primary key that no longer covers the natural key.
    expect(second.eventsWritten).toBe(0);
    expect(h.count("SELECT COUNT(*) AS n FROM llm_spend_events")).toBe(2);

    const out = await h.store.readTenantLlmSpend({ tenantId: "ten_abc", ...DAY });
    expect(out.cost_micro_usd).toBe(400);
    expect(out.periods).toBe(2);
    // CONTROL: a genuinely new row still lands, so the constraint is not simply rejecting writes.
    h.tick(900_000);
    const third = await h.run(readerOf([[...pages[0], row({ id: "c", cost: 0.000100 })]]));
    expect(third.eventsWritten).toBe(1);
    expect((await h.store.readTenantLlmSpend({ tenantId: "ten_abc", ...DAY })).cost_micro_usd).toBe(500);
  });

  // Migration 0015 rules that a row belongs to the period that INGESTED it, so a late arrival is
  // billed in the next statement rather than retroactively changing a settled one.
  it("bills a LATE row in the window that ingested it, not the window it occurred in", async () => {
    const h = harness();
    await h.run(readerOf([[row({ id: "a", cost: 0.000145 })]]));
    // A row that OCCURRED two days before the billing window, ingested now.
    h.tick(900_000);
    await h.run(readerOf([[row({ id: "old", cost: 0.000999, created_at: "2026-07-26T01:00:00.000Z" })]]));

    const today = await h.store.readTenantLlmSpend({ tenantId: "ten_abc", ...DAY });
    expect(today.cost_micro_usd).toBe(1144);

    // ...and the day it OCCURRED bills nothing for it, because no period ended that day.
    const then = await h.store.readTenantLlmSpend({
      tenantId: "ten_abc",
      windowStart: "2026-07-26T00:00:00.000Z",
      windowEnd: "2026-07-27T00:00:00.000Z",
    });
    expect(then.requests).toBe(0);
    // And it says so, rather than reporting a complete zero for a window nothing observed.
    expect(then.complete).toBe(false);
  });

  it("PARTITIONS periods across adjacent windows, billing each period exactly once", async () => {
    const h = harness();
    await h.run(readerOf([[row({ id: "a", cost: 0.000100 })]]));
    // Next run lands on the far side of the day boundary.
    h.tick(Date.parse("2026-07-29T01:00:00.000Z") - Date.parse("2026-07-28T10:00:00.000Z"));
    await h.run(readerOf([[row({ id: "b", cost: 0.000200 })]]));

    const d28 = await h.store.readTenantLlmSpend({ tenantId: "ten_abc", ...DAY });
    const d29 = await h.store.readTenantLlmSpend({
      tenantId: "ten_abc",
      windowStart: "2026-07-29T00:00:00.000Z",
      windowEnd: "2026-07-30T00:00:00.000Z",
    });
    expect(d28.cost_micro_usd).toBe(100);
    expect(d29.cost_micro_usd).toBe(200);
    expect(d28.periods + d29.periods).toBe(2);
  });
});

describe("the read refuses to call an untrustworthy window complete", () => {
  it("a FAILED positive control sinks the window even though the write succeeded", async () => {
    const h = harness();
    // total_count 0: the answer a gateway that does not exist gives, byte-identical to an empty one.
    await h.run(readerOf([[]], 0));
    const out = await h.store.readTenantLlmSpend({ tenantId: "ten_abc", ...DAY });
    expect(out.periods).toBe(1);
    expect(out.complete).toBe(false);
    expect(out.reason).toContain("FAILED their positive control");
  });

  it("a retention GAP sinks the window", async () => {
    const h = harness();
    await h.run(readerOf([[row({ id: "a" })]]));
    h.tick(900_000);
    // The oldest surviving row is now NEWER than the watermark: the stretch between is deleted.
    await h.run(readerOf([[row({ id: "b", created_at: "2026-07-28T12:00:00.000Z" })]], 5, "2026-07-28T11:00:00.000Z"));
    const out = await h.store.readTenantLlmSpend({ tenantId: "ten_abc", ...DAY });
    expect(out.complete).toBe(false);
    expect(out.reason).toContain("gone for good");
  });

  // A cost the gateway did not report is stored NULL and skipped by SUM. Unflagged, the pair
  // (a total, a bigger count) reads as "we billed everything".
  it("an UNPRICED row makes the total a floor and says so", async () => {
    const h = harness();
    await h.run(readerOf([[row({ id: "a", cost: 0.000145 }), row({ id: "b", cost: undefined })]]));
    const out = await h.store.readTenantLlmSpend({ tenantId: "ten_abc", ...DAY });
    expect(out.cost_micro_usd).toBe(145);
    expect(out.requests).toBe(2);
    expect(out.unpriced_requests).toBe(1);
    expect(out.complete).toBe(false);
  });

  // THE SHAPE A SILENTLY DEAD CRON PRODUCES, against a real database with real rows in it.
  it("a window no run was assigned to is NOT a zero", async () => {
    const h = harness();
    await h.run(readerOf([[row({ id: "a", cost: 0.000145 })]]));
    const untouched = await h.store.readTenantLlmSpend({
      tenantId: "ten_abc",
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-08-02T00:00:00.000Z",
    });
    expect(untouched.cost_micro_usd).toBe(0);
    expect(untouched.complete).toBe(false);
    expect(untouched.reason).toContain("NOT the same fact as zero spend");
  });

  // The truncation guard, WATCHED FAILING. Cap 2, plant 3 periods. Without the LIMIT+1 detection
  // this returns a confident subset dressed as a total.
  it("detects a TRUNCATED period census instead of answering from a subset", async () => {
    const h = harness(2);
    for (let i = 0; i < 3; i++) {
      await h.run(readerOf([[row({ id: "r" + i, cost: 0.000100 })]]));
      h.tick(900_000);
    }
    const out = await h.store.readTenantLlmSpend({ tenantId: "ten_abc", ...DAY });
    expect(out.periods).toBe(2);
    expect(out.complete).toBe(false);
    expect(out.reason).toContain("row limit");

    // POSITIVE CONTROL: the SAME data under a cap that is not exceeded is complete. Without this,
    // a store that reported truncation unconditionally would pass the assertion above.
    const roomy = new LlmSpendD1(d1Over(h.db), 10);
    const ok = await roomy.readTenantLlmSpend({ tenantId: "ten_abc", ...DAY });
    expect(ok.periods).toBe(3);
    expect(ok.complete).toBe(true);
    expect(ok.cost_micro_usd).toBe(300);
  });

  // A crash between opening a period and writing its events leaves finished_at NULL. That row must
  // not read as an observation.
  it("an UNFINISHED period sinks the window", async () => {
    const h = harness();
    await h.store.openLlmRollupPeriod({
      id: "llmp_torn",
      windowStart: "2026-07-28T09:45:00.000Z",
      windowEnd: "2026-07-28T10:00:00.000Z",
      status: "complete",
      controlPassed: true,
      gapDetected: false,
      startedAt: "2026-07-28T10:00:00.000Z",
    });
    const out = await h.store.readTenantLlmSpend({ tenantId: "ten_abc", ...DAY });
    expect(out.complete).toBe(false);
    expect(out.reason).toContain("never finished writing");

    // CONTROL: closing it makes the very same row an observation, so the flag tracks finished_at
    // and is not simply always set.
    await h.store.closeLlmRollupPeriod("llmp_torn", 0, "2026-07-28T10:00:01.000Z");
    expect((await h.store.readTenantLlmSpend({ tenantId: "ten_abc", ...DAY })).complete).toBe(true);
  });
});

describe("the watermark", () => {
  it("advances, and NEVER walks backward even if asked to", async () => {
    const h = harness();
    await h.store.advanceLlmWatermark("ai_gateway", "2026-07-28T09:00:00.000Z", "t1");
    expect(await h.store.readLlmWatermark("ai_gateway")).toBe("2026-07-28T09:00:00.000Z");
    // CONTROL: forward still moves.
    await h.store.advanceLlmWatermark("ai_gateway", "2026-07-28T10:00:00.000Z", "t2");
    expect(await h.store.readLlmWatermark("ai_gateway")).toBe("2026-07-28T10:00:00.000Z");
    // A stale run (or a bug) trying to rewind the cursor past rows already billed is refused BY THE
    // STATEMENT, not by a caller remembering to check.
    await h.store.advanceLlmWatermark("ai_gateway", "2026-07-28T08:00:00.000Z", "t3");
    expect(await h.store.readLlmWatermark("ai_gateway")).toBe("2026-07-28T10:00:00.000Z");
  });

  it("is null on a virgin plane, and the first period end is null with it", async () => {
    const h = harness();
    expect(await h.store.readLlmWatermark("ai_gateway")).toBeNull();
    expect(await h.store.readLastPeriodEnd()).toBeNull();
  });

  it("readLastPeriodEnd tracks the newest window_end, which is what makes periods tile", async () => {
    const h = harness();
    await h.run(readerOf([[row({ id: "a" })]]));
    const firstEnd = await h.store.readLastPeriodEnd();
    h.tick(900_000);
    const second = await h.run(readerOf([[row({ id: "b" })]]));
    expect(second.windowStart).toBe(firstEnd);
    expect(await h.store.readLastPeriodEnd()).toBe(second.windowEnd);
  });
});

describe("the schema itself refuses bad money", () => {
  it("CONTROL: the migrations really did create the meter tables", () => {
    const db: DatabaseSync = freshMigratedDb();
    for (const t of ["llm_spend_events", "llm_rollup_periods", "llm_rollup_watermark"]) {
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(t),
      ).toEqual({ n: 1 });
    }
  });

  it("rejects a negative cost and an out-of-range status", () => {
    const db = freshMigratedDb();
    expect(() =>
      db
        .prepare(
          "INSERT INTO llm_rollup_periods (id,window_start,window_end,status,control_passed,rows_ingested,started_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run("p", "a", "b", "definitely-not-a-status", 1, 0, "t"),
    ).toThrow();
    db.prepare(
      "INSERT INTO llm_rollup_periods (id,window_start,window_end,status,control_passed,rows_ingested,started_at) VALUES (?,?,?,?,?,?,?)",
    ).run("p", "a", "b", "complete", 1, 0, "t");
    expect(() =>
      db
        .prepare(
          "INSERT INTO llm_spend_events (source,source_id,cost_micro_usd,occurred_at,inserted_at,period_id) VALUES (?,?,?,?,?,?)",
        )
        .run("ai_gateway", "neg", -1, "t", "t", "p"),
    ).toThrow();
  });
});
