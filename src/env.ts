// Worker Env binding for the vivijure control plane (#52, epic #40).
//
// Hand-authored interface mirroring wrangler.control-plane.toml.example, per the standing rule.
// Adding a binding: update the wrangler config, then mirror it here.
//
// This is DELIBERATELY not an extension of the studio's src/env.ts. The control plane and the
// studio are separate Workers with disjoint bindings: the control plane never touches a tenant's
// D1 or R2, and the studio does not know the control plane exists.

import { kekRing, type KekRing } from "./token-crypto";

/** CF rate-limit binding (same shape the studio uses in src/rate-limit.ts). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface ControlPlaneEnv extends SmokeRenderBoundEnv {
  // The front-door UI (Joan, #58), served via Workers Assets. Bundle lives at hosted/public, kept
  // separate from public/ (the studio frontend that ships to every self-hoster).
  ASSETS: Fetcher;

  // Control-plane D1. PLATFORM data only; never tenant studio data.
  CP_DB: D1Database;

  // Tenant studios: the Workers-for-Platforms dispatch namespace (#55). Each tenant is a user
  // Worker in it, named tenant-<slug>-studio. Routing resolves it per request:
  //   env.TENANT_DISPATCH.get(script).fetch(freshRequest(req))
  // DANGLING-BINDING HAZARD: the namespace must EXIST before this Worker deploys, or the deploy
  // fails. typecheck cannot catch that; only a real deploy can.
  TENANT_DISPATCH: DispatchNamespace;

  // Tenant MODULE workers (cf#99) live in a SEPARATE dispatch namespace. Bound here as of cf#114:
  // the invoke-key route probes each module script GET /ready before flipping a tenant live, and a
  // dispatch binding is the only way to reach a script that has no public route.
  //
  // OPTIONAL, and precisely about what that buys: it does NOT make a fresh-account deploy safe. A
  // binding to a namespace that does not exist fails in Cloudflare's toml validation, where this
  // type has no reach at all, and the shipped wrangler example carries the binding uncommented. The
  // case it DOES cover is a deployed config that omits the binding entirely (an older toml): the
  // probe then reports the modules unverifiable, with the missing binding named in the detail,
  // instead of silently reporting a false pass.
  //
  // DEPLOY ORDER (the runbook is authoritative, docs/deploy-runbook.md): binding the control plane
  // to this namespace closes the bootstrap the provisioner used to provide -- it creates the
  // namespace lazily, but it cannot run until the plane deploys, and the plane cannot deploy until
  // the namespace exists. On a fresh account the namespace must be created out of band FIRST.
  TENANT_MODULE_DISPATCH?: DispatchNamespace;

  // ---- vars (public identifiers, not secrets) ----

  /** Current AUP version. Bumping this re-gates every account on their next request. */
  AUP_VERSION: string;
  /** Where the AUP text lives (Ernst, #57). The control plane holds no opinion on the words. */
  AUP_URL: string;
  /**
   * e.g. "studio.vivijure.com". THE single source of the deployment's hostname, shared with
   * routing (#55). PUBLIC_ORIGIN and the tenant domain suffix are DERIVED from it, never
   * configured alongside it: three names for one fact is a drift generator, and a mismatch between
   * them fails only in production. Never a literal in code (parity: a hardcoded hostname makes
   * running a competing hosted vivijure structurally impossible).
   */
  CONTROL_PLANE_HOST: string;

  /** postern send door (POST /api/send). Var: it is a URL, not a secret. */
  POSTERN_SEND_URL?: string;

  /**
   * Credit enforcement (cp#189). Absent, or anything non-affirmative, = COUNTING MODE: the ledger
   * records and refuses nothing.
   *
   * Deliberately NOT fail-closed by default, against the usual reflex and for a reason specific to
   * this knob: no purchase door exists yet, so no tenant CAN hold a positive balance, and enforcing
   * by default would refuse every submission on every tenant the instant the migration lands. The
   * dangerous direction here is not "spends without paying", it is "a studio that stops working for
   * reasons nobody configured". Full argument at parseEnforcing() in credits.ts.
   */
  CREDITS_ENFORCING?: string;

  /**
   * Ceiling on ONE operator credit, in micro-USD. Unset = the documented default (USD 100).
   *
   * A typo catcher, not a policy: nobody ruled a maximum comp, and the hazard being bounded is a
   * stray keystroke turning USD 10.00 into USD 10,000.00 on the one surface that mints money from
   * nothing. Above it the route refuses and names this knob, so a genuinely large credit is a
   * deliberate act with a config change behind it.
   */
  MANUAL_CREDIT_CEILING_MICRO_USD?: string;

  // SSO client identifiers. A provider is OFFERED only when its id AND secret are both present,
  // which is what makes /api/platform/config a projection rather than a hardcoded list.
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  // Apple seam: parked until Conrad stages Team ID + Services ID + .p8. Present here so the day
  // they land is a config change, not a code change.
  APPLE_TEAM_ID?: string;
  APPLE_SERVICES_ID?: string;

  // ---- secrets ----

  /** postern bearer for the send door. The sender identity is BOUND to this token by postern's
   *  registry (POSTERN_SEND_IDENTITIES) and `from` is authoritative there, so we never pass one. */
  POSTERN_SEND_TOKEN?: string;

  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /** The Apple .p8 signing key. Parked with the rest of the Apple seam. */
  APPLE_PRIVATE_KEY?: string;

  /** Admin gate. Bearer, compared constant-time; mirrors the studio's proven token gate. */
  CONTROL_PLANE_ADMIN_TOKEN?: string;

  /**
   * Mints tenant D1 + R2 + WfP uploads AND the per-tenant bucket tokens. Must be the
   * DASHBOARD-created credential (an API-created token is refused token-management rights, so it
   * cannot mint; see token-minter.ts). Provisioning is refused (503) while this is unset.
   */
  CF_PROVISIONER_TOKEN?: string;
  /**
   * The SCRIPT-UPLOAD credential (cf#118), separate from the provisioner on purpose.
   *
   * Attaching a Workers VPC binding needs Connectivity Directory access, and CF will not let an
   * API-created token mint a token carrying that scope -- so the capability could not be added to
   * the provisioner credential the way the R2 mint was, and the function was split instead:
   * provisioner keeps D1 / R2 / token-mint, `vivijure-cp-worker-upload` owns script upload.
   *
   * OPTIONAL, and its absence is not a degraded mode: script upload falls back to the provisioner
   * credential, which is exactly how this plane worked before the split. It is only REQUIRED when
   * VIDEO_FINISH_VPC_SERVICE_ID is set, because that is the binding it exists to attach.
   */
  CF_WORKER_UPLOAD_TOKEN?: string;
  /**
   * Connectivity Directory service id for the video-finish tier (cf#118). Set it and tenant studios
   * are provisioned with the VIDEO_FINISH_VPC binding, so assemble and mux work for them; leave it
   * unset and they degrade to per-shot clips with the reason stated -- the same honest degrade a
   * self-hoster without the container gets.
   */
  VIDEO_FINISH_VPC_SERVICE_ID?: string;

  // ---- provisioner wiring (#53). ALL of these must be present for provisioning to be offered;
  // a partially configured provisioner refuses (503 provisioner_unconfigured) rather than parking
  // tenants on jobs nothing will ever run. ----

  /** Account id (public identifier, not a secret); CfApi + the tenant R2 S3 endpoint need it. */
  CF_ACCOUNT_ID?: string;
  /** The WfP dispatch namespace NAME for uploads (TENANT_DISPATCH binds it for dispatch only). */
  DISPATCH_NAMESPACE?: string;
  /** The shared dispatch namespace NAME tenant MODULE scripts are uploaded into (cf#99). Distinct
   *  from DISPATCH_NAMESPACE (tenant studios): sharing one would collide script names and put a
   *  module bug inside the tenant blast radius. Required for provisioning (module bridge). */
  TENANT_MODULE_NAMESPACE?: string;
  /** The pinned studio release tag the provisioner ships to every new tenant. */
  STUDIO_RELEASE?: string;
  /** The release-artifact mirror written by studio-release.yml (studio-releases/<tag>/...). */
  STUDIO_RELEASES?: R2Bucket;

  /** Base64 32-byte KEK for AES-256-GCM encryption of per-tenant STUDIO_API_TOKEN values at rest
   *  (token-crypto.ts). A worker secret, never in D1. Required for provisioning under the
   *  dispatcher-injected auth model: absent -> provisioning refuses 503, same as this whole block. */
  STUDIO_TOKEN_KEK?: string;

  /** cp#95: the INCOMING KEK during a rotation window. Present -> the plane can read ciphertext
   *  written under either key, so a rotation never interrupts dispatcher-injected auth. Absent ->
   *  no window is open and the sweep route refuses. A worker secret, exactly like the primary. */
  STUDIO_TOKEN_KEK_NEXT?: string;

  /** cp#95: which installed KEK NEW ciphertext is written under -- "primary" (default) or "next".
   *  A plain VAR, not a secret: it names a key, it is not one. It is config rather than D1 state so
   *  that the re-encryption sweep and the live provision path cannot disagree about the write
   *  direction (that disagreement is what makes a sweep never converge), and so that flipping the
   *  direction of every customer credential is a reviewable deploy rather than a hidden toggle.
   *  "next" with no STUDIO_TOKEN_KEK_NEXT installed REFUSES to encrypt; it never falls back. */
  STUDIO_TOKEN_KEK_ENCRYPT_SLOT?: string;

  // ---- optional ----

  /** Per-tenant daily spend ceiling ($) set as the tenant studio's SPEND_DAILY_CEILING at provision
   *  time. Unset -> the studio's own default applies. A var, not a secret (a public policy number). */
  TENANT_SPEND_DAILY_CEILING?: string;

  /**
   * Per-tenant R2 storage ceiling in BYTES, set as the tenant studio's R2_STORAGE_QUOTA_BYTES at
   * provision time and converged onto existing tenants (cp#183). The studio enforces it at SUBMIT
   * with an honest 507 carrying both real numbers, and fails CLOSED 503 if the quota is set and its
   * own check cannot run (vivijure-core src/storage-quota.ts, core#52).
   *
   * Unset means NO ceiling, and there is deliberately no default in code: the number prices what an
   * operator is willing to carry per tenant, so it is a policy this repo does not get to invent.
   * Same posture as R2_USAGE_ALERT_BYTES.
   *
   * BYTES ONLY, no unit suffixes -- a mis-parsed unit is an order-of-magnitude error on a bill.
   * A value that is not a positive integer is REFUSED by the write paths rather than rounded down
   * to "off", because "typed it wrong" and "wants no ceiling" must not be the same outcome.
   * 107374182400 = 100 GiB.
   */
  TENANT_R2_STORAGE_QUOTA_BYTES?: string;

  /**
   * The AI Gateway slug tenant modules bind as GATEWAY_ID (cf#56). Set it to `vivijure-hosted`, the
   * DEDICATED hosted-tenant gateway (authentication ON, verified: a valid token reaches the provider
   * and a bogus one is refused 401 AT the gateway).
   *
   * Do NOT point this at `skyphusion-llm` -- that is prism gateway. A shared gateway would put every
   * tenant LLM call in the same analytics namespace and defeat the per-tenant attribution this whole
   * seam exists to provide.
   *
   * Unset means no gateway: plan-enhance degrades to the free local Workers AI provider, which is a
   * genuine working fallback rather than a failure.
   */
  TENANT_AI_GATEWAY_ID?: string;

  /**
   * cp#185: the AI Gateway READ credential the per-tenant LLM meter pages logs with. Its permission
   * groups are AI Gateway Read + Metadata Read and NOTHING else (verified with positive and negative
   * controls: 403/401 on everything outside them).
   *
   * SEPARATE from every other credential on this plane on purpose. The provisioner mints and the
   * upload token writes scripts; this one only reads a log stream, so a leak of it exposes usage
   * metadata and no ability to change anything.
   *
   * OPTIONAL, and its absence is an honest OFF rather than a degraded mode: with it unset the meter
   * does not run and writes NO period rows at all. That matters more than it looks. A period row is
   * an assertion that an observation happened, so an unconfigured plane emitting empty periods would
   * manufacture billable-looking windows of zero spend out of a missing secret, which is precisely
   * the under-bill this whole lane is built to prevent. No observation is recorded as no
   * observation.
   */
  AI_GATEWAY_READ_TOKEN?: string;

  /**
   * Alert threshold in BYTES for total R2 across all tenant buckets (cf#56). Unset (or malformed)
   * means no threshold and the admin surface reports usage without an alert verdict, which is the
   * correct default: an operator who has not chosen a number has not asked to be alerted. Parsed by
   * parseThresholdBytes, which refuses 0 deliberately -- a permanent alert is trained-to-ignore.
   */
  R2_USAGE_ALERT_BYTES?: string;

  /** Throttles the outbound-email amplifier (/api/auth/email/start) and provisioning. */
  CP_RATE_LIMIT?: RateLimiter;
}


