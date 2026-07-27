// The credit READ surface (cp#192, under cp#173): what a tenant sees, and what an operator sees.
//
// PURE. Every function here takes rows and returns a projection. The reads are the caller's job, for
// the same reason tenant-r2-usage.ts splits them: the part that can be SILENTLY wrong is the
// projection, so the projection is what lives under the unit gate.
//
// WHAT THIS SURFACE IS FOR, and it is not "showing a number". A prepaid tenant who cannot tell what
// they have left, or why a render was refused, does not have the easy access this product exists to
// give them. Two things follow, and they shape every field below:
//
//   1. Money is sent as INTEGER micro-USD and formatted at the edge. Never a pre-formatted string
//      from the server -- a formatted number cannot be compared, summed, or re-rendered in another
//      currency, and rounding at the source is how a balance and its statement come to disagree.
//   2. The completed-only policy is made LEGIBLE rather than merely true. A tenant who sees a failed
//      render sitting at no charge learns the policy without reading a pricing page, which is worth
//      more than any sentence we could write on one.

import type { Balance, HoldRow, LedgerRow, MicroUsd } from "./credits";

/** How an activity line came to be. An enum so the UI writes copy per case, never parses prose. */
export type ActivityKind =
  | "purchase"
  | "charge"
  /** A job that did not complete. Completed-only billing: no charge, and the reservation came back. */
  | "no_charge_failed"
  /** A reservation for a job still in flight. Not yet money. */
  | "reserved"
  | "refund"
  | "adjustment";

export interface ActivityLine {
  id: string;
  kind: ActivityKind;
  /** Signed micro-USD for money that MOVED; 0 for a line that reserved or released nothing. */
  delta_micro_usd: MicroUsd;
  /** Present on reservations and on lines derived from a hold, so a tenant can match it to a job. */
  job_ref: string | null;
  occurred_at: string;
  /**
   * Why this line cost nothing, when it cost nothing. NULL on lines that did move money.
   *
   * This exists because "no charge" with no reason reads as a bug to the person looking at it. It is
   * the differentiator rendered as a fact about THEIR job rather than as a marketing claim.
   */
  no_charge_reason: string | null;
}

export interface TenantCreditView {
  settled_micro_usd: MicroUsd;
  held_micro_usd: MicroUsd;
  available_micro_usd: MicroUsd;
  /** False when any aggregate came from an incomplete read. A total that might be partial says so. */
  complete: boolean;
  /**
   * Whether refusals are actually in force. Reported because a ledger that is recording and NOT
   * enforcing looks exactly like one that is, and that ambiguity is how an operator learns the truth
   * from a bill instead of from a surface.
   */
  enforcing: boolean;
  activity: ActivityLine[];
  /**
   * True when the activity feed hit its limit and older lines exist.
   *
   * SEPARATE from `complete`, deliberately. `complete` is about the AGGREGATES: it answers "is this
   * balance the whole balance". Feed truncation is normal and expected on any active tenant and says
   * nothing about the totals, which are SQL SUMs over every row. Folding the two together would make
   * `complete` false on every busy tenant and train everyone to ignore it, which is exactly how a
   * real incomplete-read warning gets missed.
   */
  activity_truncated: boolean;
}

export interface AdminCreditView extends TenantCreditView {
  /** Summed measured cost, over the rows where cost is KNOWN. */
  cost_known_micro_usd: MicroUsd;
  /** How many charge rows carry no measured cost. The reason the ratio below can be null. */
  charges_missing_cost: number;
  /**
   * Price over cost, or NULL when it cannot honestly be computed.
   *
   * NULL WHEN COST IS UNKNOWN OR ZERO, never a fabricated 1.0 and never Infinity. This number is the
   * evidence for "priced to cover costs", so a ratio computed over a partial cost basis would make
   * the claim look strongest exactly when it is least supported.
   */
  price_to_cost: number | null;
}

/**
 * Build the tenant's view.
 *
 * HOLDS ARE PROJECTED ALONGSIDE LEDGER ROWS, and that is the whole reason this function takes both.
 * A failed job leaves a RELEASED hold and no ledger row at all, so a statement built from money rows
 * alone would show a tenant nothing where their failed render should be -- silence that reads as a
 * missing record rather than as a deliberate non-charge.
 */
export function buildTenantCreditView(args: {
  balance: Balance;
  ledger: LedgerRow[];
  holds: HoldRow[];
  enforcing: boolean;
  /** True when either underlying list was read at its limit. */
  truncated: boolean;
}): TenantCreditView {
  const activity: ActivityLine[] = [];

  for (const row of args.ledger) {
    activity.push({
      id: row.id,
      kind:
        row.kind === "debit"
          ? "charge"
          : row.kind === "purchase"
            ? "purchase"
            : row.kind === "refund"
              ? "refund"
              : "adjustment",
      delta_micro_usd: row.delta_micro_usd,
      job_ref: null,
      occurred_at: row.created_at,
      no_charge_reason: null,
    });
  }

  for (const hold of args.holds) {
    // A CAPTURED hold already has its debit in the ledger above. Emitting it again would double the
    // line and, worse, imply a second charge.
    if (hold.status === "captured") continue;
    if (hold.status === "open") {
      activity.push({
        id: hold.id,
        kind: "reserved",
        delta_micro_usd: 0,
        job_ref: hold.job_ref,
        occurred_at: hold.created_at,
        no_charge_reason: null,
      });
      continue;
    }
    // released | expired: the job did not complete, so completed-only billing means no charge.
    activity.push({
      id: hold.id,
      kind: "no_charge_failed",
      delta_micro_usd: 0,
      job_ref: hold.job_ref,
      occurred_at: hold.settled_at ?? hold.created_at,
      no_charge_reason:
        hold.status === "expired"
          ? "this job never reported back, so the reservation was returned and you were not charged"
          : "this job did not complete, so you were not charged for it",
    });
  }

  // Newest first. Ties break on id so the order is total and a page boundary cannot drop or repeat a
  // line; two rows sharing a timestamp is normal (a capture writes both a settle and a debit).
  activity.sort((a, b) => (a.occurred_at === b.occurred_at ? (a.id < b.id ? 1 : -1) : a.occurred_at < b.occurred_at ? 1 : -1));

  return {
    settled_micro_usd: args.balance.settled_micro_usd,
    held_micro_usd: args.balance.held_micro_usd,
    available_micro_usd: args.balance.available_micro_usd,
    complete: args.balance.complete,
    enforcing: args.enforcing,
    activity,
    activity_truncated: args.truncated,
  };
}

/** Build the operator's view: the tenant's, plus the cost side that makes cost recovery checkable. */
export function buildAdminCreditView(args: {
  balance: Balance;
  ledger: LedgerRow[];
  holds: HoldRow[];
  enforcing: boolean;
  truncated: boolean;
}): AdminCreditView {
  const base = buildTenantCreditView(args);

  let costKnown = 0;
  let priceOnKnownCost = 0;
  let missing = 0;
  for (const row of args.ledger) {
    if (row.kind !== "debit") continue;
    if (row.cost_micro_usd === null) {
      missing++;
      continue;
    }
    costKnown += row.cost_micro_usd;
    // Price is compared only against the rows whose cost we KNOW. Summing all prices over a partial
    // cost total would inflate the ratio by exactly the rows we could not measure.
    priceOnKnownCost += Math.abs(row.delta_micro_usd);
  }

  return {
    ...base,
    cost_known_micro_usd: costKnown,
    charges_missing_cost: missing,
    price_to_cost: costKnown > 0 ? priceOnKnownCost / costKnown : null,
  };
}
