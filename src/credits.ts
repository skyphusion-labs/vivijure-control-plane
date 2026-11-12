// The prepaid credit core (cp#189, under cp#173).
//
// WHAT IS PURE AND WHY. Everything in this file is IO-free, clock-free and global-free: the balance
// arithmetic, the availability rule, and the decision to refuse a submission. That split follows the
// same reasoning as tenant-r2-usage.ts -- the live read is the caller's job, and the part that can be
// SILENTLY wrong is the decision, so the decision is what lives under the unit gate. The SQL half is
// proven separately against a real engine (tests/credits-sql.test.ts), because a fake store cannot
// catch a malformed statement and this repo has already shipped that exact bug once.
//
// THE UNIT IS INTEGER MICRO-USD (1e-6 USD). Not cents, not an abstract credit, and never a float.
// Rationale is recorded in migrations/0013_credit_ledger.sql; the short version is that the measured
// cost basis has USD 0.001765 line items, so cents cannot represent it and floats cannot be summed
// without drift. Callers convert to a display string at the very edge and nowhere else.
//
// COMPLETED-ONLY BILLING (Conrad, 2026-07-27). A failed render costs the tenant nothing; we eat the
// GPU. That is the product differentiator and it is what forces the hold: a charge that only lands at
// completion cannot refuse anything at submit time on its own.

/** Money, always. A named alias so a raw number cannot drift in from a float path unnoticed. */
export type MicroUsd = number;

/** USD 1.00 in the ledger's unit. */
export const MICRO_PER_USD = 1_000_000;

export type LedgerKind = "purchase" | "debit" | "refund" | "adjustment";
export type HoldStatus = "open" | "captured" | "released" | "expired";

export interface LedgerRow {
  id: string;
  tenant_id: string;
  kind: LedgerKind;
  delta_micro_usd: MicroUsd;
  /** What it cost US. NULL means unmeasured, NEVER 0. */
  cost_micro_usd: MicroUsd | null;
  idem_ref: string;
  hold_id: string | null;
  price_list_id: string | null;
  external_ref: string | null;
  note: string | null;
  created_at: string;
}

export interface HoldRow {
  id: string;
  tenant_id: string;
  job_ref: string;
  amount_micro_usd: MicroUsd;
  status: HoldStatus;
  price_list_id: string;
  created_at: string;
  expires_at: string;
  settled_at: string | null;
}

// --------------------------------------------------------------------------- balance

/**
 * A tenant's money position.
 *
 * `complete` is not decoration. Every aggregate here is a SUM over rows, and a SUM built from a
 * truncated or failed read is a FLOOR, not a total. The same rule the R2 usage surface holds: a
 * number that might be partial must say so, because "balance is X" claimed from a partial scan is a
 * quiet, confident, wrong answer -- and in this file it is a quiet, confident, wrong REFUSAL or a
 * quiet, confident, wrong PERMISSION.
 */
export interface Balance {
  /** SUM over ledger rows. Money that has actually moved. */
  settled_micro_usd: MicroUsd;
  /** SUM over OPEN holds. Reserved, not yet spent, not available. */
  held_micro_usd: MicroUsd;
  /** settled - held. What a new submission may draw on. */
  available_micro_usd: MicroUsd;
  /** False when either SUM was built from an incomplete read. */
  complete: boolean;
}

/**
 * Compute a balance from rows already read.
 *
 * OPEN HOLDS COUNT AS HELD EVEN IF EXPIRED, and that is deliberate rather than an oversight. Freeing
 * an expired-but-unswept hold at READ time would release a tenant's reserved money while the job it
 * reserves for may still be running, which is a double-spend against ourselves. The sweep flips
 * expired holds to 'expired' explicitly; until it does, the money stays reserved. Fail closed.
 */
export function computeBalance(args: {
  ledger: Pick<LedgerRow, "delta_micro_usd">[];
  openHolds: Pick<HoldRow, "amount_micro_usd">[];
  /** False when the ledger read or the hold read was truncated or errored. */
  complete: boolean;
}): Balance {
  let settled = 0;
  for (const row of args.ledger) settled += row.delta_micro_usd;
  let held = 0;
  for (const h of args.openHolds) held += h.amount_micro_usd;
  return balanceFromSums({ settled, held, complete: args.complete });
}

/**
 * The same balance from aggregates the database already summed.
 *
 * Production reads SUMs (a growing ledger should not be shipped row by row to be added up in JS), and
 * row-holding callers use computeBalance. Both funnel through HERE so the arithmetic exists once. Two
 * implementations of the same subtraction is how a statement view and a refusal come to disagree
 * about what a tenant can afford.
 */
