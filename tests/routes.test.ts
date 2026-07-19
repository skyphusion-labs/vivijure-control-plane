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
import type { Tenant } from "../src/store";
import { TenantModuleError } from "../src/tenant-modules";
// Cross-lane (authorized by the lead, control-plane#20 client fix): the CANONICAL invoke-key
// response shapes, shared with the client suite that reads them
// (tests/onboarding-invoke-key.test.ts). Asserting them HERE is what stops the browser client from
// going green against a contract this route no longer serves -- the defect that shipped twice.
// expectExactKeys is deliberately NOT toMatchObject: a subset match cannot see a field appear or
// disappear, which is precisely the drift being guarded.
import { LIVE_KEYS, LIVE_UNVERIFIED_KEYS, UNCONFIRMED_KEYS, expectExactKeys } from "./invoke-key-shapes";

const ROOT_HOST = "studio.vivijure.com";
const ORIGIN = `https://${ROOT_HOST}`;
const AUP = "2026-07-17";
const ADMIN_TOKEN = "a".repeat(64);
const AUP_TEXT = "No CSAM. Ever. This is the acceptable use policy text.";

let store: MemoryStore;
let sent: { to: string; subject: string; text: string }[];
let deps: ControlPlaneDeps;
let wiring: {
  start: ReturnType<typeof vi.fn>;
  installInvokeKey: ReturnType<typeof vi.fn>;
  teardown: ReturnType<typeof vi.fn>;
  preflightUpgrade: ReturnType<typeof vi.fn>;
  upgradeModules: ReturnType<typeof vi.fn>;
};

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
  // installInvokeKey now returns the cf#114 module-readiness outcome; the route reads it, so a
  // stub that returns undefined is not a valid stand-in for the production contract.
  wiring = {
    start: vi.fn(async () => {}),
    installInvokeKey: vi.fn(async () => ({
      verified: ["keyframe", "own-gpu", "finish-upscale", "finish-lipsync", "speech-upscale"],
      unverified: [],
      unconfirmed: [],
      attempts: 1,
      elapsedMs: 12,
    })),
    // Reclaim reaps through this. Default is a clean teardown; the failure cases override it.
    teardown: vi.fn(async () => ({ ok: true, failures: [] })),
    // cf#103: the upgrade route preflights through the seam, then hands the context to the runner.
    // Default is a PASSING preflight; the refusal cases override it.
    preflightUpgrade: vi.fn(async () => ({
      ok: true,
      context: {
        script: "tenant-hero-studio",
        endpoints: [],
        studioApiToken: "tok",
        release: "v1.1.0",
        bundles: new Map(),
      },
    })),
    upgradeModules: vi.fn(async () => {}),
  };
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

  // cf#103 items 3 and 4: the PREVIEW and the PROVISION path must agree, and neither may leak
  // internal resource ids to a browser.

  it("slug-available: an owner Tier A row reads reclaimable, and NO resource ids reach the client", async () => {
    const { cookie, account } = await ready();
    const t = await store.createTenant("ten_halfbuilt", "hero", account.id, "failed");
    // A half-built row carries real cloud handles. These must never appear in a preview response.
    await store.setTenantD1(t.id, "d1-uuid-secret");
    await store.setTenantBucket(t.id, "bucket-name-secret");
    await store.setTenantR2Token(t.id, "r2-token-id-secret");

    const res = await handle(req("/api/tenant/slug-available?slug=hero", { headers: { cookie } }), env(), ctx, deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Tier A: never live, so the owner may retake it.
    expect(body.available).toBe(true);
    expect(body.reclaimable).toBe(true);
    // The projection: the handle itself never crosses the wire.
    expect("reclaim" in body).toBe(false);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("d1-uuid-secret");
    expect(raw).not.toContain("bucket-name-secret");
    expect(raw).not.toContain("r2-token-id-secret");
  });

  it("slug-available: a STRANGER row gives the generic reason, never the tier", async () => {
    await store.createTenant("ten_other", "hero", "acct_other", "live");
    const { cookie } = await ready();
    const res = await handle(req("/api/tenant/slug-available?slug=hero", { headers: { cookie } }), env(), ctx, deps);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.available).toBe(false);
    expect(body.reason).toBe("that name is taken");
  });

  // ---- RECLAIM EXECUTION (cf#103, closes control-plane#18) ------------------------------------
  //
  // The ordering claim -> teardown -> reclaimSlug is the design, so most of these assert what did
  // NOT happen. Teardown is the destructive step and every tenant resource name derives from the
  // SLUG rather than the attempt, so a teardown that runs when it should not deletes resources
  // belonging to whoever legitimately holds the row.

  async function halfBuilt(accountId: string) {
    const t = await store.createTenant("ten_halfbuilt", "hero", accountId, "failed");
    await store.setTenantD1(t.id, "db-old");
    await store.setTenantBucket(t.id, "vivijure-tenant-hero");
    await store.setTenantR2Token(t.id, "tok-old");
    return (await store.getTenantById(t.id))!;
  }

  it("reclaims a Tier A slug: claim, reap, blank, then provision the SAME row", async () => {
    const { cookie, account } = await ready();
    await halfBuilt(account.id);

    const res = await handle(
      jsonReq("/api/tenant/provision", { slug: "hero", runpod_api_key: "rpa_x" }, { headers: { cookie } }),
      env(), ctx, deps,
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reclaimed).toBe(true);
    // The SAME row, not a second one: tenants.slug is UNIQUE, so a new row is impossible and a
    // duplicate would orphan the first.
    expect(body.tenant_id).toBe("ten_halfbuilt");
    expect(store.tenants.size).toBe(1);

    // Reaped from the row the CLAIM returned, with its ids still populated.
    expect(wiring.teardown).toHaveBeenCalledTimes(1);
    const [reaped, opts] = wiring.teardown.mock.calls[0] as [Tenant, { deleteData: boolean }];
    expect(reaped.d1_database_id).toBe("db-old");
    expect(reaped.r2_token_id).toBe("tok-old");
    expect(opts.deleteData).toBe(true);

    // Blanked and back at pending, and provisioning started on it.
    const after = await store.getTenantById("ten_halfbuilt");
    expect(after?.status).toBe("pending");
    expect(after?.d1_database_id).toBeNull();
    expect(wiring.start).toHaveBeenCalledTimes(1);
  });

  it("LOST the claim: destroys NOTHING and says the name is being reset", async () => {
    const { cookie, account } = await ready();
    await halfBuilt(account.id);
    // Somebody else holds the row.
    store.claimReclaim = (async () => null) as typeof store.claimReclaim;

    const res = await handle(
      jsonReq("/api/tenant/provision", { slug: "hero", runpod_api_key: "rpa_x" }, { headers: { cookie } }),
      env(), ctx, deps,
    );

    expect(res.status).toBe(409);
    expect((await res.json() as Record<string, unknown>).error).toBe("slug_reclaim_in_progress");
    // THE ASSERTION THIS TEST EXISTS FOR: the loser never reaches teardown. If it did, it would
    // delete resources the winner is using, because the names derive from the slug.
    expect(wiring.teardown).not.toHaveBeenCalled();
    expect(wiring.start).not.toHaveBeenCalled();
  });

  it("PARTIAL teardown failure: does NOT complete the reclaim, and surfaces the real errors", async () => {
    const { cookie, account } = await ready();
    await halfBuilt(account.id);
    wiring.teardown = vi.fn(async () => ({
      ok: false,
      failures: [{ resource: "r2_bucket", error: "bucket is not empty" }],
    }));
    deps.provisioner = wiring as unknown as ProvisionerWiring;

    const res = await handle(
      jsonReq("/api/tenant/provision", { slug: "hero", runpod_api_key: "rpa_x" }, { headers: { cookie } }),
      env(), ctx, deps,
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("reclaim_teardown_failed");
    expect(body.failures).toEqual([{ resource: "r2_bucket", error: "bucket is not empty" }]);
    // THE ASSERTION THIS TEST EXISTS FOR: reclaimSlug blanks the resource columns, so completing
    // here would erase the only record of what we failed to delete. The row keeps its ids.
    const after = await store.getTenantById("ten_halfbuilt");
    expect(after?.r2_bucket_name).toBe("vivijure-tenant-hero");
    expect(after?.status).toBe("failed");
    expect(wiring.start).not.toHaveBeenCalled();
  });

  it("TEARDOWN OVERRUN: completion refused after a real teardown is loud, not silent", async () => {
    const { cookie, account } = await ready();
    await halfBuilt(account.id);
    // The lease expired while teardown ran: token still matches, reclaimSlug refuses anyway.
    store.reclaimSlug = (async () => null) as typeof store.reclaimSlug;
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a));

    const res = await handle(
      jsonReq("/api/tenant/provision", { slug: "hero", runpod_api_key: "rpa_x" }, { headers: { cookie } }),
      env(), ctx, deps,
    );

    expect(res.status).toBe(409);
    expect((await res.json() as Record<string, unknown>).error).toBe("slug_reclaim_in_progress");
    // Teardown DID run, so this is the one path where we did destructive work we cannot record.
    expect(wiring.teardown).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors)).toContain("reclaim.completion_refused");
    expect(wiring.start).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("refuses a MISSING KEY before destroying anything (cheap refusals precede teardown)", async () => {
    const { cookie, account } = await ready();
    await halfBuilt(account.id);

    const res = await handle(
      jsonReq("/api/tenant/provision", { slug: "hero" }, { headers: { cookie } }),
      env(), ctx, deps,
    );

    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>).error).toBe("runpod_key_required");
    // The point: a customer who forgot to paste a key must not lose their half-built studio for it.
    expect(wiring.teardown).not.toHaveBeenCalled();
    const after = await store.getTenantById("ten_halfbuilt");
    expect(after?.d1_database_id).toBe("db-old");
  });

  // cp#43: the job row is where a failed module upgrade keeps the ONLY surviving copy of the
  // previous release (the upgrade NULLs tenants.modules_release before its first upload), and
  // 0006_module_upgrade.sql instructs an operator to "consult the job row". These assert that
  // instruction is now performable through the API rather than only through prod D1.
  describe("GET /api/tenant/:id/job -- reports the job row, not a summary of it", () => {
    async function accepted() {
      const s = await signedIn();
      await handle(jsonReq("/api/aup/accept", { version: AUP }, { headers: { cookie: s.cookie } }), env(), ctx, deps);
      return s;
    }

    it("carries the release PAIR and the kind for a FAILED module upgrade (the rollback path)", async () => {
      const s = await accepted();
      await store.createTenant("ten_abc123", "hero", s.account.id, "live");
      await store.createModuleUpgradeJob("job_up1", "ten_abc123", "v1.0.0", "v1.1.0");
      await store.finishJob("job_up1", "failed", "modules", "module 4 upload exploded");

      const res = await handle(req("/api/tenant/ten_abc123/job", { headers: { cookie: s.cookie } }), env(), ctx, deps);
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body.kind).toBe("module_upgrade");
      expect(body.status).toBe("failed");
      // The whole point: without this an operator cannot learn what to re-run the upgrade at.
      expect(body.from_release).toBe("v1.0.0");
      expect(body.to_release).toBe("v1.1.0");
      expect(body.error_message).toBe("module 4 upload exploded");
      expect(body.finished_at).not.toBeNull();
    });

    it("reports the pair as NULL on a PROVISION job rather than omitting the fields", async () => {
      // Absent and null are different answers. A caller that has to distinguish "no release pair
      // because this kind has none" from "the field was not sent" is back to guessing.
      const s = await accepted();
      // A queued provision job IS driven by this poll, and the wiring stub has no resume, so arm it
      // or the route 500s on a TypeError instead of answering.
      (wiring as unknown as { resume: unknown }).resume = vi.fn(async () => {});
      await store.createTenant("ten_dd0001", "other", s.account.id, "provisioning");
      await store.createProvisionJob("job_p1", "ten_dd0001", "provision");

      const res = await handle(req("/api/tenant/ten_dd0001/job", { headers: { cookie: s.cookie } }), env(), ctx, deps);
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.kind).toBe("provision");
      expect(Object.keys(body).sort()).toEqual([
        "error_message", "error_step", "finished_at", "from_release", "kind", "status", "step",
        "steps_done", "to_release",
      ]);
      expect(body.from_release).toBeNull();
      expect(body.to_release).toBeNull();
      expect(body.finished_at).toBeNull();
    });
  });

  it("404s another account's tenant rather than 403 (no existence oracle)", async () => {
    await store.createTenant("ten_someoneelse", "theirs", "acct_other", "live");
    const { cookie } = await ready();
    const res = await handle(req("/api/tenant/ten_someoneelse/job", { headers: { cookie } }), env(), ctx, deps);
    expect(res.status).toBe(404);
  });
});

