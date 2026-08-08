/**
 * cp#298: pin the RunPod module-host census comments so a wrong "measured" figure cannot re-land.
 *
 * `src/runpod-proxy-route-match.ts` once claimed "23 of 26 modules" referenced api.runpod.ai at
 * vivijure-cf@d26db49. Re-measurement at that exact sha (and again at b295309) is 14, and that
 * split is what `src/runpod-proxy.ts` already states. The count is not load-bearing for routing
 * (the proxy uses allow-list + pool ids as data), but a specific wrong number in a source comment
 * becomes somebody's evidence when scoping work.
 *
 * This suite does not re-scan vivijure-cf. It pins that the two comments in THIS repo agree with
 * each other and with the reproducible split, and that the unreproduced 23 cannot return.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ENDPOINT_ALLOWLIST } from "../src/runpod-proxy.js";

const repoRoot = join(import.meta.dirname, "..");

const CENSUS_FILES = [
  "src/runpod-proxy-route-match.ts",
  "src/runpod-proxy.ts",
] as const;

/** The reproducible split (cp#298 / runpod-proxy.ts): 14 host refs = 8 public slug + 6 env. */
const HOST_REFS = 14;
const PUBLIC_SLUGS = 8;
const ENV_ENDPOINT_READERS = 6;
const MODULE_DENOMINATOR = 26;

describe("RunPod module-host census comments (cp#298)", () => {
  const texts = Object.fromEntries(
    CENSUS_FILES.map((rel) => [rel, readFileSync(join(repoRoot, rel), "utf8")]),
  ) as Record<(typeof CENSUS_FILES)[number], string>;

  it("neither census comment claims the unreproduced 23-of-26 figure", () => {
    for (const rel of CENSUS_FILES) {
      expect(texts[rel], rel).not.toMatch(/23 of 26/);
    }
  });

  it("both census comments state the reproducible 14-of-26 host-reference count", () => {
    // route-match: "14 of 26"; runpod-proxy: "14 reference api.runpod.ai/v2/" with denominator 26.
    expect(texts["src/runpod-proxy-route-match.ts"]).toMatch(/14 of 26/);
    expect(texts["src/runpod-proxy.ts"]).toMatch(
      new RegExp(`denominator of ${MODULE_DENOMINATOR} modules[\\s\\S]*?${HOST_REFS} reference api\\.runpod\\.ai`),
    );
  });

  it("the public-slug half of the split matches PUBLIC_ENDPOINT_ALLOWLIST length", () => {
    // The 8 hard-coded public slugs are the allow-list itself. If either side moves without the
    // other, the comment's "8 hard-code a public slug" claim becomes a lie again.
    expect(PUBLIC_ENDPOINT_ALLOWLIST).toHaveLength(PUBLIC_SLUGS);
    expect(PUBLIC_SLUGS + ENV_ENDPOINT_READERS).toBe(HOST_REFS);
    for (const rel of CENSUS_FILES) {
      // Both comments name the 8/6 split (route-match after cp#298; proxy already did).
      expect(texts[rel], rel).toMatch(/\b8\b[\s\S]*?\b6\b/);
    }
  });
});