export function balanceFromSums(args: { settled: MicroUsd; held: MicroUsd; complete: boolean }): Balance {
  return {
    settled_micro_usd: args.settled,
    held_micro_usd: args.held,
    available_micro_usd: args.settled - args.held,
    complete: args.complete,
  };
}

// --------------------------------------------------------------------------- the gate

/**
 * Why a submission was refused. An enum, never a free-text message, so callers branch on the reason
 * and the tenant-facing copy is written once per case rather than inferred from a string.
 *
 * `balance_unknown` is the case a naive gate would not have: the balance read came back incomplete,
 * so we do not KNOW whether the tenant can afford this. Money code refuses on unknown rather than
 * assuming the generous answer.
 */
export type DenyReason = "insufficient_credit" | "balance_unknown";

export type SubmitVerdict =
  | { ok: true; enforcing: boolean; available_micro_usd: MicroUsd; required_micro_usd: MicroUsd }
  | {
      ok: false;
      reason: DenyReason;
      /** NULL when the balance could not be read. Never 0 as a stand-in for unknown. */
      available_micro_usd: MicroUsd | null;
      required_micro_usd: MicroUsd;
      message: string;
    };

/**
 * The submit-time decision.
 *
 * COUNTING MODE (ruled on cp#173: the ledger may run before any purchase door exists) records
 * everything and refuses nothing. It is ONE flag, read in one place, and it is reported back on every
 * verdict -- a ledger that is silently not enforcing looks exactly like one that is, and that
 * ambiguity is how an operator discovers the truth from a bill instead of from a surface.
 *
 * Note that counting mode does NOT suppress the incomplete-read case differently: it still reports
 * ok, because refusing nothing is the entire point of counting mode. The caller records the event.
 */
export function decideSubmit(args: {
  balance: Balance;
  required_micro_usd: MicroUsd;
  enforcing: boolean;
}): SubmitVerdict {
  const { balance, required_micro_usd: required, enforcing } = args;

  if (!enforcing) {
    return {
      ok: true,
      enforcing: false,
      available_micro_usd: balance.available_micro_usd,
      required_micro_usd: required,
    };
  }

  if (!balance.complete) {
    return {
      ok: false,
      reason: "balance_unknown",
      available_micro_usd: null,
      required_micro_usd: required,
      message:
        "credit balance could not be read completely, so this submission cannot be authorized; " +
        "no charge was made and nothing was started (fail-closed posture)",
    };
  }

  if (balance.available_micro_usd < required) {
    return {
      ok: false,
      reason: "insufficient_credit",
      available_micro_usd: balance.available_micro_usd,
      required_micro_usd: required,
      message:
        `this job needs ${formatUsd(required)} in credit and ${formatUsd(balance.available_micro_usd)} ` +
        "is available; top up to continue (nothing was started and nothing was charged)",
    };
  }

  return {
    ok: true,
    enforcing: true,
    available_micro_usd: balance.available_micro_usd,
    required_micro_usd: required,
  };
}

/**
 * The submit FLOOR (fleet-chezmoi#2049): the `required_micro_usd` the proxied submit asks
 * decideSubmit for. One micro-USD, which makes the gate "refuse when available credit is at or
 * below zero" and nothing more.
 *
 * NOT A PRICE. What a job costs a tenant is the open pricing decision (cp#190: price per job class
 * versus metered), and the per-job proxy cannot compute it anyway: billing is per FILM, on the final
 * delivered length, which the proxy never sees. This floor answers a narrower question that needs
 * no price: does this tenant have any credit left at all.
 *
 * THE RESIDUAL EXPOSURE, stated so nobody reads this as a spend ceiling. A tenant with ANY positive
 * balance may submit, so the job that crosses zero runs in full: about one job past zero per tenant
 * submitting one at a time. No hold is taken, so concurrent submits all read the same balance and
 * all pass: with N in flight when the balance crosses zero, the exposure is up to N jobs. A real
 * ceiling needs a per-job price and a hold, which is cp#190's decision.
 */
export const SUBMIT_FLOOR_MICRO_USD: MicroUsd = 1;

// --------------------------------------------------------------------------- operator knobs

/**
 * Parse the enforcement knob. Anything other than an explicit affirmative reads as COUNTING MODE.
 *
 * The default direction is chosen against the usual "fail closed" reflex, on purpose, and the reason
 * is specific to this knob: at the moment this ships there is no purchase door, so no tenant CAN hold
 * a positive balance. Defaulting to enforcing would refuse every submission on every tenant the
 * instant the migration lands. The dangerous direction here is not "spends without paying" (nothing
 * can be bought yet), it is "a studio that stops working for reasons nobody configured". Enforcement
 * is switched on deliberately when the rail exists, and the verdict reports which mode it ran in so
 * the state is never a guess.
 */
