import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPlatformApi, mockResponses } from "../public/onboarding-api.js";
import { invokeKeyVerdict } from "../public/onboarding-checks.js";
import { provisionPlanView } from "../src/runpod";
import { LIVE_KEYS, UNCONFIRMED, expectExactKeys } from "./invoke-key-shapes";

// THE TRANSPORT SEAM, driven for real (control-plane#31).
//
// What these replace: onboarding.js was one IIFE, so its fetch calls could not
// be imported and the suite asserted a hand-written MIRROR of them instead. A
// mirror proves the copy, never the shipped code -- edit invokeKey() to diverge
// and the mirror still passes. That is a stub encoding an assumption, the same
// pattern that produced the defect cp#20 fixed.
//
// Every test below builds the REAL client from public/onboarding-api.js and
// replaces exactly one thing: fetch. Nothing here reimplements a request.

/** Records every call and answers with a caller-supplied Response. The proxy
 *  is what makes "no request was made" an assertable fact rather than an
 *  inference from an absent side effect. */
function recordingFetch(responder: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return responder(url, init);
  });
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, unknown>;

// Anchored to THIS file, not to the runner cwd, so the tripwire below reads
// the shipped assets no matter where vitest is invoked from.
const HERE = dirname(fileURLToPath(import.meta.url));
const readAsset = (name: string) => readFileSync(join(HERE, "..", "public", name), "utf8");

describe("transport: every route hits the path and method the control plane serves", () => {
  it("GET /api/platform/config", async () => {
    const { impl, calls } = recordingFetch(() => json({ signups_enabled: true }));
    const api = createPlatformApi({ apiBase: "https://cp.example", fetchImpl: impl });
    await api.config();
    expect(calls[0].url).toBe("https://cp.example/api/platform/config");
  });

  it("GET /api/me", async () => {
    const { impl, calls } = recordingFetch(() => json({ account: { id: "a", email: "e" } }));
    const api = createPlatformApi({ apiBase: "https://cp.example", fetchImpl: impl });
    await api.me();
    expect(calls[0].url).toBe("https://cp.example/api/me");
  });

  it("GET /api/tenant/slug-available, with the slug URL-ENCODED", async () => {
    const { impl, calls } = recordingFetch(() => json({ available: true }));
    const api = createPlatformApi({ fetchImpl: impl });
    // A slug that would break the query string if it were concatenated raw.
    await api.slugAvailable("a b&c=d");
    expect(calls[0].url).toBe("/api/tenant/slug-available?slug=a%20b%26c%3Dd");
  });

  it("POST /api/tenant/provision carries the slug and NOTHING ELSE (cp#427)", async () => {
    const { impl, calls } = recordingFetch(() => json({ tenant_id: "t1", job_id: "j1" }));
    const api = createPlatformApi({ fetchImpl: impl });
    const res = await api.provision("my-studio");
    expect(calls[0].url).toBe("/api/tenant/provision");
    expect(calls[0].init?.method).toBe("POST");
    // The key is GONE from the contract, not merely unused: the route no longer accepts one, so
    // a transport that still advertised the field would be a fiction waiting for a consumer.
    expect(bodyOf(calls[0].init)).toEqual({ slug: "my-studio" });
    expect(res).toEqual({ tenant_id: "t1", job_id: "j1" });
  });

  it("GET /api/tenant/provision-plan (cp#474: this used to be a phantom)", async () => {
    const { impl, calls } = recordingFetch(() => json({ endpoints: [] }));
    const api = createPlatformApi({ fetchImpl: impl });
    await api.plan();
    expect(calls[0].url).toBe("/api/tenant/provision-plan");
    expect(calls[0].init?.method ?? "GET").toBe("GET");
  });

  it("GET the job status under the tenant id, ENCODED", async () => {
    const { impl, calls } = recordingFetch(() => json({ status: "running" }));
    const api = createPlatformApi({ fetchImpl: impl });
    await api.job("ten/../evil");
    expect(calls[0].url).toBe("/api/tenant/ten%2F..%2Fevil/job");
  });

  it("carries the real status and the parsed body, not just a string", async () => {
    // handleProvisionError in onboarding.js branches on err.status === 409 and
    // on err.body.error. If either is dropped here, the customer gets a dead
    // end instead of "paste your key again".
    const { impl } = recordingFetch(() => json({ error: "runpod_key_required" }, 409));
    const api = createPlatformApi({ fetchImpl: impl });
    await expect(api.provision("s")).rejects.toMatchObject({
      status: 409,
      body: { error: "runpod_key_required" },
      message: "runpod_key_required",
    });
  });

  it("a non-2xx with an unparseable body still throws something with the status in it", async () => {
    const { impl } = recordingFetch(() => new Response("<html>502</html>", { status: 502 }));
    const api = createPlatformApi({ fetchImpl: impl });
    await expect(api.plan()).rejects.toThrow(/502/);
  });

  it("CONTROL: a 2xx does NOT throw", async () => {
    // Without this, every rejects assertion above could be passing because the
    // client throws unconditionally.
    const { impl } = recordingFetch(() => json({ endpoints: [] }));
    const api = createPlatformApi({ fetchImpl: impl });
    await expect(api.plan()).resolves.toEqual({ endpoints: [] });
  });
});

