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

import { ApiTokenError } from "./tenant-api-token";
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
import { publicOrigin, studioKekRing, tenantDomainSuffix } from "./env";
import { kekCensus, sweepReencrypt } from "./kek-rotation";
import { authorizeUrl, configuredProviders, exchangeCode, isSsoProvider } from "./oauth";
import { parseInventoryBody, reconcileRunPod, TENANT_PAGE_LIMIT } from "./reconcile-runpod";
import { buildR2UsageReport, parseThresholdBytes } from "./tenant-r2-usage";
import { routeTenantRequest } from "./routing";
import { verifyInvokeKeyScope } from "./runpod-invoke-key";
import { ABUSE_REPORT_URL_VAR } from "./tenant-abuse-report";
import {
  HANDOFF_TOKEN_PARAM,
  burnInvokeKeyHandoff,
  mintInvokeKeyHandoff,
  resolveInvokeKeyHandoff,
  type HandoffDeps,
} from "./invoke-key-handoff";
import { JOB_LEASE_SECONDS, RECLAIM_LEASE_SECONDS, jobAwaitsFirstDriver, jobHasLiveDriver } from "./store";
import { StudioBindingError } from "./tenant-studio-bindings";
import { ReprovisionError } from "./tenant-runpod-reprovision";
import type { PreservationHoldKind } from "./store";
import type { Account, Tenant, ProvisionJob, SmokeRender } from "./store";
import {
  advanceSmokeRender,
  resolveSmokeRenderBounds,
  sha256Hex,
  SMOKE_RENDER_COVERAGE,
  startSmokeRender,
} from "./smoke-render";
import {
  slugRejectionMessage,
  tenantEndpointIds,
  tenantEndpointRecipe,
  tenantView,
  validateSlug,
} from "./tenants";
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

    // ---- cp#169: the owner-completed invoke-key handoff (unauthenticated by design) ----
    //
    // WHY IT SITS ABOVE THE SESSION GATE. The whole point of the ruling is that the owner does not
    // have to sign in: an operator repaired their studio and handed them a link. Requiring a session
    // here would put the flow back exactly where cp#169 found it. What replaces the session is not
    // "nothing" -- it is a one-time 256-bit token bound to ONE tenant and ONE set of endpoint ids,
    // and a key that still has to pass verifyInvokeKeyScope against endpoints living in the
    // customer's own RunPod account. Holding the link without a credential to that account installs
    // nothing.
    //
    // THE TOKEN TRAVELS IN THE BODY ON THE WRITE, and in the query only on the read the page cannot
    // avoid (it arrives as a URL). Same shape as the magic link, and the write is where a token in a
    // query string would otherwise end up in an access log next to a credential.
    if (path === "/api/handoff/invoke-key") {
      if (request.method === "GET") return await handoffContext(request, deps, url);
      if (request.method === "POST") return await handoffInstall(request, deps);
      return err("not_found", 404);
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
  } else if (env.POSTERN_SEND_URL && env.POSTERN_SEND_TOKEN) {
    // Production mail path configured but rate limit binding absent: fail closed (K3).
    console.error("CP_RATE_LIMIT binding required when POSTERN send door is configured");
    return accepted();
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
  const redirectTo = safeSameOriginRedirectPath(redirectToParam, publicOrigin(env));

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

    // ---- the tenant's PROGRAMMATIC studio token (cf#94) -------------------------------------
    //
    // SEPARATE credential, ruled: never a reveal of the dispatcher-injected STUDIO_API_TOKEN, so
    // revoking this can never sign the owner out of their browser session.
    //
    // The plaintext appears in the POST response and NOWHERE else -- not in GET, not in a log, not
    // in any table on this plane. The tenant's own studio DB stores only its SHA-256 hash, which is
    // why GET carries no masked `display` field: masking implies keeping a copy, and the visible
    // absence is the honest signal.
    if (action === "api-token") {
      if (!deps.provisioner) return err("provisioner_unconfigured", 503);
      const fail = (e: unknown): Response => {
        if (e instanceof ApiTokenError) {
          return err(e.code, e.code === "tenant_unreachable" ? 503 : 409);
        }
        throw e;
      };

      if (request.method === "GET") {
        try {
          return json(await deps.provisioner.apiToken.read(tenant));
        } catch (e) {
          return fail(e);
        }
      }
      if (request.method === "POST") {
        try {
          // Mint AND rotate: one verb, because from the tenant's side they are the same request, and
          // a separate rotate invites a UI that can leave two live credentials behind.
          return json(await deps.provisioner.apiToken.issue(tenant), 201);
        } catch (e) {
          return fail(e);
        }
      }
      if (request.method === "DELETE") {
        try {
          await deps.provisioner.apiToken.revoke(tenant);
          return json({ configured: false });
        } catch (e) {
          return fail(e);
        }
      }
      return err("method_not_allowed", 405);
    }

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

/**
 * One invocation claim on a job. THE store lease length, not a copy of it (cp#148): the poller and
 * the driver heartbeat have to agree on one number, and two 60s literals that agree by luck is how
 * a lease hierarchy drifts.
 */
const JOB_CLAIM_SECONDS = JOB_LEASE_SECONDS;

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
  // KIND GUARD. This driver resumes a PROVISION and nothing else: deps.provisioner.resume runs
  // continueProvisionJob, whose success path writes setTenantStatus("awaiting_invoke_key"). Pointed
  // at a module_upgrade job that is exactly the outage upgradeTenantModules refuses to cause -- a
  // LIVE, paying tenant flipped to a non-routable status (503 from routingStatusFor) on the path
  // where the upgrade SUCCEEDS, plus a second driver PUTting module bytes concurrently with the
  // real one.
  //
  // Reachable, not theoretical: createModuleUpgradeJob inserts `queued` with a NULL lease, and
  // claimJob matches on status alone, so any tenant poll landing in the window before the first
  // updateJobProgress of the upgrade WINS the claim. The upgrade carries its own driver (the
  // ctx.waitUntil in the admin route) and deliberately has no continuation, so there is nothing
  // here to drive in any case: the correct behavior is to REPORT the job and drive nothing.
  if (job.kind !== "provision") return null;

  // Lost driver: no progress for too long. Fail honestly rather than leave a spinner running.
  const lastProgress = Date.parse(`${job.updated_at.replace(" ", "T")}Z`);
  if (Number.isFinite(lastProgress) && deps.now() - lastProgress > MAX_JOB_STALE_MS) {
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

  // A JOB NO DRIVER HAS TAKEN YET IS NOT OURS TO CLAIM (cp#132). This is the server half of cp#124,
  // and it is the one window the cp#148 heartbeat cannot cover, because it opens BEFORE any driver
  // exists to beat.
  //
  // The provision route INSERTs the job `queued` with a NULL lease and dispatches its driver under
  // waitUntil in the same request. A poll landing inside that window -- the UI, a second tab, a
  // curl loop, an operator rehearsal -- wins claimJob outright, and winning is destructive: resume
  // runs continueProvisionJob, which refuses anything short of wfp_upload by writing
  // finishJob(failed) + setTenantStatus(failed) + a rollback that DELETES the tenant D1, bucket and
  // token the real driver is at that moment still building. The claim also makes the driver own
  // setJobRunning miss its predicate, so the row never records that a driver arrived at all.
  //
  // So: report it, drive nothing, write nothing. Declining costs discovery time on the rare job
  // whose driver never arrives (the stale rule above owns that case and declares it lost with an
  // attributable message); claiming costs a healthy customer their half-built studio. The asymmetry
  // decides it, the same way it decides the reclaim lease length.
  //
  // A `running` job with a lapsed lease is NOT this case and still gets claimed below: since cp#148
  // a lapsed lease there means the driver is genuinely gone, so the keyless refusal it walks into is
  // an honest terminal state rather than a race outcome.
  if (jobAwaitsFirstDriver(job)) return null;

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
  return (await performInvokeKeyInstall(deps, tenant, key)).response;
}

/**
 * The install itself: verify, store, prove, promote. ONE implementation, two callers.
 *
 * cp#169 gave this a second entry point (the owner-completed handoff), and the constraint on that
 * issue is that the verification runs EXACTLY as it does on the session route -- "the check refusing
 * a graphql-capable key is the whole custody story". The way to make that true by identity rather
 * than by imitation is to have one function, so this is it: the session route reads a body and calls
 * here, the handoff route resolves a one-time token and calls here, and neither owns a copy of the
 * verification, the readiness probe, or the promotion.
 *
 * `installed` is true ONLY on the terminal 200 (the tenant reached `live`). The handoff caller uses
 * it to decide whether to burn its single-use link, which is why it is a returned FACT and not
 * inferred from the status code by the caller: a 202 leaves the key stored but the tenant not live,
 * and its own message tells the customer to retry, so burning the link there would make that advice
 * a lie.
 */
async function performInvokeKeyInstall(
  deps: ControlPlaneDeps,
  tenant: Tenant,
  key: string,
): Promise<{ response: Response; installed: boolean }> {
  const no = (response: Response) => ({ response, installed: false });

  const endpoints = tenantEndpointIds(tenant);
  if (endpoints.length === 0) {
    return no(
      err("no_endpoints", 409, {
        message: "your endpoints have not been created yet; there is nothing to scope a key to",
      }),
    );
  }
  if (!tenant.script_name) {
    // Endpoints exist but the studio upload never completed: a failed provision. Installing a key
    // on a worker that is not there cannot succeed, and pretending otherwise strands the tenant.
    return no(
      err("not_provisioned", 409, {
        message: "your studio was not fully provisioned; retry provisioning before installing a key",
      }),
    );
  }

  // Same refusal as the provision route: absence of the wiring is a deploy-config fact.
  if (!deps.provisioner) return no(err("provisioner_unconfigured", 503));

  // Verify BEFORE storing. A wrong key is rejected with the real reason and never written; the most
  // dangerous wrong key is the powerful graphql one, which is exactly what this catches.
  const verdict = await verifyInvokeKeyScope(key, endpoints, deps.fetch);
  if (!verdict.ok) {
    return no(err("invoke_key_rejected", 400, { reason: verdict.reason, message: verdict.detail }));
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
      return no(err("modules_not_ready", 503, { step: e.step, message: e.message }));
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
    return no(
      json(
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
        // THE FACTS, so a client can COMPOSE the sentence instead of echoing ours (cp#27).
        //
        // The prose below cannot be localised (its wording is fixed here, in English) and cannot be
        // re-presented (a client wanting the retry as a button, or the elapsed time as a progress
        // hint, would have to parse English back into numbers -- a parser only as fresh as the
        // sample it was built from). Worse, the claims that MATTER to a customer were load-bearing
        // only by convention: tests/invoke-key-shapes.ts greps the message for "installed",
        // "stored", "retry" and "do not re-paste" precisely because dropping one costs the customer
        // the reason not to re-paste their credential. A substring assertion standing in for a
        // contract is a stand-in, honest about it or not.
        //
        // So each of those four claims gets a field that is ASSERTABLE rather than greppable:
        //   key_stored     -- a FACT. We are past the secrets PUT; the key is installed and stored.
        //   retry_finishes -- the INSTRUCTION. Retrying THIS request is the way forward. It is not
        //                     a promise the retry succeeds; it names the correct next action.
        //   repaste_needed -- the SAFETY claim, and the reason this object is not just the pair the
        //                     issue sketched. "Do not re-paste" is the single most important thing
        //                     the message says (a re-paste pulls the credential out from under a
        //                     propagation that is already working), and leaving it grep-only would
        //                     have left the most load-bearing claim as the one thing not structured.
        //   attempts / elapsed_ms -- what we probed and for how long, as numbers, which is the part
        //                     a client currently has to read back out of a sentence.
        //
        // message is RETAINED, deliberately. Dropping it is breaking for any consumer echoing it
        // (the onboarding client does today), so it stays for at least one release and the client
        // migrates to composing from these fields on its own schedule.
        readiness: {
          attempts: readiness.attempts,
          elapsed_ms: readiness.elapsedMs,
          key_stored: true,
          retry_finishes: true,
          repaste_needed: false,
        },
        message:
          "your key is installed and stored. Your render modules have not finished picking it up yet " +
          `(checked ${readiness.attempts} times over ${readiness.elapsedMs}ms). This usually clears in ` +
          "under a minute: retry this request to finish going live. Do not re-paste your key; nothing " +
          "is wrong with it.",
      },
      202,
      ),
    );
  }

  await deps.store.setTenantStatus(tenant.id, "live");
  return {
    installed: true,
    response: json({
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
    }),
  };
}

