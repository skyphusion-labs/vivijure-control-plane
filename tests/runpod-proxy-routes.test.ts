// The proxy's ROUTES, driven through the REAL router (handle()) with only the dep bundle swapped
// (cp#290). cp#291 landed the primitives and said plainly that they had no caller; this suite is
// what makes "reachable" a checked claim rather than a plan.
//
// BIAS: negative tests, each with its positive control IN THE SAME FIELD OF VIEW. "Everything
// refuses" is a known way for a proxy suite to look green while the feature is dead, and every
// refusal here is paired with the request that must be allowed to prove the pass band exists.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { handle } from "../src/index";
import type { ControlPlaneDeps } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import { MemoryStore } from "./memory-store";
import { mintTenantProxyToken } from "../src/runpod-proxy-auth";
import { PLANE_REFUSAL_HEADER } from "../src/runpod-proxy-poll";

const ROOT_HOST = "studio.example.com";
const ORIGIN = `https://${ROOT_HOST}`;
const SIGNING_KEY = "signing-key-under-test";
const POOL_KEY = "runpod-pool-key-under-test";
const TENANT_ID = "ten_1";

const POOL_JSON = JSON.stringify({
  backend: { id: "pool-backend", name: "vivijure-prod-backend" },
  lipsync: { id: "pool-lipsync", name: "vivijure-prod-lipsync" },
});

/** A public model slug from the eight-entry cost-door list. Deliberately narration-gen's: it is
 *  SPEECH, not i2v, and it is in the allow-list because it BILLS RUNPOD, which is the only
 *  membership rule a meter can have. Asserting on this one is what would fail if a future reader
 *  "tidied" a speech endpoint out of what looks like a video list. */
const PUBLIC_SLUG = "minimax-speech-02-hd";

let store: MemoryStore;
let deps: ControlPlaneDeps;
let upstream: { url: string; init: RequestInit }[];
/** What the fake RunPod answers next, per URL suffix match. Set per test. */
let upstreamReply: (url: string) => Response;

const env = (over: Partial<ControlPlaneEnv> = {}): ControlPlaneEnv =>
  ({
    ASSETS: { fetch: async () => new Response("ui", { status: 200 }) } as unknown as Fetcher,
    CP_DB: {} as D1Database,
    AUP_VERSION: "1",
    AUP_URL: `${ORIGIN}/aup`,
    CONTROL_PLANE_HOST: ROOT_HOST,
    SHARED_RUNPOD_ENDPOINTS: POOL_JSON,
    SHARED_RUNPOD_INVOKE_KEY: POOL_KEY,
    RUNPOD_PROXY_SIGNING_KEY: SIGNING_KEY,
    ...over,
  }) as ControlPlaneEnv;

const ctx = { waitUntil: () => {}, passThroughOnException() {} } as unknown as ExecutionContext;

/**
 * A module worker's request. NOTE THE ABSENCE OF AN ORIGIN HEADER, and it is not laziness: a
 * Workers `fetch()` does not send one, so this IS the production shape. The router's CSRF check
 * only fires when an Origin is present, and a version of that check which required one would 403
 * every render submit while every browser test stayed green.
 */
const modReq = (path: string, token: string | null, init: RequestInit = {}) =>
  new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string>),
    },
  });

const submitReq = (endpointId: string, token: string | null, body: unknown = { input: { x: 1 } }, extra: Record<string, string> = {}) =>
  modReq(`/api/runpod/v2/${endpointId}/run`, token, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...extra },
  });

const goodToken = async () => (await mintTenantProxyToken(SIGNING_KEY, TENANT_ID))!;

async function liveSharedTenant(): Promise<void> {
  await store.createAccount("acct_1", "a@b.com");
  await store.createTenant(TENANT_ID, "hero", "acct_1", "live");
  await store.setTenantRunPodMode(TENANT_ID, "shared");
}

beforeEach(async () => {
  store = new MemoryStore();
  upstream = [];
  upstreamReply = () => new Response(JSON.stringify({ id: "job-1", status: "IN_QUEUE" }), { status: 200 });
  deps = {
    store,
    mailer: { send: async () => {} },
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      upstream.push({ url, init: init ?? {} });
      return upstreamReply(url);
    }) as unknown as typeof fetch,
    now: () => 1_750_000_000_000,
  };
  await liveSharedTenant();
});

