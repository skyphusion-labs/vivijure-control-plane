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

// `@cloudflare/workers-types` declares a GLOBAL `Buffer` whose `toString()` takes no arguments, and
// it wins over @types/node's in this project's global scope. So `someNodeBuffer.toString("utf8")`
// stopped type-checking (TS2554 "Expected 0 arguments, but got 1") purely from a types bump -- the
// runtime behaviour never changed and these are Node buffers in Node-only test helpers.
//
// Importing Buffer explicitly from "node:buffer" and routing through `Buffer.from(...)` names which
// Buffer is meant, rather than casting the error away. A cast would silence the same message for a
// value that genuinely IS the Workers type, which is the case worth keeping loud.
import { Buffer } from "node:buffer";

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
        moduleText: Buffer.from(bytes).toString("utf8"),
        compatibilityDate: manifest.compatibility_date,
        compatibilityFlags: manifest.compatibility_flags,
      } satisfies ModuleBundle;
    },
  };
}
