// The production ModuleBundleSource (module-bundle-r2.ts) against a fake R2 binding (cf#99). Proves
// the CONTRACT: per-module layout under the shared release, module-name pinning, sha256 integrity
// refusal, verbatim compat pass-through. The real mirror is proven by the live provision, not here.

import { describe, it, expect } from "vitest";
import { r2ModuleBundleSource } from "../src/module-bundle-r2";

const WORKER_TEXT = "export default { async fetch() { return new Response('ok'); } };\n";
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fakeBucket(objects: Record<string, string>): R2Bucket {
  return {
    get: async (key: string) => {
      const v = objects[key];
      if (v === undefined) return null;
      const bytes = new TextEncoder().encode(v);
      return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
  } as unknown as R2Bucket;
}

async function mirror(tag: string, module: string, over: Partial<Record<string, unknown>> = {}) {
  const manifest = {
    module,
    main_module: "index.js",
    compatibility_date: "2026-06-01",
    compatibility_flags: ["nodejs_compat"],
    worker: { path: "worker.js", sha256: await sha256Hex(WORKER_TEXT), size: WORKER_TEXT.length },
    ...over,
  };
  return {
    [`studio-releases/${tag}/modules/${module}/manifest.json`]: JSON.stringify(manifest),
    [`studio-releases/${tag}/modules/${module}/worker.js`]: WORKER_TEXT,
  };
}

describe("r2ModuleBundleSource", () => {
  it("fetches a module bundle: worker text + verbatim compat config", async () => {
    const src = r2ModuleBundleSource(fakeBucket(await mirror("v1.0.0", "keyframe")));
    const b = await src.fetch("v1.0.0", "keyframe");
    expect(b.mainModule).toBe("index.js");
    expect(b.moduleText).toBe(WORKER_TEXT);
    expect(b.compatibilityDate).toBe("2026-06-01");
    expect(b.compatibilityFlags).toEqual(["nodejs_compat"]);
  });

  it("reads each module from its OWN subpath (no cross-module bleed)", async () => {
    const objects = { ...(await mirror("v1.0.0", "keyframe")), ...(await mirror("v1.0.0", "finish-upscale")) };
    const src = r2ModuleBundleSource(fakeBucket(objects));
    await expect(src.fetch("v1.0.0", "keyframe")).resolves.toBeTruthy();
    await expect(src.fetch("v1.0.0", "finish-upscale")).resolves.toBeTruthy();
  });

  it("REFUSES a manifest whose module name is not the one asked for (wrong-worker guard)", async () => {
    const objects = await mirror("v1.0.0", "keyframe", { module: "own-gpu" });
    const src = r2ModuleBundleSource(fakeBucket(objects));
    await expect(src.fetch("v1.0.0", "keyframe")).rejects.toThrow(/bundle mismatch/);
  });

  it("REFUSES on a sha256 mismatch (a truncated/wrong worker never reaches a tenant)", async () => {
    const objects = await mirror("v1.0.0", "keyframe", { worker: { path: "worker.js", sha256: "deadbeef", size: 3 } });
    const src = r2ModuleBundleSource(fakeBucket(objects));
    await expect(src.fetch("v1.0.0", "keyframe")).rejects.toThrow(/integrity failure/);
  });

  it("REFUSES honestly when a release object is missing from the mirror", async () => {
    const src = r2ModuleBundleSource(fakeBucket({}));
    await expect(src.fetch("v1.0.0", "keyframe")).rejects.toThrow(/missing from the mirror/);
  });
});
