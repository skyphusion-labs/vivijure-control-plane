// The D1 implementation of ControlPlaneStore (#52).
//
// This is the artifact that SHIPS. It is the un-stubbable seam: production wires it, and the live
// wrangler dev verify drives these exact statements against a real D1 built from
// migrations/0001_init.sql. The in-memory store in tests/ never substitutes for that.

import type {
  Account,
  AuthProvider,
  ControlPlaneStore,
  LoginToken,
  OAuthState,
  ProvisionJob,
  Session,
  SlugClaim,
  Tenant,
  TenantLifecycle,
} from "./store";
import { classifySlugClaim, TIER_A_STATUSES } from "./store";

/**
 * How long one driver holds a job (#112). Sized to a single invocation, not to a whole provision:
 * the point is that a driver which dies frees the job quickly enough for the next poll to resume it.
 */
export const JOB_LEASE_SECONDS = 60;

export class D1Store implements ControlPlaneStore {
  constructor(private readonly db: D1Database) {}

  // ---- accounts + identities ----

  async getAccountById(id: string): Promise<Account | null> {
    return await this.db
      .prepare("SELECT * FROM accounts WHERE id = ?1 AND deleted_at IS NULL")
      .bind(id)
      .first<Account>();
  }

  async getAccountByEmail(email: string): Promise<Account | null> {
    return await this.db
      .prepare("SELECT * FROM accounts WHERE email = ?1 AND deleted_at IS NULL")
      .bind(email)
      .first<Account>();
  }

  async createAccount(id: string, email: string): Promise<Account> {
    const row = await this.db
      .prepare("INSERT INTO accounts (id, email) VALUES (?1, ?2) RETURNING *")
      .bind(id, email)
      .first<Account>();
    if (!row) throw new Error("createAccount: insert returned no row");
    return row;
  }

  async getAccountIdByIdentity(provider: AuthProvider, subject: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT account_id FROM account_identities WHERE provider = ?1 AND subject = ?2")
      .bind(provider, subject)
      .first<{ account_id: string }>();
    return row?.account_id ?? null;
  }