describe("the preview mock matches the real plan projection (cp#474)", () => {
  it("does not invent a different set of capabilities than the provisioner", () => {
    // The defect this closes: mock.plan() answered four RunPod endpoints with
    // invented purposes, so preview walked and production rendered an empty
    // review. Keys, labels, backing and worker pins must match the projection
    // the route now serves. Image tags are omitted from the mock on purpose so
    // a pin bump cannot fail this test.
    const mockRows = mockResponses.plan().endpoints;
    const real = provisionPlanView();
    expect(mockRows.map((e) => e.key)).toEqual(real.map((e) => e.key));
    expect(mockRows.map((e) => e.label)).toEqual(real.map((e) => e.label));
    expect(mockRows.map((e) => e.backing)).toEqual(real.map((e) => e.backing));
    expect(mockRows.map((e) => e.max_workers ?? null)).toEqual(real.map((e) => e.max_workers));
    expect(mockRows.map((e) => e.gpu)).toEqual(real.map((e) => e.gpu));
  });
});

describe("transport: acceptAup reports honestly (the 409 that used to be swallowed)", () => {
  it("204 is the ONLY recorded-consent answer", async () => {
    const { impl, calls } = recordingFetch(() => new Response(null, { status: 204 }));
    const api = createPlatformApi({ fetchImpl: impl });
    const res = await api.acceptAup("v3");
    expect(res).toEqual({ ok: true });
    expect(calls[0].url).toBe("/api/aup/accept");
    expect(bodyOf(calls[0].init)).toEqual({ version: "v3" });
  });

  it("409 reports STALE and hands back the current version, never ok", async () => {
    // The defect this replaces returned {ok:true} unconditionally, so the flow
    // advanced telling someone their consent was recorded when it was not.
    const { impl } = recordingFetch(() => json({ error: "aup_version_stale", current: "v4" }, 409));
    const api = createPlatformApi({ fetchImpl: impl });
    const res = await api.acceptAup("v3");
    expect(res.ok).toBe(false);
    expect(res.stale).toBe(true);
    expect(res.current).toBe("v4");
  });

  it("any other failure is ok:false and NOT flagged stale", async () => {
    const { impl } = recordingFetch(() => json({ error: "forbidden" }, 403));
    const api = createPlatformApi({ fetchImpl: impl });
    const res = await api.acceptAup("v3");
    expect(res.ok).toBe(false);
    expect(res.stale).toBe(false);
    expect(res.status).toBe(403);
    expect(res.error).toBe("forbidden");
  });

  it("CONTROL: the swallowing version this replaced would pass an ok:true on the 409", () => {
    const swallowing = (_status: number) => ({ ok: true });
    expect(swallowing(409).ok).toBe(true);
  });
});

describe("transport: invokeKey hands status and body through UNFLATTENED", () => {
  it("POSTs an empty body to go-live, and passes 202 through", async () => {
    const { impl, calls } = recordingFetch(() => json(UNCONFIRMED, 202));
    const api = createPlatformApi({ apiBase: "https://cp.example", fetchImpl: impl });

    const res = await api.invokeKey("ten_abc123");
    expect(calls[0].url).toBe("https://cp.example/api/tenant/ten_abc123/go-live");
    expect(calls[0].init?.method).toBe("POST");
    expect(bodyOf(calls[0].init)).toEqual({});
    expect(String(calls[0].init?.body)).not.toContain("runpod_invoke_key");

    expect(res.status).toBe(202);
    const v = invokeKeyVerdict(res.status, res.body);
    expect(v.pending).toBe(true);
    expect(v.clearKey).toBe(false);
  });

  it("never puts a tenant key on the wire", async () => {
    const { impl, calls } = recordingFetch(() => json({ status: "live" }, 200));
    const api = createPlatformApi({ fetchImpl: impl });
    await api.invokeKey("ten_abc123");
    expect(bodyOf(calls[0].init)).toEqual({});
  });

  it("does NOT throw on a 4xx: it is transport-only and decides nothing", async () => {
    const { impl } = recordingFetch(() => json({ error: "invoke_key_not_accepted" }, 400));
    const api = createPlatformApi({ fetchImpl: impl });
    const res = await api.invokeKey("ten_1");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invoke_key_not_accepted");
  });

  it("a non-JSON body degrades to an empty body, not a crash", async () => {
    const { impl } = recordingFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    const api = createPlatformApi({ fetchImpl: impl });
    const res = await api.invokeKey("ten_1");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({});
    const v = invokeKeyVerdict(res.status, res.body);
    expect(v.ok).toBe(false);
    expect(v.message.length).toBeGreaterThan(0);
  });
});

