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

const MIGRATION_SQL = "CREATE TABLE IF NOT EXISTS projects (id TEXT);";

async function mirror(tag: string, over: Partial<Record<string, unknown>> = {}) {
  const manifest = {
    tag,
    main_module: "index.js",
    compatibility_date: "2026-06-01",
    compatibility_flags: ["nodejs_compat"],
    worker: { path: "worker.js", sha256: await sha256Hex(WORKER_TEXT), size: WORKER_TEXT.length },
    assets_config: { html_handling: "none", run_worker_first: true },
    assets: [{ path: "/app.js", hash: "abc123", size: 2, content_type: "text/javascript" }],
    // v1.3.1+ manifest shape (cf#85): the tenant schema and the studio var contract ride the release.
    migrations: [{ name: "0001_init.sql", sha256: await sha256Hex(MIGRATION_SQL), size: MIGRATION_SQL.length }],
    required_vars: ["AUTH_MODE", "R2_S3_ENDPOINT"],
    ...over,
  };
  return {
    [`studio-releases/${tag}/manifest.json`]: JSON.stringify(manifest),
    [`studio-releases/${tag}/worker.js`]: WORKER_TEXT,
    [`studio-releases/${tag}/assets/abc123`]: "hi",
    [`studio-releases/${tag}/migrations/0001_init.sql`]: MIGRATION_SQL,
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

describe("the v1.3.1 pin floor and migration integrity (cf#85)", () => {
  it("returns the migrations and the var contract from the artifact", async () => {
    const src = r2StudioBundleSource(fakeBucket(await mirror("v1.3.1")));
    const built = await src.fetch("v1.3.1");
    expect(built.migrations.map((m) => m.name)).toEqual(["0001_init.sql"]);
    expect(built.migrations[0].sql).toBe(MIGRATION_SQL);
    expect(built.requiredVars).toEqual(["AUTH_MODE", "R2_S3_ENDPOINT"]);
  });

  it("REFUSES a pre-floor artifact carrying no migrations, naming the floor", async () => {
    // No fallback to a baked-in copy, deliberately: that would silently provision tenants from a
    // stale in-repo schema, which is the drift this whole change exists to make impossible.
    const src = r2StudioBundleSource(fakeBucket(await mirror("v1.2.5", { migrations: undefined })));
    await expect(src.fetch("v1.2.5")).rejects.toThrow(/carries no migrations.*v1\.3\.1 or later/);
  });

  it("REFUSES an artifact carrying no required_vars", async () => {
    const src = r2StudioBundleSource(fakeBucket(await mirror("v1.2.5", { required_vars: undefined })));
    await expect(src.fetch("v1.2.5")).rejects.toThrow(/carries no required_vars.*v1\.3\.1 or later/);
  });

  it("REFUSES a migration whose bytes do not match its manifest hash", async () => {
    // A corrupted migration does not fail the provision on its own; it silently gives a tenant the
    // WRONG SCHEMA. That is why this is verified rather than trusted.
    const objects = await mirror("v1.3.1");
    objects["studio-releases/v1.3.1/migrations/0001_init.sql"] = "DROP TABLE projects;";
    const src = r2StudioBundleSource(fakeBucket(objects));
    await expect(src.fetch("v1.3.1")).rejects.toThrow(/migration integrity failure for 0001_init\.sql/);
  });

  it("REFUSES a migration that is missing from the mirror entirely", async () => {
    const objects = await mirror("v1.3.1");
    delete objects["studio-releases/v1.3.1/migrations/0001_init.sql"];
    const src = r2StudioBundleSource(fakeBucket(objects));
    await expect(src.fetch("v1.3.1")).rejects.toThrow(/missing from the mirror/);
  });
});
