// The pure half of the credit core (cp#189): balance arithmetic and the submit decision.
//
// No store, real or fake, appears in this file. That is deliberate and is argued in the CreditStore
// doc comment: a hand-written fake ledger would let money behaviour be "proven" against something
// that shares none of the real failure modes. Here we test decisions with plain data; the SQL half is
// proven against a real engine in credits-sql.test.ts.

import { describe, expect, it } from "vitest";

import {
  MICRO_PER_USD,
  balanceFromSums,
  computeBalance,
  decideSubmit,
  formatUsd,
  parseEnforcing,
  parseMicroUsd,
} from "../src/credits";

const complete = (settled: number, held: number) => balanceFromSums({ settled, held, complete: true });

describe("balance arithmetic", () => {
  it("available is settled minus open holds", () => {
    const b = complete(10 * MICRO_PER_USD, 4 * MICRO_PER_USD);
    expect(b.available_micro_usd).toBe(6 * MICRO_PER_USD);
  });

  it("computeBalance and balanceFromSums cannot disagree (one arithmetic, two entry points)", () => {
    const rows = [{ delta_micro_usd: 10 * MICRO_PER_USD }, { delta_micro_usd: -3 * MICRO_PER_USD }];
    const holds = [{ amount_micro_usd: 2 * MICRO_PER_USD }];
    const fromRows = computeBalance({ ledger: rows, openHolds: holds, complete: true });
    const fromSums = complete(7 * MICRO_PER_USD, 2 * MICRO_PER_USD);
    expect(fromRows).toEqual(fromSums);
  });

  it("carries incompleteness through rather than dropping it", () => {
    expect(computeBalance({ ledger: [], openHolds: [], complete: false }).complete).toBe(false);
  });

  it("a negative balance is representable, not clamped", () => {
    // Clamping at zero would hide an overshoot instead of showing it. The design accepts a bounded
    // negative (a metered class can land after the fact); it does not accept lying about one.
    expect(complete(-5 * MICRO_PER_USD, 0).available_micro_usd).toBe(-5 * MICRO_PER_USD);
  });
});

describe("the submit gate", () => {
  it("allows when available covers the price", () => {
    const v = decideSubmit({ balance: complete(5 * MICRO_PER_USD, 0), required_micro_usd: 4 * MICRO_PER_USD, enforcing: true });
    expect(v.ok).toBe(true);
  });

  it("allows at exactly the price (the boundary is inclusive)", () => {
    const v = decideSubmit({ balance: complete(4 * MICRO_PER_USD, 0), required_micro_usd: 4 * MICRO_PER_USD, enforcing: true });
    expect(v.ok).toBe(true);
  });

  it("refuses one micro-USD short, and says both real numbers", () => {
    const v = decideSubmit({
      balance: complete(4 * MICRO_PER_USD - 1, 0),
      required_micro_usd: 4 * MICRO_PER_USD,
      enforcing: true,
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("insufficient_credit");
    expect(v.available_micro_usd).toBe(4 * MICRO_PER_USD - 1);
    expect(v.required_micro_usd).toBe(4 * MICRO_PER_USD);
    // The honest-deny rule: the message carries the numbers, not a euphemism.
    expect(v.message).toContain("USD 4.00");
    expect(v.message).not.toMatch(/something went wrong/i);
  });

  it("refuses when an OPEN HOLD is what makes it unaffordable", () => {
    // This is the case that exists only because billing is completed-only. Settled balance alone
    // would say yes; the reservation for an in-flight job is what makes the honest answer no.
    const v = decideSubmit({
      balance: complete(10 * MICRO_PER_USD, 8 * MICRO_PER_USD),
      required_micro_usd: 4 * MICRO_PER_USD,
      enforcing: true,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.available_micro_usd).toBe(2 * MICRO_PER_USD);
  });

  it("refuses on an INCOMPLETE balance read, and reports available as null rather than 0", () => {
    // Money code refuses on unknown. Reporting 0 here would be the same defect as a failed bucket
    // read counted as an empty bucket: an unknown wearing a number's clothes.
    const v = decideSubmit({
      balance: balanceFromSums({ settled: 999 * MICRO_PER_USD, held: 0, complete: false }),
      required_micro_usd: 1,
      enforcing: true,
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("balance_unknown");
    expect(v.available_micro_usd).toBeNull();
  });

  it("counting mode records and refuses NOTHING, and says so on the verdict", () => {
    const v = decideSubmit({ balance: complete(0, 0), required_micro_usd: 999 * MICRO_PER_USD, enforcing: false });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.enforcing).toBe(false);
  });

  it("CONTROL: the same input enforcing DOES refuse, so counting mode is the reason and not a broken gate", () => {
    // Without this control the test above passes just as happily against a gate that can never
    // refuse anything at all.
    const v = decideSubmit({ balance: complete(0, 0), required_micro_usd: 999 * MICRO_PER_USD, enforcing: true });
    expect(v.ok).toBe(false);
  });
});

describe("operator knobs", () => {
  it("enforcement is off unless explicitly affirmative", () => {
    for (const raw of [undefined, "", "  ", "0", "false", "no", "off", "yes", "enabled", "TRUE-ish"]) {
      expect(parseEnforcing(raw as string | undefined)).toBe(false);
    }
  });

  it("CONTROL: the affirmative spellings really do turn it on", () => {
    for (const raw of ["1", "true", "TRUE", " enforce ", "Enforcing"]) expect(parseEnforcing(raw)).toBe(true);
  });

  it("a malformed money knob reads as unset, never as a number", () => {
    // "10GB" parsing is refused for the same reason core's storage quota refuses it: a mis-parsed
    // unit is an order-of-magnitude error on somebody's bill.
    for (const raw of [undefined, "", "abc", "10GB", "1.5", "-1", "1e6", " 12 3"]) {
      expect(parseMicroUsd(raw as string | undefined)).toBeNull();
    }
  });

  it("CONTROL: a well-formed value parses, so the rejections above are not a dead function", () => {
    expect(parseMicroUsd("10000000")).toBe(10 * MICRO_PER_USD);
    expect(parseMicroUsd(" 0 ")).toBe(0);
  });
});

describe("display", () => {
  it("formats micro-USD to cents", () => {
    expect(formatUsd(10 * MICRO_PER_USD)).toBe("USD 10.00");
    expect(formatUsd(1_420_000)).toBe("USD 1.42");
    expect(formatUsd(-3_500_000)).toBe("-USD 3.50");
  });

  it("rounds for DISPLAY only, and a sub-cent balance is not zero underneath", () => {
    // A rendered "USD 0.00" over a real 1765 micro-USD is honest on a statement line and would be a
    // lie as a threshold. Nothing in the gate compares formatted output; this test pins that the
    // rounding lives here and only here.
    expect(formatUsd(1765)).toBe("USD 0.00");
    expect(formatUsd(5_000)).toBe("USD 0.01");
  });
});