/** Requests the proxy actually forwarded to RunPod. The allow-list tests assert on its LENGTH, so
 *  "refused" means "never reached the vendor" rather than "returned a 4xx after spending". */
const upstreamCalls = () => upstream.filter((c) => c.url.startsWith("https://api.runpod.ai/"));

// ------------------------------------------------------------------------------------------------
// THE VERB SURFACE. This is the issue's whole reason for existing.
// ------------------------------------------------------------------------------------------------

describe("the verb surface: what the proxy will and will not forward", () => {
  it("REFUSES purge-queue -- the verb no RunPod key scoping can express -- and never calls upstream", async () => {
    const token = await goodToken();
    const res = await handle(
      modReq("/api/runpod/v2/pool-backend/purge-queue", token, { method: "POST" }),
      env(),
      ctx,
      deps,
    );
    expect(res.status).toBe(404);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("POSITIVE CONTROL for that refusal: /run on the SAME endpoint with the SAME token DOES forward", async () => {
    const res = await handle(submitReq("pool-backend", await goodToken()), env(), ctx, deps);
    expect(res.status).toBe(200);
    expect(upstreamCalls()).toHaveLength(1);
    expect(upstreamCalls()[0].url).toBe("https://api.runpod.ai/v2/pool-backend/run");
  });

  it("REFUSES runsync: a verb the meter has never seen is a verb it cannot price", async () => {
    const res = await handle(
      modReq("/api/runpod/v2/pool-backend/runsync", await goodToken(), { method: "POST", body: "{}" }),
      env(),
      ctx,
      deps,
    );
    expect(res.status).toBe(404);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("answers its own 404 under the prefix rather than falling through to the SESSION gate", async () => {
    // The distinction matters: a fall-through would answer 401 unauthorized for a path that simply
    // does not exist, and every debugging hour after that goes into the credential.
    const res = await handle(modReq("/api/runpod/nonsense", await goodToken()), env(), ctx, deps);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });
});

// ------------------------------------------------------------------------------------------------
// AUTHENTICATION
// ------------------------------------------------------------------------------------------------

describe("tenant authentication", () => {
  it("refuses with no bearer at all, and calls neither the store nor RunPod", async () => {
    const res = await handle(submitReq("pool-backend", null), env(), ctx, deps);
    expect(res.status).toBe(401);
    expect(res.headers.get(PLANE_REFUSAL_HEADER)).toBe("unauthorized");
    expect(upstreamCalls()).toHaveLength(0);
    expect(store.jobIndex.size).toBe(0);
  });

  it("refuses a token whose MAC is forged", async () => {
    const forged = `vjp1.${TENANT_ID}.${"0".repeat(64)}`;
    const res = await handle(submitReq("pool-backend", forged), env(), ctx, deps);
    expect(res.status).toBe(401);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("refuses a token minted under a DIFFERENT signing key (control: the right one is accepted)", async () => {
    const wrong = (await mintTenantProxyToken("some-other-key", TENANT_ID))!;
    expect((await handle(submitReq("pool-backend", wrong), env(), ctx, deps)).status).toBe(401);
    expect((await handle(submitReq("pool-backend", await goodToken()), env(), ctx, deps)).status).toBe(200);
  });

  it("FAILS CLOSED on a plane with no signing key: a genuine token is refused there", async () => {
    const token = await goodToken();
    const unkeyed = env({ RUNPOD_PROXY_SIGNING_KEY: undefined });
    expect((await handle(submitReq("pool-backend", token), unkeyed, ctx, deps)).status).toBe(401);
    // Control, so the refusal above is attributable to the missing key and not to the token.
    expect((await handle(submitReq("pool-backend", token), env(), ctx, deps)).status).toBe(200);
  });

  it("never lets the RunPod pool credential reach the tenant, and presents it upstream", async () => {
    const res = await handle(submitReq("pool-backend", await goodToken()), env(), ctx, deps);
    expect(await res.text()).not.toContain(POOL_KEY);
    const sent = new Headers(upstreamCalls()[0].init.headers as HeadersInit);
    expect(sent.get("authorization")).toBe(`Bearer ${POOL_KEY}`);
  });
});

// ------------------------------------------------------------------------------------------------
// THE TENANT GATE. Every state is checked from the column that actually holds it.
// ------------------------------------------------------------------------------------------------

describe("the tenant gate on submit", () => {
  const cases: { name: string; setup: () => Promise<void>; refusal: string }[] = [
    {
      name: "suspended (read off suspended_at, NOT off status, which never holds it)",
      setup: async () => void (await store.suspendTenant(TENANT_ID, "abuse report")),
      refusal: "tenant_suspended",
    },
    {
      name: "not live yet",
      setup: async () => void (await store.setTenantStatus(TENANT_ID, "provisioning")),
      refusal: "tenant_not_live",
    },
    {
      name: "DEDICATED mode -- the parity guard: a tenant with its own key never proxies",
      setup: async () => void (await store.setTenantRunPodMode(TENANT_ID, "dedicated")),
      refusal: "not_shared_mode",
    },
  ];

  for (const c of cases) {
    it(`refuses a ${c.name} tenant with ${c.refusal}, before any upstream call`, async () => {
      await c.setup();
      const res = await handle(submitReq("pool-backend", await goodToken()), env(), ctx, deps);
      expect(res.status).toBe(403);
      expect(res.headers.get(PLANE_REFUSAL_HEADER)).toBe(c.refusal);
      expect(upstreamCalls()).toHaveLength(0);
    });
  }

  it("POSITIVE CONTROL: the same tenant live, unsuspended and shared submits successfully", async () => {
    const res = await handle(submitReq("pool-backend", await goodToken()), env(), ctx, deps);
    expect(res.status).toBe(200);
    expect(upstreamCalls()).toHaveLength(1);
  });

  it("refuses a token for a tenant that does not exist", async () => {
    const ghost = (await mintTenantProxyToken(SIGNING_KEY, "ten_ghost"))!;
    const res = await handle(submitReq("pool-backend", ghost), env(), ctx, deps);
    expect(res.status).toBe(403);
    expect(res.headers.get(PLANE_REFUSAL_HEADER)).toBe("unknown_tenant");
  });
});

// ------------------------------------------------------------------------------------------------
// THE ALLOW-LIST
// ------------------------------------------------------------------------------------------------

describe("the endpoint allow-list", () => {
  it("refuses an endpoint in neither the pool nor the public list, before spending anything", async () => {
    const res = await handle(submitReq("some-other-endpoint", await goodToken()), env(), ctx, deps);
    expect(res.status).toBe(403);
    expect(res.headers.get(PLANE_REFUSAL_HEADER)).toBe("endpoint_not_allowed");
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("allows a POOL endpoint id, which arrives as DATA from SHARED_RUNPOD_ENDPOINTS", async () => {
    expect((await handle(submitReq("pool-lipsync", await goodToken()), env(), ctx, deps)).status).toBe(200);
  });

  it("allows the SPEECH slug in the cost-door list: the membership rule is BILLS RUNPOD, not i2v", async () => {
    expect((await handle(submitReq(PUBLIC_SLUG, await goodToken()), env(), ctx, deps)).status).toBe(200);
  });

  it("refuses every pool submit on a plane with NO pool configured (an endpoint it cannot price)", async () => {
    const unpooled = env({ SHARED_RUNPOD_ENDPOINTS: undefined });
    const res = await handle(submitReq("pool-backend", await goodToken()), unpooled, ctx, deps);
    expect(res.status).toBe(403);
    // Control: the compile-time PUBLIC slugs are unaffected by pool config, so the refusal above is
    // about the pool rather than about the allow-list being empty.
    expect((await handle(submitReq(PUBLIC_SLUG, await goodToken()), unpooled, ctx, deps)).status).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------
// WHAT A SUBMIT ACTUALLY DOES
// ------------------------------------------------------------------------------------------------

describe("submit: body rewrite and the attribution write", () => {
  const upstreamBody = () => JSON.parse(String(upstreamCalls()[0].init.body)) as Record<string, unknown>;

  it("INJECTS our callback and OVERWRITES a tenant-supplied webhook", async () => {
    await handle(
      submitReq("pool-backend", await goodToken(), { input: { x: 1 }, webhook: "https://attacker.example/steal" }),
      env(),
      ctx,
      deps,
    );
    const hook = String(upstreamBody().webhook);
    expect(hook).not.toContain("attacker.example");
    // Derived from the plane's own origin, with a 64-hex per-job token as the LAST path segment.
    //
    // SPLIT rather than one interpolated RegExp, and CodeQL was right to flag the first version
    // (js/incomplete-hostname-regexp, high): interpolating a host into a pattern leaves its dots
    // unescaped, so `studio.example.com` also matches `studioXexampleYcom`. Harmless in an
    // assertion and a real defect in the check it would be copied into. The prefix is an exact
    // string compare, so no host ever reaches a regex, and only the token shape is a pattern.
    const prefix = `${ORIGIN}/api/runpod/webhook/`;
    expect(hook.startsWith(prefix)).toBe(true);
    expect(hook.slice(prefix.length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mints a DIFFERENT token per job: one leaked callback URL exposes exactly one job", async () => {
    await handle(submitReq("pool-backend", await goodToken()), env(), ctx, deps);
    await handle(submitReq("pool-backend", await goodToken()), env(), ctx, deps);
    const hooks = upstreamCalls().map((c) => JSON.parse(String(c.init.body)).webhook);
    expect(hooks[0]).not.toBe(hooks[1]);
  });

  it("opens the row at SUBMIT with source=proxy, the endpoint, and the tenant", async () => {
    upstreamReply = () => new Response(JSON.stringify({ id: "job-abc", status: "IN_QUEUE" }), { status: 200 });
    await handle(submitReq(PUBLIC_SLUG, await goodToken(), { input: {} }, { "x-vivijure-module": "narration-gen" }), env(), ctx, deps);
    expect(store.jobIndex.get("job-abc")).toMatchObject({
      tenant_id: TENANT_ID,
      tenant_slug: "hero",
      // The endpoint is what PRICES the job on the cost door: eight slugs, eight prices.
      endpoint_id: PUBLIC_SLUG,
      module: "narration-gen",
      outcome: "submitted",
      source: "proxy",
      terminal_at: null,
      submitted_at: 1_750_000_000_000,
    });
  });

  it("passes an upstream REFUSAL through verbatim and opens NO row", async () => {
    upstreamReply = () => new Response(JSON.stringify({ error: "no capacity" }), { status: 429 });
    const res = await handle(submitReq("pool-backend", await goodToken()), env(), ctx, deps);
    expect(res.status).toBe(429);
    expect(store.jobIndex.size).toBe(0);
  });

  it("does NOT break a tenant's render when our own index write fails (the harvester is the backstop)", async () => {
    vi.spyOn(store, "openRunpodProxyJob").mockRejectedValue(new Error("d1 down"));
    const res = await handle(submitReq("pool-backend", await goodToken()), env(), ctx, deps);
    // The job is already submitted upstream. Failing the caller would not unsubmit it; it would
    // only lose the render on top of losing the row.
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toMatchObject({ id: "job-1" });
  });
});

// ------------------------------------------------------------------------------------------------
// THE CALLBACK. The security case this whole workstream exists for.
// ------------------------------------------------------------------------------------------------

describe("the webhook callback is an untrusted TRIGGER, never evidence", () => {
  /** Submit once and hand back the per-job token RunPod would hold. */
  async function submitAndToken(endpoint = "pool-backend", jobId = "job-1"): Promise<string> {
    upstreamReply = () => new Response(JSON.stringify({ id: jobId, status: "IN_QUEUE" }), { status: 200 });
    await handle(submitReq(endpoint, await goodToken()), env(), ctx, deps);
    const hook = String(JSON.parse(String(upstreamCalls()[0].init.body)).webhook);
    upstream = [];
    return hook.slice(hook.lastIndexOf("/") + 1);
  }

  const callback = (token: string, body: unknown) =>
    new Request(`${ORIGIN}/api/runpod/webhook/${token}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });

  it("REFUSES a forged token: no status read, no ledger write, nothing believed", async () => {
    await submitAndToken();
    const forged = "f".repeat(64);
    const res = await handle(callback(forged, { id: "job-1", status: "COMPLETED", executionTime: 999 }), env(), ctx, deps);
    expect(res.status).toBe(404);
    expect(upstreamCalls()).toHaveLength(0);
    expect(store.jobIndex.get("job-1")).toMatchObject({ terminal_at: null, outcome: "submitted" });
  });

  it("THE CORE PROPERTY: terminal facts come from OUR status read, and CONTRADICT the inbound body", async () => {
    const token = await submitAndToken();
    // The authoritative answer we will fetch says FAILED. The stranger's POST claims a COMPLETED
    // with a fat executionTime -- which under deduct-on-success is a forged CHARGE.
    upstreamReply = () =>
      new Response(JSON.stringify({ id: "job-1", status: "FAILED", executionTime: 120, delayTime: 7 }), { status: 200 });
    const res = await handle(
      callback(token, { id: "job-1", status: "COMPLETED", executionTime: 999_999, delayTime: 999_999 }),
      env(),
      ctx,
      deps,
    );
    expect(res.status).toBe(200);
    // We issued the read ourselves, with our own credential, at the endpoint from OUR row.
    expect(upstreamCalls()[0].url).toBe("https://api.runpod.ai/v2/pool-backend/status/job-1");
    expect(new Headers(upstreamCalls()[0].init.headers as HeadersInit).get("authorization")).toBe(`Bearer ${POOL_KEY}`);
    expect(store.jobIndex.get("job-1")).toMatchObject({
      outcome: "failed",
      status_raw: "FAILED",
      execution_ms: 120,
      delay_ms: 7,
    });
  });

  it("cannot read the inbound body at all: a body that EXPLODES on read still closes the row", async () => {
    const token = await submitAndToken();
    upstreamReply = () => new Response(JSON.stringify({ id: "job-1", status: "COMPLETED", executionTime: 42 }), { status: 200 });
    const poisoned = new Request(`${ORIGIN}/api/runpod/webhook/${token}`, {
      method: "POST",
      body: new ReadableStream({ start: (c) => c.error(new Error("body read attempted")) }),
      headers: { "content-type": "application/json" },
      // @ts-expect-error duplex is required by the fetch spec for a stream body and is not in the
      // Workers RequestInit types yet; undici (our vitest host) throws without it.
      duplex: "half",
    });
    const res = await handle(poisoned, env(), ctx, deps);
    expect(res.status).toBe(200);
    expect(store.jobIndex.get("job-1")).toMatchObject({ outcome: "completed", execution_ms: 42 });
  });

  it("CONTROL for the poison: the same exploding body on a route that DOES read one fails", async () => {
    // Without this the test above proves nothing -- an inert body would pass it identically.
    const poisonedSubmit = new Request(`${ORIGIN}/api/runpod/v2/pool-backend/run`, {
      method: "POST",
      body: new ReadableStream({ start: (c) => c.error(new Error("body read attempted")) }),
      headers: { authorization: `Bearer ${await goodToken()}`, "content-type": "application/json" },
      // @ts-expect-error see above.
      duplex: "half",
    });
    const res = await handle(poisonedSubmit, env(), ctx, deps);
    expect(res.status).toBe(400);
    expect(res.headers.get(PLANE_REFUSAL_HEADER)).toBe("bad_body");
  });

  it("is IDEMPOTENT across RunPod's retries: measured, one job, three byte-identical deliveries", async () => {
    const token = await submitAndToken();
    upstreamReply = () =>
      new Response(JSON.stringify({ id: "job-1", status: "COMPLETED", executionTime: 50, delayTime: 2 }), { status: 200 });
    const first = await handle(callback(token, {}), env(), ctx, deps);
    const second = await handle(callback(token, {}), env(), ctx, deps);
    const third = await handle(callback(token, {}), env(), ctx, deps);
    expect(await first.json()).toMatchObject({ closed: true });
    // FIRST WRITE WINS. Without the guard this is a 3x double-count of one job, triggered by a
    // receiver merely slow enough to look failed -- an ordinary production condition, not an attack.
    expect(await second.json()).toMatchObject({ closed: false });
    expect(await third.json()).toMatchObject({ closed: false });
    expect(store.jobIndex.get("job-1")).toMatchObject({ outcome: "completed", execution_ms: 50 });
  });

  it("a duplicate delivery makes NO upstream call: a leaked token buys nothing after the row closes", async () => {
    const token = await submitAndToken();
    upstreamReply = () =>
      new Response(JSON.stringify({ id: "job-1", status: "COMPLETED", executionTime: 50 }), { status: 200 });

    await handle(callback(token, {}), env(), ctx, deps);
    // CONTROL: the FIRST delivery must reach RunPod, or the assertion below passes on a proxy that
    // never calls upstream at all -- which is the shape this whole file exists to refuse.
    expect(upstreamCalls()).toHaveLength(1);

    upstream = [];
    await handle(callback(token, {}), env(), ctx, deps);
    await handle(callback(token, {}), env(), ctx, deps);
    // The ledger was always safe (first-write-wins). What is bounded HERE is outbound work: without
    // this, a leaked per-job token buys unlimited authenticated GET /status calls on OUR RunPod
    // credential, indefinitely, which is exactly the residual the per-job design exists to bound.
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("stores ABSENT execution time as NULL, never 0 -- and a genuine 0 stays distinguishable", async () => {
    const cancelled = await submitAndToken("pool-backend", "job-cancelled");
    // MEASURED 2026-08-02: a CANCELLED terminal carries no executionTime and no delayTime at all.
    upstreamReply = () => new Response(JSON.stringify({ id: "job-cancelled", status: "CANCELLED" }), { status: 200 });
    await handle(callback(cancelled, {}), env(), ctx, deps);
    expect(store.jobIndex.get("job-cancelled")).toMatchObject({
      outcome: "cancelled",
      execution_ms: null,
      delay_ms: null,
    });

    upstream = [];
    const zero = await submitAndToken("pool-backend", "job-zero");
    upstreamReply = () =>
      new Response(JSON.stringify({ id: "job-zero", status: "COMPLETED", executionTime: 0, delayTime: 0 }), { status: 200 });
    await handle(callback(zero, {}), env(), ctx, deps);
    // A real zero is a real measurement and must survive as one; collapsing the two is how a ledger
    // under-counts silently.
    expect(store.jobIndex.get("job-zero")).toMatchObject({ execution_ms: 0, delay_ms: 0 });
  });

  it("writes NOTHING when our authoritative read says the job is not terminal", async () => {
    const token = await submitAndToken();
    upstreamReply = () => new Response(JSON.stringify({ id: "job-1", status: "IN_PROGRESS" }), { status: 200 });
    const res = await handle(callback(token, { id: "job-1", status: "COMPLETED" }), env(), ctx, deps);
    // Non-2xx on purpose: it buys RunPod's two remaining attempts over the measured ~20s window,
    // which is the recovery for a callback that beat our own submit-time write.
    expect(res.status).toBe(503);
    expect(store.jobIndex.get("job-1")).toMatchObject({ terminal_at: null });
  });

  it("writes NOTHING when our own status read fails", async () => {
    const token = await submitAndToken();
    upstreamReply = () => new Response("nope", { status: 500 });
    const res = await handle(callback(token, {}), env(), ctx, deps);
    expect(res.status).toBe(503);
    expect(store.jobIndex.get("job-1")).toMatchObject({ terminal_at: null, outcome: "submitted" });
  });
});

// ------------------------------------------------------------------------------------------------
// THE POLL PATH
// ------------------------------------------------------------------------------------------------

describe("the poll path", () => {
  it("passes status, cancel and health upstream with OUR credential", async () => {
    const token = await goodToken();
    upstreamReply = () => new Response(JSON.stringify({ status: "IN_PROGRESS" }), { status: 200 });
    await handle(modReq("/api/runpod/v2/pool-backend/status/job-1", token), env(), ctx, deps);
    await handle(modReq("/api/runpod/v2/pool-backend/cancel/job-1", token, { method: "POST" }), env(), ctx, deps);
    await handle(modReq("/api/runpod/v2/pool-backend/health", token), env(), ctx, deps);
    expect(upstreamCalls().map((c) => c.url)).toEqual([
      "https://api.runpod.ai/v2/pool-backend/status/job-1",
      "https://api.runpod.ai/v2/pool-backend/cancel/job-1",
      "https://api.runpod.ai/v2/pool-backend/health",
    ]);
    expect(new Headers(upstreamCalls()[0].init.headers as HeadersInit).get("authorization")).toBe(`Bearer ${POOL_KEY}`);
  });

  it("keeps CANCEL reachable: it is the modules' spend-leak guard, and blocking it leaves jobs billing", async () => {
    const res = await handle(
      modReq("/api/runpod/v2/pool-backend/cancel/job-1", await goodToken(), { method: "POST" }),
      env(),
      ctx,
      deps,
    );
    expect(res.status).toBe(200);
  });

  it("enforces the SAME allow-list as submit, so a valid token authorizes nothing extra", async () => {
    const res = await handle(modReq("/api/runpod/v2/not-ours/status/job-1", await goodToken()), env(), ctx, deps);
    expect(res.status).toBe(403);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("refuses an unauthenticated poll", async () => {
    expect((await handle(modReq("/api/runpod/v2/pool-backend/status/job-1", null), env(), ctx, deps)).status).toBe(401);
  });

  it("does NOT invent a status when the plane cannot serve, so a module can tell us from RunPod", async () => {
    const res = await handle(
      modReq("/api/runpod/v2/pool-backend/status/job-1", await goodToken()),
      env({ SHARED_RUNPOD_INVOKE_KEY: undefined }),
      ctx,
      deps,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get(PLANE_REFUSAL_HEADER)).toBe("credential-unavailable");
  });

  it("THE STRUCTURAL RULE: a poll performs no store write at all (control: a submit does)", async () => {
    const calls: string[] = [];
    const recording = new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const recordingDeps = { ...deps, store: recording } as ControlPlaneDeps;
    const token = await goodToken();

    await handle(modReq("/api/runpod/v2/pool-backend/status/job-1", token), env(), ctx, recordingDeps);
    await handle(modReq("/api/runpod/v2/pool-backend/health", token), env(), ctx, recordingDeps);
    const duringPolls = [...calls];
    expect(duringPolls.filter((c) => /^(open|close|index)/.test(c))).toEqual([]);

    // POSITIVE CONTROL, and it is the whole reason the assertion above means anything: the SAME
    // recorder, on the SAME store, DOES see the submit write. Without it an instrument that records
    // nothing would pass identically.
    calls.length = 0;
    await handle(submitReq("pool-backend", token), env(), ctx, recordingDeps);
    expect(calls).toContain("openRunpodProxyJob");
  });
});

// ------------------------------------------------------------------------------------------------
// FOUND LIVE, not by a test: the first `wrangler dev` probe hit an empty local D1 and the callback
// answered the router's generic 500 rather than a named refusal. The submit path was already
// wrapped; this one was not. Regression-tested here because the difference is invisible until an
// operator is reading logs during an incident.
// ------------------------------------------------------------------------------------------------

describe("a store failure on the callback path is NAMED, not a generic 500", () => {
  it("answers 503 store-unavailable and writes nothing", async () => {
    const store2 = new MemoryStore();
    await store2.createAccount("acct_1", "a@b.com");
    await store2.createTenant(TENANT_ID, "hero", "acct_1", "live");
    await store2.setTenantRunPodMode(TENANT_ID, "shared");
    vi.spyOn(store2, "findRunpodProxyJobByWebhookToken").mockRejectedValue(new Error("D1_ERROR"));
    const brokenDeps = { ...deps, store: store2 } as ControlPlaneDeps;
    const res = await handle(
      new Request(`${ORIGIN}/api/runpod/webhook/${"a".repeat(64)}`, { method: "POST", body: "{}" }),
      env(),
      ctx,
      brokenDeps,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get(PLANE_REFUSAL_HEADER)).toBe("store-unavailable");
  });

  it("CONTROL: the same route on a working store answers its ordinary 404 for an unknown token", async () => {
    const res = await handle(
      new Request(`${ORIGIN}/api/runpod/webhook/${"a".repeat(64)}`, { method: "POST", body: "{}" }),
      env(),
      ctx,
      deps,
    );
    expect(res.status).toBe(404);
  });
});
