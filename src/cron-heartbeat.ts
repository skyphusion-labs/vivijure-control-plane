/**
 * CRON LIVENESS (cp#436).
 *
 * THE PROBLEM THIS SOLVES IS A FALSE NEGATIVE, not a missing feature. The scheduled handler runs
 * three halves and every one of them reports to console only, so the cron cannot be observed from
 * outside the Worker. If it stops firing, every symptom is an ABSENCE: no meter periods, no RunPod
 * sweep, no provision drives. An absence is indistinguishable from an idle plane, and since cp#429
 * the cron is the ONLY engine that drives an operator-provisioned tenant to a studio -- so a dead
 * cron means no customer ever gets a studio and the product reports provisioning forever.
 *
 * TWO REQUIREMENTS, and both are about the record being able to say something bad.
 *
 * 1. IT MUST BE ABLE TO GO RED. A heartbeat that only ever records success is not a control, it is
 *    a decoration. So a half is recorded ok:false with the reason, and a half that REFUSED (no
 *    credential, no reader) is not ok either -- a run that examined nothing because it COULD not
 *    must never read like a run that examined nothing because there was nothing to do. That is the
 *    same rule runpod-job-sweep already applies to itself; this is it applied one level up.
 *
 * 2. NEVER-RAN AND RAN-AND-FOUND-NOTHING MUST NOT READ ALIKE. A clean tick over an empty candidate
 *    list still stamps the row, so the presence of the row is the evidence the handler executed.
 *    Absence of the row means the handler has not run since the setting was introduced, and that
 *    is reported as ran:false rather than as a healthy quiet plane.
 *
 * WHY A SETTINGS ROW rather than an audit entry: the audit trail records OPERATOR actions and the
 * cron is not an operator, so a tick every 5 minutes would bury the rows that trail exists for
 * under 288 machine rows a day. A single overwritten key costs one upsert per tick and keeps the
 * trail readable.
 */

/** The registered schedule. Kept here so the staleness threshold derives from it, not from a guess. */
export const CRON_TICK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * THREE missed ticks, not one. A single miss is within the noise of scheduler jitter and a cold
 * start, and a control that cries on ordinary jitter gets ignored, which costs more than it buys.
 * Three consecutive misses is not jitter.
 */
export const CRON_STALE_AFTER_MS = 3 * CRON_TICK_INTERVAL_MS;

export const CRON_HEARTBEAT_KEY = "cron.last_tick";

/** Not a person. setSetting records an actor, and attributing a machine write to an operator would
 * put a lie in the settings table. */
export const CRON_HEARTBEAT_ACTOR = "system:cron";

export type TickHalfName = "llm_meter" | "runpod_sweep" | "provision_drive";

export const TICK_HALVES: readonly TickHalfName[] = ["llm_meter", "runpod_sweep", "provision_drive"];

export interface TickHalfRecord {
  /** false covers BOTH a throw and an honest refusal. See requirement 1 above. */
  ok: boolean;
  /** Why it is not ok, or what it did. Present on the unhappy path; that is the whole point. */
  detail?: string;
}

export interface TickHeartbeat {
  at: string;
  ok: boolean;
  halves: Record<TickHalfName, TickHalfRecord>;
}

/** What an operator reads. Every field answers a question the console logs could not. */
export interface CronLiveness {
  /** Has the handler executed at all since the heartbeat existed. */
  ran: boolean;
  at: string | null;
  age_seconds: number | null;
  /** The red light. True whenever the record cannot vouch for a recent healthy tick. */
  stale: boolean;
  /** All three halves ok on the last tick. null when there is no last tick to speak for. */
  ok: boolean | null;
  halves: Record<TickHalfName, TickHalfRecord> | null;
  /** Why the answer is what it is, in words, when it is not a plain healthy read. */
  detail?: string;
}

/**
 * Turn the stored row into the operator view. PURE, and separate from the route, because the
 * interesting behaviour is entirely in the edge cases and a pure function lets a test drive them
 * directly instead of through a request.
 *
 * EVERY UNHAPPY BRANCH RETURNS stale:true. That is deliberate and it is the safe direction: this
 * function reports on an instrument, and an instrument that cannot account for itself must read
 * BROKEN, never SILENT. A missing row, a corrupt row and a row from the future are all states
 * where we do not know that the cron is alive, and the one answer that must never be produced from
 * not-knowing is a green one.
 */
export function summarizeCronLiveness(raw: string | null, nowMs: number): CronLiveness {
  const never: CronLiveness = {
    ran: false,
    at: null,
    age_seconds: null,
    stale: true,
    ok: null,
    halves: null,
  };

  if (raw === null || raw.trim() === "") {
    return { ...never, detail: "no tick has ever been recorded: the scheduled handler has not run since this heartbeat was deployed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // NOT the same as never-ran, and not healthy either. Something wrote a row we cannot read, and
    // reporting that as a quiet plane would hide a bug in the writer behind a green light.
    return { ...never, detail: "heartbeat row is present but unparseable" };
  }

  const row = parsed as Partial<TickHeartbeat>;
  const at = typeof row.at === "string" ? row.at : null;
  const atMs = at === null ? NaN : Date.parse(at);
  if (!Number.isFinite(atMs)) {
    return { ...never, detail: "heartbeat row carries no readable timestamp" };
  }

  const ageMs = nowMs - atMs;
  const halves = (row.halves ?? null) as Record<TickHalfName, TickHalfRecord> | null;
  const ok = typeof row.ok === "boolean" ? row.ok : null;

  // A timestamp in the future is a broken clock or a broken writer, and it would otherwise read as
  // the freshest possible tick -- the failure mode that looks healthiest. One interval of tolerance
  // absorbs ordinary skew between the D1 write and the reader.
  if (ageMs < -CRON_TICK_INTERVAL_MS) {
    return {
      ran: true,
      at,
      age_seconds: Math.round(ageMs / 1000),
      stale: true,
      ok,
      halves,
      detail: "heartbeat timestamp is in the future: clock skew or a bad write, not a fresh tick",
    };
  }

  const late = ageMs > CRON_STALE_AFTER_MS;
  return {
    ran: true,
    at,
    age_seconds: Math.round(ageMs / 1000),
    // RED on a late tick OR on an unhealthy one. Two different faults, one light, because the
    // question an operator asks is is the cron ok and both answers to it are no.
    stale: late || ok === false,
    ok,
    halves,
    ...(late ? { detail: "last tick is older than " + String(CRON_STALE_AFTER_MS / 60000) + " minutes" } : {}),
  };
}
