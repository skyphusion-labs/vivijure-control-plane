// cp#195: the settlement RUN. One billing period, every tenant, one meter class.
//
// settleMeterOverage settles one tenant. This is the sweep over all of them, and its whole job
// beyond looping is to be honest about what it did NOT cover.

import type { BillingPeriod } from "./meter-period";
import type { LlmSpendReadStore } from "./llm-spend-window";
import { settleMeterOverage, type OverageLedger, type SettleOutcome } from "./meter-settle";

export interface SettlementRow {
  tenantId: string;
  slug: string | null;
  outcome: SettleOutcome["outcome"];
  amountMicroUsd?: number;
  reason?: string;
}

export interface SettlementReport {
  meter: "llm";
  periodKey: string;
  windowStart: string;
  windowEnd: string;
  /**
   * FALSE when the tenant list hit its page limit, so this run covered a SUBSET.
   *
   * Carried for the same reason the R2 usage report carries it: a total computed over a truncated
   * census is a floor wearing a total's label. Here it is worse than a wrong number, it is missing
   * MONEY -- tenants past the limit were never settled and nothing else would ever notice, because
   * an unsettled tenant looks exactly like a tenant who owed nothing.
   */
  censusComplete: boolean;
  /** Tenants the run actually walked. */
  considered: number;
  debited: number;
  alreadySettled: number;
  within: number;
  unbillable: number;
  totalDebitedMicroUsd: number;
  rows: SettlementRow[];
}

export interface LlmSettlementDeps {
  listTenants(): Promise<Array<{ id: string; slug: string | null; deleted_at?: string | null }>>;
  /** True when listTenants returned a full page, i.e. there may be more. */
  censusComplete(count: number): boolean;
  spend: LlmSpendReadStore;
  ledger: OverageLedger;
  /** Injected, NOT read from env here: see meter-debit.ts on why an unset allowance is unbillable. */
  allowanceMicroUsd: number | null;
  newId(): string;
  now(): string;
}

/**
 * Settle the LLM overage for one closed period across every live tenant.
 *
 * SEQUENTIAL, deliberately, matching the R2 usage sweep: each tenant is a database round trip inside
 * a bounded Worker invocation, and fanning out would be faster right up to the tenant count where an
 * operator most needs this to work.
 *
 * A tenant whose settlement THROWS is recorded as unbillable and the sweep continues. One tenant's
 * broken read must not stop the other ninety-nine from being billed, and the failure is in the
 * report rather than in a log nobody reads.
 *
 * DELETED TENANTS ARE SKIPPED. Their spend was real, but there is no balance left to debit and no
 * statement to carry it; writing a debit against a torn-down tenant produces a row nobody can see or
 * settle. That is a deliberate, stated loss rather than a silent one.
 */
export async function runLlmSettlement(
  deps: LlmSettlementDeps,
  period: BillingPeriod,
): Promise<SettlementReport> {
  const all = await deps.listTenants();
  const censusComplete = deps.censusComplete(all.length);
  const live = all.filter((t) => !t.deleted_at);

  const rows: SettlementRow[] = [];
  let debited = 0;
  let alreadySettled = 0;
  let within = 0;
  let unbillable = 0;
  let totalDebitedMicroUsd = 0;

  for (const tenant of live) {
    let outcome: SettleOutcome;
    try {
      const window = await deps.spend.readTenantLlmSpend({
        tenantId: tenant.id,
        windowStart: period.windowStart,
        windowEnd: period.windowEnd,
      });
      outcome = await settleMeterOverage({
        ledger: deps.ledger,
        tenantId: tenant.id,
        meter: "llm",
        window,
        usedMicroUsd: window.cost_micro_usd,
        allowanceMicroUsd: deps.allowanceMicroUsd,
        periodKey: period.key,
        newId: deps.newId,
        now: deps.now,
      });
    } catch (e) {
      // Recorded as UNBILLABLE, never as within and never as a zero. A read that threw told us
      // nothing about what this tenant used.
      outcome = {
        outcome: "unbillable",
        reason: "settlement threw for this tenant: " + (e as Error).message.slice(0, 200),
      };
    }

    const row: SettlementRow = { tenantId: tenant.id, slug: tenant.slug, outcome: outcome.outcome };
    if (outcome.outcome === "debited") {
      debited++;
      totalDebitedMicroUsd += outcome.amountMicroUsd;
      row.amountMicroUsd = outcome.amountMicroUsd;
    } else if (outcome.outcome === "already_settled") {
      alreadySettled++;
    } else if (outcome.outcome === "within") {
      within++;
    } else {
      unbillable++;
      row.reason = outcome.reason;
    }
    rows.push(row);
  }

  return {
    meter: "llm",
    periodKey: period.key,
    windowStart: period.windowStart,
    windowEnd: period.windowEnd,
    censusComplete,
    considered: live.length,
    debited,
    alreadySettled,
    within,
    unbillable,
    totalDebitedMicroUsd,
    rows,
  };
}