/** The handoff seam, assembled in one place so both routes and the admin mint share a clock. */
const handoffDeps = (deps: ControlPlaneDeps): HandoffDeps => ({ store: deps.store, now: deps.now });

/**
 * What the owner needs to SEE before they can act: which studio, which four endpoints to scope a key
 * to, and how long the link is good for. Reads the handoff; never consumes it.
 *
 * It returns endpoint ids and a slug and nothing else about the tenant. Both are identifiers the
 * owner already holds (the slug is their studio hostname, the ids are rows in their own RunPod
 * console), which is what makes this safe to serve to a bare token: a stranger who guessed a
 * 256-bit token would learn two facts they cannot act on without a credential we do not hold.
 */
async function handoffContext(request: Request, deps: ControlPlaneDeps, url: URL): Promise<Response> {
  const token = url.searchParams.get(HANDOFF_TOKEN_PARAM) ?? "";
  const outcome = await resolveInvokeKeyHandoff(handoffDeps(deps), token);
  if (!outcome.ok) {
    return err(outcome.refusal.code, outcome.refusal.status, { message: outcome.refusal.message });
  }
  const { handoff, tenant } = outcome.context;
  return json({
    handoff_id: handoff.id,
    slug: tenant.slug,
    status: tenant.status,
    expires_at: handoff.expires_at,
    // The RECIPE data, in the shape the onboarding screen already renders: the owner is doing the
    // same console work they did at signup, so they should be reading the same list. Projected from
    // the TENANT row rather than copied onto the handoff, so there is one source of truth for what
    // this studio's endpoints are, and the staleness check above is what guarantees they agree.
    endpoints: tenantEndpointRecipe(tenant),
  });
}

/**
 * The owner pastes their key. Same install as the session route, by identity, then burn the link.
 *
 * THE BURN IS AFTER, AND ONLY ON A COMPLETED INSTALL. A rejected key must leave the link usable (a
 * typo would otherwise re-strand the customer, which is the failure this whole issue is about), and
 * so must the 202, whose own instruction is to retry. `installed` comes back from the install rather
 * than being inferred from the status code here, so the two cannot drift.
 */
