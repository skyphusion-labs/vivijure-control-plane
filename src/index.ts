// The vivijure platform control plane (#52, epic #40).
//
// A SEPARATE Worker from the studio, deploying independently (the MCP Worker precedent). It owns
// accounts, auth, the AUP gate, tenant records, and the admin switches. It owns NO tenant studio
// data: each tenant's projects/renders/cast live in that tenant's own D1, behind their own studio.
//
// PARITY (permanent ruling): this control plane ships AGPL in this repo like everything else, and
// it provisions the PUBLISHED studio release unmodified. There is no hosted fork of the studio to
// drift from self-host, which is what makes same-time parity a property of the architecture rather
// than a promise someone has to keep.
//
// SCOPE NOTE, deliberate and stated rather than implied: #52 is the skeleton. The provision routes
// create real tenant and job rows and enforce the real gates, but the job RUNNER (D1/R2/WfP/RunPod
// steps) lands in #53/#54. A tenant created today therefore parks at status "pending" with a
// "queued" job until that runner ships. Nothing here claims otherwise to the caller.

import { acceptAup, fetchAupSha256, hasAcceptedCurrent, isAupExempt } from "./aup";
import {
  clearedSessionCookie,
  endSession,
  isAdmin,
  looksLikeEmail,
  normalizeEmail,
  redeemMagicLink,
  resolveSession,
  sendMagicLink,
  sessionCookie,
  sessionCookieDomain,
  startSession,
  upsertAccountForVerifiedEmail,
} from "./auth";
import { bearerFrom, newId } from "./crypto";
import type { ControlPlaneDeps } from "./deps";
import { productionDeps } from "./deps";
import type { ControlPlaneEnv } from "./env";
import { publicOrigin, tenantDomainSuffix } from "./env";
import { authorizeUrl, configuredProviders, exchangeCode, isSsoProvider } from "./oauth";
import { routeTenantRequest } from "./routing";
import { verifyInvokeKeyScope } from "./runpod-invoke-key";
import type { Account, Tenant, ProvisionJob } from "./store";
import { slugRejectionMessage, tenantEndpointIds, tenantView, validateSlug } from "./tenants";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const err = (error: string, status: number, extra: Record<string, unknown> = {}): Response =>
  json({ error, ...extra }, status);

export default {
  async fetch(request: Request, env: ControlPlaneEnv, ctx: ExecutionContext): Promise<Response> {
    return await handle(request, env, ctx, productionDeps(env));
  },
};

