import { describe, expect, it, vi } from "vitest";
import {
  classifyHost,
  freshRequest,
  routeTenantRequest,
  tenantRefusal,
} from "../src/routing";
import type { ControlPlaneDeps } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import type { Tenant, TenantLifecycle } from "../src/store";
import { tenantScriptName, validateSlug } from "../src/tenants";
import { SESSION_COOKIE } from "../src/auth";
import { sha256Hex } from "../src/crypto";
import { encryptStudioToken } from "../src/token-crypto";

const SUFFIX = ".studio.vivijure.com";

function tenant(over: Partial<Tenant> = {}): Tenant {
  return {
    id: "tn_1",
    slug: "acme",
    account_id: "acct_1",
    status: "live",
    script_name: tenantScriptName("acme"),
    d1_database_id: "d1",
    r2_bucket_name: "b",
    endpoints_json: null,
    r2_token_id: null,
    studio_release: "1.0.0",
    studio_token_enc: null,
    created_at: "2026-07-17T00:00:00Z",
    live_at: "2026-07-17T00:00:00Z",
    suspended_at: null,
    suspended_reason: null,
    deleted_at: null,
    ...over,
  };
}

function depsWith(getTenantBySlug: (slug: string) => Promise<Tenant | null>): ControlPlaneDeps {
  return { store: { getTenantBySlug }, now: () => 0 } as unknown as ControlPlaneDeps;
}

function envWith(get: (name: string) => Fetcher): ControlPlaneEnv {
  return {
    // Single source (vars ruling): the suffix is DERIVED from the host, not set beside it.
    CONTROL_PLANE_HOST: SUFFIX.replace(/^\./, ""),
    TENANT_DISPATCH: { get } as unknown as DispatchNamespace,
  } as unknown as ControlPlaneEnv;
}

function req(host: string, init?: RequestInit): Request {
  return new Request(`https://${host}/api/projects`, { headers: { host }, ...init });
}

describe("classifyHost", () => {
  it("extracts the tenant slug from the leftmost label", () => {
    expect(classifyHost(`acme${SUFFIX}`, SUFFIX)).toEqual({ kind: "tenant", slug: "acme" });
  });

  it("normalizes case, port, and the root-zone trailing dot", () => {
    expect(classifyHost("ACME.STUDIO.VIVIJURE.COM:443.", SUFFIX)).toEqual({
      kind: "tenant",
      slug: "acme",
    });
  });

  // The default is FRONT DOOR, not refusal. This Worker is legitimately reached on hostnames that
  // are neither the front door nor a tenant: wrangler dev serves it on 127.0.0.1, and the #52 suite
  // drives it on an arbitrary host. Refusing every unrecognized host 404s the control plane off its
  // own dev server -- caught by running the #52 suite against this fold, not by reasoning.
  it.each([
    ["studio.vivijure.com", "the front door itself"],
    ["127.0.0.1", "wrangler dev"],
    ["localhost", "wrangler dev"],
    ["evil.com", "someone else's zone, not ours to police"],
    [`acme${SUFFIX}.evil.com`, "suffix confusion: does not END with the suffix"],
  ])("treats non-tenant host %s as the front door (%s)", (host) => {
    expect(classifyHost(host, SUFFIX)).toEqual({ kind: "front-door" });
  });

  it("treats a missing host header as the front door", () => {
    expect(classifyHost(null, SUFFIX)).toEqual({ kind: "front-door" });
  });

  // Every guard watched refusing, not assumed. All of these sit UNDER the tenant suffix: they are
  // shaped like a tenant, so refusing is right -- a front-door page here would be a lie.
  it.each([
    [`a.b${SUFFIX}`, "multi-label, outside the ACM wildcard"],
    [`-bad${SUFFIX}`, "leading hyphen"],
    [`ab${SUFFIX}`, "under the 3-char minimum"],
    [`under_score${SUFFIX}`, "invalid character"],
    [`xn--80ak6aa92e${SUFFIX}`, "punycode homograph of the front door"],
    [`admin${SUFFIX}`, "reserved label"],
    [SUFFIX, "empty label"],
  ])("refuses %s (%s)", (host) => {
    expect(classifyHost(host, SUFFIX).kind).toBe("invalid-tenant");
  });

  it("routes to the front door when the tenant suffix is unset or malformed", () => {
    // Tenant routing is not configured, so nothing is a tenant. The misconfiguration surfaces as
    // tenants 404ing on the control-plane router, not as a Worker that refuses everything.
    expect(classifyHost(`acme${SUFFIX}`, "").kind).toBe("front-door");
    expect(classifyHost(`acme${SUFFIX}`, "studio.vivijure.com").kind).toBe("front-door");
  });

  it("agrees with the signup validator: ONE rule, not two", () => {
    // If these drift, a tenant provisions at a hostname it can never be reached at, or a reserved
    // label routes. That is why the rule lives once, in tenants.ts.
    for (const slug of ["acme", "globex", "a-b-c", "x1y2"]) {
      expect(validateSlug(slug).ok).toBe(true);
      expect(classifyHost(`${slug}${SUFFIX}`, SUFFIX)).toEqual({ kind: "tenant", slug });
    }
    for (const bad of ["admin", "xn--80ak6aa92e", "ab", "-bad"]) {
      expect(validateSlug(bad).ok).toBe(false);
      expect(classifyHost(`${bad}${SUFFIX}`, SUFFIX).kind).toBe("invalid-tenant");
    }
  });
});

