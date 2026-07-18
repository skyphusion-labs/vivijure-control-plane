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
//   studio-releases/<tag>/migrations/<name>.sql   (v1.3.1+)
//
// INTEGRITY, same discipline as the local harness source: the manifest tag must be the tag we were
// ASKED for, and the worker bytes must hash to what the manifest pinned. A provisioner that ships
// whatever is lying in a bucket is how a tenant ends up on a build nobody chose.
//
// PIN FLOOR v1.3.1 (cf#85). The artifact carries the tenant D1 SCHEMA and the studio env var
// contract as of that release. Before it, the control plane imported both out of the vivijure-cf
// source tree, which is exactly the cross-repo coupling the extraction removes. There is no
// fallback to a baked-in copy: a manifest without `migrations` or `required_vars` is REFUSED, loudly
// and by name. A fallback would silently provision tenants from a stale in-repo copy of a schema
// that lives somewhere else now, which is the drift this whole change exists to make impossible.
//
// Note v1.3.0 published NO artifact (release-builder specifier bug), so pinning it resolves to an
// empty mirror slot and fails on the missing manifest read. Honest, if terse.

import type { StudioBundleSource } from "./provisioner";

interface ReleaseManifest {
  tag: string;
  main_module: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  worker: { path: string; sha256: string; size: number };
  assets_config?: Record<string, unknown>;
  assets: { path: string; hash: string; size: number; content_type: string }[];
  /** v1.3.1+. Apply order IS array order; `name` is the tracking key in schema_migrations. */
  migrations?: { name: string; sha256: string; size: number }[];
  /** v1.3.1+. The studio ORCHESTRATOR_VAR_KEYS contract, projected at build time. */
  required_vars?: string[];
}

/**
 * The first release whose manifest carries `migrations` + `required_vars`.
 *
 * Named rather than inlined because it appears in the refusal messages, and an operator reading
 * "needs at least v1.3.1" should be reading the same constant the check uses.
 */
export const MANIFEST_PIN_FLOOR = "v1.3.1";

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

      // The tenant D1 schema, verified against bytes we did not build (cf#85). Refused outright if
      // absent: see the PIN FLOOR note at the top for why there is no baked-in fallback.
      if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
        throw new Error(
          `release ${release} carries no migrations; the control plane needs ${MANIFEST_PIN_FLOOR} or later`,
        );
      }
      if (!Array.isArray(manifest.required_vars) || manifest.required_vars.length === 0) {
        throw new Error(
          `release ${release} carries no required_vars; the control plane needs ${MANIFEST_PIN_FLOOR} or later`,
        );
      }

      const migrations = [];
      for (const m of manifest.migrations) {
        const bytes = await read(`${base}/migrations/${m.name}`);
        const migSha = await sha256HexOf(bytes);
        // Same reasoning as the worker check, and it matters more: a corrupted migration does not
        // fail the provision, it silently gives a tenant the wrong schema.
        if (migSha !== m.sha256) {
          throw new Error(`migration integrity failure for ${m.name}: sha256 ${migSha} != manifest ${m.sha256}`);
        }
        if (bytes.byteLength !== m.size) {
          throw new Error(`migration size mismatch for ${m.name}: ${bytes.byteLength} != manifest ${m.size}`);
        }
        migrations.push({ name: m.name, sql: new TextDecoder().decode(bytes) });
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
        migrations,
        requiredVars: manifest.required_vars,
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
