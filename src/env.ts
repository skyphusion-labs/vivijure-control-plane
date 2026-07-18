// Worker Env binding for the vivijure control plane (#52, epic #40).
//
// Hand-authored interface mirroring wrangler.control-plane.toml.example, per the standing rule.
// Adding a binding: update the wrangler config, then mirror it here.
//
// This is DELIBERATELY not an extension of the studio's src/env.ts. The control plane and the
// studio are separate Workers with disjoint bindings: the control plane never touches a tenant's
// D1 or R2, and the studio does not know the control plane exists.

/** CF rate-limit binding (same shape the studio uses in src/rate-limit.ts). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface ControlPlaneEnv {
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

  // ---- optional ----

  /** Per-tenant daily spend ceiling ($) set as the tenant studio's SPEND_DAILY_CEILING at provision
   *  time. Unset -> the studio's own default applies. A var, not a secret (a public policy number). */
  TENANT_SPEND_DAILY_CEILING?: string;

  /** Throttles the outbound-email amplifier (/api/auth/email/start) and provisioning. */
  CP_RATE_LIMIT?: RateLimiter;
}

/** The front door origin. Derived, so it can never disagree with routing's root host. */
export const publicOrigin = (env: ControlPlaneEnv): string => `https://${env.CONTROL_PLANE_HOST}`;

/** Tenant studios live at <slug><suffix>. Derived from the same single fact. */
export const tenantDomainSuffix = (env: ControlPlaneEnv): string => `.${env.CONTROL_PLANE_HOST}`;
