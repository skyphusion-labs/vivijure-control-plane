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