/** Exported for tests: the same router production takes, with the dep bundle swapped. */
export async function handle(
  request: Request,
  env: ControlPlaneEnv,
  ctx: ExecutionContext,
  deps: ControlPlaneDeps,
): Promise<Response> {
  // The tenant leg runs FIRST (#55). A request to <slug><TENANT_DOMAIN_SUFFIX> is that tenant's own
  // studio, never a control-plane API call, so it must not be evaluated against anything below --
  // in particular the CSRF check, which compares Origin to PUBLIC_ORIGIN. A tenant's own POST
  // legitimately carries ITS OWN origin, so checking that first would 403 every render submit.
  const tenantResponse = await routeTenantRequest(request, env, deps);
  if (tenantResponse) return tenantResponse;

  const url = new URL(request.url);
  const path = url.pathname;

  // CSRF: a state-changing request must come from our own origin. The SSO and magic-link callbacks
  // are GETs (not state-changing in this sense) and carry their own single-use state/token guard.
  if (request.method !== "GET" && request.method !== "HEAD" && path.startsWith("/api/")) {
    const origin = request.headers.get("origin");
    if (origin && origin !== publicOrigin(env)) return err("bad_origin", 403);
  }

  try {
    // ---- public ----
    if (request.method === "GET" && path === "/api/platform/config") {
      return json({
        signups_enabled: (await deps.store.getSetting("signups_enabled")) !== "false",
        aup_version: env.AUP_VERSION,
        // Projected from what is actually configured, never hardcoded. Joan renders from this.
        auth_methods: ["email", ...configuredProviders(env)],
      });
    }

    if (request.method === "GET" && path === "/api/aup/current") {
      // sha256 of the served bytes travels with the label so the front door can show, and later
      // prove, exactly what it put in front of someone.
      return json({
        version: env.AUP_VERSION,
        url: env.AUP_URL,
        sha256: await fetchAupSha256(env.AUP_URL, deps.fetch),
      });
    }

    // ---- auth ----
    if (request.method === "POST" && path === "/api/auth/email/start") {
      return await emailStart(request, env, ctx, deps);
    }

    if (request.method === "GET" && path === "/auth/email/callback") {
      const token = url.searchParams.get("token") ?? "";
      if (!token) return redirectTo(env, "/?error=link_invalid");
      const signupsEnabled = (await deps.store.getSetting("signups_enabled")) !== "false";
      const result = await redeemMagicLink(deps.store, token, signupsEnabled, deps.now());
      if (!result.ok) {
        return redirectTo(env, result.reason === "signups_closed" ? "/?error=signups_closed" : "/?error=link_invalid");
      }
      const { token: sessionToken, maxAge } = await startSession(deps.store, result.account.id, deps.now());
      return redirectTo(env, "/", { "set-cookie": sessionCookie(sessionToken, maxAge, sessionCookieDomain(env.CONTROL_PLANE_HOST)) });
    }

    const ssoStart = /^\/auth\/([a-z]+)\/start$/.exec(path);
    if (request.method === "GET" && ssoStart) return await beginSso(ssoStart[1], url, env, deps);

    const ssoCallback = /^\/auth\/([a-z]+)\/callback$/.exec(path);
    if (request.method === "GET" && ssoCallback) return await finishSso(ssoCallback[1], url, env, deps);

    if (request.method === "POST" && path === "/api/auth/logout") {
      await endSession(deps.store, request, deps.now());
      return new Response(null, { status: 204, headers: { "set-cookie": clearedSessionCookie(sessionCookieDomain(env.CONTROL_PLANE_HOST)) } });
    }

    // ---- admin (bearer, not session) ----
    if (path.startsWith("/api/admin/")) return await adminRoutes(request, env, deps, path, url);

    // ---- everything below needs a session ----
    if (path.startsWith("/api/")) {
      const account = await resolveSession(deps.store, request, deps.now());
      if (!account) return err("unauthorized", 401);

      if (request.method === "GET" && path === "/api/me") return await me(env, deps, account);

      if (request.method === "POST" && path === "/api/aup/accept") {
        const body = (await readJson(request)) as { version?: string } | null;
        const result = await acceptAup(
          deps.store,
          account.id,
          String(body?.version ?? ""),
          env.AUP_VERSION,
          request,
          await fetchAupSha256(env.AUP_URL, deps.fetch),
        );
        if (!result.ok) {
          // 409 for a stale version (reload and re-read); 503 when WE cannot pin the text, because
          // that is our failure, not the tenant's, and it must be loud rather than silently absent.
          return result.error === "aup_unverifiable"
            ? err(result.error, 503, { message: "we could not verify the policy text; nothing was recorded" })
            : err(result.error, 409, { current: result.current });
        }
        return new Response(null, { status: 204 });
      }

      // The blocking AUP gate. Everything past this point requires acceptance of the CURRENT
      // version, so no tenant can be provisioned by an account that has not accepted it.
      if (!isAupExempt(path) && !(await hasAcceptedCurrent(deps.store, account.id, env.AUP_VERSION))) {
        return err("aup_required", 403, { version: env.AUP_VERSION });
      }

      return await tenantRoutes(request, env, ctx, deps, path, url, account);
    }

    // ---- the front-door UI (Joan) ----
    return await env.ASSETS.fetch(request);
  } catch (e) {
    // Honest failure: log the real error, return a stable shape. Never leak internals to a client.
    console.error("control-plane unhandled error", { path, error: String(e) });
    return err("internal_error", 500);
  }
}

// ---- handlers -------------------------------------------------------------------------------

