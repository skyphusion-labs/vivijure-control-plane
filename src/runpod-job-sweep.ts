// The backstop for every push that did not arrive (cp#290).
//
// ------------------------------------------------------------------------------------------------
// NOT `reconcile-runpod.ts`, AND THE NAME IS DELIBERATE.
//
// That file already exists and is a different thing: the endpoint INVENTORY reconciler (cp#137),
// detection-only, whose RunPod side arrives as a snapshot an operator gathered with their own key.
// Its header says "cp#137 rules out a background poller: a poller needs a credential we refuse to
// hold" -- and that is CORRECT THERE and does not bind this file.
//
// The difference is whose account is being read. cp#137 is about a TENANT's RunPod account, where
// key A is never stored and key B is transient, so the plane genuinely cannot poll. THIS sweep asks
// about OUR pool endpoints with OUR pool key, which the plane now holds by construction because the
// proxy holds it. Same vendor, different custody, opposite conclusion. Named differently so nobody
// reads that refusal as covering this.
// ------------------------------------------------------------------------------------------------
//
// WHY IT IS LOAD-BEARING RATHER THAN TIDY. Every failure path in the proxy ends "the reconciler
// picks it up", and until this existed, none of them did -- each was PERMANENT rather than
// transient:
//
//   - the raced callback (our authoritative read said not-terminal, so nothing was written);
//   - a failed index write at submit (row never opened; the tenant-side harvest is the other net);
//   - a callback that never arrived at all -- INCLUDING the unmeasured case that RunPod may not
//     fire the webhook on COMPLETED. All three 2a probe jobs terminated FAILED or CANCELLED, so
//     firing-on-success is INFERRED. If it does not fire, every successful job stays open forever
//     and this sweep is the only thing that would ever notice.
//
// IT DOES NOT SHARE THE GATE IT BACKSTOPS. The push path is the callback route; this runs on the
// cron, reads its own rows, and issues its own upstream requests. A backstop guarded by the
// condition it exists to catch is not a backstop.

import {
  OBSERVED_RESULT_RETENTION_MS,
  RECONCILER_ADOPT_AFTER_MS,
  RUNPOD_HOST,
  terminalFactsFromStatus,
} from "./runpod-proxy";
import type { ControlPlaneStore, OpenProxyJob } from "./store";

/** Bounded per run: a sweep is a cron tick, not a batch job, and a Worker has a request budget.
 *  The cap is REPORTED against the true open count so a truncated run cannot read as a complete
 *  one -- that is the whole reason `countOpenRunpodProxyJobs` exists beside the list. */
export const SWEEP_MAX_ROWS_PER_RUN = 50;

export interface JobSweepDeps {
  fetchImpl: typeof fetch;
  runpodApiKey: () => Promise<string>;
  store: Pick<
    ControlPlaneStore,
    "listOpenRunpodProxyJobs" | "countOpenRunpodProxyJobs" | "closeRunpodProxyJob"
  >;
  now(): number;
}

/**
 * What one sweep did. EVERY BUCKET IS REPORTED, including the ones that are zero on a healthy run.
 *
 * A sweep that resolved nothing exits clean and is indistinguishable from a sweep that had nothing
 * to do -- so `examined` is the denominator and `eligible` is what existed before the cap. Their
 * difference is work deferred to the next tick, and it is printed rather than implied.
 */
export interface JobSweepResult {
  ran: boolean;
  reason?: string;
  /** Open proxy rows past the adopt delay, BEFORE the per-run cap. */
  eligible: number;
  /** How many this run actually asked RunPod about. */
  examined: number;
  /** Closed with real terminal facts we read ourselves. */
  closed: number;
  /** Closed as `unknown`: RunPod no longer has it AND it is past the retention horizon. */
  unknown: number;
  /** Still running as far as RunPod is concerned. Left open, correctly. */
  stillRunning: number;
  /** We could not find out. LEFT OPEN, never closed as anything. */
  errors: number;
}

/** What asking RunPod about one job told us. Kept as a closed vocabulary so the decision below is a
 *  switch over states rather than a chain of ifs over HTTP status codes. */
type Probe =
  | { kind: "terminal"; status: unknown }
  | { kind: "running" }
  /** RunPod does not have this job. Note this is NOT on its own a licence to write `unknown`. */
  | { kind: "gone" }
  | { kind: "error"; detail: string };

async function probeJob(deps: JobSweepDeps, key: string, job: OpenProxyJob): Promise<Probe> {
  let resp: Response;
  try {
    resp = await deps.fetchImpl(
      `${RUNPOD_HOST}/v2/${encodeURIComponent(job.endpoint_id)}/status/${encodeURIComponent(job.job_id)}`,
      { headers: { authorization: "Bearer " + key } },
    );
  } catch (e) {
    return { kind: "error", detail: String(e) };
  }
  // 404 is the only status treated as absence. Every other non-2xx -- 401, 429, 5xx -- is a failure
  // to LEARN, not evidence about the job, and must not move the row.
  if (resp.status === 404) return { kind: "gone" };
  if (!resp.ok) return { kind: "error", detail: "upstream status " + resp.status };
  let body: unknown;
  try {
    body = await resp.json();
  } catch (e) {
    return { kind: "error", detail: "unreadable body: " + String(e) };
  }
  return terminalFactsFromStatus(job.job_id, body) ? { kind: "terminal", status: body } : { kind: "running" };
}