export function parseEnforcing(raw: string | undefined): boolean {
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "enforce" || v === "enforcing";
}

/**
 * IS there a submit-time gate at all?
 *
 * MEASURED, NOT ASSUMED, and this constant is the single place the answer lives. As of
 * fleet-chezmoi#2049 the answer is YES, AND IT IS A FLOOR: the proxied submit (`handleProxySubmit`)
 * calls `decideSubmit` with `required_micro_usd = SUBMIT_FLOOR_MICRO_USD`, so with CREDITS_ENFORCING
 * on, a tenant whose available credit is at or below zero is refused, and an unreadable balance
 * refuses too (fail closed). `takeHold`, `captureHold`, `releaseHold` and `expireHolds` are still
 * never called outside tests: no hold is taken and nothing is reserved per job.
 *
 * WHAT "APPLIED" THEREFORE MEANS. Refusals are in force, at the floor only. Not a per-job price and
 * not a spend ceiling: see SUBMIT_FLOOR_MICRO_USD for the residual exposure (about one job past zero
 * per tenant, more with concurrent submits). The per-job price is cp#190, still open.
 *
 * WHY A CONSTANT RATHER THAN A COMMENT. `CREDITS_ENFORCING` used to be echoed straight back by the
 * credit views, which reported `enforcing: true` on a plane that refused nothing. Routing the knob
 * through here makes "configured" and "applied" two different facts that cannot be conflated by
 * accident.
 *
 * `tests/credits-enforcement-wiring.test.ts` asserts this constant against the source: RED if it
 * disagrees with whether anything in src/ calls the gate.
 */
export const SUBMIT_GATE_WIRED = true;

/**
 * What enforcement is CONFIGURED to do, and what it ACTUALLY does. Two facts, deliberately not one.
 */
export interface EnforcementState {
  /** What the operator set `CREDITS_ENFORCING` to. */
  configured: boolean;
  /** Whether refusals are in force IN FACT. False whenever no submit-time gate exists to apply them. */
  applied: boolean;
  /**
   * Non-null when configured and applied disagree, naming why, AND when what is applied is narrower
   * than a reader of `applied: true` would assume (fleet-chezmoi#2049: a zero-balance floor, not a
   * price or a ceiling). Never a bare boolean gap.
   */
  reason: string | null;
}

/** Resolve the knob into what is configured, what is applied, and why they differ. */
export function creditsEnforcementState(raw: string | undefined): EnforcementState {
  const configured = parseEnforcing(raw);
  if (!configured) return { configured: false, applied: false, reason: null };
  if (!SUBMIT_GATE_WIRED) {
    return {
      configured: true,
      applied: false,
      reason:
        "CREDITS_ENFORCING is set, but no submit-time gate consults the balance on this plane: " +
        "nothing calls decideSubmit and no hold is ever taken, so nothing is refused and nothing is " +
        "debited. The ledger is RECORDING ONLY. Do not read this knob as a spend control.",
    };
  }
  return {
    configured: true,
    applied: true,
    reason:
      "a floor only: a proxied submit is refused when the tenant's available credit is at or below " +
      "zero. There is no per-job price and no hold, so about one job past zero per tenant still runs " +
      "(more with concurrent submits). Do not read this as a spend ceiling.",
  };
}

/**
 * Parse a micro-USD operator value. Rejects anything that is not a non-negative whole number of
 * micro-USD, because a mis-parsed money knob is an order-of-magnitude error on somebody's bill --
 * the same reason core's storage quota refuses to parse "10GB".
 */
export function parseMicroUsd(raw: string | undefined): MicroUsd | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!/^[0-9]+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

// --------------------------------------------------------------------------- display

/**
 * Render micro-USD as a USD string. THE ONLY place money becomes text.
 *
 * Rounds half away from zero at the cent, and rounding here is display-only: the ledger keeps full
 * micro-USD precision, so a rendered "USD 0.00" can legitimately sit on a real non-zero balance. That
 * is honest for a statement line and would be a lie for a threshold, which is why nothing in this
 * file ever compares formatted output.
 */
export function formatUsd(micro: MicroUsd): string {
  const neg = micro < 0;
  const abs = Math.abs(micro);
  const cents = Math.round(abs / 10_000);
  const s = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  return `${neg ? "-" : ""}USD ${s}`;
}
