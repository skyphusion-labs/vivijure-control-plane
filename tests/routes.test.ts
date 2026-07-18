// Control-plane route behavior (#52), driven through the REAL router (handle()) with only the dep
// bundle swapped. Not a re-implementation of the logic in test form: the request goes in the front.
//
// Bias: negative tests. Every guard here is watched REFUSING before it is trusted, and each one
// targets the real refusal path rather than a stand-in that could not have succeeded anyway. The
// positive control sits next to each refusal, because "everything refuses" is a known way for a
// suite to look green while the feature is broken.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { handle } from "../src/index";
import type { ControlPlaneDeps, ProvisionerWiring } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import { SESSION_COOKIE, startSession } from "../src/auth";
import { sha256Hex } from "../src/crypto";
import { MemoryStore } from "./memory-store";

const ROOT_HOST = "studio.vivijure.com";
const ORIGIN = `https://${ROOT_HOST}`;
const AUP = "2026-07-17";
const ADMIN_TOKEN = "a".repeat(64);
const AUP_TEXT = "No CSAM. Ever. This is the acceptable use policy text.";

let store: MemoryStore;
let sent: { to: string; subject: string; text: string }[];
let deps: ControlPlaneDeps;
let wiring: { start: ReturnType<typeof vi.fn>; installInvokeKey: ReturnType<typeof vi.fn> };

const env = (over: Partial<ControlPlaneEnv> = {}): ControlPlaneEnv =>
  ({
    ASSETS: { fetch: async () => new Response("ui", { status: 200 }) } as unknown as Fetcher,
    CP_DB: {} as D1Database,
    AUP_VERSION: AUP,
    AUP_URL: `${ORIGIN}/aup`,
    CONTROL_PLANE_HOST: ROOT_HOST,
    CONTROL_PLANE_ADMIN_TOKEN: ADMIN_TOKEN,
    POSTERN_SEND_URL: "https://mail.example/api/send",
    POSTERN_SEND_TOKEN: "t",
    ...over,
  }) as ControlPlaneEnv;

// The ctx fake COLLECTS waitUntil promises instead of discarding them. Discarding made the
// magic-link assertions race the fire-and-forget send: they passed or failed depending on
// microtask timing, which is a flaky green, i.e. worse than a red. flush() awaits the real work.
let pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (p: Promise<unknown>) => void pending.push(p),
  passThroughOnException() {},
} as unknown as ExecutionContext;
const flush = async () => {
  await Promise.all(pending);
  pending = [];
};

beforeEach(() => {
  store = new MemoryStore();
  sent = [];
  pending = [];
  // The wiring STUB records the handoff; it never executes a job. What the routes prove is that
  // the runner is LAUNCHED with the right job/tenant/key; the step machine itself is
  // provisioner.test.ts + the live e2e.
  wiring = { start: vi.fn(async () => {}), installInvokeKey: vi.fn(async () => {}) };
  deps = {
    store,
    mailer: { send: async (to, subject, text) => void sent.push({ to, subject, text }) },
    // The AUP gate now fetches and hashes the SERVED bytes, so the fake serves them.
    fetch: vi.fn(async () => new Response(AUP_TEXT)) as unknown as typeof fetch,
    now: () => 1_750_000_000_000,
    provisioner: wiring as unknown as ProvisionerWiring,
  };
});

const req = (path: string, init: RequestInit = {}) =>
  new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { origin: ORIGIN, ...(init.headers as Record<string, string>) },
  });

const jsonReq = (path: string, body: unknown, init: RequestInit = {}) =>
  req(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, ...init });

async function signedIn(email = "a@b.com") {
  const account = await store.createAccount("acct_1", email);
  const { token } = await startSession(store, account.id, deps.now());
  return { account, cookie: `${SESSION_COOKIE}=${token}` };
}

// ---- config projection ----

