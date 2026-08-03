// The control plane's data seam (#52).
//
// WHY AN INTERFACE: the repo has no SQL-fidelity test harness and adding one would mean a new dep.
// So data access gets exactly ONE un-stubbable seam: D1Store (store-d1.ts) is what production wires
// and what the live wrangler dev verify exercises against a REAL D1; MemoryStore (tests/) backs the
// logic tests. The rule that keeps this honest: a stubbed store proves a DECISION PATH, never the
// shipped artifact. Anything that must be true of the SQL itself gets verified live, not here.

// TYPE-ONLY, so this cannot create a runtime cycle: runpod-pool.ts imports a type back out of
// provisioner.ts, which imports types out of here. All three edges are erased at compile.
import type { RunPodMode } from "./runpod-pool";
import type { HarvestedJob } from "./runpod-job-index";

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
  /**
   * The release whose MODULE bytes this tenant runs, when that is uniformly true (cf#103).
   *
   * NULL IS MEANINGFUL, not merely absent: it means "not known to be uniformly at any one release;
   * consult the latest module_upgrade job". The upgrade NULLs this before its first upload and
   * writes the target only on full success, so a partial failure cannot leave a value here claiming
   * a uniformity the resident scripts do not have. Distinct from studio_release on purpose -- an
   * upgrade ships modules and never touches the studio bytes.
   */
  modules_release: string | null;
  /** AES-256-GCM(STUDIO_TOKEN_KEK) of the tenant STUDIO_API_TOKEN. The one stored VALUE, encrypted. */
  studio_token_enc: string | null;
  created_at: string;
  live_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  deleted_at: string | null;
  /**
   * When this tenant's programmatic studio token was last ROTATED (cf#94). NULL means never rotated.
   * The token itself lives in the tenant's own studio DB as a hash; only this lifecycle fact is here.
   */
  api_token_rotated_at: string | null;
  /** When a teardown was last ATTEMPTED on this row. NULL means never attempted (#23). */
  teardown_at: string | null;
  /**
   * JSON array of the failures the last teardown collected; '[]' means it reaped everything it
   * tried. NULL means no teardown has run. Three states, deliberately: "clean" and "never tried"
   * are not the same fact, and collapsing them is how a row that still owns live resources reads
   * as reaped.
   */
  teardown_failures: string | null;
  /** Somebody is tearing this row down RIGHT NOW, until this time. Expires, so a dead reclaim heals. */
  reclaim_lease_until: string | null;
  /** Proves WHICH caller holds the reclaim lease. A timestamp cannot. */
  reclaim_lease_token: string | null;
  /**
   * DECLARED unreachable for the video-finish tier (cp#136). 1 = declared, 0 = not.
   *
   * The plane RECORD behind the studio var VIDEO_FINISH_TIER_STATE, which the panel reads to pick
   * between "not yet provisioned" and "cannot be turned on for this studio". It is a declaration
   * rather than a derivation: no plane-side condition computes it (see src/video-finish-tier-state.ts
   * for why every derived writer writes `provisionable` forever), so a human sets it, with a reason.
   *
   * The COLUMN is the source of truth and the var is a projection re-derived at every write to the
   * studio, so clearing it here is what un-says the sentence on the next write, in either direction.
   */
  video_finish_unreachable: number;
  /** WHY it was declared. A state nobody can explain is not auditable; the route requires it. */
  video_finish_unreachable_reason: string | null;
  /** When it was declared. NULL whenever the flag is 0; the two are written and cleared together. */
  video_finish_unreachable_at: string | null;
  /**
   * The PER-TENANT R2 storage ceiling decision (cp#183): NULL (inherit the plane default), 'set'
   * (use r2_storage_quota_bytes) or 'none' (NO ceiling for this tenant, whatever the plane says).
   *
   * Three states because cp#173 gives us two kinds of tenant. BYOK and self-host pay us nothing for
   * GPU while their R2 sits on our bill, so a refusal threshold IS the cost-recovery mechanism.
   * PREPAID tenants are bounded by their credit balance instead, so a hard byte cap would deny them
   * at exactly the byte where charged overage begins. "Inherit" and "deliberately uncapped" are
   * therefore different facts, and a single nullable number would spell them identically.
   */
  r2_storage_quota_override: string | null;
  /** The ceiling in BYTES, as the string that gets bound. Meaningful only when mode is 'set'. */
  r2_storage_quota_bytes: string | null;
  /**
   * Which RunPod shape this tenant actually got (cp#270): 'dedicated' or 'shared'.
   *
   * RECORDED, never derived. `endpoints_json` used to mean exactly one thing, "the endpoints this
   * tenant OWNS", and pooling gives it a second meaning, "the endpoints this tenant USES". Five
   * readers treat it as ownership, so a reader that must not touch a pooled endpoint needs a fact
   * to branch on rather than an inference from a JSON blob whose meaning now depends on state
   * stored somewhere else. Typed as a bare string because that is what D1 returns; narrow it
   * through readRunPodMode (src/runpod-pool.ts) rather than comparing the raw value.
   */
  runpod_mode: string;
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
  kind: "provision" | "deprovision" | "module_upgrade" | "studio_upgrade";
  status: "queued" | "running" | "succeeded" | "failed";
  step: string | null;
  steps_done: string;
  error_step: string | null;
  error_message: string | null;
  attempts: number;
  /** Who is currently driving this job, expressed as when that claim expires (#112). */
  lease_until: string | null;
  /**
   * The release pair. `from_release` belongs to the UPGRADE kinds; `to_release` is now written by
   * PROVISION jobs as well (cp#301).
   *
   * from_release exists so a FAILED upgrade is still rollback-able. Rollback here is "re-run at the
   * previous release", and the upgrade NULLs tenants.modules_release before touching anything, so
   * after a failure this row is the only place the previous release still exists. Null on every
   * other job kind, and null-able on this one because the tenant may not have had a recorded module
   * release to move from.
   *
   * to_release ON A PROVISION is the plane pin AT THE MOMENT THE JOB WAS CREATED. It exists because
   * a provision that yields and resumes must build from the release the job started on, not from
   * whatever the plane is pinned to when a poll happens to drive it -- STUDIO_RELEASE moved
   * v1.13.0 to v1.19.3 in a single day on 2026-08-03. tenants.studio_release cannot serve that: it
   * is written inside wfp_upload, so it is NULL across the entire region the resume work is about.
   */
  from_release: string | null;
  to_release: string | null;
  /**
   * Which RunPod shape this provision ATTEMPT was created for (cp#301, migration 0022).
   *
   * Recorded at the route from the fact that decides it -- a RunPod key was supplied, or it was not
   * -- because tenants.runpod_mode cannot answer the question this soon: it is written inside the
   * runpod_endpoints step and is NOT NULL DEFAULT 'dedicated', so before that step every tenant row
   * reads 'dedicated' whether or not it is one.
   *
   * NULL means the job predates migration 0022, and nothing else. A consumer must treat NULL as a
   * refusal to resume, NEVER as a fallback to 'dedicated': that is the distinction the column exists
   * to preserve, and a default would erase it.
   */
  runpod_mode: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

