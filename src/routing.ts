// Tenant hostname routing (#55, epic #40).
//
// Two kinds of hostname land on this Worker:
//   studio.vivijure.com            -> the front door (signup / account / admin). Owned by #52.
//   <slug>.studio.vivijure.com     -> that tenant`s own studio: a user Worker in the WfP tenant
//                                     dispatch namespace (spec section 2, studio-instance-per-tenant).
//
// The tenant leg is checked FIRST in the router: a request to a tenant hostname is never a
// control-plane API call, and must not be evaluated against control-plane auth.
//
// PARITY (Conrad ruling 2026-07-17, absolute): the hosted door ships AGPL and anyone may run a
// competing hosted vivijure, so no hostname is hardcoded -- everything derives from CONTROL_PLANE_HOST
// are deploy-injected. A `vivijure.com` literal here would make that structurally impossible.
//
// ONE DEFINITION, consumed not duplicated: slug rules come from ./tenants (validateSlug), the tenant
// record and its lookup come from ./store (getTenantBySlug). This module owns hostnames only.

import { resolveSession, SESSION_COOKIE } from "./auth";
import type { ControlPlaneDeps } from "./deps";
import type { ControlPlaneEnv } from "./env";
import { publicOrigin, tenantDomainSuffix } from "./env";
import type { Tenant } from "./store";
import { validateSlug } from "./tenants";
import { decryptStudioToken } from "./token-crypto";

export type HostRoute =
  /** Not a tenant hostname. The control-plane router owns it (front door, and localhost in dev). */
  | { kind: "front-door" }
  | { kind: "tenant"; slug: string }
  /** Under the tenant domain but not a usable tenant hostname. Refused; never a front-door page. */
  | { kind: "invalid-tenant"; reason: string };

/** Host headers carry a port, vary in case, and may carry the root-zone trailing dot. */
function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().split(":")[0].replace(/\.$/, "");
}

/**
 * Classify an inbound Host header against the tenant domain suffix.
 *
 * The default is FRONT DOOR, not refusal, and that is deliberate. This Worker is legitimately
 * reached on hostnames that are neither the front door nor a tenant: `wrangler dev` serves it on
 * 127.0.0.1, and its own tests drive it on an arbitrary host. Refusing every unrecognized host would
 * 404 the entire control plane off its own dev server. Only the TENANT domain is ours to police.
 *
 * Deliberately strict about multi-label hosts. A wildcard certificate covers exactly ONE label, but
 * a Cloudflare route pattern `*` matches ACROSS dots -- so `a.b.<suffix>` can reach this Worker while
 * being outside the certificate. Refused explicitly rather than left to a confusing dispatch miss.
 */
export function classifyHost(hostHeader: string | null, tenantSuffix: string): HostRoute {
  if (!hostHeader) return { kind: "front-door" };
  const host = normalizeHost(hostHeader);

  const suffix = tenantSuffix.trim().toLowerCase().replace(/\.$/, "");
  // Unset/malformed suffix: tenant routing is not configured, so nothing is a tenant. The front
  // door still serves; the misconfiguration shows up as tenants 404ing on the control-plane router
  // rather than as a Worker that refuses everything.
  if (!suffix.startsWith(".") || suffix.length < 2) return { kind: "front-door" };
  if (!host.endsWith(suffix)) return { kind: "front-door" };

  const label = host.slice(0, host.length - suffix.length);
  if (!label) return { kind: "invalid-tenant", reason: "empty tenant label" };
  if (label.includes(".")) {
    return { kind: "invalid-tenant", reason: "multi-label host is not certificate-covered" };
  }
  // The SAME rule signup enforces. If these two ever disagree, a tenant provisions at a hostname it
  // can never be reached at -- which is exactly why the rule lives in one place (tenants.ts).
  if (!validateSlug(label).ok) return { kind: "invalid-tenant", reason: "invalid tenant slug" };

  return { kind: "tenant", slug: label };
}