async function emailStart(
  request: Request,
  env: ControlPlaneEnv,
  ctx: ExecutionContext,
  deps: ControlPlaneDeps,
): Promise<Response> {
  const body = (await readJson(request)) as { email?: string } | null;
  const email = normalizeEmail(String(body?.email ?? ""));

  // 202 ALWAYS, for every outcome below: unknown address, signups off, malformed input, a postern
  // failure. The response must not distinguish "account exists" from "does not", or it becomes an
  // account-enumeration oracle. The cost is that a typo looks like success; the mail not arriving
  // is the user-visible signal, which is the standard tradeoff.
  const accepted = () => json({ ok: true }, 202);

  if (!looksLikeEmail(email)) return accepted();

  if (env.CP_RATE_LIMIT) {
    // The send door is an outbound-email amplifier: without a limit, anyone can make us mail anyone.
    const { success } = await env.CP_RATE_LIMIT.limit({ key: `email-start:${email}` });
    if (!success) return accepted();
  }

  const signupsEnabled = (await deps.store.getSetting("signups_enabled")) !== "false";
  const existing = await deps.store.getAccountByEmail(email);
  // Signups-off closes the door to NEW accounts only; it never locks out people who already have one.
  if (!existing && !signupsEnabled) return accepted();
  if (existing?.suspended_at || existing?.deleted_at) return accepted();

  // Fire-and-forget so the response timing does not vary with whether an account exists (another
  // enumeration side channel), and so a slow postern cannot hang the request.
  ctx.waitUntil(
    sendMagicLink(deps.store, deps.mailer, publicOrigin(env), email, deps.now()).catch((e: unknown) => {
      console.error("magic-link send failed", { error: String(e) });
    }),
  );
  return accepted();
}

async function beginSso(
  provider: string,
  url: URL,
  env: ControlPlaneEnv,
  deps: ControlPlaneDeps,
): Promise<Response> {
  if (!isSsoProvider(provider) || !configuredProviders(env).includes(provider)) {
    return err("unknown_provider", 404);
  }
  const redirectToParam = url.searchParams.get("redirect_to");
  // Only same-origin relative paths: an open redirector on the auth flow is a phishing primitive.
  const redirectTo = redirectToParam && redirectToParam.startsWith("/") && !redirectToParam.startsWith("//")
    ? redirectToParam
    : null;

  const { url: authUrl, state, verifier } = await authorizeUrl(env, provider, redirectTo);
  await deps.store.createOAuthState({
    state,
    provider,
    verifier,
    redirect_to: redirectTo,
    expires_at: new Date(deps.now() + 10 * 60 * 1000).toISOString(),
  });
  return Response.redirect(authUrl, 302);
}

