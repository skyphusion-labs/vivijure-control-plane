// cp#195: the billing period key, DERIVED.
//
// mackaye's constraint, and the reason this file is pure arithmetic with no storage: the key must be
// DERIVABLE rather than stored-and-hoped-for. overageIdemRef builds the ledger's idempotency
// reference out of it, so the same period must produce the same key on every retry, forever. A key
// that were generated once and stored would mean a retry that could not find the stored row mints a
// NEW key and charges the tenant twice, which is the one failure mode idempotency exists to remove.
//
// Calendar month, UTC, half-open. Proposed to joan (cp#219) as the statement surface's convention
// before it was written; UTC is not a default of convenience:
//   - a tenant-local month puts the SAME INSTANT in two different periods for two tenants, so one
//     gateway log row would belong to July for one and August for another;
//   - a tenant who changes timezone gets a period that overlaps or skips its neighbour, and a
//     skipped period is money nobody ever bills.
// Displaying a local month is a presentation concern and belongs on top of this, never inside the
// idempotency reference.

/** A closed billing period: the key, and the window the meters are read over. */
export interface BillingPeriod {
  /** e.g. "2026-07". The idempotency reference is built from this. */
  key: string;
  /** ISO, INCLUSIVE. */
  windowStart: string;
  /** ISO, EXCLUSIVE, so consecutive periods partition rather than double-count the boundary. */
  windowEnd: string;
}

const pad = (n: number): string => String(n).padStart(2, "0");
/**
 * The year is padded to FOUR digits so the generator and parseBillingPeriodKey's `\d{4}` agree.
 *
 * Found by writing the positive control for the round-trip check, not by review: without it a year
 * below 1000 generates a three-digit key the parser would then refuse, so a key this module emitted
 * could not be fed back to it. No real billing period is affected, and that is precisely why an
 * inconsistency like this survives unless something asserts the round trip in both directions.
 */
const pad4 = (n: number): string => String(n).padStart(4, "0");

/** The UTC calendar month containing `at`. Pure. */
export function billingPeriodContaining(at: Date): BillingPeriod {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth(); // 0-based
  const start = new Date(Date.UTC(y, m, 1));
  // Month + 1 with a 0-based index rolls the year over on its own (Date.UTC(2026, 12, 1) is
  // 2027-01-01), so December needs no special case and there is no branch to get wrong.
  const end = new Date(Date.UTC(y, m + 1, 1));
  return {
    key: `${pad4(y)}-${pad(m + 1)}`,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
  };
}

/**
 * The most recent period that has fully ELAPSED as of `now`.
 *
 * THE ONE A SETTLEMENT RUN WANTS, and the reason it is a named function rather than a subtraction at
 * the call site. Settling the CURRENT period would read a window that is still accumulating: the
 * debit would be computed from a partial month, and because it is idempotent on the period key, the
 * later, larger, correct figure could never replace it. One early settlement would permanently
 * under-bill that month with nothing anywhere to show it happened.
 */
export function lastClosedBillingPeriod(now: Date): BillingPeriod {
  const current = billingPeriodContaining(now);
  // One millisecond before this period opened is inside the previous one, whatever its length.
  return billingPeriodContaining(new Date(Date.parse(current.windowStart) - 1));
}

/** Parse an operator-supplied "YYYY-MM", or null. Refuses anything it cannot round-trip. */
export function parseBillingPeriodKey(key: string): BillingPeriod | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key?.trim() ?? "");
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const period = billingPeriodContaining(new Date(Date.UTC(year, month - 1, 1)));
  // ROUND-TRIP CHECK, not decoration: it is the only thing that catches a key the regex accepts but
  // the arithmetic disagrees with. Without it a caller could settle a period whose key does not
  // match the window it was billed over, and the idempotency reference would then be a lie.
  return period.key === key.trim() ? period : null;
}
