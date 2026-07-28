// cp#185 part two: the WINDOWED READ. The interface cp#195 bills from.
//
// Contract, agreed with joan before either side was written so it cannot drift: given a tenant id
// and a CLOSED time window, answer { cost_micro_usd, requests, window_start, window_end, complete }.
//
// `complete` is the load-bearing field. A meter that silently under-counts bills US, not the tenant,
// so every way this read can be less than the whole truth has to surface as complete:false with a
// reason, and each of those ways is separately reachable and separately tested. The extra
// diagnostic fields beyond the agreed five are additive: a consumer that only reads the five
// behaves exactly as specified.

/** One roll-up run as the ledger recorded it. Mirrors llm_rollup_periods (migration 0015). */
export interface RollupPeriodRow {
  id: string;
  window_start: string;
  window_end: string;
  status: string;
  control_passed: number;
  gap_detected: number;
  /** NULL until the run wrote its events. An unfinished run is not an observation. */
  finished_at: string | null;
}

export interface LlmSpendWindow {
  /** Integer micro-USD, matching credit_ledger. Never a float, never a currency string. */
  cost_micro_usd: number;
  requests: number;
  window_start: string;
  window_end: string;
  complete: boolean;
  // ---- diagnostics beyond the agreed five ----
  /** Why complete is false, in the operator's words. NULL when complete. */
  reason: string | null;
  /** How many roll-up runs were assigned to this window. Zero is why complete would be false. */
  periods: number;
  /** Requests whose cost the gateway did not report. They are IN `requests` and NOT in the sum. */
  unpriced_requests: number;
}

/**
 * Which billing window a roll-up run belongs to: the one containing its window_end, half-open.
 *
 * WHY window_end AND WHY HALF-OPEN. Migration 0015 rules that billing keys on period_id, never on a
 * row's occurred_at, so that a log row arriving after a statement is settled cannot retroactively
 * change it. That rule only holds if each PERIOD lands in exactly one billing window, and only a
 * half-open test on a single instant gives that. An overlap test would put a run that straddles a
 * boundary into BOTH neighbouring windows and bill its rows twice, which on a money path is the
 * worst failure available.
 *
 * A run whose window_start is before the requested window still belongs here if it FINISHED here.
 * That is the intended reading: its rows were ingested at that instant, so that is when they are
 * billed. A row that occurred earlier and arrived late is billed in the statement that ingested it.
 */
export function periodBelongsToWindow(
  period: RollupPeriodRow,
  windowStart: string,
  windowEnd: string,
): boolean {
  return period.window_end >= windowStart && period.window_end < windowEnd;
}

export interface WindowSums {
  /** SUM(cost_micro_usd) over the assigned periods for this tenant. SQL SUM SKIPS NULLs. */
  costMicroUsd: number;
  requests: number;
  unpricedRequests: number;
}

/**
 * Decide the window. PURE: the SQL hands over rows and counts, every judgement happens here, so the
 * judgement is unit tested against planted bad input rather than only against whatever a live
 * database happened to contain.
 *
 * WHAT IS DELIBERATELY *NOT* A COMPLETENESS CONDITION: wall-clock coverage of the requested window
 * by roll-up runs. It reads like it should be one, so here is why it is not. Under period-keyed
 * billing a stretch of wall-clock that no run covers is not lost money; the rows created then are
 * ingested by the NEXT run and billed in THAT run's window. So a cron outage is a latency fact, not
 * a money fact. It only becomes a money fact when the outage lasts long enough for retention to
 * delete rows unread, and that has its own signal (gap_detected) which IS checked below. Adding a
 * coverage clause would mark honest windows incomplete for a reason that costs nobody anything,
 * and a completeness flag that cries wolf gets ignored, which would cost us the one time it matters.
 */
