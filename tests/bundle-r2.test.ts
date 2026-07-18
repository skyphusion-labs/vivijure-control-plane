// The production StudioBundleSource (bundle-r2.ts) against a fake R2 binding. What these prove is
// the CONTRACT: layout, tag pinning, integrity refusal, verbatim manifest pass-through. Only a real
// provision against the real mirror proves the bucket itself; that is the live e2e's job.

import { describe, it, expect } from "vitest";
import { r2StudioBundleSource } from "../src/bundle-r2";

const WORKER_TEXT = "export default {};\n";
// sha256 of WORKER_TEXT, precomputed in the test rather than trusted from the code under test.
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fakeBucket(objects: Record<string, string | Uint8Array>): R2Bucket {
  return {
    get: async (key: string) => {
      const v = objects[key];
      if (v === undefined) return null;
      const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v;
      return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
  } as unknown as R2Bucket;
}

async function mirror(tag: string, over: Partial<Record<string, unknown>> = {}) {
  const manifest = {
    tag,
    main_module: "index.js",
    compatibility_date: "2026-06-01",
    compatibility_flags: ["nodejs_compat"],
    worker: { path: "worker.js", sha256: await sha256Hex(WORKER_TEXT), size: WORKER_TEXT.length },
    assets_config: { html_handling: "none", run_worker_first: true },
    assets: [{ path: "/app.js", hash: "abc123", size: 2, content_type: "text/javascript" }],
    ...over,
  };
  return {
    [`studio-releases/${tag}/manifest.json`]: JSON.stringify(manifest),
    [`studio-releases/${tag}/worker.js`]: WORKER_TEXT,
    [`studio-releases/${tag}/assets/abc123`]: "hi",
  };
}

describe("r2StudioBundleSource", () => {
  it("fetches a release: worker text, verbatim assets_config, base64 assets", async () => {
    const src = r2StudioBundleSource(fakeBucket(await mirror("v1.0.1")));
    const built = await src.fetch("v1.0.1");
    expect(built.mainModule).toBe("index.js");
    expect(built.moduleText).toBe(WORKER_TEXT);
    expect(built.compatibilityDate).toBe("2026-06-01");
    // Verbatim, never re-derived: the #77/#78 asset-handling lesson.
    expect(built.assetsConfig).toEqual({ html_handling: "none", run_worker_first: true });
    expect(built.assets).toEqual([
      { path: "/app.js", base64: btoa("hi"), contentType: "text/javascript", hash: "abc123", size: 2 },
    ]);
  });

  it("REFUSES a mirror whose manifest is for a different tag", async () => {
    const objects = await mirror("v1.0.1", { tag: "v9.9.9" });
    const src = r2StudioBundleSource(fakeBucket(objects));
    await expect(src.fetch("v1.0.1")).rejects.toThrow(/tag mismatch/);
  });

  it("REFUSES worker bytes that do not hash to the manifest pin", async () => {
    const objects = await mirror("v1.0.1");
    objects["studio-releases/v1.0.1/worker.js"] = "export default { tampered: true };\n";
    const src = r2StudioBundleSource(fakeBucket(objects));
    await expect(src.fetch("v1.0.1")).rejects.toThrow(/integrity/);
  });

  it("REFUSES a release that is simply not in the mirror, by name", async () => {
    const src = r2StudioBundleSource(fakeBucket({}));
    await expect(src.fetch("v1.0.1")).rejects.toThrow(/missing from the mirror/);
  });

  it("REFUSES a manifest whose asset object is missing (partial publish)", async () => {
    const objects = await mirror("v1.0.1");
    delete objects["studio-releases/v1.0.1/assets/abc123"];
    const src = r2StudioBundleSource(fakeBucket(objects));
    await expect(src.fetch("v1.0.1")).rejects.toThrow(/missing from the mirror/);
  });
});
