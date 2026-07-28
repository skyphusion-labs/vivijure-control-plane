// cp#195: writing (or honestly not writing) the periodic overage debit.
//
// decideOverageDebit is the judgement; this is the only place that judgement becomes money. Split
// deliberately: the decision is pure and testable against planted inputs, and the write is a thin
// layer whose entire job is to not add a way to be wrong.

import { decideOverageDebit, type MeterClass } from "./meter-debit";
import type { MeterWindow } from "./meter-window";

/** The slice of CreditStore this needs. Narrow on purpose: settlement appends, it never reads a
 *  balance and never touches a hold. */
export interface OverageLedger {
  appendLedgerRow(row: {
    id: string;
    tenantId: string;
    kind: "purchase" | "debit" | "refund" | "adjustment";
    deltaMicroUsd: number;
    costMicroUsd: number | null;
    idemRef: string;
    priceListId: string | null;
    externalRef: string | null;
    note: string | null;
    now: string;
  }): Promise<{ applied: boolean; row: { id: string } }>;
}

export type SettleOutcome =
  /** A new debit row was written. */
  | { outcome: "debited"; amountMicroUsd: number; idemRef: string; ledgerRowId: string }
  /**
   * The debit for this tenant, meter and period ALREADY existed, so nothing was written.
   *
   * A SUCCESS, and kept distinct from "debited" rather than folded into it. The store is idempotent
   * on (tenant_id, idem_ref) and documents that callers must treat applied=false as success, so
   * collapsing them would be safe for the ledger and wrong for the operator: a settlement run
   * reporting N fresh charges when it actually re-ran over N existing ones is a report that cannot
   * be used to answer "did this month settle twice".
   */
  | { outcome: "already_settled"; idemRef: string; ledgerRowId: string }
  /** Inside the allowance. No row, and nothing owed. A finished, correct answer. */
  | { outcome: "within"; usedMicroUsd: number; allowanceMicroUsd: number }
  /** We could not establish the usage. No row, and the period stays open for a better-informed run. */
  | { outcome: "unbillable"; reason: string };

/**
 * Settle one tenant, one meter class, one billing period.
 *
 * THE REFUSAL TO WRITE ON AN INCOMPLETE WINDOW IS THE POINT OF THIS FUNCTION, not a guard clause on
 * the way to the interesting part. A debit computed from a window we did not fully observe is a bill
 * computed from a partial reading, and the direction it fails in is always the same: the meter saw
 * less than happened, so the charge is lower than it should be, so the cost-recovery ratio reports
 * health while we absorb the difference. Nothing downstream can detect that, because a small number
 * and a correct number look identical once written.
 *
 * So the ONLY path to appendLedgerRow is through a decision that already established the window was
 * complete. There is no override, no force flag, and no second entry point: an operator who needs to
 * bill an incomplete period has to fix the meter or write an explicit adjustment, both of which are
 * visible acts.
 */
export async function settleMeterOverage(args: {
  ledger: OverageLedger;
  tenantId: string;
  meter: MeterClass;
  window: MeterWindow;
  usedMicroUsd: number;
  allowanceMicroUsd: number | null;
  periodKey: string;
  newId(): string;
  now(): string;
}): Promise<SettleOutcome> {
  const decision = decideOverageDebit({
    meter: args.meter,
    window: args.window,
    usedMicroUsd: args.usedMicroUsd,
    allowanceMicroUsd: args.allowanceMicroUsd,
    periodKey: args.periodKey,
  });

  if (decision.outcome === "unbillable") {
    return { outcome: "unbillable", reason: decision.reason };
  }
  if (decision.outcome === "within") {
    return {
      outcome: "within",
      usedMicroUsd: decision.usedMicroUsd,
      allowanceMicroUsd: decision.allowanceMicroUsd,
    };
  }

  const written = await args.ledger.appendLedgerRow({
    id: args.newId(),
    tenantId: args.tenantId,
    kind: "debit",
    // NEGATIVE: a debit reduces the balance. Same convention captureHold writes
    // (-h.amount_micro_usd), so the two ways money leaves a balance agree by construction rather
    // than by two authors happening to pick the same sign.
    deltaMicroUsd: -decision.amountMicroUsd,
    // What it cost US: the FULL window usage, not the charged overage. The gap between the two IS
    // the allowance we absorbed, and it has to stay visible in the record.
    costMicroUsd: decision.costMicroUsd,
    idemRef: decision.idemRef,
    // No price list: this is metered pass-through of a measured cost, not a rated line item. A
    // fabricated price-list id would claim a rating decision nobody made.
    priceListId: null,
    externalRef: null,
    note: decision.note,
    now: args.now(),
  });

  return written.applied
    ? {
        outcome: "debited",
        amountMicroUsd: decision.amountMicroUsd,
        idemRef: decision.idemRef,
        ledgerRowId: written.row.id,
      }
    : { outcome: "already_settled", idemRef: decision.idemRef, ledgerRowId: written.row.id };
}