function refusal(status: number, message: string, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

/**
 * Mint a FRESH Request for the dispatched user Worker.
 *
 * Load-bearing: forwarding the inbound Request object verbatim into a dispatched Worker fails with
 * Cloudflare error 1042 (proven live in the section-9 spike -- the first dispatch 500`d on exactly
 * this; the fresh-Request retry went green).
 *
 * `duplex: "half"` is REQUIRED by the fetch spec whenever a stream body is sent. workerd is lenient
 * and ignores it, but a spec-strict runtime (undici -- the Node host path this repo also targets,
 * and our vitest env) THROWS without it, which would break every POST through the dispatcher, i.e.
 * every render submit. Not in @cloudflare/workers-types RequestInit yet, hence the cast.
 */
export function freshRequest(request: Request): Request {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: new Headers(request.headers),
    redirect: "manual",
  };
  if (hasBody) {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(request.url, init as RequestInit);
}

function wantsHtml(request: Request): boolean {
  return request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
}

/**
 * A dispatch Request with the control-plane session cookie STRIPPED and (for the owner) the tenant
 * studio token injected as a Bearer. The tenant worker never sees a control-plane credential; its
 * auth is exactly the injected token. Same fresh-Request/duplex handling as freshRequest (the 1042
 * fix), plus the cookie strip and header injection.
 */
export function dispatchRequest(request: Request, injectedToken: string | null): Request {
  const headers = new Headers(request.headers);
  stripSessionCookie(headers);
  if (injectedToken) headers.set("authorization", `Bearer ${injectedToken}`);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, redirect: "manual" };
  if (hasBody) {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(request.url, init as RequestInit);
}

function stripSessionCookie(headers: Headers): void {
  const raw = headers.get("cookie");
  if (!raw) return;
  const kept = raw
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${SESSION_COOKIE}=`));
  if (kept.length) headers.set("cookie", kept.join("; "));
  else headers.delete("cookie");
}

/**
 * Map a tenant record to a refusal, or null when it should be dispatched.
 *
 * SUSPENSION IS CHECKED FIRST AND OFF THE LIFECYCLE. `suspended_at` is an orthogonal axis: the
 * store never writes "suspended" into `status` (see store.ts -- two independent facts, two
 * independent columns). Reading suspension off `status` here would mean the kill switch NEVER
 * fires, because that value is never stored.
 */
export function tenantRefusal(tenant: Tenant): Response | null {
  if (tenant.deleted_at !== null) return refusal(404, "No studio at this address.");
  if (tenant.suspended_at !== null) {
    return refusal(403, "This studio is suspended. Contact support.");
  }
  switch (tenant.status) {
    case "live":
      return null;
    case "pending":
    case "provisioning":
    case "awaiting_invoke_key":
      return refusal(503, "This studio is still being set up.", { "retry-after": "30" });
    case "failed":
      return refusal(503, "This studio failed to finish provisioning.");
    case "deleting":
    case "deleted":
      return refusal(404, "No studio at this address.");
  }
}

/**
 * Route one request by hostname. Returns null for the front door so #52`s router owns its own
 * surface; returns a Response for every tenant-hostname outcome.
 */
export async function routeTenantRequest(
  request: Request,
  env: ControlPlaneEnv,
  deps: ControlPlaneDeps,
): Promise<Response | null> {
  const route = classifyHost(request.headers.get("host"), tenantDomainSuffix(env));
  if (route.kind === "front-door") return null;
  if (route.kind === "invalid-tenant") return refusal(404, "No studio at this address.");

  // FAIL CLOSED on a broken lookup. If the control-plane store is unreachable we cannot know
  // whether this tenant is SUSPENDED, and dispatching on "probably fine" would walk a suspended
  // studio straight past the kill switch during a D1 blip. Same posture as the studio's money path.
  let tenant: Tenant | null;
  try {
    tenant = await deps.store.getTenantBySlug(route.slug);
  } catch {
    return refusal(503, "This studio is temporarily unavailable.", { "retry-after": "5" });
  }
  if (!tenant) return refusal(404, "No studio at this address.");

  const refused = tenantRefusal(tenant);
  if (refused) return refused;

  // Live, not suspended -- but the Worker still has to exist. Honest failure over a silent empty
  // studio: a half-provisioned tenant must read as broken, never as an empty project list.
  if (!tenant.script_name) {
    return refusal(503, "This studio is not available yet.");
  }
  if (!env.TENANT_DISPATCH) {
    return refusal(503, "This studio is not available.");
  }

  // Dispatcher-injected auth (ruling 2026-07-18), decided BEFORE the dispatch stub is resolved so a
  // signed-out browser navigation is redirected to sign in and never touches the namespace. The
  // studio artifact is byte-identical to self-host and runs AUTH_MODE=token; the control plane --
  // the ONLY reader of its own session cookie, which it sees on every *.<host> request -- injects
  // the tenant studio token for the OWNER and strips its own cookie before the tenant worker runs.
  // Non-owners get no token: a browser navigation is bounced to sign in, everything else falls to
  // the studio's own fail-closed 403.
  const account = await resolveSession(deps.store, request, deps.now());
  const isOwner = account !== null && account.id === tenant.account_id;

  let injectedToken: string | null = null;
  if (isOwner && env.STUDIO_TOKEN_KEK && tenant.studio_token_enc) {
    try {
      injectedToken = await decryptStudioToken(env.STUDIO_TOKEN_KEK, tenant.studio_token_enc);
    } catch {
      // A token we cannot decrypt is a misconfiguration, never an auth grant. Fall through with no
      // token; the studio's own fail-closed 403 answers rather than us guessing at access.
      injectedToken = null;
    }
  }

  if (!isOwner && wantsHtml(request)) {
    return Response.redirect(`${publicOrigin(env)}/`, 302);
  }

  let stub: Fetcher;
  try {
    stub = env.TENANT_DISPATCH.get(tenant.script_name);
  } catch {
    // The namespace has no such script: the control plane says live but the Worker is absent.
    return refusal(503, "This studio is not available.");
  }

  return await stub.fetch(dispatchRequest(request, injectedToken));
}
