// The payment rail seam (cp#193, under cp#173).
//
// WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN: any payment processor. No Stripe client, no API key,
// no SDK, no test-mode credential, no signup. Conrad provisions the rail himself and has not yet, so
// building against a real one would mean either inventing credentials or waiting. Instead the ledger
// gets an INTERFACE and one rail that needs no processor at all, which is enough to prove the whole
// purchase path end to end. `docs/payment-rail.md` is the list of what he must create, written to be
// executable without reading this code.
//
// THE ONE RULE THAT SHAPES EVERYTHING BELOW: a settlement is money appearing from outside. Processors
// retry webhooks by design and an attacker will happily replay one, so "credit this tenant" must be
// idempotent on the PROCESSOR's own reference and must never be reachable from an unverified body.
// Both properties live in the ledger's unique index rather than in a handler being careful.

import type { CreditStore } from "./store";
import type { MicroUsd } from "./credits";

/** A top-up the tenant has been sent to pay for, but has not paid yet. */
export interface TopUpIntent {
  /** Where to send the tenant. Null for a rail with no checkout surface (ManualRail). */
  checkout_url: string | null;
  /** The rail's own reference for this attempt. Becomes the ledger's external_ref on settlement. */
  external_ref: string;
}

/** Money that has actually arrived, as reported by a VERIFIED rail event. */
export interface SettlementEvent {
  tenant_id: string;
  amount_micro_usd: MicroUsd;
  /** The processor's own event/payment id. The idempotency anchor; never ours. */
  external_ref: string;
  /** Free-text provenance for the audit trail. Never a credential. */
  note: string | null;
}

export type RailRefusal = "unsupported" | "not_configured" | "invalid_amount" | "unverified";

export class PaymentRailError extends Error {
  constructor(readonly code: RailRefusal, message?: string) {
    super(message ?? code);
    this.name = "PaymentRailError";
  }
}

/**
 * A payment rail.
 *
 * Two methods, because a rail does exactly two things: send a tenant somewhere to pay, and tell us
 * when money arrived. Everything else (pricing, balance, refusal) belongs to the ledger and stays
 * there. The rail never sees the ledger's internals and the ledger never imports a rail, so swapping
 * Stripe for anything else is a new class rather than a migration.
 */
export interface PaymentRail {
  readonly id: string;
  createTopUp(args: { tenantId: string; amountMicroUsd: MicroUsd }): Promise<TopUpIntent>;
  /**
   * Turn a webhook request into a settlement, or null when the request is not a settlement event.
   *
   * MUST THROW `unverified` rather than return a value when the signature does not check out. An
   * unverified webhook body is an attacker-controlled request to mint money and is treated as one;
   * returning null for it would make "not a settlement" and "a forged settlement" the same outcome.
   */
  parseSettlement(request: Request): Promise<SettlementEvent | null>;
}

// --------------------------------------------------------------------------- amounts

/**
 * The minimum TENANT top-up, ruled by Conrad: USD 10.
 *
 * Applies to the purchase door, NOT to operator credits. Comping USD 3 after an incident is a
 * legitimate operator action and forcing it to USD 10 would make the floor a reason to over-credit.
 */
export const MIN_TENANT_TOPUP_MICRO_USD = 10_000_000;

/**
 * Default ceiling on a SINGLE operator credit: USD 100.
 *
 * THIS IS A TYPO CATCHER, NOT A POLICY, and the distinction matters. Nobody ruled a maximum comp; the
 * hazard being bounded is an operator's stray keystroke turning USD 10.00 into USD 10,000.00 on the
 * one surface that mints money from nothing. Above it the route refuses and SAYS to raise the knob, so
 * a genuinely large credit is a deliberate act with a config change behind it rather than a slip.
 * Operator-configurable via MANUAL_CREDIT_CEILING_MICRO_USD.
 */
export const DEFAULT_MANUAL_CREDIT_CEILING_MICRO_USD = 100_000_000;

/** Validate an amount as a positive whole number of micro-USD within the ceiling. */
export function validateCreditAmount(
  amount: unknown,
  ceilingMicroUsd: MicroUsd,
): { ok: true; amount: MicroUsd } | { ok: false; message: string } {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) {
    return { ok: false, message: "amount_micro_usd must be a whole number of micro-USD (1e-6 USD)" };
  }
  if (amount <= 0) return { ok: false, message: "amount_micro_usd must be greater than zero" };
  if (amount > ceilingMicroUsd) {
    return {
      ok: false,
      message:
        `amount_micro_usd ${amount} exceeds the single-credit ceiling of ${ceilingMicroUsd}; ` +
        "raise MANUAL_CREDIT_CEILING_MICRO_USD to do this deliberately",
    };
  }
  return { ok: true, amount };
}

// --------------------------------------------------------------------------- the manual rail

/**
 * Operator-credited top-ups. A REAL rail, not a stub, and the distinction is the point.
 *
 * It has real uses that outlive Stripe: comping an account, correcting an incident, honouring a
 * refund. It is also what lets the entire credit system be proven end to end -- purchase, hold,
 * capture, balance, refusal -- with zero payment integration, and what lets counting mode graduate to
 * enforcing before a processor exists.
 *
 * It has NO checkout surface and NO webhook, so both interface methods refuse rather than pretending:
 * a rail that returned a fake checkout URL would advertise a door that goes nowhere.
 */
export class ManualRail implements PaymentRail {
  readonly id = "manual";

  async createTopUp(): Promise<TopUpIntent> {
    throw new PaymentRailError(
      "unsupported",
      "the manual rail has no checkout surface; an operator credits the tenant directly",
    );
  }

  async parseSettlement(): Promise<SettlementEvent | null> {
    throw new PaymentRailError("unsupported", "the manual rail has no webhook; there is nothing to verify");
  }
}

// --------------------------------------------------------------------------- applying money

/**
 * Apply a settlement to the ledger. THE ONLY path by which credit is created.
 *
 * IDEMPOTENCY IS ANCHORED ON THE RAIL'S OWN REFERENCE, namespaced by rail id so two processors cannot
 * collide on a shared reference format. A replayed webhook, a retried operator click, and a
 * double-submitted form all resolve to the same row, and the ledger's unique index is what enforces
 * it -- not this function being called carefully.
 *
 * Returns `applied: false` on a replay. Callers MUST treat that as success: a processor that retries
 * until it sees a 200 will retry forever against a handler that reports a replay as an error.
 */
export async function applySettlement(
  credits: CreditStore,
  args: { railId: string; event: SettlementEvent; rowId: string; now: string },
): Promise<{ applied: boolean }> {
  const { applied } = await credits.appendLedgerRow({
    id: args.rowId,
    tenantId: args.event.tenant_id,
    kind: "purchase",
    deltaMicroUsd: args.event.amount_micro_usd,
    // A purchase has no compute cost. NULL means unmeasured; 0 here would be a real, correct zero,
    // but recording it as unmeasured keeps "cost is what a JOB cost us" the only meaning that column
    // ever carries, so the admin ratio cannot be diluted by rows that were never jobs.
    costMicroUsd: null,
    idemRef: `${args.railId}:${args.event.external_ref}`,
    priceListId: null,
    externalRef: args.event.external_ref,
    note: args.event.note,
    now: args.now,
  });
  return { applied };
}
