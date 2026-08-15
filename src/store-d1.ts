// The D1 implementation of ControlPlaneStore (#52).
//
// This is the artifact that SHIPS. It is the un-stubbable seam: production wires it, and the live
// wrangler dev verify drives these exact statements against a real D1 built from
// migrations/0001_init.sql. The in-memory store in tests/ never substitutes for that.

import type { HoldRow, LedgerRow } from "./credits";
import type { RunPodMode } from "./runpod-pool";
import type { HarvestedJob } from "./runpod-job-index";
import type { LlmSpendStore, RollupPeriodWrite } from "./llm-spend-ingest";
import type { SpendEvent } from "./llm-spend-rollup";
import type { LlmSpendReadStore, LlmSpendWindow, RollupPeriodRow } from "./llm-spend-window";
import { MAX_PERIODS_PER_WINDOW, summariseWindow } from "./llm-spend-window";
import type {
  Account,
  AupAcceptance,
  AuthProvider,
  ControlPlaneStore,
  InvokeKeyHandoff,
  LoginToken,
  OAuthState,
  PreservationHold,
  PreservationHoldKind,
  ProvisionJob,
  ProvisionJobFacts,
  Session,
  SlugClaim,
  SmokeRender,
  SmokeRenderArtifact,
  SmokeRenderBounds,
  AdminAuditRow,
  OperatorCredential,
  Tenant,
  TenantLifecycle,
  CreditStore,
  ProxyJobOpen,
  ProxyJobRef,
  ProxyJobClose,
  OpenProxyJob,
} from "./store";
import { classifySlugClaim, TIER_A_STATUSES,
  type TenantResourceKind,
  type TenantResourceRefs,
  type ResourceReferrer,
  JOB_LEASE_SECONDS,
} from "./store";

// The lease length lives in store.ts beside leaseIsLive and RECLAIM_LEASE_SECONDS, so the one
// hierarchy (job lease 60s < reclaim lease 300s < job declared lost 600s) is stated once. Re-exported
// here because that is where callers have always imported it from.
export { JOB_LEASE_SECONDS };

/**
 * Normalize the SQLite timestamp format to ISO-8601 UTC (cp#433).
 *
 * aup_acceptances.accepted_at is written ONLY by the column DEFAULT, datetime(now), which the
 * engine emits as "2026-08-15 18:25:24" -- a space separator and no zone designator. That is
 * MEASURED against the real engine in tests/store-d1-sql.test.ts, not assumed from the schema.
 *
 * Handing that string to a client is worse than it looks. Kotlin Instant.parse and Swift
 * ISO8601DateFormatter both reject it outright, which is recoverable. JavaScript new Date()
 * ACCEPTS it and reads it as LOCAL time, so a browser west of UTC silently renders a consent
 * record as having happened hours before it did. A loud failure is survivable; a quietly wrong
 * timestamp on a consent record is the one thing this table exists to prevent.
 *
 * datetime(now) is UTC by definition, so appending the designators is lossless rather than a
 * guess. An already-zoned value passes through untouched, so a future writer that stores proper
 * ISO-8601 is not corrupted by this.
 *
 * An UNRECOGNIZED value is returned RAW rather than thrown on. Throwing would 500 /api/me, and
 * /api/me is the route a re-gated account uses to discover why it is blocked (see the cp#396
 * reachability tests) -- breaking the recovery path over a display field is the worse trade.
 */
export function isoFromSqliteUtc(value: string): string {
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(value)) return value;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(value);
  if (!m) return value;
  return m[1] + "T" + m[2] + (m[3] ?? "") + "Z";
}

export class D1Store implements ControlPlaneStore, CreditStore {
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

  // ---- invoke-key handoffs (cp#169) ----

  async createInvokeKeyHandoff(row: Omit<InvokeKeyHandoff, "created_at" | "consumed_at">): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO invoke_key_handoffs (token_hash, id, tenant_id, endpoints_json, issued_by, expires_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
      .bind(row.token_hash, row.id, row.tenant_id, row.endpoints_json, row.issued_by, row.expires_at)
      .run();
  }

  async getInvokeKeyHandoff(tokenHash: string): Promise<InvokeKeyHandoff | null> {
    // Deliberately unfiltered: expired and consumed are DIFFERENT answers for the reader, and a
    // query that hid them would collapse both into "no such link", which is the one message that
    // sends a confused owner back to the operator for no reason.
    return await this.db
      .prepare("SELECT * FROM invoke_key_handoffs WHERE token_hash = ?1")
      .bind(tokenHash)
      .first<InvokeKeyHandoff>();
  }

