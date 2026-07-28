// cp#195: the billing period key.
//
// This file is short and the assertions look obvious. They are here because the key is the
// idempotency reference: if it is not reproducible, `credit_ledger`'s (tenant_id, idem_ref)
// uniqueness stops meaning "one debit per period" and a retry charges twice. Obvious arithmetic that
// money depends on still gets pinned.

import { describe, it, expect } from "vitest";
import {
  billingPeriodContaining,
  lastClosedBillingPeriod,
  parseBillingPeriodKey,
} from "../src/meter-period";

describe("billingPeriodContaining", () => {
  it("is the UTC calendar month, half-open", () => {
    expect(billingPeriodContaining(new Date("2026-07-15T12:00:00Z"))).toEqual({
      key: "2026-07",
      windowStart: "2026-07-01T00:00:00.000Z",
      windowEnd: "2026-08-01T00:00:00.000Z",
    });
  });

  // The boundary belongs to the period it OPENS, never the one it closes, or a period boundary is
  // billed twice.
  it("puts an instant exactly on a boundary in the period it OPENS", () => {
    expect(billingPeriodContaining(new Date("2026-07-01T00:00:00.000Z")).key).toBe("2026-07");
    expect(billingPeriodContaining(new Date("2026-08-01T00:00:00.000Z")).key).toBe("2026-08");
    expect(billingPeriodContaining(new Date("2026-07-31T23:59:59.999Z")).key).toBe("2026-07");
  });

  // Month + 1 on a 0-based index rolls the year itself, so December has no special case. Pinned
  // because "December is fine, it just works" is exactly the claim that turns out to be false.
  it("rolls the YEAR over at December with no special case", () => {
    expect(billingPeriodContaining(new Date("2026-12-09T00:00:00Z"))).toEqual({
      key: "2026-12",
      windowStart: "2026-12-01T00:00:00.000Z",
      windowEnd: "2027-01-01T00:00:00.000Z",
    });
  });

  it("is DETERMINISTIC: any instant in a month yields the identical key and window", () => {
    const days = ["01T00:00:00.000Z", "02T03:04:05.006Z", "17T23:00:00.000Z", "28T11:11:11.111Z"];
    const all = days.map((d) => JSON.stringify(billingPeriodContaining(new Date("2026-02-" + d))));
    expect(new Set(all).size).toBe(1);
  });

  // UTC, not local. A tenant-local month would put the SAME INSTANT in two different periods for two
  // tenants. This asserts the boundary is UTC midnight regardless of the host's timezone.
  it("uses UTC, so a late-evening local instant does not slip a month", () => {
    // 2026-07-31T22:30Z is still July in UTC and would be August in, say, UTC+3.
    expect(billingPeriodContaining(new Date("2026-07-31T22:30:00Z")).key).toBe("2026-07");
  });

  it("handles a leap February correctly on both ends", () => {
    const p = billingPeriodContaining(new Date("2028-02-29T12:00:00Z"));
    expect(p.key).toBe("2028-02");
    expect(p.windowEnd).toBe("2028-03-01T00:00:00.000Z");
  });
});

describe("lastClosedBillingPeriod", () => {
  // THE ONE THAT MATTERS. Settling the CURRENT period reads a window still accumulating: the debit
  // is computed from a partial month and, because it is idempotent on the key, the later correct
  // figure can never replace it. One early settlement permanently under-bills that month.
  it("returns the PREVIOUS month, never the one still accumulating", () => {
    expect(lastClosedBillingPeriod(new Date("2026-07-15T12:00:00Z")).key).toBe("2026-06");
    expect(lastClosedBillingPeriod(new Date("2026-07-31T23:59:59.999Z")).key).toBe("2026-06");
  });

  it("flips the instant the new month opens, and rolls the year backward at January", () => {
    expect(lastClosedBillingPeriod(new Date("2026-08-01T00:00:00.000Z")).key).toBe("2026-07");
    expect(lastClosedBillingPeriod(new Date("2027-01-01T00:00:00.000Z")).key).toBe("2026-12");
  });

  it("its window is fully in the past relative to now", () => {
    const now = new Date("2026-07-15T12:00:00Z");
    const p = lastClosedBillingPeriod(now);
    expect(Date.parse(p.windowEnd)).toBeLessThanOrEqual(now.getTime());
  });
});

describe("parseBillingPeriodKey", () => {
  it("CONTROL: a well-formed key round-trips to its own window", () => {
    expect(parseBillingPeriodKey("2026-07")).toEqual({
      key: "2026-07",
      windowStart: "2026-07-01T00:00:00.000Z",
      windowEnd: "2026-08-01T00:00:00.000Z",
    });
    expect(parseBillingPeriodKey(" 2026-12 ")?.key).toBe("2026-12");
  });

  // An operator-supplied key becomes an idempotency reference. A key the parser accepts but whose
  // window disagrees with it would make that reference a lie, so anything that cannot round-trip is
  // refused rather than normalised into something adjacent.
  it("REFUSES anything it cannot round-trip", () => {
    for (const bad of [
      "2026-7", "2026-13", "2026-00", "26-07", "2026/07", "2026-07-01", "", "july", "2026",
    ]) {
      expect(parseBillingPeriodKey(bad), bad).toBeNull();
    }
  });

  // THE CASE ONLY THE ROUND-TRIP CHECK CAN SEE, and the reason it is not decoration.
  //
  // Date.UTC maps a year of 0..99 to 1900+year: Date.UTC(26, 6, 1) is 1926-07-01, not 0026-07-01.
  // So a zero-padded four-digit year passes the regex AND the month range and then silently
  // produces a window for a completely different century. Without the round-trip check
  // parseBillingPeriodKey("0026-07") returns a period keyed "1926-07", and since that key becomes
  // the ledger's idempotency reference, an operator would settle one period under another period's
  // identity. Every other bad input above is caught by the regex, so this is the only assertion
  // that makes the check load-bearing.
  it("REFUSES a year JavaScript would silently remap to the 1900s", () => {
    expect(parseBillingPeriodKey("0026-07")).toBeNull();
    expect(parseBillingPeriodKey("0099-01")).toBeNull();
    // CONTROL: a four-digit year Date.UTC does NOT remap still parses, so the guard is about the
    // remapping and not about rejecting small years for their own sake.
    expect(parseBillingPeriodKey("0100-01")?.key).toBe("0100-01");
  });
});