/**
 * One sweep.
 *
 * THE DIRECTION OF EVERY FAILURE IS THE SAME: leave the row OPEN. An open row says "nobody knows"
 * out loud; a wrongly-closed row asserts something nobody observed, and on a billing path that is
 * the more expensive mistake by a wide margin. So the only two ways a row is ever closed here are
 * (a) we read a terminal status ourselves, or (b) TWO independent conditions agree that it can
 * never be answered.
 */
export async function runRunpodJobSweep(deps: JobSweepDeps): Promise<JobSweepResult> {
  const empty = { eligible: 0, examined: 0, closed: 0, unknown: 0, stillRunning: 0, errors: 0 };

  let key: string;
  try {
    key = await deps.runpodApiKey();
  } catch (e) {
    return { ran: false, reason: "credential_unavailable: " + String(e), ...empty };
  }
  // REFUSES rather than reports a clean sweep. A plane with no pool credential cannot ask RunPod
  // anything, and a run that examined nothing because it COULD not must never look like a run that
  // examined nothing because there was nothing to do.
  if (!key) return { ran: false, reason: "credential_unavailable", ...empty };

  const now = deps.now();
  // Never race a working push: a row younger than the adopt delay may still have a callback in
  // flight (the measured push-delivery window is ~20s, and this is 5 minutes).
  const before = now - RECONCILER_ADOPT_AFTER_MS;

  const eligible = await deps.store.countOpenRunpodProxyJobs(before);
  const rows = await deps.store.listOpenRunpodProxyJobs(before, SWEEP_MAX_ROWS_PER_RUN);

  const result: JobSweepResult = { ran: true, ...empty, eligible, examined: rows.length };

  for (const job of rows) {
    const probe = await probeJob(deps, key, job);

    if (probe.kind === "error") {
      result.errors += 1;
      console.error("runpod_sweep.probe_failed", JSON.stringify({ job: job.job_id, detail: probe.detail }));
      continue;
    }
    if (probe.kind === "running") {
      result.stillRunning += 1;
      continue;
    }
    if (probe.kind === "terminal") {
      const facts = terminalFactsFromStatus(job.job_id, probe.status)!;
      // The SAME guarded write the callback path uses, so a sweep racing a late callback is a
      // no-op rather than a second write. `changes === 0` is normal here, not an error.
      const changes = await deps.store.closeRunpodProxyJob({
        job_id: facts.jobId,
        outcome: facts.outcome,
        status_raw: facts.statusRaw,
        execution_ms: facts.executionMs,
        delay_ms: facts.delayMs,
        terminal_at: now,
      });
      if (changes === 1) result.closed += 1;
      console.log(
        "runpod_sweep.adopted",
        JSON.stringify({ job: job.job_id, outcome: facts.outcome, first_write: changes === 1 }),
      );
      continue;
    }

    // GONE. Two conditions must agree before this becomes a terminal, and they are independent:
    // RunPod says it does not have the job, AND the row is old enough that the working figure for
    // result retention explains the absence. If EITHER is wrong we leave the row open, which is why
    // a 404 from a mistyped endpoint or a wrong retention number cannot manufacture an outcome.
    const age = job.submitted_at === null ? null : now - job.submitted_at;
    const pastHorizon = age !== null && age > OBSERVED_RESULT_RETENTION_MS;
    if (!pastHorizon) {
      result.errors += 1;
      console.error(
        "runpod_sweep.gone_but_young",
        JSON.stringify({
          job: job.job_id,
          age_ms: age,
          note: "RunPod does not have this job but it is inside the retention window; left OPEN",
        }),
      );
      continue;
    }
    const changes = await deps.store.closeRunpodProxyJob({
      job_id: job.job_id,
      outcome: "unknown",
      // The vendor said nothing, so we record nothing rather than inventing a status string.
      status_raw: "",
      // NULL, never 0: nobody measured this job's duration and a zero would claim someone did.
      execution_ms: null,
      delay_ms: null,
      terminal_at: now,
    });
    if (changes === 1) result.unknown += 1;
    console.error(
      "runpod_sweep.unknown",
      JSON.stringify({ job: job.job_id, age_ms: age, first_write: changes === 1 }),
    );
  }

  // ALWAYS LOGGED, including a clean run, and at error level when anything was left unresolved --
  // an operator's log filter is the only place a rising `unknown` count or a permanently deferred
  // backlog becomes visible.
  const clean = result.errors === 0 && result.unknown === 0 && result.eligible === result.examined;
  (clean ? console.log : console.error)("runpod_sweep.tick", JSON.stringify(result));
  return result;
}
