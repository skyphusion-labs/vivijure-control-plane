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
import { StudioBindingError } from "../src/tenant-studio-bindings";
import { ReprovisionError } from "../src/tenant-runpod-reprovision";
import { decryptStudioToken, encryptStudioToken, kekRing } from "../src/token-crypto";
// Cross-lane (authorized by the lead, control-plane#20 client fix): the CANONICAL invoke-key
// response shapes, shared with the client suite that reads them
// (tests/onboarding-invoke-key.test.ts). Asserting them HERE is what stops the browser client from
// going green against a contract this route no longer serves -- the defect that shipped twice.
// expectExactKeys is deliberately NOT toMatchObject: a subset match cannot see a field appear or
// disappear, which is precisely the drift being guarded.
import {
  LIVE_KEYS, LIVE_UNVERIFIED_KEYS, UNCONFIRMED_KEYS, MESSAGE_MUST_SAY, READINESS_CLAIMS,
  expectExactKeys,
} from "./invoke-key-shapes";

/**
 * cp#112: the shape the provisioner returns for a clean refresh. Declared once, at the top, so the
 * route tests below assert the ROUTE contract (status, body key set, audit) against a fixture that
 * cannot drift silently from the module suite that owns the behaviour.
 */
const CLEAN_REFRESH = {
  ok: true,
  script: "tenant-hero-studio",
  service_id: "019ecbe6-9fc1-70a0-9946-14bbec0f51bc",
  already_present: false,
  bindings_before: ["ASSETS", "DB"],
  bindings_after: ["ASSETS", "DB", "VIDEO_FINISH_VPC"],
  secrets_before: ["STUDIO_API_TOKEN"],
  secrets_after: ["STUDIO_API_TOKEN"],
  missing_bindings: [] as string[],
  missing_secrets: [] as string[],
};

/**
 * A clean cp#136 tier-state readback. Same discipline as CLEAN_REFRESH above: shaped like the real
 * one so the route contract cannot drift from the module that owns the behaviour.
 */
const CLEAN_TIER_STATE = {
  ok: true,
  script: "tenant-hero-studio",
  unreachable: true,
  reason: "the CF account holding this studio is gone",
  var_present_before: false,
  var_present_after: true,
  bindings_before: ["ASSETS", "DB"],
  bindings_after: ["ASSETS", "DB", "VIDEO_FINISH_TIER_STATE"],
  secrets_before: ["STUDIO_API_TOKEN"],
  secrets_after: ["STUDIO_API_TOKEN"],
  missing_bindings: [] as string[],
  missing_secrets: [] as string[],
  served_reason_before: "Video finishing is not yet provisioned for this studio; finished renders deliver as per-shot clips.",
  served_reason_after:
    "Video finishing is not available for this studio and cannot be turned on for it; finished renders deliver as per-shot clips.",
  served_reason_changed: true,
};

/** A clean cp#136 detach readback, shaped like the real one (same discipline as CLEAN_REFRESH). */
const CLEAN_DETACH = {
  ok: true,
  script: "tenant-hero-studio",
  already_absent: false,
  bindings_before: ["ASSETS", "DB", "VIDEO_FINISH_VPC"],
  bindings_after: ["ASSETS", "DB"],
  secrets_before: ["STUDIO_API_TOKEN"],
  secrets_after: ["STUDIO_API_TOKEN"],
  missing_bindings: [] as string[],
  missing_secrets: [] as string[],
};

/**
 * cp#137: the shape a clean RunPod rebuild returns. Declared once, at the top, so the route tests
 * assert the ROUTE contract against a fixture that cannot drift silently from the module suite that
 * owns the behaviour (tests/tenant-runpod-reprovision.test.ts).
 */
const CLEAN_REBUILD = {
  tenant_id: "ten_abc123",
  slug: "hero",
  script: "tenant-hero-studio",
  endpoints_before: [{ key: "backend", id: "dead-backend" }],
  endpoints_after: [
    { key: "backend", id: "new-backend", name: "vivijure-hero-backend", endpointVar: "RUNPOD_ENDPOINT_ID" },
  ],
  templates: [],
  r2_token_id: "fresh-token-id",
  previous_r2_token_revoked: true,
  bindings_after: ["ASSETS", "DB"],
  secrets_after: ["RUNPOD_API_KEY", "STUDIO_API_TOKEN"],
  missing_bindings: [] as string[],
  missing_secrets: [] as string[],
  modules_release: "v1.6.0",
  modules_uploaded: ["modules_upload", "modules_install", "verify"],
  status: "awaiting_invoke_key" as const,
  next_step: "mint a RESTRICTED RunPod invoke key scoped to exactly these endpoint ids (new-backend)",
};

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
  refreshStudioBindings: ReturnType<typeof vi.fn>;
  setVideoFinishTierState: ReturnType<typeof vi.fn>;
  detachStudioBinding: ReturnType<typeof vi.fn>;
  preflightReprovisionRunPod: ReturnType<typeof vi.fn>;
  reprovisionRunPod: ReturnType<typeof vi.fn>;
  preflightStudioUpgrade: ReturnType<typeof vi.fn>;
  upgradeStudio: ReturnType<typeof vi.fn>;
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
    CP_RATE_LIMIT: { limit: async () => ({ success: true }) },
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
    teardown: vi.fn(async () => ({ ok: true, failures: [], absent: [] })),
    // cp#112: default is a clean binding refresh; the refusal and short-readback cases override it.
    refreshStudioBindings: vi.fn(async () => ({ ok: true, result: CLEAN_REFRESH })),
    // cp#139: the studio bytes move. Declared here rather than only inside its describe block so
    // the wiring literal's TYPE carries both members -- a stub assigned only in a test body
    // type-checks against an object that never had the property, which is a tests-tsconfig error
    // that `vitest run` alone would never surface.
    preflightStudioUpgrade: vi.fn(async () => ({
      ok: true,
      context: {
        script: "tenant-hero-studio",
        release: "v1.9.0",
        fromRelease: "v1.6.0",
        bundle: {},
        studioApiToken: "tok",
        hostBefore: null,
      },
    })),
    upgradeStudio: vi.fn(async () => ({ ok: true, result: {} })),
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
    // cp#137: the RunPod rebuild. Default is a PASSING preflight and a clean rebuild; the refusal
    // and failure cases override them.
    preflightReprovisionRunPod: vi.fn(async () => ({
      ok: true,
      context: {
        script: "tenant-hero-studio",
        studioApiToken: "tok",
        bucket: "vivijure-tenant-hero",
        modulesRelease: "v1.6.0",
        bundles: new Map(),
        recorded: [],
      },
    })),
    reprovisionRunPod: vi.fn(async () => CLEAN_REBUILD),
    // cp#136: default is a clean declaration; the refusal and short-readback cases override it.
    setVideoFinishTierState: vi.fn(async () => ({ ok: true, result: CLEAN_TIER_STATE })),
    // cp#136 criterion 3: default is a clean detach; the refusal and short-readback cases override.
    detachStudioBinding: vi.fn(async () => ({ ok: true, result: CLEAN_DETACH })),
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

// ---- SSO start: redirect_to must stay same-origin relative ----