  async linkIdentity(provider: AuthProvider, subject: string, accountId: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO account_identities (provider, subject, account_id) VALUES (?1, ?2, ?3) " +
          "ON CONFLICT (provider, subject) DO NOTHING",
      )
      .bind(provider, subject, accountId)
      .run();
  }

  async touchIdentityLogin(provider: AuthProvider, subject: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE account_identities SET last_login_at = datetime('now') WHERE provider = ?1 AND subject = ?2",
      )
      .bind(provider, subject)
      .run();
  }

  // ---- magic-link tokens ----

  async createLoginToken(tokenHash: string, email: string, expiresAt: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO login_tokens (token_hash, email, expires_at) VALUES (?1, ?2, ?3)")
      .bind(tokenHash, email, expiresAt)
      .run();
  }

  /**
   * Single-use by CONSTRUCTION: the UPDATE is the guard. consumed_at IS NULL in the WHERE clause
   * means a replay of the same link updates zero rows and returns null, even if two redemptions
   * race. Checking-then-updating would leave exactly that race open.
   */
  async consumeLoginToken(tokenHash: string, now: string): Promise<LoginToken | null> {
    return await this.db
      .prepare(
        "UPDATE login_tokens SET consumed_at = ?2 WHERE token_hash = ?1 AND consumed_at IS NULL " +
          "AND expires_at > ?2 RETURNING *",
      )
      .bind(tokenHash, now)
      .first<LoginToken>();
  }

  // ---- sessions ----

  async createSession(tokenHash: string, accountId: string, expiresAt: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?1, ?2, ?3)")
      .bind(tokenHash, accountId, expiresAt)
      .run();
  }

  async getSession(tokenHash: string, now: string): Promise<Session | null> {
    return await this.db
      .prepare(
        "SELECT * FROM sessions WHERE token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2",
      )
      .bind(tokenHash, now)
      .first<Session>();
  }

  async revokeSession(tokenHash: string, now: string): Promise<void> {
    await this.db
      .prepare("UPDATE sessions SET revoked_at = ?2 WHERE token_hash = ?1 AND revoked_at IS NULL")
      .bind(tokenHash, now)
      .run();
  }

  // ---- oauth state ----

  async createOAuthState(row: Omit<OAuthState, "consumed_at">): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO oauth_states (state, provider, verifier, redirect_to, expires_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5)",
      )
      .bind(row.state, row.provider, row.verifier, row.redirect_to, row.expires_at)
      .run();
  }

  /** Single-use, same UPDATE-as-guard construction as the login token. */
  async consumeOAuthState(state: string, now: string): Promise<OAuthState | null> {
    return await this.db
      .prepare(
        "UPDATE oauth_states SET consumed_at = ?2 WHERE state = ?1 AND consumed_at IS NULL " +
          "AND expires_at > ?2 RETURNING *",
      )
      .bind(state, now)
      .first<OAuthState>();
  }

  // ---- AUP ----

  async hasAcceptedAup(accountId: string, version: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT id FROM aup_acceptances WHERE account_id = ?1 AND aup_version = ?2")
      .bind(accountId, version)
      .first<{ id: number }>();
    return row !== null;
  }

  /** Append-only. OR IGNORE makes a double-accept idempotent rather than an error. */
  async recordAupAcceptance(
    accountId: string,
    version: string,
    aupSha256: string,
    ipHash: string | null,
    userAgent: string | null,
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO aup_acceptances (account_id, aup_version, aup_sha256, ip_hash, user_agent) " +
          "VALUES (?1, ?2, ?3, ?4, ?5)",
      )
      .bind(accountId, version, aupSha256, ipHash, userAgent)
      .run();
  }

  // ---- tenants ----

  async getTenantById(id: string): Promise<Tenant | null> {
    return await this.db.prepare("SELECT * FROM tenants WHERE id = ?1").bind(id).first<Tenant>();
  }

  async getTenantBySlug(slug: string): Promise<Tenant | null> {
    return await this.db.prepare("SELECT * FROM tenants WHERE slug = ?1").bind(slug).first<Tenant>();
  }

  async getTenantForAccount(accountId: string): Promise<Tenant | null> {
    return await this.db
      .prepare(
        "SELECT * FROM tenants WHERE account_id = ?1 AND status != 'deleted' ORDER BY created_at DESC LIMIT 1",
      )
      .bind(accountId)
      .first<Tenant>();
  }

  async checkSlugAvailability(slug: string, accountId: string): Promise<SlugClaim> {
    // Deliberately reuses the status-BLIND lookup. Filtering deleted rows out here is what made the
    // old check say "available" for a tombstoned slug; the tier rules need to see every row.
    const claim = classifySlugClaim(await this.getTenantBySlug(slug), accountId);
    if (!claim.available || !claim.reclaim) return claim;

    // A Tier A row can have a provision job being driven RIGHT NOW (claimJob holds a 60s lease).
    // Reclaiming under a live driver is a genuine race: the reclaim blanks the resource columns
    // while the provisioner is still writing ids into them, so the driver's D1 and R2 land on a
    // row that no longer claims them and nothing ever reaps them. Refuse while the lease is live.
    // The lease is short by design (#112), so this refusal clears itself within a minute.
    if (await this.hasLiveProvisionLease(claim.reclaim.tenant_id)) {
      return { available: false, reason: "that name is still being set up; try again in a minute" };
    }
    return claim;
  }

  /** A driver currently holds this tenant's job. Mirrors claimJob's own liveness predicate. */
  private async hasLiveProvisionLease(tenantId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT id FROM provision_jobs WHERE tenant_id = ?1 AND status IN ('queued', 'running') " +
          "AND lease_until IS NOT NULL AND lease_until > datetime('now') LIMIT 1",
      )
      .bind(tenantId)
      .first<{ id: string }>();
    return row !== null;
  }

  /**
   * The conditional UPDATE that actually authorizes a reclaim. Every Tier A condition is repeated
   * in the WHERE clause -- ownership, never-live, and the lifecycle set -- so a row that stopped
   * qualifying between the check and this write is refused rather than taken.
   *
   * The resource columns are blanked because the row is being reused for a NEW provision and stale
   * ids would make it lie about what it owns. live_at is deliberately NOT cleared: it is the
   * "this hostname ever served someone" high-water mark, and keeping it monotonic means a slug's
   * tombstone can only ever get stricter, never looser.
   */
  async claimReclaim(
    tenantId: string,
    accountId: string,
    leaseSeconds: number,
  ): Promise<{ tenant: Tenant; lease_token: string } | null> {
    const token = crypto.randomUUID();
    const placeholders = TIER_A_STATUSES.map((_, i) => `?${i + 5}`).join(", ");
    const tenant = await this.db
      .prepare(
        "UPDATE tenants SET reclaim_lease_until = datetime('now', '+' || ?3 || ' seconds'), " +
          "reclaim_lease_token = ?4 " +
          "WHERE id = ?1 AND account_id = ?2 AND live_at IS NULL " +
          `AND status IN (${placeholders}) ` +
          // An expired or absent lease is FREE, exactly as claimJob treats its own. That is the
          // self-healing half: a reclaim whose driver died must not lock the owner out forever.
          "AND (reclaim_lease_until IS NULL OR reclaim_lease_until < datetime('now')) " +
          "AND NOT EXISTS (SELECT 1 FROM provision_jobs j WHERE j.tenant_id = tenants.id " +
          "AND j.status IN ('queued', 'running') AND j.lease_until IS NOT NULL " +
          "AND j.lease_until > datetime('now')) RETURNING *",
      )
      .bind(tenantId, accountId, leaseSeconds, token, ...TIER_A_STATUSES)
      .first<Tenant>();
    return tenant ? { tenant, lease_token: token } : null;
  }

  async reclaimSlug(tenantId: string, accountId: string, leaseToken: string): Promise<Tenant | null> {
    const placeholders = TIER_A_STATUSES.map((_, i) => `?${i + 4}`).join(", ");
    return await this.db
      .prepare(
        "UPDATE tenants SET status = 'pending', d1_database_id = NULL, r2_bucket_name = NULL, " +
          "r2_token_id = NULL, script_name = NULL, endpoints_json = NULL, studio_release = NULL, " +
          "studio_token_enc = NULL, reclaim_lease_until = NULL, reclaim_lease_token = NULL " +
          "WHERE id = ?1 AND account_id = ?2 AND live_at IS NULL " +
          // Holding the TOKEN is what proves this caller won claimReclaim and did the teardown.
          // Without it the attempt that LOST the claim could blank the row out from under the
          // winner and provision under the same slug-derived names: the race, through the back door.
          "AND reclaim_lease_token = ?3 AND reclaim_lease_until > datetime('now') " +
          `AND status IN (${placeholders}) ` +
          // The lease check lives INSIDE this statement on purpose. Checking it separately would
          // reintroduce the exact TOCTOU this conditional UPDATE exists to close: a driver could
          // take the lease between the check and the write.
          "AND NOT EXISTS (SELECT 1 FROM provision_jobs j WHERE j.tenant_id = tenants.id " +
          "AND j.status IN ('queued', 'running') AND j.lease_until IS NOT NULL " +
          "AND j.lease_until > datetime('now')) RETURNING *",
      )
      .bind(tenantId, accountId, leaseToken, ...TIER_A_STATUSES)
      .first<Tenant>();
  }

  async createTenant(id: string, slug: string, accountId: string, status: TenantLifecycle): Promise<Tenant> {
    const row = await this.db
      .prepare("INSERT INTO tenants (id, slug, account_id, status) VALUES (?1, ?2, ?3, ?4) RETURNING *")
      .bind(id, slug, accountId, status)
      .first<Tenant>();
    if (!row) throw new Error("createTenant: insert returned no row");
    return row;
  }

  /** Lifecycle only. Suspension is a separate column and is deliberately untouched here. */
  async setTenantStatus(id: string, status: TenantLifecycle): Promise<void> {
    await this.db
      .prepare(
        "UPDATE tenants SET status = ?2, " +
          "live_at = CASE WHEN ?2 = 'live' AND live_at IS NULL THEN datetime('now') ELSE live_at END " +
          "WHERE id = ?1",
      )
      .bind(id, status)
      .run();
  }

  async suspendTenant(id: string, reason: string): Promise<void> {
    await this.db
      .prepare("UPDATE tenants SET suspended_at = datetime('now'), suspended_reason = ?2 WHERE id = ?1")
      .bind(id, reason)
      .run();
  }

  /** Clearing the flag restores the tenant's REAL lifecycle state; nothing has to be guessed. */
  async resumeTenant(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE tenants SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?1")
      .bind(id)
      .run();
  }

  async listTenants(filter: { status?: string; q?: string }): Promise<Tenant[]> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.status === "suspended") {
      // "suspended" is a projection, so filtering on it queries the FLAG, not the lifecycle column.
      where.push("suspended_at IS NOT NULL");
    } else if (filter.status) {
      binds.push(filter.status);
      where.push(`status = ?${binds.length}`);
    }
    if (filter.q) {
      binds.push(`%${filter.q}%`);
      where.push(`slug LIKE ?${binds.length}`);
    }
    const sql =
      "SELECT * FROM tenants" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY created_at DESC LIMIT 200";
    const res = await this.db.prepare(sql).bind(...binds).all<Tenant>();
    return res.results ?? [];
  }

  // ---- tenant provisioning writes (#53) ----

  async setTenantD1(id: string, databaseId: string): Promise<void> {
    await this.db.prepare("UPDATE tenants SET d1_database_id = ?2 WHERE id = ?1").bind(id, databaseId).run();
  }

  async setTenantBucket(id: string, bucket: string): Promise<void> {
    await this.db.prepare("UPDATE tenants SET r2_bucket_name = ?2 WHERE id = ?1").bind(id, bucket).run();
  }

  async setTenantR2Token(id: string, tokenId: string): Promise<void> {
    await this.db.prepare("UPDATE tenants SET r2_token_id = ?2 WHERE id = ?1").bind(id, tokenId).run();
  }

  async setTenantEndpoints(id: string, endpointsJson: string): Promise<void> {
    await this.db.prepare("UPDATE tenants SET endpoints_json = ?2 WHERE id = ?1").bind(id, endpointsJson).run();
  }

  async setTenantScript(id: string, scriptName: string, release: string): Promise<void> {
    await this.db
      .prepare("UPDATE tenants SET script_name = ?2, studio_release = ?3 WHERE id = ?1")
      .bind(id, scriptName, release)
      .run();
  }

  async setTenantModulesRelease(id: string, release: string | null): Promise<void> {
    // Binds null straight through: clearing is a real state here (see the column comment in
    // migration 0006), not the absence of a write.
    await this.db.prepare("UPDATE tenants SET modules_release = ?2 WHERE id = ?1").bind(id, release).run();
  }

  async setTenantStudioToken(id: string, encValue: string): Promise<void> {
    await this.db.prepare("UPDATE tenants SET studio_token_enc = ?2 WHERE id = ?1").bind(id, encValue).run();
  }

  // ---- provision jobs ----

  async createProvisionJob(
    id: string,
    tenantId: string,
    kind: "provision" | "deprovision",
  ): Promise<ProvisionJob> {
    const row = await this.db
      .prepare(
        "INSERT INTO provision_jobs (id, tenant_id, kind, status) VALUES (?1, ?2, ?3, 'queued') RETURNING *",
      )
      .bind(id, tenantId, kind)
      .first<ProvisionJob>();
    if (!row) throw new Error("createProvisionJob: insert returned no row");
    return row;
  }

  async createModuleUpgradeJob(
    id: string,
    tenantId: string,
    fromRelease: string | null,
    toRelease: string,
  ): Promise<ProvisionJob> {
    const row = await this.db
      .prepare(
        "INSERT INTO provision_jobs (id, tenant_id, kind, status, from_release, to_release) " +
          "VALUES (?1, ?2, module_upgrade, queued, ?3, ?4) RETURNING *",
      )
      .bind(id, tenantId, fromRelease, toRelease)
      .first<ProvisionJob>();
    if (!row) throw new Error("createModuleUpgradeJob: insert returned no row");
    return row;
  }

  async getLatestJobForTenant(tenantId: string): Promise<ProvisionJob | null> {
    return await this.db
      .prepare("SELECT * FROM provision_jobs WHERE tenant_id = ?1 ORDER BY created_at DESC LIMIT 1")
      .bind(tenantId)
      .first<ProvisionJob>();
  }

  async getJob(id: string): Promise<ProvisionJob | null> {
    return await this.db.prepare("SELECT * FROM provision_jobs WHERE id = ?1").bind(id).first<ProvisionJob>();
  }

  /**
   * The single-runner guard, mirroring the proven film_advance_lease shape: the UPDATE only lands
   * if the job is not already running under a live lease, so two concurrent runners cannot both
   * provision the same tenant (which would double-mint credentials).
   */
  async setJobRunning(id: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE provision_jobs SET status = 'running', attempts = attempts + 1, " +
          `lease_until = datetime('now', '+${JOB_LEASE_SECONDS} seconds'), updated_at = datetime('now') ` +
          "WHERE id = ?1 AND (lease_until IS NULL OR lease_until < datetime('now'))",
      )
      .bind(id)
      .run();
  }

  /**
   * The driving claim (#112). Wins only if nobody holds a live lease, and reports which way it went
   * so the caller can decline to drive. `changes === 1` is the entire arbitration: SQLite applies
   * the UPDATE atomically, so exactly one of two racing polls can match the predicate.
   */
  async claimJob(id: string, leaseSeconds: number): Promise<boolean> {
    const res = await this.db
      .prepare(
        "UPDATE provision_jobs SET lease_until = datetime('now', '+' || ?2 || ' seconds'), " +
          "updated_at = datetime('now') " +
          "WHERE id = ?1 AND status IN ('queued', 'running') " +
          "AND (lease_until IS NULL OR lease_until < datetime('now'))",
      )
      .bind(id, leaseSeconds)
      .run();
    return (res.meta?.changes ?? 0) === 1;
  }

  /**
   * LEASE LENGTH IS LOAD-BEARING (#112): this used to push the lease out 10 minutes on every step.
   * Under poll-driven continuation that would mean a job whose invocation died stayed un-drivable
   * for ten minutes, which is the eternal-spinner bug wearing a lease. The lease now tracks one
   * invocation, so a lost driver frees the job within a minute and the next poll resumes it.
   */
  async updateJobProgress(id: string, step: string, stepsDoneJson: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE provision_jobs SET step = ?2, steps_done = ?3, updated_at = datetime('now'), " +
          `lease_until = datetime('now', '+${JOB_LEASE_SECONDS} seconds') WHERE id = ?1`,
      )
      .bind(id, step, stepsDoneJson)
      .run();
  }

  async finishJob(
    id: string,
    status: "succeeded" | "failed",
    errorStep: string | null,
    errorMessage: string | null,
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE provision_jobs SET status = ?2, error_step = ?3, error_message = ?4, " +
          "finished_at = datetime('now'), updated_at = datetime('now'), lease_until = NULL WHERE id = ?1",
      )
      .bind(id, status, errorStep, errorMessage)
      .run();
  }

  // ---- settings + audit ----

  async getSetting(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM platform_settings WHERE key = ?1")
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string, updatedBy: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO platform_settings (key, value, updated_by) VALUES (?1, ?2, ?3) " +
          "ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = datetime('now'), updated_by = ?3",
      )
      .bind(key, value, updatedBy)
      .run();
  }

  async recordAdminAction(
    actor: string,
    action: string,
    target: string | null,
    detail: string | null,
  ): Promise<void> {
    await this.db
      .prepare("INSERT INTO admin_audit (actor, action, target, detail) VALUES (?1, ?2, ?3, ?4)")
      .bind(actor, action, target, detail)
      .run();
  }
}
