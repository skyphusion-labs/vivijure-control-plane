/**
 * cf#361: pin that the forbidden-binding guard is CALLED, not merely that it works.
 *
 * WHY A SOURCE-TEXT PIN AND NOT A BEHAVIOURAL ONE. The four behavioural tests around
 * `assertNoTenantModuleForbiddenBindings` cover the function well, but nothing pinned that
 * `uploadTenantModules` invokes it. Measured: deleting only the call site left the suite at
 * 1761 passed / 51 skipped / 90 files and `tsc` clean -- eight files drive
 * `uploadTenantModules` and not one goes red. The guard survives as dead code protecting
 * nothing, and the deletion is a single line.
 *
 * That is this PR's own standard turned on itself. It exists to make an omission impossible
 * ("pin the refusal so omission becomes design") while its own arming stayed omission-shaped.
 *
 * WHY THIS INSTRUMENT IS WEAK, STATED PLAINLY. Bindings are assembled by hardcoded
 * `bindings.push(...)` calls, so no caller can currently produce `RUNPOD_WORKERS_MAX` through
 * the API and there is no injection seam for a behavioural test. The call site is therefore
 * defence-in-depth against a FUTURE push -- exactly the case worth pinning, because whoever
 * adds that push will not know this constraint exists. A source-text assertion is a weak
 * instrument and strictly better than nothing; it goes red on the one-line deletion above.
 * Same idiom as tests/runpod-proxy-census.test.ts.
 *
 * REPLACE THIS with a behavioural test the moment a binding-injection seam exists.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "..", "src", "tenant-modules.ts"), "utf8");

describe("cf#361 forbidden-binding guard is armed", () => {
  it("the guard name appears as a CALL, not only as its declaration", () => {
    // Deliberately not a bare name match: `export function assertNoTenantModuleForbidden...`
    // satisfies that even with every call site deleted. Measured -- the first version of this
    // test did exactly that and stayed green under the deletion the suite exists to catch.
    // Count occurrences that are NOT the declaration.
    const all = src.match(/assertNoTenantModuleForbiddenBindings\s*\(/g) ?? [];
    const decl = src.match(/function\s+assertNoTenantModuleForbiddenBindings\s*\(/g) ?? [];
    expect(all.length - decl.length).toBeGreaterThan(0);
  });

  it("the call precedes the upload it guards, so no binding is added after the check", () => {
    const call = src.indexOf("assertNoTenantModuleForbiddenBindings(spec.module");
    // cp#464: the upload moved onto the SCRIPT UPLOAD credential and behind uploadModuleScript, so
    // this anchor tracks the helper rather than the client. Same property either way: the
    // forbidden-binding check must run BEFORE the bytes leave, whichever credential carries them.
    const upload = src.indexOf("uploadModuleScript(deps, spec.module", call);
    expect(call).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(call);
  });
});