describe("transport: go-live never sends a tenant RunPod key", () => {
  it("provision and go-live bodies contain no runpod_invoke_key", async () => {
    const { impl, calls } = recordingFetch(() => json({ tenant_id: "t", job_id: "j" }));
    const api = createPlatformApi({ apiBase: "https://cp.example", fetchImpl: impl });

    await api.provision("slug").catch(() => {});
    await api.invokeKey("ten_1");

    expect(calls.length).toBe(2);
    calls.forEach(({ url, init }) => {
      expect(url).not.toMatch(/rpa_/);
      expect(String(init?.body ?? "")).not.toContain("runpod_invoke_key");
    });
  });
});

describe("transport: mock mode is a real short circuit, not a fallback", () => {
  it("useMock makes ZERO network calls", async () => {
    const { impl, calls } = recordingFetch(() => json({ unexpected: true }));
    const api = createPlatformApi({ useMock: true, fetchImpl: impl });

    await api.config();
    await api.me();
    await api.plan();
    await api.provision("k");
    await api.job("t");
    await api.slugAvailable("s");
    await api.invokeKey("t");
    await api.aup();

    expect(calls.length).toBe(0);
    expect(impl).not.toHaveBeenCalled();
  });

  it("CONTROL: the SAME calls without useMock do hit the network", async () => {
    // Proves the recorder records, so the zero above means "did not call",
    // not "the proxy is broken".
    const { impl, calls } = recordingFetch(() => json({ ok: true }));
    const api = createPlatformApi({ fetchImpl: impl });
    await api.config();
    expect(calls.length).toBe(1);
  });

  it("mock mode is OFF by default: an unconfigured client talks to the real API", async () => {
    // Inferring mock from missing config once shipped a page that showed a real
    // stranger invented numbers and a fake go-live link. It must stay opt-in.
    const { impl, calls } = recordingFetch(() => json({ signups_enabled: false }));
    const api = createPlatformApi({ fetchImpl: impl });
    await api.config();
    expect(calls.length).toBe(1);
  });

  it("useMock only accepts a real true, never a truthy accident", async () => {
    const { impl, calls } = recordingFetch(() => json({ ok: true }));
    const api = createPlatformApi({ useMock: 1 as unknown as boolean, fetchImpl: impl });
    await api.config();
    expect(calls.length).toBe(1);
  });

  it("the preview go-live body matches the EXACT key set the route serves", async () => {
    // A mock that invents its own shape is how a client drifts from the
    // contract with a green suite. LIVE_KEYS is the same fixture routes.test.ts
    // asserts the real route against.
    const res = mockResponses.invokeKey();
    expect(res.status).toBe(200);
    expectExactKeys(res.body as unknown as Record<string, unknown>, LIVE_KEYS);
    // And it must survive the real interpreter as a clean go-live.
    const v = invokeKeyVerdict(res.status, res.body);
    expect(v.live).toBe(true);
    expect(v.tone).toBe("good");
  });

  it("the preview tenant lands in awaiting_go_live, like a real provision", async () => {
    // If the mock jumped straight to live, the preview would skip the key-B
    // screen entirely and stop being a preview of the actual flow.
    const api = createPlatformApi({ useMock: true });
    const me = await api.me();
    expect(me.tenant?.status).toBe("awaiting_go_live");
    expect(me.tenant?.endpoints?.length).toBe(4);
  });
});

