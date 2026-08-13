import type { JobLogReadiness } from "../src/tenant-modules";

// The reading-convergence criteria for the pre-deploy smoke, as PURE functions (cp#255).
//
// Extracted so the live loops and the unit test share ONE definition. A copy of the logic under
// test is not a test of the logic; the smoke's loops call exactly these functions.
//
// TWO criteria live here, and the OLD ONE IS KEPT DELIBERATELY so its defect stays executable
// rather than becoming a story. See tests/settle-criterion.test.ts, which replays the three real
// measured sequences through both.

/** A reading that never reached the module: a dispatch-door transport failure. Never a value. */
export const NO_ANSWER = "x" as const;

/**
 * The module answered with a job_log value this plane does not recognise (cp#378).
 *
 * DISTINCT FROM null ON PURPOSE, and this is the whole cross-repo tripwire. `JobLogReadiness`
 * is defined in vivijure-cf and nothing in this repo can notice it being renamed. If a rename
 * collapsed to null here, the smoke would report "this image predates cf#279" and send an
 * operator to bump `modules_release` -- a remedy that cannot work, for a cause that is not real.
 * That is the exact defect cp#378 was filed for, so the gate must not be able to commit it.
 */
export const UNRECOGNISED = "!" as const;

/**
 * A single /ready reading.
 *
 * `boolean` IS STILL IN THIS UNION AND IT IS NOT DEAD WEIGHT. vivijure-cf v1.13.0 shipped
 * `telemetry: { job_log: Boolean(env.TELEMETRY_DB) }` in five modules and was a real published
 * studio release (measured: 5 boolean emissions at v1.13.0, 0 at v1.23.0). The measured
 * sequences below are that wire shape, recorded before the string existed, and they are kept
 * VERBATIM rather than translated -- rewriting measured evidence into the new vocabulary would
 * make it agree with today by construction, and it is only evidence because it does not.
 */
export type Reading = JobLogReadiness | boolean | null | typeof NO_ANSWER | typeof UNRECOGNISED;

export function render(seq: Reading[]): string {
  return seq
    .map((x) => {
      if (x === NO_ANSWER) return "x";
      if (x === UNRECOGNISED) return "!";
      if (x === null) return "n";
      if (x === "ok") return "o";
      if (x === "unavailable") return "u";
      if (x === "unknown") return "?";
      return x ? "T" : "F"; // legacy booleans, pre-815c9ff0
    })
    .join("");
}

/**
 * THE OLD CRITERION: `need` consecutive identical readings, whatever they are.
 *
 * KEPT ONLY SO ITS DEFECT CAN BE DEMONSTRATED. It proves STABILITY, and on the REPLACE path a stale
 * isolate serving the previous version is perfectly stable. Correct for a FIRST upload, where the
 * script name never existed and nothing stale can answer. Wrong for a replace.
 */
export function settledValue(
  seq: Reading[],
  need: number,
): { settled: boolean; value: Exclude<Reading, typeof NO_ANSWER> | null } {
  let run = 0;
  let last: Reading | undefined;
  for (const v of seq) {
    if (v === NO_ANSWER) {
      run = 0;
      last = v;
      continue;
    }
    run = v === last ? run + 1 : 1;
    last = v;
    if (run >= need) return { settled: true, value: v as Exclude<Reading, typeof NO_ANSWER> };
  }
  return { settled: false, value: null };
}

/**
 * THE CRITERION FOR A REPLACE: has the reading REACHED `want` and held it for `need` reads.
 *
 * Asymmetric on purpose. Replacing a module that HAD the binding with one that does not:
 *   - the NEGATIVE value ("unavailable"; `false` on a pre-815c9ff0 image) can only come from the
 *     NEW version, so seeing it is proof the new bytes are served.
 *   - the POSITIVE value ("ok" / `true`) is ambiguous between a stale old isolate and a genuinely
 *     broken new one, and no amount of repetition resolves that, so it must never terminate the
 *     wait.
 *
 * THE ARGUMENT IS ABOUT WHICH VALUE THE REPLACED VERSION COULD HAVE PRODUCED, not about the type
 * of the value, so it survived the boolean-to-string change unchanged. That is why `want` is a
 * Reading rather than a boolean: the criterion was never about booleans.
 *
 * Stability is still required after the wanted value appears: a single sighting mid-flap is not
 * convergence, as run 1 below shows (false at index 1, true again at index 2).
 */
export function reached(seq: Reading[], want: Reading, need: number): boolean {
  let run = 0;
  for (const v of seq) {
    run = v === want ? run + 1 : 0;
    if (run >= need) return true;
  }
  return false;
}

/**
 * The three sequences measured on the NEGATIVE CONTROL in one night: same suite, same release, same
 * account, `keyframe` re-uploaded with its D1 binding removed.
 *
 * This is the evidence for the change, so it lives in the repo and is executable rather than
 * sitting in a thread.
 */
export const MEASURED_NEGATIVE_CONTROL_RUNS: { label: string; seq: Reading[] }[] = [
  { label: "run 1 (settled false after 50s)", seq: [true, false, true, false, false, false] },
  { label: "run 2 (settled false after 40s)", seq: [false, true, false, false, false] },
  { label: "run 3 (settled TRUE after 20s -- the stale isolate)", seq: [true, true, true] },
];
