// cp#195: settlement, against a REAL ledger built from the REAL migrations.
//
// Idempotency lives in credit_ledger's unique index, and the sign convention lives in the schema, so
// both are proven against a real SQL engine rather than a double that would agree with whatever the
// code did.
//
// THE FIRST-CLASS ASSERTION HERE (mackaye, 2026-07-28): the refusal to debit on complete:false is
// tested as a behaviour, not as a guard clause. A debit computed from a window we did not fully
// observe is a bill computed from a partial reading, and it fails in one direction only -- we
// under-charge, and the cost-recovery ratio reports health while we absorb the difference. Nothing
// downstream can catch it, because a small number and a correct number look identical once written.

import { describe, it, expect } from "vitest";
import { d1Over, freshMigratedDb } from "./sqlite-d1";
import { D1Store } from "../src/store-d1";
import { settleMeterOverage } from "../src/meter-settle";
import type { MeterWindow } from "../src/meter-window";

const complete: MeterWindow = {
  window_start: "2026-07-01T00:00:00.000Z",
  window_end: "2026-08-01T00:00:00.000Z",
  complete: true,
  reason: null,
};
const incomplete: MeterWindow = { ...complete, complete: false, reason: "a retention GAP" };

/**
 * The tenant rows the ledger hangs off must REALLY EXIST: credit_ledger.tenant_id carries a foreign
 * key to tenants(id). Seeding them is not test scaffolding, it is the reason this suite runs against
 * a real engine at all -- the first draft of this file omitted them and a mocked store would have
 * accepted every write without a word.
 */
async function harness() {
  const db = freshMigratedDb();
  const store = new D1Store(d1Over(db));
  await store.createAccount("acct_1", "a@b.com");
  await store.createTenant("ten_abc", "acme", "acct_1", "live");
  await store.createTenant("ten_xyz", "other", "acct_1", "live");
  let n = 0;
  const settle = (over: Partial<Parameters<typeof settleMeterOverage>[0]> = {}) =>
    settleMeterOverage({
      ledger: store,
      tenantId: "ten_abc",
      meter: "llm",
      window: complete,
      usedMicroUsd: 620_000,
      allowanceMicroUsd: 520_000,
      periodKey: "2026-07",
      newId: () => "led_" + ++n,
      now: () => "2026-08-01T00:05:00.000Z",
      ...over,
    });
  const rows = () =>
    db.prepare("SELECT * FROM credit_ledger ORDER BY id").all() as Array<Record<string, unknown>>;
  return { db, store, settle, rows };
}

describe("settleMeterOverage writes money", () => {
  it("CONTROL: an over-allowance window writes ONE debit for the difference", async () => {
    const h = await harness();
    const out = await h.settle();
    expect(out.outcome).toBe("debited");
    const rows = h.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("debit");
    expect(rows[0].idem_ref).toBe("overage:llm:2026-07");
    // NEGATIVE delta: a debit reduces the balance, same convention captureHold writes.
    expect(rows[0].delta_micro_usd).toBe(-100_000);
    // Cost is the FULL usage, not the charged overage. The gap IS the allowance we absorbed, and it
    // has to stay visible or the cost-recovery ratio flatters us.
    expect(rows[0].cost_micro_usd).toBe(620_000);
    // No fabricated rating decision.
    expect(rows[0].price_list_id).toBeNull();
  });

  // credit_ledger is idempotent on (tenant_id, idem_ref). A settlement run that is retried, or that
  // overlaps its own next tick, must not charge twice.
  it("a retried settlement writes NOTHING new and reports already_settled", async () => {
    const h = await harness();
    expect((await h.settle()).outcome).toBe("debited");
    const again = await h.settle();
    expect(again.outcome).toBe("already_settled");
    expect(h.rows()).toHaveLength(1);
    // ...and the second call points at the SAME row, so a caller can reconcile rather than guess.
    if (again.outcome !== "already_settled") throw new Error("unreachable");
    expect(again.ledgerRowId).toBe(h.rows()[0].id);
  });

  // CONTROL for the above: the idempotency is per tenant AND per period AND per meter class, not a
  // blanket "one debit ever". Without this, a store that refused every second write would pass.
  it("a different period, tenant or meter class still settles", async () => {
    const h = await harness();
    await h.settle();
    expect((await h.settle({ periodKey: "2026-08" })).outcome).toBe("debited");
    expect((await h.settle({ tenantId: "ten_xyz" })).outcome).toBe("debited");
    expect((await h.settle({ meter: "r2_storage" })).outcome).toBe("debited");
    expect(h.rows()).toHaveLength(4);
  });
});

describe("settleMeterOverage refuses to write", () => {
  // THE FIRST-CLASS PATH. No row, no partial row, no zero row.
  it("an INCOMPLETE window writes NO ledger row at all", async () => {
    const h = await harness();
    const out = await h.settle({ window: incomplete });
    expect(out.outcome).toBe("unbillable");
    expect(h.rows()).toHaveLength(0);
    if (out.outcome !== "unbillable") throw new Error("unreachable");
    expect(out.reason).toContain("retention GAP");
  });

  // The refusal must not POISON the period. Once the meter catches up and the window is complete,
  // the same period settles normally -- a refusal defers billing, it does not forfeit it.
  it("a refused period still settles later once the window is complete", async () => {
    const h = await harness();
    expect((await h.settle({ window: incomplete })).outcome).toBe("unbillable");
    expect(h.rows()).toHaveLength(0);
    expect((await h.settle({ window: complete })).outcome).toBe("debited");
    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0].delta_micro_usd).toBe(-100_000);
  });

  it("a within-allowance window writes NO row, and that is a finished answer", async () => {
    const h = await harness();
    const out = await h.settle({ usedMicroUsd: 1000 });
    expect(out.outcome).toBe("within");
    expect(h.rows()).toHaveLength(0);
  });

  it("an UNSET allowance writes no row and reports unbillable, never a full-usage debit", async () => {
    const h = await harness();
    const out = await h.settle({ allowanceMicroUsd: null, usedMicroUsd: 620_000 });
    expect(out.outcome).toBe("unbillable");
    expect(h.rows()).toHaveLength(0);
  });

  // There is deliberately no override, no force flag and no second entry point, so an incomplete
  // window cannot be billed by any path through this module. This asserts the property rather than
  // trusting the reading: every refusal shape leaves the ledger empty.
  it("NO input shape reaches the ledger through a refusal", async () => {
    const h = await harness();
    for (const over of [
      { window: incomplete },
      { window: { ...complete, complete: undefined as unknown as boolean } },
      { allowanceMicroUsd: null },
      { allowanceMicroUsd: -1 },
      { allowanceMicroUsd: 1.5 },
      { usedMicroUsd: -1 },
      { usedMicroUsd: NaN },
    ]) {
      await h.settle(over);
    }
    expect(h.rows()).toHaveLength(0);
    // POSITIVE CONTROL: the very same harness DOES write when the inputs are sound, so the empty
    // ledger above is refusal and not a broken insert.
    expect((await h.settle()).outcome).toBe("debited");
    expect(h.rows()).toHaveLength(1);
  });
});