describe("freshRequest", () => {
  // Guards the error-1042 lesson from the spike: never forward the inbound object.
  it("mints a NEW Request preserving url, method, and headers", () => {
    const inbound = req(`acme${SUFFIX}`, { method: "POST", body: "x" });
    const fresh = freshRequest(inbound);
    expect(fresh).not.toBe(inbound);
    expect(fresh.url).toBe(inbound.url);
    expect(fresh.method).toBe("POST");
    expect(fresh.headers.get("host")).toBe(`acme${SUFFIX}`);
  });

  it("carries no body on GET", () => {
    expect(freshRequest(req(`acme${SUFFIX}`)).body).toBeNull();
  });
});

describe("tenantRefusal -- suspension is OFF the lifecycle", () => {
  // The store never writes "suspended" into status (two independent facts, two columns). Reading
  // suspension off status would mean the kill switch never fires, because that value is never stored.
  it("403s a suspended tenant whose LIFECYCLE still reads live", () => {
    expect(tenantRefusal(tenant({ status: "live", suspended_at: "2026-07-17T00:00:00Z" }))?.status).toBe(403);
  });

  it("403s a suspended tenant at ANY lifecycle state", () => {
    const states: TenantLifecycle[] = ["pending", "provisioning", "awaiting_invoke_key", "live", "failed"];
    for (const status of states) {
      expect(tenantRefusal(tenant({ status, suspended_at: "2026-07-17T00:00:00Z" }))?.status).toBe(403);
    }
  });

  it("passes a live, unsuspended tenant through", () => {
    expect(tenantRefusal(tenant())).toBeNull();
  });

  it.each([
    ["pending", 503],
    ["provisioning", 503],
    ["awaiting_invoke_key", 503],
    ["failed", 503],
    ["deleting", 404],
    ["deleted", 404],
  ] as [TenantLifecycle, number][])("maps lifecycle %s -> %i", (status, expected) => {
    expect(tenantRefusal(tenant({ status }))?.status).toBe(expected);
  });

  it("404s a soft-deleted tenant even when the lifecycle reads live", () => {
    expect(tenantRefusal(tenant({ deleted_at: "2026-07-17T00:00:00Z" }))?.status).toBe(404);
  });
});

