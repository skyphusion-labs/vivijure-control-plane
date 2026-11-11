// Drive every arm of scripts/check-flagship-version.mjs (cp#564) and assert the NAMED REASON, not just
// the exit code. Same method as tests/check-studio-pin.test.ts: the script runs as a CHILD PROCESS
// against a real local HTTP server, so the fetches, the pagination, the parsing and the exit codes
// are the shipped ones, and only the endpoint BASE is redirected (the script prints that).
//
// The deployed-content route returns RAW script text, the way Cloudflare's content/v2 does, so the
// version marker is matched in bytes and never in a JSON-escaped string.

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "check-flagship-version.mjs");

type Route = { status?: number; body?: unknown; raw?: string };
type Routes = Array<[string, Route]>;

let live: Server | undefined;
afterEach(async () => {
  if (live) await new Promise<void>((r) => live!.close(() => r()));
  live = undefined;
});

/** Routes match by PREFIX in the order given, so a specific path is listed before its parent. */
async function serve(routes: Routes): Promise<string> {
  live = createServer((req, res) => {
    const path = req.url ?? "";
    const hit = routes.find(([k]) => path === k || path.startsWith(k + (k.includes("?") ? "" : "?")) || path === k.split("?")[0] && !k.includes("?"));
    if (!hit) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no fixture for ${path}` }));
      return;
    }
    const r = hit[1];
    if (r.raw !== undefined) {
      res.writeHead(r.status ?? 200, { "content-type": "multipart/form-data; boundary=x" });
      res.end(r.raw);
      return;
    }
    res.writeHead(r.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => live!.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(live!.address() as AddressInfo).port}`;
}

function run(env: Record<string, string | undefined>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}

const SC = "/accounts/acct/workers/scripts";
const REPO = "/repos/skyphusion-labs/vivijure-cf";
const bundle = (v: string) => `--x\r\nContent-Disposition: form-data; name="worker.js"\r\n\r\nvar foo=1;var PACKAGE_VERSION = "${v}";export default{}\r\n--x--\r\n`;

function routes(o: { bytes?: string; content?: Route; tags?: string[][]; latest?: string; scripts?: unknown[] } = {}): Routes {
  const pages = o.tags ?? [["v1.37.0", "v1.36.0", "v1.10.0"]];
  const r: Routes = [
    [`${SC}/vivijure-studio/content/v2`, o.content ?? { raw: o.bytes ?? bundle("1.37.0") }],
    [SC, { body: { success: true, result: o.scripts ?? [{ id: "vivijure-studio" }, { id: "other" }] } }],
    [`${REPO}/releases/latest`, { body: { tag_name: o.latest ?? "v1.37.0" } }],
  ];
  pages.forEach((p, i) => r.push([`${REPO}/tags?per_page=100&page=${i + 1}`, { body: p.map((name) => ({ name })) }]));
  r.push([`${REPO}/tags?per_page=100&page=${pages.length + 1}`, { body: [] }]);
  return r;
}
const env = (base: string, extra: Record<string, string | undefined> = {}) => ({
  CHECK_FLAGSHIP_CF_API: base,
  CHECK_FLAGSHIP_GH_API: base,
  CLOUDFLARE_API_TOKEN: "fixture-not-a-real-token",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  ...extra,
});

describe("check-flagship-version (cp#564)", () => {
  it("PASSES when the deployed bytes, the newest tag and the latest published release agree", async () => {
    const { code, out } = await run(env(await serve(routes())));
    expect(out).toContain("ok    deployed vivijure-studio v1.37.0 == newest tag v1.37.0 == latest published v1.37.0");
    expect(out).toContain("this run is NOT a live measurement");
    expect(code).toBe(0);
  });

  it("FAILS when the flagship is AHEAD of the latest published release (the cf#1023 shape)", async () => {
    const { code, out } = await run(env(await serve(routes({ latest: "v1.35.0" }))));
    expect(out).toContain("AHEAD of the latest published release v1.35.0");
    expect(code).toBe(1);
  });

  it("FAILS when the flagship is BEHIND the newest tag (a cut release did not deploy)", async () => {
    const { code, out } = await run(env(await serve(routes({ bytes: bundle("1.36.0"), latest: "v1.36.0" }))));
    expect(out).toContain("BEHIND the newest tag v1.37.0");
    expect(code).toBe(1);
  });

  it("FAILS when the flagship is AHEAD of the newest tag (bytes no tag names)", async () => {
    const { code, out } = await run(env(await serve(routes({ bytes: bundle("1.38.0"), latest: "v1.38.0" }))));
    expect(out).toContain("AHEAD of the newest tag v1.37.0");
    expect(code).toBe(1);
  });

  it("orders tags by SEMVER, across pages, not by API order", async () => {
    // A FULL first page (100 tags, out of order) forces a second page, which holds the newest tag.
    const page1 = Array.from({ length: 100 }, (_, i) => `v1.${(i * 37) % 100 === 37 ? 0 : (i * 37) % 30}.${i}`);
    const tags = [page1, ["v1.37.0", "v1.2.0"]];
    const { code, out } = await run(env(await serve(routes({ tags }))));
    expect(out).toContain("newest by semver v1.37.0");
    expect(code).toBe(0);
  });

  it("is UNMEASURED when the marker is not in the deployed bytes", async () => {
    const { code, out } = await run(env(await serve(routes({ bytes: "--x\r\n\r\nexport default{}\r\n--x--" }))));
    expect(out).toContain("marker is not in the deployed vivijure-studio bytes");
    expect(code).toBe(2);
  });

  it("is UNMEASURED when the bytes carry two different versions", async () => {
    const { code, out } = await run(env(await serve(routes({ bytes: bundle("1.37.0") + bundle("1.36.0") }))));
    expect(out).toContain("2 different PACKAGE_VERSION values");
    expect(code).toBe(2);
  });

  it("is UNMEASURED when the content read is refused", async () => {
    const { code, out } = await run(env(await serve(routes({ content: { status: 403, body: { success: false } } }))));
    expect(out).toContain("content read for vivijure-studio failed: HTTP 403");
    expect(code).toBe(2);
  });

  it("is UNMEASURED when the flagship is not in the visible script list", async () => {
    const { code, out } = await run(env(await serve(routes({ scripts: [{ id: "other" }] }))));
    expect(out).toContain("vivijure-studio is not in the visible script list");
    expect(code).toBe(2);
  });

  it("is UNMEASURED when no v*.*.* tag can be read", async () => {
    const { code, out } = await run(env(await serve(routes({ tags: [["latest", "nightly"]] }))));
    expect(out).toContain("parsed ZERO v*.*.* tags");
    expect(code).toBe(2);
  });

  it("is UNMEASURED without a token, and names it", async () => {
    const { code, out } = await run(env(await serve(routes()), { CLOUDFLARE_API_TOKEN: undefined }));
    expect(out).toContain("needs CLOUDFLARE_API_TOKEN");
    expect(code).toBe(2);
  });

  it("is UNMEASURED when the endpoint cannot be reached", async () => {
    const { code, out } = await run(env("http://127.0.0.1:9"));
    expect(out).toContain("failed at the transport layer");
    expect(code).toBe(2);
  });
});
