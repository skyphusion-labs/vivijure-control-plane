// Harvest the RunPod job -> tenant index out of a tenant's own database (cp#270, for vivijure-cf#225).
//
// READ-ONLY against the tenant. Nothing here writes to a tenant database, and no tenant worker
// writes to ours: the control plane already holds every `d1_database_id` because it created them, so
// the index is built by READING rather than by tenants pushing. See migration 0019 for why that
// shape was chosen over a hot-path write.
//
// THE PROPERTY THAT MAKES IT CORRECT RATHER THAN MERELY CHEAP: a tenant's database dies at teardown,
// which is exactly the moment this index becomes the only surviving record. A periodic sweep alone
// would therefore have a permanent hole -- every job between the last sweep and the deletion. So the
// harvest is also a MANDATORY, ORDERED STEP IN TEARDOWN, ahead of the D1 delete, and a harvest that
// cannot be proven complete FAILS the teardown. That converts a race into a guarantee.

import type { CfApi } from "./cf-api";

/**
 * The table this reads, created by vivijure-cf migration 0014 in the TENANT studio database.
 *
 * Named as a constant because two separate things depend on the exact string: the existence probe
 * below and the SELECT. A typo in one and not the other would make a tenant with a healthy job log
 * look like a tenant with no table, which is the reassuring answer and the wrong one.
 */
export const TENANT_JOB_LOG_TABLE = "runpod_job_log";

/**
 * How many rows one harvest will read.
 *
 * A CEILING, NOT A PAGE SIZE, and it is deliberately not paginated. A harvest that hits this cap has
 * NOT read the whole log, and the honest thing to do with a partial read is refuse to call it a
 * harvest -- not to quietly index the first N and report success. `complete` below carries that, and
 * teardown treats an incomplete harvest as a failure rather than as progress.
 *
 * Set high enough that no realistic tenant reaches it (the busiest tenant to date has produced job
 * rows in the low hundreds) and low enough that one query cannot exhaust a Worker's memory or its
 * subrequest time budget. If a real tenant ever trips it, that is a signal to add paging, and it
 * will arrive as a loud teardown failure rather than as a silently truncated index.
 */
export const HARVEST_ROW_CAP = 5_000;

/** One harvested job row, as the index stores it. Ids and machine labels only. */
export interface HarvestedJob {
  job_id: string;
  module: string | null;
  outcome: string | null;
  submitted_at: number | null;
  terminal_at: number | null;
}

export interface HarvestResult {
  /**
   * True only when the whole log was read.
   *
   * NOT decoration, and not derivable from `rows.length` by a caller: a read that hit the cap and a
   * read that happened to return exactly that many rows are indistinguishable from the outside. A
   * caller that must not proceed on a partial read (teardown) branches on THIS.
   */
  complete: boolean;
  rows: HarvestedJob[];
  /**
   * True when the tenant database has no `runpod_job_log` table at all.
   *
   * A DISTINCT STATE FROM "no rows", and collapsing them would be the defect. A half-provisioned
   * tenant whose migrations never ran has no table, and that is a complete and correct harvest of
   * nothing -- it must not fail a rollback teardown. A tenant WITH the table and zero rows is also
   * complete, and means something different (it ran and submitted nothing). Both are `complete`;
   * only this flag tells them apart, and only for a human reading the log line.
   */
  tableAbsent: boolean;
}

/** D1 returns `[{ results: [...] }]`; mirrors the parser in migrate.ts rather than re-deriving it. */
function rowsOf(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of raw) {
    const results = (entry as { results?: unknown } | null)?.results;
    if (Array.isArray(results)) out.push(...(results as Record<string, unknown>[]));
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Read one tenant's job log.
 *
 * ASKS ABOUT THE TABLE BY DATA, NEVER BY ERROR TEXT. The obvious implementation is to run the SELECT
 * and treat a "no such table" error as absence, which makes the classification depend on a vendor
 * error string that is free to change and that also matches genuinely broken states. vivijure-cf hit
 * exactly this and fixed it the same way (`probeRunpodJobLog`): ask `sqlite_master`, which answers
 * with a row or no rows, and let every OTHER failure be a failure.
 */
export async function harvestTenantJobLog(
  cf: Pick<CfApi, "queryD1">,
  databaseId: string,
  cap: number = HARVEST_ROW_CAP,
): Promise<HarvestResult> {
  const present = rowsOf(
    await cf.queryD1(databaseId, "SELECT name FROM sqlite_master WHERE type = ?1 AND name = ?2;", [
      "table",
      TENANT_JOB_LOG_TABLE,
    ]),
  );
  if (present.length === 0) return { complete: true, rows: [], tableAbsent: true };

  // cap + 1 is how the ceiling is DETECTED rather than assumed. Selecting exactly `cap` rows cannot
  // distinguish "there were cap" from "there were more"; one extra row makes the difference
  // observable, and the extra row is discarded.
  const raw = rowsOf(
    await cf.queryD1(
      databaseId,
      "SELECT job_id, module, outcome, submitted_at, terminal_at FROM runpod_job_log " +
        "ORDER BY submitted_at ASC LIMIT ?1;",
      [cap + 1],
    ),
  );
  const complete = raw.length <= cap;
  const rows: HarvestedJob[] = [];
  for (const r of raw.slice(0, cap)) {
    const jobId = str(r.job_id);
    // A row with no job id indexes nothing: the id IS the key the whole table exists to provide.
    // Skipped rather than stored with a null key, and it cannot happen (job_id is the PRIMARY KEY
    // upstream) which is exactly why it is worth being explicit instead of trusting the shape.
    if (!jobId) continue;
    rows.push({
      job_id: jobId,
      module: str(r.module),
      outcome: str(r.outcome),
      submitted_at: int(r.submitted_at),
      terminal_at: int(r.terminal_at),
    });
  }
  return { complete, rows, tableAbsent: false };
}