  async consumeInvokeKeyHandoff(tokenHash: string, now: string): Promise<InvokeKeyHandoff | null> {
    // THE WRITE IS THE GATE, same shape as consumeLoginToken: the predicate lives in the UPDATE, so
    // SQLite's single writer decides the winner rather than a check that ran a moment earlier.
    return await this.db
      .prepare(
        "UPDATE invoke_key_handoffs SET consumed_at = ?2 WHERE token_hash = ?1 AND consumed_at IS NULL " +
          "AND expires_at > ?2 RETURNING *",
      )
      .bind(tokenHash, now)
      .first<InvokeKeyHandoff>();
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

  /**
   * The most recent acceptance, by ROW ID (cp#433).
   *
   * ORDER BY id DESC and not by aup_version: the labels are free-form and unsortable. Not by
   * accepted_at either, which is second-granularity and ties. The autoincrement id is the only
   * column that records the order the rows actually arrived in.
   */
  async getLastAupAcceptance(accountId: string): Promise<AupAcceptance | null> {
    const row = await this.db
      .prepare(
        "SELECT aup_version, accepted_at FROM aup_acceptances WHERE account_id = ?1 " +
          "ORDER BY id DESC LIMIT 1",
      )
      .bind(accountId)
      .first<{ aup_version: string; accepted_at: string }>();
    if (row === null) return null;
    return { version: row.aup_version, accepted_at: isoFromSqliteUtc(row.accepted_at) };
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

  async beginTeardown(tenantId: string, leaseSeconds: number): Promise<{ tenant: Tenant; lease_token: string } | null> {
    const token = crypto.randomUUID();
    const tenant = await this.db
      .prepare(
        // A tombstone STAYS a tombstone through a re-sweep. Downgrading 'deleted' to 'deleting'
        // would un-tell the one fact that row is carrying.
        "UPDATE tenants SET status = CASE WHEN status = 'deleted' THEN 'deleted' ELSE 'deleting' END, " +
          "reclaim_lease_until = datetime('now', '+' || ?2 || ' seconds'), reclaim_lease_token = ?3 " +
          "WHERE id = ?1 " +
          // An expired or absent lease is FREE, same rule as claimReclaim and claimJob: a teardown
          // whose driver died must not wedge the row forever.
          "AND (reclaim_lease_until IS NULL OR reclaim_lease_until < datetime('now')) " +
          // A live provision or upgrade driver is WRITING to these same resources; deleting under
          // it would race a job that believes it owns the row.
          "AND NOT EXISTS (SELECT 1 FROM provision_jobs j WHERE j.tenant_id = tenants.id " +
          "AND j.status IN ('queued', 'running') AND j.lease_until IS NOT NULL " +
          "AND j.lease_until > datetime('now')) RETURNING *",
      )
      .bind(tenantId, leaseSeconds, token)
      .first<Tenant>();
    return tenant ? { tenant, lease_token: token } : null;
  }

  async finishTeardown(tenantId: string, leaseToken: string, reaped: boolean): Promise<Tenant | null> {
    return await this.db
      .prepare(
        "UPDATE tenants SET " +
          "status = CASE WHEN ?3 = 1 THEN 'deleted' ELSE status END, " +
          // COALESCE, not overwrite: a re-swept tombstone keeps the date it actually died on.
          "deleted_at = CASE WHEN ?3 = 1 THEN COALESCE(deleted_at, datetime('now')) ELSE deleted_at END, " +
          "reclaim_lease_until = NULL, reclaim_lease_token = NULL " +
          // The token is the proof. No liveness check on the lease: a pass that overran its lease
          // but was never taken over still holds the only token, and refusing it there would throw
          // away the record of what it just did.
          "WHERE id = ?1 AND reclaim_lease_token = ?2 RETURNING *",
      )
      .bind(tenantId, leaseToken, reaped ? 1 : 0)
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
    await this.claimResourceOwnership("d1", databaseId, id);
  }

  async setTenantBucket(id: string, bucket: string): Promise<void> {
    await this.db.prepare("UPDATE tenants SET r2_bucket_name = ?2 WHERE id = ?1").bind(id, bucket).run();
    await this.claimResourceOwnership("r2_bucket", bucket, id);
  }

  async setTenantR2Token(id: string, tokenId: string): Promise<void> {
    await this.db.prepare("UPDATE tenants SET r2_token_id = ?2 WHERE id = ?1").bind(id, tokenId).run();
    await this.claimResourceOwnership("r2_token", tokenId, id);
  }

  async setTenantEndpoints(id: string, endpointsJson: string): Promise<void> {
    await this.db.prepare("UPDATE tenants SET endpoints_json = ?2 WHERE id = ?1").bind(id, endpointsJson).run();
  }

  async setTenantRunPodMode(id: string, mode: RunPodMode): Promise<void> {
    await this.db.prepare("UPDATE tenants SET runpod_mode = ?2 WHERE id = ?1").bind(id, mode).run();
  }

  async setTenantScript(id: string, scriptName: string, release: string): Promise<void> {
    await this.db
      .prepare("UPDATE tenants SET script_name = ?2, studio_release = ?3 WHERE id = ?1")
      .bind(id, scriptName, release)
      .run();
    await this.claimResourceOwnership("worker", scriptName, id);
  }

  async setTenantStudioRelease(id: string, release: string | null): Promise<void> {
    // Same nullable-on-purpose shape as setTenantModulesRelease, for the same reason: a studio
    // upgrade CLEARS this before its first write so a partial move cannot leave a release value
    // standing (cp#139). Binds null straight through; clearing is a state, not a skipped write.
    await this.db.prepare("UPDATE tenants SET studio_release = ?2 WHERE id = ?1").bind(id, release).run();
  }

  async setTenantVideoFinishUnreachable(id: string, mark: { reason: string; at: string } | null): Promise<void> {
    // ONE statement writes all three columns, in both directions, so the flag can never be set
    // without its reason or cleared while its reason stays behind (cp#136).
    await this.db
      .prepare(
        "UPDATE tenants SET video_finish_unreachable = ?2, video_finish_unreachable_reason = ?3, " +
          "video_finish_unreachable_at = ?4 WHERE id = ?1",
      )
      .bind(id, mark ? 1 : 0, mark ? mark.reason : null, mark ? mark.at : null)
      .run();
  }

  async setTenantStorageQuota(
    id: string,
    override: { mode: "set"; bytes: string } | { mode: "none" } | null,
  ): Promise<void> {
    // ONE statement writes both columns, in every direction, so a mode can never be stored without
    // its number or a stale number survive a switch to 'none' (cp#183). Same shape and same reason
    // as setTenantVideoFinishUnreachable above.
    await this.db
      .prepare("UPDATE tenants SET r2_storage_quota_override = ?2, r2_storage_quota_bytes = ?3 WHERE id = ?1")
      .bind(id, override ? override.mode : null, override && override.mode === "set" ? override.bytes : null)
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

  async listEncryptedStudioTokens(): Promise<{ id: string; slug: string; studio_token_enc: string }[]> {
    // NO status filter, by design (see the interface comment): a parked or deleted row still holds
    // ciphertext under the outgoing key. Ordered by id so a bounded sweep walks the same sequence
    // every run and its "complete" flag means what it says.
    const rs = await this.db
      .prepare(
        "SELECT id, slug, studio_token_enc FROM tenants WHERE studio_token_enc IS NOT NULL " +
          "AND studio_token_enc != '' ORDER BY id",
      )
      .all<{ id: string; slug: string; studio_token_enc: string }>();
    return rs.results ?? [];
  }

  async setTenantStudioTokenIfUnchanged(id: string, expectedEnc: string, newEnc: string): Promise<boolean> {
    // The WHERE clause IS the lock. D1 has no transaction to hold across the decrypt/encrypt gap, so
    // the guard travels in the statement: write only if the ciphertext is still the one we read.
    const res = await this.db
      .prepare("UPDATE tenants SET studio_token_enc = ?3 WHERE id = ?1 AND studio_token_enc = ?2")
      .bind(id, expectedEnc, newEnc)
      .run();
    // meta.changes is the only honest signal here: a 0-row UPDATE is a SUCCESSFUL statement that did
    // nothing, so reporting success off the absence of an error would call a race a rotation.
    return (res.meta?.changes ?? 0) > 0;
  }

  // ---- provision jobs ----

  async createProvisionJob(
    id: string,
    tenantId: string,
    kind: "provision" | "deprovision",
    facts: ProvisionJobFacts,
  ): Promise<ProvisionJob> {
    // ONE INSERT carries the id, the mode and the release (cp#301). Writing the facts in a second
    // statement would open a window where a job exists and cannot say what it is building, and the
    // driver is dispatched under waitUntil by the same request -- so that window is not theoretical,
    // it is exactly where the cp#132 early-poller lives.
    const row = await this.db
      .prepare(
        "INSERT INTO provision_jobs (id, tenant_id, kind, status, runpod_mode, to_release) " +
          "VALUES (?1, ?2, ?3, 'queued', ?4, ?5) RETURNING *",
      )
      .bind(id, tenantId, kind, facts.runpodMode, facts.toRelease)
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
    return await this.insertUpgradeJob("module_upgrade", id, tenantId, fromRelease, toRelease);
  }

  async createStudioUpgradeJob(
    id: string,
    tenantId: string,
    fromRelease: string | null,
    toRelease: string,
  ): Promise<ProvisionJob> {
    return await this.insertUpgradeJob("studio_upgrade", id, tenantId, fromRelease, toRelease);
  }

  /**
   * The one INSERT both upgrade kinds share. The kind is a closed union from this file, never a
   * caller string, so widening it is a compile-time decision rather than a runtime value that could
   * write a kind nothing reads.
   */
  private async insertUpgradeJob(
    kind: "module_upgrade" | "studio_upgrade",
    id: string,
    tenantId: string,
    fromRelease: string | null,
    toRelease: string,
  ): Promise<ProvisionJob> {
    const row = await this.db
      .prepare(
        "INSERT INTO provision_jobs (id, tenant_id, kind, status, from_release, to_release) " +
          "VALUES (?1, ?2, ?3, 'queued', ?4, ?5) RETURNING *",
      )
      .bind(id, tenantId, kind, fromRelease, toRelease)
      .first<ProvisionJob>();
    if (!row) throw new Error(kind + ": insert returned no row");
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
  /**
   * The driving heartbeat (cp#148). Renews the lease and NOTHING else.
   *
   * updated_at is deliberately untouched: it is the progress clock MAX_JOB_STALE_MS reads, and a
   * heartbeat that bumped it would make a live-but-wedged driver immortal. The status predicate is
   * the other half -- a job someone else already finished must not get a live lease back.
   */
  async renewJobLease(id: string, leaseSeconds: number): Promise<boolean> {
    const res = await this.db
      .prepare(
        "UPDATE provision_jobs SET lease_until = datetime('now', '+' || ?2 || ' seconds') " +
          "WHERE id = ?1 AND status IN ('queued', 'running')",
      )
      .bind(id, leaseSeconds)
      .run();
    return (res.meta?.changes ?? 0) === 1;
  }

  /**
   * Hand the lease back at a yield boundary (cp#158). The mirror image of renewJobLease.
   *
   * updated_at is untouched for the same reason it is untouched there: it is the PROGRESS clock the
   * lost-driver rule reads, and a yield is not progress. The status predicate is the same guard too
   * -- a terminal job is a closed record, and a driver that lost its job must not write to it.
   */
  async releaseJobLease(id: string): Promise<boolean> {
    const res = await this.db
      .prepare("UPDATE provision_jobs SET lease_until = NULL WHERE id = ?1 AND status IN ('queued', 'running')")
      .bind(id)
      .run();
    return (res.meta?.changes ?? 0) === 1;
  }

  async updateJobProgress(id: string, step: string, stepsDoneJson: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE provision_jobs SET step = ?2, steps_done = ?3, updated_at = datetime('now'), " +
          `lease_until = datetime('now', '+${JOB_LEASE_SECONDS} seconds') ` +
          // cp#148: a terminal job is a closed record. A driver that lost its job to a poll keeps
          // running to the end of its invocation, and its next mark used to overwrite the terminal
          // step / steps_done and re-arm the lease on the failed row.
          "WHERE id = ?1 AND status IN ('queued', 'running')",
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

  /**
   * The trail reader (cp#219). Ordered by `id` DESC rather than created_at: created_at has
   * one-second resolution here, so several rows from one operator action share a timestamp and
   * ordering by it would shuffle them. The autoincrement key is the only strict order there is.
   */
  async listAdminAudit(opts: { target?: string; limit: number }): Promise<AdminAuditRow[]> {
    // The limit is clamped rather than trusted: this is an operator surface, but an unbounded LIMIT
    // read straight off a query string is how a review page becomes a way to time out the Worker.
    const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit) || 1));
    const stmt = opts.target
      ? this.db
          .prepare("SELECT id, actor, action, target, detail, created_at FROM admin_audit WHERE target = ?1 ORDER BY id DESC LIMIT ?2")
          .bind(opts.target, limit)
      : this.db
          .prepare("SELECT id, actor, action, target, detail, created_at FROM admin_audit ORDER BY id DESC LIMIT ?1")
          .bind(limit);
    const { results } = await stmt.all<AdminAuditRow>();
    return results ?? [];
  }

  // ---- named operator credentials (cp#219) ------------------------------------------------------

  async createOperatorCredential(
    row: Omit<OperatorCredential, "created_at" | "last_used_at" | "revoked_at" | "revoked_by">,
  ): Promise<void> {
    // No ON CONFLICT clause anywhere in this statement, deliberately. The live-name unique index and
    // the token hash unique constraint are the guards, and an upsert here would silently REPLACE a
    // colleague's live credential with a new one on a name collision -- a revocation nobody asked
    // for and nobody would see. Letting the constraint throw is the correct, loud outcome.
    await this.db
      .prepare(
        "INSERT INTO operator_credentials (id, name, token_sha256, scopes, created_by, expires_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
      .bind(row.id, row.name, row.token_sha256, row.scopes, row.created_by, row.expires_at)
      .run();
  }

  async getOperatorCredentialByHash(tokenHash: string): Promise<OperatorCredential | null> {
    return (
      (await this.db
        .prepare("SELECT * FROM operator_credentials WHERE token_sha256 = ?1")
        .bind(tokenHash)
        .first<OperatorCredential>()) ?? null
    );
  }

  async listOperatorCredentials(): Promise<OperatorCredential[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM operator_credentials ORDER BY created_at DESC, id DESC")
      .all<OperatorCredential>();
    return results ?? [];
  }

  async revokeOperatorCredential(id: string, revokedBy: string, now: string): Promise<boolean> {
    // `revoked_at IS NULL` in the WHERE is what makes the return value mean something: a second
    // revoke matches no row and reports false, instead of overwriting the original timestamp and
    // rewriting when the credential actually died.
    const { meta } = await this.db
      .prepare("UPDATE operator_credentials SET revoked_at = ?2, revoked_by = ?3 WHERE id = ?1 AND revoked_at IS NULL")
      .bind(id, now, revokedBy)
      .run();
    return (meta?.changes ?? 0) > 0;
  }

  async touchOperatorCredential(id: string, now: string): Promise<void> {
    await this.db
      .prepare("UPDATE operator_credentials SET last_used_at = ?2 WHERE id = ?1")
      .bind(id, now)
      .run();
  }

  // ---- operator smoke renders (cp#45) -----------------------------------------------------------

  /**
   * The spend guard, as ONE statement. Every bound is in the WHERE clause of the INSERT itself, so
   * SQLite's writer serializes two concurrent operator submits and exactly one of them creates a
   * row. Splitting this into a read and a write would reintroduce the classic check-then-act hole,
   * and here that hole costs GPU money rather than a duplicate record.
   *
   * The three bounds, in order:
   *   1. no smoke render for this tenant is IN FLIGHT (bounded, so a lost poll cannot wedge it);
   *   2. this tenant is past its COOLDOWN since the last submit;
   *   3. the trailing-24h count across ALL tenants is under the DAILY CAP.
   */
  async openSmokeRender(
    id: string,
    tenantId: string,
    modulesRelease: string | null,
    bounds: SmokeRenderBounds,
  ): Promise<SmokeRender | null> {
    return await this.db
      .prepare(
        "INSERT INTO smoke_renders (id, tenant_id, modules_release) " +
          "SELECT ?1, ?2, ?3 WHERE NOT EXISTS (" +
          "SELECT 1 FROM smoke_renders WHERE tenant_id = ?2 AND status = 'running' " +
          "AND created_at > datetime('now', '-' || ?6 || ' seconds')" +
          ") AND NOT EXISTS (" +
          "SELECT 1 FROM smoke_renders WHERE tenant_id = ?2 " +
          "AND created_at > datetime('now', '-' || ?4 || ' seconds')" +
          ") AND (" +
          "SELECT COUNT(*) FROM smoke_renders WHERE created_at > datetime('now', '-86400 seconds')" +
          ") < ?5 RETURNING *",
      )
      .bind(id, tenantId, modulesRelease, bounds.cooldownSeconds, bounds.dailyCap, bounds.inFlightSeconds)
      .first<SmokeRender>();
  }

  /**
   * The LEGIBLE half. Deliberately a separate read: it can disagree with the INSERT under a race,
   * and that is fine, because it never authorizes anything. Ordered most-specific first so an
   * operator is told the nearest bound rather than the broadest one.
   */
  async describeSmokeRenderRefusal(tenantId: string, bounds: SmokeRenderBounds): Promise<string | null> {
    const inFlight = await this.db
      .prepare(
        "SELECT id FROM smoke_renders WHERE tenant_id = ?1 AND status = 'running' " +
          "AND created_at > datetime('now', '-' || ?2 || ' seconds') LIMIT 1",
      )
      .bind(tenantId, bounds.inFlightSeconds)
      .first<{ id: string }>();
    if (inFlight) return `a smoke render is already running for this tenant (${inFlight.id})`;

    const recent = await this.db
      .prepare(
        "SELECT created_at FROM smoke_renders WHERE tenant_id = ?1 " +
          "AND created_at > datetime('now', '-' || ?2 || ' seconds') ORDER BY created_at DESC LIMIT 1",
      )
      .bind(tenantId, bounds.cooldownSeconds)
      .first<{ created_at: string }>();
    if (recent) {
      return (
        `this tenant had a smoke render at ${recent.created_at}; the cooldown is ` +
        `${bounds.cooldownSeconds}s and it has not elapsed`
      );
    }

    const day = await this.db
      .prepare("SELECT COUNT(*) AS n FROM smoke_renders WHERE created_at > datetime('now', '-86400 seconds')")
      .first<{ n: number }>();
    if ((day?.n ?? 0) >= bounds.dailyCap) {
      return `the platform-wide smoke-render cap of ${bounds.dailyCap} per 24h has been reached`;
    }
    return null;
  }

  async getSmokeRender(id: string): Promise<SmokeRender | null> {
    return await this.db.prepare("SELECT * FROM smoke_renders WHERE id = ?1").bind(id).first<SmokeRender>();
  }

  async setSmokeRenderSubmitted(id: string, studioJobId: string, bundleKey: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE smoke_renders SET studio_job_id = ?2, bundle_key = ?3, updated_at = datetime('now') " +
          "WHERE id = ?1",
      )
      .bind(id, studioJobId, bundleKey)
      .run();
  }

  /**
   * Terminal write, guarded on status = 'running' so a late poll cannot overwrite an outcome an
   * earlier poll already recorded. Two operators polling the same smoke render is normal.
   */
  async finishSmokeRender(
    id: string,
    outcome: { status: "succeeded"; artifact: SmokeRenderArtifact } | { status: "failed"; error: string },
  ): Promise<void> {
    if (outcome.status === "succeeded") {
      await this.db
        .prepare(
          "UPDATE smoke_renders SET status = 'succeeded', artifact_key = ?2, artifact_bytes = ?3, " +
            "artifact_sha256 = ?4, artifact_content_type = ?5, updated_at = datetime('now'), " +
            "finished_at = datetime('now') WHERE id = ?1 AND status = 'running'",
        )
        .bind(
          id,
          outcome.artifact.key,
          outcome.artifact.bytes,
          outcome.artifact.sha256,
          outcome.artifact.contentType,
        )
        .run();
      return;
    }
    await this.db
      .prepare(
        "UPDATE smoke_renders SET status = 'failed', error_message = ?2, updated_at = datetime('now'), " +
          "finished_at = datetime('now') WHERE id = ?1 AND status = 'running'",
      )
      .bind(id, outcome.error)
      .run();
  }

  // ---- teardown record + the referential guard (#23) -------------------------------------------

  /** Column per resource kind. Named explicitly so a new kind cannot silently blank the wrong one. */
  private static readonly RESOURCE_COLUMN: Record<TenantResourceKind, string> = {
    d1: "d1_database_id",
    r2_bucket: "r2_bucket_name",
    r2_token: "r2_token_id",
    worker: "script_name",
  };

  async clearTenantResource(id: string, resource: TenantResourceKind): Promise<void> {
    const column = D1Store.RESOURCE_COLUMN[resource];
    if (!column) throw new Error(`unknown tenant resource kind: ${resource}`);
    // Read the key before blanking so ownership can be released (cp#106 D).
    const row = await this.db
      .prepare(`SELECT ${column} AS k FROM tenants WHERE id = ?1`)
      .bind(id)
      .first<{ k: string | null }>();
    const key = row?.k ?? null;
    // Column name is looked up from a closed literal map, never interpolated from caller input.
    await this.db.prepare(`UPDATE tenants SET ${column} = NULL WHERE id = ?1`).bind(id).run();
    if (key) {
      await this.db
        .prepare(
          "DELETE FROM tenant_resource_ownership WHERE resource_kind = ?1 AND resource_key = ?2 AND owner_tenant_id = ?3",
        )
        .bind(resource, key, id)
        .run();
    }
  }

  async claimResourceOwnership(
    kind: TenantResourceKind,
    resourceKey: string,
    ownerTenantId: string,
  ): Promise<void> {
    if (!resourceKey) return;
    // cp#106 D: do not silently steal from a LIVE owner. Slug reuse re-claims after the prior
    // tenant is deleted/failed (tombstone); a live tenant still pointing at the same physical id
    // must keep ownership so a half-built claim cannot re-point the guard.
    const prior = await this.getResourceOwner(kind, resourceKey);
    if (prior && prior !== ownerTenantId) {
      const priorRow = await this.getTenantById(prior);
      if (priorRow && priorRow.status !== "deleted" && priorRow.status !== "failed") {
        // Keep prior owner; the column write on `tenants` still happened (caller already wrote it).
        // Teardown will refuse the non-owner via getResourceOwner.
        return;
      }
    }
    await this.db
      .prepare(
        "INSERT INTO tenant_resource_ownership (resource_kind, resource_key, owner_tenant_id, provisioned_at) " +
          "VALUES (?1, ?2, ?3, datetime('now')) " +
          "ON CONFLICT(resource_kind, resource_key) DO UPDATE SET " +
          "owner_tenant_id = excluded.owner_tenant_id, " +
          "provisioned_at = excluded.provisioned_at",
      )
      .bind(kind, resourceKey, ownerTenantId)
      .run();
  }

  async getResourceOwner(kind: TenantResourceKind, resourceKey: string): Promise<string | null> {
    if (!resourceKey) return null;
    const row = await this.db
      .prepare(
        "SELECT owner_tenant_id FROM tenant_resource_ownership WHERE resource_kind = ?1 AND resource_key = ?2",
      )
      .bind(kind, resourceKey)
      .first<{ owner_tenant_id: string }>();
    return row?.owner_tenant_id ?? null;
  }

  async setApiTokenRotatedAt(id: string): Promise<void> {
    await this.db.prepare("UPDATE tenants SET api_token_rotated_at = datetime('now') WHERE id = ?1").bind(id).run();
  }

  async indexRunpodJobs(tenantId: string, tenantSlug: string, rows: HarvestedJob[]): Promise<number> {
    if (rows.length === 0) return 0;
    // COALESCE on every nullable column, in this direction: `excluded` first so a fresh value
    // wins, falling back to what is already stored so a later harvest that sees LESS cannot
    // erase what an earlier one saved. An index whose whole purpose is to outlive its source
    // must not be able to lose data to a re-run.
    const sql =
      "INSERT INTO runpod_job_index " +
      "(job_id, tenant_id, tenant_slug, module, outcome, submitted_at, terminal_at, harvested_at, source) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), 'harvest') " +
      "ON CONFLICT(job_id) DO UPDATE SET " +
      // source is a fact about ORIGIN, so unlike every other column here the EXISTING value wins.
      // A row the proxy opened at submit was seen by the proxy; a later harvest touching the same
      // job must not relabel it 'harvest'. Note the COALESCE direction is deliberately the OPPOSITE
      // of the others below, which prefer `excluded` so a fresher value refines an older one.
      "source = COALESCE(runpod_job_index.source, excluded.source), " +
      "module = COALESCE(excluded.module, runpod_job_index.module), " +
      "outcome = COALESCE(excluded.outcome, runpod_job_index.outcome), " +
      "submitted_at = COALESCE(excluded.submitted_at, runpod_job_index.submitted_at), " +
      "terminal_at = COALESCE(excluded.terminal_at, runpod_job_index.terminal_at), " +
      "harvested_at = datetime('now')";
    // batch() so one harvest is one round trip rather than N. Statements are prepared per row
    // because D1 has no multi-row bind; the SQL string is constant, so only the bindings vary.
    await this.db.batch(
      rows.map((r) =>
        this.db
          .prepare(sql)
          .bind(r.job_id, tenantId, tenantSlug, r.module, r.outcome, r.submitted_at, r.terminal_at),
      ),
    );
    return rows.length;
  }

  // ---- the PROXY push path (cp#290) ------------------------------------------------------------

  async openRunpodProxyJob(row: ProxyJobOpen): Promise<void> {
    // `harvested_at` is NOT NULL and predates this path; on a pushed row it means "when we wrote
    // it", which is also when we saw the job. Named here because the column NAME implies a harvest
    // and a reader deserves to be told it does not mean one.
    //
    // ON CONFLICT is defensive rather than expected -- a job id we just minted upstream cannot
    // already be here. It is written so a conflict can never BLANK a closed row: outcome and
    // terminal_at are deliberately absent from the update list, so the terminal facts of an
    // existing row survive a colliding open untouched.
    await this.db
      .prepare(
        "INSERT INTO runpod_job_index " +
          "(job_id, tenant_id, tenant_slug, module, outcome, submitted_at, terminal_at, harvested_at, " +
          " source, endpoint_id, webhook_token_sha256) " +
          "VALUES (?1, ?2, ?3, ?4, 'submitted', ?5, NULL, datetime('now'), 'proxy', ?6, ?7) " +
          "ON CONFLICT(job_id) DO UPDATE SET " +
          "tenant_id = excluded.tenant_id, " +
          "tenant_slug = excluded.tenant_slug, " +
          "module = COALESCE(excluded.module, runpod_job_index.module), " +
          "endpoint_id = COALESCE(excluded.endpoint_id, runpod_job_index.endpoint_id), " +
          // ORIGIN, and the proxy is authoritative for a job it submitted itself: unlike the
          // harvest path (which must never relabel a proxy row), this row IS the proxy's.
          "source = 'proxy', " +
          "webhook_token_sha256 = excluded.webhook_token_sha256, " +
          "submitted_at = COALESCE(runpod_job_index.submitted_at, excluded.submitted_at), " +
          "harvested_at = datetime('now')",
      )
      .bind(
        row.job_id,
        row.tenant_id,
        row.tenant_slug,
        row.module,
        row.submitted_at,
        row.endpoint_id,
        row.webhook_token_sha256,
      )
      .run();
  }

  async findRunpodProxyJobByWebhookToken(tokenSha256: string): Promise<ProxyJobRef | null> {
    // Lookup BY HASH: the presented token is hashed and matched against the stored digest, so the
    // raw credential exists nowhere in this database. An unknown token yields null and the caller
    // learns nothing else -- which is the entire vocabulary an unverified caller may extract.
    const row = await this.db
      .prepare(
        "SELECT job_id, tenant_id, endpoint_id, terminal_at FROM runpod_job_index " +
          "WHERE webhook_token_sha256 = ?1",
      )
      .bind(tokenSha256)
      .first<{ job_id: string; tenant_id: string; endpoint_id: string | null; terminal_at: number | null }>();
    if (!row) return null;
    return {
      job_id: String(row.job_id),
      tenant_id: String(row.tenant_id),
      endpoint_id: row.endpoint_id === null ? null : String(row.endpoint_id),
      terminal_at: row.terminal_at === null ? null : Number(row.terminal_at),
    };
  }

  async closeRunpodProxyJob(row: ProxyJobClose): Promise<number> {
    // FIRST TERMINAL WRITE WINS. `terminal_at IS NULL` is what makes a webhook retry, a reconciler
    // sweep and a forged duplicate all safe to point at the same row -- and RunPod really does
    // deliver the same terminal three times when a receiver merely looks slow (measured).
    //
    // meta.changes is the only honest signal: a 0-row UPDATE is a SUCCESSFUL statement. Returning
    // it lets the caller distinguish a first close from a duplicate instead of reading a silent
    // no-op as success.
    const res = await this.db
      .prepare(
        "UPDATE runpod_job_index SET " +
          "outcome = ?2, status_raw = ?3, execution_ms = ?4, delay_ms = ?5, " +
          "terminal_at = ?6, closed_at = datetime('now') " +
          "WHERE job_id = ?1 AND terminal_at IS NULL",
      )
      .bind(row.job_id, row.outcome, row.status_raw, row.execution_ms, row.delay_ms, row.terminal_at)
      .run();
    return res.meta?.changes ?? 0;
  }

  // The partial index `idx_runpod_job_index_open` (migration 0020) exists for exactly this scan:
  // it is ON (submitted_at) WHERE terminal_at IS NULL, so the sweep reads the open set rather than
  // filtering the whole table. Both statements below are shaped to hit it.

  async listOpenRunpodProxyJobs(before: number, limit: number): Promise<OpenProxyJob[]> {
    const res = await this.db
      .prepare(
        "SELECT job_id, tenant_id, endpoint_id, submitted_at FROM runpod_job_index " +
          "WHERE terminal_at IS NULL AND source = 'proxy' AND endpoint_id IS NOT NULL " +
          "AND submitted_at IS NOT NULL AND submitted_at < ?1 " +
          // OLDEST FIRST, so a cap truncates the youngest rather than the closest to the retention
          // horizon. Under a backlog the old rows are the ones about to become unanswerable.
          "ORDER BY submitted_at ASC LIMIT ?2",
      )
      .bind(before, limit)
      .all<{ job_id: string; tenant_id: string; endpoint_id: string; submitted_at: number | null }>();
    return (res.results ?? []).map((r) => ({
      job_id: String(r.job_id),
      tenant_id: String(r.tenant_id),
      endpoint_id: String(r.endpoint_id),
      submitted_at: r.submitted_at === null ? null : Number(r.submitted_at),
    }));
  }

  async countOpenRunpodProxyJobs(before: number): Promise<number> {
    // The SAME predicate as the list, minus the cap. The difference between the two is the number
    // the sweep could not reach this run, and printing it is what stops a capped run reading as
    // complete coverage.
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM runpod_job_index " +
          "WHERE terminal_at IS NULL AND source = 'proxy' AND endpoint_id IS NOT NULL " +
          "AND submitted_at IS NOT NULL AND submitted_at < ?1",
      )
      .bind(before)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  async recordTeardown(id: string, failures: { resource: string; error: string }[]): Promise<void> {
    await this.db
      .prepare("UPDATE tenants SET teardown_at = datetime('now'), teardown_failures = ?2 WHERE id = ?1")
      .bind(id, JSON.stringify(failures))
      .run();
  }

  // ---- preservation holds (cp#118) -------------------------------------------------------------

  async openPreservationHold(hold: {
    id: string;
    tenant_id: string;
    kind: PreservationHoldKind;
    reason: string;
    opened_by: string;
    expires_at: string | null;
  }): Promise<PreservationHold> {
    await this.db
      .prepare(
        "INSERT INTO preservation_holds (id, tenant_id, kind, reason, opened_by, expires_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
      .bind(hold.id, hold.tenant_id, hold.kind, hold.reason, hold.opened_by, hold.expires_at)
      .run();
    // Read back rather than reconstruct: opened_at is written by SQLite (datetime(now)), so the
    // returned row is the stored fact instead of this process idea of what it stored.
    const row = await this.db
      .prepare("SELECT * FROM preservation_holds WHERE id = ?1")
      .bind(hold.id)
      .first<PreservationHold>();
    if (!row) throw new Error(`preservation hold ${hold.id} vanished immediately after insert`);
    return row;
  }

  async listPreservationHolds(tenantId: string, opts?: { openOnly?: boolean }): Promise<PreservationHold[]> {
    // OPEN is released_at IS NULL and nothing else. Note what is NOT in this WHERE clause: any
    // comparison of expires_at to now. An elapsed preservation floor still blocks (2258A(h)(5)
    // permits longer; 2258B(c) puts destruction on a law-enforcement request), so a clock can never
    // silently unblock a destructive pass.
    const sql = opts?.openOnly
      ? "SELECT * FROM preservation_holds WHERE tenant_id = ?1 AND released_at IS NULL ORDER BY opened_at DESC"
      : "SELECT * FROM preservation_holds WHERE tenant_id = ?1 ORDER BY opened_at DESC";
    const res = await this.db.prepare(sql).bind(tenantId).all<PreservationHold>();
    return res.results ?? [];
  }

  async releasePreservationHold(
    holdId: string,
    releasedBy: string,
    reason: string,
  ): Promise<PreservationHold | null> {
    // released_at IS NULL in the WHERE is the single-use guard: a second release changes no rows and
    // returns null, so it cannot overwrite who decided the duty was over, or when.
    // RETURNING rather than a changes count, matching every other single-use write in this file:
    // the row IS the evidence the update happened, and no-row-returned is the unambiguous answer
    // for "already released" without depending on a driver meta field.
    return (
      (await this.db
        .prepare(
          "UPDATE preservation_holds SET released_at = datetime('now'), released_by = ?2, release_reason = ?3 " +
            "WHERE id = ?1 AND released_at IS NULL RETURNING *",
        )
        .bind(holdId, releasedBy, reason)
        .first<PreservationHold>()) ?? null
    );
  }

  async findResourceReferrers(
    exceptTenantId: string,
    resources: TenantResourceRefs,
  ): Promise<ResourceReferrer[]> {
    const d1 = resources.d1_database_id ?? null;
    const bucket = resources.r2_bucket_name ?? null;
    const token = resources.r2_token_id ?? null;
    const script = resources.script_name ?? null;
    // Nothing to look for is not the same as nothing found, but it has the same answer and costs a
    // round trip to discover.
    if (d1 === null && bucket === null && token === null && script === null) return [];

    const rows = await this.db
      .prepare(
        "SELECT id, slug, status, d1_database_id, r2_bucket_name, r2_token_id, script_name " +
          "FROM tenants WHERE id != ?1 AND (" +
          "(?2 IS NOT NULL AND d1_database_id = ?2) OR " +
          "(?3 IS NOT NULL AND r2_bucket_name = ?3) OR " +
          "(?4 IS NOT NULL AND r2_token_id = ?4) OR " +
          "(?5 IS NOT NULL AND script_name = ?5))",
      )
      .bind(exceptTenantId, d1, bucket, token, script)
      .all<{
        id: string;
        slug: string;
        status: TenantLifecycle;
        d1_database_id: string | null;
        r2_bucket_name: string | null;
        r2_token_id: string | null;
        script_name: string | null;
      }>();

    const out: ResourceReferrer[] = [];
    for (const r of rows.results ?? []) {
      // One row can alias SEVERAL of this tenant's resources -- in the live plane most of them alias
      // three -- so it is reported once per resource rather than once per row. The caller refuses
      // per resource, so a per-row answer would be the wrong granularity.
      if (d1 !== null && r.d1_database_id === d1) out.push({ tenant_id: r.id, slug: r.slug, status: r.status, resource: "d1" });
      if (bucket !== null && r.r2_bucket_name === bucket) out.push({ tenant_id: r.id, slug: r.slug, status: r.status, resource: "r2_bucket" });
      if (token !== null && r.r2_token_id === token) out.push({ tenant_id: r.id, slug: r.slug, status: r.status, resource: "r2_token" });
      if (script !== null && r.script_name === script) out.push({ tenant_id: r.id, slug: r.slug, status: r.status, resource: "worker" });
    }
    return out;
  }

  // ---- credits (cp#189) ----
  //
  // Money statements. Every one of these is exercised against a REAL SQL engine in
  // tests/credits-sql.test.ts, because a fake store cannot catch a malformed statement and this file
  // has already shipped that bug once (the unquoted-literal 500 recorded at the top of
  // tests/store-d1-sql.test.ts).

  async appendLedgerRow(row: {
    id: string;
    tenantId: string;
    kind: "purchase" | "debit" | "refund" | "adjustment";
    deltaMicroUsd: number;
    costMicroUsd: number | null;
    idemRef: string;
    priceListId: string | null;
    externalRef: string | null;
    note: string | null;
    now: string;
  }): Promise<{ applied: boolean; row: LedgerRow }> {
    // DO NOTHING + RETURNING: on conflict SQLite returns no row, which is exactly how we learn the
    // write was a replay. The alternative (SELECT first, then INSERT) has a race between the two.
    const inserted = await this.db
      .prepare(
        `INSERT INTO credit_ledger
           (id, tenant_id, kind, delta_micro_usd, cost_micro_usd, idem_ref, hold_id, price_list_id, external_ref, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?10)
         ON CONFLICT (tenant_id, idem_ref) DO NOTHING
         RETURNING *`,
      )
      .bind(
        row.id,
        row.tenantId,
        row.kind,
        row.deltaMicroUsd,
        row.costMicroUsd,
        row.idemRef,
        row.priceListId,
        row.externalRef,
        row.note,
        row.now,
      )
      .first<LedgerRow>();
    if (inserted) return { applied: true, row: inserted };

    const existing = await this.db
      .prepare("SELECT * FROM credit_ledger WHERE tenant_id = ?1 AND idem_ref = ?2")
      .bind(row.tenantId, row.idemRef)
      .first<LedgerRow>();
    // A conflict with nothing to read back would mean the unique index fired on something we cannot
    // see, which is not a state to paper over with a fabricated row.
    if (!existing) throw new Error("appendLedgerRow: conflict but no existing row");
    return { applied: false, row: existing };
  }

  async readBalanceSums(tenantId: string): Promise<{ settled: number; held: number }> {
    // COALESCE, so a tenant with no rows reads 0 rather than null. That is a genuine zero (no rows
    // means no money moved), not an unknown, so collapsing it here is honest -- unlike a failed read,
    // which throws and is reported as incomplete by the caller.
    const settled = await this.db
      .prepare("SELECT COALESCE(SUM(delta_micro_usd), 0) AS total FROM credit_ledger WHERE tenant_id = ?1")
      .bind(tenantId)
      .first<{ total: number }>();
    const held = await this.db
      .prepare(
        "SELECT COALESCE(SUM(amount_micro_usd), 0) AS total FROM credit_holds WHERE tenant_id = ?1 AND status = 'open'",
      )
      .bind(tenantId)
      .first<{ total: number }>();
    if (!settled || !held) throw new Error("readBalanceSums: aggregate returned no row");
    return { settled: Number(settled.total ?? 0), held: Number(held.total ?? 0) };
  }

  async listLedger(tenantId: string, limit: number): Promise<LedgerRow[]> {
    const rows = await this.db
      .prepare("SELECT * FROM credit_ledger WHERE tenant_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2")
      .bind(tenantId, limit)
      .all<LedgerRow>();
    return rows.results ?? [];
  }

  async takeHold(args: {
    id: string;
    tenantId: string;
    jobRef: string;
    amountMicroUsd: number;
    priceListId: string;
    now: string;
    expiresAt: string;
  }): Promise<{ created: boolean; hold: HoldRow }> {
    const inserted = await this.db
      .prepare(
        `INSERT INTO credit_holds
           (id, tenant_id, job_ref, amount_micro_usd, status, price_list_id, created_at, expires_at, settled_at)
         VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?6, ?7, NULL)
         ON CONFLICT (tenant_id, job_ref) DO NOTHING
         RETURNING *`,
      )
      .bind(args.id, args.tenantId, args.jobRef, args.amountMicroUsd, args.priceListId, args.now, args.expiresAt)
      .first<HoldRow>();
    if (inserted) return { created: true, hold: inserted };

    const existing = await this.db
      .prepare("SELECT * FROM credit_holds WHERE tenant_id = ?1 AND job_ref = ?2")
      .bind(args.tenantId, args.jobRef)
      .first<HoldRow>();
    if (!existing) throw new Error("takeHold: conflict but no existing hold");
    return { created: false, hold: existing };
  }

  async captureHold(args: {
    holdId: string;
    ledgerRowId: string;
    costMicroUsd: number | null;
    note: string | null;
    now: string;
  }): Promise<{ captured: boolean }> {
    // ONE BATCH, which D1 runs as an implicit transaction, so the reservation and the charge cannot
    // come apart. Both halves are ALSO individually safe, which is what makes the pair correct under
    // concurrency rather than merely atomic:
    //
    //  - the UPDATE is conditional on status='open', so exactly one caller can win;
    //  - the INSERT draws its values from the hold row and requires status='captured', so a hold that
    //    was RELEASED (a failed job) can never produce a debit -- that is completed-only billing
    //    enforced in SQL rather than in a caller's discipline;
    //  - idem_ref is the hold id, so "exactly one debit per hold, ever" is a database guarantee.
    //
    // The SELECT carries a WHERE clause for a second reason beyond filtering: SQLite needs one to
    // disambiguate ON CONFLICT from a join's ON clause when an upsert takes values from a SELECT.
    const res = await this.db.batch([
      this.db
        .prepare("UPDATE credit_holds SET status = 'captured', settled_at = ?2 WHERE id = ?1 AND status = 'open'")
        .bind(args.holdId, args.now),
      this.db
        .prepare(
          `INSERT INTO credit_ledger
             (id, tenant_id, kind, delta_micro_usd, cost_micro_usd, idem_ref, hold_id, price_list_id, external_ref, note, created_at)
           SELECT ?2, h.tenant_id, 'debit', -h.amount_micro_usd, ?3, h.id, h.id, h.price_list_id, NULL, ?4, ?5
             FROM credit_holds h
            WHERE h.id = ?1 AND h.status = 'captured'
           ON CONFLICT (tenant_id, idem_ref) DO NOTHING`,
        )
        .bind(args.holdId, args.ledgerRowId, args.costMicroUsd, args.note, args.now),
    ]);
    // changes on the UPDATE is the only honest signal for "did I win": a 0-row UPDATE is a successful
    // statement that did nothing, so reporting success off the absence of an error would call a lost
    // race a capture.
    return { captured: (res[0]?.meta?.changes ?? 0) === 1 };
  }

  async releaseHold(holdId: string, now: string): Promise<{ released: boolean }> {
    const res = await this.db
      .prepare("UPDATE credit_holds SET status = 'released', settled_at = ?2 WHERE id = ?1 AND status = 'open'")
      .bind(holdId, now)
      .run();
    return { released: (res.meta?.changes ?? 0) === 1 };
  }

  async expireHolds(now: string): Promise<number> {
    const res = await this.db
      .prepare("UPDATE credit_holds SET status = 'expired', settled_at = ?1 WHERE status = 'open' AND expires_at <= ?1")
      .bind(now)
      .run();
    return res.meta?.changes ?? 0;
  }

  async getHoldByJobRef(tenantId: string, jobRef: string): Promise<HoldRow | null> {
    return await this.db
      .prepare("SELECT * FROM credit_holds WHERE tenant_id = ?1 AND job_ref = ?2")
      .bind(tenantId, jobRef)
      .first<HoldRow>();
  }

  async listHolds(tenantId: string, limit: number): Promise<HoldRow[]> {
    const rows = await this.db
      .prepare("SELECT * FROM credit_holds WHERE tenant_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2")
      .bind(tenantId, limit)
      .all<HoldRow>();
    return rows.results ?? [];
  }

  async capturedHoldsMissingDebit(limit: number): Promise<HoldRow[]> {
    const rows = await this.db
      .prepare(
        `SELECT h.* FROM credit_holds h
          WHERE h.status = 'captured'
            AND NOT EXISTS (SELECT 1 FROM credit_ledger l WHERE l.hold_id = h.id)
          LIMIT ?1`,
      )
      .bind(limit)
      .all<HoldRow>();
    return rows.results ?? [];
  }
}

// ---------------------------------------------------------------------------------------------
// cp#185: the LLM spend meter. Ingestion half (LlmSpendStore) and read half (LlmSpendReadStore).
//
// Statements live here with the rest of the D1 SQL rather than beside the decision code, for the
// standing reason: this class is the artifact that ships, and a live wrangler dev verify drives
// these exact statements against a real D1 built from the real migrations.

export class LlmSpendD1 implements LlmSpendStore, LlmSpendReadStore {
  /**
   * `maxPeriodsPerWindow` is a PARAMETER, not a test seam: production takes the default and there is
   * exactly one code path. It is a parameter because a truncation guard that cannot be watched
   * FAILING is an assumption with a green checkmark, and planting 20,001 period rows to watch it is
   * not a test anyone would keep running.
   */
  constructor(
    private readonly db: D1Database,
    private readonly maxPeriodsPerWindow: number = MAX_PERIODS_PER_WINDOW,
  ) {}

  async readLlmWatermark(source: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT last_seen_at FROM llm_rollup_watermark WHERE id = ?1")
      .bind(source)
      .first<{ last_seen_at: string }>();
    return row?.last_seen_at ?? null;
  }

  async readLastPeriodEnd(): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT window_end FROM llm_rollup_periods ORDER BY window_end DESC LIMIT 1")
      .bind()
      .first<{ window_end: string }>();
    return row?.window_end ?? null;
  }

  async openLlmRollupPeriod(period: RollupPeriodWrite): Promise<void> {
    // rows_ingested 0 and finished_at NULL: the row exists so events have a parent, and it claims
    // nothing until closeLlmRollupPeriod stamps what was actually written.
    await this.db
      .prepare(
        `INSERT INTO llm_rollup_periods
           (id, window_start, window_end, status, control_passed, rows_ingested, gap_detected, started_at, finished_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, NULL)`,
      )
      .bind(
        period.id,
        period.windowStart,
        period.windowEnd,
        period.status,
        period.controlPassed ? 1 : 0,
        period.gapDetected ? 1 : 0,
        period.startedAt,
      )
      .run();
  }

  async writeLlmSpendEvents(
    periodId: string,
    events: SpendEvent[],
    insertedAt: string,
  ): Promise<number> {
    let written = 0;
    // CHUNKED, because a single batch of an unbounded statement list is how a cold-start backlog
    // takes the whole run down. The chunk is a transaction (D1 batch is one), so a chunk lands
    // whole or not at all; a torn run leaves an unfinished period, which reads as incomplete.
    const CHUNK = 50;
    for (let i = 0; i < events.length; i += CHUNK) {
      const slice = events.slice(i, i + CHUNK);
      const statements = slice.map((e) =>
        this.db
          .prepare(
            `INSERT OR IGNORE INTO llm_spend_events
               (source, source_id, tenant_id, slug, model, cost_micro_usd, tokens_in, tokens_out,
                cached, occurred_at, inserted_at, period_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
          )
          .bind(
            e.source,
            e.sourceId,
            e.tenantId,
            e.slug,
            e.model,
            e.costMicroUsd,
            e.tokensIn,
            e.tokensOut,
            e.cached,
            e.occurredAt,
            insertedAt,
            periodId,
          ),
      );
      const results = await this.db.batch(statements);
      // The ENGINE's changes count, not the statement count. They differ exactly when OR IGNORE
      // suppressed a duplicate, which is the normal case on the second-granular watermark re-read
      // (see ai-gateway-logs.ts), and reporting the statement count instead would over-claim.
      for (const r of results) written += Number((r as { meta?: { changes?: number } })?.meta?.changes ?? 0);
    }
    return written;
  }

  async closeLlmRollupPeriod(periodId: string, rowsIngested: number, finishedAt: string): Promise<void> {
    await this.db
      .prepare("UPDATE llm_rollup_periods SET rows_ingested = ?2, finished_at = ?3 WHERE id = ?1")
      .bind(periodId, rowsIngested, finishedAt)
      .run();
  }

  async advanceLlmWatermark(source: string, lastSeenAt: string, updatedAt: string): Promise<void> {
    // MONOTONIC BY THE STATEMENT, not by the caller remembering. Two runs overlapping (a slow run
    // and the next cron tick) could otherwise write the older value last and silently re-read, or
    // worse, a bug elsewhere could walk the cursor BACKWARD past rows already billed into a period.
    await this.db
      .prepare(
        `INSERT INTO llm_rollup_watermark (id, last_seen_at, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (id) DO UPDATE SET
           last_seen_at = MAX(llm_rollup_watermark.last_seen_at, excluded.last_seen_at),
           updated_at = excluded.updated_at`,
      )
      .bind(source, lastSeenAt, updatedAt)
      .run();
  }

  async readTenantLlmSpend(args: {
    tenantId: string;
    windowStart: string;
    windowEnd: string;
  }): Promise<LlmSpendWindow> {
    // The period census. LIMIT + 1 so a truncation is DETECTED rather than assumed absent: a
    // negative conclusion drawn from a list that was silently cut off is a floor wearing a total's
    // label, and every completeness judgement below is drawn from this list.
    const censused = await this.db
      .prepare(
        `SELECT id, window_start, window_end, status, control_passed, gap_detected, finished_at
           FROM llm_rollup_periods
          WHERE window_end >= ?1 AND window_end < ?2
          ORDER BY window_end
          LIMIT ?3`,
      )
      .bind(args.windowStart, args.windowEnd, this.maxPeriodsPerWindow + 1)
      .all<RollupPeriodRow>();
    const all = censused.results ?? [];
    const truncated = all.length > this.maxPeriodsPerWindow;
    const periods = truncated ? all.slice(0, this.maxPeriodsPerWindow) : all;

    if (periods.length === 0) {
      // No periods means no IN list to build, and an empty IN list is a SQL error in some engines
      // and an accidental match-everything in others. Answer from the pure function directly.
      return summariseWindow({
        periods: [],
        windowStart: args.windowStart,
        windowEnd: args.windowEnd,
        sums: { costMicroUsd: 0, requests: 0, unpricedRequests: 0 },
        periodCensusTruncated: truncated,
      });
    }

    // Summed over period_id, NEVER over occurred_at. Migration 0015 rules that a row belongs to the
    // period that INGESTED it, so that a late arrival cannot retroactively change a settled
    // statement. Summing by occurred_at here would break that contract from the read side no matter
    // how carefully the write side behaves.
    const placeholders = periods.map((_, i) => "?" + (i + 2)).join(",");
    const sums = await this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_micro_usd), 0) AS cost,
                COUNT(*) AS requests,
                SUM(CASE WHEN cost_micro_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
           FROM llm_spend_events
          WHERE tenant_id = ?1 AND period_id IN (${placeholders})`,
      )
      .bind(args.tenantId, ...periods.map((p) => p.id))
      .first<{ cost: number | null; requests: number | null; unpriced: number | null }>();
    if (!sums) throw new Error("readTenantLlmSpend: aggregate returned no row");

    return summariseWindow({
      periods,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      sums: {
        costMicroUsd: Number(sums.cost ?? 0),
        requests: Number(sums.requests ?? 0),
        unpricedRequests: Number(sums.unpriced ?? 0),
      },
      periodCensusTruncated: truncated,
    });
  }
}