/**
 * CENSUS CLASSIFICATION (cp#218). The declared intent `scripts/var-census.py` reads.
 *
 * WHY THIS EXISTS. The census used to anchor on the placeholders in `wrangler.toml.example` and
 * assert the other three lists agreed with that set. That catches "declared in some lists, missing
 * from others" and is structurally BLIND to "declared in no list, read in code anyway": all four
 * lists agree, by all omitting it. `CREDITS_ENFORCING` shipped in v1.17.0 that way and never
 * reached the Worker. Census green, deploy green, tests green, feature dead.
 *
 * Closing that needs a distinction this interface does not otherwise carry, because
 * `ControlPlaneEnv` mixes three kinds of thing that reach the Worker by three different routes:
 *
 *   - a VAR is delivered by the four lists (template placeholder, render allowlist, both deploy
 *     render blocks). Anything not named below is one, and it MUST be declared.
 *   - a SECRET is delivered by `wrangler secret put`, out of band, and must NEVER appear in a
 *     tracked deploy list.
 *   - a BINDING is delivered by a wrangler binding table (`[[d1_databases]]`, `[[r2_buckets]]`,
 *     `[[dispatch_namespaces]]`, `assets`, `[[unsafe.bindings]]`), never as a var.
 *
 * The classification is by DELIVERY MECHANISM, not by how sensitive a value looks.
 * `VIDEO_FINISH_VPC_SERVICE_ID` is not a credential, and it is listed as a secret because that is
 * how it is actually installed on the Worker (read back from the live script settings as
 * `secret_text`). Guessing from the type would have got that one wrong in the safe-looking
 * direction, which is the whole reason this is a declaration rather than a heuristic.
 *
 * FLAGGING A SECRET AS A MISSING VAR WOULD BE ACTIVELY WRONG: it invites someone to "fix" the
 * census by putting a credential name into a tracked deploy list. Flagging bindings would put noise
 * on every deploy, and a noisy guard is one people learn to ignore, which is worse than the gap.
 *
 * ADDING A FIELD. Add it to one of these lists, or declare it in the four var lists. There is no
 * third option and no silent one: a field in neither is a census FAILURE, because silence is the
 * bug this exists to catch.
 *
 * `satisfies` is load-bearing. It makes tsc reject a name that is not a field of the interface, so
 * a renamed or deleted field cannot leave a stale entry sitting here looking like coverage.
 */
