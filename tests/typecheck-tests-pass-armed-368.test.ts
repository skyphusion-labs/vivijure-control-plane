/**
 * cp#368: pin that BOTH tsc passes stay wired into `npm run typecheck`, and that the second pass
 * still pulls tests/ in.
 *
 * WHY. The base tsconfig.json `include` is `src/**\/*.ts` only -- a bare `tsc --noEmit` never sees
 * `tests/`. Only the second pass, `tsc -p tsconfig.tests.json --noEmit`, typechecks anything under
 * tests/, including the cp#339 mapped WiringDouble test-double protection (widening
 * `ProvisionerWiring` fails typecheck at the double instead of drifting into a runtime failure).
 * Simplifying the script to a single invocation -- the kind of tidy-up a later cleanup makes
 * without ceremony -- disarms that protection with no error and no signal it ever existed.
 *
 * WHY THIS INSTRUMENT IS A SOURCE-TEXT PIN, NOT A BEHAVIOURAL ONE. There is no seam to drive
 * `npm run typecheck` itself from inside a vitest run without shelling out to a second tsc
 * invocation, which would make this test as slow and fragile as the thing it guards. A source-text
 * assertion on the package.json script and the tsconfig.tests.json include list is a weak
 * instrument in the abstract (it does not prove tsc actually passes), but it is exactly the
 * instrument that catches THIS failure mode: the script or config being tidied away, not a real
 * type error. Same idiom as tests/tenant-modules-guard-armed.test.ts.
 *
 * MUTATION-TESTED: both assertions were driven red by hand before this file was trusted --
 * (1) collapsing the typecheck script to a single `tsc --noEmit` reddened the first assertion, and
 * (2) dropping `tests/**\/*.ts` from tsconfig.tests.json include reddened the second assertion.
 * Both were restored and reconfirmed green. See the PR body for the transcript.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tsconfigTests = JSON.parse(readFileSync(join(root, "tsconfig.tests.json"), "utf8"));

describe("cp#368 the test-typecheck pass stays armed", () => {
  it("npm run typecheck still runs both tsc passes, in order", () => {
    const script: string = pkg.scripts.typecheck;
    expect(script).toContain("tsc --noEmit");
    expect(script).toContain("tsc -p tsconfig.tests.json --noEmit");
    expect(script.indexOf("tsc -p tsconfig.tests.json")).toBeGreaterThan(
      script.indexOf("tsc --noEmit"),
    );
  });

  it("tsconfig.tests.json still pulls tests files into the typechecked set", () => {
    expect(tsconfigTests.include).toContain("tests/**/*.ts");
  });
});
