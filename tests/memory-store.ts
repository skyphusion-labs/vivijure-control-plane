// In-memory ControlPlaneStore for the control-plane logic tests (#52).
//
// WHAT THIS IS FOR, precisely: proving DECISION PATHS (does the gate refuse, is a token single-use,
// does an unverified email get rejected). It is NOT evidence about the shipped artifact. The SQL in
// store-d1.ts is verified against a REAL D1 in the live wrangler dev pass, because a fake store
// encodes my own assumptions about my own SQL and would happily agree with a bug.
//
// It mirrors D1Store's SEMANTICS deliberately, especially the two single-use guards: consume is an
// atomic check-and-set, so a replay finds nothing.

import type {
  Account,
  AuthProvider,
  ControlPlaneStore,
  LoginToken,
  OAuthState,
  ProvisionJob,
  Session,
  Tenant,
  TenantLifecycle,
} from "../src/store";

export class MemoryStore implements ControlPlaneStore {
  accounts = new Map<string, Account>();
  identities = new Map<string, { account_id: string; last_login_at: string | null }>();
  loginTokens = new Map<string, LoginToken>();
  sessions = new Map<string, Session>();
  oauthStates = new Map<string, OAuthState>();
  tenants = new Map<string, Tenant>();
  jobs = new Map<string, ProvisionJob>();
  settings = new Map<string, string>([["signups_enabled", "true"]]);
  audit: { actor: string; action: string; target: string | null; detail: string | null }[] = [];

  private key(p: AuthProvider, s: string) {
    return `${p}:${s}`;
  }

  async getAccountById(id: string) {
    const a = this.accounts.get(id);
    return a && !a.deleted_at ? a : null;
  }
  async getAccountByEmail(email: string) {
    for (const a of this.accounts.values()) if (a.email === email && !a.deleted_at) return a;
    return null;
  }
  async createAccount(id: string, email: string) {
    const a: Account = {
      id,
      email,
      created_at: new Date().toISOString(),
      suspended_at: null,
      suspended_reason: null,
      deleted_at: null,
    };
    this.accounts.set(id, a);
    return a;
  }
  async getAccountIdByIdentity(p: AuthProvider, s: string) {
    return this.identities.get(this.key(p, s))?.account_id ?? null;
  }
  async linkIdentity(p: AuthProvider, s: string, accountId: string) {
    if (!this.identities.has(this.key(p, s))) {
      this.identities.set(this.key(p, s), { account_id: accountId, last_login_at: null });
    }
  }
  async touchIdentityLogin(p: AuthProvider, s: string) {
    const row = this.identities.get(this.key(p, s));
    if (row) row.last_login_at = new Date().toISOString();
  }

  async createLoginToken(token_hash: string, email: string, expires_at: string) {
    this.loginTokens.set(token_hash, { token_hash, email, expires_at, consumed_at: null });
  }
  /** Atomic check-and-set, exactly like the D1 UPDATE guard: a replay updates nothing. */
  async consumeLoginToken(token_hash: string, now: string) {
    const row = this.loginTokens.get(token_hash);
    if (!row || row.consumed_at || row.expires_at <= now) return null;
    row.consumed_at = now;
    return { ...row };
  }

  async createSession(token_hash: string, account_id: string, expires_at: string) {
    this.sessions.set(token_hash, { token_hash, account_id, expires_at, revoked_at: null });
  }
  async getSession(token_hash: string, now: string) {
    const s = this.sessions.get(token_hash);
    if (!s || s.revoked_at || s.expires_at <= now) return null;
    return s;
  }
  async revokeSession(token_hash: string, now: string) {
    const s = this.sessions.get(token_hash);
    if (s && !s.revoked_at) s.revoked_at = now;
  }

  async createOAuthState(row: Omit<OAuthState, "consumed_at">) {
    this.oauthStates.set(row.state, { ...row, consumed_at: null });
  }
  async consumeOAuthState(state: string, now: string) {
    const row = this.oauthStates.get(state);
    if (!row || row.consumed_at || row.expires_at <= now) return null;
    row.consumed_at = now;
    return { ...row };
  }

  aup: { account_id: string; aup_version: string; aup_sha256: string; ip_hash: string | null }[] = [];
  async hasAcceptedAup(account_id: string, version: string) {
    return this.aup.some((r) => r.account_id === account_id && r.aup_version === version);
  }
  async recordAupAcceptance(account_id: string, aup_version: string, aup_sha256: string, ip_hash: string | null) {
    if (!(await this.hasAcceptedAup(account_id, aup_version))) {
      this.aup.push({ account_id, aup_version, aup_sha256, ip_hash });
    }
  }

