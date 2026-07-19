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
import { RECLAIM_LEASE_SECONDS } from "./store";
import type { Account, Tenant, ProvisionJob, SmokeRender } from "./store";
import {
  advanceSmokeRender,
  resolveSmokeRenderBounds,
  sha256Hex,
  SMOKE_RENDER_COVERAGE,
  startSmokeRender,
} from "./smoke-render";
import { slugRejectionMessage, tenantEndpointIds, tenantView, validateSlug } from "./tenants";
import { TenantModuleError, type ModuleReadiness } from "./tenant-modules";
import { CONTROL_PLANE_VERSION } from "./version";

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

    // What is actually running. src/version.ts was referenced by nothing at runtime, so confirming a
    // release meant fetching a changed asset and reading the patched line off the wire -- archaeology,
    // not observability (cf#114d). Its OWN route rather than a field on /api/platform/config: that
    // route is a POLICY projection the front door renders from, with a UI contract and a different
    // audience; deploy identity is an operator/CI fact with different cache semantics, and folding it
    // in is how a config endpoint becomes a junk drawer. Unauthenticated, like the config route: the
    // version of an AGPL codebase whose tags are public is not a secret, and a version you must hold
    // a credential to read is useless to the monitoring that needs it most.
    if (request.method === "GET" && path === "/api/platform/version") {
      return json({ control_plane_version: CONTROL_PLANE_VERSION });
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
    if (path.startsWith("/api/admin/")) return await adminRoutes(request, env, deps, path, url, ctx);

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
    // Same classifier the provision path consults (cf#103). This route used to run its own
    // getTenantBySlug plus a hand-written reason, which under the slug tiers would have DISAGREED
    // with what provision actually does: the preview would say "taken" to an owner whose own Tier A
    // row is reclaimable, and say "available" for shapes provision refuses. A surface that claims
    // something the system will not honour is the cf#114 shape, so there is exactly ONE rule.
    const claim = await deps.store.checkSlugAvailability(slug, account.id);
    // PROJECTED, never returned raw. SlugClaim.reclaim carries live cloud resource ids
    // (d1_database_id, r2_bucket_name, r2_token_id, script_name). Those are internal handles of the
    // control plane and a browser has no use for them. The preview answers exactly two questions:
    // can I take this name, and if so is it fresh or my own unfinished studio.
    return json(
      claim.available
        ? { available: true, reclaimable: claim.reclaim !== null }
        : { available: false, reason: claim.reason },
    );
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
        // WHICH KIND OF JOB THIS IS (cp#43). Without it every other field here is ambiguous: a
        // "failed" with a step name reads identically whether a provision died or a module upgrade
        // did, and those have opposite recovery procedures (retry the provision vs re-run the
        // upgrade at from_release). It is also the field that makes the release pair below legible.
        kind: job.kind,
        status: job.status,
        step: job.step,
        steps_done: JSON.parse(job.steps_done) as string[],
        // The REAL step error, verbatim. If RunPod says the worker quota is 10 and we need 12, the
        // tenant reads exactly that, not "provisioning failed".
        error_step: job.error_step,
        error_message: job.error_message,
        // THE RELEASE PAIR (cp#43). 0006_module_upgrade.sql tells an operator facing a NULL
        // modules_release to "consult the job row", and until now that instruction pointed at a
        // table no route reported: the only way to learn the previous release was reading prod D1
        // with a separately minted credential, which is what a rehearsal actually had to do.
        //
        // from_release is the whole point. The upgrade NULLs tenants.modules_release before its
        // first upload, so after a partial failure THIS ROW is the only place the previous release
        // still exists, and re-running the upgrade at from_release IS the documented rollback.
        // Reporting to_release beside it makes the row read as an intent (R_old -> R_new) rather
        // than a bare target. NULL on every non-upgrade kind, which is honest rather than absent.
        from_release: job.from_release,
        to_release: job.to_release,
        // When it stopped. NULL while it is still running, which distinguishes "in flight" from
        // "finished and this is the terminal state" without inferring it from status.
        finished_at: job.finished_at,
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
  // cf#103. This check is ADVISORY and says so out loud: check-then-create is two steps, so two
  // concurrent provisions can both pass it. The UNIQUE constraint on tenants.slug is what actually
  // serializes them and createTenant below is the real gate. What the check buys is a LEGIBLE
  // refusal (which tier, in words the owner can act on) instead of a bare constraint violation.
  const claim = await deps.store.checkSlugAvailability(slug, account.id);
  if (!claim.available) return err("slug_taken", 409, { message: claim.reason });

  // EVERY CHEAP REFUSAL HAPPENS BEFORE ANYTHING DESTRUCTIVE. These two used to sit below, which was
  // harmless while provision only ever CREATED. The reclaim path below DELETES a customer half-built
  // studio, so discovering a missing key or an unconfigured provisioner after the teardown would
  // leave them strictly worse off than before they asked: resources gone, nothing provisioned, and
  // the refusal they should have got for free up front. Order is load-bearing, not stylistic.
  if (!body?.runpod_api_key) return err("runpod_key_required", 400);
  if (!deps.provisioner) return err("provisioner_unconfigured", 503);
  // A GRANTED RECLAIM CANNOT GO THROUGH THIS ROUTE, and that refusal is deliberate rather than a
  // gap. tenants.slug is UNIQUE, so createTenant on a reclaimable row is guaranteed to hit the
  // constraint; and the row can still carry a half-built D1, bucket, and R2 token that must be torn
  // down BEFORE the reclaim commits (the teardown-before-reclaim ruling), or we orphan cloud
  // resources nothing will ever reap. Both facts make reclaim a DIFFERENT operation from provision,
  // not a branch inside it. Until that path exists, refuse honestly and name the real situation.
  // ---- RECLAIM EXECUTION (cf#103, closes control-plane#18) --------------------------------------
  //
  // Retaking a Tier A row: never-live, owned by this account, half-built. It cannot go through
  // createTenant (tenants.slug is UNIQUE), and its leftover D1, bucket, token and worker must be
  // reaped or nothing ever will.
  //
  // THE ORDER IS THE WHOLE DESIGN, and it is not the obvious one:
  //   claimReclaim  -> teardown -> reclaimSlug
  //   (exclusivity)    (destroy)   (blank the columns)
  // Every tenant resource name derives from the SLUG, not from the attempt, so two concurrent
  // reclaims issue the SAME delete calls. Without the claim, attempt A teardown lands after attempt
  // B has provisioned fresh resources under those names and deletes them, silently, while B is
  // mid-provision. Serializing on the claim WRITE is what makes it safe to start deleting at all --
  // the loser never reaches teardown, so a lost race destroys nothing.
  if (claim.reclaim) {
    const claimed = await deps.store.claimReclaim(claim.reclaim.tenant_id, account.id, RECLAIM_LEASE_SECONDS);
    if (!claimed) {
      // We LOST, or the row stopped qualifying between the check and the write. Nothing has been
      // destroyed: this is the whole point of claiming before reaping.
      return err("slug_reclaim_in_progress", 409, {
        message:
          "that name is being reset right now. Give it a moment and try again; nothing has been " +
          "lost.",
      });
    }

    // Reap from the row the CLAIM returned, not from the earlier check handle. The claim is the
    // serialization point, so these are the authoritative ids; the check ran before we held
    // anything and its handle can already be stale.
    const reaped = await deps.provisioner.teardown(claimed.tenant, { deleteData: true });
    if (!reaped.ok) {
      // DO NOT COMPLETE. reclaimSlug blanks the resource columns, so completing now would erase the
      // only record of the resources we just failed to delete and nothing would ever reap them. The
      // row stays claimed until the lease expires, and the customer gets the real errors rather than
      // a cheerful retry prompt. An orphan we cannot see is worse than an error they can act on.
      console.error("reclaim.teardown_failed", {
        tenant: claimed.tenant.id,
        failures: reaped.failures,
      });
      return err("reclaim_teardown_failed", 409, {
        message:
          "some of the old studio pieces could not be removed, so the name has not been freed. " +
          "Nothing has been lost. Try again in a few minutes.",
        failures: reaped.failures,
      });
    }

    const reclaimed = await deps.store.reclaimSlug(claim.reclaim.tenant_id, account.id, claimed.lease_token);
    if (!reclaimed) {
      // THE TEARDOWN-OVERRUN BRANCH, and it is real rather than theoretical. reclaimSlug requires a
      // LIVE lease as well as the token, so a teardown that ran past RECLAIM_LEASE_SECONDS is
      // refused here even though our token still matches. That refusal is CORRECT: by now another
      // attempt may hold the row and be reaping it, and completing would blank the row underneath
      // them. We have already destroyed the old resources, so this must be loud -- it is the one
      // path where we did real work and cannot record it.
      console.error("reclaim.completion_refused", {
        tenant: claim.reclaim.tenant_id,
        reason: "lease expired or no longer held; teardown DID run",
      });
      return err("slug_reclaim_in_progress", 409, {
        message:
          "that name is being reset right now. Give it a moment and try again; nothing has been " +
          "lost.",
      });
    }

    // The row is ours, blanked, and back at pending -- same id, same slug. Provision continues on
    // THIS row: createTenant would hit the UNIQUE constraint, and a second row would orphan the
    // first. No getTenantForAccount check here: the reclaimed row IS this account tenant.
    const job = await deps.store.createProvisionJob(newId("job"), reclaimed.id, "provision");
    ctx.waitUntil(deps.provisioner.start(job.id, reclaimed, body.runpod_api_key));
    return json({ tenant_id: reclaimed.id, job_id: job.id, reclaimed: true }, 202);
  }

  if (await deps.store.getTenantForAccount(account.id)) return err("tenant_exists", 409);

  // The provisioning key is transient by ruling: it exists in this request and nowhere else. It is
  // never written to D1, never logged, and never held past the job. The runner consumes it from the
  // request that carries it; a failure IN the RunPod steps therefore cannot self-resume, and the
  // tenant re-pastes. Both this and the provisioner-configured refusal are asserted ABOVE, before
  // the reclaim path can destroy anything.

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
  // Installs the key AND proves the module workers actually serve it (cf#114). A throw here leaves
  // the tenant at awaiting_invoke_key: we do not promote a tenant to live on a credential whose
  // propagation nothing has observed, because that is precisely the failure this closes.
  //
  // control-plane#17: a TenantModuleError carries the REAL diagnostic (which module, which script,
  // retryable or not, attempts, elapsed). Letting it reach the top-level catch turned all of that
  // into a bare 500 internal_error -- an opaque error at the exact moment cf#114 exists to make
  // errors honest. Catch it here and surface it.
  let readiness: ModuleReadiness;
  try {
    readiness = await deps.provisioner.installInvokeKey(tenant, key);
  } catch (e) {
    if (e instanceof TenantModuleError) {
      // 503, not 500: the key is stored and the tenant is intact; what failed is our verification of
      // a downstream module. Retryable by the caller, and the message says what to look at.
      return err("modules_not_ready", 503, { step: e.step, message: e.message });
    }
    throw e; // a non-module failure is not a readiness problem; do not dress it up as one.
  }

  // Propagation not finished inside the probe budget. The key IS installed and this resolves itself,
  // so answer softly and actionably (202) rather than failing -- but do NOT flip the tenant live,
  // because an unconfirmed module is the exact state a customer must not be able to render against.
  if (readiness.unconfirmed.length) {
    // Deliberately NO status write. The tenant genuinely remains awaiting_invoke_key: the operation
    // has not completed and must be retried. Inventing an "awaiting_readiness" lifecycle value to
    // make this response prettier would be a schema and UI decision smuggled into an error-handling
    // fix, and it would make the reported status a thing no store ever holds. The response reports
    // the TRUE stored state and explains the rest in words.
    return json(
      {
        // cp#20: NO `ok` field, deliberately, and this is the whole point of the fix.
        //
        // This response used to carry ok:true. It is a 202: the key is installed but the tenant is
        // NOT live and must not be rendered against. A caller branching on `ok` therefore got a
        // cheerful yes for a studio that is not serving -- the cf#114 lie ("a stored fact the
        // running system does not honour") re-introduced one layer up, in the very route cf#114
        // exists to make honest.
        //
        // The fix is not ok:false. Nothing FAILED here: the key is stored, the tenant is intact,
        // and the message explicitly tells the customer not to re-paste it. ok:false would push a
        // UI toward an error path and invite exactly the re-paste we are telling them to skip.
        //
        // So the summary boolean is REMOVED rather than corrected, and callers must branch on the
        // facts that are actually true: the HTTP status (202 vs 200) and `modules_ready`. Both are
        // present in both responses, so this asks callers to read a field that already existed
        // rather than learn new vocabulary.
        status: tenant.status,
        verified_endpoints: verdict.inScope.length,
        modules_ready: false,
        modules_verified: readiness.verified,
        modules_unconfirmed: readiness.unconfirmed,
        ...(readiness.unverified.length ? { modules_unverified: readiness.unverified } : {}),
        message:
          "your key is installed and stored. Your render modules have not finished picking it up yet " +
          `(checked ${readiness.attempts} times over ${readiness.elapsedMs}ms). This usually clears in ` +
          "under a minute: retry this request to finish going live. Do not re-paste your key; nothing " +
          "is wrong with it.",
      },
      202,
    );
  }

  await deps.store.setTenantStatus(tenant.id, "live");
  return json({
    // No `ok` here either (cp#20). Dropping it from the 202 alone would leave `ok` meaning
    // "present on success, absent on incomplete", so absence would become the success signal by
    // accident and every caller would still be branching on a summary rather than on the state.
    // One shape, both outcomes: `status` says where the tenant IS, `modules_ready` says whether
    // its modules were PROVEN serving.
    status: "live",
    verified_endpoints: verdict.inScope.length,
    // Say plainly whether every module was PROVEN ready. "unverified" is not a soft pass: it names
    // the modules whose readiness could not be observed (an image predating GET /ready) so the fact
    // travels to the operator instead of being swallowed by an ok:true.
    modules_ready: readiness.unverified.length === 0,
    modules_verified: readiness.verified,
    ...(readiness.unverified.length ? { modules_unverified: readiness.unverified } : {}),
  });
}

