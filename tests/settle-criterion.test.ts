// Replay the three REAL measured negative-control sequences through both criteria (cp#255).
//
// This suite exists because the defect it documents was found in production use of the gate, not by
// reasoning, and the fix must not be trusted on reasoning either. Every case below is a sequence
// that actually came off a running Cloudflare worker on 2026-08-01.
//
// THE POINT: run 3 is the one that matters. The old criterion ACCEPTS it and reports `true`, which
// is the gate declaring the very regression it exists to catch to be the expected answer. The new
// criterion refuses it. If you ever "simplify" the negative control back to a settle, this file
// goes red and tells you why.

import { describe, it, expect } from "vitest";
import {
  MEASURED_NEGATIVE_CONTROL_RUNS,
  NO_ANSWER,
  reached,
  render,
  settledValue,
  type Reading,
} from "./settle-criterion";

const NEED = 3;

describe("the OLD criterion, kept so its defect stays executable", () => {
  it("REPRODUCES THE DEFECT: run 3 is accepted, and the value accepted is a lie", () => {
    const run3 = MEASURED_NEGATIVE_CONTROL_RUNS[2].seq;
    const v = settledValue(run3, NEED);
    // A stale isolate answered `true` three times in a row. Perfectly stable, entirely wrong.
    expect(v.settled).toBe(true);
    expect(v.value).toBe(true);
  });

  it("got runs 1 and 2 right BY LUCK OF THE INTERLEAVING, not by design", () => {
    // The flapping kept resetting the streak until the new version won. Nothing about the criterion
    // caused that; a non-flapping stale isolate defeats it, which is exactly run 3.
    expect(settledValue(MEASURED_NEGATIVE_CONTROL_RUNS[0].seq, NEED)).toEqual({ settled: true, value: false });
    expect(settledValue(MEASURED_NEGATIVE_CONTROL_RUNS[1].seq, NEED)).toEqual({ settled: true, value: false });
  });
});

describe("the REPLACE criterion: reach the value, never accept the ambiguous one", () => {
  it("accepts runs 1 and 2, which genuinely converged to false", () => {
    for (const run of MEASURED_NEGATIVE_CONTROL_RUNS.slice(0, 2)) {
      expect(reached(run.seq, false, NEED), `${run.label} reads ${render(run.seq)}`).toBe(true);
    }
  });

  it("REFUSES run 3, which never observed false at all", () => {
    const run3 = MEASURED_NEGATIVE_CONTROL_RUNS[2];
    expect(reached(run3.seq, false, NEED), `${run3.label} reads ${render(run3.seq)}`).toBe(false);
  });

  it("no quantity of the ambiguous value can satisfy the wait", () => {
    // The whole asymmetry in one assertion: a stale isolate is stable forever and must never win.
    const foreverTrue: Reading[] = Array.from({ length: 200 }, () => true);
    expect(reached(foreverTrue, false, NEED)).toBe(false);
    // ...while the wanted value satisfies it as soon as it holds.
    expect(reached([...foreverTrue, false, false, false], false, NEED)).toBe(true);
  });

  it("a single sighting mid-flap is NOT convergence", () => {
    // Run 1 read false at index 1 and true again at index 2. Accepting the first sighting would
    // have passed on a reading the new version had not yet won.
    expect(reached([true, false, true], false, NEED)).toBe(false);
    expect(reached([true, false, false, false], false, NEED)).toBe(true);
  });

  it("a transport failure resets the streak and can never satisfy the wait", () => {
    expect(reached([false, false, NO_ANSWER, false], false, NEED)).toBe(false);
    expect(reached([NO_ANSWER, NO_ANSWER, NO_ANSWER], false, NEED)).toBe(false);
    expect(reached([false, NO_ANSWER, false, false, false], false, NEED)).toBe(true);
  });

  it("null (a module that reports no telemetry field) never satisfies a wait for false", () => {
    // An image predating the telemetry field is not a module saying `false`, and collapsing the two
    // is the defect this whole constellation has been working through.
    expect(reached([null, null, null], false, NEED)).toBe(false);
  });
});

describe("render, so a sequence in a log is readable", () => {
  it("prints each reading as one character", () => {
    expect(render([true, false, null, NO_ANSWER])).toBe("TFnx");
    expect(render(MEASURED_NEGATIVE_CONTROL_RUNS[0].seq)).toBe("TFTFFF");
    expect(render(MEASURED_NEGATIVE_CONTROL_RUNS[1].seq)).toBe("FTFFF");
    expect(render(MEASURED_NEGATIVE_CONTROL_RUNS[2].seq)).toBe("TTT");
  });
});
