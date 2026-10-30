import { describe, expect, it } from "vitest";
import { r2ModuleBundleSource } from "../src/module-bundle-r2";
import { TENANT_MODULE_CATALOG, TenantModuleError, prefetchModuleBundles } from "../src/tenant-modules";

// A catalog row whose module the release did not publish. Real reader, real prefetch, fake bucket.
// This is why a door that leaves the release list has to leave the catalog in the same train.

const RELEASE = "v9.9.9";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function bucketPublishing(names: string[]) {
  const objects = new Map<string, Uint8Array>();
  for (const name of names) {
    const worker = new TextEncoder().encode(`export default { name: "${name}" };`);
    const base = `studio-releases/${RELEASE}/modules/${name}`;
    objects.set(`${base}/worker.mjs`, worker);
    objects.set(
      `${base}/manifest.json`,
      new TextEncoder().encode(
        JSON.stringify({
          module: name,
          main_module: "worker.mjs",
          compatibility_date: "2026-01-01",
          worker: { path: "worker.mjs", sha256: await sha256Hex(worker), size: worker.length },
        }),
      ),
    );
  }
  return {
    get: async (key: string) => {
      const b = objects.get(key);
      return b ? { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } : null;
    },
  } as never;
}

const catalog = TENANT_MODULE_CATALOG.map((s) => s.module);
const depsOver = (bucket: never) => ({ moduleBundle: r2ModuleBundleSource(bucket) }) as never;

describe("prefetchModuleBundles against a release", () => {
  it("CONTROL: resolves when the release publishes every catalog module", async () => {
    const bundles = await prefetchModuleBundles(depsOver(await bucketPublishing(catalog)), RELEASE);
    expect([...bundles.keys()].sort()).toEqual([...catalog].sort());
  });

  it("fails at modules_upload, naming the module, when one catalog module is not published", async () => {
    const missing = catalog[catalog.length - 1];
    const run = prefetchModuleBundles(depsOver(await bucketPublishing(catalog.filter((m) => m !== missing))), RELEASE);
    await expect(run).rejects.toBeInstanceOf(TenantModuleError);
    await expect(run).rejects.toMatchObject({ step: "modules_upload" });
    await expect(run).rejects.toThrow(`fetch module bundle ${missing} at ${RELEASE}`);
    await expect(run).rejects.toThrow("module release object missing from the mirror");
  });
});
