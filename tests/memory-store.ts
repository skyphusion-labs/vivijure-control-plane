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
  SlugClaim,
  SmokeRender,
  SmokeRenderArtifact,
  SmokeRenderBounds,
  TenantResourceKind,
  TenantResourceRefs,
  ResourceReferrer,
} from "../src/store";
import { classifySlugClaim, leaseIsLive, TIER_A_STATUSES } from "../src/store";

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
  async checkSlugAvailability(slug: string, account_id: string): Promise<SlugClaim> {
    const claim = classifySlugClaim(await this.getTenantBySlug(slug), account_id);
    if (!claim.available || !claim.reclaim) return claim;
    if (this.hasLiveProvisionLease(claim.reclaim.tenant_id)) {
      return { available: false, reason: "that name is still being set up; try again in a minute" };
    }
    return claim;
  }

  /** Mirrors the D1 predicate, including WHICH job states count and that an EXPIRED lease does not. */
  private hasLiveProvisionLease(tenantId: string): boolean {
    for (const j of this.jobs.values()) {
      if (j.tenant_id !== tenantId) continue;
      if (j.status !== "queued" && j.status !== "running") continue;
      if (j.lease_until !== null && Date.parse(`${j.lease_until.replace(" ", "T")}Z`) > Date.now()) return true;
    }
    return false;
  }

  /**
   * Mirrors D1Store.reclaimSlug's WHERE clause, including the parts that REFUSE. A stub that only
   * models the success path would let a not-yours reclaim pass in CI and fail on real D1.
   */
  async claimReclaim(
    tenantId: string,
    accountId: string,
    leaseSeconds: number,
  ): Promise<{ tenant: Tenant; lease_token: string } | null> {
    const t = this.tenants.get(tenantId);
    if (!t) return null;
    if (t.account_id !== accountId) return null;
    if (t.live_at !== null) return null;
    if (!TIER_A_STATUSES.includes(t.status)) return null;
    if (this.hasLiveProvisionLease(tenantId)) return null;
    // An expired or absent lease is free, same as the D1 statement. Self-healing.
    if (leaseIsLive(t.reclaim_lease_until, Date.now())) return null;
    const token = `tok_${this.leaseSeq++}`;
    t.reclaim_lease_token = token;
    t.reclaim_lease_until = new Date(Date.now() + leaseSeconds * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    return { tenant: { ...t }, lease_token: token };
  }

  private leaseSeq = 1;

  async reclaimSlug(tenantId: string, accountId: string, leaseToken: string): Promise<Tenant | null> {
    const t = this.tenants.get(tenantId);
    if (!t) return null;
    if (t.account_id !== accountId) return null;
    if (t.live_at !== null) return null;
    if (!TIER_A_STATUSES.includes(t.status)) return null;
    // Refuse under a live driver, same as the D1 statement's NOT EXISTS clause.
    if (this.hasLiveProvisionLease(tenantId)) return null;
    // Must hold YOUR OWN live lease: the loser of the claim must not blank the winner's row.
    if (t.reclaim_lease_token !== leaseToken) return null;
    if (!leaseIsLive(t.reclaim_lease_until, Date.now())) return null;
    t.reclaim_lease_until = null;
    t.reclaim_lease_token = null;
    t.status = "pending";
    t.d1_database_id = null;
    t.r2_bucket_name = null;
    t.r2_token_id = null;
    t.script_name = null;
    t.endpoints_json = null;
    t.studio_release = null;
    t.modules_release = null;
    t.studio_token_enc = null;
    // live_at deliberately untouched: monotonic, so the tombstone can only get stricter.
    return { ...t };
  }

  async createTenant(id: string, slug: string, account_id: string, status: TenantLifecycle) {
    // The UNIQUE(slug) constraint from migrations/0001_init.sql, enforced here on purpose.
    // Without it this stub encodes OUR assumption instead of the database rule, and a slug-reclaim
    // path goes green in CI then violates the constraint the first time it touches real D1.
    // store.ts says it plainly: a stubbed store proves a DECISION PATH, never the shipped artifact.
    // The one rule this stub MUST carry is the one the creation path is arbitrated by.
    for (const existing of this.tenants.values()) {
      if (existing.slug === slug) {
        throw new Error(`UNIQUE constraint failed: tenants.slug (${slug})`);
      }
    }
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
      modules_release: null,
      studio_token_enc: null,
      created_at: new Date().toISOString(),
      live_at: null,
      suspended_at: null,
      suspended_reason: null,
      deleted_at: null,
      reclaim_lease_until: null,
      reclaim_lease_token: null,
      teardown_at: null,
      teardown_failures: null,
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
      from_release: null,
      to_release: null,
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
  async setTenantModulesRelease(id: string, release: string | null) {
    const t = this.tenants.get(id);
    if (t) t.modules_release = release;
  }

  // ---- #23: teardown record + referential guard ------------------------------------------------
  async clearTenantResource(id: string, resource: TenantResourceKind) {
    const t = this.tenants.get(id);
    if (!t) return;
    if (resource === "d1") t.d1_database_id = null;
    else if (resource === "r2_bucket") t.r2_bucket_name = null;
    else if (resource === "r2_token") t.r2_token_id = null;
    else if (resource === "worker") t.script_name = null;
    else throw new Error(`unknown tenant resource kind: ${resource}`);
  }

  async recordTeardown(id: string, failures: { resource: string; error: string }[]) {
    const t = this.tenants.get(id);
    if (!t) return;
    t.teardown_at = new Date().toISOString();
    t.teardown_failures = JSON.stringify(failures);
  }

  async findResourceReferrers(
    exceptTenantId: string,
    resources: TenantResourceRefs,
  ): Promise<ResourceReferrer[]> {
    const out: ResourceReferrer[] = [];
    for (const t of this.tenants.values()) {
      if (t.id === exceptTenantId) continue;
      const hit = (resource: TenantResourceKind) =>
        out.push({ tenant_id: t.id, slug: t.slug, status: t.status, resource });
      if (resources.d1_database_id && t.d1_database_id === resources.d1_database_id) hit("d1");
      if (resources.r2_bucket_name && t.r2_bucket_name === resources.r2_bucket_name) hit("r2_bucket");
      if (resources.r2_token_id && t.r2_token_id === resources.r2_token_id) hit("r2_token");
      if (resources.script_name && t.script_name === resources.script_name) hit("worker");
    }
    return out;
  }
  async createModuleUpgradeJob(id: string, tenant_id: string, fromRelease: string | null, toRelease: string) {
    const j: ProvisionJob = {
      id,
      tenant_id,
      kind: "module_upgrade",
      status: "queued",
      step: null,
      steps_done: "[]",
      error_step: null,
      error_message: null,
      attempts: 0,
      lease_until: null,
      from_release: fromRelease,
      to_release: toRelease,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      finished_at: null,
    };
    this.jobs.set(id, j);
    return j;
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
    if (!j) return;
    const held = j.lease_until !== null && Date.parse(`${j.lease_until.replace(" ", "T")}Z`) > Date.now();
    if (held) return;
    j.status = "running";
    j.attempts += 1;
    j.lease_until = new Date(Date.now() + 60_000).toISOString().replace("T", " ").slice(0, 19);
    j.updated_at = j.lease_until;
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
      j.updated_at = new Date().toISOString().replace("T", " ").slice(0, 19);
      j.lease_until = new Date(Date.now() + 60_000).toISOString().replace("T", " ").slice(0, 19);
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

  // ---- operator smoke renders (cp#45) ----
  //
  // MIRRORS D1Store's SEMANTICS, and is NOT evidence about the shipped SQL. The conditional INSERT
  // that actually enforces the spend guard lives in store-d1.ts and is exercised against real
  // SQLite in tests/store-d1-sql.test.ts. What these prove is the DECISION path: that the route
  // refuses when a bound is hit and that a terminal outcome is written once.
  //
  // Timestamps are written in D1's "YYYY-MM-DD HH:MM:SS" UTC shape rather than ISO, deliberately:
  // the deadline logic parses created_at, so a fake writing a different shape would test a string
  // production never sees.
  smokeRenders = new Map<string, SmokeRender>();

  private sqliteNow(offsetMs = 0): string {
    return new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);
  }

  private secondsSince(stamp: string): number {
    return (Date.now() - Date.parse(`${stamp.replace(" ", "T")}Z`)) / 1000;
  }

  private smokeFor(tenantId: string): SmokeRender[] {
    return [...this.smokeRenders.values()].filter((s) => s.tenant_id === tenantId);
  }

  async openSmokeRender(
    id: string,
    tenantId: string,
    modulesRelease: string | null,
    bounds: SmokeRenderBounds,
  ): Promise<SmokeRender | null> {
    if (await this.describeSmokeRenderRefusal(tenantId, bounds)) return null;
    const row: SmokeRender = {
      id,
      tenant_id: tenantId,
      status: "running",
      modules_release: modulesRelease,
      studio_job_id: null,
      bundle_key: null,
      artifact_key: null,
      artifact_bytes: null,
      artifact_sha256: null,
      artifact_content_type: null,
      error_message: null,
      created_at: this.sqliteNow(),
      updated_at: this.sqliteNow(),
      finished_at: null,
    };
    this.smokeRenders.set(id, row);
    return row;
  }

  async describeSmokeRenderRefusal(tenantId: string, bounds: SmokeRenderBounds): Promise<string | null> {
    const mine = this.smokeFor(tenantId);
    const inFlight = mine.find(
      (s) => s.status === "running" && this.secondsSince(s.created_at) < bounds.inFlightSeconds,
    );
    if (inFlight) return `a smoke render is already running for this tenant (${inFlight.id})`;

    const recent = mine
      .filter((s) => this.secondsSince(s.created_at) < bounds.cooldownSeconds)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (recent) {
      return (
        `this tenant had a smoke render at ${recent.created_at}; the cooldown is ` +
        `${bounds.cooldownSeconds}s and it has not elapsed`
      );
    }

    const day = [...this.smokeRenders.values()].filter((s) => this.secondsSince(s.created_at) < 86400).length;
    if (day >= bounds.dailyCap) {
      return `the platform-wide smoke-render cap of ${bounds.dailyCap} per 24h has been reached`;
    }
    return null;
  }

  async getSmokeRender(id: string): Promise<SmokeRender | null> {
    return this.smokeRenders.get(id) ?? null;
  }

  async setSmokeRenderSubmitted(id: string, studioJobId: string, bundleKey: string): Promise<void> {
    const row = this.smokeRenders.get(id);
    if (!row) return;
    row.studio_job_id = studioJobId;
    row.bundle_key = bundleKey;
    row.updated_at = this.sqliteNow();
  }

  async finishSmokeRender(
    id: string,
    outcome: { status: "succeeded"; artifact: SmokeRenderArtifact } | { status: "failed"; error: string },
  ): Promise<void> {
    const row = this.smokeRenders.get(id);
    // Guarded on running, exactly like the SQL: a late poll must not overwrite a recorded outcome.
    if (!row || row.status !== "running") return;
    if (outcome.status === "succeeded") {
      row.status = "succeeded";
      row.artifact_key = outcome.artifact.key;
      row.artifact_bytes = outcome.artifact.bytes;
      row.artifact_sha256 = outcome.artifact.sha256;
      row.artifact_content_type = outcome.artifact.contentType;
    } else {
      row.status = "failed";
      row.error_message = outcome.error;
    }
    row.updated_at = this.sqliteNow();
    row.finished_at = this.sqliteNow();
  }

  /** TEST SEAM: age a smoke render backwards, so cooldown and deadline paths are reachable. */
  ageSmokeRender(id: string, seconds: number): void {
    const row = this.smokeRenders.get(id);
    if (!row) throw new Error(`no smoke render ${id}`);
    row.created_at = this.sqliteNow(-seconds * 1000);
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
