// The un-stubbable half of the credit core (cp#189): the SQL itself, against a REAL engine.
//
// WHY THIS FILE IS NOT OPTIONAL. Money guarantees in this design are DATABASE guarantees, not caller
// discipline: "one debit per hold, ever" is a unique index, "a failed job never produces a charge" is
// a WHERE clause, and "one capturer wins" is a conditional UPDATE's row count. None of those can be
// observed by a fake store, and this repo has already shipped a statement bug that 468 green tests
// and a live deploy missed (see the header of store-d1-sql.test.ts).
//
// So this instantiates the SHIPPED D1Store against real SQLite built from the REAL migrations, and
// every assertion below is about what the engine did, not what the caller intended.

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { MICRO_PER_USD, balanceFromSums } from "../src/credits";
import { D1Store } from "../src/store-d1";
import { d1Over, freshMigratedDb as freshDb } from "./sqlite-d1";

const USD = (n: number) => n * MICRO_PER_USD;
const T0 = "2026-07-27T10:00:00.000Z";
const T1 = "2026-07-27T11:00:00.000Z";

describe("credit ledger SQL", () => {
  let db: DatabaseSync;
  let store: D1Store;

  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  const purchase = (idem: string, micro: number) =>
    store.appendLedgerRow({
      id: `led_${idem}`,
      tenantId: "ten_1",
      kind: "purchase",
      deltaMicroUsd: micro,
      costMicroUsd: null,
      idemRef: idem,
      priceListId: null,
      externalRef: `ext_${idem}`,
      note: null,
      now: T0,
    });

  const hold = (jobRef: string, micro: number, expiresAt = "2026-07-27T12:00:00.000Z") =>
    store.takeHold({
      id: `hld_${jobRef}`,
      tenantId: "ten_1",
      jobRef,
      amountMicroUsd: micro,
      priceListId: "pl_v1",
      now: T0,
      expiresAt,
    });

  beforeEach(async () => {
    db = freshDb();
    store = new D1Store(d1Over(db));
    await store.createAccount("acct_1", "a@b.com");
    await store.createTenant("ten_1", "credits-rehearsal", "acct_1", "live");
  });

  // ---- idempotency -------------------------------------------------------------------------

  it("a replayed append is a no-op, not a second charge", async () => {
    const first = await purchase("topup_1", USD(10));
    const replay = await purchase("topup_1", USD(10));

    expect(first.applied).toBe(true);
    expect(replay.applied).toBe(false);
    expect(replay.row.id).toBe(first.row.id);
    expect(count("credit_ledger")).toBe(1);
  });

  it("CONTROL: a DIFFERENT idem_ref does insert a second row", async () => {
    // Without this, the test above passes just as well against an insert path that never writes
    // anything. It proves the unique index is what stopped the replay.
    await purchase("topup_1", USD(10));
    await purchase("topup_2", USD(10));
    expect(count("credit_ledger")).toBe(2);
  });

  // ---- the sign constraint ------------------------------------------------------------------

  it("the database refuses a debit written with a positive sign", async () => {
    // A caller passing the wrong sign would PAY a tenant for rendering. The CHECK makes that
    // impossible rather than unlikely.
    await expect(
      store.appendLedgerRow({
        id: "led_bad",
        tenantId: "ten_1",
        kind: "debit",
        deltaMicroUsd: USD(4),
        costMicroUsd: null,
        idemRef: "bad_sign",
        priceListId: null,
        externalRef: null,
        note: null,
        now: T0,
      }),
    ).rejects.toThrow();
    expect(count("credit_ledger")).toBe(0);
  });

  it("CONTROL: the same row with the correct sign is accepted", async () => {
    const r = await store.appendLedgerRow({
      id: "led_ok",
      tenantId: "ten_1",
      kind: "debit",
      deltaMicroUsd: -USD(4),
      costMicroUsd: 914_000,
      idemRef: "good_sign",
      priceListId: "pl_v1",
      externalRef: null,
      note: null,
      now: T0,
    });
    expect(r.applied).toBe(true);
    expect(r.row.cost_micro_usd).toBe(914_000);
  });

  // ---- holds -------------------------------------------------------------------------------

  it("a retried submit reuses its hold instead of reserving twice", async () => {
    const first = await hold("film_1", USD(4));
    const retry = await hold("film_1", USD(4));

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.hold.id).toBe(first.hold.id);
    expect(count("credit_holds")).toBe(1);

    const sums = await store.readBalanceSums("ten_1");
    expect(sums.held).toBe(USD(4));
  });

  it("capture settles the hold into exactly one debit", async () => {
    await purchase("topup_1", USD(10));
    const h = await hold("film_1", USD(4));

    const res = await store.captureHold({
      holdId: h.hold.id,
      ledgerRowId: "led_debit_1",
      costMicroUsd: 914_000,
      note: null,
      now: T1,
    });

    expect(res.captured).toBe(true);
    const rows = await store.listLedger("ten_1", 10);
    const debits = rows.filter((r) => r.kind === "debit");
    expect(debits).toHaveLength(1);
    expect(debits[0].delta_micro_usd).toBe(-USD(4));
    expect(debits[0].hold_id).toBe(h.hold.id);
    // The hold id IS the idempotency reference. That is what makes one-debit-per-hold a database
    // guarantee rather than a promise about how callers behave.
    expect(debits[0].idem_ref).toBe(h.hold.id);

    const sums = await store.readBalanceSums("ten_1");
    expect(balanceFromSums({ ...sums, complete: true }).available_micro_usd).toBe(USD(6));
  });

  it("a second capture writes no second debit and reports it did not win", async () => {
    await purchase("topup_1", USD(10));
    const h = await hold("film_1", USD(4));
    await store.captureHold({ holdId: h.hold.id, ledgerRowId: "led_a", costMicroUsd: null, note: null, now: T1 });
    const again = await store.captureHold({ holdId: h.hold.id, ledgerRowId: "led_b", costMicroUsd: null, note: null, now: T1 });

    expect(again.captured).toBe(false);
    expect((await store.listLedger("ten_1", 10)).filter((r) => r.kind === "debit")).toHaveLength(1);
  });

  // ---- COMPLETED-ONLY BILLING, enforced in SQL ----------------------------------------------

  it("a RELEASED hold can never become a debit (completed-only billing, in the WHERE clause)", async () => {
    // THE ruling test. A failed render releases its hold; if a late or duplicated capture could then
    // charge for it, "you pay for films, not failures" would be false in exactly the case it exists
    // for. The INSERT requires status='captured', so the released hold yields no row to insert from.
    await purchase("topup_1", USD(10));
    const h = await hold("film_1", USD(4));

    const rel = await store.releaseHold(h.hold.id, T1);
    expect(rel.released).toBe(true);

    const late = await store.captureHold({
      holdId: h.hold.id,
      ledgerRowId: "led_late",
      costMicroUsd: 914_000,
      note: null,
      now: T1,
    });

    expect(late.captured).toBe(false);
    expect((await store.listLedger("ten_1", 10)).filter((r) => r.kind === "debit")).toHaveLength(0);
    // And the money came back: the failed job leaves the tenant exactly where they started.
    const sums = await store.readBalanceSums("ten_1");
    expect(balanceFromSums({ ...sums, complete: true }).available_micro_usd).toBe(USD(10));
  });

  it("CONTROL: the identical capture on a still-open hold DOES write the debit", async () => {
    // Proves the test above fails for the RELEASE, not because captureHold is inert.
    await purchase("topup_1", USD(10));
    const h = await hold("film_2", USD(4));
    const ok = await store.captureHold({ holdId: h.hold.id, ledgerRowId: "led_ok", costMicroUsd: null, note: null, now: T1 });
    expect(ok.captured).toBe(true);
    expect((await store.listLedger("ten_1", 10)).filter((r) => r.kind === "debit")).toHaveLength(1);
  });

  it("a second release reports it did not win", async () => {
    const h = await hold("film_1", USD(4));
    expect((await store.releaseHold(h.hold.id, T1)).released).toBe(true);
    expect((await store.releaseHold(h.hold.id, T1)).released).toBe(false);
  });

  // ---- expiry ------------------------------------------------------------------------------

  it("the sweep expires only past-due OPEN holds", async () => {
    const stale = await hold("film_stale", USD(1), "2026-07-27T09:00:00.000Z");
    const live = await hold("film_live", USD(2), "2026-07-27T23:00:00.000Z");
    const captured = await hold("film_done", USD(3), "2026-07-27T09:00:00.000Z");
    await store.captureHold({ holdId: captured.hold.id, ledgerRowId: "led_d", costMicroUsd: null, note: null, now: T0 });

    const swept = await store.expireHolds(T1);

    expect(swept).toBe(1);
    expect((await store.getHoldByJobRef("ten_1", "film_stale"))?.status).toBe("expired");
    // CONTROLS, both directions: an unexpired hold and an already-settled hold are untouched. A sweep
    // that flipped everything would pass a bare count assertion.
    expect((await store.getHoldByJobRef("ten_1", "film_live"))?.status).toBe("open");
    expect((await store.getHoldByJobRef("ten_1", "film_done"))?.status).toBe("captured");
    expect(stale.created && live.created).toBe(true);
  });

  it("an expired hold stops counting as held, so the money comes back", async () => {
    await purchase("topup_1", USD(10));
    await hold("film_gone", USD(4), "2026-07-27T09:00:00.000Z");
    expect((await store.readBalanceSums("ten_1")).held).toBe(USD(4));

    await store.expireHolds(T1);

    expect((await store.readBalanceSums("ten_1")).held).toBe(0);
  });

  // ---- the reconcile claim -----------------------------------------------------------------

  it("a normal capture leaves NO captured hold missing its debit", async () => {
    await purchase("topup_1", USD(10));
    const h = await hold("film_1", USD(4));
    await store.captureHold({ holdId: h.hold.id, ledgerRowId: "led_1", costMicroUsd: null, note: null, now: T1 });
    expect(await store.capturedHoldsMissingDebit(10)).toEqual([]);
  });

  it("CONTROL: a planted captured-without-debit hold IS found", async () => {
    // An empty result is only evidence if the query can return something. Plant the exact state the
    // reconcile exists to catch (a crash between settle and charge, which the batch should make
    // impossible) and prove the query sees it.
    db.prepare(
      `INSERT INTO credit_holds (id, tenant_id, job_ref, amount_micro_usd, status, price_list_id, created_at, expires_at, settled_at)
       VALUES ('hld_orphan', 'ten_1', 'film_orphan', 4000000, 'captured', 'pl_v1', '${T0}', '${T1}', '${T1}')`,
    ).run();
    const found = await store.capturedHoldsMissingDebit(10);
    expect(found.map((h) => h.id)).toEqual(["hld_orphan"]);
  });

  // ---- balance across a full cycle ----------------------------------------------------------

  it("purchase, hold, capture: the arithmetic survives a real round trip", async () => {
    await purchase("topup_1", USD(10));
    const a = await hold("film_1", USD(4));
    const b = await hold("film_2", USD(3));

    // Two in flight: 10 settled, 7 held, 3 available.
    let sums = await store.readBalanceSums("ten_1");
    expect(balanceFromSums({ ...sums, complete: true })).toMatchObject({
      settled_micro_usd: USD(10),
      held_micro_usd: USD(7),
      available_micro_usd: USD(3),
    });

    await store.captureHold({ holdId: a.hold.id, ledgerRowId: "led_a", costMicroUsd: 914_000, note: null, now: T1 });
    await store.releaseHold(b.hold.id, T1);

    // One completed (charged), one failed (not charged): 6 settled, nothing held, 6 available.
    sums = await store.readBalanceSums("ten_1");
    expect(balanceFromSums({ ...sums, complete: true })).toMatchObject({
      settled_micro_usd: USD(6),
      held_micro_usd: 0,
      available_micro_usd: USD(6),
    });
  });
});