/**
 * The two facts a provision job must carry from the moment it is created (cp#301).
 *
 * BOTH ARE WRITTEN BY THE SAME INSERT, deliberately. They describe the same attempt, and two
 * separate writes are two chances for a job row to carry a mode from one epoch and a release from
 * another -- a disagreement no reader could detect and none of them would expect.
 */
export interface ProvisionJobFacts {
  /**
   * DERIVED FROM WHETHER A KEY WAS SUPPLIED, never from whether the plane happens to offer a pool.
   * A plane with a pool armed also serves BYO dedicated tenants, so "a pool exists" would put a
   * tenant who brought their own RunPod account onto ours.
   */
  runpodMode: RunPodMode;
  /** The plane pin at job-creation time. The release THIS attempt is building. */
  toRelease: string;
}

export interface LoginToken {
  token_hash: string;
  email: string;
  expires_at: string;
  consumed_at: string | null;
}

/**
 * cp#169: a one-time authorization for the ACCOUNT OWNER to install one invoke key on one tenant.
 *
 * The plaintext token exists once, in the admin response the operator reads; this row carries only
 * its SHA-256, exactly like a login token. `endpoints_json` is the four ids the handoff was issued
 * against: the page shows them so the owner knows what to scope, and the consume path refuses when
 * they no longer match the tenant's current endpoints.
 */