async function finishSso(
  provider: string,
  url: URL,
  env: ControlPlaneEnv,
  deps: ControlPlaneDeps,
): Promise<Response> {
  if (!isSsoProvider(provider) || !configuredProviders(env).includes(provider)) {
    return err("unknown_provider", 404);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return redirectTo(env, "/?error=sso_failed");

  // Single-use state: consumed atomically, so a replayed callback finds nothing and cannot bind a
  // second session. This is also the CSRF guard for the whole SSO round trip.
  const stateRow = await deps.store.consumeOAuthState(state, new Date(deps.now()).toISOString());
  if (!stateRow || stateRow.provider !== provider) return redirectTo(env, "/?error=sso_failed");

  const identity = await exchangeCode(env, provider, code, stateRow.verifier, deps.fetch);
  // Null here means the provider would not vouch for a verified email. Refuse; never fall back to
  // an unverified address.
  if (!identity) return redirectTo(env, "/?error=sso_unverified_email");

  // Signups-off must close the SSO door to NEW accounts too, or it is not a switch at all. Decided
  // before creation, so a closed signup leaves nothing behind.
  const signupsEnabled = (await deps.store.getSetting("signups_enabled")) !== "false";
  const result = await upsertAccountForVerifiedEmail(
    deps.store,
    identity.provider,
    identity.subject,
    identity.email,
    signupsEnabled,
  );
  if (!result.ok) {
    return redirectTo(env, result.reason === "signups_closed" ? "/?error=signups_closed" : "/?error=account_unavailable");
  }
  const account = result.account;

  const { token, maxAge } = await startSession(deps.store, account.id, deps.now());
  return redirectTo(env, stateRow.redirect_to ?? "/", { "set-cookie": sessionCookie(token, maxAge, sessionCookieDomain(env.CONTROL_PLANE_HOST)) });
}

async function me(env: ControlPlaneEnv, deps: ControlPlaneDeps, account: Account): Promise<Response> {
  const tenant = await deps.store.getTenantForAccount(account.id);
  return json({
    account: { id: account.id, email: account.email, created_at: account.created_at },
    aup: {
      required_version: env.AUP_VERSION,
      accepted: await hasAcceptedCurrent(deps.store, account.id, env.AUP_VERSION),
    },
    tenant: tenant ? tenantView(tenant, tenantDomainSuffix(env)) : null,
  });
}

async function tenantRoutes(
  request: Request,
  env: ControlPlaneEnv,
  ctx: ExecutionContext,
  deps: ControlPlaneDeps,
  path: string,
  url: URL,
  account: Account,
): Promise<Response> {
  if (request.method === "GET" && path === "/api/tenant/slug-available") {
    const slug = (url.searchParams.get("slug") ?? "").toLowerCase();
    const valid = validateSlug(slug);
    if (!valid.ok) return json({ available: false, reason: slugRejectionMessage(valid.reason) });
    const taken = await deps.store.getTenantBySlug(slug);
    return json(taken ? { available: false, reason: "that name is taken" } : { available: true });
  }

  if (request.method === "POST" && path === "/api/tenant/provision") {
    return await provision(request, ctx, deps, account);
  }

  const scoped = /^\/api\/tenant\/(ten_[a-f0-9]+)(?:\/([a-z-]+))?$/.exec(path);
  if (scoped) {
    const tenant = await deps.store.getTenantById(scoped[1]);
    // 404 rather than 403 on someone else's tenant: an authorization error that confirms existence
    // is an enumeration oracle.
    if (!tenant || tenant.account_id !== account.id) return err("not_found", 404);
    const action = scoped[2];

    if (request.method === "GET" && action === "job") {
      let job = await deps.store.getLatestJobForTenant(tenant.id);
      if (!job) return err("not_found", 404);
      // The poll IS the engine (#112). A provision cannot fit in one invocation's budget, so each
      // poll drives the job a little further under its own fresh waitUntil, and the client's normal
      // polling cadence walks it to completion. Two things guard this:
      //   - a stale job (no progress for MAX_JOB_AGE) is declared lost instead of driven forever;
      //   - only the poll that WINS the lease drives, so overlapping polls cannot double-mint.
      const driven = await driveJobIfNeeded(ctx, deps, tenant, job);
      if (driven) job = driven;
      return json({
        status: job.status,
        step: job.step,
        steps_done: JSON.parse(job.steps_done) as string[],
        // The REAL step error, verbatim. If RunPod says the worker quota is 10 and we need 12, the
        // tenant reads exactly that, not "provisioning failed".
        error_step: job.error_step,
        error_message: job.error_message,
      });
    }

    if (request.method === "POST" && action === "invoke-key") {
      return await installInvokeKey(request, deps, tenant);
    }
  }

  return err("not_found", 404);
}

/**
 * How long a job may show no progress before we call the driver lost (#112).
 *
 * Comfortably above the slowest legitimate step (RunPod endpoint creation) and well below human
 * patience. A job past this is marked FAILED with an honest message, because an eternal "running"
 * is a lie of omission: the tenant can neither wait for it nor retry it.
 */
const MAX_JOB_STALE_MS = 10 * 60 * 1000;

/** One invocation's claim on a job. Matches the store's lease length. */
const JOB_CLAIM_SECONDS = 60;

/**
 * Drive a non-terminal job forward, or declare it lost. Returns the re-read job when it changed.
 *
 * CONCURRENCY, the part that is easy to get wrong: the client polls every few seconds, so several
 * polls are in flight around the same job. Without arbitration each one would start its own driver,
 * and two drivers running the provisioner concurrently would mint two R2 credentials, upload twice,
 * and race each other's writes. claimJob is a conditional UPDATE, so exactly one poll wins; every
 * other poll returns the current state and does nothing.
 */
async function driveJobIfNeeded(
  ctx: ExecutionContext,
  deps: ControlPlaneDeps,
  tenant: Tenant,
  job: ProvisionJob,
): Promise<ProvisionJob | null> {
  if (job.status === "succeeded" || job.status === "failed") return null;
  if (!deps.provisioner) return null;

  // Lost driver: no progress for too long. Fail honestly rather than leave a spinner running.
  const lastProgress = Date.parse(`${job.updated_at.replace(" ", "T")}Z`);
  if (Number.isFinite(lastProgress) && Date.now() - lastProgress > MAX_JOB_STALE_MS) {
    await deps.store.finishJob(
      job.id,
      "failed",
      job.step,
      `invocation lost: no progress for over ${Math.round(MAX_JOB_STALE_MS / 60000)} minutes; ` +
        "the provision did not complete",
    );
    await deps.store.setTenantStatus(tenant.id, "failed");
    return await deps.store.getJob(job.id);
  }

  // Only the winner drives. A lost claim is the normal case for all but one concurrent poll.
  if (!(await deps.store.claimJob(job.id, JOB_CLAIM_SECONDS))) return null;

  const stepsDone = JSON.parse(job.steps_done) as string[];
  ctx.waitUntil(deps.provisioner.resume(job.id, tenant, stepsDone));
  return null;
}

async function provision(
  request: Request,
  ctx: ExecutionContext,
  deps: ControlPlaneDeps,
  account: Account,
): Promise<Response> {
  const body = (await readJson(request)) as { slug?: string; runpod_api_key?: string } | null;
  const slug = String(body?.slug ?? "").toLowerCase();

  const valid = validateSlug(slug);
  if (!valid.ok) return err("invalid_slug", 400, { message: slugRejectionMessage(valid.reason) });

  // PRODUCT RULING (2026-07-17): signups_enabled means "can NEW accounts be created", full stop.
  // The toggle aims at the front door, not at people already inside it: an existing, AUP-accepted
  // account mid-onboarding is never stranded by the admin closing signups. Provisioning therefore
  // gates on session + accepted AUP ONLY (both enforced upstream of this route).
  if (await deps.store.getTenantBySlug(slug)) return err("slug_taken", 409);
  if (await deps.store.getTenantForAccount(account.id)) return err("tenant_exists", 409);

  // The provisioning key is transient by ruling: it exists in this request and nowhere else. It is
  // never written to D1, never logged, and never held past the job. The runner consumes it from
  // the request that carries it; a failure IN the RunPod steps therefore cannot self-resume, and
  // the tenant re-pastes. That is the honest cost of never storing it.
  if (!body?.runpod_api_key) return err("runpod_key_required", 400);

  // Refuse BEFORE creating rows: a tenant parked on a job nothing will ever run is a lie with a
  // status page. Absence of the wiring is a deploy-config fact, and 503 is its honest shape.
  if (!deps.provisioner) return err("provisioner_unconfigured", 503);

  const tenant = await deps.store.createTenant(newId("ten"), slug, account.id, "pending");
  const job = await deps.store.createProvisionJob(newId("job"), tenant.id, "provision");
  // The runner records every outcome on the job row (honest failures, real step errors); waitUntil
  // keeps it going after this 202 returns. The key rides the call and dies with it.
  ctx.waitUntil(deps.provisioner.start(job.id, tenant, body.runpod_api_key));
  return json({ tenant_id: tenant.id, job_id: job.id }, 202);
}

async function installInvokeKey(
  request: Request,
  deps: ControlPlaneDeps,
  tenant: Tenant,
): Promise<Response> {
  const body = (await readJson(request)) as { runpod_invoke_key?: string } | null;
  const key = String(body?.runpod_invoke_key ?? "");
  if (!key) return err("invoke_key_required", 400);

  const endpoints = tenantEndpointIds(tenant);
  if (endpoints.length === 0) {
    return err("no_endpoints", 409, {
      message: "your endpoints have not been created yet; there is nothing to scope a key to",
    });
  }
  if (!tenant.script_name) {
    // Endpoints exist but the studio upload never completed: a failed provision. Installing a key
    // on a worker that is not there cannot succeed, and pretending otherwise strands the tenant.
    return err("not_provisioned", 409, {
      message: "your studio was not fully provisioned; retry provisioning before installing a key",
    });
  }

  // Same refusal as the provision route: absence of the wiring is a deploy-config fact.
  if (!deps.provisioner) return err("provisioner_unconfigured", 503);

  // Verify BEFORE storing. A wrong key is rejected with the real reason and never written; the most
  // dangerous wrong key is the powerful graphql one, which is exactly what this catches.
  const verdict = await verifyInvokeKeyScope(key, endpoints, deps.fetch);
  if (!verdict.ok) {
    return err("invoke_key_rejected", 400, { reason: verdict.reason, message: verdict.detail });
  }

  // The per-script secrets PUT (spike-proven: rotates in place, no re-upload). The key goes from
  // this request straight into the tenant worker secret; on any failure it is stored nowhere.
  await deps.provisioner.installInvokeKey(tenant, key);
  await deps.store.setTenantStatus(tenant.id, "live");
  return json({ ok: true, status: "live", verified_endpoints: verdict.inScope.length });
}

async function adminRoutes(
  request: Request,
  env: ControlPlaneEnv,
  deps: ControlPlaneDeps,
  path: string,
  url: URL,
): Promise<Response> {
  // Fails CLOSED when the secret is unset: no token configured means no admin surface, not an open one.
  if (!(await isAdmin(bearerFrom(request), env.CONTROL_PLANE_ADMIN_TOKEN))) {
    return err("unauthorized", 401);
  }
  const actor = "admin-token";

  if (request.method === "GET" && path === "/api/admin/tenants") {
    const tenants = await deps.store.listTenants({
      status: url.searchParams.get("status") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
    });
    return json({ tenants: tenants.map((t) => tenantView(t, tenantDomainSuffix(env))) });
  }

  if (request.method === "GET" && path === "/api/admin/settings") {
    return json({ signups_enabled: (await deps.store.getSetting("signups_enabled")) !== "false" });
  }

  if (request.method === "POST" && path === "/api/admin/settings") {
    const body = (await readJson(request)) as { signups_enabled?: boolean } | null;
    if (typeof body?.signups_enabled !== "boolean") return err("invalid_body", 400);
    const value = body.signups_enabled ? "true" : "false";
    await deps.store.setSetting("signups_enabled", value, actor);
    await deps.store.recordAdminAction(actor, "settings.set", "signups_enabled", value);
    return new Response(null, { status: 204 });
  }

  const suspend = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/(suspend|resume)$/.exec(path);
  if (request.method === "POST" && suspend) {
    const tenant = await deps.store.getTenantById(suspend[1]);
    if (!tenant) return err("not_found", 404);

    if (suspend[2] === "suspend") {
      const body = (await readJson(request)) as { reason?: string } | null;
      const reason = String(body?.reason ?? "").trim();
      // A suspend without a reason is un-auditable, and this is the kill switch.
      if (!reason) return err("reason_required", 400);
      await deps.store.suspendTenant(tenant.id, reason);
      await deps.store.recordAdminAction(actor, "tenant.suspend", tenant.id, reason);
    } else {
      if (tenant.suspended_at === null) return err("not_suspended", 409);
      // Clears the flag ONLY. The tenant returns to whatever it actually was; a never-provisioned
      // tenant must not come back "live" with a URL to a studio that does not exist.
      await deps.store.resumeTenant(tenant.id);
      await deps.store.recordAdminAction(actor, "tenant.resume", tenant.id, null);
    }
    return new Response(null, { status: 204 });
  }

  return err("not_found", 404);
}

// ---- helpers --------------------------------------------------------------------------------

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function redirectTo(env: ControlPlaneEnv, path: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location: `${publicOrigin(env)}${path}`, ...headers } });
}
