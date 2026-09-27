// Is the credit submit gate WIRED? Measured against the source, not asserted in a comment.
//
// THE DEFECT THIS EXISTS TO CATCH, in both directions. `CREDITS_ENFORCING` was echoed straight back
// by the credit views, so the API reported `enforcing: true` on a plane where `decideSubmit` had no
// production caller and no hold was ever taken. A tenant at zero balance submitted renders while the
// operator surface said enforcement was active. The fix routes the knob through
// `SUBMIT_GATE_WIRED`, and a constant that says "nothing is wired" is worth exactly as much as the
// thing that checks it stays true.
//
// So this file is the mechanism, not the documentation:
//   - RED today if `SUBMIT_GATE_WIRED` were flipped to true while nothing calls the gate.
//   - RED the day somebody wires the gate and forgets to flip the constant, which is the failure that
//     would otherwise reinstate the original lie in reverse.
//
// A MENTION IS NOT A CALLER, so comments are stripped before matching and the store methods are
// matched only with a receiver (`x.takeHold(`), which a method DEFINITION cannot produce. The
// positive control at the bottom proves the matcher can find a caller at all; without it a green run
// here would be indistinguishable from a matcher that matches nothing.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SUBMIT_GATE_WIRED } from "../src/credits";

const SRC = join(import.meta.dirname, "..", "src");

/** The five functions that together ARE the submit-time gate. */
const HOLD_METHODS = ["takeHold", "captureHold", "releaseHold", "expireHolds"] as const;

/** Block and line comments removed, so prose about a function is never counted as a call to it. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * Every call site of the gate in `src/`, as `file:line`.
 *
 * `decideSubmit` is matched bare but never where `function` precedes it, so its own definition in
 * credits.ts does not count as its own caller. The hold methods are matched only after a `.`, which
 * a `async takeHold(args: {...})` definition cannot satisfy.
 */
function gateCallSites(): string[] {
  const out: string[] = [];
  for (const name of readdirSync(SRC).filter((n) => n.endsWith(".ts")).sort()) {
    const lines = stripComments(readFileSync(join(SRC, name), "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (/(?<!function\s)\bdecideSubmit\s*\(/.test(line)) out.push(`${name}:${i + 1} decideSubmit`);
      for (const m of HOLD_METHODS) {
        if (new RegExp(`\\.${m}\\s*\\(`).test(line)) out.push(`${name}:${i + 1} ${m}`);
      }
    });
  }
  return out;
}

describe("the credit submit gate, measured", () => {
  it("SUBMIT_GATE_WIRED agrees with whether src/ actually calls the gate", () => {
    const sites = gateCallSites();
    // The message carries the sites so a failure names WHAT changed rather than only that something
    // did. A census that reports a bare mismatch sends the next reader back to do this grep by hand.
    expect(
      SUBMIT_GATE_WIRED,
      `SUBMIT_GATE_WIRED is ${SUBMIT_GATE_WIRED} but src/ gate call sites are: ` +
        (sites.length ? sites.join(", ") : "(none)") +
        ". Flip the constant in src/credits.ts to match, and re-read what the credit views now claim.",
    ).toBe(sites.length > 0);
  });

  it("POSITIVE CONTROL: the matcher finds a caller when one exists", () => {
    // Without this, a green run above could mean "nothing calls the gate" OR "the matcher matches
    // nothing", and those are the same reading. Same shape as the repo's other census controls.
    const synthetic = [
      "const verdict = decideSubmit({ balance, required_micro_usd: 1, enforcing: true });",
      "await deps.credits.takeHold({ tenantId, jobRef, amountMicroUsd });",
      "await store.captureHold({ holdId, ledgerRowId, costMicroUsd: null, note: null, now });",
      "await store.releaseHold(holdId, now);",
      "await store.expireHolds(now);",
    ].join("\n");
    const found = stripComments(synthetic)
      .split("\n")
      .filter(
        (line) =>
          /(?<!function\s)\bdecideSubmit\s*\(/.test(line) ||
          HOLD_METHODS.some((m) => new RegExp(`\\.${m}\\s*\\(`).test(line)),
      );
    expect(found).toHaveLength(5);
  });

  it("NEGATIVE CONTROL: a definition and a comment are not callers", () => {
    const notCallers = [
      "export function decideSubmit(args: { balance: Balance }): SubmitVerdict {",
      "  async takeHold(args: { tenantId: string }): Promise<HoldRow> {",
      "// NEGATIVE: a debit reduces the balance. Same convention captureHold(x) writes",
      "/* releaseHold(id) is documented here and called nowhere */",
    ].join("\n");
    const found = stripComments(notCallers)
      .split("\n")
      .filter(
        (line) =>
          /(?<!function\s)\bdecideSubmit\s*\(/.test(line) ||
          HOLD_METHODS.some((m) => new RegExp(`\\.${m}\\s*\\(`).test(line)),
      );
    expect(found).toEqual([]);
  });
});
