// cp#185 part two: the windowed read's judgement, as pure logic.
//
// `complete` is the field cp#195 bills on, so the suite's job is not to show it can be true. It is
// to show every distinct way it becomes FALSE is reachable, and that a clean window still comes
// back true (the control, without which a summariser that always returned false would pass every
// negative test here unanimously).

import { describe, it, expect } from "vitest";
import {
  periodBelongsToWindow,
  summariseWindow,
  type RollupPeriodRow,
} from "../src/llm-spend-window";

const period = (over: Partial<RollupPeriodRow> = {}): RollupPeriodRow => ({
  id: "llmp_1",
  window_start: "2026-07-28T00:00:00.000Z",
  window_end: "2026-07-28T00:15:00.000Z",
  status: "complete",
  control_passed: 1,
  gap_detected: 0,
  finished_at: "2026-07-28T00:15:02.000Z",
  ...over,
});

const sums = (over: Partial<{ costMicroUsd: number; requests: number; unpricedRequests: number }> = {}) => ({
  costMicroUsd: 145,
  requests: 1,
  unpricedRequests: 0,
  ...over,
});

const WSTART = "2026-07-28T00:00:00.000Z";
const WEND = "2026-07-29T00:00:00.000Z";

const summary = (periods: RollupPeriodRow[], s = sums(), truncated = false) =>
  summariseWindow({ periods, windowStart: WSTART, windowEnd: WEND, sums: s, periodCensusTruncated: truncated });

describe("periodBelongsToWindow", () => {
  // Half-open on window_end, so consecutive billing windows PARTITION the periods. An overlap test
  // would put a straddling run in both neighbours and bill its rows twice, which on a money path is
  // the worst failure available.
  it("assigns a period by its window_end, inclusive of the start and exclusive of the end", () => {
    expect(periodBelongsToWindow(period({ window_end: WSTART }), WSTART, WEND)).toBe(true);
    expect(periodBelongsToWindow(period({ window_end: "2026-07-28T23:59:59.999Z" }), WSTART, WEND)).toBe(true);
    expect(periodBelongsToWindow(period({ window_end: WEND }), WSTART, WEND)).toBe(false);
    expect(periodBelongsToWindow(period({ window_end: "2026-07-27T23:59:59.999Z" }), WSTART, WEND)).toBe(false);
  });

  // The property that makes double-billing impossible, stated as a property rather than as three
  // examples: every period lands in EXACTLY ONE of two adjacent windows.
  it("puts every period in exactly one of two adjacent windows", () => {
    const next = "2026-07-30T00:00:00.000Z";
    for (const end of [WSTART, "2026-07-28T12:00:00.000Z", WEND, "2026-07-29T18:00:00.000Z"]) {
      const p = period({ window_end: end });
      const hits = [periodBelongsToWindow(p, WSTART, WEND), periodBelongsToWindow(p, WEND, next)];
      expect(hits.filter(Boolean), end).toHaveLength(1);
    }
  });

  // A first run's window is zero-width by construction (nothing before the meter existed was
  // observed). It must still be assignable, because it carries the whole backfill.
  it("assigns a ZERO-WIDTH period, which is what a first run writes", () => {
    const first = period({ window_start: "2026-07-28T03:00:00.000Z", window_end: "2026-07-28T03:00:00.000Z" });
    expect(periodBelongsToWindow(first, WSTART, WEND)).toBe(true);
  });
});

describe("summariseWindow: the control", () => {
  it("a clean window is complete, with the agreed five fields carrying the real numbers", () => {
    const out = summary([period()], sums({ costMicroUsd: 145, requests: 3 }));
    expect(out.complete).toBe(true);
    expect(out.reason).toBeNull();
    expect(out.cost_micro_usd).toBe(145);
    expect(out.requests).toBe(3);
    expect(out.window_start).toBe(WSTART);
    expect(out.window_end).toBe(WEND);
  });

  it("a clean window with genuinely no spend for this tenant is a complete ZERO", () => {
    // The honest zero: an observation happened and this tenant was not in it. Distinguishing this
    // from the no-observation case below is the entire point of the flag.
    const out = summary([period()], sums({ costMicroUsd: 0, requests: 0 }));
    expect(out.complete).toBe(true);
    expect(out.cost_micro_usd).toBe(0);
  });
});

describe("summariseWindow: every path to complete:false is reachable", () => {
  // THE ONE THAT MATTERS MOST, and the shape a silently-dead cron produces. Zero periods is not
  // zero spend, it is no observation, and billing it as a zero is the under-bill this lane exists
  // to prevent.
  it("NO ROLL-UP RUN assigned: a zero that must not be billed as one", () => {
    const out = summary([], sums({ costMicroUsd: 0, requests: 0 }));
    expect(out.complete).toBe(false);
    expect(out.periods).toBe(0);
    expect(out.reason).toContain("NOT the same fact as zero spend");
  });

  it("an UNFINISHED run: it died mid-write, so its event set is partial", () => {
    const out = summary([period({ finished_at: null })]);
    expect(out.complete).toBe(false);
    expect(out.reason).toContain("never finished writing");
  });

  it("a run that did not paginate to exhaustion", () => {
    expect(summary([period({ status: "incomplete" })]).complete).toBe(false);
    expect(summary([period({ status: "failed" })]).reason).toContain("did not paginate to exhaustion");
  });

  it("a FAILED positive control: the run read nothing and proved nothing", () => {
    const out = summary([period({ control_passed: 0 })]);
    expect(out.complete).toBe(false);
    expect(out.reason).toContain("FAILED their positive control");
  });

  it("a retention GAP: rows deleted unread, the only PERMANENT loss here", () => {
    const out = summary([period({ gap_detected: 1 })]);
    expect(out.complete).toBe(false);
    expect(out.reason).toContain("gone for good");
  });

  // SQL SUM skips NULLs, so an unpriced row is invisible in the total and visible in the count.
  // Unflagged, that pair reads as "we billed everything".
  it("UNPRICED requests: counted but not summed, so the total is a floor", () => {
    const out = summary([period()], sums({ costMicroUsd: 145, requests: 4, unpricedRequests: 2 }));
    expect(out.complete).toBe(false);
    expect(out.unpriced_requests).toBe(2);
    expect(out.reason).toContain("the total is a floor");
    // The number still travels: an unbillable window is still a diagnosable one.
    expect(out.cost_micro_usd).toBe(145);
    expect(out.requests).toBe(4);
  });

  it("a TRUNCATED period census: every count below it is a floor", () => {
    const out = summary([period()], sums(), true);
    expect(out.complete).toBe(false);
    expect(out.reason).toContain("row limit");
  });

  // One bad period among many good ones must still sink the window. A summariser that checked only
  // the first, or only the last, would pass every single-period test above.
  it("ONE bad run among good ones sinks the window", () => {
    const out = summary([period({ id: "a" }), period({ id: "b", gap_detected: 1 }), period({ id: "c" })]);
    expect(out.complete).toBe(false);
    expect(out.periods).toBe(3);
  });

  it("reports EVERY reason, not just the first", () => {
    const out = summary(
      [period({ status: "incomplete", control_passed: 0, gap_detected: 1, finished_at: null })],
      sums({ unpricedRequests: 1 }),
    );
    for (const fragment of [
      "never finished writing",
      "did not paginate",
      "FAILED their positive control",
      "gone for good",
      "the total is a floor",
    ]) {
      expect(out.reason, fragment).toContain(fragment);
    }
  });
});
