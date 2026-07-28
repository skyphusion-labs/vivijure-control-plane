// cp#195: the settlement SWEEP, against a real ledger.
//
// The sweep's own job, beyond looping, is to be honest about what it did NOT cover, so the
// assertions concentrate there: a truncated tenant census, a tenant whose read threw, and the
// difference between the two kinds of "no row written".

import { describe, it, expect } from "vitest";
import { d1Over, freshMigratedDb } from "./sqlite-d1";
import { D1Store } from "../src/store-d1";
import { runLlmSettlement, type LlmSettlementDeps } from "../src/meter-settle-run";
import { parseBillingPeriodKey } from "../src/meter-period";
import type { LlmSpendWindow } from "../src/llm-spend-window";

const JULY = parseBillingPeriodKey("2026-07")!;

const window = (over: Partial<LlmSpendWindow> = {}): LlmSpendWindow => ({
  cost_micro_usd: 620_000,
  requests: 40,
  window_start: JULY.windowStart,
  window_end: JULY.windowEnd,
  complete: true,
  reason: null,
  periods: 3,
  unpriced_requests: 0,
  ...over,
});

async function harness(opts: {
  tenants?: Array<{ id: string; slug: string | null; deleted_at?: string | null }>;
  windows?: Record<string, LlmSpendWindow | Error>;
  allowance?: number | null;
  censusComplete?: boolean;
} = {}) {
  const db = freshMigratedDb();
  const store = new D1Store(d1Over(db));
  await store.createAccount("acct_1", "a@b.com");
  const tenants = opts.tenants ?? [{ id: "ten_a", slug: "alpha" }];
  for (const t of tenants) await store.createTenant(t.id, t.slug ?? t.id, "acct_1", "live");
  let n = 0;
  const deps: LlmSettlementDeps = {
    listTenants: async () => tenants,
    censusComplete: () => opts.censusComplete ?? true,
    spend: {
      async readTenantLlmSpend({ tenantId }) {
        const w = opts.windows?.[tenantId] ?? window();
        if (w instanceof Error) throw w;
        return w;
      },
    },
    ledger: store,
    allowanceMicroUsd: opts.allowance === undefined ? 520_000 : opts.allowance,
    newId: () => "led_" + ++n,
    now: () => "2026-08-01T00:05:00.000Z",
  };
  const rows = () => db.prepare("SELECT * FROM credit_ledger").all() as Array<Record<string, unknown>>;
  return { deps, rows, run: () => runLlmSettlement(deps, JULY) };
}

describe("runLlmSettlement", () => {
  it("CONTROL: settles every live tenant and totals what it charged", async () => {
    const h = await harness({
      tenants: [
        { id: "ten_a", slug: "alpha" },
        { id: "ten_b", slug: "beta" },
      ],
    });
    const r = await h.run();
    expect(r.debited).toBe(2);
    expect(r.totalDebitedMicroUsd).toBe(200_000); // 100k each
    expect(r.considered).toBe(2);
    expect(r.censusComplete).toBe(true);
    expect(h.rows()).toHaveLength(2);
  });

  it("is IDEMPOTENT: a second run over the same period charges nothing more", async () => {
    const h = await harness();
    expect((await h.run()).debited).toBe(1);
    const again = await h.run();
    expect(again.debited).toBe(0);
    expect(again.alreadySettled).toBe(1);
    // The re-run reports ZERO newly charged, so an operator cannot read a replay as new revenue.
    expect(again.totalDebitedMicroUsd).toBe(0);
    expect(h.rows()).toHaveLength(1);
  });

  // A TRUNCATED CENSUS IS MISSING MONEY, not a wrong number: tenants past the page limit were never
  // settled, and an unsettled tenant looks exactly like a tenant who owed nothing.
  it("reports a TRUNCATED tenant census instead of implying full coverage", async () => {
    const h = await harness({ censusComplete: false });
    const r = await h.run();
    expect(r.censusComplete).toBe(false);
    // ...and it still settles the ones it CAN see, rather than refusing everything.
    expect(r.debited).toBe(1);
  });

  it("skips DELETED tenants rather than writing a debit nobody can settle", async () => {
    const h = await harness({
      tenants: [
        { id: "ten_a", slug: "alpha" },
        { id: "ten_gone", slug: "gone", deleted_at: "2026-06-01T00:00:00Z" },
      ],
    });
    const r = await h.run();
    expect(r.considered).toBe(1);
    expect(h.rows()).toHaveLength(1);
  });

  // One tenant's broken read must not stop the other ninety-nine from being billed, and the failure
  // belongs in the REPORT rather than in a log nobody reads.
  it("records a throwing tenant as unbillable and CONTINUES the sweep", async () => {
    const h = await harness({
      tenants: [
        { id: "ten_bad", slug: "bad" },
        { id: "ten_ok", slug: "ok" },
      ],
      windows: { ten_bad: new Error("D1 exploded") },
    });
    const r = await h.run();
    expect(r.unbillable).toBe(1);
    expect(r.debited).toBe(1);
    expect(r.rows.find((x) => x.tenantId === "ten_bad")?.reason).toContain("D1 exploded");
    expect(h.rows()).toHaveLength(1);
  });

  // THE DISTINCTION THAT MUST SURVIVE THE SWEEP. Both write no row; they are different facts.
  it("keeps WITHIN and UNBILLABLE apart in the report", async () => {
    const h = await harness({
      tenants: [
        { id: "ten_small", slug: "small" },
        { id: "ten_blind", slug: "blind" },
      ],
      windows: {
        ten_small: window({ cost_micro_usd: 1000 }),
        ten_blind: window({ complete: false, reason: "no roll-up run assigned" }),
      },
    });
    const r = await h.run();
    expect(r.within).toBe(1);
    expect(r.unbillable).toBe(1);
    expect(r.debited).toBe(0);
    expect(h.rows()).toHaveLength(0);
    expect(r.rows.find((x) => x.tenantId === "ten_blind")?.reason).toContain("no roll-up run");
    // The within row carries NO reason: nothing went wrong for it.
    expect(r.rows.find((x) => x.tenantId === "ten_small")?.reason).toBeUndefined();
  });

  it("an UNSET allowance settles nothing and marks every tenant unbillable", async () => {
    const h = await harness({ tenants: [{ id: "ten_a", slug: "a" }, { id: "ten_b", slug: "b" }], allowance: null });
    const r = await h.run();
    expect(r.unbillable).toBe(2);
    expect(r.debited).toBe(0);
    expect(h.rows()).toHaveLength(0);
  });
});
