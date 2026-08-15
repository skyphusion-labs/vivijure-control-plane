// cp#367: the backend endpoint purpose/label is hand-copied in three downstream places besides
// its source (PROVISION_PLAN in src/runpod.ts, guarded separately in tests/runpod.test.ts). This
// file guards those three copies against the SAME NO_TRAINING_CLAUSE the source guard uses, so a
// re-introduced training claim in any copy fails loudly instead of staying green.
//
// Re-derived population (Step 1, cp#367): a repo-wide union grep for the backend purpose text
// (the keyframes/video wording) plus a search for every "key: backend" and "**backend**" site
// confirms the issue claim: exactly four places carry the claim, one guarded (the source), three
// not. Two near-misses were checked and excluded. CHANGELOG.md line 119 describes, in past tense,
// what the label USED to say before cp#303 fixed it -- a historical record, not a live copy that
// can drift. public/onboarding.js is a CONSUMER (renders ep.purpose at lines 171 and 174), not a
// copy.
//
// TRAP (real, checked): both public/onboarding-api.js and public/onboarding-checks.js carry a
// comment beside the backend entry -- "cp#303: purpose matches PROVISION_PLAN -- training is not
// on this endpoint" -- and that comment contains the word training. A whole-file /train/i scan
// would flag that CORRECT explanatory comment. Every extraction below reads the backend entry
// purpose or label FIELD VALUE, either through the JS module data itself (never a text scan of
// the file) or a table-row-scoped regex for the doc. Neither can trip on the comment text.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NO_TRAINING_CLAUSE } from "../src/runpod";
import { REPRESENTATIVE_PLAN } from "../public/onboarding-checks.js";
import { mockResponses } from "../public/onboarding-api.js";

const HOSTED_TIER_DOC = readFileSync(join(import.meta.dirname, "..", "docs", "hosted-tier.md"), "utf8");

// The three downstream copies confirmed by the Step 1 sweep, and the extractor for each one.
// Naming each extractor explicitly, instead of looping over a glob, is what lets the
// denominator test below say exactly which ones it found.
function onboardingChecksPurpose(): string {
  const entry = REPRESENTATIVE_PLAN.endpoints.find((e) => e.key === "backend");
  expect(entry, "public/onboarding-checks.js: no backend entry in REPRESENTATIVE_PLAN.endpoints").toBeDefined();
  expect(entry?.purpose, "public/onboarding-checks.js: backend entry has no purpose field").toBeTruthy();
  return entry?.purpose ?? "";
}

function onboardingApiPurpose(): string {
  const plan = mockResponses.plan();
  const entry = plan.endpoints.find((e) => e.key === "backend");
  expect(entry, "public/onboarding-api.js: no backend entry in mockResponses.plan().endpoints").toBeDefined();
  expect(entry?.purpose, "public/onboarding-api.js: backend entry has no purpose field").toBeTruthy();
  return entry?.purpose ?? "";
}

function hostedTierDocPurpose(): string {
  // Scoped to the markdown table row whose first cell is backend, never a whole-file scan --
  // the same discipline as the two extractors above, applied to prose instead of a data module.
  const match = HOSTED_TIER_DOC.match(/\|\s*\*\*backend\*\*\s*\|\s*([^|]+?)\s*\|/);
  expect(match, "docs/hosted-tier.md: no backend row found in the endpoint table").not.toBeNull();
  return match ? match[1] : "";
}

describe("backend label copies do not promise cast LoRA training (cp#367)", () => {
  it("public/onboarding-checks.js REPRESENTATIVE_PLAN backend purpose", () => {
    expect(onboardingChecksPurpose()).not.toMatch(NO_TRAINING_CLAUSE);
  });

  it("public/onboarding-api.js mock plan backend purpose", () => {
    expect(onboardingApiPurpose()).not.toMatch(NO_TRAINING_CLAUSE);
  });

  it("docs/hosted-tier.md backend table row", () => {
    expect(hostedTierDocPurpose()).not.toMatch(NO_TRAINING_CLAUSE);
  });

  // Denominator check: the population is fixed at 3 downstream copies as of cp#367 Step 1. This
  // pins that COUNT explicitly, on top of the per-copy assertions above, so a future edit that
  // quietly narrows the array below (rather than adding a fourth copy properly) fails here too.
  it("found 3 of 3 downstream copies (cp#367 Step 1 denominator)", () => {
    const found = [onboardingChecksPurpose(), onboardingApiPurpose(), hostedTierDocPurpose()].filter(
      (v) => v.length > 0,
    );
    expect(found.length, "expected all 3 downstream copies to extract a non-empty value").toBe(3);
  });
});
