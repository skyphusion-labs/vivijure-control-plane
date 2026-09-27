// Is PUBLIC_ENDPOINT_ALLOWLIST still the set of slugs this plane actually provisions? (cp#541)
//
// WHAT REPLACED WHAT, because the file this grew out of is the lesson. `runpod-proxy-census.test.ts`
// was named for a census and could not observe one. It held `const PUBLIC_SLUGS = 8` and asserted
// `expect(PUBLIC_ENDPOINT_ALLOWLIST).toHaveLength(PUBLIC_SLUGS)` -- a constant against a constant --
// and `expect(PUBLIC_SLUGS + ENV_ENDPOINT_READERS).toBe(HOST_REFS)`, which is 8 + 6 === 14 and
// cannot fail in any universe. Its own docstring said "This suite does not re-scan vivijure-cf",
// and everything downstream read it as parity anyway. A check whose NAME promises more than it can
// observe is worse than no check: it occupies the slot where the real one would go.
//
// THE POPULATION THE ALLOW-LIST MIRRORS IS THIS REPO'S CATALOG, NOT vivijure-cf's MODULE SET, and
// that is measured rather than preferred. At vivijure-cf@7b927b9, NINE modules declare
// `const ENDPOINT_ID = "<slug>"`: the seven this plane catalogues, plus `infinitetalk` and
// `kling-o1-r2v`, which are deliberately uncatalogued. And `narration-gen` IS catalogued and
// allow-listed while declaring no such constant at all -- it builds its URL by concatenation. So a
// gate asserting the allow-list equals cf's module-declared slugs would be red on a correct estate,
// in both directions at once. The right authority is the thing the proxy actually admits FOR: the
// tenant catalog.
//
// WHY THAT IS PARITY AND NOT THE TAUTOLOGY THIS REPLACES. `TENANT_MODULE_CATALOG` and
// `PUBLIC_ENDPOINT_ALLOWLIST` are two independent artifacts, in two files, edited by different
// changes for different reasons -- one says what a tenant gets provisioned, the other says what the
// meter will price. Comparing them can fail, and it DID: when cp#538 removed the `kling` row, this
// assertion is what fails on the leftover `kling-v2-1-i2v-pro` entry. The old suite stayed green
// through exactly that, by construction.
//
// WHAT THIS STILL CANNOT SEE, stated so it is not read as total: whether a slug resolves at RunPod.
// That is vivijure-cf's scheduled endpoint-liveness probe (cf#934), which derives its population
// from `modules/` on its own checkout and reports by opening an issue. Green here means the two
// plane-side lists agree, not that the door renders.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ENDPOINT_ALLOWLIST } from "../src/runpod-proxy.js";
import { TENANT_MODULE_CATALOG } from "../src/tenant-modules.js";

const repoRoot = join(import.meta.dirname, "..");

/** Every public slug the catalog declares, by module, so an offender can be named rather than counted. */
const CATALOGUED: { module: string; slug: string }[] = TENANT_MODULE_CATALOG.filter(
  (s): s is typeof s & { publicEndpoint: string } => typeof s.publicEndpoint === "string",
).map((s) => ({ module: s.module, slug: s.publicEndpoint }));

describe("the allow-list is exactly what the catalog provisions", () => {
  it("CONTROL: both populations are non-empty, so neither side can agree by being absent", () => {
    // The denominator, printed rather than assumed. Two empty sets are equal, and that is precisely
    // the shape a parser or an import regression produces.
    expect(CATALOGUED.length).toBeGreaterThan(0);
    expect(PUBLIC_ENDPOINT_ALLOWLIST.length).toBeGreaterThan(0);
  });

  it("every catalogued public slug is admitted by the proxy", () => {
    // The direction that breaks a RENDER: a tenant module submits to a slug the proxy refuses.
    const missing = CATALOGUED.filter((c) => !PUBLIC_ENDPOINT_ALLOWLIST.includes(c.slug));
    expect(missing.map((m) => `${m.module} -> ${m.slug}`)).toEqual([]);
  });

  it("the proxy admits NOTHING the catalog does not provision", () => {
    // The direction that breaks a METER, and the one the replaced suite could not see. An allow-list
    // entry with no catalogued module is a slug we would price for a door no tenant can have --
    // which is exactly what `kling-v2-1-i2v-pro` became the moment cp#538 dropped its row.
    const slugs = new Set(CATALOGUED.map((c) => c.slug));
    const orphans = PUBLIC_ENDPOINT_ALLOWLIST.filter((s) => !slugs.has(s));
    expect(orphans).toEqual([]);
  });

  it("CONTROL: the comparator reports a difference when there is one", () => {
    // Without this, the two assertions above pass identically against a comparator that always
    // returns []. The same set-difference expression, over a SELF-CONTAINED pair.
    //
    // Deliberately NOT built from the live lists, and that was measured rather than assumed: the
    // first version appended a ghost to the real allow-list, so when a genuine orphan was present
    // the control failed too -- for the same reason as its subject, reporting one defect as two and
    // discriminating nothing. A control has to be able to pass while the thing it validates fails.
    const known = new Set(["already-catalogued-slug"]);
    const observed = ["already-catalogued-slug", "definitely-not-a-slug-cp541"];
    expect(observed.filter((s) => !known.has(s))).toEqual(["definitely-not-a-slug-cp541"]);
    expect(observed.filter((s) => known.has(s))).toEqual(["already-catalogued-slug"]);
  });
});

describe("the census comments cannot re-land an unreproduced figure (cp#298)", () => {
  // ALL THAT SURVIVES of the old suite, and it is the half that was doing real work. The "23 of 26"
  // figure was never reproduced at the sha it claimed; the numbers that replaced it have since gone
  // stale in their own right (see the corrected comments), but a specific wrong number in a source
  // comment still becomes somebody's evidence when scoping work.
  const CENSUS_FILES = ["src/runpod-proxy-route-match.ts", "src/runpod-proxy.ts"] as const;

  it("neither comment claims the unreproduced 23-of-26 figure", () => {
    for (const rel of CENSUS_FILES) {
      const text = readFileSync(join(repoRoot, rel), "utf8");
      expect(text, rel).not.toMatch(/23 of 26/);
      // CONTROL: the file was actually read, so a path typo cannot pass as a clean result.
      expect(text.length, rel).toBeGreaterThan(500);
    }
  });
});
