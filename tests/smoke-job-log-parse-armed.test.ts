// cp#384: pin that the pre-deploy smoke has no local telemetry.job_log parse.
//
// cp#378 removed a duplicated `typeof job_log === "boolean"` predicate. Nothing
// asserted it stayed removed. A reintroduced copy is valid TypeScript, passes
// typecheck, and passes every existing test -- and silently restores the
// condition under which the smoke cannot observe the failure it exists to
// observe (the plane and the modules disagreed for twelve days; the gate
// agreed with the plane by construction).
//
// SOURCE-TEXT PIN, weakness stated: this cannot see a parse rewritten in a
// shape the matcher does not know. It goes red on the predicate that actually
// broke, and on dropping the shipped import. Same idiom as
// tests/tenant-modules-guard-armed.test.ts and tests/smoke-d1-migration.test.ts.
//
// TWO REQUIREMENTS this file exists to keep:
//   1. A POSITIVE CONTROL. The matcher is driven against a snippet known to
//      contain the old local predicate and observed REFUSING before the smoke
//      file's zero is trusted.
//   2. A DENOMINATOR. A zero-match against a file that never mentions job_log
//      is a harness failure, not agreement.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TESTS = import.meta.dirname;
const SMOKE = join(TESTS, "pre-deploy-smoke.live.test.ts");

/** The predicate shape that actually broke (cp#378). */
const LOCAL_BOOLEAN_PARSE = /typeof\s+[\s\S]{0,120}?job_log\s*===\s*["']boolean["']/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function localBooleanParses(src: string): string[] {
  return stripComments(src).match(new RegExp(LOCAL_BOOLEAN_PARSE, "g")) ?? [];
}

describe("cp#384: pre-deploy smoke uses only the shipped job_log parser", () => {
  const smoke = readFileSync(SMOKE, "utf8");

  it("POSITIVE CONTROL: the matcher refuses a file that still has the old local parse", () => {
    const knownBad =
      "v = typeof body.telemetry?.job_log === \"boolean\" ? body.telemetry.job_log : null;";
    const hits = localBooleanParses(knownBad);
    expect(
      hits.length,
      "matcher found nothing in the verbatim cp#378 predicate; the zero below would be decoration",
    ).toBeGreaterThan(0);
  });

  it("the smoke file has no local boolean job_log parse (comments stripped)", () => {
    const mentions = smoke.match(/job_log/g) ?? [];
    // DENOMINATOR: a file that never mentions job_log cannot prove absence of a parse.
    expect(
      mentions.length,
      "denominator: pre-deploy-smoke.live.test.ts must still talk about job_log",
    ).toBeGreaterThan(0);
    const hits = localBooleanParses(smoke);
    expect(
      hits,
      `local boolean parse reintroduced (${hits.length} hit(s) against ${mentions.length} job_log mention(s))`,
    ).toEqual([]);
  });

  it("imports parseJobLogReadiness from the shipped module and actually calls it", () => {
    expect(smoke).toMatch(
      /import\s*\{[^}]*\bparseJobLogReadiness\b[^}]*\}\s*from\s*["']\.\.\/src\/tenant-modules["']/,
    );
    const calls = smoke.match(/\bparseJobLogReadiness\s*\(/g) ?? [];
    expect(calls.length, "the import is unused; a local parse could sit beside it").toBeGreaterThan(0);
  });

  it("no other tests/ file reintroduces the boolean predicate either", () => {
    const files = readdirSync(TESTS).filter((f) => f.endsWith(".ts"));
    const withJobLog: string[] = [];
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(TESTS, f), "utf8");
      if (!src.includes("job_log")) continue;
      withJobLog.push(f);
      if (localBooleanParses(src).length > 0) offenders.push(f);
    }
    expect(
      withJobLog.length,
      "denominator: at least the smoke file mentions job_log",
    ).toBeGreaterThan(0);
    expect(offenders, `boolean job_log parse in: ${offenders.join(", ")}`).toEqual([]);
  });
});