  async getTenantById(id: string) {
    return this.tenants.get(id) ?? null;
  }
  async getTenantBySlug(slug: string) {
    for (const t of this.tenants.values()) if (t.slug === slug) return t;
    return null;
  }
  async getTenantForAccount(account_id: string) {
    for (const t of this.tenants.values()) if (t.account_id === account_id && t.status !== "deleted") return t;
    return null;
  }
  async createTenant(id: string, slug: string, account_id: string, status: TenantLifecycle) {
    const t: Tenant = {
      id,
      slug,
      account_id,
      status,
      script_name: null,
      d1_database_id: null,
      r2_bucket_name: null,
      endpoints_json: null,
      r2_token_id: null,
      studio_release: null,
      studio_token_enc: null,
      created_at: new Date().toISOString(),
      live_at: null,
      suspended_at: null,
      suspended_reason: null,
      deleted_at: null,
    };
    this.tenants.set(id, t);
    return t;
  }
  async setTenantStatus(id: string, status: TenantLifecycle) {
    const t = this.tenants.get(id);
    if (!t) return;
    t.status = status;
    if (status === "live" && !t.live_at) t.live_at = new Date().toISOString();
  }
  async suspendTenant(id: string, reason: string) {
    const t = this.tenants.get(id);
    if (!t) return;
    t.suspended_at = new Date().toISOString();
    t.suspended_reason = reason;
  }
  async resumeTenant(id: string) {
    const t = this.tenants.get(id);
    if (!t) return;
    t.suspended_at = null;
    t.suspended_reason = null;
  }
  async listTenants(filter: { status?: string; q?: string }) {
    return [...this.tenants.values()].filter(
      (t) =>
        (!filter.status ||
          (filter.status === "suspended" ? t.suspended_at !== null : t.status === filter.status)) &&
        (!filter.q || t.slug.includes(filter.q)),
    );
  }

  async createProvisionJob(id: string, tenant_id: string, kind: "provision" | "deprovision") {
    const j: ProvisionJob = {
      id,
      tenant_id,
      kind,
      status: "queued",
      step: null,
      steps_done: "[]",
      error_step: null,
      error_message: null,
      attempts: 0,
      lease_until: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      finished_at: null,
    };
    this.jobs.set(id, j);
    return j;
  }
  async setTenantD1(id: string, databaseId: string) {
    const t = this.tenants.get(id);
    if (t) t.d1_database_id = databaseId;
  }
  async setTenantBucket(id: string, bucket: string) {
    const t = this.tenants.get(id);
    if (t) t.r2_bucket_name = bucket;
  }
  async setTenantR2Token(id: string, tokenId: string) {
    const t = this.tenants.get(id);
    if (t) t.r2_token_id = tokenId;
  }
  async setTenantEndpoints(id: string, endpointsJson: string) {
    const t = this.tenants.get(id);
    if (t) t.endpoints_json = endpointsJson;
  }
  async setTenantScript(id: string, scriptName: string, release: string) {
    const t = this.tenants.get(id);
    if (t) {
      t.script_name = scriptName;
      t.studio_release = release;
    }
  }
  async setTenantStudioToken(id: string, encValue: string) {
    const t = this.tenants.get(id);
    if (t) t.studio_token_enc = encValue;
  }

  async getJob(id: string) {
    return this.jobs.get(id) ?? null;
  }
  async setJobRunning(id: string) {
    const j = this.jobs.get(id);
    if (j) {
      j.status = "running";
      j.attempts += 1;
    }
  }
  /**
   * Mirrors the D1 predicate: win only if nobody holds a LIVE lease. Modelled faithfully because the
   * whole point of the claim is what happens when two callers race, and a fake that always says yes
   * would make the contention test meaningless.
   */
  async claimJob(id: string, leaseSeconds: number) {
    const j = this.jobs.get(id);
    if (!j) return false;
    if (j.status !== "queued" && j.status !== "running") return false;
    const held = j.lease_until !== null && Date.parse(j.lease_until) > Date.now();
    if (held) return false;
    j.lease_until = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    return true;
  }
  async updateJobProgress(id: string, step: string, stepsDoneJson: string) {
    const j = this.jobs.get(id);
    if (j) {
      j.step = step;
      j.steps_done = stepsDoneJson;
      j.updated_at = new Date().toISOString();
    }
  }
  async finishJob(id: string, status: "succeeded" | "failed", errorStep: string | null, errorMessage: string | null) {
    const j = this.jobs.get(id);
    if (j) {
      j.status = status;
      j.error_step = errorStep;
      j.error_message = errorMessage;
      j.finished_at = new Date().toISOString();
      j.lease_until = null;
    }
  }

  async getLatestJobForTenant(tenant_id: string) {
    const all = [...this.jobs.values()].filter((j) => j.tenant_id === tenant_id);
    return all.length ? all[all.length - 1] : null;
  }

  async getSetting(key: string) {
    return this.settings.get(key) ?? null;
  }
  async setSetting(key: string, value: string) {
    this.settings.set(key, value);
  }
  async recordAdminAction(actor: string, action: string, target: string | null, detail: string | null) {
    this.audit.push({ actor, action, target, detail });
  }
}

/**
 * A recording proxy over a store: journals EVERY argument passed to EVERY method.
 *
 * WHY THIS EXISTS (a real false-confidence bug this suite had): the custody test used to assert
 * that a secret was absent from the store's FINAL state. A sabotage run that deliberately wrote
 * key A into the job row still passed, because the very next progress update overwrote the leaked
 * value before the assertion ran. On a real D1 that write genuinely happened: durable, replicated,
 * in the WAL, readable at that moment. "It was overwritten afterwards" is not a custody property.
 *
 * A credential must never be PASSED to the store at all, so the journal records every call and the
 * assertion runs against the whole history rather than the surviving state.
 */
export function recordingStore<T extends object>(inner: T): { store: T; journal: string[] } {
  const journal: string[] = [];
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        journal.push(`${String(prop)}(${args.map((a) => JSON.stringify(a) ?? String(a)).join(",")})`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as T;
  return { store, journal };
}
