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