export const ENV_SECRETS = [
  "POSTERN_SEND_TOKEN",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "APPLE_PRIVATE_KEY",
  "CONTROL_PLANE_ADMIN_TOKEN",
  "CF_PROVISIONER_TOKEN",
  "CF_WORKER_UPLOAD_TOKEN",
  "VIDEO_FINISH_VPC_SERVICE_ID",
  // cp#185, classified from the tracked evidence rather than from the name: docs/deploy.md records
  // it as "worker secret, wrangler secret put" and its owners row says it is not yet installed on
  // the Worker. So the delivery mechanism is out of band, and the census must NOT ask for it in a
  // deploy list. This entry is the census meeting new code on its first merge and being told the
  // answer, which is the whole point of a declaration.
  "AI_GATEWAY_READ_TOKEN",
  "STUDIO_TOKEN_KEK",
  "STUDIO_TOKEN_KEK_NEXT",
] as const satisfies readonly (keyof ControlPlaneEnv)[];

export const ENV_BINDINGS = [
  "ASSETS",
  "CP_DB",
  "TENANT_DISPATCH",
  "TENANT_MODULE_DISPATCH",
  "STUDIO_RELEASES",
  "CP_RATE_LIMIT",
] as const satisfies readonly (keyof ControlPlaneEnv)[];