async function handoffInstall(request: Request, deps: ControlPlaneDeps): Promise<Response> {
  const body = (await readJson(request)) as { token?: unknown; runpod_invoke_key?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token : "";
  const key = typeof body?.runpod_invoke_key === "string" ? body.runpod_invoke_key : "";
  if (!key) return err("invoke_key_required", 400);

  const outcome = await resolveInvokeKeyHandoff(handoffDeps(deps), token);
  if (!outcome.ok) {
    return err(outcome.refusal.code, outcome.refusal.status, { message: outcome.refusal.message });
  }
  const { handoff, tenant } = outcome.context;

  const { response, installed } = await performInvokeKeyInstall(deps, tenant, key);
  if (!installed) return response;

  const burned = await burnInvokeKeyHandoff(handoffDeps(deps), handoff);
  // CONSUMPTION IS AUDITED, and it is audited as the OWNER acting, not the operator: the actor
  // records which handoff was used and who issued it, so an install has a person on both ends. The
  // key is not here and never was -- the fields are ids and a boolean.
  await deps.store.recordAdminAction(
    `handoff:${handoff.id}`,
    "tenant.install_invoke_key_via_handoff",
    tenant.id,
    JSON.stringify({ handoff_id: handoff.id, issued_by: handoff.issued_by, burned }),
  );
  return response;
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

  // ---- Aggregate R2 usage across tenant buckets (cf#56 gate section 5) ------------------------
  //
  // READS ONLY, and records no audit row, for the same reason the RunPod reconcile below records
  // none: nothing changes, so there is nothing to audit, and a write would let the pass alter what
  // it measures. This is about OUR bill; the per-tenant storage QUOTA is a studio-core knob so that
  // self-host gets the identical feature (vivijure-core#52), never a hosted-only enforcement path.
  //
  // WHY THE CENSUS FLAG TRAVELS INTO THE REPORT. listTenants pages at TENANT_PAGE_LIMIT. A total
  // computed over a truncated census is not a total, it is a floor wearing a totals label, and an
  // under-threshold verdict drawn from it is a confident all-clear that can be flat wrong. So the
  // completeness fact is carried, and buildR2UsageReport refuses to say "under" without it.
  if (request.method === "GET" && path === "/api/admin/r2-usage") {
    // Same absence-refusal as every other route needing cloud reach: a deploy without provisioner
    // env has no credential to read R2 with, and 503 is the honest answer rather than an empty
    // report that would read as "no tenants are using anything".
    if (!deps.provisioner) return err("provisioner_unconfigured", 503);
    const tenants = await deps.store.listTenants({});
    const censusComplete = tenants.length < TENANT_PAGE_LIMIT;
    // Live tenants only: a deleted rows bucket is already reaped, and counting it would inflate the
    // bill we are trying to measure. Suspended tenants DO still hold storage, so they stay in.
    const measured = tenants.filter((t) => t.r2_bucket_name && !t.deleted_at);
    const measurements = new Map<string, { payloadBytes: number; objectCount: number } | { error: string }>();
    // SEQUENTIAL, deliberately: each bucket is one subrequest, and a Worker has a bounded subrequest
    // budget. Fanning these out concurrently would be faster and would also be the thing that makes
    // this route fail as the tenant count grows, which is precisely when an operator needs it.
    for (const t of measured) {
      const bucket = t.r2_bucket_name as string;
      try {
        measurements.set(bucket, await deps.provisioner.r2Usage(bucket));
      } catch (e) {
        // Recorded as unreadable, NOT as zero. The report counts it and marks the total a floor.
        measurements.set(bucket, { error: (e as Error).message.slice(0, 200) });
      }
    }
    return json({
      report: buildR2UsageReport({
        tenants: measured.map((t) => ({ id: t.id, slug: t.slug, r2_bucket_name: t.r2_bucket_name })),
        censusComplete,
        measurements,
        thresholdBytes: parseThresholdBytes(env.R2_USAGE_ALERT_BYTES),
      }),
    });
  }

  // ---- RunPod reconciliation: read the drift, change nothing (cp#137) -------------------------
  //
  // WHY A POST THAT ONLY READS. The plane cannot fetch this itself: it holds no credential that can
  // read the RunPod account of a tenant, by design (key A used once and never stored, key B
  // invoke-only). So the operator brings the RunPod snapshot they read with their own key and the
  // plane supplies the half only it has, the tenant records. The verb is POST because a snapshot
  // travels in a body, not because anything is written.
  //
  // NOTHING IS WRITTEN, INCLUDING AN AUDIT ROW. Every other admin route here records what it did
  // because it did something. This one reads two lists and returns a report, so there is no state
  // change to audit, and adding a write would give the pass the one property it must not have: the
  // ability to alter the thing it is measuring. Remediation (deleting an orphan, re-provisioning a
  // tenant) is separate, lead-approved work with its own route and its own audit.
  if (request.method === "POST" && path === "/api/admin/reconcile/runpod") {
    const parsed = parseInventoryBody(await readJson(request));
    if (!parsed.ok) return err("invalid_inventory", 400, { message: parsed.detail });

    const tenants = await deps.store.listTenants({});
    // The store pages at TENANT_PAGE_LIMIT. A full page means the census MAY have been cut off, and
    // every orphan finding is an absence-of-owner claim that only a whole census can support, so
    // the flag travels into the report instead of being assumed away.
    const census = { tenants, complete: tenants.length < TENANT_PAGE_LIMIT };
    return json({ report: reconcileRunPod(census, parsed.inventory) });
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

  // ---- preservation holds: the interlock on the irreversible lever (cp#118) --------------------
  //
  // ABUSE-RESPONSE-RUNBOOK.md Section 5.2 forbids teardown on a tenant with an open report or
  // preservation duty, and until these routes existed the only thing enforcing that was an operator
  // remembering the paragraph. A hold is the technical control: teardownTenant refuses while one is
  // open (see provisioner.ts), and only an explicit, audited human release lifts it.
  //
  // WHY OPENING IS CHEAP AND RELEASING IS DELIBERATE. Opening a hold costs an operator one call and
  // destroys nothing, so it should happen the moment a report arrives, before triage, before
  // anyone knows whether it is real. Releasing is the decision that lets evidence be destroyed, so
  // it demands its own reason and its own audit row naming who decided the duty was over.
  const holds = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/preservation-holds$/.exec(path);
  if (holds && (request.method === "GET" || request.method === "POST")) {
    const tenant = await deps.store.getTenantById(holds[1]);
    if (!tenant) return err("not_found", 404);

    if (request.method === "GET") {
      // Every hold, not just the open ones: a released hold is the record of a duty that ENDED, and
      // an operator asking "why can this be torn down now" needs to see it.
      return json({ tenant_id: tenant.id, holds: await deps.store.listPreservationHolds(tenant.id) });
    }

    const body = (await readJson(request)) as
      | { kind?: unknown; reason?: unknown; expires_at?: unknown }
      | null;
    const reason = String(body?.reason ?? "").trim();
    // Same rule as suspend: a hold nobody can explain is not auditable, and this one blocks a lever.
    if (!reason) return err("reason_required", 400);

    const kind = String(body?.kind ?? "").trim() as PreservationHoldKind;
    if (kind !== "ncmec_2258a_h" && kind !== "le_2703_f" && kind !== "internal") {
      return err("invalid_kind", 400, {
        message:
          "kind must be ncmec_2258a_h (our CyberTipline submission, 1 year), le_2703_f (a " +
          "governmental preservation request, 90 days renewable), or internal (an open report with " +
          "no statutory clock yet)",
      });
    }

    // THE CLOCK IS EXPLICIT OR DEFAULTED FROM THE STATUTE, never guessed silently. The default is
    // computed here rather than in SQL so the stored value is a fact an operator can read back and
    // argue with, and so the two statutory periods are written down in one place next to their
    // citations. An `internal` hold gets no clock: it has not started one.
    let expiresAt: string | null = null;
    if (typeof body?.expires_at === "string" && body.expires_at.trim()) {
      expiresAt = body.expires_at.trim();
    } else if (kind === "ncmec_2258a_h" || kind === "le_2703_f") {
      const days = kind === "ncmec_2258a_h" ? 365 : 90;
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }

    const hold = await deps.store.openPreservationHold({
      id: newId("hold"),
      tenant_id: tenant.id,
      kind,
      reason,
      opened_by: actor,
      expires_at: expiresAt,
    });
    await deps.store.recordAdminAction(
      actor,
      "tenant.preservation_hold.open",
      tenant.id,
      JSON.stringify({ hold_id: hold.id, kind, expires_at: expiresAt, reason }),
    );
    return json({ hold }, 201);
  }

  const release = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/preservation-holds\/(hold_[a-f0-9]+)\/release$/.exec(
    path,
  );
  if (request.method === "POST" && release) {
    const tenant = await deps.store.getTenantById(release[1]);
    if (!tenant) return err("not_found", 404);

    const body = (await readJson(request)) as { reason?: unknown } | null;
    const reason = String(body?.reason ?? "").trim();
    // The release reason is the one an auditor reads first: it is the moment we decided destruction
    // was permissible. 2258B(c) puts that call on law enforcement, so this is usually where their
    // instruction gets written down.
    if (!reason) return err("reason_required", 400);

    // Belt and braces: the hold must belong to THIS tenant. releasePreservationHold keys on the hold
    // id alone, and an operator working from a pasted id must not be able to lift a hold off a
    // different customer row by way of a typo in the path.
    const existing = (await deps.store.listPreservationHolds(tenant.id)).find((h) => h.id === release[2]);
    if (!existing) return err("not_found", 404);

    const released = await deps.store.releasePreservationHold(release[2], actor, reason);
    // Null means it was ALREADY released. Reporting that honestly matters: the audit row for the
    // first release is the record of who decided, and a second one must not read as a fresh call.
    if (!released) return err("already_released", 409, { hold_id: release[2] });

    await deps.store.recordAdminAction(
      actor,
      "tenant.preservation_hold.release",
      tenant.id,
      JSON.stringify({ hold_id: released.id, kind: released.kind, reason }),
    );
    return json({ hold: released });
  }

  // ---- teardown: THE production caller teardownTenant never had (#23) -------------------------
  //
  // WHY ADMIN-GATED rather than owner-facing. This is the irreversible lever, and #23 asks for a
  // path that is REACHABLE, not for a self-serve delete button nobody has ruled on. Operator-held
  // matches the other destructive lever on this plane (suspend) and keeps the customer-facing
  // deprovision UX a deliberate decision rather than a side effect of wiring the caller. An
  // owner-facing route can be built on top of this one; the reverse is not true.
  //
  // WHY IT RUNS INLINE rather than under waitUntil. The answer IS the evidence: what was reaped,
  // and what the referential guard refused and why. A 202 would hand back a job id and put the
  // refusals somewhere the operator has to go looking for, on the one route where the refusals are
  // the most important thing in the response. Emptying is budgeted per cycle (provisioner.ts), so a
  // large bucket returns an honest "re-run to continue" rather than a call that never lands.
  const teardown = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/teardown$/.exec(path);
  if (request.method === "POST" && teardown) {
    if (!deps.provisioner) return err("provisioner_unconfigured", 503);
    const tenant = await deps.store.getTenantById(teardown[1]);
    if (!tenant) return err("not_found", 404);

    const body = (await readJson(request)) as { confirm_slug?: unknown; delete_data?: unknown } | null;
    // Name the target out loud. Tenant ids are opaque and adjacent in a listing; the slug is what an
    // operator actually recognises, and typing it is the difference between tearing down the studio
    // you meant and the one above it.
    if (typeof body?.confirm_slug !== "string" || body.confirm_slug.trim() !== tenant.slug) {
      return err("slug_confirmation_required", 400, { slug: tenant.slug });
    }
    // DEFAULT FALSE, deliberately (#23). Without it teardown pulls the worker, the module scripts
    // and the credential -- the tenant stops being reachable and stops being able to write -- and
    // LEAVES the data. Reaping a customer films is an explicit second decision.
    const deleteData = body.delete_data === true;

    // ONE destructive pass at a time, on the same lease the reclaim path uses: resource names derive
    // from the slug, so two overlapping teardowns issue the same deletes and the second can land on
    // whatever was rebuilt under those names.
    const lease = await deps.store.beginTeardown(tenant.id, RECLAIM_LEASE_SECONDS);
    if (!lease) {
      return err("teardown_in_progress", 409, {
        message: "another destructive pass holds this row, or a provision job is live on it",
      });
    }

    // TEAR DOWN FROM THE LEASED ROW, not from the row read before the lease: beginTeardown is the
    // serialization point, so those are the authoritative ids (same rule the reclaim path states).
    const result = await deps.provisioner.teardown(lease.tenant, { deleteData });

    // WHAT WAS ACTUALLY REAPED is read back off the ROW rather than taken from the return value.
    // Columns blank only on their own resource successful deletion, so this diff is the plane own
    // record of the reap instead of the caller opinion of it.
    const after = await deps.store.getTenantById(tenant.id);
    const reaped = (["script_name", "d1_database_id", "r2_bucket_name", "r2_token_id"] as const).filter(
      (col) => lease.tenant[col] !== null && after?.[col] === null,
    );

    // A REFUSAL is not a failure: it is the guard working. They are split because they need opposite
    // follow-up -- a refusal means "this resource is not provably ours, go look at the referrer
    // named in the message", a failure means "this call did not work, retry it".
    const refused = result.failures.filter((f) => f.error.startsWith("refused:"));
    const failed = result.failures.filter((f) => !f.error.startsWith("refused:"));

    // ABSENT is a third answer, and it needs to be visible (cp#110). The reaped list above is a
    // column diff, so a resource that was ALREADY GONE lands in it looking exactly like one this
    // pass deleted. Reporting absence alongside is what keeps those two facts distinguishable: a
    // script removed out of band is something an operator may want to go ask about, while nothing
    // here needs a retry.
    const absent = result.absent;

    // Promote to 'deleted' ONLY on a clean pass that was allowed to take the data. Anything else
    // leaves the status where it was, because "deleted" has to keep meaning "provably reaped".
    const finished = await deps.store.finishTeardown(tenant.id, lease.lease_token, result.ok && deleteData);

    await deps.store.recordAdminAction(
      actor,
      "tenant.teardown",
      tenant.id,
      JSON.stringify({
        delete_data: deleteData,
        reaped,
        refused: refused.length,
        failed: failed.length,
        absent: absent.map((a) => a.resource),
      }),
    );

    return json({
      tenant_id: tenant.id,
      slug: tenant.slug,
      // Read back, never assumed. finishTeardown returns null when the lease was taken over
      // mid-pass, which is exactly the case where an assumed status would be wrong.
      status: finished?.status ?? after?.status ?? tenant.status,
      delete_data: deleteData,
      reaped,
      refused,
      failed,
      absent,
      teardown_at: finished?.teardown_at ?? after?.teardown_at ?? null,
    });
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
    if (latest && jobHasLiveDriver(latest, deps.now())) {
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
    // Claim the job BEFORE returning 202, same as provision's setJobRunning: a lease that expires
    // if the driver dies, so a stranded upgrade self-heals instead of wedging every future attempt
    // (#44). The guard above keys off live leases, not bare status.
    await deps.store.setJobRunning(job.id);
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

  // ---- cp#139: move a LIVE tenant's STUDIO BYTES onto a newer release ---------------------------
  //
  // WHY ADMIN-GATED: it is an operator action on someone else's studio, exactly like teardown and
  // upgrade-modules. The tenant asked for nothing.
  //
  // WHY A JOB AND NOT INLINE (the split from refresh-studio-bindings): this MOVES BYTES and changes
  // the release a live tenant runs. cp#112 could be inline because it changes bindings only and its
  // answer IS its evidence; a release change is the operation this plane already insists must carry
  // a from_release/to_release record, so it gets a job row like the module upgrade it is a sibling of.
  //
  // WHY NO confirm_slug: it is not destructive. In place, bindings preserved, status untouched, the
  // tenant serving throughout. The preflight refusals are what keep it from running where it makes
  // no sense.
  const studioUpgrade = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/upgrade-studio$/.exec(path);
  if (request.method === "POST" && studioUpgrade) {
    if (!deps.provisioner) return err("provisioner_unconfigured", 503);
    const tenant = await deps.store.getTenantById(studioUpgrade[1]);
    if (!tenant) return err("not_found", 404);

    const body = (await readJson(request)) as { release?: unknown } | null;
    // REQUIRED, with no fallback to STUDIO_RELEASE, for the same reason the module upgrade refuses
    // one: a default would not save typing, it would ship bytes at "whatever the plane happened to
    // be pinned to" with nobody having said so. The operator names the release or gets a 400.
    const release = typeof body?.release === "string" ? body.release.trim() : "";
    if (!release) return err("release_required", 400);

    // ONE writer at a time on this row. Two drivers PUTting different bytes into the same studio
    // script is the one way to reach a state nothing recorded.
    const latest = await deps.store.getLatestJobForTenant(tenant.id);
    if (latest && jobHasLiveDriver(latest, deps.now())) {
      return err("job_in_progress", 409, { job_id: latest.id, kind: latest.kind });
    }

    // Preflight FIRST: a refusal here has written nothing at all -- no job, no cleared release, no
    // uploaded byte.
    const pre = await deps.provisioner.preflightStudioUpgrade(tenant, release);
    if (!pre.ok) return err(pre.refusal.code, pre.refusal.status, { message: pre.refusal.message });

    const job = await deps.store.createStudioUpgradeJob(
      newId("job"),
      tenant.id,
      // Where it is moving FROM, captured before the run NULLs it. This is what makes a failed move
      // rollback-able: re-run at from_release.
      tenant.studio_release,
      release,
    );
    await deps.store.recordAdminAction(
      actor,
      "tenant.upgrade_studio",
      tenant.id,
      JSON.stringify({ from: tenant.studio_release, to: release, job: job.id }),
    );
    await deps.store.setJobRunning(job.id);
    // upgradeStudio writes its own terminal job state for every failure it can see. This handler
    // only catches something thrown OUTSIDE that, where the job would otherwise be stranded
    // "running" forever with no record of why.
    ctx.waitUntil(
      deps.provisioner.upgradeStudio(job.id, tenant, pre.context).catch(async (e: unknown) => {
        console.error("studio_upgrade.unhandled", { tenant: tenant.id, error: String(e) });
        await deps.store.finishJob(job.id, "failed", null, `studio upgrade driver threw: ${String(e)}`);
      }),
    );
    // 202 without ok:true (cp#20): ACCEPTED, not completed. The readback lands on the job row.
    return json({ job_id: job.id, from_release: tenant.studio_release, to_release: release }, 202);
  }

  // ---- cp#112: give an EXISTING tenant a studio-level binding ----------------------------------
  //
  // WHY ADMIN-GATED: it is an operator action on someone else studio, exactly like teardown and
  // upgrade-modules. The tenant asked for nothing and sees no new surface.
  //
  // WHY INLINE rather than a job: the answer IS the evidence (the before/after binding and secret
  // census), it is one API call plus two reads, and a job row would put the readback somewhere the
  // operator has to go looking for. Same reasoning the teardown route records.
  //
  // WHY NO confirm_slug: this is not destructive. It adds a binding, changes no bytes, no release,
  // and no status. The refusals below are what keep it from running where it makes no sense.
  const bindings = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/refresh-studio-bindings$/.exec(path);
  if (request.method === "POST" && bindings) {
    if (!deps.provisioner) return err("provisioner_unconfigured", 503);
    const tenant = await deps.store.getTenantById(bindings[1]);
    if (!tenant) return err("not_found", 404);

    // One writer at a time on this row. A provision or module upgrade with a live driver is already
    // PUTting at this tenant scripts; a binding patch landing mid-provision would race the upload
    // that owns the binding set.
    const latest = await deps.store.getLatestJobForTenant(tenant.id);
    if (latest && jobHasLiveDriver(latest, deps.now())) {
      return err("job_in_progress", 409, { job_id: latest.id, kind: latest.kind });
    }

    let outcome;
    try {
      outcome = await deps.provisioner.refreshStudioBindings(tenant);
    } catch (e) {
      // A NAMED failure (the plane credential cannot attach a VPC binding) answers with its own
      // code and message rather than falling into the generic 500, which would hide the one fact
      // the operator needs: nothing about the tenant is wrong.
      if (e instanceof StudioBindingError) return err(e.code, e.status, { message: e.message });
      throw e;
    }
    if (!outcome.ok) return err(outcome.refusal.code, outcome.refusal.status, { message: outcome.refusal.message });

    const result = outcome.result;
    await deps.store.recordAdminAction(
      actor,
      "tenant.refresh_studio_bindings",
      tenant.id,
      JSON.stringify({
        ok: result.ok,
        already_present: result.already_present,
        service_id: result.service_id,
        missing_bindings: result.missing_bindings,
        missing_secrets: result.missing_secrets,
      }),
    );

    // 409 when the readback is short. A 200 carrying ok:false reads as success to anything that
    // checks status codes, and a tenant that lost a binding or a secret is the one outcome this
    // route exists to make impossible to miss.
    return json({ tenant_id: tenant.id, slug: tenant.slug, ...result }, result.ok ? 200 : 409);
  }

  // ---- cp#136 (criterion 3): ATTACH or DETACH the video-finish tier binding -------------------
  //
  // WHY THIS EXISTS. Every other binding writer in this plane either attaches the tier or preserves
  // it, so a tenant that HAS it could never be returned to the tier-absent state the panel sentence
  // describes. The drill proved it on the testbed: the mark refused with `studio_reader_absent`
  // because the studio serves `{}` -- tier bound, observed available, correctly so. Without a detach
  // the acceptance criterion (a human READS the sentence on a live studio) has no honest path.
  //
  // ONE VERB, TWO DIRECTIONS, and the attach direction is the EXISTING cp#112 call rather than a
  // second implementation. That is what makes "reattach restores exactly what a refresh produces"
  // true by identity instead of by imitation, and it means the attach side keeps its own refusals
  // (an unconfigured plane still cannot attach a tier it has no service id for).
  //
  // WHY ADMIN-GATED and WHY INLINE: same answers as the two routes above. The answer IS the
  // evidence, and it changes no bytes, no release, and no status.
  const vfBinding = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/video-finish-binding$/.exec(path);
  if (request.method === "POST" && vfBinding) {
    if (!deps.provisioner) return err("provisioner_unconfigured", 503);
    const tenant = await deps.store.getTenantById(vfBinding[1]);
    if (!tenant) return err("not_found", 404);

    const body = (await readJson(request)) as { attached?: boolean } | null;
    if (typeof body?.attached !== "boolean") return err("invalid_body", 400);

    // One writer at a time on this row, exactly as the two routes above guard it.
    const latest = await deps.store.getLatestJobForTenant(tenant.id);
    if (latest && jobHasLiveDriver(latest, deps.now())) {
      return err("job_in_progress", 409, { job_id: latest.id, kind: latest.kind });
    }

    let outcome;
    try {
      outcome = body.attached
        ? await deps.provisioner.refreshStudioBindings(tenant)
        : await deps.provisioner.detachStudioBinding(tenant);
    } catch (e) {
      if (e instanceof StudioBindingError) return err(e.code, e.status, { message: e.message });
      throw e;
    }
    if (!outcome.ok) return err(outcome.refusal.code, outcome.refusal.status, { message: outcome.refusal.message });

    const result = outcome.result;
    await deps.store.recordAdminAction(
      actor,
      body.attached ? "tenant.attach_video_finish_binding" : "tenant.detach_video_finish_binding",
      tenant.id,
      JSON.stringify({
        ok: result.ok,
        missing_bindings: result.missing_bindings,
        missing_secrets: result.missing_secrets,
      }),
    );

    // 409 when the readback disagrees, for the same reason as its siblings: a 200 carrying ok:false
    // reads as success to anything that checks status codes.
    return json({ tenant_id: tenant.id, slug: tenant.slug, attached: body.attached, ...result }, result.ok ? 200 : 409);
  }

  // ---- cp#136: DECLARE a tenant unreachable for the video-finish tier (or un-declare it) --------
  //
  // WHY THE ROUTE EXISTS. vivijure-cf resolves three states for the tier and reads the third off the
  // studio var VIDEO_FINISH_TIER_STATE. Nothing in this plane wrote that var, so `unprovisionable`
  // could not occur in production and the sentence written for it (cf#243) could never be displayed.
  // This is the writer, and it is a DECLARATION: no plane-side condition derives unreachability (see
  // src/video-finish-tier-state.ts), so a human states it, with a reason, audited like any other
  // operator action.
  //
  // WHY IT IS NOT DERIVED FROM THE TIER BEING DOWN, since that is the tempting wiring: the panel
  // sentence is permanent ("cannot be turned on for it") and an outage is transient. Wiring the two
  // together would tell every tenant the tier can never be turned on, and keep saying it afterwards.
  //
  // WHY ADMIN-GATED and WHY INLINE rather than a job: same answers as refresh-studio-bindings above.
  // It is an operator action on someone else studio, the answer IS the evidence (the binding census
  // plus what the studio now serves), and it changes no bytes, no release, and no status.
  const tierState = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/video-finish-tier-state$/.exec(path);
  if (request.method === "POST" && tierState) {
    if (!deps.provisioner) return err("provisioner_unconfigured", 503);
    const tenant = await deps.store.getTenantById(tierState[1]);
    if (!tenant) return err("not_found", 404);

    const body = (await readJson(request)) as { unreachable?: boolean; reason?: string } | null;
    if (typeof body?.unreachable !== "boolean") return err("invalid_body", 400);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    // A REASON IS MANDATORY when marking. A state nobody can explain is not auditable, and this one
    // makes a studio tell its user a capability can never be turned on for them; the same standard
    // 0010_preservation_holds.sql sets for a hold. Clearing needs none: it removes a claim.
    if (body.unreachable && reason === "") {
      return err("reason_required", 400, {
        message:
          "declaring a studio unreachable requires a reason: it makes the panel tell that tenant the " +
          "tier can never be turned on for them, and a declaration nobody can explain cannot be reviewed",
      });
    }

    // One writer at a time on this row, exactly as the binding refresh guards it: a provision or an
    // upgrade with a live driver is already PUTting at this tenant scripts, and a settings patch
    // landing mid-upload would race the write that owns the binding set.
    const latest = await deps.store.getLatestJobForTenant(tenant.id);
    if (latest && jobHasLiveDriver(latest, deps.now())) {
      return err("job_in_progress", 409, { job_id: latest.id, kind: latest.kind });
    }

    const outcome = await deps.provisioner.setVideoFinishTierState(tenant, {
      unreachable: body.unreachable,
      reason: body.unreachable ? reason : null,
    });
    if (!outcome.ok) return err(outcome.refusal.code, outcome.refusal.status, { message: outcome.refusal.message });

    const result = outcome.result;
    await deps.store.recordAdminAction(
      actor,
      "tenant.set_video_finish_tier_state",
      tenant.id,
      JSON.stringify({
        ok: result.ok,
        unreachable: result.unreachable,
        reason: result.reason,
        var_present_before: result.var_present_before,
        var_present_after: result.var_present_after,
        served_reason_changed: result.served_reason_changed,
        missing_bindings: result.missing_bindings,
        missing_secrets: result.missing_secrets,
      }),
    );

    // 409 when the readback disagrees with the intent. A 200 carrying ok:false reads as success to
    // anything that checks status codes, and "the plane believes it declared something the studio is
    // not carrying" is the one outcome this route exists to make impossible to miss.
    return json({ tenant_id: tenant.id, slug: tenant.slug, ...result }, result.ok ? 200 : 409);
  }

  // ---- cp#164: converge an EXISTING tenant studio onto the abuse-report URL --------------------
  //
  // WHY THIS ROUTE EXISTS. vivijure-cf v1.10.0 ships the reader (host.abuse_report_url on
  // GET /api/modules, rendered by public/abuse-link.js) and this plane wrote the var nowhere, so no
  // tenant studio could show a reporter where to go. The provision path and the studio upgrade now
  // bind it, and BOTH of those only reach a tenant that is new or is having its bytes moved. That is
  // precisely the split-estate shape cp#112 and cp#136 each had to close separately, and closing it
  // for new tenants alone would leave every live tenant permanently unable to display the link.
  //
  // WHY IT IS A BINDING PATCH AND NOT A RE-UPLOAD: the cp#112 answer, unchanged. The plane cannot
  // reproduce two of the four secrets a live tenant studio carries, and a re-upload would move the
  // tenant onto whatever release the plane is pinned to -- a release change smuggled in as a config
  // fix. Bindings only; no bytes, no release, no status.
  //
  // WHY NO BODY: there is nothing to choose. The URL is derived from this deploy's own host, so the
  // operator is not setting a value, they are asking a studio to catch up with the plane.
  //
  // WHY ADMIN-GATED and WHY INLINE rather than a job: same answers as refresh-studio-bindings. It is
  // an operator action on someone else's studio, the tenant asked for nothing, and the answer IS the
  // evidence (the binding census plus what the studio now advertises).
  //
  // WHY NO confirm_slug: it is not destructive. It adds one plain_text binding and changes nothing
  // else; the refusals below are what keep it from running where it makes no sense.
  const abuseUrl = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/abuse-report-url$/.exec(path);
  if (request.method === "POST" && abuseUrl) {
    if (!deps.provisioner) return err("provisioner_unconfigured", 503);
    const tenant = await deps.store.getTenantById(abuseUrl[1]);
    if (!tenant) return err("not_found", 404);

    // One writer at a time on this row, exactly as the binding refresh and the tier-state write
    // guard it: a provision or an upgrade with a live driver is already PUTting at this tenant's
    // scripts, and a settings patch landing mid-upload would race the write that owns the set.
    const latest = await deps.store.getLatestJobForTenant(tenant.id);
    if (latest && jobHasLiveDriver(latest, deps.now())) {
      return err("job_in_progress", 409, { job_id: latest.id, kind: latest.kind });
    }

    const outcome = await deps.provisioner.setAbuseReportUrl(tenant);
    if (!outcome.ok) return err(outcome.refusal.code, outcome.refusal.status, { message: outcome.refusal.message });

    const result = outcome.result;
    await deps.store.recordAdminAction(
      actor,
      "tenant.set_abuse_report_url",
      tenant.id,
      JSON.stringify({
        ok: result.ok,
        url: result.url,
        already_present: result.already_present,
        var_present_after: result.var_present_after,
        reader_live: result.reader_live,
        missing_bindings: result.missing_bindings,
        missing_secrets: result.missing_secrets,
      }),
    );

    // THREE OUTCOMES, and the middle one was learned on the live testbed (cp#164 acceptance run).
    //
    //   200  bound AND the studio serves it. Done.
    //   202  bound, nothing stranded, but the studio had not served it by the end of the confirm
    //        budget. The first cut of this route answered 409 here and told the operator to move the
    //        studio bytes -- and the live run proved that instruction can be flat wrong: the very
    //        first converge on the testbed reported exactly this and the SAME call succeeded sixty
    //        seconds later, unchanged. The binding IS set; either the edge has not picked it up yet
    //        or the bundle predates the reader, and from here those are indistinguishable. So the
    //        answer names both and says re-run, which is cheap because this route is idempotent.
    //        202 is the same shape the invoke-key route already uses for "stored, not yet proven".
    //   409  a genuine strand: a binding or secret present before and absent after. That is the
    //        outcome this route exists to make impossible to miss, and it keeps the hard status.
    //
    // `ok` stays FALSE on the 202 and `reader_live` stays false, so nothing machine-readable claims
    // a success that was not observed.
    const stranded = result.missing_bindings.length > 0 || result.missing_secrets.length > 0;
    const status = result.ok ? 200 : stranded ? 409 : 202;
    return json(
      {
        tenant_id: tenant.id,
        slug: tenant.slug,
        ...result,
        ...(status === 202
          ? {
              message:
                "the binding IS set on this studio and nothing was stranded, but it had not served " +
                `${ABUSE_REPORT_URL_VAR} back within ${result.readback_elapsed_ms}ms ` +
                `(${result.readback_attempts} checks). Either the edge has not picked the binding up ` +
                "yet, or this studio runs a bundle that predates the vivijure-cf v1.10.0 reader. " +
                "Re-run this route to tell them apart: it is idempotent, and a re-run that still " +
                "reports this means the studio bytes need moving (POST .../upgrade-studio).",
            }
          : {}),
      },
      status,
    );
  }

  // ---- cp#183: converge an EXISTING tenant onto this plane's storage ceiling ------------------
  //
  // WHY A ROUTE AND NOT ONLY THE PROVISION PATH. The provision binding caps tenants created from
  // now on and the studio upgrade caps tenants whose bytes move. Every tenant already live on this
  // plane was provisioned before the var existed, so without this they stay uncapped forever, which
  // is the population the cost bound was for. Same shape as the cp#164 converge next door.
  //
  // WHY IT ALSO CONVERGES DOWNWARD. Binding nothing is how a plane that LIFTED its quota lifts it
  // on a live tenant: the var is filtered out of the carried set, so the studio stops enforcing a
  // number nobody configures. That direction has to work or the quota is a one-way door.
  const storageQuota = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/storage-quota$/.exec(path);
  if (request.method === "POST" && storageQuota) {
    if (!deps.provisioner) return err("provisioner_unconfigured", 503);
    const tenant = await deps.store.getTenantById(storageQuota[1]);
    if (!tenant) return err("not_found", 404);

    // One writer at a time on this row, the same guard the abuse-report converge and the binding
    // refresh take: a provision or an upgrade with a live driver is already PUTting at this
    // tenant's scripts, and a settings patch landing mid-upload races the write that owns the set.
    const latest = await deps.store.getLatestJobForTenant(tenant.id);
    if (latest && jobHasLiveDriver(latest, deps.now())) {
      return err("job_in_progress", 409, { job_id: latest.id, kind: latest.kind });
    }

    const outcome = await deps.provisioner.setStorageQuota(tenant);
    if (!outcome.ok) return err(outcome.refusal.code, outcome.refusal.status, { message: outcome.refusal.message });

    const result = outcome.result;
    await deps.store.recordAdminAction(
      actor,
      "tenant.set_storage_quota",
      tenant.id,
      JSON.stringify({
        ok: result.ok,
        quota_bytes: result.quota_bytes,
        already_present: result.already_present,
        var_present_after: result.var_present_after,
        enforced: result.enforced,
        served_quota_before: result.served_quota_before,
        served_quota_after: result.served_quota_after,
        used_bytes: result.used_bytes,
        over_on_arrival: result.over_on_arrival,
        missing_bindings: result.missing_bindings,
        missing_secrets: result.missing_secrets,
      }),
    );

    // THREE OUTCOMES, the cp#164 shape, and the middle one is there because that route learned it
    // on live infra rather than by reasoning:
    //
    //   200  bound AND the studio reports the ceiling it now enforces. Done.
    //   202  bound, nothing stranded, but the studio had not reported the new number by the end of
    //        the confirm budget. Unlike cp#164 this CANNOT be a too-old bundle -- the preflight
    //        already proved the reader exists by reading quota_bytes off it -- so the remaining
    //        cause is an edge that has not picked the binding up. Idempotent, so a re-run is cheap.
    //   409  a genuine strand: a binding or secret present before and absent after.
    //
    // `ok` and `enforced` both stay FALSE on the 202: nothing machine-readable claims a cap that
    // was not observed, which for a cost control is the whole point.
    const stranded = result.missing_bindings.length > 0 || result.missing_secrets.length > 0;
    const status = result.ok ? 200 : stranded ? 409 : 202;
    return json(
      {
        tenant_id: tenant.id,
        slug: tenant.slug,
        ...result,
        ...(status === 202
          ? {
              message:
                `the binding IS set on this studio and nothing was stranded, but it had not reported ` +
                `quota_bytes=${result.quota_bytes ?? "null"} within ${result.readback_elapsed_ms}ms ` +
                `(${result.readback_attempts} checks). The reader is present (the preflight read it), ` +
                "so this is an edge that has not picked the binding up yet. Re-run this route; it is " +
                "idempotent.",
            }
          : {}),
      },
      status,
    );
  }

  // ---- cp#169: hand the OWNER a one-time link to install a fresh invoke key -------------------
  //
  // WHY THIS ROUTE EXISTS SEPARATELY from the reprovision that mints one automatically. A tenant can
  // be stranded at awaiting_invoke_key by a repair that happened before this existed, by a link that
  // expired in a support queue, or by a second reprovision that made an outstanding link stale. All
  // three need a fresh link WITHOUT re-running a repair, and re-running a repair to obtain one would
  // rebuild four endpoints to solve a paperwork problem.
  //
  // WHY IT IS A LINK AND NOT AN ADMIN INSTALL (option 2 on cp#169, deliberately declined): an
  // admin-gated install would let an operator credential place a RunPod key on a customer studio.
  // The ruling keeps the credential decision with the owner and moves only the initiative.
  //
  // WHAT THE OPERATOR GETS BACK is the ONLY time the token exists outside this function. It is not
  // logged, not audited, and cannot be re-read: a lost link is re-minted, never recovered.
  const handoffMint = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/invoke-key-handoff$/.exec(path);
  if (request.method === "POST" && handoffMint) {
    const tenant = await deps.store.getTenantById(handoffMint[1]);
    if (!tenant) return err("not_found", 404);

    const outcome = await mintInvokeKeyHandoff(handoffDeps(deps), tenant, actor, publicOrigin(env));
    if (!outcome.ok) return err(outcome.refusal.code, outcome.refusal.status, { message: outcome.refusal.message });

    // IDS AND AN EXPIRY. The token is deliberately absent from the audit row: a credential-bearing
    // URL in an audit table is a credential in an audit table.
    await deps.store.recordAdminAction(
      actor,
      "tenant.issue_invoke_key_handoff",
      tenant.id,
      JSON.stringify({
        handoff_id: outcome.minted.id,
        expires_at: outcome.minted.expires_at,
        endpoints: outcome.minted.endpoints,
      }),
    );
    return json({ tenant_id: tenant.id, slug: tenant.slug, ...outcome.minted });
  }

  // ---- cp#137: rebuild a tenant's RunPod endpoints, through a plane mechanism ------------------
  //
  // WHY THIS ROUTE EXISTS AT ALL. cp#137's detection half proved a live tenant can point at four
  // endpoints that no longer exist, and the standing ruling on that issue is that the fix goes
  // through a plane mechanism rather than an UPDATE against D1. Correcting the record by hand would
  // move the ids without making them real; this rebuilds the endpoints, re-points every consumer of
  // their ids, and writes the record as a consequence of having done so.
  //
  // WHY confirm_slug, unlike refresh-studio-bindings: this pass REVOKES a live R2 credential and
  // replaces the wiring of a running studio. It is not destructive of customer data, but it is not
  // the kind of thing to run against the tenant one row above the one you meant, and the ids are
  // opaque where the slug is recognisable. Same reasoning, and the same shape, as teardown.
  //
  // KEY A NEVER LANDS ANYWHERE. It arrives in this body, is passed as an argument, and is held by
  // nothing afterwards: no job row (this route deliberately has none), no audit detail, no log line.
  // The audit row below records ids and counts. A failure carries a message the module has already
  // scrubbed of every secret it was holding.
  const reprovisionRunPod = /^\/api\/admin\/tenants\/(ten_[a-f0-9]+)\/reprovision-runpod$/.exec(path);
  if (request.method === "POST" && reprovisionRunPod) {
    if (!deps.provisioner) return err("provisioner_unconfigured", 503);
    const tenant = await deps.store.getTenantById(reprovisionRunPod[1]);
    if (!tenant) return err("not_found", 404);

    const body = (await readJson(request)) as { confirm_slug?: unknown; runpod_api_key?: unknown } | null;
    if (typeof body?.confirm_slug !== "string" || body.confirm_slug.trim() !== tenant.slug) {
      return err("slug_confirmation_required", 400, { slug: tenant.slug });
    }
    // Checked BEFORE anything else that could change state, for the reason the provision route
    // states out loud: discovering a missing key after the first write leaves the caller strictly
    // worse off than the refusal they should have had for free.
    const runpodApiKey = typeof body.runpod_api_key === "string" ? body.runpod_api_key.trim() : "";
    if (!runpodApiKey) {
      return err("runpod_key_required", 400, {
        message:
          "this needs the tenant's own RunPod key A (graphql read/write) to create endpoints on their " +
          "account. It is used once and stored nowhere.",
      });
    }

    // One writer at a time on this row: a provision, module upgrade or studio upgrade with a live
    // driver is already PUTting at these scripts, and a bindings patch landing mid-upload races the
    // upload that owns the binding set.
    const latest = await deps.store.getLatestJobForTenant(tenant.id);
    if (latest && jobHasLiveDriver(latest, deps.now())) {
      return err("job_in_progress", 409, { job_id: latest.id, kind: latest.kind });
    }

    // Preflight FIRST and separately: a refusal here has written nothing at all, which is what lets
    // the honest refusals (not serving, bundle missing, no recorded module release) be cheap.
    const pre = await deps.provisioner.preflightReprovisionRunPod(tenant);
    if (!pre.ok) return err(pre.refusal.code, pre.refusal.status, { message: pre.refusal.message });

    let result;
    try {
      result = await deps.provisioner.reprovisionRunPod(tenant, pre.context, runpodApiKey);
    } catch (e) {
      if (e instanceof ReprovisionError) {
        // The tenant is at awaiting_invoke_key and its studio is still serving. Say which step died
        // and stop; the message is already scrubbed, and a re-run of this same route is the retry.
        await deps.store.recordAdminAction(
          actor,
          "tenant.reprovision_runpod.failed",
          tenant.id,
          JSON.stringify({ step: e.step, message: e.message }),
        );
        return err("reprovision_failed", 409, { step: e.step, message: e.message });
      }
      throw e;
    }

    await deps.store.recordAdminAction(
      actor,
      "tenant.reprovision_runpod",
      tenant.id,
      // IDS AND COUNTS ONLY. Endpoint ids and an R2 token id are identifiers the plane already
      // stores; neither key A nor the minted credential value appears here or anywhere else.
      JSON.stringify({
        endpoints_before: result.endpoints_before.map((e) => e.id),
        endpoints_after: result.endpoints_after.map((e) => e.id),
        templates_changed: result.templates.filter((t) => t.changed).length,
        r2_token_id: result.r2_token_id,
        previous_r2_token_revoked: result.previous_r2_token_revoked,
        modules_release: result.modules_release,
        missing_bindings: result.missing_bindings,
        missing_secrets: result.missing_secrets,
      }),
    );

    // cp#169: THE REPAIR EMITS ITS OWN LAST STEP. Every reprovision ends at awaiting_invoke_key by
    // construction (new endpoints, new ids, the stored key B scoped to the ones just replaced), and
    // until now the operator had no way to complete or to delegate that step: the install route
    // resolves a session. So the successful repair now mints the one-time link in the same response
    // that reports it, bound to the endpoints THIS run created, and the operator hands it to the
    // customer through their support channel.
    //
    // A MINT FAILURE MUST NOT UNDO A SUCCESSFUL REPAIR. The endpoints are rebuilt and the record is
    // written by the time we get here; failing the whole call over a link would report a repair that
    // did happen as a repair that did not, and invite a re-run that rebuilds four endpoints again.
    // So the link is reported as ABSENT with the reason attached, and the standalone mint route above
    // is the retry.
    let handoff: Record<string, unknown> | null = null;
    let handoffRefusal: string | null = null;
    const reread = await deps.store.getTenantById(tenant.id);
    const minted = reread
      ? await mintInvokeKeyHandoff(handoffDeps(deps), reread, actor, publicOrigin(env))
      : null;
    if (minted?.ok) {
      handoff = { ...minted.minted };
      await deps.store.recordAdminAction(
        actor,
        "tenant.issue_invoke_key_handoff",
        tenant.id,
        JSON.stringify({
          handoff_id: minted.minted.id,
          expires_at: minted.minted.expires_at,
          endpoints: minted.minted.endpoints,
          via: "reprovision",
        }),
      );
    } else {
      handoffRefusal = minted ? minted.refusal.code : "tenant_missing";
    }

    // 200 with the readback attached, and NO summary boolean (cp#20): reaching this line already
    // means the studio census came back whole, because a short readback throws at studio_bindings and
    // is answered above as a 409 naming that step. The facts a caller should branch on are `status`
    // (awaiting_invoke_key, every time) and the endpoint ids in `endpoints_after`.
    return json({ ...result, invoke_key_handoff: handoff, invoke_key_handoff_refusal: handoffRefusal });
  }

  // ---- cp#95: STUDIO_TOKEN_KEK rotation -------------------------------------------------------
  //
  // WHY THESE ROUTES EXIST. `tenants.studio_token_enc` is the only customer credential this plane
  // stores as a usable value, and until now the key protecting it could not be changed at all. That
  // made rotation an incident rather than maintenance, and a key you can only rotate under pressure
  // is one you rotate badly. The capability is admin-gated product code with tests, deliberately not
  // a one-off script, because the day it is needed is the worst possible day to be writing it.
  //
  // WHAT IS **NOT** HERE, and why that is the design rather than an omission: generating the new key,
  // installing it, escrowing it, and dropping the old one are all OPERATOR steps outside this
  // Worker. The plane never mints its own KEK. A key generated inside the platform is exactly how
  // the current one came to exist with no owner and no escrow (docs/deploy.md), so the new key is
  // born on an operator box, escrowed BEFORE it is installed, and only then bound. This Worker does
  // the one part an operator cannot: rewrite every ciphertext, and answer honestly whether the old
  // key may now be dropped.
  //
  // WHY NO confirm_slug ON THE SWEEP. It is idempotent and convergent -- run it twice and the second
  // run is a no-op, run it half way and re-run it and it finishes. The dangerous step in a rotation
  // is DROPPING a key, and that step does not live here; it lives behind `safe_to_promote`, which is
  // computed from a full census rather than from the sweep report.
  const kekStatus = path === "/api/admin/kek/status";
  const kekSweep = path === "/api/admin/kek/reencrypt";

  if ((request.method === "GET" && kekStatus) || (request.method === "POST" && kekSweep)) {
    if (!env.STUDIO_TOKEN_KEK) {
      // No primary key means this plane cannot read a single stored token, so a census would report
      // every row unreadable and read like a catastrophe instead of a missing binding.
      return err("kek_unconfigured", 503, {
        message: "STUDIO_TOKEN_KEK is not installed on this deploy; there is no key ring to inspect",
      });
    }
    const ring = studioKekRing(env);

    if (request.method === "GET") {
      // READ ONLY, and safe to hit at any time. The counts are the operator gate for every
      // destructive step that follows, so they are computed from a full walk of the rows every call
      // rather than cached: a stale "safe to promote" is worse than a slow one.
      return json(await kekCensus(deps.store, ring));
    }

    const body = (await readJson(request)) as { limit?: number } | null;
    const limit = typeof body?.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : undefined;
    let sweep;
    try {
      sweep = await sweepReencrypt(deps.store, ring, { limit });
    } catch (e) {
      // The one refusal sweepReencrypt raises is "no window is open", which is an operator
      // configuration answer and not a 500. Anything else is a real fault and rethrows.
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("no rotation window is open")) {
        return err("rotation_window_closed", 409, { message });
      }
      throw e;
    }
    await deps.store.recordAdminAction(
      actor,
      "kek.reencrypt",
      null,
      JSON.stringify({
        encrypt_slot: ring.encryptSlot,
        examined: sweep.examined,
        rotated: sweep.rotated,
        skipped_on_target: sweep.skipped_on_target,
        raced: sweep.raced,
        unreadable: sweep.unreadable,
        complete: sweep.complete,
      }),
    );
    // The CENSUS is returned alongside the sweep report, and it is the one an operator should read.
    // A sweep reporting "rotated: 7" is the writer describing its own work; the census is a fresh
    // read of what is actually stored, and only it decides `safe_to_promote`. Same rule cp#112
    // applies with its independent readback.
    const census = await kekCensus(deps.store, ring);
    // 409 when the run left work behind, for the same reason the binding refresh answers 409 on a
    // short readback: an incomplete rotation returning 200 reads as done to anything checking status
    // codes, and "done" is the one thing it is not.
    return json({ sweep, census }, census.safe_to_promote ? 200 : 409);
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
 * Post-SSO return path. Only same-origin relative paths are kept.
 *
 * The classic `startsWith("/") && !startsWith("//")` check is not enough: browsers treat `\` as `/`
 * in URL paths, so `/\\evil.com` becomes protocol-relative `//evil.com`. Reject backslashes and
 * any `//`, then re-parse against the public origin and demand an origin match.
 */
function safeSameOriginRedirectPath(raw: string | null, origin: string): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.includes("\\") || raw.includes("//")) return null;
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
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