describe("transport: fetch is resolved per call, not captured at construction", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a global stubbed AFTER the client is built still drives the shipped code", async () => {
    // This is what lets the browser path (no fetchImpl) be tested at all. If
    // globalThis.fetch were read once in createPlatformApi, this would call the
    // real network instead.
    const api = createPlatformApi({ apiBase: "https://cp.example" });
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => json({ available: true }));
    vi.stubGlobal("fetch", spy);

    const res = await api.slugAvailable("late-bound");
    expect(res.available).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain("/api/tenant/slug-available?slug=late-bound");
  });
});

// THE TRIPWIRE. The whole point of cp#31 is that there is exactly ONE copy of
// the request-building code. Nothing stops someone adding a fetch back into
// onboarding.js six months from now and quietly recreating the untestable seam,
// except this.
describe("TRIPWIRE: onboarding.js owns no transport of its own", () => {
  const src = readAsset("onboarding.js");

  it("contains no fetch call", () => {
    // Comments in that file discuss fetch by name, so match a CALL, not a word.
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/XMLHttpRequest/);
    expect(src).not.toMatch(/navigator\.sendBeacon/);
  });

  it("builds its client from the shared seam", () => {
    expect(src).toContain("createPlatformApi");
  });

  it("CONTROL: the regex above really does catch a fetch call", () => {
    // Proves the tripwire can go red. A pattern that matches nothing would
    // pass forever against a file full of fetches.
    expect("const r = await fetch(url);").toMatch(/\bfetch\s*\(/);
  });

  it("onboarding.html loads the seam BEFORE the page script", () => {
    // Load order is load-bearing: onboarding.js reads window.onboardingApi at
    // IIFE evaluation time.
    const html = readAsset("onboarding.html");
    const api = html.indexOf("onboarding-api.js");
    const page = html.indexOf("src=\"onboarding.js\"");
    expect(api).toBeGreaterThan(-1);
    expect(page).toBeGreaterThan(-1);
    expect(api).toBeLessThan(page);
  });
});

// cp#467: EVERY ROUTE THE TRANSPORT CALLS MUST BE ONE THE PLANE SERVES.
//
// Two phantoms were found one after the other. capacity() POSTed /api/tenant/capacity, which the
// plane has NEVER served, and its mock answered green so the flow was walkable in preview and dead
// in production. retry() POSTed /api/tenant/:id/retry, which no handler matches either, and its
// body still conditionally advertised runpod_api_key after cp#427 removed the concept.
//
// Neither was a route that ROTTED. Both were routes that never existed, sitting behind a client
// method and a mock that agreed with each other. THE MOCK WAS NOT DRIFTING FROM THE CONTRACT, IT
// WAS INVENTING ONE, and the only thing asserting the contract was something we wrote to stand in
// for it.
//
// So this reads the SHIPPED transport and the SHIPPED route table and demands they agree. It is
// deliberately crude -- string extraction, not a parser -- because the failure it catches is a
// path that appears in one file and nowhere in the other, which crude is enough for.
describe("no transport calls a route the plane does not serve (cp#467)", () => {
  const api = readFileSync(join(HERE, "..", "public", "onboarding-api.js"), "utf8");
  const plane = readFileSync(join(HERE, "..", "src", "index.ts"), "utf8");

  it("CONTROL: both files are really there and the extraction finds paths", () => {
    expect(api.length).toBeGreaterThan(2000);
    expect(plane.length).toBeGreaterThan(2000);
    expect(api).toMatch(/["`]\/api\//);
  });

  it("every literal /api/tenant path in the transport is served", () => {
    // The two shapes the transport uses: a fixed path, and a scoped one built by concatenation.
    const fixed = [...api.matchAll(/["`](\/api\/tenant\/[a-z-]+)["`]/g)].map((m) => m[1]);
    // Scoped calls look like "/api/tenant/" + encodeURIComponent(id) + "/action".
    const scoped = [...api.matchAll(/\+ ["`]\/([a-z-]+)["`]/g)].map((m) => m[1]);

    const servedFixed = [...plane.matchAll(/path === ["`](\/api\/tenant\/[a-z-]+)["`]/g)].map((m) => m[1]);
    const servedActions = [...plane.matchAll(/action === ["`]([a-z-]+)["`]/g)].map((m) => m[1]);

    // Positive control: the extraction must actually find something, or this passes on an empty set.
    expect(servedFixed.length + servedActions.length).toBeGreaterThan(3);

    for (const path of fixed) {
      expect(servedFixed, path + " is called by the client and served by nothing").toContain(path);
    }
    for (const action of scoped) {
      expect(servedActions, action + " is called by the client and served by nothing").toContain(action);
    }
  });
});
