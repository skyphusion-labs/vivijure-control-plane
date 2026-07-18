import { describe, expect, it } from "vitest";
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
