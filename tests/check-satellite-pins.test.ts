// cp#627. Drive scripts/check-satellite-pins.mjs REGISTRY mode against a local stand-in for GHCR and
// assert each exit band by its named reason. The load-bearing case is the timeout: before cp#627 an
// aborted request escaped as an unhandled rejection and Node exited 1 -- the DRIFT band -- so a GHCR
// stall read as "a pin does not resolve". Exit 2 means could not perform, and only 2 is right there.
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { GHCR_ORG, SATELLITE_PINS } from "../src/satellite-pins";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "check-satellite-pins.mjs");
const PINS = Object.values(SATELLITE_PINS);

let live: Server | undefined;

afterEach(async () => {
  if (live) await new Promise<void>((r) => live!.close(() => r()));
  live = undefined;
});

type Ghcr = { tokenStatus?: number; digest?: (repo: string) => string | null; hang?: boolean };

/** A fake GHCR: /token issues a token; HEAD /v2/<org>/<repo>/manifests/<tag> answers a digest. */
async function ghcr(opts: Ghcr): Promise<string> {
  live = createServer((req, res) => {
    if (opts.hang) return; // never answers: the abort path
    const url = req.url ?? "";
    if (url.startsWith("/token")) {
      res.writeHead(opts.tokenStatus ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "fixture-not-a-real-token" }));
      return;
    }
    const m = /^\/v2\/([^/]+)\/([^/]+)\/manifests\//.exec(url);
    const digest = m && m[1] === GHCR_ORG ? (opts.digest ?? pinnedDigest)(m[2]) : null;
    if (!digest) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "docker-content-digest": digest });
    res.end();
  });
  await new Promise<void>((r) => live!.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(live!.address() as AddressInfo).port}`;
}

function pinnedDigest(repo: string): string | null {
  return PINS.find((p) => p.repo === repo)?.digest ?? null;
}

function run(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      { env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv, timeout: 15_000 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

describe("check-satellite-pins -- REGISTRY mode transport (cp#627)", () => {
  it("PASSES when every pin resolves to its pinned digest (the positive control)", async () => {
    const base = await ghcr({});
    const r = await run({ CHECK_SATELLITE_PINS_GHCR: base });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`all ${PINS.length} pins verified`);
  });

  it("announces a redirected run so it cannot pass for a registry measurement", async () => {
    const base = await ghcr({});
    const r = await run({ CHECK_SATELLITE_PINS_GHCR: base });
    expect(r.out).toContain("REDIRECTED by CHECK_SATELLITE_PINS_GHCR");
  });

  it("goes RED (1) when a tag resolves to a digest other than the pin -- drift stays drift", async () => {
    const base = await ghcr({ digest: () => "sha256:" + "0".repeat(64) });
    const r = await run({ CHECK_SATELLITE_PINS_GHCR: base });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("now resolves to sha256:0000");
  });

  it("REFUSES (2) when a GHCR request exceeds the timeout, never DRIFT (1)", async () => {
    const base = await ghcr({ hang: true });
    const r = await run({ CHECK_SATELLITE_PINS_GHCR: base, CHECK_SATELLITE_PINS_TIMEOUT_MS: "250" });
    expect(r.code, r.out).toBe(2);
    expect(r.out).toMatch(/request to http:\/\/127\.0\.0\.1:\d+ exceeded the 250ms timeout -- the check could not be performed/);
    expect(r.out).not.toContain("AbortError");
  });

  it("REFUSES (2) when the connection is refused, never DRIFT (1)", async () => {
    const base = await ghcr({});
    await new Promise<void>((r) => live!.close(() => r()));
    live = undefined;
    const r = await run({ CHECK_SATELLITE_PINS_GHCR: base });
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain("failed at the transport layer");
  });

  it("REFUSES (2) when GHCR refuses the token", async () => {
    const base = await ghcr({ tokenStatus: 503 });
    const r = await run({ CHECK_SATELLITE_PINS_GHCR: base });
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain("failed: HTTP 503");
  });
});