describe("GET /api/platform/config", () => {
  it("projects auth_methods from what is CONFIGURED, never a hardcoded list", async () => {
    const res = await handle(req("/api/platform/config"), env(), ctx, deps);
    expect(await res.json()).toMatchObject({ auth_methods: ["email"], aup_version: AUP });
  });

  it("offers a provider only when BOTH its id and secret exist (half-config = absent, not broken)", async () => {
    const half = env({ GOOGLE_OAUTH_CLIENT_ID: "id" });
    expect((await (await handle(req("/api/platform/config"), half, ctx, deps)).json())).toMatchObject({
      auth_methods: ["email"],
    });
    const full = env({ GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "s" });
    expect((await (await handle(req("/api/platform/config"), full, ctx, deps)).json())).toMatchObject({
      auth_methods: ["email", "google"],
    });
  });

  it("keeps Apple absent until all three Apple credentials are staged (the parked seam)", async () => {
    const partial = env({ APPLE_TEAM_ID: "T", APPLE_SERVICES_ID: "S" });
    expect((await (await handle(req("/api/platform/config"), partial, ctx, deps)).json())).toMatchObject({
      auth_methods: ["email"],
    });
    const staged = env({ APPLE_TEAM_ID: "T", APPLE_SERVICES_ID: "S", APPLE_PRIVATE_KEY: "p8" });
    expect((await (await handle(req("/api/platform/config"), staged, ctx, deps)).json())).toMatchObject({
      auth_methods: ["email", "apple"],
    });
  });
});

// ---- magic link ----

describe("POST /api/auth/email/start", () => {
  it("sends a link and answers 202", async () => {
    const res = await handle(jsonReq("/api/auth/email/start", { email: "New@Example.com " }), env(), ctx, deps);
    expect(res.status).toBe(202);
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("new@example.com"); // normalized in exactly one place
  });

  it("answers 202 identically for a junk address: no enumeration oracle", async () => {
    const res = await handle(jsonReq("/api/auth/email/start", { email: "nonsense" }), env(), ctx, deps);
    expect(res.status).toBe(202);
    await flush();
    expect(sent).toHaveLength(0);
  });

  it("answers 202 for a suspended account but sends nothing", async () => {
    const a = await store.createAccount("acct_s", "s@b.com");
    a.suspended_at = "now";
    const res = await handle(jsonReq("/api/auth/email/start", { email: "s@b.com" }), env(), ctx, deps);
    expect(res.status).toBe(202);
    await flush();
    expect(sent).toHaveLength(0);
  });

  it("REFUSES a new signup when signups are off, but still serves EXISTING accounts", async () => {
    store.settings.set("signups_enabled", "false");
    await handle(jsonReq("/api/auth/email/start", { email: "new@b.com" }), env(), ctx, deps);
    await flush();
    expect(sent).toHaveLength(0); // new person: door closed

    await store.createAccount("acct_2", "old@b.com");
    await handle(jsonReq("/api/auth/email/start", { email: "old@b.com" }), env(), ctx, deps);
    await flush();
    expect(sent).toHaveLength(1); // existing person: never locked out
  });
});

describe("GET /auth/email/callback", () => {
  async function link(email = "new@b.com"): Promise<string> {
    await handle(jsonReq("/api/auth/email/start", { email }), env(), ctx, deps);
    await flush();
    return new URL(sent[0].text.split("\n").find((l) => l.startsWith("http"))!).searchParams.get("token")!;
  }

  it("redeems a fresh link, creates the account, and sets a session", async () => {
    const res = await handle(req(`/auth/email/callback?token=${await link()}`), env(), ctx, deps);
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain(SESSION_COOKIE);
    expect(await store.getAccountByEmail("new@b.com")).not.toBeNull();
  });

  it("REFUSES a replayed link (single-use), even though it just worked", async () => {
    const token = await link();
    expect((await handle(req(`/auth/email/callback?token=${token}`), env(), ctx, deps)).headers.get("set-cookie"))
      .toContain(SESSION_COOKIE);
    const replay = await handle(req(`/auth/email/callback?token=${token}`), env(), ctx, deps);
    expect(replay.headers.get("location")).toContain("error=link_invalid");
    expect(replay.headers.get("set-cookie")).toBeNull();
  });

  it("REFUSES an expired link", async () => {
    const token = await link();
    const later = { ...deps, now: () => deps.now() + 16 * 60 * 1000 };
    const res = await handle(req(`/auth/email/callback?token=${token}`), env(), ctx, later);
    expect(res.headers.get("location")).toContain("error=link_invalid");
  });

  it("REFUSES a forged token", async () => {
    const res = await handle(req("/auth/email/callback?token=deadbeef"), env(), ctx, deps);
    expect(res.headers.get("location")).toContain("error=link_invalid");
  });

  it("REFUSES to create an account if signups closed AFTER the link was mailed", async () => {
    const token = await link();
    store.settings.set("signups_enabled", "false"); // the switch flips mid-flight
    const res = await handle(req(`/auth/email/callback?token=${token}`), env(), ctx, deps);
    expect(res.headers.get("location")).toContain("error=signups_closed");
    expect(await store.getAccountByEmail("new@b.com")).toBeNull(); // and leaves nothing behind
  });
});

