// cp#185: the per-tenant LLM spend roll-up.
//
// Reads AI Gateway logs, attributes each request to a tenant, and writes integer micro-USD usage
// rows the credit ledger debits from. Ruled a periodic ROLL-UP rather than pull-on-demand
// (mackaye, 2026-07-27); the reasoning is recorded in migrations/0015_llm_spend_rollup.sql.
//
// THE HAZARD THIS FILE IS SHAPED AROUND. The gateway logs endpoint answers HTTP 200,
// success=true, total_count=0 for a gateway id THAT DOES NOT EXIST. Proven against
// this-gateway-does-not-exist-xyzzy-9999, byte-identical in shape to the real gateway. So an empty
// result cannot be read as no spend: it is equally consistent with wrong-gateway, wrong-account,
// no-permission, and rows having aged out. A meter that reports that zero as zero UNDER-BILLS US,
// not the tenant.
//
// Hence runRollup carries a POSITIVE CONTROL on EVERY run, not just at build time, and records
// whether it passed. A consumer bills a period only when it completed AND the control passed.

/** One AI Gateway log row, as far as this module cares. Shape read off the LIVE gateway. */
export interface GatewayLogRow {
  id: string;
  created_at: string;
  model?: string;
  cost?: number;
  tokens_in?: number;
  tokens_out?: number;
  cached?: boolean;
  /** Populated ONLY by the cf-aig-metadata header. null on a call that sent none. */
  metadata?: Record<string, unknown> | null;
}

export interface GatewayPage {
  rows: GatewayLogRow[];
  totalCount: number | null;
}

/**
 * The ONE un-stubbable seam. Everything else in this file is pure, so the decision path is unit
 * tested without the network; this is the single place a real gateway is reached.
 */
export interface GatewayLogReader {
  /** A page of logs. `after` maps to the gateway created_at gt filter, verified in both directions. */
  list(opts: { after?: string; page: number; perPage: number }): Promise<GatewayPage>;
  /**
   * An UNFILTERED probe. Returns the gateway total_count (the positive control) AND the created_at
   * of the OLDEST row still present (gap detection).
   *
   * The oldest row matters because retention is 10,000,000 rows DELETE_OLDEST with no time window.
   * If the oldest surviving row is NEWER than our watermark, everything between them was deleted
   * unread and is gone for good. That is a different fact from an unfinished page walk: one is
   * resumable, the other is not, and they want different operator responses.
   */
  probe(): Promise<{ total: number | null; oldest: string | null }>;
}

/** The gateway caps per_page at 50. Read off the API, not guessed. */
export const MAX_PER_PAGE = 50;

/**
 * Convert Cloudflare native float cost to integer micro-USD. ONE conversion point, at ingest.
 *
 * Doing this at read time would put a rounding rule at every call site and let two readers
 * disagree about the same row. Rejects anything non-finite or negative rather than coercing:
 * a NaN cost silently becoming 0 is an under-count, which is the failure this whole file guards.
 */
export function toMicroUsd(cost: unknown): number | null {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
  return Math.round(cost * 1_000_000);
}

