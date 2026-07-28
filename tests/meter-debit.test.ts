// cp#195: the overage decision.
//
// The assertion this suite exists for is the THREE-WAY distinction. `within` and `unbillable` both
// write no ledger row, so a decision core that collapsed them would pass any test that only checked
// "was a debit written". Every case below asserts WHICH no-row outcome it is, because one means
// "nothing is owed" and the other means "we could not look", and treating them alike is a silent
// free ride on every gap in the meter.

import { describe, it, expect } from "vitest";
import { decideOverageDebit, overageIdemRef, type MeterClass } from "../src/meter-debit";
import { isUnbillable, type MeterWindow } from "../src/meter-window";

const complete: MeterWindow = {
  window_start: "2026-07-01T00:00:00.000Z",
  window_end: "2026-08-01T00:00:00.000Z",
  complete: true,
  reason: null,
};
const incomplete: MeterWindow = {
  ...complete,
  complete: false,
  reason: "no roll-up run is assigned to this window",
};

const decide = (over: Partial<Parameters<typeof decideOverageDebit>[0]> = {}) =>
  decideOverageDebit({
    meter: "llm",
    window: complete,
    usedMicroUsd: 1000,
    allowanceMicroUsd: 520_000,
    periodKey: "2026-07",
    ...over,
  });

describe("isUnbillable", () => {
  it("bills ONLY on an explicit true, so a missing flag is not a free pass", () => {
    expect(isUnbillable(complete)).toBe(false);
    expect(isUnbillable(incomplete)).toBe(true);
    // A window from an older shape, or a hand-built fixture, must not read as billable.
    expect(isUnbillable({ ...complete, complete: undefined as unknown as boolean })).toBe(true);
  });
});

describe("decideOverageDebit: the three outcomes are distinct", () => {
  it("CONTROL: usage over the allowance produces a debit for the DIFFERENCE, not the total", () => {
    const d = decide({ usedMicroUsd: 620_000, allowanceMicroUsd: 520_000 });
    expect(d.outcome).toBe("debit");
    if (d.outcome !== "debit") throw new Error("unreachable");
    expect(d.amountMicroUsd).toBe(100_000);
    expect(d.idemRef).toBe("overage:llm:2026-07");
  });

  // "Usage inside the allowance produces no ledger row" (cp#195). A complete, correct answer.
  it("usage inside the allowance is WITHIN: no row, and nothing unknown", () => {
    const d = decide({ usedMicroUsd: 1000, allowanceMicroUsd: 520_000 });
    expect(d.outcome).toBe("within");
    expect(d).not.toHaveProperty("amountMicroUsd");
  });

  // THE DISTINCTION THAT MATTERS. Both write nothing; they are not the same fact.
  it("an INCOMPLETE window is UNBILLABLE, never within and never a zero debit", () => {
    const d = decide({ window: incomplete, usedMicroUsd: 0 });
    expect(d.outcome).toBe("unbillable");
    expect(d.outcome).not.toBe("within");
    if (d.outcome !== "unbillable") throw new Error("unreachable");
    // The upstream reason travels, so an operator learns WHY without a second lookup.
    expect(d.reason).toContain("no roll-up run is assigned");
  });

  // THE MOST DANGEROUS SHAPE AVAILABLE, and the reason completeness is checked FIRST. An incomplete
  // window whose PARTIAL total sits under the allowance would report a confident "nothing is owed"
  // derived from data we never had, and it looks exactly like the healthy case.
  it("an incomplete window UNDER the allowance is still unbillable, not within", () => {
    const d = decide({ window: incomplete, usedMicroUsd: 1, allowanceMicroUsd: 520_000 });
    expect(d.outcome).toBe("unbillable");
  });

  // ...and the same window OVER the allowance must not bill either.
  it("an incomplete window OVER the allowance does not bill", () => {
    const d = decide({ window: incomplete, usedMicroUsd: 9_999_999, allowanceMicroUsd: 1 });
    expect(d.outcome).toBe("unbillable");
  });

  it("EXACTLY at the allowance is within, not a zero debit", () => {
    const d = decide({ usedMicroUsd: 520_000, allowanceMicroUsd: 520_000 });
    expect(d.outcome).toBe("within");
  });

  it("one micro-USD over the allowance is the smallest real debit", () => {
    const d = decide({ usedMicroUsd: 520_001, allowanceMicroUsd: 520_000 });
    expect(d.outcome).toBe("debit");
    if (d.outcome !== "debit") throw new Error("unreachable");
    expect(d.amountMicroUsd).toBe(1);
  });

  // A zero allowance IS a decision (bill from the first micro-USD) and must behave differently from
  // an unset one. Without this, "unset means zero" could be reintroduced and nothing would fail.
  it("a configured ZERO allowance bills from the first micro-USD", () => {
    expect(decide({ usedMicroUsd: 1, allowanceMicroUsd: 0 }).outcome).toBe("debit");
    expect(decide({ usedMicroUsd: 0, allowanceMicroUsd: 0 }).outcome).toBe("within");
  });
});

describe("decideOverageDebit refuses rather than inventing a policy", () => {
  // The one failure in this lane that would cost the TENANT rather than us. An unset allowance is
  // the absence of a decision, not a decision of zero.
  it("an UNSET allowance is unbillable, NOT an allowance of zero", () => {
    const d = decide({ allowanceMicroUsd: null, usedMicroUsd: 9_999_999 });
    expect(d.outcome).toBe("unbillable");
    if (d.outcome !== "unbillable") throw new Error("unreachable");
    expect(d.reason).toContain("absence of a decision");
  });

  it('refuses a MALFORMED allowance rather than rounding it: "typed it wrong" is not "chose none"', () => {
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      const d = decide({ allowanceMicroUsd: bad, usedMicroUsd: 1_000_000 });
      expect(d.outcome, String(bad)).toBe("unbillable");
    }
  });

  it("refuses a nonsense usage total rather than clamping it to zero", () => {
    for (const bad of [-1, 0.5, NaN, Infinity]) {
      const d = decide({ usedMicroUsd: bad });
      expect(d.outcome, String(bad)).toBe("unbillable");
    }
  });

  // POSITIVE CONTROL for both refusal blocks: valid inputs still decide. Without it, a function that
  // returned "unbillable" unconditionally would pass every assertion above.
  it("CONTROL: valid inputs still produce real decisions", () => {
    expect(decide({ usedMicroUsd: 0, allowanceMicroUsd: 0 }).outcome).toBe("within");
    expect(decide({ usedMicroUsd: 2, allowanceMicroUsd: 1 }).outcome).toBe("debit");
  });
});

describe("overageIdemRef", () => {
  // credit_ledger is idempotent on (tenant_id, idem_ref), so a retried settlement run must produce
  // the SAME key or it charges twice.
  it("is deterministic for one meter and one period", () => {
    expect(overageIdemRef("llm", "2026-07")).toBe(overageIdemRef("llm", "2026-07"));
  });

  // One tenant can owe an LLM overage AND a storage overage for the same period. Those are two
  // rows, and a key that did not separate them would silently drop the second.
  it("separates meter classes and periods so neither collides", () => {
    const keys = new Set<string>();
    for (const meter of ["llm", "r2_storage"] as MeterClass[]) {
      for (const period of ["2026-07", "2026-08"]) keys.add(overageIdemRef(meter, period));
    }
    expect(keys.size).toBe(4);
  });
});