// ---- session + AUP gate ----

describe("the AUP gate", () => {
  it("REFUSES a gated route before acceptance", async () => {
    const { cookie } = await signedIn();
    const res = await handle(req("/api/tenant/slug-available?slug=hero", { headers: { cookie } }), env(), ctx, deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "aup_required", version: AUP });
  });

  it("PASSES the same route after acceptance (the positive control)", async () => {
    const { cookie } = await signedIn();
    expect((await handle(jsonReq("/api/aup/accept", { version: AUP }, { headers: { cookie } }), env(), ctx, deps)).status)
      .toBe(204);
    const res = await handle(req("/api/tenant/slug-available?slug=hero", { headers: { cookie } }), env(), ctx, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: true });
  });

  it("RE-GATES everyone when AUP_VERSION is bumped, with no migration", async () => {
    const { cookie } = await signedIn();
    await handle(jsonReq("/api/aup/accept", { version: AUP }, { headers: { cookie } }), env(), ctx, deps);
    const bumped = env({ AUP_VERSION: "2026-09-01" });
    const res = await handle(req("/api/tenant/slug-available?slug=hero", { headers: { cookie } }), bumped, ctx, deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "aup_required", version: "2026-09-01" });
  });

  it("REFUSES acceptance of a stale version rather than logging consent to unseen text", async () => {
    const { cookie } = await signedIn();
    const res = await handle(jsonReq("/api/aup/accept", { version: "2020-01-01" }, { headers: { cookie } }), env(), ctx, deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "aup_version_stale", current: AUP });
  });

  it("records the SHA-256 of the SERVED AUP BYTES, not just the version label", async () => {
    // The label proves what we CALLED the text; the hash proves what it SAID. If the bytes behind
    // AUP_URL ever change without a version bump, every acceptance row would otherwise attest to
    // text nobody agreed to, with no way after the fact to tell which. (Ernst's first-serve
    // immutability rule, #40.)
    const { cookie } = await signedIn();
    await handle(jsonReq("/api/aup/accept", { version: AUP }, { headers: { cookie } }), env(), ctx, deps);
    const expected = await sha256Hex(AUP_TEXT);
    expect(store.aup[0].aup_sha256).toBe(expected);
  });

  it("serves the hash alongside the label so the front door can prove what it displayed", async () => {
    const res = await handle(req("/api/aup/current"), env(), ctx, deps);
    expect(await res.json()).toMatchObject({ version: AUP, sha256: await sha256Hex(AUP_TEXT) });
  });

  it("REFUSES an acceptance it cannot hash, and records NOTHING (fail closed)", async () => {
    // An acceptance whose text we cannot pin is not evidence: it records that someone clicked a
    // button next to bytes we can no longer identify. 503, because that is OUR failure.
    const { cookie } = await signedIn();
    deps.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await handle(jsonReq("/api/aup/accept", { version: AUP }, { headers: { cookie } }), env(), ctx, deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "aup_unverifiable" });
    expect(store.aup).toHaveLength(0);
    // and the gate still refuses, so an unverifiable AUP cannot become a way past it
    const gated = await handle(req("/api/tenant/slug-available?slug=hero", { headers: { cookie } }), env(), ctx, deps);
    expect(gated.status).toBe(403);
  });

  it("REFUSES when the AUP fetch throws outright (network, not just a bad status)", async () => {
    const { cookie } = await signedIn();
    deps.fetch = vi.fn(async () => { throw new Error("network"); }) as unknown as typeof fetch;
    const res = await handle(jsonReq("/api/aup/accept", { version: AUP }, { headers: { cookie } }), env(), ctx, deps);
    expect(res.status).toBe(503);
    expect(store.aup).toHaveLength(0);
  });

  it("hashes the acceptance IP rather than storing it raw", async () => {
    const { cookie } = await signedIn();
    await handle(
      jsonReq("/api/aup/accept", { version: AUP }, { headers: { cookie, "cf-connecting-ip": "203.0.113.9" } }),
      env(), ctx, deps,
    );
    expect(store.aup[0].ip_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(store.aup)).not.toContain("203.0.113.9");
  });

  it("leaves /api/me reachable so a gated user can still see why they are gated", async () => {
    const { cookie } = await signedIn();
    const res = await handle(req("/api/me", { headers: { cookie } }), env(), ctx, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ aup: { required_version: AUP, accepted: false }, tenant: null });
  });
});

