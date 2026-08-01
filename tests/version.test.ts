import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTROL_PLANE_VERSION } from "../src/version.js";

// NOTE: import.meta.dirname (node 22+), not `new URL(...)`. The tests tsconfig loads BOTH
// @cloudflare/workers-types and @types/node, and their `URL` types are structurally
// incompatible -- readFileSync(new URL(...)) fails typecheck here even though it runs fine.
const repoRoot = join(import.meta.dirname, "..");

describe("control-plane version", () => {
  it("matches the version declared in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(CONTROL_PLANE_VERSION).toBe(pkg.version);
  });

  it("is a bare SemVer triple (the deploy pipeline tags v<version>)", () => {
    expect(CONTROL_PLANE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// cp#252: package-lock.json declares this package own version in two places (top-level and
// packages[""].version) and it drifted from package.json UNDETECTED -- 1.9.0 in the lock beside
// 1.19.0 in package.json, for at least one full release cycle. Ported from the vivijure-cf guard
// (tests/changelog-version.test.ts, cf#274), same parser and same control shape, so both repos
// keep this invariant in the same place a maintainer of either would look.
/** The two places package-lock.json declares this package own version: the top-level "version"
 *  field, and packages[""].version (the root package entry, lockfileVersion 3 shape). Returns null
 *  on anything malformed or missing rather than a partial result, so a broken parse fails the
 *  assertion instead of comparing against undefined and passing by accident. */
export function lockFileVersions(lockJson: string): { top: string; root: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const packages = obj.packages;
  if (typeof obj.version !== "string" || typeof packages !== "object" || packages === null) return null;
  const rootEntry = (packages as Record<string, unknown>)[""];
  if (typeof rootEntry !== "object" || rootEntry === null) return null;
  const rootVersion = (rootEntry as Record<string, unknown>).version;
  if (typeof rootVersion !== "string") return null;
  return { top: obj.version, root: rootVersion };
}

describe("package-lock.json agrees with package.json (cp#252, ported from vivijure-cf#274)", () => {
  it("both the top-level version and packages[\"\"].version match package.json", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const lockRaw = readFileSync(join(repoRoot, "package-lock.json"), "utf8");
    const lock = lockFileVersions(lockRaw);
    expect(lock, "package-lock.json is missing or malformed at the fields this check reads").not.toBeNull();
    expect(
      lock?.top,
      `package-lock.json top-level version is ${lock?.top} but package.json declares ${pkg.version}; run npm install to refresh the lock`,
    ).toBe(pkg.version);
    expect(
      lock?.root,
      `package-lock.json packages[""].version is ${lock?.root} but package.json declares ${pkg.version}; run npm install to refresh the lock`,
    ).toBe(pkg.version);
  });

  it("CONTROL: the parser reads a planted lock file with both fields present", () => {
    const planted = JSON.stringify({
      version: "2.4.1",
      packages: { "": { version: "2.4.1" } },
    });
    expect(lockFileVersions(planted)).toEqual({ top: "2.4.1", root: "2.4.1" });
  });

  it("CONTROL: a planted mismatch on the top-level field is what this test exists to catch", () => {
    // The exact shape cp#252 found undetected: package.json declared 1.19.0 while
    // package-lock.json declared 1.9.0 at both fields.
    const planted = JSON.stringify({
      version: "1.9.0",
      packages: { "": { version: "1.9.0" } },
    });
    const lock = lockFileVersions(planted);
    expect(lock?.top === "1.19.0").toBe(false);
  });

  it("CONTROL: a planted mismatch on packages[\"\"].version alone is caught too", () => {
    const planted = JSON.stringify({
      version: "1.20.0",
      packages: { "": { version: "1.19.0" } },
    });
    const lock = lockFileVersions(planted);
    expect(lock?.root === "1.20.0").toBe(false);
  });

  it("CONTROL: malformed JSON and a missing root package entry both fail closed, not open", () => {
    expect(lockFileVersions("not json")).toBeNull();
    expect(lockFileVersions(JSON.stringify({ version: "1.0.0", packages: {} }))).toBeNull();
  });
});

// cf#114 (d): the version is only useful if something outside the deploy can READ it. Before this,
// confirming which release the plane served meant fetching a changed asset and reading the patched
// line off the wire, which is archaeology, not observability.
describe("GET /api/platform/version", () => {
  it("serves CONTROL_PLANE_VERSION, unauthenticated", async () => {
    const { default: worker } = await import("../src/index.js");
    const res = await worker.fetch(
      new Request("https://studio.vivijure.com/api/platform/version"),
      {
        ASSETS: { fetch: async () => new Response("ui") },
        CP_DB: {},
        AUP_VERSION: "1",
        AUP_URL: "https://example.com/aup",
        CONTROL_PLANE_HOST: "studio.vivijure.com",
      } as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ control_plane_version: CONTROL_PLANE_VERSION });
  });

  it("reports the SAME version the lockstep gate pins, so it cannot drift from the tag", async () => {
    // A route that reported a hardcoded or separately-maintained string would be worse than no
    // route: it would answer "what is running" with a confident lie.
    const { default: worker } = await import("../src/index.js");
    const res = await worker.fetch(
      new Request("https://studio.vivijure.com/api/platform/version"),
      {
        ASSETS: { fetch: async () => new Response("ui") },
        CP_DB: {},
        AUP_VERSION: "1",
        AUP_URL: "https://example.com/aup",
        CONTROL_PLANE_HOST: "studio.vivijure.com",
      } as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never,
    );
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(((await res.json()) as { control_plane_version: string }).control_plane_version).toBe(pkg.version);
  });
});