describe("GET /auth/:provider/start redirect_to", () => {
  const googleEnv = () =>
    env({ GOOGLE_OAUTH_CLIENT_ID: "gid", GOOGLE_OAUTH_CLIENT_SECRET: "gsec" });

  async function storedRedirectTo(path: string): Promise<string | null> {
    const res = await handle(req(path), googleEnv(), ctx, deps);
    expect(res.status).toBe(302);
    expect([...store.oauthStates.values()]).toHaveLength(1);
    return [...store.oauthStates.values()][0].redirect_to;
  }

  it("keeps a same-origin relative path", async () => {
    expect(await storedRedirectTo("/auth/google/start?redirect_to=%2Fonboarding")).toBe("/onboarding");
  });

  it("keeps query and hash on a relative path", async () => {
    expect(await storedRedirectTo("/auth/google/start?redirect_to=%2Fapp%3Fstep%3D2%23ready")).toBe(
      "/app?step=2#ready",
    );
  });

  it("REFUSES the backslash open-redirect (`/\\evil.com` → protocol-relative)", async () => {
    // Literal backslash in the query value (browsers treat \\ as / → //evil.com).
    expect(await storedRedirectTo("/auth/google/start?redirect_to=/%5Cevil.com")).toBeNull();
    store.oauthStates.clear();
    const withSlash = "/auth/google/start?redirect_to=" + encodeURIComponent("/\\evil.com");
    expect(await storedRedirectTo(withSlash)).toBeNull();
  });

  it("REFUSES protocol-relative and absolute external URLs", async () => {
    expect(await storedRedirectTo("/auth/google/start?redirect_to=" + encodeURIComponent("//evil.com"))).toBeNull();
    store.oauthStates.clear();
    expect(await storedRedirectTo("/auth/google/start?redirect_to=" + encodeURIComponent("https://evil.com"))).toBeNull();
  });

  it("REFUSES absolute same-origin URLs (relative paths only)", async () => {
    expect(
      await storedRedirectTo(
        "/auth/google/start?redirect_to=" + encodeURIComponent("https://studio.vivijure.com/onboarding"),
      ),
    ).toBeNull();
  });

  it("defaults to null (later `/`) when redirect_to is absent", async () => {
    expect(await storedRedirectTo("/auth/google/start")).toBeNull();
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

  it("ALREADY-GONE pieces do not block the reclaim: an absent-only reap COMPLETES it (cp#110)", async () => {
    const { cookie, account } = await ready();
    await halfBuilt(account.id);
    // The live strand, at this route: the studio worker was NEVER created (the provision yielded
    // before wfp_upload), so the delete 404s on a derived name. Nothing failed -- there was nothing
    // to delete -- and a gate that read that as failure refused the ONLY recovery path the code
    // names, permanently, on a real customer FIRST attempt (vivijure-cf#240, Lane V).
    wiring.teardown = vi.fn(async () => {
      const row = (await store.getTenantById("ten_halfbuilt"))!;
      row.script_name = null;
      row.d1_database_id = null;
      row.r2_bucket_name = null;
      row.r2_token_id = null;
      return {
        ok: true,
        failures: [],
        absent: [{ resource: "worker", detail: "wfp.deleteScript: This Worker does not exist on your account." }],
      };
    });

    const res = await handle(
      jsonReq("/api/tenant/provision", { slug: "hero", runpod_api_key: "rpa_x" }, { headers: { cookie } }),
      env(), ctx, deps,
    );

    expect(res.status, "an absent-only reap must not read as reclaim_teardown_failed").toBe(202);
    expect((await res.json() as Record<string, unknown>).reclaimed).toBe(true);
    // The row is freed and provisioning restarted on it: the customer is unstuck.
    expect((await store.getTenantById("ten_halfbuilt"))?.status).toBe("pending");
    expect(wiring.start).toHaveBeenCalledTimes(1);
  });

  it("PARTIAL teardown failure: does NOT complete the reclaim, and surfaces the real errors", async () => {
    const { cookie, account } = await ready();
    await halfBuilt(account.id);
    wiring.teardown = vi.fn(async () => ({
      absent: [],
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

  // A lease that expired in the past, in the D1 datetime shape the store writes and leaseIsLive
  // reads. This is what a job whose driver is genuinely GONE looks like: it ran (status running,
  // attempts 1) and then stopped beating (cp#148), which is the ONE state a poll may take over.
  const expireLease = (jobId: string) => {
    const j = store.jobs.get(jobId)!;
    j.lease_until = new Date(Date.now() - 1_000).toISOString().replace("T", " ").slice(0, 19);
  };

  it("POSITIVE CONTROL: it DOES drive a provision job whose driver is gone, so the guards are not vacuous", async () => {
    const resume = armResume();
    const s = await accepted();
    await store.createTenant("ten_dd0001", "other", s.account.id, "provisioning");
    await store.createProvisionJob("job_p1", "ten_dd0001", "provision");
    // A driver took it and died: running, lease lapsed, no heartbeat behind it.
    await store.setJobRunning("job_p1");
    expireLease("job_p1");

    await handle(req("/api/tenant/ten_dd0001/job", { headers: { cookie: s.cookie } }), env(), ctx, deps);
    await flush();

    expect(resume).toHaveBeenCalledWith("job_p1", expect.objectContaining({ id: "ten_dd0001" }), []);
  });

  // ---- cp#132: the server half of cp#124 ------------------------------------------------------
  //
  // THE DEFECT, and it is destructive rather than merely wrong: createProvisionJob INSERTs `queued`
  // with a NULL lease and the driver is dispatched under waitUntil in the same request, so a poll
  // landing in that window wins claimJob outright. The winner runs continueProvisionJob, which
  // refuses anything short of wfp_upload by writing finishJob(failed) + setTenantStatus(failed) +
  // a rollback that DELETES the D1, bucket and token the real driver is still creating. The client
  // half (PR #129) made the UI wait; it could not stop a second tab, a script, or an operator
  // rehearsal, because the refusal is written by whoever holds the lease.
  //
  // The cp#148 heartbeat does not reach this window: it opens BEFORE the first beat and before
  // setJobRunning. What closes it is refusing to claim a job no driver has taken yet.
  it("NEVER claims a provision job whose driver has not started yet (cp#132)", async () => {
    const resume = armResume();
    const s = await accepted();
    await store.createTenant("ten_cc0001", "fresh", s.account.id, "provisioning");
    await store.createProvisionJob("job_q1", "ten_cc0001", "provision");

    const res = await handle(req("/api/tenant/ten_cc0001/job", { headers: { cookie: s.cookie } }), env(), ctx, deps);
    await flush();

    // Reported, not driven, and above all not TERMINALIZED.
    expect(res.status).toBe(200);
    expect(resume).not.toHaveBeenCalled();
    const job = store.jobs.get("job_q1")!;
    expect(job.status).toBe("queued");
    expect(job.error_message).toBeNull();
    expect(job.finished_at).toBeNull();
    // The lease is the other half: a poll that claimed would have written one, and that claim is
    // what makes the real driver own setJobRunning miss its predicate.
    expect(job.lease_until).toBeNull();
    expect((await store.getTenantById("ten_cc0001"))?.status).toBe("provisioning");
  });

  it("NEVER claims a provision job whose driver is alive and beating (cp#148 half, at the route)", async () => {
    const resume = armResume();
    const s = await accepted();
    await store.createTenant("ten_cc0002", "beating", s.account.id, "provisioning");
    await store.createProvisionJob("job_q2", "ten_cc0002", "provision");
    // setJobRunning is the first thing a driver writes, and its heartbeat keeps this lease live.
    await store.setJobRunning("job_q2");

    const res = await handle(req("/api/tenant/ten_cc0002/job", { headers: { cookie: s.cookie } }), env(), ctx, deps);
    await flush();

    expect(res.status).toBe(200);
    expect(resume).not.toHaveBeenCalled();
    expect(store.jobs.get("job_q2")!.status).toBe("running");
    expect((await store.getTenantById("ten_cc0002"))?.status).toBe("provisioning");
  });

  it("still declares a QUEUED job lost once the stale rule says so, so declining is not a wedge", async () => {
    // The cost of declining, paid honestly: a job whose driver never arrives is nobody else to
    // rescue, so the existing 10-minute lost-driver rule has to be the thing that ends it. If this
    // failed, the fix above would have traded a destructive race for an eternal spinner.
    const resume = armResume();
    const s = await accepted();
    await store.createTenant("ten_cc0003", "stalled", s.account.id, "provisioning");
    await store.createProvisionJob("job_q3", "ten_cc0003", "provision");
    const stalled = store.jobs.get("job_q3")!;
    // Off the ROUTE clock (deps.now is fixed in this harness), not the wall clock: the stale rule
    // compares updated_at against deps.now(), and a stamp taken from Date.now() reads as a job whose
    // last progress is in the future.
    stalled.updated_at = new Date(deps.now() - 11 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);

    const res = await handle(req("/api/tenant/ten_cc0003/job", { headers: { cookie: s.cookie } }), env(), ctx, deps);
    await flush();

    expect(res.status).toBe(200);
    expect(resume).not.toHaveBeenCalled();
    const job = store.jobs.get("job_q3")!;
    expect(job.status).toBe("failed");
    expect(job.error_message).toContain("invocation lost");
    expect((await store.getTenantById("ten_cc0003"))?.status).toBe("failed");
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

    // cp#27: the STRUCTURED facts behind that sentence. These are the numbers a client otherwise
    // has to parse back out of English, and the three claims that were previously load-bearing by
    // substring grep alone. Asserted against the real probe outcome (attempts 6, elapsedMs 9800)
    // rather than a hardcoded pair, so the fields cannot go stale against what the prober reported.
    expect(body.readiness).toEqual({
      attempts: 6,
      elapsed_ms: 9800,
      ...READINESS_CLAIMS,
    });
  });

  it("cp#27: the structured claims and the prose make the SAME four claims, or one of them is lying", async () => {
    // The point of the change is that these stop being independent. If a rewording drops "do not
    // re-paste" while repaste_needed stays false, or the reverse, this fails.
    const { cookie } = await tenantReady(String.raw`["ep1"]`);
    wiring.installInvokeKey.mockResolvedValueOnce({
      verified: [], unverified: [], unconfirmed: ["keyframe"], attempts: 2, elapsedMs: 300,
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
    const body = (await res.json()) as Record<string, unknown>;
    const readiness = body.readiness as Record<string, unknown>;

    MESSAGE_MUST_SAY.forEach((claim) => expect(String(body.message)).toMatch(claim));
    expect(readiness.key_stored).toBe(true);
    expect(readiness.retry_finishes).toBe(true);
    expect(readiness.repaste_needed).toBe(false);
    // The numbers track the ACTUAL probe, not the fixture: a client rendering a progress hint from
    // these must not be shown a constant.
    expect(readiness.attempts).toBe(2);
    expect(readiness.elapsed_ms).toBe(300);
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

// ---- the teardown caller (#23) ----
//
// These prove the ROUTE contract: what it refuses, what it promotes, and that the answer carries the
// evidence. teardownTenant itself (the guard, the blanking, the emptying cycle) is proven in
// provisioner.test.ts and teardown-guard.test.ts against a REAL store and a recording proxy; a route
// test that also re-proved the reaping would be asserting a stub.
describe("POST /api/admin/tenants/:id/teardown", () => {
  const admin = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${ADMIN_TOKEN}`, ...extra });

  async function provisionedTenant(status: "live" | "failed" = "live") {
    const t = await store.createTenant("ten_abc123", "hero", "acct_1", status);
    if (status === "live") t.live_at = "t0";
    t.script_name = "tenant-hero-studio";
    t.d1_database_id = "db-1";
    t.r2_bucket_name = "vivijure-tenant-hero";
    t.r2_token_id = "tok-1";
    return t;
  }

  /**
   * What a real teardown does to the row: blank the columns whose resource it actually reaped.
   *
   * `absent` (cp#110) blanks its column too -- an already-gone resource IS gone -- which is why it
   * is expressed as columns here rather than as a separate list of names. That equivalence is the
   * reason the route cannot tell the two apart from the row alone, and therefore the reason the
   * route reports absence separately.
   */
  function reaps(
    cols: ("script_name" | "d1_database_id" | "r2_bucket_name" | "r2_token_id")[],
    failures: { resource: string; error: string }[] = [],
    absent: { resource: string; detail: string }[] = [],
  ) {
    wiring.teardown = vi.fn(async () => {
      const row = (await store.getTenantById("ten_abc123"))!;
      for (const c of cols) row[c] = null;
      return { ok: failures.length === 0, failures, absent };
    });
  }

  it("REFUSES without the slug typed back: an opaque id is not a confirmation", async () => {
    await provisionedTenant();
    reaps(["script_name"]);
    const res = await handle(jsonReq("/api/admin/tenants/ten_abc123/teardown", {}, { headers: admin() }), env(), ctx, deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "slug_confirmation_required", slug: "hero" });
    expect(wiring.teardown).not.toHaveBeenCalled();
  });

  it("REFUSES a confirmation for a DIFFERENT slug", async () => {
    await provisionedTenant();
    reaps(["script_name"]);
    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/teardown", { confirm_slug: "hero-old" }, { headers: admin() }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(400);
    expect(wiring.teardown).not.toHaveBeenCalled();
  });

  it("defaults to KEEPING the data, and does not call the row deleted for a partial reap", async () => {
    await provisionedTenant();
    // No delete_data: the worker and the credential go, the D1 and the bucket stay.
    reaps(["script_name", "r2_token_id"]);
    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/teardown", { confirm_slug: "hero" }, { headers: admin() }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delete_data: boolean; reaped: string[]; status: string };
    expect(body.delete_data).toBe(false);
    expect(wiring.teardown).toHaveBeenCalledWith(expect.objectContaining({ id: "ten_abc123" }), { deleteData: false });
    expect(body.reaped.sort()).toEqual(["r2_token_id", "script_name"]);
    // THE POINT OF #23: the data is still there, so the row must NOT say deleted.
    expect(body.status).toBe("deleting");
    expect((await store.getTenantById("ten_abc123"))!.deleted_at).toBeNull();
  });

  it("promotes to deleted ONLY on a clean pass that was allowed to take the data", async () => {
    await provisionedTenant();
    reaps(["script_name", "d1_database_id", "r2_bucket_name", "r2_token_id"]);
    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/teardown", { confirm_slug: "hero", delete_data: true }, { headers: admin() }),
      env(), ctx, deps,
    );
    const body = (await res.json()) as { status: string; reaped: string[]; refused: unknown[]; failed: unknown[] };
    expect(body.status).toBe("deleted");
    expect(body.reaped).toHaveLength(4);
    expect(body.refused).toEqual([]);
    expect(body.failed).toEqual([]);
    const row = (await store.getTenantById("ten_abc123"))!;
    expect(row.status).toBe("deleted");
    expect(row.deleted_at).not.toBeNull();
  });

  it("reports an ALREADY-GONE resource separately from one this pass reaped (cp#110)", async () => {
    await provisionedTenant();
    // The live shape: the studio script was already gone, everything else reaped normally. The
    // column blanks either way, so `reaped` alone cannot say which happened -- and a teardown whose
    // only finding is absence is a CLEAN pass, which is what lets the row reach deleted at all.
    reaps(
      ["script_name", "d1_database_id", "r2_bucket_name", "r2_token_id"],
      [],
      [{ resource: "worker", detail: "wfp.deleteScript: This Worker does not exist on your account." }],
    );
    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/teardown", { confirm_slug: "hero", delete_data: true }, { headers: admin() }),
      env(), ctx, deps,
    );
    const body = (await res.json()) as { status: string; reaped: string[]; absent: { resource: string }[] };
    expect(body.absent.map((a) => a.resource)).toEqual(["worker"]);
    expect(body.reaped).toContain("script_name");
    expect(body.status).toBe("deleted");
    // The audit row carries it too: an operator reading the ledger later sees that this plane did
    // not delete that script, something else did.
    const entry = store.audit.find((a) => a.action === "tenant.teardown" && a.target === "ten_abc123")!;
    expect(JSON.parse(entry.detail!)).toMatchObject({ absent: ["worker"] });
  });

  it("splits REFUSALS from FAILURES, and a refusal keeps the row out of deleted", async () => {
    await provisionedTenant();
    // The live-plane shape: the guard refuses an aliased bucket, an unrelated call fails.
    reaps(["script_name"], [
      { resource: "r2_bucket", error: "refused: r2_bucket is still referenced by 1 other tenant row(s): ten_live (hero, status=live) -- AT LEAST ONE IS NOT DELETED, this resource is in use" },
      { resource: "d1", error: "Error: D1 delete failed" },
    ]);
    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/teardown", { confirm_slug: "hero", delete_data: true }, { headers: admin() }),
      env(), ctx, deps,
    );
    const body = (await res.json()) as {
      status: string;
      reaped: string[];
      refused: { resource: string }[];
      failed: { resource: string }[];
    };
    // They need opposite follow-up, so they must not arrive as one list.
    expect(body.refused.map((f) => f.resource)).toEqual(["r2_bucket"]);
    expect(body.failed.map((f) => f.resource)).toEqual(["d1"]);
    expect(body.reaped).toEqual(["script_name"]);
    expect(body.status).toBe("deleting");
    expect((await store.getTenantById("ten_abc123"))!.status).not.toBe("deleted");
  });

  it("REFUSES a second pass while one holds the lease (same-name deletes must not overlap)", async () => {
    await provisionedTenant();
    reaps(["script_name"]);
    // Somebody already holds the destructive lease on this row.
    await store.beginTeardown("ten_abc123", 300);
    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/teardown", { confirm_slug: "hero", delete_data: true }, { headers: admin() }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "teardown_in_progress" });
    expect(wiring.teardown).not.toHaveBeenCalled();
  });

  it("REFUSES without the admin token, like every other lever on this surface", async () => {
    await provisionedTenant();
    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/teardown", { confirm_slug: "hero", delete_data: true }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(401);
  });

  it("records an admin action, because an unaudited destructive lever is not an operator tool", async () => {
    await provisionedTenant();
    reaps(["script_name", "d1_database_id", "r2_bucket_name", "r2_token_id"]);
    await handle(
      jsonReq("/api/admin/tenants/ten_abc123/teardown", { confirm_slug: "hero", delete_data: true }, { headers: admin() }),
      env(), ctx, deps,
    );
    const entry = store.audit.find((a) => a.action === "tenant.teardown" && a.target === "ten_abc123");
    expect(entry, "the teardown must be audited").toBeDefined();
    // The detail has to carry WHAT happened, not just that something did.
    expect(JSON.parse(entry!.detail!)).toMatchObject({ delete_data: true, refused: 0, failed: 0 });
  });
});

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

  it("REFUSES while another job for this tenant holds a live lease (no two drivers, one script set)", async () => {
    await liveTenant();
    const running = await store.createProvisionJob("job_running", "ten_abc123", "provision");
    running.status = "running";
    running.lease_until = new Date(Date.now() + 60_000).toISOString().replace("T", " ").slice(0, 19);

    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/upgrade-modules", { release: "v1.1.0" }, { headers: admin() }),
      env(), ctx, deps,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "job_in_progress", job_id: "job_running", kind: "provision" });
    expect(wiring.upgradeModules).not.toHaveBeenCalled();
  });

  it("ALLOWS a new upgrade when the latest job is stranded queued with no lease (#44 self-heal)", async () => {
    await liveTenant();
    const stranded = await store.createModuleUpgradeJob("job_stranded", "ten_abc123", "v1.0.0", "v1.1.0");
    stranded.status = "queued";
    stranded.lease_until = null;

    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/upgrade-modules", { release: "v1.2.0" }, { headers: admin() }),
      env(), ctx, deps,
    );

    expect(res.status).toBe(202);
    await flush();
    expect(wiring.upgradeModules).toHaveBeenCalledTimes(1);
    const claimed = [...store.jobs.values()].find((j) => j.to_release === "v1.2.0");
    expect(claimed?.status).toBe("running");
    expect(claimed?.lease_until).not.toBeNull();
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
    expect(job.status).toBe("running");
    expect(job.lease_until).not.toBeNull();
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

// ---- cp#139: operator-driven STUDIO BYTES move ----
//
// The ROUTE contract only. What is actually uploaded, the binding-carry-forward shape, and the
// readback that decides ok are owned by tests/studio-upgrade.test.ts; duplicating them here would
// produce two fixtures that agree with each other and with nothing else.
describe("POST /api/admin/tenants/:id/upgrade-studio (cp#139)", () => {
  const admin = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${ADMIN_TOKEN}`, ...extra });
  const call = (body: Record<string, unknown>, id = "ten_abc123") =>
    handle(jsonReq(`/api/admin/tenants/${id}/upgrade-studio`, body, { headers: admin() }), env(), ctx, deps);

  /** An already-provisioned LIVE tenant on an OLD studio release: the only shape this route runs on. */
  async function liveTenant() {
    const t = await store.createTenant("ten_abc123", "hero", "acct_1", "live");
    t.live_at = "t0";
    t.script_name = "tenant-hero-studio";
    t.studio_release = "v1.6.0";
    wiring.preflightStudioUpgrade = vi.fn(async () => ({
      ok: true,
      context: {
        script: "tenant-hero-studio",
        release: "v1.9.0",
        fromRelease: "v1.6.0",
        bundle: {},
        studioApiToken: "tok",
        hostBefore: null,
      },
    }));
    wiring.upgradeStudio = vi.fn(async () => ({ ok: true, result: {} }));
    return t;
  }

  it("REFUSES a request with no release: there is deliberately no default to the plane pin", async () => {
    await liveTenant();
    const res = await call({});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "release_required" });
    expect(wiring.upgradeStudio).not.toHaveBeenCalled();
    expect(store.jobs.size).toBe(0);
    expect(store.audit).toEqual([]);
  });

  it("REFUSES a blank release rather than treating it as absent-but-fine", async () => {
    await liveTenant();
    const res = await call({ release: "   " });
    expect(res.status).toBe(400);
    expect(wiring.upgradeStudio).not.toHaveBeenCalled();
  });

  it("REFUSES while another job holds a live lease: two drivers, one studio script", async () => {
    await liveTenant();
    const running = await store.createProvisionJob("job_running", "ten_abc123", "provision");
    running.status = "running";
    running.lease_until = new Date(Date.now() + 60_000).toISOString().replace("T", " ").slice(0, 19);

    const res = await call({ release: "v1.9.0" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "job_in_progress", job_id: "job_running", kind: "provision" });
    expect(wiring.upgradeStudio).not.toHaveBeenCalled();
  });

  it("a preflight refusal creates NO job and starts NO work", async () => {
    await liveTenant();
    wiring.preflightStudioUpgrade = vi.fn(async () => ({
      ok: false,
      refusal: { code: "tenant_suspended", status: 409, message: "suspended" },
    }));

    const res = await call({ release: "v1.9.0" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "tenant_suspended", message: "suspended" });
    // THE POINT of preflighting before the insert: a refusal leaves no row and no audit entry.
    expect(store.jobs.size).toBe(0);
    expect(store.audit).toEqual([]);
    expect(wiring.upgradeStudio).not.toHaveBeenCalled();
  });

  it("ACCEPTS with 202 carrying EXACTLY the job id and both ends of the move, and no ok:true", async () => {
    await liveTenant();

    const res = await call({ release: "v1.9.0" });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    // EXACT key set (cp#20): a 202 claiming ok:true would assert a success that has not happened.
    expect(Object.keys(body).sort()).toEqual(["from_release", "job_id", "to_release"]);
    expect(body.from_release).toBe("v1.6.0");
    expect(body.to_release).toBe("v1.9.0");
    await flush();
    expect(wiring.upgradeStudio).toHaveBeenCalledTimes(1);
  });

  it("creates a STUDIO_UPGRADE job carrying the release pair, claimed before the 202", async () => {
    await liveTenant();
    await call({ release: "v1.9.0" });
    const job = [...store.jobs.values()][0];
    // The kind is the half that matters: the two upgrade kinds clear DIFFERENT tenant columns, so a
    // studio move recorded as a module move would clear the wrong fact.
    expect(job.kind).toBe("studio_upgrade");
    expect(job.from_release).toBe("v1.6.0");
    expect(job.to_release).toBe("v1.9.0");
    expect(job.status).toBe("running");
    expect(job.lease_until).not.toBeNull();
  });

  it("records the move in the audit trail, both ends of it", async () => {
    await liveTenant();
    await call({ release: "v1.9.0" });
    await flush();
    expect(store.audit.map((a) => a.action)).toEqual(["tenant.upgrade_studio"]);
    const detail = JSON.parse(store.audit[0].detail as string) as Record<string, unknown>;
    expect(detail.from).toBe("v1.6.0");
    expect(detail.to).toBe("v1.9.0");
  });

  it("404s an unknown tenant, and REFUSES without the admin token", async () => {
    await liveTenant();
    expect((await call({ release: "v1.9.0" }, "ten_nope99")).status).toBe(404);
    expect(
      (await handle(
        jsonReq("/api/admin/tenants/ten_abc123/upgrade-studio", { release: "v1.9.0" }),
        env(), ctx, deps,
      )).status,
    ).toBe(401);
  });
});

// ---- cp#112: operator-driven studio binding refresh ----
//
// The ROUTE contract only. What is actually sent to Cloudflare, and the readback that decides ok, is
// owned by tests/tenant-studio-bindings.test.ts; duplicating it here would produce two fixtures that
// agree with each other and with nothing else.
describe("POST /api/admin/tenants/:id/refresh-studio-bindings (cp#112)", () => {
  const admin = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${ADMIN_TOKEN}`, ...extra });
  const call = (id = "ten_abc123", d: ControlPlaneDeps = deps) =>
    handle(jsonReq(`/api/admin/tenants/${id}/refresh-studio-bindings`, {}, { headers: admin() }), env(), ctx, d);

  /** A D1-shaped timestamp against the HARNESS clock (deps.now()), never the wall clock. */
  const stamp = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

  async function existingTenant(): Promise<Tenant> {
    const t = await store.createTenant("ten_abc123", "hero", "acct_1", "live");
    t.live_at = "t0";
    t.script_name = "tenant-hero-studio";
    t.studio_release = "v1.6.0";
    return t;
  }

  it("REFUSES without the admin token: this is an operator action on someone else studio", async () => {
    await existingTenant();
    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/refresh-studio-bindings", {}),
      env(), ctx, deps,
    );
    expect(res.status).toBe(401);
    expect(wiring.refreshStudioBindings).not.toHaveBeenCalled();
  });

  it("refuses 503 when the plane has no provisioner wiring, rather than looking present", async () => {
    await existingTenant();
    const res = await call("ten_abc123", { ...deps, provisioner: undefined });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "provisioner_unconfigured" });
  });

  it("404s an unknown tenant", async () => {
    expect((await call("ten_nope")).status).toBe(404);
    expect(wiring.refreshStudioBindings).not.toHaveBeenCalled();
  });

  it("REFUSES while a job holds a live lease: a binding patch must not race an upload", async () => {
    await existingTenant();
    const running = await store.createProvisionJob("job_running", "ten_abc123", "provision");
    running.status = "running";
    // Stamped off deps.now(), NOT Date.now(). The harness clock is fixed in the past, so a lease
    // built from the wall clock is "live" no matter what it was meant to express -- which is how a
    // dead-lease control silently tests nothing. Caught by watching the control fail.
    running.lease_until = stamp(deps.now() + 60_000);

    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "job_in_progress", job_id: "job_running", kind: "provision" });
    expect(wiring.refreshStudioBindings).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: a dead lease does NOT block, or the guard would wedge every tenant", async () => {
    await existingTenant();
    const stale = await store.createProvisionJob("job_stale", "ten_abc123", "provision");
    stale.status = "running";
    stale.lease_until = stamp(deps.now() - 60_000);

    expect((await call()).status).toBe(200);
    expect(wiring.refreshStudioBindings).toHaveBeenCalledTimes(1);
  });

  it("returns the READBACK and audits the action, changing no tenant state", async () => {
    await existingTenant();
    const res = await call();
    expect(res.status).toBe(200);
    // Exact key set: a field appearing or vanishing here is a contract change an operator tool sees.
    expectExactKeys(await res.json(), [
      "tenant_id", "slug", "ok", "script", "service_id", "already_present",
      "bindings_before", "bindings_after", "secrets_before", "secrets_after",
      "missing_bindings", "missing_secrets",
    ]);
    expect(store.audit.map((a) => a.action)).toEqual(["tenant.refresh_studio_bindings"]);
    // The care standard cp#112 sets: a live tenant keeps serving, on the same release.
    const after = await store.getTenantById("ten_abc123");
    expect(after?.status).toBe("live");
    expect(after?.studio_release).toBe("v1.6.0");
  });

  it("answers 409, not 200, when the readback came back SHORT", async () => {
    // A 200 carrying ok:false reads as success to anything that checks status codes, and a tenant
    // that lost a secret is the one outcome this route exists to make impossible to miss.
    await existingTenant();
    wiring.refreshStudioBindings = vi.fn(async () => ({
      ok: true,
      result: { ...CLEAN_REFRESH, ok: false, missing_secrets: ["R2_S3_SECRET_ACCESS_KEY"] },
    }));
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()) as { missing_secrets: string[] }).toMatchObject({
      missing_secrets: ["R2_S3_SECRET_ACCESS_KEY"],
    });
    // Still audited: the failed attempt is exactly the one an operator must be able to find later.
    expect(store.audit.map((a) => a.action)).toEqual(["tenant.refresh_studio_bindings"]);
  });

  it("passes a preflight refusal through with its own code, having written nothing", async () => {
    await existingTenant();
    wiring.refreshStudioBindings = vi.fn(async () => ({
      ok: false,
      refusal: {
        code: "video_finish_unconfigured",
        status: 409,
        message: "this plane is not configured for video finishing (VIDEO_FINISH_VPC_SERVICE_ID is unset)",
      },
    }));
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "video_finish_unconfigured" });
    expect(store.audit).toEqual([]);
  });

  it("surfaces a NAMED credential failure instead of a bare 500", async () => {
    await existingTenant();
    wiring.refreshStudioBindings = vi.fn(async () => {
      throw new StudioBindingError(
        "vpc_binding_unauthorized",
        409,
        "video-finish binding refused: fix CF_WORKER_UPLOAD_TOKEN and re-run.",
      );
    });
    const res = await call();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("vpc_binding_unauthorized");
    expect(body.message).toMatch(/CF_WORKER_UPLOAD_TOKEN/);
  });
});

// ---- cp#95: KEK rotation routes ----------------------------------------------------------------

describe("KEK rotation admin routes (cp#95)", () => {
  const KEK = btoa("0123456789abcdef0123456789abcdef");
  const NEXT = btoa("ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP");
  const admin = () => ({ authorization: `Bearer ${ADMIN_TOKEN}` });

  const rotEnv = (over: Partial<ControlPlaneEnv> = {}) =>
    env({ STUDIO_TOKEN_KEK: KEK, ...over });

  /** A tenant row carrying ciphertext under the key of your choosing. */
  async function seedToken(id: string, slug: string, ring: Parameters<typeof encryptStudioToken>[0]) {
    const account = await store.createAccount(`acct_${id}`, `${slug}@example.com`);
    const t = await store.createTenant(id, slug, account.id, "live");
    await store.setTenantStudioToken(t.id, await encryptStudioToken(ring, `tok-${slug}`));
    return t;
  }

  it("REFUSES both routes without the admin token (it is an operator surface, not a user one)", async () => {
    expect((await handle(req("/api/admin/kek/status"), rotEnv(), ctx, deps)).status).toBe(401);
    expect(
      (await handle(jsonReq("/api/admin/kek/reencrypt", {}), rotEnv(), ctx, deps)).status,
    ).toBe(401);
  });

  it("answers 503 when no primary KEK is installed, rather than reporting every row unreadable", async () => {
    const res = await handle(req("/api/admin/kek/status", { headers: admin() }), env(), ctx, deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "kek_unconfigured" });
  });

  it("censuses by key WITH its counts, so an empty answer can never read as a passing one", async () => {
    await seedToken("ten_aaa111", "alpha", kekRing(KEK));
    await seedToken("ten_bbb222", "bravo", kekRing(NEXT));

    const res = await handle(
      req("/api/admin/kek/status", { headers: admin() }),
      rotEnv({ STUDIO_TOKEN_KEK_NEXT: NEXT, STUDIO_TOKEN_KEK_ENCRYPT_SLOT: "next" }),
      ctx,
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      window_open: true,
      encrypt_slot: "next",
      total: 2,
      on_target: 1,
      needs_rotation: 1,
      unreadable: [],
      safe_to_promote: false,
    });
  });

  it("REFUSES the sweep with 409 when no rotation window is open", async () => {
    await seedToken("ten_aaa111", "alpha", kekRing(KEK));
    const res = await handle(jsonReq("/api/admin/kek/reencrypt", {}, { headers: admin() }), rotEnv(), ctx, deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "rotation_window_closed" });
  });

  it("sweeps, then answers 200 ONLY when a FRESH census says the old key can be dropped", async () => {
    await seedToken("ten_aaa111", "alpha", kekRing(KEK));
    await seedToken("ten_bbb222", "bravo", kekRing(KEK));
    const rotating = rotEnv({ STUDIO_TOKEN_KEK_NEXT: NEXT, STUDIO_TOKEN_KEK_ENCRYPT_SLOT: "next" });

    const res = await handle(jsonReq("/api/admin/kek/reencrypt", {}, { headers: admin() }), rotating, ctx, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      sweep: { examined: 2, rotated: 2, raced: 0, complete: true },
      census: { needs_rotation: 0, safe_to_promote: true },
    });

    // The rows really moved: readable under the NEW key alone. Asserted against the store, because
    // the sweep counters are the writer describing its own work.
    for (const id of ["ten_aaa111", "ten_bbb222"]) {
      const enc = store.tenants.get(id)!.studio_token_enc!;
      await expect(decryptStudioToken(kekRing(NEXT), enc)).resolves.toContain("tok-");
      await expect(decryptStudioToken(kekRing(KEK), enc)).rejects.toBeTruthy();
    }
  });

  it("answers 409 when the run left work behind, so an incomplete rotation cannot read as done", async () => {
    await seedToken("ten_aaa111", "alpha", kekRing(KEK));
    await seedToken("ten_bbb222", "bravo", kekRing(KEK));
    const rotating = rotEnv({ STUDIO_TOKEN_KEK_NEXT: NEXT, STUDIO_TOKEN_KEK_ENCRYPT_SLOT: "next" });

    const res = await handle(
      jsonReq("/api/admin/kek/reencrypt", { limit: 1 }, { headers: admin() }),
      rotating,
      ctx,
      deps,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ census: { safe_to_promote: false } });
  });

  it("records the sweep as an admin action, without any key or token value in the detail", async () => {
    await seedToken("ten_aaa111", "alpha", kekRing(KEK));
    const rotating = rotEnv({ STUDIO_TOKEN_KEK_NEXT: NEXT, STUDIO_TOKEN_KEK_ENCRYPT_SLOT: "next" });
    await handle(jsonReq("/api/admin/kek/reencrypt", {}, { headers: admin() }), rotating, ctx, deps);

    const action = store.audit.find((a) => a.action === "kek.reencrypt");
    expect(action).toBeTruthy();
    // NEGATIVE assertion on what was PASSED to the recorder, not on a rendered view: no key material
    // and no token value may ride an audit row.
    expect(action!.detail ?? "").not.toContain(KEK);
    expect(action!.detail ?? "").not.toContain(NEXT);
    expect(action!.detail ?? "").not.toContain("tok-alpha");
    expect(JSON.parse(action!.detail!)).toMatchObject({ encrypt_slot: "next", rotated: 1 });
  });
});

// cp#136: the route that makes the panel `unprovisionable` state reachable at all.
//
// The behaviour that matters here is the ROUTE half: what it refuses, what it audits, and that it
// never answers 200 over a readback that disagrees with the intent. What the plane SENDS to
// Cloudflare, and the reader floor that stops a write nobody could read, live in
// tests/video-finish-tier-state.test.ts, which owns that behaviour.
describe("POST /api/admin/tenants/:id/video-finish-tier-state (cp#136)", () => {
  const admin = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${ADMIN_TOKEN}`, ...extra });
  const call = (body: unknown, id = "ten_abc123", d: ControlPlaneDeps = deps) =>
    handle(jsonReq(`/api/admin/tenants/${id}/video-finish-tier-state`, body, { headers: admin() }), env(), ctx, d);
  const MARK = { unreachable: true, reason: "the CF account holding this studio is gone" };

  async function existingTenant(): Promise<Tenant> {
    const t = await store.createTenant("ten_abc123", "hero", "acct_1", "live");
    t.live_at = "t0";
    t.script_name = "tenant-hero-studio";
    t.studio_release = "v1.9.0";
    return t;
  }

  it("REFUSES without the admin token: it changes what someone else studio tells its users", async () => {
    await existingTenant();
    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/video-finish-tier-state", MARK),
      env(), ctx, deps,
    );
    expect(res.status).toBe(401);
    expect(wiring.setVideoFinishTierState).not.toHaveBeenCalled();
  });

  it("refuses 503 when the plane has no provisioner wiring, rather than looking present", async () => {
    await existingTenant();
    const res = await call(MARK, "ten_abc123", { ...deps, provisioner: undefined });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "provisioner_unconfigured" });
  });

  it("404s an unknown tenant", async () => {
    expect((await call(MARK, "ten_nope")).status).toBe(404);
    expect(wiring.setVideoFinishTierState).not.toHaveBeenCalled();
  });

  it("REQUIRES a reason to declare, because the declaration must be reviewable", async () => {
    await existingTenant();
    const res = await call({ unreachable: true });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("reason_required");
    expect(wiring.setVideoFinishTierState).not.toHaveBeenCalled();

    // Whitespace is not a reason either: a required field satisfied by a space is not required.
    expect((await call({ unreachable: true, reason: "   " })).status).toBe(400);
    expect(wiring.setVideoFinishTierState).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: clearing needs NO reason, because it removes a claim", async () => {
    await existingTenant();
    wiring.setVideoFinishTierState = vi.fn(async () => ({
      ok: true,
      result: { ...CLEAN_TIER_STATE, unreachable: false, reason: null, var_present_after: false },
    }));
    expect((await call({ unreachable: false })).status).toBe(200);
    expect(wiring.setVideoFinishTierState).toHaveBeenCalledTimes(1);
    // And the intent reaches the seam as a CLEAR, with no reason invented on the way.
    expect(wiring.setVideoFinishTierState.mock.calls[0][1]).toEqual({ unreachable: false, reason: null });
  });

  it("400s a body that does not state an intent at all", async () => {
    await existingTenant();
    expect((await call({})).status).toBe(400);
    expect((await call({ unreachable: "yes" })).status).toBe(400);
    expect(wiring.setVideoFinishTierState).not.toHaveBeenCalled();
  });

  it("REFUSES while a job holds a live lease: this patch must not race an upload", async () => {
    await existingTenant();
    const running = await store.createProvisionJob("job_running", "ten_abc123", "provision");
    running.status = "running";
    running.lease_until = new Date(deps.now() + 60_000).toISOString().replace("T", " ").slice(0, 19);

    const res = await call(MARK);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "job_in_progress", job_id: "job_running", kind: "provision" });
    expect(wiring.setVideoFinishTierState).not.toHaveBeenCalled();
  });

  it("returns the READBACK and audits the action, changing no tenant state", async () => {
    await existingTenant();
    const res = await call(MARK);
    expect(res.status).toBe(200);
    expectExactKeys(await res.json(), [
      "tenant_id", "slug", "ok", "script", "unreachable", "reason",
      "var_present_before", "var_present_after",
      "bindings_before", "bindings_after", "secrets_before", "secrets_after",
      "missing_bindings", "missing_secrets",
      "served_reason_before", "served_reason_after", "served_reason_changed",
    ]);
    expect(store.audit.map((a) => a.action)).toEqual(["tenant.set_video_finish_tier_state"]);
    // The same care standard cp#112 sets: a live tenant keeps serving, on the same release.
    const after = await store.getTenantById("ten_abc123");
    expect(after?.status).toBe("live");
    expect(after?.studio_release).toBe("v1.9.0");
  });

  it("passes a module REFUSAL through with its own code and status, having written nothing", async () => {
    await existingTenant();
    wiring.setVideoFinishTierState = vi.fn(async () => ({
      ok: false,
      refusal: { code: "studio_reader_absent", status: 422, message: "would reach nobody" },
    }));
    const res = await call(MARK);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "studio_reader_absent", message: "would reach nobody" });
    // A refusal is not an action: nothing to audit.
    expect(store.audit).toEqual([]);
  });

  it("answers 409, not 200, when the readback disagrees with the intent", async () => {
    // A 200 carrying ok:false reads as success to anything checking status codes, and "the plane
    // believes it declared something the studio is not carrying" is what this route must not hide.
    await existingTenant();
    wiring.setVideoFinishTierState = vi.fn(async () => ({
      ok: true,
      result: { ...CLEAN_TIER_STATE, ok: false, var_present_after: false },
    }));
    const res = await call(MARK);
    expect(res.status).toBe(409);
    expect((await res.json() as { ok: boolean }).ok).toBe(false);
    // Still audited: the attempt happened and the operator needs the record of it.
    expect(store.audit.map((a) => a.action)).toEqual(["tenant.set_video_finish_tier_state"]);
  });
});