describe("sessions", () => {
  it("REFUSES an unauthenticated gated route", async () => {
    expect((await handle(req("/api/me"), env(), ctx, deps)).status).toBe(401);
  });

  it("REFUSES a revoked session after logout", async () => {
    const { cookie } = await signedIn();
    expect((await handle(req("/api/me", { headers: { cookie } }), env(), ctx, deps)).status).toBe(200);
    expect((await handle(jsonReq("/api/auth/logout", {}, { headers: { cookie } }), env(), ctx, deps)).status).toBe(204);
    expect((await handle(req("/api/me", { headers: { cookie } }), env(), ctx, deps)).status).toBe(401);
  });

  it("REFUSES a session whose account was suspended mid-session", async () => {
    const { account, cookie } = await signedIn();
    account.suspended_at = "now";
    expect((await handle(req("/api/me", { headers: { cookie } }), env(), ctx, deps)).status).toBe(401);
  });

  it("REFUSES a cross-origin state-changing request (CSRF)", async () => {
    const { cookie } = await signedIn();
    const res = await handle(
      new Request(`${ORIGIN}/api/aup/accept`, {
        method: "POST",
        body: "{}",
        headers: { cookie, origin: "https://evil.example" },
      }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "bad_origin" });
  });
});

// ---- tenants ----