async function adminRoutes(
  request: Request,
  env: ControlPlaneEnv,
  deps: ControlPlaneDeps,
  path: string,
  url: URL,
  ctx: ExecutionContext,
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

  const upgrade = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/upgrade-modules$/.exec(path);
  if (request.method === "POST" && upgrade) {
    if (!deps.provisioner) return err("provisioner_unconfigured", 503);
    const tenant = await deps.store.getTenantById(upgrade[1]);
    if (!tenant) return err("not_found", 404);

    const body = (await readJson(request)) as { release?: unknown } | null;
    // REQUIRED, with no fallback to STUDIO_RELEASE. A default here would not save typing, it would
    // manufacture the exact silent skew this route was built to end: module bytes shipped at
    // "whatever the plane happened to be pinned to" with nobody having said so. The operator names
    // the release or gets a 400.
    const release = typeof body?.release === "string" ? body.release.trim() : "";
    if (!release) return err("release_required", 400);

    // ONE tenant at a time, and one job at a time for that tenant. A second upgrade overlapping the
    // first would have two drivers PUTting different bytes into the same module scripts, which is
    // the one way to reach a mixed state that nothing recorded.
    const latest = await deps.store.getLatestJobForTenant(tenant.id);
    if (latest && (latest.status === "queued" || latest.status === "running")) {
      return err("job_in_progress", 409, { job_id: latest.id, kind: latest.kind });
    }

    // Preflight FIRST, before any row is created. A refusal here has written nothing at all: no
    // job, no cleared release, no uploaded module.
    const pre = await deps.provisioner.preflightUpgrade(tenant, release);
    if (!pre.ok) return err(pre.refusal.code, pre.refusal.status, { message: pre.refusal.message });

    const job = await deps.store.createModuleUpgradeJob(
      newId("job"),
      tenant.id,
      // Where it is moving FROM, captured before anything NULLs it. This is what makes a failed
      // upgrade rollback-able.
      tenant.modules_release,
      release,
    );
    await deps.store.recordAdminAction(
      actor,
      "tenant.upgrade_modules",
      tenant.id,
      JSON.stringify({ from: tenant.modules_release, to: release, job: job.id }),
    );
    // upgradeModules writes its own terminal job state for every failure it can see. The rejection
    // handler only catches something thrown OUTSIDE that, where the job would otherwise be stranded
    // "running" forever with no record of why.
    ctx.waitUntil(
      deps.provisioner.upgradeModules(job.id, tenant, pre.context).catch(async (e: unknown) => {
        console.error("module_upgrade.unhandled", { tenant: tenant.id, error: String(e) });
        await deps.store.finishJob(job.id, "failed", null, `upgrade driver threw: ${String(e)}`);
      }),
    );
    // 202 without ok:true (cp#20): this has been ACCEPTED, not completed, and a body claiming
    // success before the work has run is the exact shape that ruling exists to forbid.
    return json({ job_id: job.id, from_release: tenant.modules_release, to_release: release }, 202);
  }

  // ---- operator verification (cp#45) ------------------------------------------------------------
  //
  // WHY THESE ROUTES EXIST: our release standard is that nothing is verified until someone has
  // looked at the actual output, and for a hosted tenant nobody could -- the only credential that
  // drives a tenant studio is decryptable only inside this worker. Conrad ruled option (b): the
  // plane submits a canonical smoke render on an operator request and hands back the ARTIFACT. No
  // credential leaves the worker, and the render goes through THIS tenant's own door or not at all.
  const smokeArtifact = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/smoke-render\/(smk_[a-f0-9]+)\/artifact$/.exec(path);
  const smokeOne = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/smoke-render\/(smk_[a-f0-9]+)$/.exec(path);
  const smokeStart = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/smoke-render$/.exec(path);

  if (request.method === "POST" && smokeStart) {
    if (!deps.provisioner) return err("provisioner_unconfigured", 503);
    const tenant = await deps.store.getTenantById(smokeStart[1]);
    if (!tenant) return err("not_found", 404);

    // EVERY CHEAP REFUSAL BEFORE ANYTHING THAT COSTS GPU. A tenant that cannot render must be told
    // so for free, not discovered halfway through a paid render.
    if (tenant.suspended_at !== null) {
      return err("tenant_suspended", 409, { message: "this tenant is suspended; nothing may be rendered on it" });
    }
    if (tenant.status !== "live") {
      return err("tenant_not_live", 409, {
        status: tenant.status,
        message: "only a live tenant can render; a tenant that never finished provisioning has nothing to verify",
      });
    }
    if (!tenant.script_name || !tenant.studio_token_enc) {
      return err("tenant_not_addressable", 409, {
        message: "this tenant has no studio script or no stored studio token, so it cannot be driven",
      });
    }

    const smokeDeps = {
      store: deps.store,
      studio: deps.provisioner.smokeClient,
      bounds: resolveSmokeRenderBounds(env),
      log: (event: string, fields: Record<string, unknown>) => console.log("control-plane", { event, ...fields }),
    };
    const started = await startSmokeRender(smokeDeps, tenant, newId("smk"));

    if (!started.ok && started.code === "spend_guard") {
      // 429, not 403: this is a RATE decision, it is temporary, and the message names which bound
      // was hit so the operator can decide whether to wait or to raise it deliberately.
      return err("smoke_render_rate_limited", 429, { message: started.message, bounds: smokeDeps.bounds });
    }
    if (!started.ok) {
      await deps.store.recordAdminAction(actor, "tenant.smoke_render_refused", tenant.id, started.message);
      // 502: the refusal came from the tenant studio, not from us. The row is already recorded
      // FAILED carrying the studio's own words.
      return err("studio_refused", 502, {
        smoke_render_id: started.smoke.id,
        message: started.message,
        coverage: SMOKE_RENDER_COVERAGE,
      });
    }

    await deps.store.recordAdminAction(
      actor,
      "tenant.smoke_render",
      tenant.id,
      JSON.stringify({ smoke: started.smoke.id, studio_job: started.smoke.studio_job_id, modules_release: tenant.modules_release }),
    );
    // 202 without ok:true (cp#20): this has been ACCEPTED. Nothing is verified until the poll route
    // has fetched the artifact, and a body claiming otherwise would be the exact lie cp#45 closes.
    return json(smokeRenderView(started.smoke), 202);
  }

  if (request.method === "GET" && smokeOne) {
    if (!deps.provisioner) return err("provisioner_unconfigured", 503);
    const found = await loadSmokeRender(deps, smokeOne[1], smokeOne[2]);
    if (!found) return err("not_found", 404);
    const smokeDeps = {
      store: deps.store,
      studio: deps.provisioner.smokeClient,
      bounds: resolveSmokeRenderBounds(env),
      log: (event: string, fields: Record<string, unknown>) => console.log("control-plane", { event, ...fields }),
    };
    // The poll IS the engine here, same as the provision poll (#112): it drives the render forward,
    // and it is the step that FETCHES the artifact rather than trusting a status field.
    const advanced = await advanceSmokeRender(smokeDeps, found.tenant, found.smoke);
    return json(smokeRenderView(advanced));
  }

  if (request.method === "GET" && smokeArtifact) {
    if (!deps.provisioner) return err("provisioner_unconfigured", 503);
    const found = await loadSmokeRender(deps, smokeArtifact[1], smokeArtifact[2]);
    if (!found) return err("not_found", 404);
    const { smoke, tenant } = found;
    if (smoke.status !== "succeeded" || !smoke.artifact_key) {
      return err("no_artifact", 409, { status: smoke.status, message: "this smoke render produced no verified artifact" });
    }

    // Re-fetched through the tenant's own door on every request rather than cached here: the
    // control plane owns no tenant data and is not about to start by keeping copies of customer
    // renders. The tenant credential still never leaves this worker.
    const got = await deps.provisioner.smokeClient.fetchArtifact(tenant, smoke.artifact_key);
    if (got.status !== 200 || !got.bytes) {
      return err("artifact_unavailable", 502, {
        message: `the tenant studio would not serve the artifact (HTTP ${got.status})`,
      });
    }
    // INTEGRITY, not decoration: these are served as the bytes that were verified, so prove they
    // still are. A mismatch means the object changed under us and the operator must not be handed
    // it as though it were the verified artifact.
    const sha = await sha256Hex(got.bytes);
    if (sha !== smoke.artifact_sha256) {
      return err("artifact_changed", 409, {
        message: "the stored artifact no longer matches the bytes that were verified",
        verified_sha256: smoke.artifact_sha256,
        current_sha256: sha,
      });
    }
    return new Response(got.bytes, {
      headers: {
        "content-type": got.contentType,
        "content-length": String(got.bytes.byteLength),
        "x-vivijure-smoke-sha256": sha,
        // Operator-facing, never a browser surface: this is an admin-token route and the bytes are
        // a customer's render.
        "cache-control": "no-store",
      },
    });
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

/**
 * Resolve a smoke render THAT BELONGS TO THIS TENANT (cp#45).
 *
 * The tenant id in the path is not decoration: without this join a smoke render id would address a
 * render on any tenant, and the artifact route would serve one customer's render off another
 * customer's URL. 404 rather than 403 for a mismatch, same as the tenant routes -- an authorization
 * error that confirms existence is an enumeration oracle.
 */
async function loadSmokeRender(
  deps: ControlPlaneDeps,
  tenantId: string,
  smokeId: string,
): Promise<{ tenant: Tenant; smoke: SmokeRender } | null> {
  const smoke = await deps.store.getSmokeRender(smokeId);
  if (!smoke || smoke.tenant_id !== tenantId) return null;
  const tenant = await deps.store.getTenantById(tenantId);
  if (!tenant) return null;
  return { tenant, smoke };
}

/**
 * The operator-facing projection of a smoke render.
 *
 * `verified` is the ONE summary field and it means exactly one thing: this worker fetched the
 * artifact bytes and hashed them. It is derived from the presence of that evidence rather than from
 * the status string, so there is no way to report verified:true for a render whose bytes nobody
 * pulled. The coverage statement rides along on every response, because a green tick that does not
 * state its limits is how "the modules answered" became "the modules render".
 */
function smokeRenderView(smoke: SmokeRender): Record<string, unknown> {
  const verified = smoke.status === "succeeded" && smoke.artifact_sha256 !== null;
  return {
    smoke_render_id: smoke.id,
    tenant_id: smoke.tenant_id,
    status: smoke.status,
    verified,
    // WHICH module bytes produced these pixels. Without this the artifact answers "does it render",
    // never "does THIS release render", which is the question a post-upgrade check is asking.
    modules_release: smoke.modules_release,
    studio_job_id: smoke.studio_job_id,
    artifact: verified
      ? {
          key: smoke.artifact_key,
          bytes: smoke.artifact_bytes,
          sha256: smoke.artifact_sha256,
          content_type: smoke.artifact_content_type,
          // Where an operator goes to LOOK at it, which is the whole point of the issue.
          url: `/api/admin/tenants/${smoke.tenant_id}/smoke-render/${smoke.id}/artifact`,
        }
      : null,
    error_message: smoke.error_message,
    created_at: smoke.created_at,
    finished_at: smoke.finished_at,
    coverage: SMOKE_RENDER_COVERAGE,
  };
}
