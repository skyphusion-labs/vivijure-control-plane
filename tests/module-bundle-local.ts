// A ModuleBundleSource that reads locally-built module release artifacts from a studio release dir.
// Layout mirrors the R2 mirror (cf-api parity):
//   {dir}/modules/{moduleName}/manifest.json
//   {dir}/modules/{moduleName}/{worker.path}
//
// HARNESS code only (tests/); same provenance caveat as studio-bundle-local.ts.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ModuleBundle, ModuleBundleSource } from "../src/tenant-modules";

interface ModuleReleaseManifest {
  module: string;
  main_module: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  worker: { path: string; sha256: string; size: number };
}

export function localModuleBundleSource(releaseDir: string): ModuleBundleSource {
  return {
    async fetch(release: string, moduleName: string) {
      void release;
      const base = join(releaseDir, "modules", moduleName);
      const manifest = JSON.parse(
        readFileSync(join(base, "manifest.json"), "utf8"),
      ) as ModuleReleaseManifest;

      if (manifest.module !== moduleName) {
        throw new Error(`module bundle mismatch: asked for ${moduleName}, artifact is ${manifest.module}`);
      }

      const bytes = readFileSync(join(base, manifest.worker.path));
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (sha !== manifest.worker.sha256) {
        throw new Error(`module ${moduleName} integrity failure: sha256 ${sha} != manifest ${manifest.worker.sha256}`);
      }

      return {
        mainModule: manifest.main_module,
        moduleText: bytes.toString("utf8"),
        compatibilityDate: manifest.compatibility_date,
        compatibilityFlags: manifest.compatibility_flags,
      } satisfies ModuleBundle;
    },
  };
}
