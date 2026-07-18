// The production StudioBundleSource (#53's open seam, closed): reads the studio release artifact
// from the R2 mirror that .github/workflows/studio-release.yml publishes.
//
// PROVENANCE: the GitHub release asset is the authoritative public artifact (parity ruling in the
// workflow header); this bucket is the mirror OF that artifact, written by the same workflow run
// from the same bytes. The Worker reads the mirror because a Worker cannot untar a release asset,
// and an R2 binding read is account-local. A self-hoster binds their own bucket, same layout:
//   studio-releases/<tag>/manifest.json
//   studio-releases/<tag>/worker.js
//   studio-releases/<tag>/assets/<hash>
//
// INTEGRITY, same discipline as the local harness source: the manifest tag must be the tag we were
// ASKED for, and the worker bytes must hash to what the manifest pinned. A provisioner that ships
// whatever is lying in a bucket is how a tenant ends up on a build nobody chose.

import type { StudioBundleSource } from "./provisioner";

interface ReleaseManifest {
  tag: string;
  main_module: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  worker: { path: string; sha256: string; size: number };
  assets_config?: Record<string, unknown>;
  assets: { path: string; hash: string; size: number; content_type: string }[];
}

const PREFIX = "studio-releases";

export function r2StudioBundleSource(bucket: R2Bucket): StudioBundleSource {
  const read = async (key: string): Promise<ArrayBuffer> => {
    const obj = await bucket.get(key);
    if (!obj) throw new Error(`studio release object missing from the mirror: ${key}`);
    return await obj.arrayBuffer();
  };

  return {
    async fetch(release: string) {
      const base = `${PREFIX}/${release}`;
      const manifest = JSON.parse(new TextDecoder().decode(await read(`${base}/manifest.json`))) as ReleaseManifest;

      // The artifact must be the one we were ASKED for.
      if (manifest.tag !== release) {
        throw new Error(`bundle tag mismatch: asked for ${release}, artifact is ${manifest.tag}`);
      }

      const workerBytes = await read(`${base}/${manifest.worker.path}`);
      const sha = await sha256HexOf(workerBytes);
      // Integrity BEFORE it reaches a tenant: a truncated or wrong bundle in a tenant's studio is
      // worse than a failed provision.
      if (sha !== manifest.worker.sha256) {
        throw new Error(`bundle integrity failure: sha256 ${sha} != manifest ${manifest.worker.sha256}`);
      }

      const assets = [];
      for (const a of manifest.assets) {
        assets.push({
          path: a.path,
          base64: toBase64(await read(`${base}/assets/${a.hash}`)),
          contentType: a.content_type,
          hash: a.hash,
          size: a.size,
        });
      }

      return {
        mainModule: manifest.main_module,
        moduleText: new TextDecoder().decode(workerBytes),
        compatibilityDate: manifest.compatibility_date,
        compatibilityFlags: manifest.compatibility_flags,
        // Verbatim, including {}: an empty object means the release was built with CF defaults and
        // the tenant should get CF defaults (#77/#78). Never substitute the core's values for it.
        assetsConfig: manifest.assets_config,
        assets,
      };
    },
  };
}

async function sha256HexOf(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Chunked btoa: String.fromCharCode(...bigArray) blows the argument limit on real asset sizes. */
function toBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