/** A usage row ready to write. tenant_id null means UNATTRIBUTED, never dropped. */
export interface SpendEvent {
  source: "ai_gateway";
  sourceId: string;
  tenantId: string | null;
  slug: string | null;
  model: string | null;
  /**
   * NULL when the gateway reported no usable cost. NEVER coerced to 0: downstream a 0 reads as
   * THIS REQUEST WAS FREE rather than WE DO NOT KNOW, and that error is silent and one-directional
   * (we undercount, so we undercharge, while the ratio reports cost recovery).
   */
  costMicroUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cached: 0 | 1 | null;
  occurredAt: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

/**
 * Turn one log row into a usage row, or null when it is unusable.
 *
 * ATTRIBUTION IS READ OFF THE ROW, never inferred from the fact that a server-side filter returned
 * it. The gateway metadata filter takes metadata.key and metadata.value as SEPARATE dimensions, and
 * whether they evaluate as a matched PAIR or as two independent conditions could not be proven
 * against the two rows that exist. If independent, a filter could match a row whose tenant_id is
 * NOT the one asked for, and one tenant spend would be attributed to another. So the filter is a
 * narrowing optimisation only and this function is the sole source of truth for whose row it is.
 * That holds whether or not the filter semantics are ever settled.
 *
 * A row with no usable id or timestamp is dropped and COUNTED as dropped by the caller: an
 * unparseable row is a gap in the meter, not a zero.
 */
export function parseLogRow(row: GatewayLogRow): SpendEvent | null {
  const sourceId = str(row?.id);
  const occurredAt = str(row?.created_at);
  if (!sourceId || !occurredAt) return null;
  // A row we cannot price is KEPT with a null cost, not dropped. Dropping it is the same silent
  // under-count one layer up: the request happened and the money moved whether or not we can put a
  // number on it. Recorded, visible, and unbillable beats absent.
  const costMicroUsd = toMicroUsd(row.cost);
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : null;
  return {
    source: "ai_gateway",
    sourceId,
    tenantId: meta ? str(meta.tenant_id) : null,
    slug: meta ? str(meta.slug) : null,
    model: str(row.model),
    costMicroUsd,
    tokensIn: num(row.tokens_in),
    tokensOut: num(row.tokens_out),
    cached: typeof row.cached === "boolean" ? (row.cached ? 1 : 0) : null,
    occurredAt,
  };
}

/** The newest occurred_at in a batch, for advancing the watermark. Pure. */
export function newestOccurredAt(events: SpendEvent[]): string | null {
  let best: string | null = null;
  for (const e of events) if (best === null || e.occurredAt > best) best = e.occurredAt;
  return best;
}

export type RollupStatus = "complete" | "incomplete" | "failed";

export interface RollupResult {
  status: RollupStatus;
  controlPassed: boolean;
  /** True when rows were deleted unread (retention), which is NOT the same as unfinished. */
  gapDetected: boolean;
  events: SpendEvent[];
  rowsSeen: number;
  rowsDropped: number;
  newWatermark: string | null;
  note: string;
}

/**
 * Page the gateway from the watermark forward.
 *
 * pageCap bounds a single run so one invocation cannot walk an unbounded backlog; hitting it is
 * reported as `incomplete` and LOGGED, never silently truncated. A capped run that reported
 * `complete` would tell a consumer it had the whole window when it did not.
 */
export async function collectSince(
  reader: GatewayLogReader,
  after: string | undefined,
  pageCap: number,
  perPage: number = MAX_PER_PAGE,
): Promise<{ events: SpendEvent[]; rowsSeen: number; rowsDropped: number; exhausted: boolean }> {
  const events: SpendEvent[] = [];
  let rowsSeen = 0;
  let rowsDropped = 0;
  let exhausted = false;
  for (let page = 1; page <= pageCap; page++) {
    const got = await reader.list({ after, page, perPage });
    const rows = got.rows ?? [];
    rowsSeen += rows.length;
    for (const r of rows) {
      const e = parseLogRow(r);
      if (e) events.push(e);
      else rowsDropped++;
    }
    if (rows.length < perPage) {
      exhausted = true;
      break;
    }
  }
  return { events, rowsSeen, rowsDropped, exhausted };
}

/**
 * One roll-up run, as a pure decision over an injected reader.
 *
 * THE POSITIVE CONTROL RUNS FIRST AND EVERY TIME. An unfiltered probe must report a non-zero total
 * before any narrowed result is trusted. If the probe reports zero, we genuinely cannot tell an
 * empty gateway from a broken read, so the run is recorded with controlPassed=false and the
 * consumer treats the period as UNBILLABLE rather than as zero spend. That is the difference
 * between "we know nothing happened" and "we learned nothing".
 */
export async function runRollup(
  reader: GatewayLogReader,
  after: string | undefined,
  pageCap = 200,
): Promise<RollupResult> {
  let probed: { total: number | null; oldest: string | null };
  try {
    probed = await reader.probe();
  } catch (e) {
    return {
      status: "failed", controlPassed: false, gapDetected: false, events: [], rowsSeen: 0,
      rowsDropped: 0, newWatermark: null,
      note: "positive control threw, so nothing read is evidence: " + (e as Error).message,
    };
  }
  const total = probed.total;
  const controlPassed = typeof total === "number" && total > 0;
  // Rows deleted unread. Only meaningful once we HAVE a watermark: a first run has no gap by
  // definition, it simply has no history.
  const gapDetected = Boolean(after && probed.oldest && probed.oldest > after);

  let collected;
  try {
    collected = await collectSince(reader, after, pageCap);
  } catch (e) {
    return {
      status: "failed", controlPassed, gapDetected, events: [], rowsSeen: 0, rowsDropped: 0,
      newWatermark: null, note: "paging failed: " + (e as Error).message,
    };
  }

  // A gap makes the window incomplete even when the page walk finished: we read everything still
  // THERE, which is not the same as everything that HAPPENED.
  const status: RollupStatus =
    collected.exhausted && !gapDetected ? "complete" : "incomplete";
  const notes: string[] = [];
  if (!controlPassed) {
    notes.push(
      "POSITIVE CONTROL FAILED: an unfiltered probe reported " + String(total) + ". An empty read " +
        "is indistinguishable from wrong-gateway, wrong-account or no-permission, so this period " +
        "is UNBILLABLE rather than zero.",
    );
  }
  if (!collected.exhausted) {
    notes.push("page cap " + pageCap + " reached before exhaustion; window is PARTIAL and RESUMABLE.");
  }
  if (gapDetected) {
    notes.push(
      "GAP: the oldest row still in the gateway (" + String(probed.oldest) + ") is newer than the " +
        "watermark (" + String(after) + "), so rows between them were deleted UNREAD and are gone. " +
        "Not resumable; this is retention loss, not an unfinished walk.",
    );
  }
  const unpriced = collected.events.filter((e) => e.costMicroUsd === null).length;
  if (unpriced > 0) {
    notes.push(
      unpriced + " row(s) carried no usable cost and were kept with a NULL cost, never 0: a row we " +
        "cannot price is recorded and unbillable rather than silently free.",
    );
  }
  if (collected.rowsDropped > 0) {
    notes.push(collected.rowsDropped + " row(s) unparseable and dropped; that is a gap, not a zero.");
  }
  const unattributed = collected.events.filter((e) => e.tenantId === null).length;
  if (unattributed > 0) {
    notes.push(
      unattributed + " row(s) carried no cf-aig-metadata and are UNATTRIBUTED. Written with a null " +
        "tenant, never spread: a rising count means the emitter regressed.",
    );
  }

  return {
    status,
    controlPassed,
    gapDetected,
    events: collected.events,
    rowsSeen: collected.rowsSeen,
    rowsDropped: collected.rowsDropped,
    newWatermark: newestOccurredAt(collected.events),
    note: notes.join(" "),
  };
}
