// fleet-chezmoi#2083: RunPod REST v1 (rest.runpod.io/v1) retires 2026-11-15. This plane's RunPod client and
// its two operator scripts move to v2 (https://api.runpod.io/v2, shapes from RunPod's v2 OpenAPI). Covered:
//   * RunPodClient: every method's URL and body, the cursor walk, the GPU-type -> pool mapping;
//   * scripts/reconcile-runpod.mjs and scripts/check-satellite-pins.mjs, run as real processes against a
//     local fake v2 server (RUNPOD_API_BASE): a walked inventory is complete, an unwalkable one exits 2;
//     a pinned endpoint is read for its own image;
//   * no file under src/ or scripts/ names rest.runpod.io.
// The serverless invoke API (the .ai host: /<id>/run, status, cancel, health) is a different product and
// is not touched here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { RunPodClient, gpuPoolsFor } from "../src/runpod";
import { SATELLITE_PINS, imageRef, type SatelliteKey } from "../src/satellite-pins";

type Call = { url: string; method: string; body: unknown };
function client(answers: (url: string, method: string) => unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(answers(url, method) ?? {}), { status: 200 });
  }) as typeof fetch;
  return { c: new RunPodClient("k", fetchImpl), calls };
}
const last = (p: { endpoints?: unknown[]; templates?: unknown[] }) => ({ ...p, pagination: { nextCursor: null, hasNextPage: false } });

