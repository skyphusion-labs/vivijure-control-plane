// The control plane's data seam (#52).
//
// WHY AN INTERFACE: the repo has no SQL-fidelity test harness and adding one would mean a new dep.
// So data access gets exactly ONE un-stubbable seam: D1Store (store-d1.ts) is what production wires
// and what the live wrangler dev verify exercises against a REAL D1; MemoryStore (tests/) backs the
// logic tests. The rule that keeps this honest: a stubbed store proves a DECISION PATH, never the
// shipped artifact. Anything that must be true of the SQL itself gets verified live, not here.

/**
 * The tenant LIFECYCLE. Note what is NOT in here: "suspended".
 *
 * Suspension is an ORTHOGONAL axis (suspended_at), not a lifecycle state, and that separation is
 * load-bearing rather than stylistic. Storing suspension in this column destroys the lifecycle
 * state it overwrites, so resume has to GUESS where to go back to; guessing "live" silently
 * promoted a never-provisioned tenant to live, complete with a URL to a studio that did not exist
 * (caught on the real box, #52 live verify, not by the unit suite). Two independent facts need two
 * independent columns.
 */
export type TenantLifecycle =
  | "pending"
  | "provisioning"
  | "awaiting_invoke_key"
  | "live"
  | "failed"
  | "deleting"
  | "deleted";

/** What the API projects. "suspended" is computed from suspended_at, never stored in `status`. */
export type TenantStatus = TenantLifecycle | "suspended";

export type AuthProvider = "email" | "google" | "github" | "apple";

export interface Account {
  id: string;
  email: string;
  created_at: string;
  suspended_at: string | null;
  suspended_reason: string | null;
  deleted_at: string | null;
}

export interface Tenant {
  id: string;
  slug: string;
  account_id: string;
  status: TenantLifecycle;
  script_name: string | null;
  d1_database_id: string | null;
  r2_bucket_name: string | null;
  endpoints_json: string | null;
  /** The ID of the bucket-scoped R2 token, never its value. Teardown revokes by this. */
  r2_token_id: string | null;
  studio_release: string | null;
  /** AES-256-GCM(STUDIO_TOKEN_KEK) of the tenant STUDIO_API_TOKEN. The one stored VALUE, encrypted. */
  studio_token_enc: string | null;
  created_at: string;
  live_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  deleted_at: string | null;
}

/**
 * What a Tier A reclaim leaves for the caller to reap (cf#103).
 *
 * A never-live tenant can still carry a HALF-BUILT D1, R2 bucket, R2 token, and worker script from
 * a provision that died partway. Reclaiming the slug blanks those columns, so this handle is the
 * ONLY record of what was there. The caller must tear these down BEFORE calling reclaimSlug; after
 * the reclaim the row no longer knows they existed and nothing will ever reap them.
 *
 * Note what this type does NOT have: a `tier` field. Only Tier A ever produces a handle, so there
 * is no branch here that could confuse a half-built resource with a former customer's live data.
 * That is deliberate -- see the Tier B note on checkSlugAvailability.
 */
export interface ReclaimHandle {
  tenant_id: string;
  d1_database_id: string | null;
  r2_bucket_name: string | null;
  r2_token_id: string | null;
  script_name: string | null;
}

/**
 * The answer to "may THIS account create a studio at THIS slug".
 *
 * `reclaim` non-null means an existing row must be reclaimed rather than inserted: slug is UNIQUE,
 * so the creation path CANNOT go through createTenant here -- that INSERT would fail every time.
 */
export type SlugClaim =
  | { available: true; reclaim: ReclaimHandle | null }
  | { available: false; reason: string };