describe("POST /api/tenant/provision", () => {
  async function ready() {
    const s = await signedIn();
    await handle(jsonReq("/api/aup/accept", { version: AUP }, { headers: { cookie: s.cookie } }), env(), ctx, deps);
    return s;
  }

  it("creates a tenant and a queued job, and LAUNCHES the runner with the transient key", async () => {
    const { cookie } = await ready();
    const res = await handle(
      jsonReq("/api/tenant/provision", { slug: "hero", runpod_api_key: "rpa_x" }, { headers: { cookie } }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { tenant_id: string; job_id: string };
    expect(store.tenants.get(body.tenant_id)?.status).toBe("pending");
    expect(store.jobs.get(body.job_id)?.status).toBe("queued");
    // The wiring handoff: job id, THE created tenant, and the key -- the one place it may travel.
    expect(wiring.start).toHaveBeenCalledTimes(1);
    const [jobId, tenant, key] = wiring.start.mock.calls[0] as [string, { id: string }, string];
    expect(jobId).toBe(body.job_id);
    expect(tenant.id).toBe(body.tenant_id);
    expect(key).toBe("rpa_x");
  });

  it("REFUSES (503) when the provisioner wiring is absent, creating NOTHING", async () => {
    const { cookie } = await ready();
    const res = await handle(
      jsonReq("/api/tenant/provision", { slug: "hero", runpod_api_key: "rpa_x" }, { headers: { cookie } }),
      env(), ctx, { ...deps, provisioner: undefined },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "provisioner_unconfigured" });
    // No parked tenant, no job nothing will run: refusal must leave zero rows behind.
    expect(store.tenants.size).toBe(0);
    expect(store.jobs.size).toBe(0);
  });

  it("RULING: signups OFF never strands an existing AUP-accepted account (provision still 202)", async () => {
    // The toggle aims at the front DOOR (new accounts; refusal pinned in the callback suite), not
    // at people already inside it. Both halves together are the product ruling, 2026-07-17.
    const { cookie } = await ready();
    store.settings.set("signups_enabled", "false");
    const res = await handle(
      jsonReq("/api/tenant/provision", { slug: "hero", runpod_api_key: "rpa_x" }, { headers: { cookie } }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(202);
    expect(wiring.start).toHaveBeenCalledTimes(1);
  });

  it("NEVER stores the transient provisioning key anywhere", async () => {
    const { cookie } = await ready();
    await handle(
      jsonReq("/api/tenant/provision", { slug: "hero", runpod_api_key: "rpa_SUPERSECRET" }, { headers: { cookie } }),
      env(), ctx, deps,
    );
    // The custody ruling in one assertion: the key exists in the request and nowhere else.
    const dump = JSON.stringify([...store.tenants.values(), ...store.jobs.values(), [...store.settings]]);
    expect(dump).not.toContain("rpa_SUPERSECRET");
  });

  it("REFUSES provisioning without a key, a reserved slug, a taken slug, or a second tenant", async () => {
    const { cookie } = await ready();
    const post = (body: unknown) =>
      handle(jsonReq("/api/tenant/provision", body, { headers: { cookie } }), env(), ctx, deps);

    expect((await post({ slug: "hero" })).status).toBe(400); // no key
    expect((await post({ slug: "admin", runpod_api_key: "rpa_x" })).status).toBe(400); // reserved
    expect((await post({ slug: "hero", runpod_api_key: "rpa_x" })).status).toBe(202); // ok
    expect((await post({ slug: "hero2", runpod_api_key: "rpa_x" })).status).toBe(409); // second tenant
  });

  it("REFUSES a slug already taken by another account", async () => {
    await store.createTenant("ten_other", "taken", "acct_other", "live");
    const { cookie } = await ready();
    const res = await handle(
      jsonReq("/api/tenant/provision", { slug: "taken", runpod_api_key: "rpa_x" }, { headers: { cookie } }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "slug_taken" });
  });

  it("404s another account's tenant rather than 403 (no existence oracle)", async () => {
    await store.createTenant("ten_someoneelse", "theirs", "acct_other", "live");
    const { cookie } = await ready();
    const res = await handle(req("/api/tenant/ten_someoneelse/job", { headers: { cookie } }), env(), ctx, deps);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/tenant/:id/invoke-key", () => {
  async function tenantReady(endpoints: string | null, script: string | null = "tenant-hero-studio") {
    const s = await signedIn();
    await handle(jsonReq("/api/aup/accept", { version: AUP }, { headers: { cookie: s.cookie } }), env(), ctx, deps);
    const t = await store.createTenant("ten_abc123", "hero", s.account.id, "awaiting_invoke_key");
    t.endpoints_json = endpoints;
    t.script_name = script;
    return s;
  }

  it("REFUSES a key before endpoints exist: there is nothing to scope to", async () => {
    const { cookie } = await tenantReady(null);
    const res = await handle(
      jsonReq("/api/tenant/ten_abc123/invoke-key", { runpod_invoke_key: "rpa_x" }, { headers: { cookie } }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "no_endpoints" });
  });

  it("REFUSES a graphql-capable key WITHOUT storing it", async () => {
    const { cookie } = await tenantReady('["ep1"]');
    deps.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("graphql")
        ? new Response(JSON.stringify({ data: { myself: { id: "u" } } }), { status: 200 })
        : new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const res = await handle(
      jsonReq("/api/tenant/ten_abc123/invoke-key", { runpod_invoke_key: "rpa_toopowerful" }, { headers: { cookie } }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invoke_key_rejected", reason: "graphql_capable" });
    expect(JSON.stringify([...store.tenants.values()])).not.toContain("rpa_toopowerful");
  });

  it("installs a correctly scoped key and promotes the tenant to live", async () => {
    // Real stored shape: the provisioner writes CreatedEndpoint[] objects, not a string[] of ids.
    const { cookie } = await tenantReady(
      JSON.stringify([{ key: "backend", label: "Render", id: "ep1", name: "vivijure-hero-backend" }]),
    );
    deps.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("graphql")
        ? new Response("no", { status: 401 })
        : new Response(JSON.stringify({ workers: {} }), { status: 200 }),
    ) as unknown as typeof fetch;
    const res = await handle(
      jsonReq("/api/tenant/ten_abc123/invoke-key", { runpod_invoke_key: "rpa_good" }, { headers: { cookie } }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "live", verified_endpoints: 1 });
    // The install handoff carries the tenant and the key; the key is stored NOWHERE else.
    expect(wiring.installInvokeKey).toHaveBeenCalledTimes(1);
    const [tenant, key] = wiring.installInvokeKey.mock.calls[0] as [{ id: string }, string];
    expect(tenant.id).toBe("ten_abc123");
    expect(key).toBe("rpa_good");
    expect(store.tenants.get("ten_abc123")?.status).toBe("live");
    expect(JSON.stringify([...store.tenants.values()])).not.toContain("rpa_good");
  });

  it("REFUSES (409 not_provisioned) when endpoints exist but the studio upload never completed", async () => {
    const { cookie } = await tenantReady('["ep1"]', null);
    const res = await handle(
      jsonReq("/api/tenant/ten_abc123/invoke-key", { runpod_invoke_key: "rpa_good" }, { headers: { cookie } }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_provisioned" });
    expect(wiring.installInvokeKey).not.toHaveBeenCalled();
  });

  it("REFUSES (503) when the provisioner wiring is absent, without probing or storing", async () => {
    const { cookie } = await tenantReady('["ep1"]');
    const probes = vi.fn(async () => new Response("{}", { status: 200 }));
    const res = await handle(
      jsonReq("/api/tenant/ten_abc123/invoke-key", { runpod_invoke_key: "rpa_good" }, { headers: { cookie } }),
      env(), ctx, { ...deps, fetch: probes as unknown as typeof fetch, provisioner: undefined },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "provisioner_unconfigured" });
    expect(probes).not.toHaveBeenCalled();
    expect(store.tenants.get("ten_abc123")?.status).toBe("awaiting_invoke_key");
  });

  it("a failed install stays HONEST: 500, and the tenant is NOT promoted to live", async () => {
    const { cookie } = await tenantReady('["ep1"]');
    wiring.installInvokeKey.mockRejectedValueOnce(new Error("secrets PUT exploded"));
    deps.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("graphql")
        ? new Response("no", { status: 401 })
        : new Response(JSON.stringify({ workers: {} }), { status: 200 }),
    ) as unknown as typeof fetch;
    const res = await handle(
      jsonReq("/api/tenant/ten_abc123/invoke-key", { runpod_invoke_key: "rpa_good" }, { headers: { cookie } }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(500);
    expect(store.tenants.get("ten_abc123")?.status).toBe("awaiting_invoke_key");
  });
});

// ---- admin ----

describe("admin switches", () => {
  const admin = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${ADMIN_TOKEN}`, ...extra });

  it("REFUSES a wrong or missing admin token", async () => {
    expect((await handle(req("/api/admin/tenants"), env(), ctx, deps)).status).toBe(401);
    expect(
      (await handle(req("/api/admin/tenants", { headers: { authorization: "Bearer wrong" } }), env(), ctx, deps)).status,
    ).toBe(401);
  });

  it("fails CLOSED when no admin token is configured: unset means no admin surface", async () => {
    const res = await handle(
      req("/api/admin/tenants", { headers: admin() }),
      env({ CONTROL_PLANE_ADMIN_TOKEN: undefined }),
      ctx, deps,
    );
    expect(res.status).toBe(401);
  });

  it("REFUSES a session cookie in place of the admin token (a user cannot self-promote)", async () => {
    const { cookie } = await signedIn();
    expect((await handle(req("/api/admin/tenants", { headers: { cookie } }), env(), ctx, deps)).status).toBe(401);
  });

  it("suspends and resumes a tenant, and audits both", async () => {
    const t0 = await store.createTenant("ten_abc123", "hero", "acct_1", "live");
    t0.live_at = "t0";
    const s = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/suspend", { reason: "abuse report" }, { headers: admin() }),
      env(), ctx, deps,
    );
    expect(s.status).toBe(204);
    expect(store.tenants.get("ten_abc123")?.suspended_at).not.toBeNull();

    const r = await handle(jsonReq("/api/admin/tenants/ten_abc123/resume", {}, { headers: admin() }), env(), ctx, deps);
    expect(r.status).toBe(204);
    expect(store.tenants.get("ten_abc123")?.suspended_at).toBeNull();
    expect(store.tenants.get("ten_abc123")?.status).toBe("live");
    expect(store.audit.map((a) => a.action)).toEqual(["tenant.suspend", "tenant.resume"]);
  });

  it("resume restores the tenant's REAL state, never a guessed 'live' (live-verify regression)", async () => {
    // Found on the real box during the #52 live verify, not by this suite: suspension used to be
    // stored IN the status column, so suspending a PENDING tenant destroyed the lifecycle and
    // resume promoted it to "live" with a URL to a studio that had never been provisioned. The
    // unit suite missed it because it only ever suspended an already-live tenant.
    await store.createTenant("ten_abc123", "hero", "acct_1", "pending");
    await handle(
      jsonReq("/api/admin/tenants/ten_abc123/suspend", { reason: "abuse" }, { headers: admin() }),
      env(), ctx, deps,
    );
    // While suspended the API projects "suspended" and offers no URL...
    let view = (await (await handle(req("/api/admin/tenants", { headers: admin() }), env(), ctx, deps)).json()) as {
      tenants: { status: string; url: string | null; suspended_reason: string | null }[];
    };
    expect(view.tenants[0]).toMatchObject({ status: "suspended", url: null });
    // ...but the underlying lifecycle was never overwritten.
    expect(store.tenants.get("ten_abc123")?.status).toBe("pending");

    await handle(jsonReq("/api/admin/tenants/ten_abc123/resume", {}, { headers: admin() }), env(), ctx, deps);
    view = (await (await handle(req("/api/admin/tenants", { headers: admin() }), env(), ctx, deps)).json()) as {
      tenants: { status: string; url: string | null; suspended_reason: string | null }[];
    };
    expect(view.tenants[0]).toMatchObject({ status: "pending", url: null });
    expect(store.tenants.get("ten_abc123")?.live_at).toBeNull();
  });

  it("suspending a LIVE tenant pulls its URL, and resume gives it back", async () => {
    const t = await store.createTenant("ten_abc123", "hero", "acct_1", "live");
    t.live_at = "t0";
    await handle(
      jsonReq("/api/admin/tenants/ten_abc123/suspend", { reason: "abuse" }, { headers: admin() }),
      env(), ctx, deps,
    );
    let view = (await (await handle(req("/api/admin/tenants", { headers: admin() }), env(), ctx, deps)).json()) as {
      tenants: { status: string; url: string | null; suspended_reason: string | null }[];
    };
    expect(view.tenants[0]).toMatchObject({ status: "suspended", url: null, suspended_reason: "abuse" });

    await handle(jsonReq("/api/admin/tenants/ten_abc123/resume", {}, { headers: admin() }), env(), ctx, deps);
    view = (await (await handle(req("/api/admin/tenants", { headers: admin() }), env(), ctx, deps)).json()) as {
      tenants: { status: string; url: string | null; suspended_reason: string | null }[];
    };
    expect(view.tenants[0]).toMatchObject({ status: "live", url: "https://hero.studio.vivijure.com" });
  });

  it("REFUSES resume on a tenant that is not suspended", async () => {
    await store.createTenant("ten_abc123", "hero", "acct_1", "live");
    const res = await handle(jsonReq("/api/admin/tenants/ten_abc123/resume", {}, { headers: admin() }), env(), ctx, deps);
    expect(res.status).toBe(409);
  });

  it("REFUSES a suspend with no reason: the kill switch must stay auditable", async () => {
    await store.createTenant("ten_abc123", "hero", "acct_1", "live");
    const res = await handle(jsonReq("/api/admin/tenants/ten_abc123/suspend", {}, { headers: admin() }), env(), ctx, deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "reason_required" });
    expect(store.tenants.get("ten_abc123")?.status).toBe("live");
  });

  it("flips signups off, and the switch is visible to the front door immediately", async () => {
    expect((await handle(jsonReq("/api/admin/settings", { signups_enabled: false }, { headers: admin() }), env(), ctx, deps)).status)
      .toBe(204);
    const cfg = await (await handle(req("/api/platform/config"), env(), ctx, deps)).json();
    expect(cfg).toMatchObject({ signups_enabled: false });
    expect(store.audit.map((a) => a.action)).toContain("settings.set");
  });
});
