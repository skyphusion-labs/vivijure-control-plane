// D1's bound-parameter ceiling, against the shipped store (fleet-chezmoi#2249 item 3).
//
// WHAT WENT WRONG, and it is a doctrine failure before it is a SQL one. `readTenantLlmSpend` built an
// `IN (?2, ?3, ...)` list with ONE PARAMETER PER ROLL-UP PERIOD, capped at MAX_PERIODS_PER_WINDOW =
// 20,000. The five-minute cron produces about 8,900 periods a month. D1 refuses any statement over 100
// parameters, so:
//
//   - POST /api/admin/meter-settle threw for EVERY tenant; runLlmSettlement caught it and recorded
//     every one of them `unbillable`, so no LLM overage was ever billed;
//   - GET /api/admin/llm-spend answered 500 for any window longer than about 8 hours.
//
// And the 1,989-test suite was green, because the tests run node:sqlite, which allows roughly 32,000
// variables. A REAL engine is not the same property as THE real engine. The ceiling now lives in
// tests/sqlite-d1.ts so this class of defect cannot pass locally again, and the controls at the
// bottom prove the instrument can produce the failing reading rather than asserting that it could.
//
// THE FIX IS NOT CHUNKING. The period set is now selected by a SUBQUERY over the same window, so the
// parameter count is CONSTANT (four) no matter how many periods the window holds. Chunking would have
// traded one limit for 90 sequential round trips per tenant per settlement.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { LlmSpendD1 } from "../src/store-d1";
import { D1_MAX_BOUND_PARAMS, d1Over, freshMigratedDb } from "./sqlite-d1";

const TENANT = "ten_abc";
const SLUG = "acme";

// A month at the five-minute cron is about 8,900 periods. 250 is the smallest number that makes the
// point cheaply: anything over 99 breaks a one-parameter-per-period IN list, and the assertion below
// is on the parameter count being CONSTANT rather than on any particular period count.
const PERIODS = 250;

const WINDOW = { windowStart: "2026-08-01T00:00:00.000Z", windowEnd: "2026-09-01T00:00:00.000Z" };

/** Real rows through the shipped writers: N finished, complete, control-passed periods in the window. */
async function seed(store: LlmSpendD1, periods: number): Promise<void> {
  const base = Date.parse(WINDOW.windowStart);
  for (let i = 0; i < periods; i++) {
    const id = `llmp_${String(i).padStart(6, "0")}`;
    const start = new Date(base + i * 5 * 60_000).toISOString();
    const end = new Date(base + (i + 1) * 5 * 60_000).toISOString();
    await store.openLlmRollupPeriod({
      id,
      windowStart: start,
      windowEnd: end,
      status: "complete",
      controlPassed: true,
      gapDetected: false,
      startedAt: start,
    });
    await store.writeLlmSpendEvents(
      id,
      [
        {
          source: "ai_gateway",
          sourceId: `log_${i}`,
          tenantId: TENANT,
          slug: SLUG,
          model: "claude-opus-4-8",
          costMicroUsd: 1_000,
          tokensIn: 10,
          tokensOut: 5,
          cached: 0,
          occurredAt: start,
        },
      ],
      end,
    );
    await store.closeLlmRollupPeriod(id, 1, end);
  }
}

describe("readTenantLlmSpend under D1's real bound-parameter ceiling", () => {
  it(`reads a ${PERIODS}-period window without exceeding ${D1_MAX_BOUND_PARAMS} bound parameters`, async () => {
    const db = freshMigratedDb();
    const binds: number[] = [];
    const store = new LlmSpendD1(d1Over(db, (_sql, args) => binds.push(args.length)));
    await seed(store, PERIODS);

    const before = binds.length;
    const out = await store.readTenantLlmSpend({ tenantId: TENANT, ...WINDOW });

    // The totals are still right. A read that stayed under the ceiling by reading less would be the
    // same under-bill in a different costume.
    expect(out.cost_micro_usd).toBe(PERIODS * 1_000);
    expect(out.requests).toBe(PERIODS);
    expect(out.periods).toBe(PERIODS);
    expect(out.complete).toBe(true);
    expect(out.reason).toBeNull();

    // THE INVARIANT: the parameter count does not grow with the period count. Not "it fits today".
    const readBinds = binds.slice(before);
    expect(readBinds.length).toBeGreaterThan(0);
    expect(Math.max(...readBinds)).toBeLessThanOrEqual(4);
  });

  it("scales: doubling the periods does not change the bound-parameter count", async () => {
    // A ceiling test that passes at one size and is never checked at another is a ceiling test that
    // will be true until somebody's window is bigger.
    const counts = await Promise.all(
      [120, 480].map(async (n) => {
        const db = freshMigratedDb();
        const binds: number[] = [];
        const store = new LlmSpendD1(d1Over(db, (_sql, args) => binds.push(args.length)));
        await seed(store, n);
        const before = binds.length;
        const out = await store.readTenantLlmSpend({ tenantId: TENANT, ...WINDOW });
        expect(out.periods).toBe(n);
        expect(out.cost_micro_usd).toBe(n * 1_000);
        return Math.max(...binds.slice(before));
      }),
    );
    expect(counts[0]).toBe(counts[1]);
  });

  it("still reports a TRUNCATED census as incomplete, with the cap doing the cutting", async () => {
    // The census cap is the reason the old IN list existed at all, so the fix has to keep the
    // truncation signal honest rather than quietly widening the window.
    const db = freshMigratedDb();
    const store = new LlmSpendD1(d1Over(db), 10);
    await seed(store, 25);
    const out = await store.readTenantLlmSpend({ tenantId: TENANT, ...WINDOW });
    expect(out.periods).toBe(10);
    expect(out.complete).toBe(false);
    expect(out.reason).toMatch(/row limit/i);
    // Summed over the CENSUSED periods only, so the reported total agrees with the reported period
    // count. A total over all 25 next to a census of 10 would be two facts that cannot both be read.
    expect(out.cost_micro_usd).toBe(10 * 1_000);
  });

  it("POSITIVE CONTROL: the harness refuses 101 bound parameters, the way D1 does", () => {
    // Without this, every green result above is also what a harness that enforces nothing produces.
    const db = freshMigratedDb();
    expect(() =>
      d1Over(db)
        .prepare("SELECT 1")
        .bind(...Array(D1_MAX_BOUND_PARAMS + 1).fill(1)),
    ).toThrow(/too many bound parameters: 101 exceeds D1's limit of 100/);
  });

  it("NEGATIVE CONTROL: exactly 100 bound parameters is accepted", () => {
    const db = freshMigratedDb();
    expect(() =>
      d1Over(db)
        .prepare("SELECT 1")
        .bind(...Array(D1_MAX_BOUND_PARAMS).fill(1)),
    ).not.toThrow();
  });

  it("CONTROL: node:sqlite itself would have allowed the statement D1 refuses", () => {
    // THE WHOLE REASON THE CEILING LIVES IN THE HARNESS. This is the reading the old suite got, and
    // it is indistinguishable from correctness right up to the deploy.
    const db = new DatabaseSync(":memory:");
    const placeholders = Array.from({ length: 200 }, (_, i) => "?" + (i + 1)).join(",");
    const stmt = db.prepare(`SELECT 1 WHERE 1 IN (${placeholders})`);
    expect(() => stmt.get(...(Array(200).fill(1) as never[]))).not.toThrow();
  });
});