export interface ProvisionJob {
  id: string;
  tenant_id: string;
  kind: "provision" | "deprovision";
  status: "queued" | "running" | "succeeded" | "failed";
  step: string | null;
  steps_done: string;
  error_step: string | null;
  error_message: string | null;
  attempts: number;
  /** Who is currently driving this job, expressed as when that claim expires (#112). */
  lease_until: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface LoginToken {
  token_hash: string;
  email: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface Session {
  token_hash: string;
  account_id: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface OAuthState {
  state: string;
  provider: string;
  verifier: string | null;
  redirect_to: string | null;
  expires_at: string;
  consumed_at: string | null;
}

/**
 * The Tier A lifecycle set: a tenant that has NOT finished provisioning.
 *
 * SINGLE SOURCE, and it has to be. The tier rule is expressed twice by design -- once in
 * classifySlugClaim (to produce a legible reason) and once in reclaimSlug's SQL WHERE clause (to
 * actually authorize the write). Two hand-written copies of a security predicate drift, and the
 * drift is silent because each side keeps passing its own tests. Both read this constant.
 */
export const TIER_A_STATUSES: readonly TenantLifecycle[] = [
  "pending",
  "provisioning",
  "awaiting_invoke_key",
  "failed",
];

/** The generic refusal. Every tier gives a stranger THIS string and nothing more (enumeration). */
export const SLUG_TAKEN_REASON = "that name is taken";

/**
 * Decide a slug claim from the row alone. Pure, so the tier rules are testable without a database.
 *
 * This function only ever produces a REASON. It never authorizes anything -- reclaimSlug's
 * conditional UPDATE does that, and it re-tests these same rules against the row it is writing.
 */
export function classifySlugClaim(row: Tenant | null, accountId: string): SlugClaim {
  if (!row) return { available: true, reclaim: null };

  // A stranger learns only that the name is unavailable, never which tier it is in.
  if (row.account_id !== accountId) return { available: false, reason: SLUG_TAKEN_REASON };

  const neverLive = row.live_at === null;

  // Tier A: never served anyone, so there is no hostname history to inherit. The owner may retake it.
  if (neverLive && TIER_A_STATUSES.includes(row.status)) {
    return {
      available: true,
      reclaim: {
        tenant_id: row.id,
        d1_database_id: row.d1_database_id,
        r2_bucket_name: row.r2_bucket_name,
        r2_token_id: row.r2_token_id,
        script_name: row.script_name,
      },
    };
  }

  // Tier B: WAS live, now deleted. Tombstoned. Refused for everyone today, owner included --
  // the row cannot tell a reaped resource id from a live one, so this fails closed. See
  // checkSlugAvailability's contract for the full reasoning.
  if (!neverLive && row.status === "deleted") {
    return {
      available: false,
      reason: "that name belonged to a studio that has been deleted, and cannot be reused",
    };
  }

  // Tier C: active, or any shape we have not explicitly blessed (a never-live DELETED row lands
  // here, and refusing it is the safe direction). The owner gets a reason they can act on.
  return { available: false, reason: "you already have a studio at that name" };
}

export interface ControlPlaneStore {
  // accounts + identities
  getAccountById(id: string): Promise<Account | null>;
  getAccountByEmail(email: string): Promise<Account | null>;
  createAccount(id: string, email: string): Promise<Account>;
  getAccountIdByIdentity(provider: AuthProvider, subject: string): Promise<string | null>;
  linkIdentity(provider: AuthProvider, subject: string, accountId: string): Promise<void>;
  touchIdentityLogin(provider: AuthProvider, subject: string): Promise<void>;

  // magic-link tokens (hash only)
  createLoginToken(tokenHash: string, email: string, expiresAt: string): Promise<void>;
  /** Single-use redemption: returns the row ONLY if it consumes it in the same step. */
  consumeLoginToken(tokenHash: string, now: string): Promise<LoginToken | null>;

  // sessions (hash only)
  createSession(tokenHash: string, accountId: string, expiresAt: string): Promise<void>;
  getSession(tokenHash: string, now: string): Promise<Session | null>;
  revokeSession(tokenHash: string, now: string): Promise<void>;

  // oauth round-trip state
  createOAuthState(row: Omit<OAuthState, "consumed_at">): Promise<void>;
  consumeOAuthState(state: string, now: string): Promise<OAuthState | null>;

  // AUP
  hasAcceptedAup(accountId: string, version: string): Promise<boolean>;
  recordAupAcceptance(
    accountId: string,
    version: string,
    /** SHA-256 of the served AUP bytes: the label says what we called it, this says what it said. */
    aupSha256: string,
    ipHash: string | null,
    userAgent: string | null,
  ): Promise<void>;

  // tenants
  getTenantById(id: string): Promise<Tenant | null>;
  getTenantBySlug(slug: string): Promise<Tenant | null>;
  getTenantForAccount(accountId: string): Promise<Tenant | null>;
  /**
   * The slug LEASE check (cf#103). A slug is a lease, not a permanent identity, and which tier a
   * slug falls into is decided by whether its hostname was ever publicly served.
   *
   *   Tier A -- NEVER LIVE (live_at IS NULL, status pending/provisioning/awaiting_invoke_key/failed):
   *     the hostname never served anyone, so the OWNING account may reclaim it. Another account gets
   *     a refusal while the row exists.
   *   Tier B -- WAS LIVE, NOW DELETED (live_at IS NOT NULL, status='deleted'): the slug is
   *     TOMBSTONED to that account. Nobody may reuse it today, INCLUDING the owner -- see below.
   *   Tier C -- ACTIVE (anything else): refused.
   *
   * WHY TIER B REFUSES THE OWNER TOO (deliberate, cf#103): the ruled design grants the owning
   * account a re-create. It is not implementable safely yet. teardownTenant never blanks the
   * resource columns and has no production caller, and R2 refuses to delete a non-empty bucket --
   * which means the typical Tier B row (a studio that WAS live, so it probably rendered) still
   * points at a live bucket holding that customer's films. Nothing on the row distinguishes a
   * reaped id from a live one. So Tier B fails CLOSED until teardown records what it actually
   * reaped. Denying costs nothing today: no route writes status='deleted', so Tier B is currently
   * unreachable in production.
   *
   * A NON-OWNER gets the same generic refusal for every tier on purpose. A tier-specific reason
   * would tell a stranger whether a slug is active, half-built, or a former studio -- the same
   * enumeration oracle the tenant routes avoid by answering 404 instead of 403.
   */
  checkSlugAvailability(slug: string, accountId: string): Promise<SlugClaim>;
  /**
   * Take over an existing Tier A row, atomically. Returns null if it is not yours or no longer
   * qualifies.
   *
   * This is the ENFORCEMENT point, not checkSlugAvailability. Check-then-create is two steps and
   * two concurrent provisions of the same slug both pass the check; for a fresh slug the UNIQUE
   * constraint arbitrates, but for a reclaim nothing does unless the write itself re-tests the
   * tier predicate and the owner. So the tier rules are repeated in this UPDATE's WHERE clause on
   * purpose. The check exists to produce a legible reason, not to authorize.
   *
   * ORDERING REQUIREMENT: this blanks the resource columns. Reap the resources named in the
   * ReclaimHandle FIRST; after this returns, the row no longer knows they existed.
   */
  reclaimSlug(tenantId: string, accountId: string): Promise<Tenant | null>;
  createTenant(id: string, slug: string, accountId: string, status: TenantLifecycle): Promise<Tenant>;
  /** Moves the LIFECYCLE only. Never touches suspension. */
  setTenantStatus(id: string, status: TenantLifecycle): Promise<void>;
  /** The kill switch: orthogonal to lifecycle, so resume restores the real state by itself. */
  suspendTenant(id: string, reason: string): Promise<void>;
  resumeTenant(id: string): Promise<void>;
  listTenants(filter: { status?: string; q?: string }): Promise<Tenant[]>;

  // tenant provisioning writes (#53). Ids and names only; a credential VALUE never lands here.
  setTenantD1(id: string, databaseId: string): Promise<void>;
  setTenantBucket(id: string, bucket: string): Promise<void>;
  setTenantR2Token(id: string, tokenId: string): Promise<void>;
  setTenantEndpoints(id: string, endpointsJson: string): Promise<void>;
  setTenantScript(id: string, scriptName: string, release: string): Promise<void>;
  /** The encrypted per-tenant STUDIO_API_TOKEN value (dispatcher-injected auth). Value, not a hash. */
  setTenantStudioToken(id: string, encValue: string): Promise<void>;

  // provision jobs
  createProvisionJob(id: string, tenantId: string, kind: "provision" | "deprovision"): Promise<ProvisionJob>;
  getLatestJobForTenant(tenantId: string): Promise<ProvisionJob | null>;
  getJob(id: string): Promise<ProvisionJob | null>;
  setJobRunning(id: string): Promise<void>;
  /**
   * Take the driving claim on a job, or report that someone else holds it (#112).
   *
   * This is the whole concurrency story for poll-driven continuation: the client polls every few
   * seconds, so without a claim two overlapping polls would BOTH drive the same job and double-mint
   * credentials. Returns true only for the caller that won the claim.
   */
  claimJob(id: string, leaseSeconds: number): Promise<boolean>;
  updateJobProgress(id: string, step: string, stepsDoneJson: string): Promise<void>;
  finishJob(id: string, status: "succeeded" | "failed", errorStep: string | null, errorMessage: string | null): Promise<void>;

  // settings + audit
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string, updatedBy: string): Promise<void>;
  recordAdminAction(actor: string, action: string, target: string | null, detail: string | null): Promise<void>;
}
