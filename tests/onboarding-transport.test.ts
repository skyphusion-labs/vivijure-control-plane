import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPlatformApi, mockResponses } from "../public/onboarding-api.js";
import { invokeKeyVerdict } from "../public/onboarding-checks.js";
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

  it("POST /api/tenant/provision carries the slug and the key under the contract names", async () => {
    const { impl, calls } = recordingFetch(() => json({ tenant_id: "t1", job_id: "j1" }));
    const api = createPlatformApi({ fetchImpl: impl });
    const res = await api.provision("my-studio", "rpa_setup_key");
    expect(calls[0].url).toBe("/api/tenant/provision");
    expect(calls[0].init?.method).toBe("POST");
    expect(bodyOf(calls[0].init)).toEqual({ slug: "my-studio", runpod_api_key: "rpa_setup_key" });
    expect(res).toEqual({ tenant_id: "t1", job_id: "j1" });
  });

  it("GET the job status under the tenant id, ENCODED", async () => {
    const { impl, calls } = recordingFetch(() => json({ status: "running" }));
    const api = createPlatformApi({ fetchImpl: impl });
    await api.job("ten/../evil");
    expect(calls[0].url).toBe("/api/tenant/ten%2F..%2Fevil/job");
  });

  it("POST retry WITHOUT a key sends an empty object, not a null key", async () => {
    // The route reads runpod_api_key when present. Sending {runpod_api_key: null}
    // is a different request from sending {}, and the 409 runpod_key_required
    // path depends on the difference.
    const { impl, calls } = recordingFetch(() => json({ job_id: "j2" }));
    const api = createPlatformApi({ fetchImpl: impl });
    await api.retry("ten_1");
    expect(bodyOf(calls[0].init)).toEqual({});
  });

  it("POST retry WITH a key carries it", async () => {
    const { impl, calls } = recordingFetch(() => json({ job_id: "j2" }));
    const api = createPlatformApi({ fetchImpl: impl });
    await api.retry("ten_1", "rpa_again");
    expect(bodyOf(calls[0].init)).toEqual({ runpod_api_key: "rpa_again" });
  });

  it("POST capacity sends the key the read-only probe reads", async () => {
    const { impl, calls } = recordingFetch(() => json({ quota: 10, existing_worker_sum: 0 }));
    const api = createPlatformApi({ fetchImpl: impl });
    await api.capacity("rpa_probe");
    expect(calls[0].url).toBe("/api/tenant/capacity");
    expect(bodyOf(calls[0].init)).toEqual({ runpod_api_key: "rpa_probe" });
  });
});

describe("transport: json() turns a non-2xx into a THROWN error that keeps the diagnosis", () => {
  it("carries the real status and the parsed body, not just a string", async () => {
    // handleProvisionError in onboarding.js branches on err.status === 409 and
    // on err.body.error. If either is dropped here, the customer gets a dead
    // end instead of "paste your key again".
    const { impl } = recordingFetch(() => json({ error: "runpod_key_required" }, 409));
    const api = createPlatformApi({ fetchImpl: impl });
    await expect(api.provision("s", "k")).rejects.toMatchObject({
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
  it("POSTs the key under the name the route reads, and passes 202 through", async () => {
    const { impl, calls } = recordingFetch(() => json(UNCONFIRMED, 202));
    const api = createPlatformApi({ apiBase: "https://cp.example", fetchImpl: impl });

    const res = await api.invokeKey("ten_abc123", "rpa_render_key");
    expect(calls[0].url).toBe("https://cp.example/api/tenant/ten_abc123/invoke-key");
    expect(calls[0].init?.method).toBe("POST");
    // The route reads body.runpod_invoke_key; any other name is a silent 400.
    expect(bodyOf(calls[0].init)).toEqual({ runpod_invoke_key: "rpa_render_key" });

    expect(res.status).toBe(202);
    // End to end through the real verdict: 202 must stay pending, not become a
    // failure and not clear the field.
    const v = invokeKeyVerdict(res.status, res.body);
    expect(v.pending).toBe(true);
    expect(v.clearKey).toBe(false);
  });

  it("does NOT throw on a 4xx: it is transport-only and decides nothing", async () => {
    // invokeKey deliberately does not go through json(). If it ever did, the
    // 400/503 diagnostics would arrive as exceptions and the customer would see
    // a generic message instead of the real reason.
    const { impl } = recordingFetch(() => json({ error: "invoke_key_rejected", reason: "graphql_capable" }, 400));
    const api = createPlatformApi({ fetchImpl: impl });
    const res = await api.invokeKey("ten_1", "rpa_bad");
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("graphql_capable");
  });

  it("a non-JSON body degrades to an empty body, not a crash", async () => {
    const { impl } = recordingFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    const api = createPlatformApi({ fetchImpl: impl });
    const res = await api.invokeKey("ten_1", "rpa_x");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({});
    const v = invokeKeyVerdict(res.status, res.body);
    expect(v.ok).toBe(false);
    expect(v.message.length).toBeGreaterThan(0);
  });
});

describe("transport: SECRET HYGIENE, a key never reaches a URL", () => {
  const SECRET = "rpa_do_not_put_me_in_a_url";

  it("no key-bearing call puts the key in the request URL", async () => {
    const { impl, calls } = recordingFetch(() => json({ quota: 1, existing_worker_sum: 0 }));
    const api = createPlatformApi({ apiBase: "https://cp.example", fetchImpl: impl });

    await api.capacity(SECRET);
    await api.provision("slug", SECRET).catch(() => {});
    await api.retry("ten_1", SECRET).catch(() => {});
    await api.invokeKey("ten_1", SECRET);

    expect(calls.length).toBe(4);
    calls.forEach(({ url }) => expect(url).not.toContain(SECRET));
  });

  it("CONTROL: the key IS in the request BODY, so the assertion above is about placement", async () => {
    // Without this control, the URL assertion would also pass if the key were
    // silently dropped and never sent at all.
    const { impl, calls } = recordingFetch(() => json({ quota: 1, existing_worker_sum: 0 }));
    const api = createPlatformApi({ fetchImpl: impl });
    await api.capacity(SECRET);
    expect(String(calls[0].init?.body)).toContain(SECRET);
  });
});

describe("transport: mock mode is a real short circuit, not a fallback", () => {
  it("useMock makes ZERO network calls", async () => {
    const { impl, calls } = recordingFetch(() => json({ unexpected: true }));
    const api = createPlatformApi({ useMock: true, fetchImpl: impl });

    await api.config();
    await api.me();
    await api.plan();
    await api.capacity("k");
    await api.provision("s", "k");
    await api.job("t");
    await api.retry("t", "k");
    await api.slugAvailable("s");
    await api.invokeKey("t", "k");
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

  it("the preview tenant lands in awaiting_invoke_key, like a real provision", async () => {
    // If the mock jumped straight to live, the preview would skip the key-B
    // screen entirely and stop being a preview of the actual flow.
    const api = createPlatformApi({ useMock: true });
    const me = await api.me();
    expect(me.tenant?.status).toBe("awaiting_invoke_key");
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