export interface InvokeKeyHandoff {
  token_hash: string;
  id: string;
  tenant_id: string;
  endpoints_json: string;
  issued_by: string;
  created_at: string;
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

/**
 * How long one driver holds a job (#112, cp#148). Sized to a single invocation, not to a whole
 * provision: a driver that dies must free the job quickly enough for the next poll to resume it.
 *
 * IT MEANS "A DRIVER IS ALIVE" ONLY BECAUSE A LIVE DRIVER RENEWS IT (cp#148). It used to be written
 * at step boundaries alone, so any STEP longer than this expired the lease under a perfectly healthy
 * driver and the next poll claimed the job away from it. On a slow RunPod account that is exactly
 * what happened: createEndpoints ran for ~87s with no mark inside it, the lease lapsed at ~68s, and
 * the poll that won the now-free claim ran the continuation, which refuses anything short of
 * wfp_upload and writes a terminal failure plus a destructive rollback. The provisioner now
 * heartbeats this lease for as long as its invocation lives (renewJobLease), so an expired lease
 * means a dead driver and nothing else. Every other guard that reads lease_until -- claimReclaim,
 * beginTeardown, jobHasLiveDriver -- gets that same repair for free, because they were all reading a
 * column that could only ever say "a step boundary happened recently".
 */
export const JOB_LEASE_SECONDS = 60;

/**
 * How long one reclaim attempt owns a row (cf#103). SIZED, not copied from JOB_LEASE_SECONDS.
 *
 * A teardown is ~11 SEQUENTIAL CF API calls: worker delete, module list + up to five module script
 * deletes + census list, R2 token revoke, D1 delete, R2 bucket delete. At normal CF latency that
 * runs to tens of seconds, so claimJob's 60s sits INSIDE the plausible duration of a SUCCEEDING
 * teardown. An undersized lease is not a small error here: it expires mid-flight and hands the row
 * to a second attempt while the first is still deleting, which is the exact race this closes.
 *
 * The asymmetry sets the direction. Too SHORT silently destroys a customer's newly provisioned
 * bucket and is unrecoverable; too LONG makes an owner wait, bounded, self-healing, with a legible
 * reason. So: several times the realistic worst case, and still half of MAX_JOB_STALE_MS, keeping
 * one coherent hierarchy -- provision claim 60s < reclaim lease 300s < job declared lost 600s.
 */
export const RECLAIM_LEASE_SECONDS = 300;

/**
 * Is a lease still held? Shared by the reclaim lease here and mirrored by the store's SQL.
 *
 * An ABSENT lease and an EXPIRED lease both read as free, and that is the self-healing half: a
 * reclaim whose driver died must not lock the owner out of their own slug forever.
 */
export function leaseIsLive(leaseUntil: string | null, nowMs: number): boolean {
  if (leaseUntil === null) return false;
  const t = Date.parse(`${leaseUntil.replace(" ", "T")}Z`);
  return Number.isFinite(t) && t > nowMs;
}

/**
 * Does this job currently have a live driver (#44, #112)?
 *
 * Status alone is not enough: a dead upgrade left `queued` with no lease wedged the tenant
 * forever under the old guard. An expired or absent lease reads as free, which is the self-healing
 * half -- same reasoning as reclaim_lease_until and claimJob.
 */
export function jobHasLiveDriver(job: ProvisionJob, nowMs: number): boolean {
  if (job.status !== "queued" && job.status !== "running") return false;
  return leaseIsLive(job.lease_until, nowMs);
}

/**
 * Has NO driver ever taken this job (cp#132)?
 *
 * THE DEFECT THIS NAMES. Every job kind is INSERTed `queued` with a NULL lease, and its driver is
 * dispatched by the same request under waitUntil. Between those two facts sits a window in which
 * the row says nobody holds this job while a driver is starting up, and claimJob -- correctly, for
 * what it is -- reads the row alone: status in (queued, running) AND no live lease. So an early
 * poller wins the claim outright, and on a provision that claim is destructive: the winner runs
 * continueProvisionJob, which refuses anything short of wfp_upload by writing finishJob(failed) +
 * setTenantStatus(failed) + a rollback that DELETES the half-built tenant, while the real driver is
 * still provisioning it. Worse, the poll claim makes the driver own setJobRunning UPDATE miss its
 * predicate (it requires a free lease), so the row never even records that a driver arrived.
 *
 * The cp#148 heartbeat does not close this one: it starts beating at the same instant, and the
 * window is BEFORE the first beat and before setJobRunning.
 *
 * WHY `queued` IS THE HONEST TEST rather than a timing heuristic: setJobRunning is the only writer
 * of `running` and it is the first store call every driver makes, so `queued` means exactly "no
 * driver has ever claimed this row". Not "the driver is slow", not "the lease lapsed". A job that is
 * `running` with a lapsed lease is the OTHER case entirely, and there the lease now means what it
 * says (cp#148): the driver is gone, so terminalizing it is honest.
 *
 * What owns a queued job whose driver never arrives is the existing lost-driver rule
 * (MAX_JOB_STALE_MS in index.ts), which reads updated_at and declares it lost with an attributable
 * message. Slower than a poll racing it, and correct instead of destructive.
 */
export function jobAwaitsFirstDriver(job: ProvisionJob): boolean {
  return job.status === "queued";
}

/** The generic refusal. Every tier gives a stranger THIS string and nothing more (enumeration). */
export const SLUG_TAKEN_REASON = "that name is taken";

/**
 * Decide a slug claim from the row alone. Pure, so the tier rules are testable without a database.
 *
 * This function only ever produces a REASON. It never authorizes anything -- reclaimSlug's
 * conditional UPDATE does that, and it re-tests these same rules against the row it is writing.
 */
export function classifySlugClaim(row: Tenant | null, accountId: string, nowMs: number = Date.now()): SlugClaim {
  if (!row) return { available: true, reclaim: null };

  // A stranger learns only that the name is unavailable, never which tier it is in.
  if (row.account_id !== accountId) return { available: false, reason: SLUG_TAKEN_REASON };

  const neverLive = row.live_at === null;

  // Tier A: never served anyone, so there is no hostname history to inherit. The owner may retake it.
  if (neverLive && TIER_A_STATUSES.includes(row.status)) {
    // ...unless another attempt is already tearing it down. Reported here so the customer gets a
    // reason instead of a write that silently refuses. Self-clearing: the lease expires.
    if (leaseIsLive(row.reclaim_lease_until, nowMs)) {
      return { available: false, reason: "that name is being reset right now; try again in a few minutes" };
    }
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

/** The four control-plane-owned resources a teardown can reap. RunPod endpoints are the TENANT's. */
export type TenantResourceKind = "d1" | "r2_bucket" | "r2_token" | "worker";

/** The resource values to look for, as they appear on a tenant row. */
export interface TenantResourceRefs {
  d1_database_id?: string | null;
  r2_bucket_name?: string | null;
  r2_token_id?: string | null;
  script_name?: string | null;
}

/** Another row that still points at one of those resources, and what state that row is in. */
export interface ResourceReferrer {
  tenant_id: string;
  slug: string;
  status: TenantLifecycle;
  resource: TenantResourceKind;
}

/**
 * Which preservation duty a hold represents (cp#118). The vocabulary is statutory, and the two
 * statutory kinds run on DIFFERENT clocks that can be live at the same time on the same tenant
 * (ABUSE-RESPONSE-RUNBOOK.md Section 5.3):
 *
 * - ncmec_2258a_h -- OUR CyberTipline submission, 1 YEAR (18 U.S.C. 2258A(h)(1), as amended by
 *   Pub. L. 118-59; anything still saying 90 days for THIS clock quotes repealed text).
 * - le_2703_f -- a GOVERNMENTAL ENTITY preservation request, 90 days, renewable for a further 90
 *   (18 U.S.C. 2703(f)). 2258A(h)(4) says the two do not limit each other.
 * - internal -- an open report with no statutory clock attached yet, which is the state most
 *   incidents start in and the one an operator most needs to be able to record immediately.
 */
export type PreservationHoldKind = "ncmec_2258a_h" | "le_2703_f" | "internal";

/**
 * A preservation obligation on a tenant. OPEN means released_at is null, and nothing else.
 *
 * expires_at is the FLOOR of the duty, never a trigger: 2258A(h)(5) permits preserving longer and
 * 2258B(c) puts destruction on a law-enforcement request rather than on a timer of ours. An elapsed
 * clock therefore still blocks, and says so.
 */
export interface PreservationHold {
  id: string;
  tenant_id: string;
  kind: PreservationHoldKind;
  reason: string;
  opened_at: string;
  opened_by: string;
  expires_at: string | null;
  released_at: string | null;
  released_by: string | null;
  release_reason: string | null;
}

/**
 * A named operator credential (cp#219). The plaintext token exists only in the mint response; this
 * row holds its SHA-256 hex, so nothing here can be replayed as a credential.
 */
export interface OperatorCredential {
  id: string;
  /** The authenticated operator identity. Lands in admin_audit as `operator:<name>`. */
  name: string;
  token_sha256: string;
  /** Space-separated canonical scope ids. Parsed through operator-auth.ts, never read raw. */
  scopes: string;
  created_at: string;
  created_by: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

/** One admin_audit row, as read back. `id` is the autoincrement key and orders the trail. */
export interface AdminAuditRow {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: string;
}

/**
 * A job the proxy is opening (cp#290). Every field is known at submit time except the job id, which
 * is why this write happens AFTER the upstream call rather than before it.
 */
export interface ProxyJobOpen {
  job_id: string;
  tenant_id: string;
  /** The slug AS IT WAS at submit. Slugs are leases and get reused; resolving one later would
   *  answer about whoever holds it now, so it is denormalised here as a fact about this job. */
  tenant_slug: string;
  /** Tenant-ASSERTED label (a request header), used for attribution only. It never decides money:
   *  what a job cost is priced off endpoint_id, which the tenant cannot misreport because the proxy
   *  read it off the URL it was willing to forward. */
  module: string | null;
  /** A pooled endpoint id, or a public model slug. Both meanings live in this column by design
   *  (see migration 0020) because the cost door prices per slug. */
  endpoint_id: string;
  submitted_at: number;
  /** SHA-256 hex of the per-job callback token. The raw token is never stored. */
  webhook_token_sha256: string;
}

/** What the callback route needs to go and ask RunPod what actually happened. */
export interface ProxyJobRef {
  job_id: string;
  tenant_id: string;
  endpoint_id: string | null;
  /** Non-null means this job is already closed. The close is idempotent regardless; this is here so
   *  a duplicate callback can be LOGGED as a duplicate rather than looking like a first delivery. */
  terminal_at: number | null;
}

/** One open row the sweep may ask RunPod about. */
export interface OpenProxyJob {
  job_id: string;
  tenant_id: string;
  /** NOT NULL by the query's own WHERE clause: a row without one cannot be asked about at all. */
  endpoint_id: string;
  submitted_at: number | null;
}

/** Terminal facts, taken from a status read WE initiated. Never from the inbound webhook body. */
export interface ProxyJobClose {
  job_id: string;
  outcome: string;
  /** The vendor's own vocabulary, verbatim, so a state we have not modelled is still recoverable. */
  status_raw: string;
  /** NULL, never 0, when RunPod did not report it: a CANCELLED job reports neither field, and a
   *  zero would read as a real measurement of a job that took no time. */
  execution_ms: number | null;
  delay_ms: number | null;
  terminal_at: number;
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
   * Claim the EXCLUSIVE right to tear this row down and reuse its slug (cf#103).
   *
   * WHY THIS EXISTS AT ALL: every tenant resource name derives from the SLUG, not the attempt, so
   * two concurrent reclaims by the same owner issue the SAME delete calls. Attempt A's teardown
   * lands after attempt B has already provisioned fresh resources under those names, and deletes
   * them. Serializing on this write is what makes teardown safe to start.
   *
   * Guarded on the full Tier A predicate plus no live provision lease plus no live reclaim lease.
   * The winner gets the row AND a token; only the token holder may complete the reclaim.
   *
   * TEAR DOWN FROM THE RETURNED ROW, not from an earlier checkSlugAvailability handle: this write
   * is the serialization point, so these are the authoritative ids.
   *
   * MINTS the lease token. It is returned once, here, and nowhere else: pass it to reclaimSlug to
   * complete. A timestamp alone would be advisory, proving somebody holds the lease but never that
   * it is you, which would leave the losing attempt free to blank the row mid-teardown.
   */
  claimReclaim(
    tenantId: string,
    accountId: string,
    leaseSeconds: number,
  ): Promise<{ tenant: Tenant; lease_token: string } | null>;
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
   * ORDERING REQUIREMENT: this blanks the resource columns. Reap the resources named on the row
   * claimReclaim RETURNED first; after this returns, the row no longer knows they existed. Use the
   * claim's row rather than an earlier checkSlugAvailability handle -- the claim is the
   * serialization point, so a handle read before it can already be stale.
   *
   * REQUIRES YOUR OWN LIVE LEASE, and refuses without one in EITHER direction: a token that is not
   * yours, or a token that is yours but whose lease has EXPIRED. Holding a live token is what
   * proves you are the attempt that won claimReclaim and did the teardown, rather than the one
   * that lost and would otherwise blank the row out from under the winner. The expiry half matters
   * on a teardown that overruns its lease: by then another attempt may have claimed the row, so
   * null here means re-run from claimReclaim, never retry this call. Clears the lease on success.
   */
  reclaimSlug(tenantId: string, accountId: string, leaseToken: string): Promise<Tenant | null>;
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
  /**
   * Record which RunPod shape this tenant got (cp#270).
   *
   * A SEPARATE call from setTenantEndpoints rather than a second argument to it, deliberately:
   * the reprovision path rewrites endpoints_json for an existing tenant and must NOT be able to
   * change its mode as a side effect of that write. Two facts, two writers.
   */
  setTenantRunPodMode(id: string, mode: RunPodMode): Promise<void>;
  setTenantScript(id: string, scriptName: string, release: string): Promise<void>;
  /**
   * Write (or CLEAR) the release whose studio bytes this tenant runs (cp#139).
   *
   * Nullable on purpose, and the null is the load-bearing half: a studio upgrade clears this before
   * its first write, so a run that dies mid-move leaves "not known to be uniformly at any release;
   * consult the job row" rather than a value claiming the move completed. Same discipline
   * modules_release already follows. setTenantScript cannot express it (it takes a non-null release
   * because a provision always knows what it uploaded).
   */
  setTenantStudioRelease(id: string, release: string | null): Promise<void>;

  /**
   * Declare (or un-declare) this tenant unreachable for the video-finish tier (cp#136).
   *
   * ONE call for both directions, taking `null` to clear, because the flag, the reason and the
   * timestamp are one fact and must never be written apart: a flag with no reason is a state nobody
   * can explain, and a reason left standing under a cleared flag is a label outliving its cause.
   *
   * The STUDIO half is not here. This writes the record; projecting it onto the studio var is the
   * caller job (src/video-finish-tier-state.ts), so the source of truth has exactly one writer.
   */
  setTenantVideoFinishUnreachable(id: string, mark: { reason: string; at: string } | null): Promise<void>;

  /**
   * Record the per-tenant storage-ceiling decision (cp#183). `null` clears it back to inheriting the
   * plane default; 'none' records a deliberate no-ceiling, which is NOT the same state.
   *
   * The record is written only after the studio has been proven able to receive the projection, so
   * the plane never remembers a ceiling it failed to deliver (the cp#136 ordering).
   */
  setTenantStorageQuota(
    id: string,
    override: { mode: "set"; bytes: string } | { mode: "none" } | null,
  ): Promise<void>;

  /**
   * Blank ONE resource column, on that resource's successful deletion (#23).
   *
   * Per-resource rather than all-at-once because teardown is best-effort: it can reap the worker and
   * fail on the bucket, and a row that blanked both would then claim the bucket is gone when it is
   * still there holding a customer's films.
   */
  clearTenantResource(id: string, resource: TenantResourceKind): Promise<void>;

  /** Stamp a programmatic-token rotation on the tenant row (cf#94). */
  setApiTokenRotatedAt(id: string): Promise<void>;

  /** Record that a teardown ran and what it failed to reap ('[]' when it reaped everything). */
  recordTeardown(id: string, failures: { resource: string; error: string }[]): Promise<void>;
  /**
   * Write harvested RunPod job rows into the control-plane index (cp#270, migration 0019).
   *
   * UPSERT BY job_id, and the conflict rule is the interesting half: a later harvest of the SAME
   * job may carry a terminal outcome the earlier one did not, so a re-harvest must be able to
   * complete a row. It must NOT be able to blank one -- a tenant database that lost its log
   * would otherwise erase what we already saved, which is the one thing an index that outlives
   * its source must never do. Implementations therefore fill NULLs and never overwrite a
   * non-NULL with a NULL.
   *
   * Returns the number of rows WRITTEN, so a caller can assert a positive-evidence floor rather
   * than reading a silent no-op as a successful harvest.
   */
  indexRunpodJobs(
    tenantId: string,
    tenantSlug: string,
    rows: HarvestedJob[],
  ): Promise<number>;

  // ---- the PROXY push path into the same index (cp#290, migrations 0020 + 0021) ----------------
  //
  // Two writes per job, and no more: one when the proxy submits, one when the job ends. The poll
  // path has no store at all, which is what keeps this at ~2 writes per job rather than the
  // (shots x ticks) a per-poll write would cost on a database that serialises queries.

  /**
   * Open the row at SUBMIT, the moment RunPod hands back a job id.
   *
   * This is the attribution write, and it is the whole reason the proxy exists: the (job id ->
   * tenant) map is produced AT SOURCE instead of reconstructed later by a fan-out scan of every
   * tenant database. `source` is written 'proxy' so a reader can tell a row we saw submitted from
   * one we found afterwards -- different freshness, different coverage, and a reader that cannot
   * tell them apart will read an absent push as an absent JOB.
   */
  openRunpodProxyJob(row: ProxyJobOpen): Promise<void>;

  /**
   * Resolve the callback credential to its job. Returns null for an unknown token, which is the
   * ONLY thing the callback route is allowed to learn from an unverified caller.
   *
   * The endpoint id comes back because the authoritative `GET /status/{id}` needs it, and it must
   * come from OUR row rather than from the inbound body -- the body is a stranger's claim.
   */
  findRunpodProxyJobByWebhookToken(tokenSha256: string): Promise<ProxyJobRef | null>;

  /**
   * Close the row at TERMINAL, from facts we read ourselves.
   *
   * IDEMPOTENT BY `WHERE terminal_at IS NULL`, and that guard is load-bearing under ORDINARY
   * conditions, not only against an attacker: RunPod delivered one job's terminal callback THREE
   * times with byte-identical bodies when the receiver was merely slow enough to look failed
   * (measured 2026-08-02). Without it that is a 3x double-count of one job.
   *
   * Returns the number of rows actually written, so a caller can tell a first close from a
   * duplicate rather than reading a silent no-op as success.
   */
  closeRunpodProxyJob(row: ProxyJobClose): Promise<number>;

  /**
   * The reconciler's work queue: rows the proxy opened and no terminal write has closed (cp#290).
   *
   * SCOPED TO source='proxy' AND endpoint_id IS NOT NULL, and the exclusion is REPORTED rather than
   * silent. A harvested row can also sit open, and the sweep must not touch it: we did not submit
   * it through the proxy, so the endpoint it needs to ask about may not be recorded. A sweep that
   * silently skipped those would report a clean run over a population it never examined.
   *
   * `before` is a submitted_at ceiling, so a row younger than the adopt delay is never swept -- a
   * working push must not be raced by the backstop that exists for when the push fails.
   */
  listOpenRunpodProxyJobs(before: number, limit: number): Promise<OpenProxyJob[]>;

  /** How many open proxy rows the sweep is NOT eligible to examine, for the same reason a sweep
   *  reports its denominator: a cap or an exclusion nobody prints reads as full coverage. */
  countOpenRunpodProxyJobs(before: number): Promise<number>;

  // ---- preservation holds (cp#118) -------------------------------------------------------------
  //
  // The technical half of "never run teardown on a tenant with an open abuse report" (runbook
  // Section 5.2). Suspend stays the lever for an open incident: instant, reversible, audited, and it
  // destroys nothing. These three calls exist so teardown can REFUSE rather than rely on the
  // operator having read that paragraph recently.

  /** Open a hold. The reason is mandatory upstream; a hold nobody can explain is not auditable. */
  openPreservationHold(hold: {
    id: string;
    tenant_id: string;
    kind: PreservationHoldKind;
    reason: string;
    opened_by: string;
    expires_at: string | null;
  }): Promise<PreservationHold>;

  /**
   * Every hold on a tenant, newest first. openOnly asks the interlock question -- and it is answered
   * by released_at IS NULL ALONE, never by comparing a clock to now: an elapsed preservation floor
   * is not permission to delete.
   */
  listPreservationHolds(tenantId: string, opts?: { openOnly?: boolean }): Promise<PreservationHold[]>;

  /**
   * Release a hold. Returns null if it does not exist or was ALREADY released -- a second release
   * must not read as a fresh one, because the audit row is the record of who decided the duty was
   * over. Releasing is the only way a hold stops blocking.
   */
  releasePreservationHold(holdId: string, releasedBy: string, reason: string): Promise<PreservationHold | null>;

  /**
   * Every OTHER tenant row that still points at any of these resources (#23).
   *
   * This exists because the resource ids on a tenant row are not private to it. Resource NAMES
   * derive from the SLUG, and the house pattern frees a slug by RENAMING the old row, so the old row
   * keeps the ids while the next tenant to take that slug provisions onto the same names -- and
   * therefore the same objects. Slug reuse is resource reuse. A census of the live plane found ONE
   * physical D1 referenced by nine successive tenant rows, eight of them tombstones and one of them
   * the LIVE tenant.
   *
   * So "is this id on the row I am tearing down" does not answer "is this object mine to delete".
   * Only this does.
   */
  findResourceReferrers(
    exceptTenantId: string,
    resources: TenantResourceRefs,
  ): Promise<ResourceReferrer[]>;
  /**
   * Take the DESTRUCTIVE lease on a tenant, so exactly one teardown runs at a time (#23).
   *
   * Same serialization point as claimReclaim and for the same reason: every tenant resource name
   * derives from the SLUG rather than the attempt, so two concurrent teardowns issue the SAME
   * delete calls, and the loser can land its deletes on whatever was rebuilt under those names. It
   * shares the reclaim lease columns deliberately: there is ONE destructive lease per row, and two
   * independent ones would not exclude each other.
   *
   * Unlike claimReclaim this is NOT account-scoped and NOT Tier-A-scoped. An operator teardown has
   * to run on a LIVE tenant and on a row a previous pass left half-reaped, which are the two
   * populations claimReclaim exists to exclude.
   *
   * It writes status='deleting' -- a destructive pass is in flight -- but NEVER on a row that is
   * already 'deleted'. A tombstone being re-swept (the orphan module-script sweep) must not lose
   * its tombstone because a sweep ran. Promotion to 'deleted' belongs to finishTeardown, and only
   * when the reap actually completed.
   */
  beginTeardown(id: string, leaseSeconds: number): Promise<{ tenant: Tenant; lease_token: string } | null>;
  /**
   * Release the teardown lease, and promote the row ONLY if the reap actually happened.
   *
   * `reaped` true writes status='deleted' + deleted_at (preserving an existing deleted_at, so a
   * re-sweep does not rewrite history). False leaves the status exactly as it was, with
   * teardown_at / teardown_failures carrying what refused or failed -- because the entire point of
   * #23 is that "deleted" must never mean anything but "provably reaped".
   *
   * Holding the TOKEN is the proof this caller took the lease; a caller whose lease was taken over
   * gets null and writes nothing.
   */
  finishTeardown(id: string, leaseToken: string, reaped: boolean): Promise<Tenant | null>;
  /**
   * Set (or deliberately CLEAR, with null) the tenant module release.
   *
   * Takes null rather than exposing a separate clear method because the two calls are one
   * protocol: the upgrade clears before its first write and sets only on full success, and a
   * clear that could not be expressed here would push callers into writing a sentinel string.
   */
  setTenantModulesRelease(id: string, release: string | null): Promise<void>;
  /** The encrypted per-tenant STUDIO_API_TOKEN value (dispatcher-injected auth). Value, not a hash. */
  setTenantStudioToken(id: string, encValue: string): Promise<void>;
  /**
   * cp#95: EVERY row carrying an encrypted studio token, whatever its status.
   *
   * Deliberately not filtered to live tenants. A parked or deleted row still holds a customer
   * credential encrypted under the key a rotation is about to retire, and the house pattern is
   * park-and-rename rather than delete, so a status filter here would leave real ciphertext behind
   * and let a census answer "safe to promote" while it was not.
   */
  listEncryptedStudioTokens(): Promise<{ id: string; slug: string; studio_token_enc: string }[]>;
  /**
   * cp#95: compare-and-set on the ciphertext, for the rotation sweep.
   *
   * The sweep holds a decrypted token across an await, so a provision that re-minted the token in
   * that gap would be silently reverted by a blind UPDATE -- leaving the tenant authenticating with
   * a token its own studio no longer accepts. Returns whether the row was written.
   */
  setTenantStudioTokenIfUnchanged(id: string, expectedEnc: string, newEnc: string): Promise<boolean>;

  // provision jobs
  /**
   * Create a provision job, carrying the two facts a later resume cannot reconstruct (cp#301).
   *
   * `facts` is REQUIRED rather than optional, and that is the whole point of the parameter: an
   * optional one would let a call site omit the mode and produce a job row that is silently
   * unresumable, which is the exact silent-inert shape this repo keeps refusing. Same reasoning
   * that made createModuleUpgradeJob a separate method below.
   */
  createProvisionJob(
    id: string,
    tenantId: string,
    kind: "provision" | "deprovision",
    facts: ProvisionJobFacts,
  ): Promise<ProvisionJob>;
  /**
   * A module_upgrade job, which carries the release pair the provision kinds have no use for.
   * Separate from createProvisionJob so the release pair is REQUIRED where it is meaningful rather
   * than optional everywhere, and so no caller can create an upgrade job that forgot where it came
   * from (the one fact a failed upgrade cannot be reconstructed without).
   */
  createModuleUpgradeJob(
    id: string,
    tenantId: string,
    fromRelease: string | null,
    toRelease: string,
  ): Promise<ProvisionJob>;
  /**
   * A studio_upgrade job (cp#139): the STUDIO bytes move, which is a different fact from the module
   * move and therefore a different job kind on the same two release columns.
   *
   * Separate from createModuleUpgradeJob rather than a kind parameter on it, deliberately: the two
   * kinds NULL different tenant columns before their first write (modules_release vs studio_release),
   * so a caller that picked the wrong kind would clear the wrong fact and leave the other column
   * asserting a uniformity that no longer holds. Two names make that unmistakable at the call site.
   */
  createStudioUpgradeJob(
    id: string,
    tenantId: string,
    fromRelease: string | null,
    toRelease: string,
  ): Promise<ProvisionJob>;
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
  /**
   * Refresh the lease on a job THIS invocation is driving (cp#148).
   *
   * The heartbeat behind "lease live == driver alive". Two properties are load-bearing:
   *
   *   - it must NOT touch updated_at. That column is the PROGRESS clock the lost-driver rule reads
   *     (MAX_JOB_STALE_MS), so a heartbeat that bumped it would make a driver that is alive but
   *     wedged immortal. Liveness and progress are different facts and stay in different columns.
   *   - it must refuse a TERMINAL job. A driver whose job was already finished by someone else must
   *     not put a live lease back on that record.
   *
   * Returns false when nothing was renewed, which is the honest signal that this driver no longer
   * owns the job it is still working on.
   */
  renewJobLease(id: string, leaseSeconds: number): Promise<boolean>;
  /**
   * Hand the job back at a YIELD boundary (cp#158).
   *
   * A driver that yields is done writing, but its lease runs on for up to the remainder of
   * JOB_LEASE_SECONDS, so the job sits un-drivable for up to a minute of pure dead time before the
   * next poll can pick it up. That is latency, not a correctness bug, and this is the direct cure:
   * the driver that knows it is leaving says so, instead of the next driver waiting out a lease
   * nobody is holding.
   *
   * Like renewJobLease it leaves updated_at ALONE (liveness is not progress) and REFUSES a terminal
   * job, so a driver whose job was finished by someone else cannot write to that closed record.
   * Returns whether a row was actually released.
   */
  releaseJobLease(id: string): Promise<boolean>;
  /**
   * Record progress. REFUSES a terminal job (cp#148): a late mark from a driver whose job was
   * already failed by a poll would otherwise overwrite step / steps_done on the terminal record and
   * re-arm its lease, leaving a failed job that reads as live and progressing.
   */
  updateJobProgress(id: string, step: string, stepsDoneJson: string): Promise<void>;
  finishJob(id: string, status: "succeeded" | "failed", errorStep: string | null, errorMessage: string | null): Promise<void>;

  // ---- invoke-key handoffs (cp#169) ----
  /** Mint one. The caller hashes; this store never sees the token value. */
  createInvokeKeyHandoff(row: Omit<InvokeKeyHandoff, "created_at" | "consumed_at">): Promise<void>;
  /**
   * Read a handoff WITHOUT consuming it: the page needs to show the owner which endpoints to scope
   * before they have anything to submit. Returns the row whatever its state, so the caller can tell
   * expired from consumed from unknown -- three different sentences for a person to read.
   */
  getInvokeKeyHandoff(tokenHash: string): Promise<InvokeKeyHandoff | null>;
  /**
   * BURN it, single-use, and the UPDATE is the gate (the consumeLoginToken shape): the row comes
   * back only if this call is what consumed it, so two concurrent completions cannot both count.
   * Called only after an install has actually reached `live`.
   */
  consumeInvokeKeyHandoff(tokenHash: string, now: string): Promise<InvokeKeyHandoff | null>;

  // settings + audit
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string, updatedBy: string): Promise<void>;
  recordAdminAction(actor: string, action: string, target: string | null, detail: string | null): Promise<void>;
  /**
   * READ the admin trail (cp#219).
   *
   * admin_audit has been append-only with no reader since 0001, and the ruling on operator access
   * asks for a record that is "durable and reviewable, so the claim is checkable". A trail nobody
   * can read is durable and not reviewable, which satisfies the letter and defeats the point.
   *
   * Newest first, bounded by `limit`, optionally filtered to one target (a tenant id). No cursor:
   * this is an incident-review surface with near-zero expected volume, and a pagination contract
   * nobody exercises is a contract that rots.
   */
  listAdminAudit(opts: { target?: string; limit: number }): Promise<AdminAuditRow[]>;

  // ---- named operator credentials (cp#219) ----
  /**
   * Mint. The CALLER hashes: this store never sees a token value, exactly like the invoke-key
   * handoff and the login-token paths. Throws on a duplicate live name or a duplicate hash, both of
   * which are enforced by the schema rather than by a check here.
   */
  createOperatorCredential(row: Omit<OperatorCredential, "created_at" | "last_used_at" | "revoked_at" | "revoked_by">): Promise<void>;
  /**
   * The auth path. Returns the row WHATEVER its state (revoked, expired) and lets the caller decide,
   * because "revoked" and "never existed" are different facts and only the caller knows which of
   * them it is safe to say out loud.
   */
  getOperatorCredentialByHash(tokenHash: string): Promise<OperatorCredential | null>;
  /** Every credential, live and revoked, newest first. Never returns a token value; there is none. */
  listOperatorCredentials(): Promise<OperatorCredential[]>;
  /**
   * Soft revoke. Returns whether THIS call is what revoked it, so a repeat is visibly a no-op rather
   * than a second revocation with a second timestamp.
   */
  revokeOperatorCredential(id: string, revokedBy: string, now: string): Promise<boolean>;
  /**
   * Stamp last_used_at. Called OUTSIDE the request path (ctx.waitUntil) and never awaited by the
   * gate: a failed stamp must never become a failed authentication.
   */
  touchOperatorCredential(id: string, now: string): Promise<void>;

  // ---- operator smoke renders (cp#45) ----
  /**
   * OPEN a smoke render, or refuse. THE WRITE IS THE GATE.
   *
   * This is the spend guard, and it is one conditional INSERT on purpose. The route costs GPU by
   * definition, so a check-then-insert would let two concurrent operator requests both pass the
   * check and both burn a render. The predicate lives in the INSERT's WHERE, where SQLite's single
   * writer serializes it, exactly like claimReclaim: the check that runs beforehand exists to
   * produce a LEGIBLE refusal, never to authorize.
   *
   * Returns null when any bound is hit. Call describeSmokeRenderRefusal to say WHICH one, and note
   * that a refusal here has written nothing at all -- no row, no dispatch, no GPU.
   */
  openSmokeRender(
    id: string,
    tenantId: string,
    modulesRelease: string | null,
    bounds: SmokeRenderBounds,
  ): Promise<SmokeRender | null>;
  /**
   * Why an open would be refused, in words. ADVISORY ONLY (it is a read, so it can be stale by the
   * time the INSERT runs); openSmokeRender is what actually decides.
   */
  describeSmokeRenderRefusal(tenantId: string, bounds: SmokeRenderBounds): Promise<string | null>;
  getSmokeRender(id: string): Promise<SmokeRender | null>;
  /** The studio accepted the submit. Records the studio-side ids so an operator can correlate. */
  setSmokeRenderSubmitted(id: string, studioJobId: string, bundleKey: string): Promise<void>;
  /**
   * Terminal, and written ONLY by the poll that observed the outcome.
   *
   * The artifact fields are all-or-nothing and only ever accompany "succeeded": they describe bytes
   * this worker actually PULLED. There is deliberately no way to record a success without them,
   * because a success with no fetched bytes is the phase=done lie this route exists to end.
   */
  finishSmokeRender(
    id: string,
    outcome:
      | { status: "succeeded"; artifact: SmokeRenderArtifact }
      | { status: "failed"; error: string },
  ): Promise<void>;
}

/** The tunable half of the spend guard. Every field is a hard bound, never a hint. */
export interface SmokeRenderBounds {
  /** No second smoke render for THIS tenant until this many seconds after the last one STARTED. */
  cooldownSeconds: number;
  /** Ceiling on smoke renders across ALL tenants in the trailing 24h. The blast-radius bound. */
  dailyCap: number;
  /**
   * How long a "running" row blocks a new submit for the same tenant. Bounded rather than infinite
   * so a smoke render whose poll never returned cannot wedge the route forever; it is longer than
   * any legitimate keyframe render, so it never races a live one.
   */
  inFlightSeconds: number;
}

/** Proof of bytes this worker fetched. Never inferred from a status field. */
export interface SmokeRenderArtifact {
  key: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

/**
 * One operator-initiated canonical smoke render against one tenant (cp#45).
 *
 * What this row is EVIDENCE OF, stated precisely, because the whole issue was a claim outrunning
 * its proof: status="succeeded" means this worker submitted a canonical keyframe render THROUGH
 * THIS TENANT's own studio and module workers, then pulled the resulting bytes back and hashed
 * them. It does NOT mean the tenant's other modules render -- see SMOKE_RENDER_COVERAGE.
 */
export interface SmokeRender {
  id: string;
  tenant_id: string;
  status: "running" | "succeeded" | "failed";
  modules_release: string | null;
  studio_job_id: string | null;
  bundle_key: string | null;
  artifact_key: string | null;
  artifact_bytes: number | null;
  artifact_sha256: string | null;
  artifact_content_type: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

// --------------------------------------------------------------------------- credits (cp#189)

/**
 * The credit data seam, kept SEPARATE from ControlPlaneStore on purpose.
 *
 * Every other store method has a MemoryStore fake behind it, which is right for lifecycle logic. It
 * would be wrong here. A hand-written fake ledger would let money behaviour -- idempotency, the
 * capture race, the sign constraints -- be "proven" against an implementation that shares none of the
 * real one's failure modes, which is the precise shape of a stub encoding the author's own assumption.
 * So there is deliberately NO fake: the pure decisions are tested as pure functions with no store at
 * all, and everything that is a property of the SQL is tested against a real engine built from the
 * real migrations. If a future caller wants a fake for convenience, that is the moment to re-read
 * this paragraph.
 */
export interface CreditStore {
  /**
   * Append a money row. Idempotent on (tenant_id, idem_ref): a replay returns the EXISTING row with
   * applied=false rather than writing a second one. Callers must treat applied=false as success.
   */
  appendLedgerRow(row: {
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
  }): Promise<{ applied: boolean; row: import("./credits").LedgerRow }>;

  /** SUM of ledger deltas and SUM of OPEN holds, in micro-USD. Throws if either read fails. */
  readBalanceSums(tenantId: string): Promise<{ settled: number; held: number }>;

  /** Most recent money rows for a tenant, newest first. */
  listLedger(tenantId: string, limit: number): Promise<import("./credits").LedgerRow[]>;

  /**
   * Reserve funds for one job. Idempotent on (tenant_id, job_ref): a retried submit returns the
   * EXISTING hold with created=false rather than reserving the tenant's balance twice.
   */
  takeHold(args: {
    id: string;
    tenantId: string;
    jobRef: string;
    amountMicroUsd: number;
    priceListId: string;
    now: string;
    expiresAt: string;
  }): Promise<{ created: boolean; hold: import("./credits").HoldRow }>;

  /**
   * Settle a hold into a debit, atomically. Returns captured=false when this caller did not win the
   * race or the hold was no longer open (already released for a failed job, say) -- in which case NO
   * debit exists and none will be written.
   */
  captureHold(args: {
    holdId: string;
    ledgerRowId: string;
    costMicroUsd: number | null;
    note: string | null;
    now: string;
  }): Promise<{ captured: boolean }>;

  /** Release a hold without charging (the completed-only path for a failed job). */
  releaseHold(holdId: string, now: string): Promise<{ released: boolean }>;

  /** Flip open holds past their expiry. Returns how many were swept. */
  expireHolds(now: string): Promise<number>;

  getHoldByJobRef(tenantId: string, jobRef: string): Promise<import("./credits").HoldRow | null>;

  /**
   * Recent holds for a tenant, newest first.
   *
   * Added for the READ surface (cp#192), not for the gate. A failed job leaves a released hold and NO
   * ledger row, so a statement built from money rows alone shows a tenant nothing where their failed
   * render should be -- silence that reads as a lost record rather than as a deliberate non-charge.
   */
  listHolds(tenantId: string, limit: number): Promise<import("./credits").HoldRow[]>;

  /**
   * Captured holds carrying no debit row. Should always be empty (capture is one atomic batch); it
   * is queryable anyway, because "should be empty" is a claim and an empty result is the proof.
   */
  capturedHoldsMissingDebit(limit: number): Promise<import("./credits").HoldRow[]>;
}