// ---- the poll drives PROVISION jobs only (found while building cp#43) --------------------------
//
// FOUND, NOT DESIGNED: reading the job route for cp#43 showed driveJobIfNeeded has no `kind` check,
// while claimJob matches any kind and a module_upgrade job is created `queued` with a NULL lease.
// So a tenant polling their own job page during an admin module upgrade wins the claim and starts
// continueProvisionJob against a LIVE tenant. That path ends with setTenantStatus("awaiting_invoke_key"),
// which routingStatusFor treats as non-routable: the customer goes 503 on the path where the upgrade
// SUCCEEDS. upgradeTenantModules documents at length that it must never write tenants.status for
// exactly this reason; the poll reached around it.
describe("GET /api/tenant/:id/job -- drives PROVISION jobs only", () => {
  const armResume = () => {
    const resume = vi.fn(async () => {});
    (wiring as unknown as { resume: unknown }).resume = resume;
    return resume;
  };

  // The AUP gate sits in front of every tenant route, so a signed-in session alone reads 403 here.
  async function accepted() {
    const s = await signedIn();
    await handle(jsonReq("/api/aup/accept", { version: AUP }, { headers: { cookie: s.cookie } }), env(), ctx, deps);
    return s;
  }

  it("NEVER hands a module_upgrade job to the provision driver (that would take a live tenant dark)", async () => {
    const resume = armResume();
    const s = await accepted();
    await store.createTenant("ten_abc123", "hero", s.account.id, "live");
    await store.createModuleUpgradeJob("job_up1", "ten_abc123", "v1.0.0", "v1.1.0");

    const res = await handle(req("/api/tenant/ten_abc123/job", { headers: { cookie: s.cookie } }), env(), ctx, deps);
    await flush();

    // The job is still readable: refusing to DRIVE it is not refusing to REPORT it.
    expect(res.status).toBe(200);
    expect(resume).not.toHaveBeenCalled();
    expect((await store.getTenantById("ten_abc123"))?.status).toBe("live");
  });

  it("POSITIVE CONTROL: it DOES drive a provision job, so the guard above is not passing vacuously", async () => {
    const resume = armResume();
    const s = await accepted();
    await store.createTenant("ten_dd0001", "other", s.account.id, "provisioning");
    await store.createProvisionJob("job_p1", "ten_dd0001", "provision");

    await handle(req("/api/tenant/ten_dd0001/job", { headers: { cookie: s.cookie } }), env(), ctx, deps);
    await flush();

    expect(resume).toHaveBeenCalledWith("job_p1", expect.objectContaining({ id: "ten_dd0001" }), []);
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
    const liveBody = (await res.json()) as Record<string, unknown>;
    expect(liveBody).toMatchObject({
      status: "live",
      verified_endpoints: 1,
      // cf#114: the response says plainly that every module was PROVEN to serve the key.
      modules_ready: true,
    });
    // EXACT shape. The browser client branches on these keys; if one is added, renamed or removed
    // here, that client silently misreads a live studio -- which is how a customer came to be told
    // That key was not accepted while their tenant was already live in D1.
    expectExactKeys(liveBody, LIVE_KEYS);
    // The install handoff carries the tenant and the key; the key is stored NOWHERE else.
    expect(wiring.installInvokeKey).toHaveBeenCalledTimes(1);
    const [tenant, key] = wiring.installInvokeKey.mock.calls[0] as [{ id: string }, string];
    expect(tenant.id).toBe("ten_abc123");
    expect(key).toBe("rpa_good");
    expect(store.tenants.get("ten_abc123")?.status).toBe("live");
    expect(JSON.stringify([...store.tenants.values()])).not.toContain("rpa_good");
  });

  it("goes LIVE with modules_ready:false when readiness could not be PROVEN, and names them", async () => {
    // The asymmetry that cp#20 deletes ok rather than fixing it: 200 means LIVE, modules_ready means
    // PROVEN, and they are different facts. A module image predating GET /ready cannot report
    // readiness, so the tenant goes live with modules_ready:false and a modules_unverified list.
    // This is a REAL state, not a failure, and the browser client renders it as live-but-unproven
    // (tests/onboarding-invoke-key.test.ts). Without this test the client asserts that behaviour
    // against a shape nothing on the server side ever confirmed -- green against a fiction.
    const { cookie } = await tenantReady(
      JSON.stringify([{ key: "backend", label: "Render", id: "ep1", name: "vivijure-hero-backend" }]),
    );
    // UnverifiedModule OBJECTS, which is what installInvokeKey actually resolves to.
    // This mock returned bare strings, a shape the real function never produces, and the
    // assertion below was written to match the mock. Both sides agreed with each other and
    // neither agreed with the code, so the client shipped "[object Object]" to a customer.
    wiring.installInvokeKey.mockResolvedValueOnce({
      verified: ["backend"],
      unverified: [
        { module: "lipsync", reason: "unverifiable", detail: "no /ready route", script: "tenant-x-lipsync" },
        { module: "audio-upscale", reason: "unverifiable", detail: "no /ready route", script: "tenant-x-audio" },
      ],
      unconfirmed: [],
      attempts: 1, elapsedMs: 120,
    });
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
    const body = (await res.json()) as Record<string, unknown>;
    // Live, but explicitly NOT proven, and the unproven modules are NAMED so the fact travels.
    expect(body.status).toBe("live");
    expect(body.modules_ready).toBe(false);
    expect((body.modules_unverified as { module: string }[]).map((u) => u.module)).toEqual([
      "lipsync",
      "audio-upscale",
    ]);
    // Second key set, per the optional-key rule: allowing one optional key inside a single set is a
    // subset match wearing a disguise, so the with-unverified shape gets its own exact assertion.
    expectExactKeys(body, LIVE_UNVERIFIED_KEYS);
    expect(store.tenants.get("ten_abc123")?.status).toBe("live");
  });

  // cf#114: the readiness verdict has to REACH the caller. An operator reading the response must be
  // able to tell "checked and fine" from "could not check" without inspecting nested fields.
  it("surfaces a MIXED fleet honestly: modules_ready false, every unproven module named", async () => {
    const { cookie } = await tenantReady(
      JSON.stringify([{ key: "backend", label: "Render", id: "ep1", name: "vivijure-hero-backend" }]),
    );
    wiring.installInvokeKey.mockResolvedValueOnce({
      verified: ["keyframe", "own-gpu"],
      unverified: [
        { module: "finish-upscale", reason: "unverifiable", script: "ten-abc123-finish-upscale", detail: "d1" },
        { module: "speech-upscale", reason: "unverifiable", script: "ten-abc123-speech-upscale", detail: "d2" },
      ],
      unconfirmed: [],
      attempts: 1,
      elapsedMs: 30,
    });
    deps.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("graphql")
        ? new Response("no", { status: 401 })
        : new Response(JSON.stringify({ workers: {} }), { status: 200 }),
    ) as unknown as typeof fetch;

    const res = await handle(
      jsonReq("/api/tenant/ten_abc123/invoke-key", { runpod_invoke_key: "rpa_good" }, { headers: { cookie } }),
      env(), ctx, deps,
    );
    const body = (await res.json()) as {
      modules_ready: boolean;
      modules_verified: string[];
      modules_unverified: { module: string }[];
    };

    expect(res.status).toBe(200);
    // The key install genuinely succeeded, so the tenant IS live -- but readiness is not claimed.
    expect(store.tenants.get("ten_abc123")?.status).toBe("live");
    expect(body.modules_ready).toBe(false);
    expect(body.modules_verified).toEqual(["keyframe", "own-gpu"]);
    expect(body.modules_unverified.map((u) => u.module)).toEqual(["finish-upscale", "speech-upscale"]);
  });

  // cp#20: NEITHER invoke-key outcome may carry a summary `ok`. The 202 is the dangerous one (a
  // caller branching on ok:true would treat a NOT-LIVE tenant as ready, which is the cf#114 lie one
  // layer up), but the 200 is asserted too: if `ok` survived on success only, its ABSENCE would
  // silently become the failure signal and callers would still be reading a summary instead of the
  // state. These assert a field is MISSING, which toMatchObject structurally cannot do.
  it("cp#20: no `ok` field on the LIVE 200 -- callers branch on status/modules_ready", async () => {
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
    const body = (await res.json()) as Record<string, unknown>;
    expect("ok" in body).toBe(false);
    // The facts a caller must branch on instead are both present.
    expect(body.status).toBe("live");
    expect(typeof body.modules_ready).toBe("boolean");
  });

  it("cp#20: no `ok` field on the UNCONFIRMED 202 -- the not-live case cannot read as success", async () => {
    const { cookie } = await tenantReady(JSON.stringify(["ep1"]));
    wiring.installInvokeKey.mockResolvedValueOnce({
      verified: [], unverified: [], unconfirmed: ["keyframe"], attempts: 6, elapsedMs: 9800,
    });
    deps.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("graphql")
        ? new Response("no", { status: 401 })
        : new Response(JSON.stringify({ workers: {} }), { status: 200 }),
    ) as unknown as typeof fetch;
    const res = await handle(
      jsonReq("/api/tenant/ten_abc123/invoke-key", { runpod_invoke_key: "rpa_good" }, { headers: { cookie } }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect("ok" in body).toBe(false);
    expect(body.modules_ready).toBe(false);
    // And the tenant really is NOT live, which is what ok:true used to paper over.
    expect(store.tenants.get("ten_abc123")?.status).toBe("awaiting_invoke_key");
  });

  it("omits modules_unverified entirely when everything was PROVEN (no empty-array ambiguity)", async () => {
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
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.modules_ready).toBe(true);
    expect("modules_unverified" in body).toBe(false);
  });

  // ---- cf#114 follow-up (control-plane#17): WHAT THE CALLER RECEIVES on each readiness outcome.
  //
  // These exist because their absence shipped a defect. Every other test asserts what
  // awaitTenantModulesReady throws or returns; none asserted what this ROUTE hands back. So a
  // TenantModuleError carrying modules, attempts and elapsed propagated into the top-level catch and
  // reached the customer as a bare {"error":"internal_error"} 500 -- with the suite green. The cf#114
  // PR claimed that path "fails LOUDLY with attempts and elapsed": true of the function, false of the
  // product. For any path a customer can hit, assert the RESPONSE, not the internal.

  it("UNCONFIRMED (deadline, key installed but not yet visible) -> 202, and NOT live", async () => {
    const { cookie } = await tenantReady('["ep1"]');
    wiring.installInvokeKey.mockResolvedValueOnce({
      verified: [], unverified: [], unconfirmed: ["keyframe", "own-gpu"], attempts: 6, elapsedMs: 9800,
    });
    deps.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("graphql")
        ? new Response("no", { status: 401 })
        : new Response(JSON.stringify({ workers: {} }), { status: 200 }),
    ) as unknown as typeof fetch;

    const res = await handle(
      jsonReq("/api/tenant/ten_abc123/invoke-key", { runpod_invoke_key: "rpa_good" }, { headers: { cookie } }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    // EXACT shape, same reason as the go-live body above. The 202 is the response whose WORDS the
    // client now renders verbatim, so a change to it is a change to what a customer reads.
    expectExactKeys(body, UNCONFIRMED_KEYS);
    expect(body.modules_ready).toBe(false);
    expect(body.modules_unconfirmed).toEqual(["keyframe", "own-gpu"]);
    // It must say the key IS stored, or the caller re-pastes credentials for a problem that is not theirs.
    expect(String(body.message)).toMatch(/installed/i);
    expect(String(body.message)).toMatch(/retry/i);
    // The reported status is the TRUE stored one, not an invented label.
    expect(body.status).toBe("awaiting_invoke_key");
    // SAFETY: unconfirmed is never live. This is the entire point of the gate.
    expect(store.tenants.get("ten_abc123")?.status).toBe("awaiting_invoke_key");
  });

  it("MISCONFIGURED -> 503 carrying the REAL diagnostic, never a bare internal_error", async () => {
    const { cookie } = await tenantReady('["ep1"]');
    wiring.installInvokeKey.mockRejectedValueOnce(
      new TenantModuleError(
        "verify",
        "module keyframe (ten-abc123-keyframe) /ready -> 200: endpoint id absent (not retryable; attempts=1, elapsed=120ms)",
      ),
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
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("modules_not_ready");
    expect(body.error).not.toBe("internal_error");
    // The diagnostic IS the deliverable: which module, which script, retryability, attempts.
    expect(String(body.message)).toContain("ten-abc123-keyframe");
    expect(String(body.message)).toContain("not retryable");
    expect(String(body.message)).toContain("attempts=1");
    expect(store.tenants.get("ten_abc123")?.status).toBe("awaiting_invoke_key");
  });

  it("a NON-module install failure is still internal_error 500, not dressed up as a readiness problem", async () => {
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
    expect(await res.json()).toMatchObject({ error: "internal_error" });
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

// ---- the module-upgrade route (cf#103 half two) ----

describe("POST /api/admin/tenants/:id/upgrade-modules", () => {
  const admin = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${ADMIN_TOKEN}`, ...extra });

  /** An already-provisioned LIVE tenant, the only shape this route ever operates on. */
  async function liveTenant() {
    const t = await store.createTenant("ten_abc123", "hero", "acct_1", "live");
    t.live_at = "t0";
    t.script_name = "tenant-hero-studio";
    t.modules_release = "v1.0.0";
    // The wiring stub stands in for preflight, so the route test proves the ROUTE contract
    // (refusals, ordering, the 202 shape, what gets written) and the provisioner test proves the
    // step machine. Same split as the provision routes.
    wiring.preflightUpgrade = vi.fn(async () => ({
      ok: true,
      context: {
        script: "tenant-hero-studio",
        endpoints: [],
        studioApiToken: "tok",
        release: "v1.1.0",
        bundles: new Map(),
      },
    }));
    wiring.upgradeModules = vi.fn(async () => {});
    return t;
  }

  it("REFUSES a request with no release: there is deliberately no default", async () => {
    await liveTenant();
    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/upgrade-modules", {}, { headers: admin() }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "release_required" });
    // Nothing was started, and nothing was recorded.
    expect(wiring.upgradeModules).not.toHaveBeenCalled();
    expect(store.audit).toEqual([]);
  });

  it("REFUSES a blank/whitespace release rather than treating it as absent-but-fine", async () => {
    await liveTenant();
    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/upgrade-modules", { release: "   " }, { headers: admin() }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(400);
    expect(wiring.upgradeModules).not.toHaveBeenCalled();
  });

  it("REFUSES while another job for this tenant is still running (no two drivers, one script set)", async () => {
    await liveTenant();
    const running = await store.createProvisionJob("job_running", "ten_abc123", "provision");
    running.status = "running";

    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/upgrade-modules", { release: "v1.1.0" }, { headers: admin() }),
      env(), ctx, deps,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "job_in_progress", job_id: "job_running", kind: "provision" });
    expect(wiring.upgradeModules).not.toHaveBeenCalled();
  });

  it("a preflight refusal creates NO job and starts NO work", async () => {
    await liveTenant();
    wiring.preflightUpgrade = vi.fn(async () => ({
      ok: false,
      refusal: { code: "tenant_not_live", status: 409, message: "not live" },
    }));

    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/upgrade-modules", { release: "v1.1.0" }, { headers: admin() }),
      env(), ctx, deps,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "tenant_not_live", message: "not live" });
    // THE POINT of preflighting before the insert: a refusal leaves no row behind.
    expect(store.jobs.size).toBe(0);
    expect(store.audit).toEqual([]);
    expect(wiring.upgradeModules).not.toHaveBeenCalled();
  });

  it("ACCEPTS with 202 carrying EXACTLY the job id and both ends of the move, and no ok:true", async () => {
    await liveTenant();

    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/upgrade-modules", { release: "v1.1.0" }, { headers: admin() }),
      env(), ctx, deps,
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    // EXACT key set (cp#20): a 202 that carried ok:true would claim a success that has not happened
    // yet, and toMatchObject would never notice it being added back.
    expect(Object.keys(body).sort()).toEqual(["from_release", "job_id", "to_release"]);
    expect(body.from_release).toBe("v1.0.0");
    expect(body.to_release).toBe("v1.1.0");
    expect(typeof body.job_id).toBe("string");
    await flush();
    expect(wiring.upgradeModules).toHaveBeenCalledTimes(1);
  });

  it("records the move in the audit trail, both ends of it", async () => {
    await liveTenant();
    await handle(
      jsonReq("/api/admin/tenants/ten_abc123/upgrade-modules", { release: "v1.1.0" }, { headers: admin() }),
      env(), ctx, deps,
    );
    await flush();
    expect(store.audit.map((a) => a.action)).toEqual(["tenant.upgrade_modules"]);
    const detail = JSON.parse(store.audit[0].detail as string) as Record<string, unknown>;
    expect(detail.from).toBe("v1.0.0");
    expect(detail.to).toBe("v1.1.0");
  });

  it("the created job carries the release PAIR, so a failed upgrade stays rollback-able", async () => {
    await liveTenant();
    await handle(
      jsonReq("/api/admin/tenants/ten_abc123/upgrade-modules", { release: "v1.1.0" }, { headers: admin() }),
      env(), ctx, deps,
    );
    const job = [...store.jobs.values()][0];
    expect(job.kind).toBe("module_upgrade");
    expect(job.from_release).toBe("v1.0.0");
    expect(job.to_release).toBe("v1.1.0");
  });

  it("404s an unknown tenant, and REFUSES without the admin token", async () => {
    await liveTenant();
    expect(
      (await handle(
        jsonReq("/api/admin/tenants/ten_nope99/upgrade-modules", { release: "v1.1.0" }, { headers: admin() }),
        env(), ctx, deps,
      )).status,
    ).toBe(404);
    expect(
      (await handle(
        jsonReq("/api/admin/tenants/ten_abc123/upgrade-modules", { release: "v1.1.0" }),
        env(), ctx, deps,
      )).status,
    ).toBe(401);
  });
});
