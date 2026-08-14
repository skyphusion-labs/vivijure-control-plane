// Drive every arm of scripts/check-studio-pin.mjs and assert the NAMED REASON, not just the exit
// code (cf#372). A refusal matrix that asserted only "non-zero" would pass identically if the
// script died for an unrelated reason -- an assertion that cannot produce a disconfirming result is
// not evidence.
//
// The pairs below differ along ONE axis each (pin current vs behind; binding equal vs behind;
// binding present vs absent), so a green run and a red run are separated by exactly the fact under
// test rather than by fixture shape.
//
// The script is exercised as a CHILD PROCESS against a real local HTTP server, so the fetch, the
// pagination, the JSON parsing and the exit codes are the shipped ones. Only the endpoint BASE is
// redirected, and the script prints that redirection on every such run.

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "check-studio-pin.mjs");

type Routes = Record<string, { status?: number; body: unknown }>;

let live: Server | undefined;

afterEach(async () => {
  if (live) await new Promise<void>((r) => live!.close(() => r()));
  live = undefined;
});

/** A local stand-in for the two APIs. Unrouted paths 404 loudly rather than defaulting to a body. */
async function serve(routes: Routes): Promise<string> {
  live = createServer((req, res) => {
    const path = req.url ?? "";
    const hit = Object.keys(routes).find((k) => path.startsWith(k) && matchesQuery(k, path));
    if (!hit) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no fixture for ${path}` }));
      return;
    }
    const r = routes[hit];
    res.writeHead(r.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => live!.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(live!.address() as AddressInfo).port}`;
}

function matchesQuery(key: string, path: string): boolean {
  if (!key.includes("?")) return true;
  return path.includes(key.slice(key.indexOf("?")));
}

function run(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

const REL = "/repos/skyphusion-labs/vivijure-cf/releases";
const rel = (tag: string) => ({ tag_name: tag, draft: false, prerelease: false });

/** A full published history, newest first, as the real endpoint orders it. */
const HISTORY = [rel("v1.26.0"), rel("v1.25.0"), rel("v1.24.0"), rel("v1.20.0"), rel("v1.13.0")];

const releaseRoutes = (list = HISTORY, latest = "v1.26.0"): Routes => ({
  [`${REL}/latest`]: { body: { tag_name: latest } },
  [`${REL}?per_page=100&page=1`]: { body: list },
  [`${REL}?per_page=100&page=2`]: { body: [] },
});

const CP = "/accounts/acct/workers/scripts";
const cfRoutes = (bindings: unknown[], scripts = [{ id: "vivijure-control-plane" }]): Routes => ({
  [`${CP}/vivijure-control-plane/settings`]: { body: { success: true, errors: [], result: { bindings } } },
  [CP]: { body: { success: true, result: scripts } },
});

const cfEnv = (base: string) => ({
  CHECK_STUDIO_PIN_CF_API: base,
  CLOUDFLARE_API_TOKEN: "fixture-not-a-real-token",
  CLOUDFLARE_ACCOUNT_ID: "acct",
});

describe("check-studio-pin -- RELEASE mode", () => {
  it("PASSES when the pin is the latest published release", async () => {
    const base = await serve(releaseRoutes());
    const { code, out } = await run([], { CHECK_STUDIO_PIN_GH_API: base, STUDIO_RELEASE: "v1.26.0" });
    expect(out).toContain("ok    STUDIO_RELEASE v1.26.0 == latest published v1.26.0");
    expect(out).toContain("studio pin is current at v1.26.0");
    expect(code).toBe(0);
  });

  it("announces a redirected run so it cannot be mistaken for a live measurement", async () => {
    const base = await serve(releaseRoutes());
    const { out } = await run([], { CHECK_STUDIO_PIN_GH_API: base, STUDIO_RELEASE: "v1.26.0" });
    expect(out).toContain("this run is NOT a live measurement");
  });

  // The negative control for the case above: identical fixture, pin moved back one axis.
  it("goes RED when the pin trails the latest release, and reports the distance", async () => {
    const base = await serve(releaseRoutes());
    const { code, out } = await run([], { CHECK_STUDIO_PIN_GH_API: base, STUDIO_RELEASE: "v1.20.0" });
    expect(out).toContain("DRIFT STUDIO_RELEASE v1.20.0");
    expect(out).toContain("latest published v1.26.0 -- the pin is 3 release(s) behind");
    expect(code).toBe(1);
  });

  it("goes RED when the pin names a tag that was never published", async () => {
    const base = await serve(releaseRoutes());
    const { code, out } = await run([], { CHECK_STUDIO_PIN_GH_API: base, STUDIO_RELEASE: "v9.99.9" });
    expect(out).toContain("is not a published release");
    expect(code).toBe(1);
  });

  it("REFUSES (2) on an unset pin rather than passing on an empty derivation", async () => {
    const base = await serve(releaseRoutes());
    const { code, out } = await run([], { CHECK_STUDIO_PIN_GH_API: base, STUDIO_RELEASE: undefined });
    expect(out).toContain("empty or unset -- an unset pin is an UNMEASURED check, never a pass");
    expect(code).toBe(2);
  });

  it("REFUSES (2) on a malformed pin", async () => {
    const base = await serve(releaseRoutes());
    const { code, out } = await run([], { CHECK_STUDIO_PIN_GH_API: base, STUDIO_RELEASE: "latest" });
    expect(out).toContain("which is not a v*.*.* tag -- refusing to compare");
    expect(code).toBe(2);
  });

  it("REFUSES (2) when the release list is empty rather than reporting no drift", async () => {
    const base = await serve(releaseRoutes([], "v1.26.0"));
    const { code, out } = await run([], { CHECK_STUDIO_PIN_GH_API: base, STUDIO_RELEASE: "v1.26.0" });
    expect(out).toContain("parsed ZERO published v* releases");
    expect(code).toBe(2);
  });

  it("REFUSES (2) when the two release reads disagree with each other", async () => {
    const base = await serve(releaseRoutes(HISTORY, "v1.27.0"));
    const { code, out } = await run([], { CHECK_STUDIO_PIN_GH_API: base, STUDIO_RELEASE: "v1.26.0" });
    expect(out).toContain("absent from the release LIST -- the two reads disagree");
    expect(code).toBe(2);
  });

  it("REFUSES (2) rather than concluding from a list that never terminates", async () => {
    // Every page returns a FULL page, so the end is never proven. A negative conclusion drawn here
    // ("the pin is not published") would be worthless, which is why this is a refusal and not a red.
    const full = Array.from({ length: 100 }, (_, i) => rel(`v2.0.${i}`));
    const routes: Routes = { [`${REL}/latest`]: { body: { tag_name: "v2.0.0" } } };
    for (let p = 1; p <= 21; p++) routes[`${REL}?per_page=100&page=${p}`] = { body: full };
    const base = await serve(routes);
    const { code, out } = await run([], { CHECK_STUDIO_PIN_GH_API: base, STUDIO_RELEASE: "v1.26.0" });
    expect(out).toContain("did not terminate within 20 pages");
    expect(code).toBe(2);
  });

  it("REFUSES (2) on an HTTP error rather than treating it as no drift", async () => {
    const base = await serve({ [`${REL}?per_page=100&page=1`]: { status: 503, body: {} } });
    const { code, out } = await run([], { CHECK_STUDIO_PIN_GH_API: base, STUDIO_RELEASE: "v1.26.0" });
    expect(out).toContain("failed: HTTP 503");
    expect(code).toBe(2);
  });
});

describe("check-studio-pin -- DEPLOYED mode", () => {
  const bindingsWith = (tag: string) => [
    { name: "SOME_OTHER_VAR", type: "plain_text", text: "x" },
    { name: "STUDIO_RELEASE", type: "plain_text", text: tag },
  ];

  it("PASSES when binding, variable and latest release all agree", async () => {
    const gh = await serve(releaseRoutes());
    const cf = await serveSecond(cfRoutes(bindingsWith("v1.26.0")));
    const { code, out } = await run(["--deployed"], {
      CHECK_STUDIO_PIN_GH_API: gh,
      STUDIO_RELEASE: "v1.26.0",
      ...cfEnv(cf),
    });
    expect(out).toContain("ok    deployed binding v1.26.0 == variable == latest published v1.26.0");
    expect(code).toBe(0);
  });

  // THE CASE THIS FILE EXISTS FOR, and the one measured live on 2026-08-14: the variable and the
  // latest release agree, so RELEASE mode is green, and the deployed binding is six releases back.
  it("goes RED when the variable advanced and no deploy carried it", async () => {
    const gh = await serve(releaseRoutes());
    const cf = await serveSecond(cfRoutes(bindingsWith("v1.20.0")));
    const { code, out } = await run(["--deployed"], {
      CHECK_STUDIO_PIN_GH_API: gh,
      STUDIO_RELEASE: "v1.26.0",
      ...cfEnv(cf),
    });
    expect(out).toContain("ok    STUDIO_RELEASE v1.26.0 == latest published v1.26.0");
    expect(out).toContain("DRIFT deployed binding v1.20.0 != STUDIO_RELEASE variable v1.26.0");
    expect(out).toContain("a tenant provisioned right now receives v1.20.0");
    expect(code).toBe(1);
  });

  it("REFUSES (2) when the binding key is ABSENT rather than coercing it to a value", async () => {
    const gh = await serve(releaseRoutes());
    const cf = await serveSecond(cfRoutes([{ name: "SOME_OTHER_VAR", type: "plain_text", text: "x" }]));
    const { code, out } = await run(["--deployed"], {
      CHECK_STUDIO_PIN_GH_API: gh,
      STUDIO_RELEASE: "v1.26.0",
      ...cfEnv(cf),
    });
    expect(out).toContain("carries NO STUDIO_RELEASE binding -- that is a deploy defect, not a pin lag");
    expect(code).toBe(2);
  });

  it("REFUSES (2) on zero bindings", async () => {
    const gh = await serve(releaseRoutes());
    const cf = await serveSecond(cfRoutes([]));
    const { code, out } = await run(["--deployed"], {
      CHECK_STUDIO_PIN_GH_API: gh,
      STUDIO_RELEASE: "v1.26.0",
      ...cfEnv(cf),
    });
    expect(out).toContain("reported ZERO bindings");
    expect(code).toBe(2);
  });

  // A scope-limited Cloudflare credential answers success:true with an empty result. Without this
  // control the empty answer is that credential's opinion and reads exactly like a clean estate.
  it("REFUSES (2) when the credential sees no Workers at all", async () => {
    const gh = await serve(releaseRoutes());
    const cf = await serveSecond(cfRoutes(bindingsWith("v1.26.0"), []));
    const { code, out } = await run(["--deployed"], {
      CHECK_STUDIO_PIN_GH_API: gh,
      STUDIO_RELEASE: "v1.26.0",
      ...cfEnv(cf),
    });
    expect(out).toContain("this credential cannot see the account's Workers");
    expect(code).toBe(2);
  });

  it("REFUSES (2) when the target Worker is not in the visible script list", async () => {
    const gh = await serve(releaseRoutes());
    const cf = await serveSecond(cfRoutes(bindingsWith("v1.26.0"), [{ id: "some-other-worker" }]));
    const { code, out } = await run(["--deployed"], {
      CHECK_STUDIO_PIN_GH_API: gh,
      STUDIO_RELEASE: "v1.26.0",
      ...cfEnv(cf),
    });
    expect(out).toContain("is not in the visible script list");
    expect(code).toBe(2);
  });

  it("REFUSES (2) without a Cloudflare credential rather than skipping the comparison", async () => {
    const gh = await serve(releaseRoutes());
    const { code, out } = await run(["--deployed"], {
      CHECK_STUDIO_PIN_GH_API: gh,
      STUDIO_RELEASE: "v1.26.0",
      CLOUDFLARE_ACCOUNT_ID: "acct",
    });
    expect(out).toContain("--deployed needs CLOUDFLARE_API_TOKEN");
    expect(code).toBe(2);
  });
});

// Deployed mode drives two hosts, so the suite needs a second listener alongside `live`.
let live2: Server | undefined;
afterEach(async () => {
  if (live2) await new Promise<void>((r) => live2!.close(() => r()));
  live2 = undefined;
});

async function serveSecond(routes: Routes): Promise<string> {
  live2 = createServer((req, res) => {
    const path = req.url ?? "";
    const hit = Object.keys(routes).find((k) => path.startsWith(k));
    if (!hit) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no fixture for ${path}` }));
      return;
    }
    res.writeHead(routes[hit].status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(routes[hit].body));
  });
  await new Promise<void>((r) => live2!.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(live2!.address() as AddressInfo).port}`;
}