// cp#136 criterion 3: the route that can put a live studio into the tier-ABSENT state.
describe("POST /api/admin/tenants/:id/video-finish-binding (cp#136)", () => {
  const admin = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${ADMIN_TOKEN}`, ...extra });
  const call = (body: unknown, id = "ten_abc123", d: ControlPlaneDeps = deps) =>
    handle(jsonReq(`/api/admin/tenants/${id}/video-finish-binding`, body, { headers: admin() }), env(), ctx, d);

  async function existingTenant(): Promise<Tenant> {
    const t = await store.createTenant("ten_abc123", "hero", "acct_1", "live");
    t.live_at = "t0";
    t.script_name = "tenant-hero-studio";
    t.studio_release = "v1.9.0";
    return t;
  }

  it("REFUSES without the admin token", async () => {
    await existingTenant();
    const res = await handle(jsonReq("/api/admin/tenants/ten_abc123/video-finish-binding", { attached: false }), env(), ctx, deps);
    expect(res.status).toBe(401);
    expect(wiring.detachStudioBinding).not.toHaveBeenCalled();
  });

  it("refuses 503 without provisioner wiring, and 404s an unknown tenant", async () => {
    await existingTenant();
    expect((await call({ attached: false }, "ten_abc123", { ...deps, provisioner: undefined })).status).toBe(503);
    expect((await call({ attached: false }, "ten_nope")).status).toBe(404);
    expect(wiring.detachStudioBinding).not.toHaveBeenCalled();
  });

  it("400s a body that does not state a direction", async () => {
    await existingTenant();
    expect((await call({})).status).toBe(400);
    expect((await call({ attached: "no" })).status).toBe(400);
    expect(wiring.detachStudioBinding).not.toHaveBeenCalled();
  });

  it("DETACHES on attached:false, and never calls the attach path", async () => {
    await existingTenant();
    const res = await call({ attached: false });
    expect(res.status).toBe(200);
    expect(wiring.detachStudioBinding).toHaveBeenCalledTimes(1);
    // The direction must not be mixed up: an attach here would put the tier back on.
    expect(wiring.refreshStudioBindings).not.toHaveBeenCalled();
    expect(store.audit.map((a) => a.action)).toEqual(["tenant.detach_video_finish_binding"]);
  });

  it("ATTACHES through the EXISTING cp#112 path on attached:true, not a second implementation", async () => {
    // This is what makes "reattach restores exactly what a refresh produces" true by identity.
    await existingTenant();
    const res = await call({ attached: true });
    expect(res.status).toBe(200);
    expect(wiring.refreshStudioBindings).toHaveBeenCalledTimes(1);
    expect(wiring.detachStudioBinding).not.toHaveBeenCalled();
    expect(store.audit.map((a) => a.action)).toEqual(["tenant.attach_video_finish_binding"]);
  });

  it("REFUSES while a job holds a live lease, in BOTH directions", async () => {
    await existingTenant();
    const running = await store.createProvisionJob("job_running", "ten_abc123", "provision");
    running.status = "running";
    running.lease_until = new Date(deps.now() + 60_000).toISOString().replace("T", " ").slice(0, 19);

    expect((await call({ attached: false })).status).toBe(409);
    expect((await call({ attached: true })).status).toBe(409);
    expect(wiring.detachStudioBinding).not.toHaveBeenCalled();
    expect(wiring.refreshStudioBindings).not.toHaveBeenCalled();
  });

  it("passes a REFUSAL through with its own code, having audited nothing", async () => {
    await existingTenant();
    wiring.detachStudioBinding = vi.fn(async () => ({
      ok: false,
      refusal: { code: "video_finish_declared", status: 409, message: "one truth at a time" },
    }));
    const res = await call({ attached: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "video_finish_declared", message: "one truth at a time" });
    expect(store.audit).toEqual([]);
  });

  it("answers 409, not 200, when the readback says the tier is still there", async () => {
    await existingTenant();
    wiring.detachStudioBinding = vi.fn(async () => ({
      ok: true,
      result: { ...CLEAN_DETACH, ok: false, bindings_after: ["ASSETS", "DB", "VIDEO_FINISH_VPC"] },
    }));
    const res = await call({ attached: false });
    expect(res.status).toBe(409);
    expect((await res.json() as { ok: boolean }).ok).toBe(false);
    // Still audited: the attempt happened and the operator needs the record of it.
    expect(store.audit.map((a) => a.action)).toEqual(["tenant.detach_video_finish_binding"]);
  });
});

// ---- cp#137: rebuild a tenant's RunPod endpoints -------------------------------------------------
//
// The route is the thin half; the step machine and every custody rule live in
// tests/tenant-runpod-reprovision.test.ts. What is proved HERE is what only the router can get
// wrong: the gate, the confirmation, the key refusal, the writer interlock, the refusal passthrough,
// and -- the one that matters most -- that a failure records and returns a message with no
// credential in it.
describe("POST /api/admin/tenants/:id/reprovision-runpod (cp#137)", () => {
  const admin = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${ADMIN_TOKEN}`, ...extra });
  const KEY_A = "rpa_ROUTEKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const stamp = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

  const call = (
    body: Record<string, unknown> = { confirm_slug: "hero", runpod_api_key: KEY_A },
    id = "ten_abc123",
    d: ControlPlaneDeps = deps,
  ) => handle(jsonReq(`/api/admin/tenants/${id}/reprovision-runpod`, body, { headers: admin() }), env(), ctx, d);

  async function liveTenant(): Promise<Tenant> {
    const t = await store.createTenant("ten_abc123", "hero", "acct_1", "live");
    t.script_name = "tenant-hero-studio";
    t.modules_release = "v1.6.0";
    t.r2_bucket_name = "vivijure-tenant-hero";
    return t;
  }

  it("REFUSES without the admin token: this rebuilds someone else's render capacity", async () => {
    await liveTenant();
    const res = await handle(
      jsonReq("/api/admin/tenants/ten_abc123/reprovision-runpod", { confirm_slug: "hero", runpod_api_key: KEY_A }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(401);
    expect(wiring.reprovisionRunPod).not.toHaveBeenCalled();
  });

  it("refuses 503 when the plane has no provisioner wiring, rather than looking present", async () => {
    await liveTenant();
    const res = await call(undefined, "ten_abc123", { ...deps, provisioner: undefined });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "provisioner_unconfigured" });
  });

  it("404s an unknown tenant", async () => {
    expect((await call(undefined, "ten_nope")).status).toBe(404);
    expect(wiring.reprovisionRunPod).not.toHaveBeenCalled();
  });

  it("REFUSES a wrong or missing slug confirmation: the ids are opaque, the slug is not", async () => {
    await liveTenant();
    const wrong = await call({ confirm_slug: "hero-2", runpod_api_key: KEY_A });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "slug_confirmation_required", slug: "hero" });
    expect((await call({ runpod_api_key: KEY_A })).status).toBe(400);
    expect(wiring.reprovisionRunPod).not.toHaveBeenCalled();
  });

  it("REFUSES without key A, BEFORE anything can change state", async () => {
    await liveTenant();
    const res = await call({ confirm_slug: "hero" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "runpod_key_required" });
    // The refusal is upstream of the preflight, so nothing has even been read on the tenant's behalf.
    expect(wiring.preflightReprovisionRunPod).not.toHaveBeenCalled();
    expect(wiring.reprovisionRunPod).not.toHaveBeenCalled();
  });

  it("REFUSES while a job holds a live lease: this must not race an upload", async () => {
    await liveTenant();
    const running = await store.createProvisionJob("job_running", "ten_abc123", "provision");
    running.status = "running";
    running.lease_until = stamp(deps.now() + 60_000);

    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "job_in_progress", job_id: "job_running", kind: "provision" });
    expect(wiring.reprovisionRunPod).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: a dead lease does NOT block, or the guard would wedge the route forever", async () => {
    await liveTenant();
    const stale = await store.createProvisionJob("job_stale", "ten_abc123", "provision");
    stale.status = "running";
    stale.lease_until = stamp(deps.now() - 60_000);

    expect((await call()).status).toBe(200);
    expect(wiring.reprovisionRunPod).toHaveBeenCalledTimes(1);
  });

  it("passes a preflight refusal through with its own code and status, having written nothing", async () => {
    await liveTenant();
    wiring.preflightReprovisionRunPod = vi.fn(async () => ({
      ok: false,
      refusal: { code: "tenant_studio_not_serving", status: 422, message: "the tenant studio answered 503" },
    }));

    const res = await call();

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "tenant_studio_not_serving" });
    expect(wiring.reprovisionRunPod).not.toHaveBeenCalled();
    // A refusal is not an action: nothing is audited, because nothing happened.
    expect(store.audit).toEqual([]);
  });

  it("hands key A to the runner and keeps it out of the audit row", async () => {
    await liveTenant();

    const res = await call();

    expect(res.status).toBe(200);
    // The key reaches the runner as an ARGUMENT and lives nowhere else.
    expect(wiring.reprovisionRunPod).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ten_abc123" }),
      expect.objectContaining({ script: "tenant-hero-studio" }),
      KEY_A,
    );
    const audit = JSON.stringify(store.audit);
    // CONTROL FIRST: the audit row exists and carries the ids, so "no key in the audit" is not an
    // assertion about an empty table.
    expect(audit).toContain("tenant.reprovision_runpod");
    expect(audit).toContain("new-backend");
    expect(audit).toContain("fresh-token-id");
    expect(audit).not.toContain(KEY_A);
  });

  it("answers with the new ids and the honest status, and no summary boolean (cp#20)", async () => {
    await liveTenant();

    const body = (await (await call()).json()) as Record<string, unknown>;

    expect(body.status).toBe("awaiting_invoke_key");
    expect(body.endpoints_after).toEqual(CLEAN_REBUILD.endpoints_after);
    expect(body.next_step).toContain("new-backend");
    // No `ok`: a caller branches on status and on the ids, never on a summary flag that reads as
    // success while the tenant cannot render (cp#20).
    expect("ok" in body).toBe(false);
  });

  it("turns a rebuild failure into a 409 naming the step, with a message carrying no credential", async () => {
    await liveTenant();
    // The module already scrubs; the route must not re-introduce the value by reporting something
    // else. This asserts the ROUTE's half of that contract.
    wiring.reprovisionRunPod = vi.fn(async () => {
      throw new ReprovisionError("runpod_endpoints", 'endpoints.create: 401 {"authorization":"Bearer [redacted]"}');
    });

    const res = await call();

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "reprovision_failed", step: "runpod_endpoints" });
    expect(String(body.message)).toContain("[redacted]");
    expect(String(body.message)).not.toContain(KEY_A);
    // The failure is AUDITED, not swallowed: an operator reading the log has to see the attempt.
    const audit = JSON.stringify(store.audit);
    expect(audit).toContain("tenant.reprovision_runpod.failed");
    expect(audit).not.toContain(KEY_A);
  });
});