describe("RunPodClient on REST v2", () => {
  it("lists endpoints from /v2/serverless, walking every page, and maps workers.max", async () => {
    const { c, calls } = client((url) =>
      url.includes("cursor=c2")
        ? last({ endpoints: [{ id: "e2", name: "two" }] })
        : { endpoints: [{ id: "e1", name: "one", workers: { max: 3 } }], pagination: { nextCursor: "c2", hasNextPage: true } });
    expect(await c.listEndpoints()).toEqual([{ id: "e1", name: "one", workersMax: 3 }, { id: "e2", name: "two" }]);
    expect(calls.map((x) => x.url)).toEqual([
      "https://api.runpod.io/v2/serverless?limit=1000",
      "https://api.runpod.io/v2/serverless?limit=1000&cursor=c2",
    ]);
  });
  it("refuses a page that claims more but gives no cursor, rather than reading it as the end", async () => {
    const { c } = client(() => ({ endpoints: [], pagination: { nextCursor: null, hasNextPage: true } }));
    await expect(c.listEndpoints()).rejects.toThrow(/gave no cursor/);
  });
  it("lists templates from /v2/templates", async () => {
    const { c, calls } = client(() => last({ templates: [{ id: "t1", name: "x" }] }));
    expect(await c.listTemplates()).toEqual([{ id: "t1", name: "x" }]);
    expect(calls[0].url).toBe("https://api.runpod.io/v2/templates?limit=1000");
  });
  it("creates a template with the v2 field names", async () => {
    const { c, calls } = client(() => ({ id: "t1" }));
    await c.createTemplate("vivijure-x-backend", "ghcr.io/o/r:1@sha256:a", { A: "1" }, 30);
    expect(calls[0]).toEqual({ url: "https://api.runpod.io/v2/templates", method: "POST",
      body: { name: "vivijure-x-backend", image: "ghcr.io/o/r:1@sha256:a", serverless: true, disk: 30, env: { A: "1" } } });
  });
  it("creates an endpoint on /v2/serverless with pools, nested workers and scaling, scale-to-zero", async () => {
    const { c, calls } = client(() => ({ id: "e1" }));
    await c.createEndpoint({ name: "vivijure-x-backend", templateId: "t1", gpuTypeIds: ["NVIDIA H200", "NVIDIA B200"], workersMax: 2 });
    expect(calls[0]).toEqual({ url: "https://api.runpod.io/v2/serverless", method: "POST", body: {
      name: "vivijure-x-backend", templateId: "t1",
      gpu: { pools: ["HOPPER_141", "BLACKWELL_180"], count: 1 },
      workers: { min: 0, max: 2, idleTimeout: 5 },
      scaling: { type: "QUEUE_DELAY", queueDelay: 4 },
    } });
  });
  it("refuses a GPU type with no known v2 pool before any call", async () => {
    const { c, calls } = client(() => ({}));
    await expect(c.createEndpoint({ name: "n", templateId: "t", gpuTypeIds: ["NVIDIA Z9"], workersMax: 1 })).rejects.toThrow(/no RunPod v2 pool/);
    expect(calls).toEqual([]);
    expect(gpuPoolsFor(["NVIDIA H200", "NVIDIA H200"])).toEqual(["HOPPER_141"]);
  });
  it("re-pins and re-envs a LIVE endpoint with PATCH /v2/serverless/{id} (a v2 template edit does not reach it)", async () => {
    const { c, calls } = client(() => ({ id: "e1" }));
    await c.updateEndpointImage("e1", "ghcr.io/o/r:2@sha256:b");
    await c.updateEndpointEnv("e1", { A: "2" });
    expect(calls).toEqual([
      { url: "https://api.runpod.io/v2/serverless/e1", method: "PATCH", body: { image: "ghcr.io/o/r:2@sha256:b" } },
      { url: "https://api.runpod.io/v2/serverless/e1", method: "PATCH", body: { env: { A: "2" } } },
    ]);
  });
  it("template edits, reads and deletes use /v2/templates/{id} and the v2 `image` field", async () => {
    const { c, calls } = client((url, method) => (method === "GET" ? { id: "t1", image: "img:1" } : { id: "t1" }));
    await c.updateTemplateImage("t1", "img:2");
    await c.updateTemplateEnv("t1", { A: "1" });
    expect(await c.getTemplate("t1")).toEqual({ id: "t1", imageName: "img:1" });
    await c.deleteTemplate("t1");
    expect(calls.map((x) => [x.method, x.url, x.body])).toEqual([
      ["PATCH", "https://api.runpod.io/v2/templates/t1", { image: "img:2" }],
      ["PATCH", "https://api.runpod.io/v2/templates/t1", { env: { A: "1" } }],
      ["GET", "https://api.runpod.io/v2/templates/t1", undefined],
      ["DELETE", "https://api.runpod.io/v2/templates/t1", undefined],
    ]);
  });
  it("reads and deletes an endpoint at /v2/serverless/{id}, mapping workers.min/max and image", async () => {
    const { c, calls } = client((url, method) => (method === "GET" ? { id: "e1", image: "img:1", workers: { min: 0, max: 2 } } : {}));
    expect(await c.getEndpoint("e1")).toEqual({ id: "e1", image: "img:1", workersMin: 0, workersMax: 2 });
    await c.deleteEndpoint("e1");
    expect(calls.map((x) => [x.method, x.url])).toEqual([["GET", "https://api.runpod.io/v2/serverless/e1"], ["DELETE", "https://api.runpod.io/v2/serverless/e1"]]);
  });
});

