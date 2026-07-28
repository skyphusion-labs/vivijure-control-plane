// cp#195: turning a metered window into a money row, or honestly declining to.
//
// PURE, and injected with the allowance rather than reading a knob, for two reasons. The knob's home
// is a live design question (core operator knob plus a plane TENANT_* binding, the cp#183 shape),
// and this decision does not change shape whichever way it lands. And a money decision that reads
// its own config cannot be tested against the values that matter, only against the ones the
// environment happens to hold.
//
// THREE OUTCOMES, NOT TWO. This is the whole design and the easiest thing to get wrong:
//
//   debit         usage exceeded the allowance. Write the overage.
//   within        usage was inside the allowance. NO ledger row at all, and that is a COMPLETE,
//                 CORRECT, finished answer (cp#195: "usage inside the allowance produces no ledger
//                 row"). Nothing is owed and nothing is unknown.
//   unbillable    we could not establish what the usage WAS. Nothing is written, and the period
//                 stays open for a later, better-informed run.
//
// `within` and `unbillable` both write nothing, which is exactly why they must not share a name. One
// says "we looked, and nothing is owed". The other says "we could not look". Collapsing them turns
// every gap in the meter into a silent free ride, which is the failure this entire lane is built
// around. A consumer that treats them alike is a consumer that under-bills us and never finds out.

import { isUnbillable, type MeterWindow } from "./meter-window";

/** Ledger `kind` for a metered overage. Overage is consumption, so it is a debit like any other. */
export const OVERAGE_LEDGER_KIND = "debit" as const;

export type MeterClass = "llm" | "r2_storage";

export type DebitDecision =
  | {
      outcome: "debit";
      /** Integer micro-USD to charge. ALWAYS positive: a zero overage is `within`, not a zero debit. */
      amountMicroUsd: number;
      /** Deterministic, so a retried settlement run is a no-op on (tenant_id, idem_ref). */
      idemRef: string;
      note: string;
    }
  | { outcome: "within"; /** What was used, for the statement line. */ usedMicroUsd: number; allowanceMicroUsd: number; note: string }
  | { outcome: "unbillable"; reason: string };

/**
 * The idempotency key for one tenant's overage in one billing period.
 *
 * DETERMINISTIC AND DERIVED, never a fresh id: `credit_ledger` is idempotent on
 * (tenant_id, idem_ref), so a settlement run that is retried, or that overlaps its own next tick,
 * must produce the SAME key or it charges twice. It carries the meter class because one tenant can
 * owe an LLM overage and a storage overage for the same period, and those are two rows.
 *
 * The tenant id is deliberately NOT in the key: the uniqueness constraint already scopes by tenant,
 * and putting it in would make the key look globally unique when its uniqueness is per-tenant --
 * a reader would then reasonably assume they could dedupe on it across tenants.
 */
export function overageIdemRef(meter: MeterClass, periodKey: string): string {
  return `overage:${meter}:${periodKey}`;
}

/**
 * Decide the overage for one tenant, one meter class, one billing period.
 *
 * ORDER OF THE GUARDS IS LOAD-BEARING. Completeness is checked FIRST, before the allowance and
 * before any arithmetic, because a number drawn from a window we did not fully observe is not a
 * small number, it is not a number at all. Checking the allowance first would let an incomplete
 * window whose partial total happens to sit under the allowance report `within` -- a confident
 * "nothing is owed" derived from data we never had. That is the single most dangerous shape
 * available here, because it looks exactly like the healthy case.
 */
export function decideOverageDebit(args: {
  meter: MeterClass;
  /** The metered window. Any class: it only has to speak the shared vocabulary. */
  window: MeterWindow;
  /** What the window says was used, in integer micro-USD. */
  usedMicroUsd: number;
  /**
   * The included allowance in integer micro-USD, or NULL when no allowance is configured.
   *
   * NULL IS UNBILLABLE, NOT ZERO. An unset allowance is not a policy of "no allowance", it is the
   * absence of a decision, and this code does not get to invent one -- the same posture
   * R2_STORAGE_QUOTA_BYTES takes (no default in code, because the number prices what an operator is
   * willing to carry). The direction matters: treating unset as zero would bill a tenant for every
   * micro-USD of something nobody configured, which is the one failure in this lane that costs the
   * TENANT rather than us. Refusing costs us an allowance-sized amount and is visible.
   */
  allowanceMicroUsd: number | null;
  /** The billing period this settles, e.g. "2026-07". Only used to build the idempotency key. */
  periodKey: string;
}): DebitDecision {
  const { meter, window, usedMicroUsd, allowanceMicroUsd, periodKey } = args;

  if (isUnbillable(window)) {
    return {
      outcome: "unbillable",
      reason:
        `the ${meter} meter did not fully observe ${window.window_start}..${window.window_end}, so ` +
        "its total is not a number we may bill from: " + (window.reason ?? "no reason recorded"),
    };
  }

  // A complete window carrying a nonsense total is a bug upstream, not a free period. Refusing here
  // rather than clamping means it surfaces; clamping to 0 would bill nothing and say nothing.
  if (!Number.isInteger(usedMicroUsd) || usedMicroUsd < 0) {
    return {
      outcome: "unbillable",
      reason:
        `the ${meter} meter reported a usage of ${String(usedMicroUsd)} micro-USD, which is not a ` +
        "non-negative integer. Refusing to bill from it rather than coercing it to a number that " +
        "would be silently wrong",
    };
  }

  if (allowanceMicroUsd === null) {
    return {
      outcome: "unbillable",
      reason:
        `no included allowance is configured for the ${meter} meter, so there is nothing to measure ` +
        "overage against. An unset allowance is the absence of a decision, not a decision of zero, " +
        "and billing every micro-USD against an allowance nobody chose would charge the tenant for " +
        "our missing config",
    };
  }
  if (!Number.isInteger(allowanceMicroUsd) || allowanceMicroUsd < 0) {
    return {
      outcome: "unbillable",
      reason:
        `the configured ${meter} allowance ${String(allowanceMicroUsd)} is not a non-negative ` +
        "integer number of micro-USD. A malformed allowance is refused rather than rounded, because " +
        '"typed it wrong" and "chose no allowance" must not be the same outcome',
    };
  }

  if (usedMicroUsd <= allowanceMicroUsd) {
    // NO LEDGER ROW. Not a zero-value one: a zero row would put a money entry on a statement for
    // something that cost the tenant nothing, and would make the ledger's row count a poor proxy
    // for "times this tenant was charged".
    return {
      outcome: "within",
      usedMicroUsd,
      allowanceMicroUsd,
      note:
        `${usedMicroUsd} of ${allowanceMicroUsd} micro-USD included ${meter} allowance used in ` +
        `${periodKey}; nothing owed`,
    };
  }

  const amountMicroUsd = usedMicroUsd - allowanceMicroUsd;
  return {
    outcome: "debit",
    amountMicroUsd,
    idemRef: overageIdemRef(meter, periodKey),
    note:
      `${meter} overage for ${periodKey}: ${usedMicroUsd} micro-USD used against a ` +
      `${allowanceMicroUsd} micro-USD included allowance`,
  };
}