/**
 * cp#95: the KEK ring this deploy runs on, DERIVED in one place.
 *
 * Every reader of the studio-token keys goes through here -- dispatch injection (routing.ts), the
 * provisioner, the smoke client, and the rotation routes. One derivation means the write direction
 * cannot be read differently by two call sites, and two call sites disagreeing about which key is
 * being written is exactly what makes a rotation sweep chase its own tail.
 *
 * `STUDIO_TOKEN_KEK` is optional in this interface, so an unconfigured plane yields a ring with an
 * empty primary. That is safe rather than lucky: the provisioner wiring returns undefined without
 * the secret, and dispatch injection tests the secret before it ever builds a ring.
 */
export const studioKekRing = (env: ControlPlaneEnv): KekRing =>
  kekRing(env.STUDIO_TOKEN_KEK ?? "", env.STUDIO_TOKEN_KEK_NEXT, env.STUDIO_TOKEN_KEK_ENCRYPT_SLOT);

/** The front door origin. Derived, so it can never disagree with routing's root host. */
export const publicOrigin = (env: ControlPlaneEnv): string => `https://${env.CONTROL_PLANE_HOST}`;

/** Tenant studios live at <slug><suffix>. Derived from the same single fact. */
export const tenantDomainSuffix = (env: ControlPlaneEnv): string => `.${env.CONTROL_PLANE_HOST}`;

/**
 * OPERATOR SMOKE-RENDER BOUNDS (cp#45). All optional, all vars rather than secrets -- they are
 * policy numbers, not credentials. Unset means the DEFAULT applies (src/smoke-render.ts), never
 * that the bound is off: this route costs GPU by definition, so there is no unbounded mode.
 */
export interface SmokeRenderBoundEnv {
  /** Seconds before the same tenant may be smoke-rendered again. Default 1800. */
  SMOKE_RENDER_COOLDOWN_SECONDS?: string;
  /** Ceiling on operator smoke renders across ALL tenants in a rolling 24h. Default 20. */
  SMOKE_RENDER_DAILY_CAP?: string;
  /** How long a running smoke render blocks a new one for that tenant, and its own deadline.
   *  Default 1200. */
  SMOKE_RENDER_INFLIGHT_SECONDS?: string;
}