// ---- the operator scripts, run as real processes against a local fake v2 API ----------------------
const ROOT = join(__dirname, "..");
let server: Server;
let base = "";
let route: (path: string, url: URL) => { status: number; body: unknown } = () => ({ status: 404, body: {} });
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const r = route(url.pathname, url);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/v2`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

function run(script: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(ROOT, "scripts", script), ...args],
      { env: { PATH: process.env.PATH ?? "", RUNPOD_API_KEY: "k", RUNPOD_API_BASE: base, ...env } }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      });
  });
}

describe("scripts/reconcile-runpod.mjs on v2 (--dry-run)", () => {
  it("walks both lists to their last page and calls the inventory complete (exit 0)", async () => {
    route = (path, url) => {
      if (path === "/v2/serverless") {
        return url.searchParams.get("cursor") === "p2"
          ? { status: 200, body: last({ endpoints: [{ id: "e2", name: "b" }] }) }
          : { status: 200, body: { endpoints: [{ id: "e1", name: "a" }], pagination: { nextCursor: "p2", hasNextPage: true } } };
      }
      if (path === "/v2/templates") return { status: 200, body: last({ templates: [{ id: "t1", name: "c" }] }) };
      return { status: 404, body: {} };
    };
    const r = await run("reconcile-runpod.mjs", ["--dry-run"], {});
    expect(r.code, r.out).toBe(0);
    const inv = JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1));
    expect(inv.complete).toBe(true);
    expect(inv.endpoints.map((e: { id: string }) => e.id)).toEqual(["e1", "e2"]);
    expect(inv.templates.map((t: { id: string }) => t.id)).toEqual(["t1"]);
  });
  it("a list with no pagination block is NOT complete (exit 2), never read as whole", async () => {
    route = (path) => (path === "/v2/serverless" ? { status: 200, body: { endpoints: [] } } : { status: 200, body: last({ templates: [] }) });
    const r = await run("reconcile-runpod.mjs", ["--dry-run"], {});
    expect(r.code).toBe(2);
  });
  it("an HTTP error is could-not-measure (exit 2)", async () => {
    route = () => ({ status: 410, body: {} });
    const r = await run("reconcile-runpod.mjs", ["--dry-run"], {});
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/HTTP 410/);
  });
});

describe("scripts/check-satellite-pins.mjs --prod on v2", () => {
  const keys = Object.keys(SATELLITE_PINS) as SatelliteKey[];
  const byEndpoint = (image: (k: SatelliteKey) => string, status = 200) => (path: string) => {
    const k = keys.find((x) => path === `/v2/serverless/${SATELLITE_PINS[x].mirrors.endpointId}`);
    return k ? { status, body: { id: SATELLITE_PINS[k].mirrors.endpointId, name: k, image: image(k) } } : { status: 404, body: {} };
  };
  it("reads each pinned endpoint for its OWN image and passes when they match (exit 0)", async () => {
    route = byEndpoint((k) => imageRef(k));
    const r = await run("check-satellite-pins.mjs", ["--prod"], {});
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/all \d+ pins verified/);
  });
  it("a different image is DRIFT (exit 1)", async () => {
    route = byEndpoint((k) => `${imageRef(k)}-other`);
    const r = await run("check-satellite-pins.mjs", ["--prod"], {});
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/DRIFT/);
  });
  it("an endpoint this key cannot see (404) is a named FAIL (exit 1), not a pass", async () => {
    route = () => ({ status: 404, body: {} });
    const r = await run("check-satellite-pins.mjs", ["--prod"], {});
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not visible to this key/);
  });
  it("a 5xx or a 410 is could-not-measure (exit 2)", async () => {
    for (const status of [500, 410]) {
      route = byEndpoint((k) => imageRef(k), status);
      const r = await run("check-satellite-pins.mjs", ["--prod"], {});
      expect(r.code, `${status}: ${r.out}`).toBe(2);
    }
  });
});

describe("no rest.runpod.io left in src/ or scripts/ (the #2083 done condition, kept true by CI)", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|mjs|js|sh)$/.test(p) ? [p] : [];
    });
  }
  const SCAN = [...files(join(ROOT, "src")), ...files(join(ROOT, "scripts"))];
  it("CONTROL: the scan covers both trees and its matcher can fire", () => {
    expect(SCAN.some((f) => f.includes("/src/runpod.ts"))).toBe(true);
    expect(SCAN.some((f) => f.includes("/scripts/reconcile-runpod.mjs"))).toBe(true);
    expect(/rest\.runpod\.io/.test('const B = "https://rest.runpod.io/v1";')).toBe(true);
  });
  it("names it nowhere", () => {
    const hits = SCAN.filter((f) => /rest\.runpod\.io/.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});