describe("routeTenantRequest", () => {
  it("dispatches a live tenant to ITS OWN script with a fresh Request", async () => {
    const inbound = req(`acme${SUFFIX}`);
    const fetch = vi.fn(async (_req: Request) => new Response("studio"));
    const get = vi.fn((_name: string) => ({ fetch }) as unknown as Fetcher);

    const res = await routeTenantRequest(inbound, envWith(get), depsWith(async () => tenant()));

    expect(get).toHaveBeenCalledWith("tenant-acme-studio");
    expect(await res!.text()).toBe("studio");
    expect(fetch.mock.calls[0][0]).not.toBe(inbound); // the 1042 guard
  });

  it("dispatches two distinct hostnames to two DISTINCT scripts", async () => {
    const get = vi.fn((_name: string) => ({ fetch: async () => new Response("ok") }) as unknown as Fetcher);
    const env = envWith(get);
    const deps = depsWith(async (slug) => tenant({ slug, script_name: tenantScriptName(slug) }));

    await routeTenantRequest(req(`acme${SUFFIX}`), env, deps);
    await routeTenantRequest(req(`globex${SUFFIX}`), env, deps);

    expect(get.mock.calls.map((c) => c[0])).toEqual(["tenant-acme-studio", "tenant-globex-studio"]);
  });

  it("returns null for the front door so the control plane owns it", async () => {
    const res = await routeTenantRequest(req("studio.vivijure.com"), envWith(vi.fn()), depsWith(async () => null));
    expect(res).toBeNull();
  });

  it("returns null on localhost so wrangler dev still serves the control plane", async () => {
    const res = await routeTenantRequest(req("127.0.0.1"), envWith(vi.fn()), depsWith(async () => null));
    expect(res).toBeNull();
  });

  it("404s an unknown tenant WITHOUT dispatching", async () => {
    const get = vi.fn();
    const res = await routeTenantRequest(req(`nobody${SUFFIX}`), envWith(get), depsWith(async () => null));
    expect(res!.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("403s a suspended tenant and never reaches the dispatch namespace", async () => {
    const get = vi.fn(() => ({ fetch: async () => new Response("SHOULD NOT BE REACHED") }) as unknown as Fetcher);
    const deps = depsWith(async () => tenant({ suspended_at: "2026-07-17T00:00:00Z" }));

    const res = await routeTenantRequest(req(`acme${SUFFIX}`), envWith(get), deps);

    expect(res!.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  it("503s live-but-script_name-null honestly (never a silent empty studio)", async () => {
    const get = vi.fn();
    const res = await routeTenantRequest(
      req(`acme${SUFFIX}`),
      envWith(get),
      depsWith(async () => tenant({ script_name: null })),
    );
    expect(res!.status).toBe(503);
    expect(get).not.toHaveBeenCalled();
  });

  it("503s when the script is missing from the namespace", async () => {
    const get = vi.fn(() => {
      throw new Error("script not found");
    });
    const res = await routeTenantRequest(req(`acme${SUFFIX}`), envWith(get), depsWith(async () => tenant()));
    expect(res!.status).toBe(503);
  });

  // FAIL CLOSED: if suspension state cannot be read, dispatching would walk a suspended studio
  // straight past the kill switch during a D1 blip.
  it("503s when the store throws, rather than dispatching an unverified tenant", async () => {
    const get = vi.fn(() => ({ fetch: async () => new Response("LEAKED PAST THE KILL SWITCH") }) as unknown as Fetcher);
    const deps = depsWith(async () => {
      throw new Error("D1 unreachable");
    });

    const res = await routeTenantRequest(req(`acme${SUFFIX}`), envWith(get), deps);

    expect(res!.status).toBe(503);
    expect(get).not.toHaveBeenCalled();
  });
});


const KEK = btoa("0123456789abcdef0123456789abcdef"); // 32 bytes -> valid AES-256 key

function injectEnv(get: (name: string) => Fetcher): ControlPlaneEnv {
  return {
    CONTROL_PLANE_HOST: SUFFIX.replace(/^\./, ""),
    TENANT_DISPATCH: { get } as unknown as DispatchNamespace,
    STUDIO_TOKEN_KEK: KEK,
  } as unknown as ControlPlaneEnv;
}

/** Deps whose session cookie <token> resolves to <accountId>; other tokens resolve to nothing. */
async function sessionDeps(t: Tenant, token: string, accountId: string): Promise<ControlPlaneDeps> {
  const hash = await sha256Hex(token);
  return {
    now: () => 0,
    store: {
      getTenantBySlug: async () => t,
      getSession: async (h: string) =>
        h === hash ? { token_hash: h, account_id: accountId, expires_at: "", revoked_at: null } : null,
      getAccountById: async (id: string) =>
        id === accountId
          ? { id, email: "o@x", created_at: "", suspended_at: null, suspended_reason: null, deleted_at: null }
          : null,
    },
  } as unknown as ControlPlaneDeps;
}

function reqCookie(host: string, cookie: string | null, accept?: string): Request {
  const headers: Record<string, string> = { host };
  if (cookie) headers.cookie = cookie;
  if (accept) headers.accept = accept;
  return new Request(`https://${host}/api/projects`, { headers });
}

describe("routeTenantRequest dispatcher-injected auth", () => {
  it("injects the tenant studio token as a Bearer for the OWNER and strips the CP session cookie", async () => {
    const enc = await encryptStudioToken(KEK, "rpa_studiotoken");
    const t = tenant({ account_id: "acct_owner", studio_token_enc: enc, script_name: tenantScriptName("acme") });
    let forwarded: Request | undefined;
    const get = vi.fn(
      () => ({ fetch: async (r: Request) => ((forwarded = r), new Response("ok")) }) as unknown as Fetcher,
    );
    const deps = await sessionDeps(t, "sess_owner", "acct_owner");

    await routeTenantRequest(reqCookie(`acme${SUFFIX}`, `${SESSION_COOKIE}=sess_owner`), injectEnv(get), deps);

    expect(forwarded!.headers.get("authorization")).toBe("Bearer rpa_studiotoken");
    expect(forwarded!.headers.get("cookie") ?? "").not.toContain(SESSION_COOKIE);
  });

  it("redirects a signed-out BROWSER navigation to sign in, without dispatching", async () => {
    const t = tenant({ account_id: "acct_owner", studio_token_enc: await encryptStudioToken(KEK, "rpa_x"), script_name: tenantScriptName("acme") });
    const get = vi.fn(() => ({ fetch: async () => new Response("SHOULD NOT REACH") }) as unknown as Fetcher);
    const deps = await sessionDeps(t, "sess_owner", "acct_owner");
    const res = await routeTenantRequest(reqCookie(`acme${SUFFIX}`, null, "text/html"), injectEnv(get), deps);
    expect(res!.status).toBe(302);
    expect(get).not.toHaveBeenCalled();
  });

  it("passes a signed-out NON-browser request through with NO token (studio's own 403 answers)", async () => {
    const t = tenant({ account_id: "acct_owner", studio_token_enc: await encryptStudioToken(KEK, "rpa_x"), script_name: tenantScriptName("acme") });
    let forwarded: Request | undefined;
    const get = vi.fn(
      () => ({ fetch: async (r: Request) => ((forwarded = r), new Response("passthru")) }) as unknown as Fetcher,
    );
    const deps = await sessionDeps(t, "sess_owner", "acct_owner");
    await routeTenantRequest(reqCookie(`acme${SUFFIX}`, null), injectEnv(get), deps);
    expect(forwarded!.headers.get("authorization")).toBeNull();
  });

  it("does NOT inject for a valid session that is NOT the tenant owner, and still strips the cookie", async () => {
    const t = tenant({ account_id: "acct_owner", studio_token_enc: await encryptStudioToken(KEK, "rpa_x"), script_name: tenantScriptName("acme") });
    let forwarded: Request | undefined;
    const get = vi.fn(
      () => ({ fetch: async (r: Request) => ((forwarded = r), new Response("ok")) }) as unknown as Fetcher,
    );
    const deps = await sessionDeps(t, "sess_stranger", "acct_stranger");
    await routeTenantRequest(reqCookie(`acme${SUFFIX}`, `${SESSION_COOKIE}=sess_stranger`), injectEnv(get), deps);
    expect(forwarded!.headers.get("authorization")).toBeNull();
    expect(forwarded!.headers.get("cookie") ?? "").not.toContain(SESSION_COOKIE);
  });
});
