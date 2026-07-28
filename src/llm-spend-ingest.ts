// cp#185 part two: the TRIGGER's body. One roll-up run, from watermark to written rows.
//
// runRollup (llm-spend-rollup.ts) decides WHAT was read and how much of it is trustworthy. This
// file is the part that persists that decision, and its whole job is to make sure the persisted
// record can never claim more than the read actually earned.

import type { GatewayLogReader, RollupResult, SpendEvent } from "./llm-spend-rollup";
import { runRollup } from "./llm-spend-rollup";

/**
 * Pages per run. 40 * 50 = 2,000 log rows, which at the hosted Opus call rate is many hours of
 * backlog per five-minute run, and is well inside a Worker's subrequest budget with room for the
 * probe and the writes. A run that hits the cap reports `incomplete` and RESUMES next time from the
 * advanced watermark; it never silently truncates. Bounded deliberately: an unbounded walk on a
 * cold start would exhaust the invocation and leave a period row with no events under it.
 */
export const DEFAULT_PAGE_CAP = 40;

export interface RollupPeriodWrite {
  id: string;
  windowStart: string;
  windowEnd: string;
  status: RollupResult["status"];
  controlPassed: boolean;
  gapDetected: boolean;
  startedAt: string;
}

export interface LlmSpendStore {
  /** The ingestion cursor, or null on a virgin plane. */
  readLlmWatermark(source: string): Promise<string | null>;
  /**
   * The newest window_end ever recorded, which is the previous run's instant. Null before the first
   * run. Periods therefore TILE by construction: this run's window_start is the last one's
   * window_end, with no arithmetic and no configured interval that could disagree with the cron.
   */
  readLastPeriodEnd(): Promise<string | null>;
  /** Insert the period row with finished_at NULL. Its events have nothing to reference until it exists. */
  openLlmRollupPeriod(period: RollupPeriodWrite): Promise<void>;
  /** INSERT OR IGNORE the events under a period. Returns how many rows the engine actually wrote. */
  writeLlmSpendEvents(periodId: string, events: SpendEvent[], insertedAt: string): Promise<number>;
  /** Stamp finished_at and the TRUE ingested count. Only now is the period an observation. */
  closeLlmRollupPeriod(periodId: string, rowsIngested: number, finishedAt: string): Promise<void>;
  /** Advance the cursor. Callers must not call this when nothing trustworthy was read. */
  advanceLlmWatermark(source: string, lastSeenAt: string, updatedAt: string): Promise<void>;
}

export interface IngestOutcome {
  periodId: string;
  windowStart: string;
  windowEnd: string;
  status: RollupResult["status"];
  controlPassed: boolean;
  gapDetected: boolean;
  rowsSeen: number;
  rowsDropped: number;
  eventsWritten: number;
  watermarkBefore: string | null;
  watermarkAfter: string | null;
  note: string;
}

export interface IngestDeps {
  store: LlmSpendStore;
  reader: GatewayLogReader;
  now(): number;
  newId(): string;
  pageCap?: number;
}

const SOURCE = "ai_gateway";

/**
 * Run the roll-up once and record it.
 *
 * WRITE ORDER IS THE CRASH-SAFETY ARGUMENT, not a style choice:
 *
 *   1. open the period  (finished_at NULL, rows_ingested 0)
 *   2. write the events (INSERT OR IGNORE, idempotent on (source, source_id))
 *   3. close the period (finished_at + the TRUE count)
 *   4. advance the watermark
 *
 * Die anywhere and the record is honestly worse than the truth rather than better. Die after 1: an
 * unfinished period, which summariseWindow reads as incomplete. Die after 2: same, and the events
 * are already there so the retry writes nothing new. Die after 3: the watermark did not move, so the
 * next run re-reads the same rows and INSERT OR IGNORE drops every one of them.
 *
 * The reverse order would produce the one shape we cannot tolerate: a finished period claiming a
 * count it never wrote, or a watermark past rows nobody stored, which is a silent permanent
 * under-count with nothing anywhere to indicate it happened.
 */
export async function ingestLlmSpend(deps: IngestDeps): Promise<IngestOutcome> {
  const startedAt = new Date(deps.now()).toISOString();
  const watermarkBefore = await deps.store.readLlmWatermark(SOURCE);
  const lastEnd = await deps.store.readLastPeriodEnd();

  const result = await runRollup(
    deps.reader,
    watermarkBefore ?? undefined,
    deps.pageCap ?? DEFAULT_PAGE_CAP,
  );

  const period: RollupPeriodWrite = {
    id: deps.newId(),
    // The FIRST run's window is zero-width, and that is correct rather than a degenerate case: no
    // billing window before the meter existed was ever observed, so none of them may be called
    // complete. The backfill this run ingests is still attributed to it, because a period belongs
    // to the billing window containing its window_end (llm-spend-window.ts), and a zero-width
    // period has one.
    windowStart: lastEnd ?? startedAt,
    windowEnd: startedAt,
    status: result.status,
    controlPassed: result.controlPassed,
    gapDetected: result.gapDetected,
    startedAt,
  };
  await deps.store.openLlmRollupPeriod(period);

  const eventsWritten = result.events.length
    ? await deps.store.writeLlmSpendEvents(period.id, result.events, startedAt)
    : 0;

  await deps.store.closeLlmRollupPeriod(
    period.id,
    eventsWritten,
    new Date(deps.now()).toISOString(),
  );

  // THE WATERMARK ADVANCES ONLY ON A PASSED CONTROL.
  //
  // A page walk that succeeded against a gateway whose unfiltered total is zero read nothing and
  // proved nothing; result.newWatermark is null in that case anyway, but the condition is stated
  // rather than inherited, because inheriting it would make this correct only by accident of
  // another function's return value. The cost of NOT advancing on a bad run is re-reading rows we
  // already have, which is free. The cost of advancing on one is skipping rows forever.
  //
  // Advancing on an INCOMPLETE (page-capped) run IS correct and deliberate: the walk is ascending,
  // so a capped run read a contiguous PREFIX, and the newest row it saw is a true resume point.
  let watermarkAfter = watermarkBefore;
  if (result.controlPassed && result.newWatermark) {
    await deps.store.advanceLlmWatermark(
      SOURCE,
      result.newWatermark,
      new Date(deps.now()).toISOString(),
    );
    watermarkAfter = result.newWatermark;
  }

  return {
    periodId: period.id,
    windowStart: period.windowStart,
    windowEnd: period.windowEnd,
    status: result.status,
    controlPassed: result.controlPassed,
    gapDetected: result.gapDetected,
    rowsSeen: result.rowsSeen,
    rowsDropped: result.rowsDropped,
    eventsWritten,
    watermarkBefore,
    watermarkAfter,
    note: result.note,
  };
}
