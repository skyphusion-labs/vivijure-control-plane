// A StudioBundleSource that reads a locally-built release artifact (#53/#59).
//
// PROVENANCE, stated plainly because it is the whole caveat: this reads the artifact produced by
// scripts/build-studio-release.ts from a directory. It is NOT the published-tag fetch. The build
// script reads no secrets and no account state, so a local build of a given commit is byte-identical
// to what the workflow publishes for that tag -- but "byte-identical by construction" and "fetched
// from the published location" are different claims, and only the second one proves the shipping
// path. This exists so the e2e chain can be shaken out before a tag exists; the fetching
// implementation replaces it at first release and is the launch gate's job to prove.
//
// Lives in tests/, not src/, deliberately: it reads the filesystem, and src/ compiles against
// workers-types with no Node types. This is HARNESS code -- the live e2e uses it, the shipping
// Worker never does. Putting it in src/ would have meant loosening the Worker tsconfig to admit
// Node globals the Worker cannot use, which is the tail wagging the dog.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { StudioBundleSource } from "../src/provisioner";

interface ReleaseManifest {
  tag: string;
  main_module: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  worker: { path: string; sha256: string; size: number };
  assets_config?: Record<string, unknown>;
  assets: { path: string; hash: string; size: number; content_type: string }[];
  migrations?: { name: string; sha256: string; size: number }[];
  required_vars?: string[];
}

export function localStudioBundleSource(dir: string): StudioBundleSource {
  return {
    async fetch(release: string) {
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as ReleaseManifest;

      // The artifact must be the one we were ASKED for. A provisioner that quietly ships whatever
      // is lying in a directory is how a tenant ends up on a build nobody chose.
      if (manifest.tag !== release) {
        throw new Error(`bundle tag mismatch: asked for ${release}, artifact is ${manifest.tag}`);
      }

      const bytes = readFileSync(join(dir, manifest.worker.path));
      const sha = createHash("sha256").update(bytes).digest("hex");
      // Integrity BEFORE it reaches a tenant: a truncated or wrong bundle in a paying tenant's
      // studio is worse than a failed provision.
      if (sha !== manifest.worker.sha256) {
        throw new Error(`bundle integrity failure: sha256 ${sha} != manifest ${manifest.worker.sha256}`);
      }

      // Mirrors the shipping r2StudioBundleSource checks (cf#85): refuse a pre-v1.3.1 artifact rather
      // than provisioning a tenant with no schema, and verify each migration against its own hash.
      if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
        throw new Error(`release ${release} carries no migrations; the control plane needs v1.3.1 or later`);
      }
      if (!Array.isArray(manifest.required_vars) || manifest.required_vars.length === 0) {
        throw new Error(`release ${release} carries no required_vars; the control plane needs v1.3.1 or later`);
      }
      const migrations = manifest.migrations.map((m) => {
        const mb = readFileSync(join(dir, "migrations", m.name));
        const mSha = createHash("sha256").update(mb).digest("hex");
        if (mSha !== m.sha256) {
          throw new Error(`migration integrity failure for ${m.name}: sha256 ${mSha} != manifest ${m.sha256}`);
        }
        return { name: m.name, sql: mb.toString("utf8") };
      });

      return {
        mainModule: manifest.main_module,
        moduleText: bytes.toString("utf8"),
        compatibilityDate: manifest.compatibility_date,
        compatibilityFlags: manifest.compatibility_flags,
        // Verbatim, including {}: an empty object means the release was built with CF defaults and
        // the tenant should get CF defaults. Never substitute the core's values for it.
        assetsConfig: manifest.assets_config,
        assets: manifest.assets.map((a) => ({
          path: a.path,
          base64: readFileSync(join(dir, "assets", a.hash)).toString("base64"),
          contentType: a.content_type,
          hash: a.hash,
          size: a.size,
        })),
        migrations,
        requiredVars: manifest.required_vars,
      };
    },
  };
}
