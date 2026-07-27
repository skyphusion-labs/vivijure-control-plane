// Projection edge cases (cp#192) that are awkward to force through SQL: feed truncation, the two
// distinct no-charge reasons, ordering ties, and the ratio's refusal to be computed dishonestly.
// The end-to-end behaviour is proven through the real router over a real engine in
// credits-routes.test.ts; this file covers the corners that test cannot reach cheaply.

import { describe, expect, it } from "vitest";

import { MICRO_PER_USD, balanceFromSums, type HoldRow, type LedgerRow } from "../src/credits";
import { buildAdminCreditView, buildTenantCreditView } from "../src/credits-api";

const USD = (n: number) => n * MICRO_PER_USD;
const BAL = balanceFromSums({ settled: USD(10), held: 0, complete: true });

const ledgerRow = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  id: "led_1", tenant_id: "ten_1", kind: "debit", delta_micro_usd: -USD(4), cost_micro_usd: USD(2),
  idem_ref: "hld_1", hold_id: "hld_1", price_list_id: "pl_v1", external_ref: null, note: null,
  created_at: "2026-07-27T10:00:00.000Z", ...over,
});

const holdRow = (over: Partial<HoldRow> = {}): HoldRow => ({
  id: "hld_1", tenant_id: "ten_1", job_ref: "film_1", amount_micro_usd: USD(4), status: "open",
  price_list_id: "pl_v1", created_at: "2026-07-27T10:00:00.000Z",
  expires_at: "2026-07-27T23:00:00.000Z", settled_at: null, ...over,
});

const view = (ledger: LedgerRow[], holds: HoldRow[], truncated = false) =>
  buildTenantCreditView({ balance: BAL, ledger, holds, enforcing: false, truncated });

describe("activity projection", () => {
  it("an EXPIRED hold and a RELEASED hold give different reasons", () => {
    // Both cost the tenant nothing, but they are different facts: one job failed, the other never
    // reported back at all. Collapsing them would tell someone their render failed when it vanished.
    const lines = view([], [
      holdRow({ id: "hld_a", job_ref: "film_a", status: "released", settled_at: "2026-07-27T11:00:00.000Z" }),
      holdRow({ id: "hld_b", job_ref: "film_b", status: "expired", settled_at: "2026-07-27T12:00:00.000Z" }),
    ]).activity;

    expect(lines.find((l) => l.job_ref === "film_a")?.no_charge_reason).toContain("did not complete");
    expect(lines.find((l) => l.job_ref === "film_b")?.no_charge_reason).toContain("never reported back");
  });

  it("an OPEN hold reads as reserved and moves no money", () => {
    const [line] = view([], [holdRow()]).activity;
    expect(line).toMatchObject({ kind: "reserved", delta_micro_usd: 0, job_ref: "film_1" });
  });

  it("a CAPTURED hold is not double-lined beside its own debit", () => {
    const lines = view([ledgerRow()], [holdRow({ status: "captured", settled_at: "2026-07-27T11:00:00.000Z" })]).activity;
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe("charge");
  });

  it("CONTROL: the same hold NOT captured does produce its own line", () => {
    // Without this, the test above passes against a projection that drops every hold.
    expect(view([ledgerRow()], [holdRow({ status: "released" })]).activity).toHaveLength(2);
  });

  it("orders newest first with a total tie-break, so a page boundary cannot drop or repeat a line", () => {
    const same = "2026-07-27T10:00:00.000Z";
    const lines = view(
      [ledgerRow({ id: "led_a", created_at: same }), ledgerRow({ id: "led_b", created_at: same, idem_ref: "x", hold_id: null })],
      [],
    ).activity;
    expect(lines.map((l) => l.id)).toEqual(["led_b", "led_a"]);
  });

  it("truncation is its own flag and does NOT make the balance incomplete", () => {
    // complete is about the AGGREGATES (SQL SUMs over every row). Feed truncation is normal on any
    // active tenant; folding them together would make complete false constantly and train everyone
    // to ignore the one warning that matters.
    const v = view([ledgerRow()], [], true);
    expect(v.activity_truncated).toBe(true);
    expect(v.complete).toBe(true);
  });
});

describe("the operator ratio", () => {
  const admin = (ledger: LedgerRow[]) =>
    buildAdminCreditView({ balance: BAL, ledger, holds: [], enforcing: false, truncated: false });

  it("computes price over cost when cost is known", () => {
    expect(admin([ledgerRow({ delta_micro_usd: -USD(4), cost_micro_usd: USD(2) })]).price_to_cost).toBe(2);
  });

  it("compares price only against the rows whose cost we KNOW", () => {
    // Summing every price over a partial cost total would inflate the ratio by exactly the rows we
    // could not measure, making cost recovery look strongest where it is least supported.
    const v = admin([
      ledgerRow({ id: "led_a", delta_micro_usd: -USD(4), cost_micro_usd: USD(2) }),
      ledgerRow({ id: "led_b", delta_micro_usd: -USD(6), cost_micro_usd: null }),
    ]);
    expect(v.price_to_cost).toBe(2);
    expect(v.charges_missing_cost).toBe(1);
  });

  it("is NULL rather than Infinity when the measured cost is zero", () => {
    expect(admin([ledgerRow({ cost_micro_usd: 0 })]).price_to_cost).toBeNull();
  });

  it("ignores purchases: a top-up is not a priced job", () => {
    const v = admin([ledgerRow({ id: "led_p", kind: "purchase", delta_micro_usd: USD(10), cost_micro_usd: null })]);
    expect(v.price_to_cost).toBeNull();
    expect(v.charges_missing_cost).toBe(0);
  });
});
