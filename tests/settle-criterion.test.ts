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
  UNRECOGNISED,
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

describe("the criterion is value-agnostic, so the string contract reuses it (cp#378)", () => {
  // The measured runs above are pre-815c9ff0 BOOLEAN readings and are kept verbatim. These cases
  // are the same sequence SHAPES in the string vocabulary the modules emit today, which is what
  // the live smoke now feeds these functions. If the criterion had been written about booleans
  // rather than about shapes, every one of these would need a second implementation.
  it("REFUSES a stably-positive replace read, exactly as it refuses run 3", () => {
    // The string-contract twin of run 3: a stale isolate answering "ok" forever.
    expect(reached(["ok", "ok", "ok"], "unavailable", NEED)).toBe(false);
    const foreverOk: Reading[] = Array.from({ length: 200 }, () => "ok");
    expect(reached(foreverOk, "unavailable", NEED)).toBe(false);
  });

  it("accepts a converged unavailable, including after a mid-flap sighting", () => {
    expect(reached(["ok", "unavailable", "ok"], "unavailable", NEED)).toBe(false);
    expect(reached(["ok", "unavailable", "unavailable", "unavailable"], "unavailable", NEED)).toBe(true);
  });

  it("neither unknown nor null nor an unrecognised value satisfies a wait for unavailable", () => {
    // FOUR STATES, FOUR MEANINGS. "unknown" is the worker saying it probed and could not tell;
    // null is no field at all; UNRECOGNISED is the cf contract having moved. None of them is the
    // worker saying it cannot record, and the negative control must not accept any as if it were.
    expect(reached(["unknown", "unknown", "unknown"], "unavailable", NEED)).toBe(false);
    expect(reached([null, null, null], "unavailable", NEED)).toBe(false);
    expect(reached([UNRECOGNISED, UNRECOGNISED, UNRECOGNISED], "unavailable", NEED)).toBe(false);
  });

  it("a positive leg settles on ok, and settles on unrecognised rather than hiding it", () => {
    expect(settledValue(["ok", "ok", "ok"], NEED)).toEqual({ settled: true, value: "ok" });
    // An unrecognised value is a STABLE OBSERVATION, not a transport failure, so it settles and
    // the caller gets to report it. Resetting the streak here would hide a rename behind a
    // deadline and the failure would read as a timeout.
    expect(settledValue([UNRECOGNISED, UNRECOGNISED, UNRECOGNISED], NEED)).toEqual({
      settled: true,
      value: UNRECOGNISED,
    });
  });

  it("a transport failure still resets the streak under the string contract", () => {
    expect(reached(["unavailable", "unavailable", NO_ANSWER, "unavailable"], "unavailable", NEED)).toBe(false);
    expect(reached(["unavailable", NO_ANSWER, "unavailable", "unavailable", "unavailable"], "unavailable", NEED)).toBe(true);
  });
});

describe("render, so a sequence in a log is readable", () => {
  it("prints each reading as one character", () => {
    expect(render([true, false, null, NO_ANSWER])).toBe("TFnx");
    // One character per state, and all six distinguishable in a log line.
    expect(render(["ok", "unavailable", "unknown", null, NO_ANSWER, UNRECOGNISED])).toBe("ou?nx!");
    expect(render(MEASURED_NEGATIVE_CONTROL_RUNS[0].seq)).toBe("TFTFFF");
    expect(render(MEASURED_NEGATIVE_CONTROL_RUNS[1].seq)).toBe("FTFFF");
    expect(render(MEASURED_NEGATIVE_CONTROL_RUNS[2].seq)).toBe("TTT");
  });
});