export function summariseWindow(args: {
  periods: RollupPeriodRow[];
  windowStart: string;
  windowEnd: string;
  sums: WindowSums;
  /** True when the period census was cut off by its own limit; see readTenantLlmSpend. */
  periodCensusTruncated?: boolean;
}): LlmSpendWindow {
  const { periods, windowStart, windowEnd, sums } = args;
  const reasons: string[] = [];

  // A truncated census is checked FIRST: every judgement below is drawn from a list of periods, and
  // a conclusion drawn from a list that was cut off is a floor wearing a total's label.
  if (args.periodCensusTruncated) {
    reasons.push(
      "the period census for this window hit its own row limit, so the periods below are a subset " +
        "and every count drawn from them is a floor",
    );
  }

  if (periods.length === 0) {
    // THE ONE THAT MATTERS MOST. Zero periods means no roll-up run was assigned to this window, so
    // the meter produced no observation of it at all. That is not zero spend. Reporting it as a
    // complete zero is exactly the under-bill this lane exists to prevent, and it is the shape a
    // silently-broken cron produces.
    reasons.push(
      "no roll-up run is assigned to this window, so the meter made no observation of it. That is " +
        "NOT the same fact as zero spend, and the zero below must not be billed as one",
    );
  }

  const unfinished = periods.filter((p) => !p.finished_at).length;
  if (unfinished > 0) {
    // A run writes its period row BEFORE its events so the events have a parent to reference, and
    // stamps finished_at only once they are written. An unfinished row is therefore a run that died
    // mid-write: its events are a partial set, and its own rows_ingested count over-claims.
    reasons.push(
      unfinished + " assigned run(s) never finished writing, so their event sets are partial",
    );
  }
  const notComplete = periods.filter((p) => p.status !== "complete").length;
  if (notComplete > 0) {
    reasons.push(
      notComplete + " assigned run(s) did not paginate to exhaustion (status incomplete or failed)",
    );
  }
  const controlFailed = periods.filter((p) => p.control_passed !== 1).length;
  if (controlFailed > 0) {
    // The gateway logs endpoint answers 200 / success:true / total_count:0 for a gateway that does
    // not exist, so a run whose unfiltered probe reported zero learned nothing and proved nothing.
    reasons.push(
      controlFailed +
        " assigned run(s) FAILED their positive control, so what they read is not evidence " +
        "(an empty gateway read is indistinguishable from wrong-gateway or no-permission)",
    );
  }
  const gapped = periods.filter((p) => p.gap_detected === 1).length;
  if (gapped > 0) {
    // The only PERMANENT loss in this system. Everything else is resumable.
    reasons.push(
      gapped +
        " assigned run(s) detected a retention GAP: rows were deleted unread and are gone for good, " +
        "so this window under-counts by an unknown amount that will never arrive",
    );
  }
  if (sums.unpricedRequests > 0) {
    // SQL SUM skips NULLs, so an unpriced row is invisible in the total while being visible in the
    // count. Left unflagged, the pair reads as "we billed everything" when it is "we billed what we
    // could price".
    reasons.push(
      sums.unpricedRequests +
        " request(s) in this window carried no usable cost from the gateway and are counted but NOT " +
        "summed, so the total is a floor",
    );
  }

  return {
    cost_micro_usd: sums.costMicroUsd,
    requests: sums.requests,
    window_start: windowStart,
    window_end: windowEnd,
    complete: reasons.length === 0,
    reason: reasons.length === 0 ? null : reasons.join("; "),
    periods: periods.length,
    unpriced_requests: sums.unpricedRequests,
  };
}

/**
 * Cap on how many roll-up runs one windowed read will consider.
 *
 * A five-minute cron produces 288 periods a day, so this covers a month-long window with room. It
 * exists because a read with no limit is a full scan on a table that only grows, and because a
 * limit hit SILENTLY would turn a subset into an answer. It is never hit silently: the store passes
 * periodCensusTruncated and the window reports complete:false naming it.
 */
export const MAX_PERIODS_PER_WINDOW = 20_000;

/** The read half of the meter, split from the ingest half: a consumer bills, it does not ingest. */
export interface LlmSpendReadStore {
  /**
   * Spend for one tenant over one CLOSED window. The cp#195 contract.
   *
   * windowStart is INCLUSIVE and windowEnd EXCLUSIVE, matching periodBelongsToWindow, so calling
   * this for consecutive windows partitions the periods rather than double-billing the boundary.
   */
  readTenantLlmSpend(args: {
    tenantId: string;
    windowStart: string;
    windowEnd: string;
  }): Promise<LlmSpendWindow>;
}
