import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLANE_REFUSAL_HEADER, passthrough, upstreamUrlFor } from "../src/runpod-proxy-poll";

const POLL_SRC = new URL("../src/runpod-proxy.ts", import.meta.url); // the METERING half
const POLL_FILE = new URL("../src/runpod-proxy-poll.ts", import.meta.url);

const read = (u: URL): string => readFileSync(u.pathname, "utf8");
/** Comments are PROSE, and prose about the absence of a thing contains the thing's name.
 *  Stripping them is what makes the assertions below tests of DECLARATIONS rather than of
 *  wording -- the first version of this file failed on its own doc comment saying "absence of a
 *  store", which is the check matching narrative about a dead state-word. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
/** Import specifiers only, so a mention inside a comment cannot pass or fail this. */
const importsOf = (src: string): string[] =>
  [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);

describe("the poll half is STRUCTURALLY incapable of metering", () => {
  // POSITIVE CONTROL FOR THE MATCHER ITSELF. If the import extractor silently returned [] the
  // separation assertions below would all pass while testing nothing -- a check that cannot fail.
  // The metering half genuinely imports ./store, so finding it proves the extractor works.
  it("control: the import extractor really does find imports (metering half imports ./store)", () => {
    const specs = importsOf(read(POLL_SRC));
    expect(specs.length).toBeGreaterThan(0);
    expect(specs).toContain("./store");
  });

  it("the poll module imports NOTHING from the metering half", () => {
    const specs = importsOf(read(POLL_FILE));
    for (const s of specs) {
      expect(s).not.toMatch(/runpod-proxy(\.js)?$/);
    }
  });

  it("the poll module imports NO store, and therefore holds no write handle", () => {
    const specs = importsOf(read(POLL_FILE));
    for (const s of specs) {
      expect(s).not.toMatch(/store/i);
      expect(s).not.toMatch(/store-d1/i);
    }
  });

  // The deps type is the second lock: even if an import appeared, there is no store to reach.
  it("RunpodPollDeps declares no store field", () => {
    const src = read(POLL_FILE);
    const iface = stripComments(src).slice(stripComments(src).indexOf("export interface RunpodPollDeps"));
    const body = iface.slice(0, iface.indexOf("}"));
    expect(body).not.toMatch(/store/i);
    // Control: the fields it DOES declare are present, so an empty slice cannot pass vacuously.
    // CONTROL that the stripper did not eat the declarations along with the prose.
    expect(body).toMatch(/fetchImpl/);
    expect(body).toMatch(/runpodApiKey/);
  });
});

describe("upstream url shapes", () => {
  it("builds status, cancel and health", () => {
    expect(upstreamUrlFor("status", "ep1", "job1")).toBe("https://api.runpod.ai/v2/ep1/status/job1");
    expect(upstreamUrlFor("cancel", "ep1", "job1")).toBe("https://api.runpod.ai/v2/ep1/cancel/job1");
    expect(upstreamUrlFor("health", "ep1")).toBe("https://api.runpod.ai/v2/ep1/health");
  });

  it("refuses a job-scoped op with no job id rather than building a wrong url", () => {
    expect(() => upstreamUrlFor("status", "ep1")).toThrow(/requires a job id/);
  });

  it("encodes path segments", () => {
    expect(upstreamUrlFor("status", "ep/../x", "j j")).toContain("ep%2F..%2Fx");
  });
});

describe("plane refusal is distinguishable from a RunPod blip", () => {
  // The third state that has to exist before the modules can degrade honestly. Today every module
  // reads an unreachable upstream as "still running", which was right when the upstream was RunPod
  // and becomes a silent forever-pend once the upstream is ours.
  it("labels a missing credential as a PLANE refusal, 503 + header", async () => {
    const resp = await passthrough(
      { fetchImpl: (async () => new Response("unused")) as unknown as typeof fetch, runpodApiKey: async () => "" },
      "status",
      "ep1",
      "job1",
    );
    expect(resp.status).toBe(503);
    expect(resp.headers.get(PLANE_REFUSAL_HEADER)).toBe("credential-unavailable");
  });

  it("does NOT label a RunPod transport failure as a plane refusal", async () => {
    const resp = await passthrough(
      {
        fetchImpl: (async () => {
          throw new Error("connect ETIMEDOUT");
        }) as unknown as typeof fetch,
        runpodApiKey: async () => "k",
      },
      "status",
      "ep1",
      "job1",
    );
    expect(resp.status).toBe(502);
    // The distinction is the point: mislabelling this would make a RunPod blip look like our outage.
    expect(resp.headers.get(PLANE_REFUSAL_HEADER)).toBeNull();
  });

  it("passes an upstream response through verbatim", async () => {
    const resp = await passthrough(
      {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ status: "IN_PROGRESS" }), { status: 200 })) as unknown as typeof fetch,
        runpodApiKey: async () => "k",
      },
      "status",
      "ep1",
      "job1",
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ status: "IN_PROGRESS" });
  });
});

// ------------------------------------------------------------------------------------------------
// cp#290: THE WIRING IS WHERE THIS PROPERTY WOULD HAVE BEEN LOST, so the check follows it there.
//
// The original assertions above look one hop: does runpod-proxy-poll.ts import a store. That was
// the right check for a module with no callers. It is not sufficient for a ROUTE, because a route
// reaches the store through anything it imports -- and while writing the poll route I nearly took a
// shared helper from the metering half, which would have restored a path to the store while every
// one-hop assertion above stayed green.
//
// So the walk is TRANSITIVE, and it has a positive control: run the same walker from the metering
// half and it MUST find the store. Without that, a walker that silently resolved nothing would pass
// every assertion below while testing nothing at all.
// ------------------------------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

/** Every first-party module reachable from `entry`, following relative imports only. Vendor
 *  packages cannot hold a D1 binding and are not the hazard. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of importsOf(read(new URL(`file://${file}`)))) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec.replace(/\.js$/, "")) + ".ts";
      queue.push(target);
    }
  }
  return seen;
}

const names = (files: Set<string>): string[] => [...files].map((f) => f.slice(SRC.length));

describe("the poll ROUTE cannot reach a store either, transitively", () => {
  // POSITIVE CONTROL FIRST. The metering half genuinely depends on ./store, so a walker that
  // resolved nothing would fail HERE rather than passing the real assertions vacuously.
  it("control: the walker really does traverse (the metering half reaches store.ts)", () => {
    const graph = names(reachable(`${SRC}runpod-proxy-routes.ts`));
    expect(graph.length).toBeGreaterThan(3);
    expect(graph).toContain("store.ts");
  });

  it("nothing reachable from the poll ROUTE is a store", () => {
    for (const file of names(reachable(`${SRC}runpod-proxy-poll-routes.ts`))) {
      expect(file).not.toMatch(/store/i);
    }
  });

  it("nothing reachable from the poll MODULE is a store", () => {
    for (const file of names(reachable(`${SRC}runpod-proxy-poll.ts`))) {
      expect(file).not.toMatch(/store/i);
    }
  });

  it("the poll route does not reach the metering half by ANY path", () => {
    expect(names(reachable(`${SRC}runpod-proxy-poll-routes.ts`))).not.toContain("runpod-proxy.ts");
  });
});
