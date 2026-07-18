// The production ModuleBundleSource (cf#99): reads tenant module worker bundles from the SAME R2
// release mirror the studio bundle uses, under a per-module subpath. Modules ship WITH the studio
// release they were built and conformance-proven against (one tag, one artifact), so a tenant's
// studio and its modules can never be a mismatched pair.
//
// PROVENANCE + PARITY, identical to bundle-r2.ts: the GitHub release asset is the authoritative public
// artifact; this bucket is the mirror written by the same workflow run from the same bytes. A Worker
// cannot untar a release asset, so it reads the mirror (an R2 binding read is account-local). A
// self-hoster binds their own bucket, same layout:
//   studio-releases/<tag>/modules/<module>/manifest.json
//   studio-releases/<tag>/modules/<module>/worker.js
//
// INTEGRITY, same discipline as the studio bundle: the manifest module name must be the one we asked
// for, and the worker bytes must hash to what the manifest pinned. A provisioner that ships whatever
// is lying in a bucket is how a tenant ends up on a module build nobody chose. Modules carry NO static
// assets (pure workers), so there is no asset leg.

import type { ModuleBundle, ModuleBundleSource } from "./tenant-modules";

interface ModuleReleaseManifest {
  module: string;
  main_module: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  worker: { path: string; sha256: string; size: number };
}

const PREFIX = "studio-releases";

export function r2ModuleBundleSource(bucket: R2Bucket): ModuleBundleSource {
  const read = async (key: string): Promise<ArrayBuffer> => {
    const obj = await bucket.get(key);
    if (!obj) throw new Error(`module release object missing from the mirror: ${key}`);
    return await obj.arrayBuffer();
  };

  return {
    async fetch(release: string, moduleName: string): Promise<ModuleBundle> {
      const base = `${PREFIX}/${release}/modules/${moduleName}`;
      const manifest = JSON.parse(
        new TextDecoder().decode(await read(`${base}/manifest.json`)),
      ) as ModuleReleaseManifest;

      // The artifact must be the module we asked for (a wrong path silently shipping the wrong worker
      // is exactly the drift the integrity checks exist to stop).
      if (manifest.module !== moduleName) {
        throw new Error(`module bundle mismatch: asked for ${moduleName}, artifact is ${manifest.module}`);
      }

      const workerBytes = await read(`${base}/${manifest.worker.path}`);
      const sha = await sha256HexOf(workerBytes);
      if (sha !== manifest.worker.sha256) {
        throw new Error(`module ${moduleName} integrity failure: sha256 ${sha} != manifest ${manifest.worker.sha256}`);
      }

      return {
        mainModule: manifest.main_module,
        moduleText: new TextDecoder().decode(workerBytes),
        compatibilityDate: manifest.compatibility_date,
        compatibilityFlags: manifest.compatibility_flags,
      };
    },
  };
}

async function sha256HexOf(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
