// Fetch the PUBLISHED studio release artifact for a tag, so a live suite can upload the same module
// bundles a tenant would actually receive (cp#255).
//
// WHICH COPY, and it is the same answer scripts/check-release-modules.py already settled: the
// GITHUB RELEASE. studio-release.yml calls the GitHub release the "PUBLIC source of truth" and R2 a
// "CACHE/MIRROR only, never the source of truth". Reading the release is also credential-free
// (vivijure-cf is public), which is why this needs no R2 grant and cannot be blamed on one.
//
// WHAT THIS IS NOT: it is not a mirror check. The provisioner reads R2 and src/module-bundle-r2.ts
// has no fallback, so a release that is internally perfect but never mirrored still fails at
// provision. That gap is real, it is covered by the deploy-time mirror assertion in
// check-release-modules.py, and this file does not re-cover it. Said out loud rather than left for
// someone to assume the smoke proves more than it does.
//
// THE CONTROL, before any bundle is served: the artifact's own top-level manifest must declare the
// tag we asked for. Without it a wrong-tag or truncated download degrades into "every module is
// missing", which sends the reader hunting a problem that does not exist.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FetchedStudioRelease {
  /** Extraction root, laid out exactly like the R2 mirror: modules/<name>/manifest.json + worker. */
  dir: string;
  /** The tag the artifact declares about ITSELF, already checked to equal the tag requested. */
  tag: string;
  /** Remove the extraction directory. Safe to call twice. */
  cleanup(): void;
}

interface TopManifest {
  tag?: string;
}

/**
 * Download and extract `studio-release-<tag>.tar.gz` from the release repo.
 *
 * Anonymous HTTPS. An Authorization header is attached only when a token happens to be in the
 * environment, so this keeps working if the repo is ever made private without becoming dependent on
 * a credential it does not need today.
 */
export async function fetchStudioRelease(repo: string, tag: string): Promise<FetchedStudioRelease> {
  const url = `https://github.com/${repo}/releases/download/${tag}/studio-release-${tag}.tar.gz`;
  const headers: Record<string, string> = { "user-agent": "vivijure-pre-deploy-smoke" };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token && token.length > 0) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) {
    throw new Error(
      `studio release download ${url} returned HTTP ${res.status}. A 404 means the release or its ` +
        `artifact does not exist for that tag.`,
    );
  }
  const bytes = Buffer.from(await res.arrayBuffer());

  const dir = mkdtempSync(join(tmpdir(), "cpsmoke-release-"));
  const tarPath = join(dir, "studio-release.tar.gz");
  writeFileSync(tarPath, bytes);
  // Shelling out to tar rather than carrying a tar reader: this is harness code, tar is present on
  // every runner and every crew box, and a hand-rolled parser is a second thing that can be wrong
  // about the artifact under test.
  execFileSync("tar", ["-xzf", tarPath, "-C", dir], { stdio: "pipe" });
  rmSync(tarPath, { force: true });

  // THE CONTROL. Separates "the release is wrong" from "we downloaded the wrong thing".
  let declared: string | undefined;
  try {
    declared = (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as TopManifest).tag;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`studio release ${tag}: manifest.json is missing or unreadable (${String(e)})`);
  }
  if (declared !== tag) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`studio release artifact declares tag ${String(declared)}, asked for ${tag}`);
  }

  return {
    dir,
    tag,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
