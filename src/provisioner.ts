// The tenant provisioner (#53): durable, resumable, idempotent-by-name.
//
// WHAT "RESUMABLE" MEANS HERE, precisely, because the obvious reading is wrong:
// resume RE-RUNS FROM THE TOP; it does not skip completed steps. Every step is idempotent-by-name
// (a create that hits an existing resource ADOPTS it), which is what makes that safe, and it is the
// only honest option: the secret-producing step (the R2 token mint) has no stored output to skip
// with, because we deliberately never store the credential it produces. A skip-list would either
// force us to persist secrets or silently leave a tenant with a worker bound to a credential
// nobody holds. steps_done is therefore a PROGRESS RECORD (for the UI and for honest error
// reporting), not a skip-list.
//
// KEY CUSTODY: the tenant's RunPod key (key A) is a PARAMETER, never a field. It lives in the
// request that carries it and in this function's arguments, and nowhere else: not in D1, not in a
// log, not on the job row. That is why a job failing in the RunPod step cannot self-resume, and why
// /retry answers 409 runpod_key_required instead of quietly re-running with a key it kept.

import type { CfApi } from "./cf-api";
import { CfApiError, isScriptAbsent } from "./cf-api";
import { applyStudioMigrations, type StudioMigration } from "./migrate";
import { randomToken } from "./crypto";
import type { TemplateConvergence, TenantR2Creds } from "./runpod";
import type { SharedRunPodPool } from "./runpod-pool";
import { readRunPodMode, type RunPodMode } from "./runpod-pool";
import { harvestTenantJobLog, HARVEST_ROW_CAP } from "./runpod-job-index";
import {
  JOB_LEASE_SECONDS,
  type ControlPlaneStore,
  type ResourceReferrer,
  type Tenant,
  type TenantResourceKind,
} from "./store";
import { emptyBucketBounded, type EmptyBucketResult } from "./r2-empty";
import type { KekRing } from "./token-crypto";
import { decryptStudioToken, encryptStudioToken } from "./token-crypto";
import { REQUIRED_TENANT_STUDIO_VARS, assertDispositionCoversContract } from "./tenant-studio-env";
import { abuseReportUrlBindings } from "./tenant-abuse-report";
import { resolveStorageQuota, storageQuotaBindings, type StorageQuotaConfig } from "./tenant-storage-quota";
import { videoFinishTierStateBindings } from "./video-finish-tier-state";
import type { TokenMinter } from "./token-minter";
import type { ModuleBundle, ModuleBundleSource } from "./tenant-modules";
import {
  TENANT_MODULE_CATALOG,
  installTenantModules,
  prefetchModuleBundles,
  teardownTenantModules,
  uploadTenantModules,
  verifyTenantModulesInstalled,
  TenantModuleError,
} from "./tenant-modules";

/** The named steps, in order. These strings reach the tenant's screen; keep them legible. */
export const PROVISION_STEPS = [
  "d1_create",
  "d1_migrate",
  "r2_bucket",
  "r2_token",
  "runpod_endpoints",
  "wfp_upload",
  "modules_upload",
  "modules_install",
  "verify",
] as const;
/**
 * PRECONDITIONS: named so a failure is attributable, but NOT members of PROVISION_STEPS.
 *
 * They create nothing, are never marked done, and are never resumed. Keeping them OUT of
 * PROVISION_STEPS is load-bearing rather than tidy: `inferStep` maps `done.length` to a step BY
 * INDEX, so inserting a precondition into that array would shift every inference by one and quietly
 * mislabel every later failure. This was caught by the step-order test, which is exactly what it is
 * there for.
 *
 * `bundle_fetch` exists because without it a bad release pin surfaced as `step: "d1_create"` (the
 * inferStep default for an empty progress list), sending an operator to look at D1 quota when the
 * real cause was the pinned tag or an empty mirror slot.
 */
export const PROVISION_PRECONDITIONS = ["bundle_fetch"] as const;

export type ProvisionStep = (typeof PROVISION_STEPS)[number] | (typeof PROVISION_PRECONDITIONS)[number];

/** The steps a job can actually RECORD as done. Preconditions are excluded by construction. */
export type MarkableProvisionStep = (typeof PROVISION_STEPS)[number];

/** One of the tenant's 4 RunPod endpoints, as Joan's screens render them. */
export interface TenantEndpoint {
  key: string;
  label: string;
  id: string;
  name: string;
  /** The studio env var this endpoint id is wired into (spec.endpointVar). */
  endpointVar: string;
}

/**
 * The RunPod half of provisioning (#54). Split behind a seam because it is a different lane AND a
 * different trust domain: this is the only part that touches the tenant's transient key.
 */
export interface RunPodProvisioner {
  /**
   * r2 is the REAL minted bucket credential (S3-derived), because the satellite templates carry it
   * and a render reads it. The live e2e once passed placeholders here, which provisioned endpoints
   * whose first render would have failed on R2 auth; the seam takes the credential so the shipping
   * wiring cannot repeat that.
   */
  createEndpoints(runpodApiKey: string, slug: string, r2: TenantR2Creds): Promise<TenantEndpoint[]>;
  /**
   * Move this tenant's EXISTING templates onto the pins the plane currently holds (cp#137).
   *
   * On the seam rather than reached for directly, so there is still exactly one RunPod injection
   * point. Required rather than optional: an optional method would let a wiring omission read as
   * "nothing to converge", which is the silent-skip shape this repo keeps refusing.
   */
  convergeTemplateImages(runpodApiKey: string, slug: string): Promise<TemplateConvergence[]>;
}

/**
 * Where the published studio bundle comes from.
 *
 * SEAM ON PURPOSE, and currently the open question in #53: the control plane is a Worker and cannot
 * build. Nothing in the repo publishes a built studio bundle today (install-module.ts takes a
 * pre-built --code from an operator), so how the release artifact is produced and fetched is a call
 * that crosses into CI/release. Whatever we pick (release asset, R2, npm), it is an implementation
 * of THIS interface and not a rewrite of the provisioner.
 */
export interface StudioBundleSource {
  /** The published release, unmodified. Parity depends on this being the real artifact. */
  fetch(release: string): Promise<{
    mainModule: string;
    moduleText: string;
    compatibilityDate: string;
    compatibilityFlags?: string[];
    /**
     * The release's OWN asset handling (manifest assets_config, #78). Consumed verbatim, never
     * re-derived: html_handling="none" + run_worker_first=true are load-bearing in the core (the
     * #374 redirect loop and the post-v0.7.4 unheadered-pages finding), and hardcoding them here
     * would be the exact drift the manifest exists to prevent.
     *
     * `{}` is MEANINGFUL, not missing: it means the release was built with CF's defaults, so the
     * tenant gets CF's defaults. Substituting the core's values for an empty object would re-create
     * the hardcode one layer up.
     */
    assetsConfig?: Record<string, unknown>;
    assets?: { path: string; base64: string; contentType: string; hash: string; size: number }[];
    /**
     * The tenant D1 schema, carried BY the release (cf#85, manifest v1.3.1+).
     *
     * These used to be imported out of the vivijure-cf source tree at the control plane build time,
     * which meant a tenant could get its SCHEMA from the control plane deploy commit and its WORKER
     * from a pinned release tag: two different versions of the studio in one tenant. Sourcing both
     * from the same pinned artifact makes that skew impossible.
     *
     * Apply order IS array order, and `name` is the tracking key recorded in the tenant
     * schema_migrations table, so neither is cosmetic.
     */
    migrations: StudioMigration[];
    /**
     * The studio env var contract as of this release (ORCHESTRATOR_VAR_KEYS, manifest v1.3.1+).
     * The provisioner binds these onto the tenant studio; deriving the census from the pinned
     * artifact is what stops it drifting from what the studio actually reads.
     */
    requiredVars: string[];
  }>;
}

export interface ProvisionDeps {
  store: ControlPlaneStore;
  cf: CfApi;
  runpod: RunPodProvisioner;
  bundle: StudioBundleSource;
  /** Where tenant MODULE worker bundles come from (cf#99). Same seam as `bundle`, per module. */
  moduleBundle: ModuleBundleSource;
  /**
   * The R2 credential seam. Split out because it is the one leg our API-created provisioner token
   * cannot perform (CF refuses API-created tokens any token-management rights), so it is blocked on
   * a dashboard-created cred while every other leg is live-verified.
   */
  tokenMinter: TokenMinter;
  /** The account S3 endpoint (https://<account>.r2.cloudflarestorage.com) the satellites use. */
  r2Endpoint: string;
  /**
   * The SHARED RunPod endpoint pool this plane offers, or null when it offers none (cp#270).
   *
   * Present means a tenant that brings NO RunPod key of its own can still be provisioned: it
   * rides these endpoints and creates zero new ones. Null means this plane has no shared tier and
   * every tenant must bring a key, which is exactly the behaviour before this existed.
   *
   * NULL IS THE HONEST DEFAULT and it is also the safe one. An unconfigured or malformed pool
   * resolves to null (parseSharedPool refuses rather than partially resolving), so the failure
   * mode of bad config is `runpod_key_required` -- a tenant who cannot provision -- never a
   * tenant provisioned onto a pool that covers three of four capabilities.
   */
  sharedPool: SharedRunPodPool | null;
  /**
   * The pool's invoke key (key B for the shared tier), or null when no pool is configured.
   *
   * SEPARATE FIELD from sharedPool, deliberately: the pool is identifiers and is safe to log,
   * report and store, and this is a secret that goes from env into a worker secret binding and
   * nowhere else. Keeping them apart means an error message or a log line built from a pool
   * cannot carry the credential by accident.
   *
   * CUSTODY NOTE, because this inverts the two-key design for one tier: on the dedicated path
   * key B belongs to the TENANT, is minted in their console, and is proven endpoint-scoped by
   * verifyInvokeKeyScope at paste time. A pooled tenant has no RunPod account, so the key is
   * OURS. It must therefore be a per-function key, invoke-only and scoped to exactly the pool
   * endpoints, and revoking it affects every shared tenant at once rather than one.
   */
  sharedPoolInvokeKey: string | null;
  /**
   * The client that uploads TENANT SCRIPTS, which is the call that attaches bindings (cf#118).
   *
   * WHY A SECOND CLIENT AND NOT A WIDER FIRST ONE. Attaching a Workers VPC binding needs
   * Connectivity Directory access, and Cloudflare will not let an API-created token mint a token
   * carrying that scope -- so the capability cannot be added to the provisioner credential the way
   * the R2 mint was. The function is split instead: the provisioner keeps D1 / R2 / token-mint, and
   * a narrower `vivijure-cp-worker-upload` credential (Workers Scripts Write + Connectivity
   * Directory) owns script upload. Per-function keys, arrived at by constraint rather than taste.
   *
   * DEFAULTS TO `cf` when no upload credential is configured, deliberately: one seam, no second code
   * path, and a plane without the new credential behaves exactly as it did before this change.
   */
  scriptUploadCf: CfApi;
  /**
   * The Connectivity Directory service id for the video-finish tier, or null when this plane does
   * not offer it (cf#118). Null is the honest self-host-parity default: no binding, and the render
   * degrades to per-shot clips with the reason stated, which is what tenants get today.
   */
  videoFinishServiceId: string | null;
  /**
   * The own-iron doors (cp#396), keyed by PROVISION_PLAN key. See TenantModuleDeps.vpcDoors for
   * the both-or-neither rule; resolved once in deps.ts so the module upload and any future studio
   * consumer cannot disagree about whether a door is configured.
   *
   * DISTINCT FROM videoFinishServiceId above, which is a STUDIO binding that render-frames.ts and
   * video-finish-availability.ts genuinely read. These are MODULE bindings. Both are doors onto the
   * same fleet; they are attached to different workers because different code reads them.
   */
  vpcDoors: Record<string, { serviceId: string; token: string }>;
  /**
   * Clock, sleep and fetch, injected rather than reached for globally (#23 / cf#72).
   *
   * Teardown empties a tenant bucket over the S3 API, and that is a BUDGETED loop: it needs a clock
   * a test can move, a sleep a test can make instant, and a fetch a test can script. Taking all
   * three off this bundle keeps ONE seam, the rule the rest of ProvisionDeps already follows,
   * instead of a second test-only path into the destructive code.
   */
  now(): number;
  sleep(ms: number): Promise<void>;
  fetch: typeof fetch;
  namespace: string;
  /** The shared dispatch namespace tenant MODULE scripts live in (vivijure-tenant-modules). */
  moduleNamespace: string;
  release: string;
  tenantScriptName(slug: string): string;
  /**
   * The studio-token KEK RING (cp#95). Writes use the configured write slot; reads open under
   * either installed key, so provisioning keeps working throughout a rotation window.
   */
  kek: KekRing;
  /**
   * The AI Gateway slug bound onto AI-Gateway-backed tenant modules as GATEWAY_ID (cf#56), or null
   * when this plane configures none. Identifier, not a secret. Null degrades plan-enhance to the
   * free local Workers AI provider rather than breaking it.
   */
  aiGatewayId: string | null;
  /**
   * The plane-side RunPod proxy a tenant module is pointed at (cp#288), or null when this plane
   * configures none. Consumed by uploadTenantModules; see TenantModuleDeps.runpodProxy for what
   * null means and why this carries the signing key rather than a minted token.
   */
  runpodProxy: { base: string; signingKey: string } | null;
  /** Optional per-tenant daily spend ceiling set as SPEND_DAILY_CEILING; null -> studio default. */
  spendDailyCeiling: string | null;
  /**
   * The per-tenant R2 storage ceiling this plane configures (cp#183), already validated.
   *
   * `bytes` is bound onto the studio as R2_STORAGE_QUOTA_BYTES; null binds nothing, which core
   * reads as no ceiling. `invalid` carries a set-but-malformed raw value so a write path can REFUSE
   * rather than leave a tenant uncapped while the deploy config claims otherwise.
   */
  storageQuota: StorageQuotaConfig;
  /**
   * The hosted abuse-report page this deploy publishes, bound onto every tenant studio as
   * ABUSE_REPORT_URL (cp#164), or null when the plane cannot name one.
   *
   * DERIVED from CONTROL_PLANE_HOST rather than configured, because the page is served by the
   * control plane itself at a path it ships (src/tenant-abuse-report.ts). Null binds nothing, which
   * is the same unset-renders-nothing behaviour a self-hoster gets, and the correct state for a
   * plane that does not know its own host.
   */
  abuseReportUrl: string | null;
  /**
   * Dispatch a request to the tenant studio over TENANT_DISPATCH, attaching the studio bearer so
   * the AUTH_MODE=token gate passes. Proves the studio SERVES (GET /) and drives its own module
   * install + installed-list routes (cf#99). Generalizes the old probeTenantRoot.
   */
  callTenantStudio(
    scriptName: string,
    init: { method: string; path: string; studioApiToken: string; body?: string },
  ): Promise<{ status: number; text: string }>;
  /**
   * Dispatch a GET to one tenant MODULE script over TENANT_MODULE_DISPATCH (cf#114). Separate from
   * callTenantStudio: module scripts live in a DIFFERENT dispatch namespace and take no bearer,
   * because GET /ready is unauthenticated by design.
   */
  callTenantModule(scriptName: string, path: string): Promise<{ status: number; text: string }>;
  log(event: string, fields: Record<string, unknown>): void;
}

/** Deterministic, tenant-scoped resource names. Idempotency depends on these being stable. */
export const tenantD1Name = (slug: string) => `vivijure-tenant-${slug}`;
export const tenantBucketName = (slug: string) => `vivijure-tenant-${slug}`;
export const tenantR2TokenName = (slug: string) => `vivijure-tenant-${slug}-r2`;
/**
 * This tenant AI Gateway Run token for MODULE workers (cf#56). DETERMINISTIC from the slug, like
 * the R2 token name and for the same reason: the value is never stored, so a token whose id we lost
 * can still be revoked by name (the cf#91 census path). No new column is needed -- unlike the R2
 * credential, whose id doubles as the S3 access key id, this token id is only ever needed to revoke.
 *
 * Studio planner/chat uses a SEPARATE grant (`tenantStudioAigTokenName`): sharing one Run token
 * between the studio script and every module would mean a compromise of either surface bills and
 * revokes the other (cf#98 audit).
 */
export const tenantAigTokenName = (slug: string) => `vivijure-tenant-${slug}-aig`;

/** Studio-only AI Gateway Run token (cf#98). Distinct from the module grant above. */
export const tenantStudioAigTokenName = (slug: string) => `vivijure-tenant-${slug}-aig-studio`;

/**
 * The credential a TEARDOWN cycle mints for itself to empty a bucket (cf#72). Deliberately a
 * DIFFERENT name from the tenant long-lived r2 token: teardown revokes the tenant token by name
 * when its id was never persisted, and a shared name would let either revoke hit the other.
 */
export const tenantR2TeardownTokenName = (slug: string) => `vivijure-tenant-${slug}-teardown`;

/**
 * Wall-clock budget for ONE emptying cycle. Small on purpose: teardown runs inside a request the
 * operator is waiting on, and a bucket too large for one cycle is meant to take several honest
 * cycles rather than one call that silently outlives its invocation.
 */
const TEARDOWN_EMPTY_BUDGET_MS = 15_000;

/**
 * Cloudflare's code for "this token may not attach that VPC binding" (cf#118). Read off a live
 * response during the credential probe, not guessed: the same upload succeeded without the binding
 * and failed with it, on the same token, carrying exactly this code.
 */
const CF_VPC_BINDING_UNAUTHORIZED = 10196;

/**
 * The Workers Rate Limiting namespace the tenant spend limiter binds to. Shared across tenant
 * workers (the limiter keys by client IP, so a shared namespace still throttles per-IP); distinct
 * from the control plane's own CP_RATE_LIMIT namespace. Self-host uses an operator-set id; a fixed
 * platform id is the hosted equivalent.
 */
const SPEND_RATELIMIT_NAMESPACE = "3001";

/**
 * How long ONE invocation will spend driving a job before yielding (#112).
 *
 * WHY THIS EXISTS AT ALL: the job runs under waitUntil, whose extension window is on the order of
 * 30 seconds. Run 4 of the cf#99 finale died exactly here -- 22 of the 30 seconds went to the steps
 * before the module install, the install probe then waited on a real propagation race, and the
 * runtime cancelled the invocation mid-wait. The job row was left saying "running" forever with no
 * error, because the catch that writes a terminal state only runs if the function is still running.
 *
 * Shortening individual waits does not fix that; it only buys headroom until the next slow step.
 * The structural answer is to stop trying to fit a whole provision into one invocation: work until
 * the budget is spent, persist progress, and let the next poll drive the rest.
 */
export const PROVISION_INVOCATION_BUDGET_MS = 15_000;

/**
 * The steps AFTER which a yield leaves a job the next driver can actually carry forward. Every step
 * qualifies EXCEPT runpod_endpoints, and that single exception is the whole of cp#18.
 *
 *   - After a CF-only step (d1_create .. r2_token) nothing billable exists yet, so recovery is a
 *     fresh re-provision (key A in hand) that ADOPTS the idempotent-by-name D1/bucket and re-mints
 *     the token. No strand.
 *   - After wfp_upload and everything past it, a poll-driven continueProvisionJob finishes the job
 *     with NO key A, because all it then needs is on the tenant row (endpoints_json, studio_token_enc).
 *
 * runpod_endpoints is NEITHER: it has just created 4 BILLABLE RunPod endpoints that a keyless poll
 * cannot use and a re-provision would strand. Yielding there produced a permanently unresumable job,
 * because continueProvisionJob refuses anything short of wfp_upload. So the invocation MUST carry
 * runpod_endpoints THROUGH to wfp_upload in the same run; suppressing the yield at exactly this
 * boundary lines the yield boundary up with continueProvisionJob resume boundary. Carrying one extra
 * step past the 15s budget is safe inside the ~30s waitUntil window (the finale run measured the
 * whole pre-install prefix at 22s, and wfp_upload is a fraction of that).
 */
const YIELD_UNSAFE_STEPS = new Set<MarkableProvisionStep>(["runpod_endpoints"]);

/**
 * How often a live driver refreshes its lease (cp#148). A third of the lease, so two consecutive
 * missed beats still leave the job leased; the driver has to be GONE for the lease to lapse.
 */
export const JOB_LEASE_HEARTBEAT_MS = 20_000;

/**
 * Hold the job lease for as long as THIS invocation lives, and return the stopper (cp#148).
 *
 * THE DEFECT THIS CLOSES. The lease was written only by setJobRunning and by mark(), so it said "a
 * step boundary happened within the last 60 seconds", never "a driver is alive". runpod_endpoints is
 * one uninterrupted await with no mark inside it, so on a slow RunPod account (the cp#117 rehearsal
 * measured ~87s in that one step) the lease lapsed at ~68s while the driver was healthy and still
 * working. The next poll found a free claim, won it, and ran continueProvisionJob, which refuses
 * anything short of wfp_upload and writes finishJob(failed) + setTenantStatus(failed) + a
 * destructive rollback. The invocation never "ended" at runpod_endpoints; the job was taken from it.
 *
 * WHY A TIMER AND NOT deps.sleep. deps.sleep models a bounded wait the flow AWAITS, and every
 * budgeted loop in this codebase uses it for exactly that. This is the opposite shape: a background
 * tick whose lifetime is the invocation. setInterval is the runtime primitive for that, and the
 * coupling is the point -- when the invocation dies the timer dies with it, the lease lapses within
 * one beat, and an expired lease finally means what every guard already assumed it meant.
 *
 * A failed renew is LOGGED, never thrown: losing the lease is information about the job, not a
 * reason to break a driver that is otherwise doing real work. The step it is in decides its own
 * fate, and the writes it is racing are now refused store-side.
 *
 * EXPORTED for the studio-upgrade driver (cp#158). That driver lives in its own file and beat
 * nothing, so its lease said "a step boundary happened recently" while a slow migration or asset
 * upload ran -- the pre-cp#148 meaning, on a route whose ONE-writer guard (job_in_progress, which
 * reads jobHasLiveDriver) is the only thing standing between one live studio and two drivers PUTting
 * different bytes into it. It takes THIS function rather than a second copy of it: one heartbeat
 * shape, one place where the interval and the terminal-job refusal are decided.
 */
export function startLeaseHeartbeat(deps: ProvisionDeps, jobId: string): () => void {
  const timer = setInterval(() => {
    void deps.store
      .renewJobLease(jobId, JOB_LEASE_SECONDS)
      .then((held) => {
        if (!held) deps.log("provision.lease_not_held", { job: jobId });
      })
      .catch((e: unknown) => deps.log("provision.lease_renew_failed", { job: jobId, error: String(e) }));
  }, JOB_LEASE_HEARTBEAT_MS);
  return () => clearInterval(timer);
}

/** A job that ran out of invocation budget with work left. NOT a failure: progress is persisted. */
export interface ProvisionYielded {
  ok: false;
  yielded: true;
  after: ProvisionStep;
}

export type ProvisionOutcome =
  | { ok: true; status: "awaiting_invoke_key" }
  | { ok: false; step: ProvisionStep; message: string }
  | ProvisionYielded;

/** Injectable clock so budget behaviour is testable without burning real seconds. */
export interface ProvisionClock {
  now(): number;
}

const realClock: ProvisionClock = { now: () => Date.now() };

/**
 * Per-step wall-clock, for cp#18.
 *
 * THE GAP THIS CLOSES: elapsedMs was logged ONLY on yield, so a provision that SUCCEEDED recorded
 * no timing anywhere. D1 was no help either -- steps_done holds step NAMES and updated_at is
 * overwritten by every progress write, so per-step duration has never been captured for any
 * provision that has ever run. cp#18 has to be MEASURED rather than argued, and this is what
 * produces the numbers.
 *
 * WHAT stepMs ACTUALLY MEASURES, stated precisely because the answer is not "the step's work":
 * it is mark-to-mark, so it includes the previous mark's updateJobProgress write as well as the
 * step itself. That is DELIBERATE. The question cp#18 asks is whether two steps fit inside the
 * 15s invocation budget, and the budget is consumed by everything on the wall clock, D1 writes
 * included. A number that excluded them would be tidier and would understate the thing being
 * bounded.
 *
 * THE FIRST STEP IS THE ONE EXCEPTION WORTH KNOWING: its stepMs runs from startedAt, so it also
 * carries the unmarked precondition work ahead of it (the release bundle fetch, which is
 * deliberately not a marked step). Read the first number as "everything up to and including this
 * step", not as that step alone.
 *
 * Takes the timestamp rather than the clock on purpose: the caller has already read it for the
 * budget check, and this must not add a second read.
 */
function stepTimer(startedAt: number) {
  let previous = startedAt;
  return (step: MarkableProvisionStep, at: number) => {
    const stepMs = at - previous;
    previous = at;
    return { step, stepMs, elapsedMs: at - startedAt };
  };
}

/** Internal control-flow signal: this invocation is out of budget, not broken. */
class ProvisionYield extends Error {
  constructor(readonly after: ProvisionStep) {
    super(`provision yielded after ${after}`);
    this.name = "ProvisionYield";
  }
}

export class ProvisionFailure extends Error {
  constructor(
    readonly step: ProvisionStep,
    message: string,
  ) {
    super(message);
    this.name = "ProvisionFailure";
  }
}

/**
 * Advice appended when a provision cannot resume and the customer re-submits the same slug.
 *
 * THE WORD "CONTINUE" IS THE DEFECT (cp#304). Re-provisioning a failed, never-live slug is the
 * reclaim path: claim -> teardown(deleteData) -> blank columns -> new job. That DESTROYS the partial
 * environment and starts over; it does not resume. Naming the route and the destroy is what makes
 * the instruction match what the plane does.
 */
export const REPROVISION_DESTROYS =
  "this cannot be continued. POST /api/tenant/provision with the same name again destroys the " +
  "partial environment and starts over from scratch";

/**
 * Run a provision job to completion or to an honest failure.
 *
 * runpodApiKey is key A: transient, used once, never stored. Pass null to resume the CF-side steps
 * only; the run then stops honestly at runpod_endpoints rather than pretending.
 */
/**
 * Carried by a RESUME of the pre-upload region (cp#301 item 3).
 *
 * Its presence is what makes this function a continuation rather than a fresh provision, and it
 * carries the two facts a poll cannot derive: how far the job got, and which release it is building.
 * `release` is REQUIRED rather than defaulted for the reason `runModuleSteps` already gives one
 * field over: deps.release is the PLANE-WIDE pin read at the moment of driving, and a resume that
 * used it could upload a studio from one release onto a schema migrated by another.
 */
export interface ProvisionResume {
  done: readonly MarkableProvisionStep[];
  release: string;
}

export async function runProvisionJob(
  deps: ProvisionDeps,
  jobId: string,
  tenant: Tenant,
  runpodApiKey: string | null,
  clock: ProvisionClock = realClock,
  budgetMs: number = PROVISION_INVOCATION_BUDGET_MS,
  resume?: ProvisionResume,
): Promise<ProvisionOutcome> {
  const startedAt = clock.now();
  // Resuming starts from what the job already recorded; a fresh provision starts from nothing. One
  // list either way, so every `complete()` below reads the same thing on both paths.
  const done: MarkableProvisionStep[] = resume ? [...resume.done] : [];
  const complete = (step: MarkableProvisionStep) => done.includes(step);
  // THE RELEASE THIS INVOCATION IS BUILDING. Never deps.release on a resume: see ProvisionResume.
  const release = resume ? resume.release : deps.release;

  /**
   * Record a completed step, then YIELD if this invocation is out of budget (#112).
   *
   * Yielding between steps rather than inside one is deliberate: a step is the unit the job row can
   * describe, so stopping on a boundary always leaves a state the next driver can resume from. The
   * throw is caught below and turned into an honest "yielded", NOT a failure -- nothing is wrong,
   * we simply ran out of invocation.
   */
  const timeStep = stepTimer(startedAt);
  const mark = async (step: MarkableProvisionStep) => {
    // A RESUME re-runs r2_token on a job that already recorded it, so pushing unconditionally would
    // put a duplicate in the progress list and break the contiguity check the resume preamble runs.
    if (!done.includes(step)) done.push(step);
    await deps.store.updateJobProgress(jobId, step, JSON.stringify(done));
    // ONE clock read, reused for both the timing and the budget check. Reading the clock twice
    // would be the obvious way to write this and it would be wrong: the tests drive a hand-rolled
    // clock that ADVANCES ON EVERY READ, so a second read would change when a yield fires. That is
    // perturbing the instrument the measurement is about (cp#18), not a style preference.
    const at = clock.now();
    deps.log("provision.step", { tenant: tenant.id, job: jobId, phase: "provision", ...timeStep(step, at) });
    // R2_TOKEN IS YIELD-UNSAFE ON A RESUME, for the same reason runpod_endpoints always is. A resume
    // re-mints the bucket credential and the ONLY thing that binds the new secret is wfp_upload, so
    // yielding between them would leave the old grant live, and the next invocation would mint again
    // and orphan another. Carrying r2_token through to wfp_upload keeps the mint and its rebind in
    // one invocation. On a FRESH provision nothing has been bound yet, so the old rule stands.
    const yieldUnsafe = YIELD_UNSAFE_STEPS.has(step) || (resume !== undefined && step === "r2_token");
    if (!yieldUnsafe && at - startedAt >= budgetMs) throw new ProvisionYield(step);
  };

  // The lease is the claim of THIS driver, and it is only true while the driver is alive (cp#148).
  const stopHeartbeat = startLeaseHeartbeat(deps, jobId);
  try {
    await deps.store.setJobRunning(jobId);
    await deps.store.setTenantStatus(tenant.id, "provisioning");

    // 0. The pinned release, fetched BEFORE anything is created (cf#85).
    //
    // It is a PRECONDITION, not a resumable step: read-only, creates nothing, and sits ahead of the
    // point of no return with the other preconditions. Fetching it first means a bad or missing pin
    // (wrong tag, empty mirror slot, a pre-v1.3.1 manifest with no migrations) fails with ZERO
    // tenant resources created, instead of stranding a half-provisioned tenant with a live D1 that
    // someone has to find and clean up by hand.
    //
    // It is also where the tenant D1 SCHEMA now comes from. It used to be imported out of the
    // vivijure-cf source tree at OUR build time, so a tenant could take its schema from the control
    // plane deploy commit and its worker from the pinned release: two studio versions in one tenant.
    // Both now come from this one artifact, so that skew cannot exist.
    //
    // BUDGET: this read is not marked as a step, deliberately. If a slow mirror eats the invocation
    // budget, the very next thing that runs is d1_create followed by its mark(), so the yield lands
    // on a recorded boundary and the continuation story stays clean. There is no window where we
    // burn the budget having marked nothing.
    let built: Awaited<ReturnType<StudioBundleSource["fetch"]>>;
    try {
      built = await deps.bundle.fetch(release);
    } catch (e) {
      // Name the real cause. The message is the source error verbatim (a tag mismatch, a missing
      // manifest, a migration hash failure, a pre-v1.3.1 artifact), so the tenant-facing text says
      // what is actually wrong with the pin instead of blaming the next thing that would have run.
      throw new ProvisionFailure("bundle_fetch", String(e instanceof Error ? e.message : e));
    }

    // Every var the pinned release declares must have a deliberate disposition here. This is the
    // #116 drift guard, relocated: it used to be a compile-time check against an imported studio
    // constant, which is exactly the cross-repo import the extraction removes. Now it runs against
    // the artifact we actually pinned, and it runs BEFORE anything is created, so an unknown var is
    // a clean refusal rather than a tenant quietly missing something its studio reads.
    try {
      assertDispositionCoversContract(built.requiredVars);
    } catch (e) {
      throw new ProvisionFailure("bundle_fetch", String(e instanceof Error ? e.message : e));
    }

    // cp#183: a set-but-malformed storage ceiling refuses the provision HERE, beside the other
    // contract check and before any tenant resource exists. The studio would read a non-integer as
    // NO ceiling, so binding it would produce an uncapped tenant on a plane whose config says it is
    // capped -- the silent-inert class this repo keeps getting burned by, with a bill attached.
    // Unset is not malformed: that is a plane which has chosen no ceiling, and it provisions.
    // Resolved through the ONE seam every writer uses, so a tenant born here enforces exactly what a
    // later converge or studio upgrade would give it. A per-tenant record (cp#173's prepaid class,
    // recorded before the provision) beats the plane default, INCLUDING beating a malformed one:
    // that tenant was never going to use the plane value, so a broken deploy var must not block them.
    const resolvedQuota = resolveStorageQuota(deps.storageQuota, tenant);
    if (resolvedQuota.blocked !== null) {
      throw new ProvisionFailure("bundle_fetch", resolvedQuota.blocked);
    }

    // 1. D1. Adopt-on-exists makes a re-run safe.
    //
    // ON A RESUME the id is read from the row rather than re-created. Not an optimisation: the
    // resume preamble has already proved the progress record and the row AGREE about it, so this is
    // the one place that fact is consumed. Re-creating would also be safe (adopt-on-exists), but it
    // would spend invocation budget re-proving something already recorded.
    let dbUuid: string;
    if (complete("d1_create")) {
      dbUuid = tenant.d1_database_id as string;
    } else {
      const db = await deps.cf.createD1(tenantD1Name(tenant.slug));
      dbUuid = db.uuid;
      await deps.store.setTenantD1(tenant.id, dbUuid);
      await mark("d1_create");
    }

    // 2. Migrations: the SAME migration files the studio ships, applied only where missing and
    //    recorded per-migration in the schema_migrations table of the tenant D1 (#105). This step
    //    MUST tolerate an adopted, already-migrated D1: the previous unconditional replay assumed
    //    the files were all CREATE TABLE IF NOT EXISTS, and died on the first ALTER TABLE.
    if (!complete("d1_migrate")) {
      const migrated = await applyStudioMigrations(deps.cf, dbUuid, built.migrations);
      deps.log("d1.migrate", {
        tenant: tenant.id,
        applied: migrated.applied,
        seeded: migrated.seeded,
      });
      await mark("d1_migrate");
    }

    // 3. Bucket per tenant (not a prefix): satellite-visible R2 creds must reach ONLY this tenant.
    // The NAME is derived from the immutable slug, so it is the same value on a resume without
    // reading the row; only the CREATE is skipped.
    const bucket = tenantBucketName(tenant.slug);
    if (!complete("r2_bucket")) {
      await deps.cf.createR2Bucket(bucket);
      await deps.store.setTenantBucket(tenant.id, bucket);
      await mark("r2_bucket");
    }

    // 4. Bucket-scoped creds. ALWAYS re-minted, on a fresh run and on a resume alike: the value is
    //    never stored, so there is nothing to reuse and nothing a continuation could reconstruct.
    //
    //    MINT -> REBIND -> REVOKE, and the ORDER IS THE SAFETY PROPERTY (cp#301 item 3). The revoke
    //    used to run FIRST, which is correct on a fresh provision because nothing is bound yet. It
    //    is NOT correct on a resume: wfp_upload is not atomic, so a driver that died after the
    //    worker upload but before its step was marked leaves a LIVE tenant Worker holding the old
    //    secret, and the tenant row cannot detect it (script_name is written after the upload, so
    //    NULL is produced identically by "no Worker" and "Worker exists and is bound").
    //
    //    THE TWO FAILURE DIRECTIONS ARE NOT SYMMETRIC, which is the whole reason for the order:
    //      revoke-then-die  -> a live Worker bound to a DEAD credential. Silent, surfaces weeks
    //                          later as a storage bug in another subsystem, and nothing points at
    //                          it. Unrecoverable without already knowing to look.
    //      mint-then-die    -> TWO live grants, one orphaned. Loud, logged, revocable by id, and
    //                          teardownTenant also revokes by NAME, so it is reaped either way.
    //    A cleanup task with an owner beats a studio that provisions green and cannot read its own
    //    bucket. The revoke therefore happens AFTER wfp_upload has rebound the worker, below.
    const previousTokenId = tenant.r2_token_id;
    const token = await deps.tokenMinter.mintBucketToken(tenantR2TokenName(tenant.slug), bucket);
    // Persist the id IMMEDIATELY (cf#91 / #93): if we die between mint and the next await, teardown
    // can still revoke by id. Hashing the secret value is pure CPU and can wait.
    await deps.store.setTenantR2Token(tenant.id, token.id);
    // R2 S3 semantics: access key id = token id, secret = SHA-256 hex of the token value. Derived
    // ONCE here and used for both the satellite templates and the worker secret, so they cannot
    // disagree.
    const s3Secret = await sha256Hex(token.value);
    await mark("r2_token");

    // 5. RunPod. TWO SHAPES SINCE cp#270, and which one a tenant gets is decided HERE by a fact
    //    the caller already carries rather than by a mode flag someone has to remember to set:
    //
    //      key A present -> DEDICATED. The tenant brought their own RunPod account, so they get
    //                       their own endpoints on it and pay RunPod directly. Unchanged.
    //      key A absent + a pool configured -> SHARED. The tenant rides the endpoints that
    //                       already exist and creates ZERO new ones.
    //      key A absent + no pool -> the original honest stop.
    //
    //    That mapping is not a convenience: it IS Conrad's 2026-08-01 ruling expressed in code.
    //    The shared tier never provisions dedicated endpoints; the BYO power-user path keeps them
    //    because the tenant brings the account. Deriving the mode from who brought a key means
    //    there is no third state where the two can disagree.
    let endpoints: TenantEndpoint[];
    // The mode this step DECIDES, carried forward rather than re-read off `tenant` (cp#288). The row
    // is updated by setTenantRunPodMode below; the in-memory object this invocation holds is not, so
    // reading it after the write would report the pre-write default on the very tenants the shared
    // tier is for. Definite-assignment does the enforcing: a branch that forgets to set it will not
    // compile.
    let runpodMode: RunPodMode;
    if (complete("runpod_endpoints")) {
      // RESUME past the endpoints step. Read them back rather than re-resolving: on the dedicated
      // shape re-creating would touch a key this invocation does not have, and on the shared shape
      // the pool could have been reconfigured since, which would silently move a live tenant.
      endpoints = readTenantEndpoints(tenant);
      // RESUME: the endpoints step ran in an EARLIER invocation, so the row is authoritative here in
      // a way it is not on the branches below.
      runpodMode = readRunPodMode(tenant.runpod_mode);
      if (!endpoints.length) {
        throw new ProvisionFailure(
          "runpod_endpoints",
          "the endpoints recorded for this tenant cannot be read, although the provision got past " +
            `the step that writes them; ${REPROVISION_DESTROYS}`,
        );
      }
    } else if (runpodApiKey) {
      endpoints = await deps.runpod.createEndpoints(runpodApiKey, tenant.slug, {
        endpoint: deps.r2Endpoint,
        accessKeyId: token.id,
        secretAccessKey: s3Secret,
        bucket,
      });
      // ORDER IS LOAD-BEARING, and it is the opposite of the obvious one. The MODE is written
      // BEFORE the endpoint list on both branches, so a crash between the two writes leaves a row
      // whose mode is known and whose endpoints are absent. That state is inert: reconcile reads
      // no endpoints and teardown finds none. The reverse order would leave a row carrying POOL
      // endpoint ids under the default mode 'dedicated', which is the one combination that makes
      // reconciliation attribute production endpoints to a tenant and call them its debris.
      runpodMode = "dedicated";
      await deps.store.setTenantRunPodMode(tenant.id, "dedicated");
      await deps.store.setTenantEndpoints(tenant.id, JSON.stringify(endpoints));
    } else if (deps.sharedPool) {
      // NOTHING IS CREATED HERE. No quota is consumed, no template is written, no key A exists,
      // and the step is a pure resolution of config into the same shape the dedicated branch
      // returns. Both downstream consumers (the studio endpointVar bindings and
      // uploadTenantModules) read only `id` and `endpointVar`, so neither can tell the
      // difference -- which is why this is a branch here and not a second provisioning path.
      endpoints = deps.sharedPool.endpoints;
      runpodMode = "shared";
      await deps.store.setTenantRunPodMode(tenant.id, "shared");
      await deps.store.setTenantEndpoints(tenant.id, JSON.stringify(endpoints));
      deps.log("provision.shared_pool", {
        tenant: tenant.id,
        endpoints: endpoints.map((e) => e.id),
        created: 0,
      });
    } else {
      return { ok: false, step: "runpod_endpoints", message: "runpod_key_required" };
    }
    await mark("runpod_endpoints");

    // 6. Upload the PUBLISHED studio release, unmodified. No hosted fork exists to drift.
    //    Already fetched at step 0; reused here rather than re-read, so the worker we upload and the
    //    schema we applied are provably the same artifact and not two reads that could differ.
    let assetsJwt: string | undefined;
    if (built.assets?.length) assetsJwt = await uploadStudioAssets(deps, tenant.slug, built.assets);

    // The tenant's studio API token. Minted here, set as the tenant-studio secret (satisfying its
    // AUTH_MODE=token fail-closed gate), and ALSO persisted control-plane-side (encrypted) because
    // the dispatcher injects it for the owner's browser (auth ruling 2026-07-18). It is the one
    // credential stored as a VALUE; token-crypto encrypts it under STUDIO_TOKEN_KEK before D1.
    const studioApiToken = randomToken();

    // cf#98: mint a STUDIO-scoped AI Gateway Run token BEFORE the studio upload so planner/chat can
    // bind GATEWAY_ID + CF_AIG_TOKEN (both-or-neither). Distinct name from the module grant minted
    // below -- one surface's compromise must not expose the other's credential.
    let studioAigTokenValue: string | null = null;
    if (deps.aiGatewayId) {
      try {
        await deps.tokenMinter.revokeByName(tenantStudioAigTokenName(tenant.slug));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "revoke failed";
        deps.log("aig_token.studio_revoke_failed", { tenant: tenant.id, error: msg });
      }
      studioAigTokenValue = (await deps.tokenMinter.mintAigToken(tenantStudioAigTokenName(tenant.slug))).value;
    }

    // Each created endpoint carries the studio env var its id belongs in (spec.endpointVar); the
    // studio cannot dispatch a render without these. The mapping is DATA from the provision plan, so
    // adding a service is a plan entry, not an edit here.
    const endpointBindings = endpoints.map((e) => ({ type: "plain_text" as const, name: e.endpointVar, text: e.id }));

    await uploadStudioScript(deps, {
      namespace: deps.namespace,
      scriptName: deps.tenantScriptName(tenant.slug),
      mainModule: built.mainModule,
      moduleText: built.moduleText,
      compatibilityDate: built.compatibilityDate,
      compatibilityFlags: built.compatibilityFlags,
      assetsJwt,
      // The release's own asset handling, verbatim. Without this a tenant got CF defaults while a
      // self-hoster running the SAME release got html_handling="none" -- a blank page at the
      // tenant's studio root, hosted-only, on identical code (#77/#78).
      assetsConfig: built.assetsConfig,
      bindings: [
        // env.ASSETS must be DECLARED for the studio to serve its static UI; without it env.ASSETS
        // is undefined and asset serving throws 1101 on every static path (hosted-only, #40 burn).
        { type: "assets", name: "ASSETS" },
        // MODULE_DISPATCH -> the shared tenant-modules namespace: the studio reaches its own
        // module workers via env.MODULE_DISPATCH.get(script) (cf#99). This is UPLOAD METADATA, not
        // studio code, so the studio bytes stay byte-identical to self-host (parity). A WfP user
        // worker carrying a dispatch_namespace binding was live-proven in the cf#99 step-1 probe.
        { type: "dispatch_namespace", name: "MODULE_DISPATCH", namespace: deps.moduleNamespace },
        { type: "d1", name: "DB", id: dbUuid },
        { type: "r2_bucket", name: "R2_RENDERS", bucket_name: bucket },
        { type: "r2_bucket", name: "R2", bucket_name: bucket },
        { type: "plain_text", name: "AUTH_MODE", text: "token" },
        { type: "plain_text", name: "R2_S3_BUCKET", text: bucket },
        // #116: r2-presign.ts requires ALL FOUR of R2_S3_{ACCESS_KEY_ID,SECRET_ACCESS_KEY,ENDPOINT,
        // BUCKET} and THROWS without them. This one was missing, so a tenant provisioned 9/9 green
        // and then died on its first render: the keyframe rendered and landed in R2, and the
        // keyframe->clips handoff threw inside presign on every poll thereafter. An identifier, not
        // a credential (plain_text): the SAME endpoint already handed to the RunPod templates below.
        // Self-host derives it from CLOUDFLARE_ACCOUNT_ID at deploy, so omitting it here was a
        // parity break as well as a defect.
        { type: "plain_text", name: "R2_S3_ENDPOINT", text: deps.r2Endpoint },
        // The 4 RunPod endpoint ids the studio renders against.
        ...endpointBindings,
        // The credential goes straight from the mint into a worker secret. It is never persisted
        // on our side and never returned to any caller.
        { type: "secret_text", name: "R2_S3_ACCESS_KEY_ID", text: token.id },
        { type: "secret_text", name: "R2_S3_SECRET_ACCESS_KEY", text: s3Secret },
        // AUTH_MODE=token requires this; the dispatcher injects it for the owner and the studio
        // fail-closed-denies everyone else.
        { type: "secret_text", name: "STUDIO_API_TOKEN", text: studioApiToken },
        // The studio fail-CLOSES renders when SPEND_RATE_LIMITER is unbound; bind it so the tenant
        // can render, matching self-host's posture exactly (30 req / 60s, fail-closed default).
        {
          type: "ratelimit",
          name: "SPEND_RATE_LIMITER",
          namespace_id: SPEND_RATELIMIT_NAMESPACE,
          simple: { limit: 30, period: 60 },
        },
        // Per-tenant daily spend ceiling (the primary cost cap, DB-enforced fail-closed). Always set
        // -- a hosted tenant without a ceiling has no cost bound. Operator-tunable via env.
        ...(deps.spendDailyCeiling
          ? [{ type: "plain_text" as const, name: "SPEND_DAILY_CEILING", text: deps.spendDailyCeiling }]
          : []),
        // cp#183: the per-tenant R2 storage ceiling, the OTHER cost bound. SPEND_DAILY_CEILING caps
        // what a tenant can spend in a day; this caps what they can accumulate forever, which is the
        // bill that keeps arriving after they stop rendering (and, for a tenant who leaves, the one
        // we inherit). Absent when this plane configures no ceiling: core reads an absent knob as
        // off, so there is no value meaning "unlimited" to bind, and "0" would deny every submit.
        ...storageQuotaBindings(resolvedQuota.bytes, deps.storageQuota.mode),
        // cf#118: the video-finish tier. Present only when this plane is configured for it; absent
        // means the tenant degrades to per-shot clips WITH THE REASON STATED, which is exactly what
        // tenants get today and what self-host gets without the container.
        //
        // The tier is SHARED, selected by the `tier=finishing` swarm label rather than a fixed
        // node list (measured 2026-08-01: descendents, badbrains, jello), and that is safe by
        // CONSTRUCTION, not by policy: the container never receives a credential. The studio
        // presigns per-object R2 GET/PUT URLs with its OWN bucket-scoped credential and passes
        // URLs, so a shared worker cannot enumerate a tenant's bucket, cannot outlive the URL,
        // and holds nothing to leak.
        //
        // THE NODE LIST IS AN OBSERVATION, NEVER A DEFINITION, and naming nodes is what made this
        // comment stale in the first place. jello was wiped, rebuilt and re-labelled on
        // 2026-07-31, and the tier absorbed it with no per-tenant change anywhere, because
        // placement is label-driven and the workers hold no credential to re-issue. That is the
        // cp#270 shared-tier thesis already running in production, which is why this comment is
        // the precedent the pooled RunPod design is built on.
        ...(deps.videoFinishServiceId
          ? [{ type: "vpc_service" as const, name: "VIDEO_FINISH_VPC", service_id: deps.videoFinishServiceId }]
          : []),
        // cp#136: the finish-tier STATE, projected from the tenant record rather than decided here.
        // Normally empty -- a tenant being provisioned now is reachable by definition -- but a
        // re-provision or a resumed provision of a DECLARED-unreachable tenant must re-state the var,
        // because a plain_text binding omitted from an upload is DROPPED and the panel would quietly
        // go back to promising "not yet provisioned" to a studio nobody can reach.
        ...videoFinishTierStateBindings(tenant),
        // cp#164: where a reporter is sent for abuse of THIS studio. The tenant studio is the
        // surface where hosted content is actually seen, and enforcement here is report-driven by
        // ruling, so the intake path is part of the product rather than a legal footnote. HOSTED
        // ONLY, structurally: the value is computed from control-plane config and the studio bytes
        // uploaded above are the published release unmodified, so nothing here can reach the bundle
        // a self-hoster installs -- their unset var renders nothing, which is correct because we
        // cannot act on their content. Absent when the plane cannot name its own page.
        ...abuseReportUrlBindings(deps.abuseReportUrl),
        // cf#98: planner / chat / enhance on the STUDIO (not only plan-enhance modules) need env.AI
        // and a resolvable GATEWAY_ID. AI is bound unconditionally so a plane with no gateway still
        // has a working Workers AI local path; GATEWAY_ID + CF_AIG_TOKEN are both-or-neither when
        // TENANT_AI_GATEWAY_ID is configured (same rule as modules). CF_AIG_TOKEN is secret_text only.
        { type: "ai", name: "AI" },
        ...(deps.aiGatewayId && studioAigTokenValue
          ? [
              { type: "plain_text" as const, name: "GATEWAY_ID", text: deps.aiGatewayId },
              // secret_text only -- never plain_text (credential must not appear in script metadata).
              { type: "secret_text" as const, name: "CF_AIG_TOKEN", text: studioAigTokenValue },
            ]
          : []),
      ],
    });
    await deps.store.setTenantScript(tenant.id, deps.tenantScriptName(tenant.slug), release);
    // Persist the token VALUE, encrypted, so the dispatcher can inject it. Never plaintext at rest.
    await deps.store.setTenantStudioToken(tenant.id, await encryptStudioToken(deps.kek, studioApiToken));
    await mark("wfp_upload");

    // THE REVOKE, DEFERRED TO HERE (cp#301 item 3). See the ordering rationale at the mint above.
    //
    // The worker is now bound to the NEW secret, so the old grant is provably unreferenced and can
    // go. Running it before the upload was safe on a fresh provision and unsafe on a resume, and the
    // two paths share this code, so the order that is correct for both is the one that waits.
    //
    // GUARDED ON INEQUALITY as well as presence: the mint is by NAME and adopt-by-name is a shape
    // this repo uses elsewhere, so a minter that returned the SAME id would otherwise have us revoke
    // the credential we just bound -- the exact dead-binding outcome the ordering exists to prevent,
    // reached from the other side.
    //
    // Failure here is LOGGED, not fatal, unchanged from the original placement: a stale grant we
    // could not clean up is a real problem and it must be visible, but stranding a provisioned
    // tenant over it would be worse.
    if (previousTokenId && previousTokenId !== token.id) {
      try {
        await deps.tokenMinter.revoke(previousTokenId);
      } catch (e) {
        deps.log("r2_token.revoke_failed", { tenant: tenant.id, error: String(e) });
      }
    }

    // 7. Upload the tenant MODULE scripts (cf#99) into the shared modules namespace, each carrying
    //    its endpoint id. Key B is NOT bound yet -- it lands in installInvokeKey, alongside the
    //    studio. The studio (with its MODULE_DISPATCH binding) is already up, so the install pass
    //    below can reach these. Idempotent-by-name (adopt-on-exists), like every other step.
    // cf#56: module AI Gateway Run token (separate grant from the studio token minted above).
    let aigTokenValue: string | null = null;
    if (deps.aiGatewayId) {
      try {
        await deps.tokenMinter.revokeByName(tenantAigTokenName(tenant.slug));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "revoke failed";
        deps.log("aig_token.revoke_failed", { tenant: tenant.id, error: msg });
      }
      aigTokenValue = (await deps.tokenMinter.mintAigToken(tenantAigTokenName(tenant.slug))).value;
    }
    await uploadTenantModules(
      deps, release, tenant.id, tenant.slug, endpoints, dbUuid, bucket, runpodMode, undefined, aigTokenValue,
    );
    await mark("modules_upload");

    // 8. Install each module through the studio's OWN conformance-gated route (cf#99): the studio
    //    runs the live suite against the resident script via its now-bound MODULE_DISPATCH and
    //    seeds installed_modules in the tenant D1. No install logic is duplicated here.
    await installTenantModules(deps, tenant.id, deps.tenantScriptName(tenant.slug), studioApiToken);
    await mark("modules_install");
    // RECORD THE MODULE RELEASE. Provision used to leave `tenants.modules_release` NULL forever:
    // setTenantModulesRelease was called only by the UPGRADE path, so a tenant that had never been
    // upgraded asserted no module release at all, while its resident module scripts were plainly at
    // deps.release. Two consequences, and the second is the one that matters:
    //   - the tenant census cannot say what modules a freshly provisioned tenant runs;
    //   - smoke-render.ts opens every smoke with `tenant.modules_release` and states the invariant
    //     "the pixels came from the module bytes recorded in modules_release", so on a fresh tenant
    //     that provenance was NULL -- a smoke that cannot name the bytes that produced its pixels.
    // WHY HERE and not inside runModuleSteps, which both callers share: the upgrade owns its own
    // NULL-then-set window on this column (it must assert non-uniformity while it re-uploads), and
    // moving the write inside would make that deliberate sequence read as dead code. AFTER
    // modules_install, not after modules_upload, so a provision that dies between the two does not
    // claim a release for modules that were never installed.
    await deps.store.setTenantModulesRelease(tenant.id, release);

    // 7. Verify what we actually built, from the API's own view, rather than trusting our writes.
    //    Names only; these endpoints never return values.
    const script = deps.tenantScriptName(tenant.slug);
    const bindings = await deps.cf.getScriptBindings(deps.namespace, script);
    const names = new Set(bindings.map((b) => b.name));
    // #116: census covers the platform-env contract, not just remembered bindings (see above).
    const requiredBindings = [
      "DB",
      "R2_RENDERS",
      "ASSETS",
      "SPEND_RATE_LIMITER",
      ...REQUIRED_TENANT_STUDIO_VARS,
      ...endpoints.map((e) => e.endpointVar),
    ];
    for (const required of requiredBindings) {
      if (!names.has(required)) {
        throw new ProvisionFailure("verify", `tenant worker is missing the ${required} binding after upload`);
      }
    }
    const secrets = await deps.cf.getScriptSecretNames(deps.namespace, script);
    for (const required of ["R2_S3_SECRET_ACCESS_KEY", "STUDIO_API_TOKEN"]) {
      if (!secrets.includes(required)) {
        throw new ProvisionFailure("verify", `tenant worker is missing the ${required} secret after upload`);
      }
    }
    // SERVING, not just storage: a binding census green-lit the first live provision, which then
    // 1101'd at the studio root because env.ASSETS was undefined. Dispatch a real request to the
    // worker root and require it does not 5xx.
    const probe = await deps.callTenantStudio(script, { method: "GET", path: "/", studioApiToken });
    if (probe.status >= 500) {
      throw new ProvisionFailure("verify", `tenant studio root returned ${probe.status}; the worker is not serving`);
    }
    // Module half (cf#99): the studio must report a NON-EMPTY installed set, or discovery is dark
    // and a render 503s honestly. The moving-pixels gate (render past discovery) needs key B and
    // is the out-of-band release gate; this proves the bridge exists.
    const installedModules = await verifyTenantModulesInstalled(deps, script, studioApiToken);
    deps.log("provision.modules_installed", { tenant: tenant.id, modules: installedModules });
    await mark("verify");

    // The studio is built but cannot render until key B lands: RunPod will not let us mint that key
    // and it cannot be scoped to endpoints that did not exist a moment ago.
    await deps.store.setTenantStatus(tenant.id, "awaiting_invoke_key");
    await deps.store.finishJob(jobId, "succeeded", null, null);
    return { ok: true, status: "awaiting_invoke_key" };
  } catch (e) {
    // Out of invocation budget, not broken: leave the job RUNNING with its progress persisted so the
    // next poll picks it up. Writing a failure here would turn "not finished yet" into "failed".
    if (e instanceof ProvisionYield) {
      // cp#158: hand the lease back NOW rather than leaving it to expire. A yield means this driver
      // is done writing, so the up-to-60s remainder of its lease is pure dead time before the next
      // poll can drive. Order is load-bearing: stop the heartbeat FIRST, or a beat still queued
      // behind this await re-arms the lease we just cleared and reinstates the whole delay.
      stopHeartbeat();
      const released = await deps.store.releaseJobLease(jobId);
      deps.log("provision.yielded", {
        tenant: tenant.id,
        after: e.after,
        elapsedMs: clock.now() - startedAt,
        leaseReleased: released,
      });
      return { ok: false, yielded: true, after: e.after };
    }
    const step =
      e instanceof ProvisionFailure ? e.step : e instanceof TenantModuleError ? e.step : inferStep(done);
    // The REAL error, verbatim. If RunPod says the worker quota is 10 and we need 12, that exact
    // sentence is what the tenant reads.
    const message =
      e instanceof CfApiError || e instanceof ProvisionFailure || e instanceof TenantModuleError ? e.message : String(e);
    deps.log("provision.failed", { tenant: tenant.id, step, message });
    await deps.store.finishJob(jobId, "failed", step, message);
    await deps.store.setTenantStatus(tenant.id, "failed");
    // Auto-teardown (cf#91): a failed provision must not leave live R2 tokens / buckets / D1
    // standing. Re-fetch the row so we see ids persisted mid-run (the start-of-job `tenant`
    // snapshot is stale after setTenantR2Token). Best-effort: teardown failures are logged; the
    // job stays failed either way so reclaim can retry.
    await rollbackFailedProvision(deps, tenant.id);
    return { ok: false, step, message };
  } finally {
    // Stop beating on EVERY exit: success, failure and yield alike. The yield path already stopped
    // it (it has to, before releasing the lease -- cp#158), and calling the stopper twice is a
    // no-op, which is cheaper than tracking whether it ran and getting THAT wrong.
    stopHeartbeat();
  }
}

/**
 * The endpoint list as the provisioner stored it (#112 continuation).
 *
 * The writer persists the CreatedEndpoint[] verbatim, so this reads objects, not ids. It is
 * deliberately strict: a row that cannot produce a well-formed endpoint carrying its endpointVar is
 * treated as no endpoints at all, because a continuation that guessed a var name would wire a studio
 * to nothing and call it success. The same shape assumption bit us once already (#92, where a
 * string-only reader made every live key install 409).
 */
export function readTenantEndpoints(tenant: Tenant): TenantEndpoint[] {
  if (!tenant.endpoints_json) return [];
  try {
    const parsed: unknown = JSON.parse(tenant.endpoints_json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is TenantEndpoint =>
        !!e &&
        typeof e === "object" &&
        typeof (e as TenantEndpoint).id === "string" &&
        typeof (e as TenantEndpoint).key === "string" &&
        typeof (e as TenantEndpoint).endpointVar === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Drive a job that a previous invocation left unfinished (#112).
 *
 * WHY THIS IS A SEPARATE ENTRY POINT AND NOT "call runProvisionJob again":
 * key A is transient by design. It lives in the request that carried it and nowhere else, so a
 * continuation driven by a POLL does not have it and never can. That is not a limitation to work
 * around, it is the custody rule, and it decides exactly how much of the job is resumable:
 *
 *   steps 1-6 (d1 .. wfp_upload)  need key A and/or the minted R2 secret  -> NOT resumable
 *   steps 7-9 (modules_upload ..) need only persisted state               -> resumable
 *
 * Everything step 7 onward needs is already on the tenant row: the endpoint list (endpoints_json)
 * and the studio API token (studio_token_enc, decrypted with the same KEK the dispatcher uses). So
 * a continuation can finish a provision that got as far as the studio upload, and must honestly
 * refuse one that did not.
 *
 * That refusal matters: a job interrupted before the endpoints exist cannot be completed by anyone
 * except the tenant re-submitting with their key, and saying so is better than a job that waits
 * forever for a driver that can never succeed.
 */
export async function continueProvisionJob(
  deps: ProvisionDeps,
  jobId: string,
  tenant: Tenant,
  stepsDone: readonly string[],
  clock: ProvisionClock = realClock,
  budgetMs: number = PROVISION_INVOCATION_BUDGET_MS,
): Promise<ProvisionOutcome> {
  const startedAt = clock.now();
  // Typed MARKABLE rather than ProvisionStep: the source is PROVISION_STEPS itself, so every
  // element is a step a job can record, and a resume hands this list straight to runProvisionJob.
  const done: MarkableProvisionStep[] = PROVISION_STEPS.filter((s) => stepsDone.includes(s));
  const timeStep = stepTimer(startedAt);
  const mark = async (step: MarkableProvisionStep) => {
    done.push(step);
    await deps.store.updateJobProgress(jobId, step, JSON.stringify(done));
    // ONE clock read, reused for both the timing and the budget check. Reading the clock twice
    // would be the obvious way to write this and it would be wrong: the tests drive a hand-rolled
    // clock that ADVANCES ON EVERY READ, so a second read would change when a yield fires. That is
    // perturbing the instrument the measurement is about (cp#18), not a style preference.
    const at = clock.now();
    deps.log("provision.step", { tenant: tenant.id, job: jobId, phase: "resume", ...timeStep(step, at) });
    if (!YIELD_UNSAFE_STEPS.has(step) && at - startedAt >= budgetMs) throw new ProvisionYield(step);
  };
  const complete = (step: MarkableProvisionStep) => done.includes(step);

  const stopHeartbeat = startLeaseHeartbeat(deps, jobId);
  try {
    // ---- INTEGRITY, BEFORE ANY DECISION (cp#301) ------------------------------------------------
    //
    // Every guard below reasons about `done`, so `done` has to be a shape they can reason about.
    // Both of these were previously guaranteed as a SIDE EFFECT of the boundary refusing everything
    // short of wfp_upload; neither was ever stated, and neither would survive that refusal moving.
    //
    // PROGRESS MUST BE A PREFIX. `done` is built by FILTERING (a set test), not by slicing, and
    // inferStep maps done.length to a step BY INDEX -- so a record with a hole produces a plausible
    // WRONG step name rather than an error, and every `complete(x)` below silently means "x is in
    // the set" rather than "the job got that far". A hole is not reachable by any code path here
    // (mark() only ever appends), which is exactly why it is worth asserting: the states that
    // cannot happen are the ones nothing else is watching.
    //
    // NOT REFUSED, deliberately: an UNRECOGNISED step name in stepsDone. PROVISION_STEPS.filter
    // drops it silently, and that is the correct behaviour during a deploy that adds a step, where
    // a row written by the newer code is read by the older. Refusing would strand those rows.
    const contiguous = PROVISION_STEPS.slice(0, done.length);
    if (done.length !== contiguous.length || done.some((step, i) => step !== contiguous[i])) {
      throw new ProvisionFailure(
        inferStep(done),
        `job progress is not contiguous (${JSON.stringify(done)}), so no step order can be inferred ` +
          "from it; this row cannot be resumed",
      );
    }
    // GUARD 5, PROMOTED then SPLIT. This was never written as a guard: it was a `telemetryD1Id`
    // field handed to runModuleSteps, whose refusal lives one module away in uploadTenantModules.
    //
    // SPLIT INTO TWO NAMED REFUSALS (cp#301 item 3) because the two directions of the disagreement
    // are not the same kind of state, and item 3 relaxes exactly one of them. One combined check
    // with one message would mean relaxing half a condition, which is the shape that takes the other
    // half with it by accident.
    //
    // NOT PRODUCIBLE: progress claims the step and the row has no id. runProvisionJob calls
    // setTenantD1 IMMEDIATELY BEFORE mark("d1_create"), so no code path marks that step without the
    // id. This is corruption, and it refuses permanently on both shapes.
    if (complete("d1_create") && tenant.d1_database_id === null) {
      throw new ProvisionFailure(
        "d1_create",
        "the job progress record says the database was created but the tenant row has no database " +
          "id, so this row is inconsistent and cannot be resumed",
      );
    }
    // PRODUCIBLE, and therefore RECOVERABLE rather than refused: the row has an id and progress does
    // not claim the step, which is exactly what a driver that died between setTenantD1 and mark
    // leaves behind. createD1 is adopt-on-exists, so re-running that step is safe and lands on the
    // same database. Refusing here would strand a tenant that is fine.
    //
    // It is NOT silently ignored: the mismatch is logged, because a row and its progress disagreeing
    // is worth seeing even when it is benign, and this is the only place that can see it.
    if (!complete("d1_create") && tenant.d1_database_id !== null) {
      deps.log("provision.resume_adopts_database", {
        tenant: tenant.id,
        job: jobId,
        database: tenant.d1_database_id,
        reason: "the row carries a database id that the progress record does not claim; d1_create " +
          "will re-run and adopt it",
      });
    }

    // ---- THE MODE, FROM THE JOB ROW (cp#301, migration 0022) -------------------------------------
    //
    // Read HERE rather than taken from the caller: this function is the one that decides on it, and
    // a caller-supplied mode is a second place for it to be wrong. tenants.runpod_mode cannot answer
    // for the pre-upload region at all -- it is written inside the runpod_endpoints step and is
    // NOT NULL DEFAULT 'dedicated', so before that step every row reads 'dedicated' whether or not
    // it is one.
    const job = await deps.store.getJob(jobId);
    if (!job) {
      throw new ProvisionFailure(inferStep(done), `job ${jobId} no longer exists; this row cannot be resumed`);
    }
    // NOT readRunPodMode(). That helper narrows anything unrecognised to 'dedicated', which is the
    // safe direction for teardown and reconcile (do less) and the WRONG one here: it would turn the
    // NULL that means "this job predates the recording" into a confident 'dedicated' and erase the
    // distinction migration 0022 exists to preserve.
    const recordedMode = job.runpod_mode;

    // ---- THE PRE-UPLOAD REGION: FOUR NAMED REFUSALS, NO FALL-THROUGH -----------------------------
    //
    // Every branch below REFUSES. That is not a placeholder: admitting any of these states requires
    // re-minting the bucket credential and re-running wfp_upload in full, which is a separate change
    // (cp#301 item 3). Admitting them here would reach wfp_upload with no way to reconstruct
    // s3Secret and upload a tenant studio bound to an empty or stale R2 secret -- a studio that
    // provisions GREEN and cannot read or write its own bucket, which is the exact outcome this
    // whole issue exists to prevent.
    //
    // WHAT CHANGES HERE IS THE REASON, NOT THE ANSWER. Every one of these states is refused today
    // too, by a single message that names key A regardless of whether this tenant ever had one.
    // Each refusal now states its own cause, and each is an EXPLICIT test rather than the end of a
    // chain: a refusal reached by falling off the bottom of a condition is one a later edit removes
    // by accident.
    if (!complete("wfp_upload")) {
      if (recordedMode === null) {
        throw new ProvisionFailure(
          inferStep(done),
          "this provision was started before the plane recorded which RunPod shape it was for, so " +
            `there is no way to tell whether it can be finished without the original key; ${REPROVISION_DESTROYS}`,
        );
      }
      if (recordedMode === "dedicated") {
        // Key A is unrecoverable for a tenant that brought its own RunPod account; the refusal is
        // permanent by custody. The DESTROY clause (cp#304) is the load-bearing half of the advice:
        // re-provisioning the same name is reclaim, not resume.
        throw new ProvisionFailure(
          inferStep(done),
          "provisioning was interrupted before the studio was uploaded, and the RunPod key needed to " +
            `finish it is never stored; ${REPROVISION_DESTROYS}`,
        );
      }
      if (recordedMode === "shared") {
        // THE SUPPORTED PATH (cp#301 item 3). A pooled tenant needs no key A, so everything this
        // region does is reachable from persisted state plus a credential we can re-mint.
        //
        // DELEGATES rather than reimplementing. The steps live in exactly one function, the way the
        // module half already does (runModuleSteps, cf#103): a second copy of the provisioning
        // sequence is a copy that drifts, and this one would drift on the path nobody exercises
        // until something has already gone wrong.
        //
        // THE RELEASE COMES FROM THE JOB ROW, never deps.release. tenants.studio_release is NULL
        // across this entire region (it is written inside wfp_upload), which is why item 1 recorded
        // the pin on the job at creation. A missing pin REFUSES: a fallback would turn "I cannot
        // tell which release this job is building" into a confident wrong answer, and the schema is
        // already migrated by then.
        if (!job.to_release) {
          throw new ProvisionFailure(
            inferStep(done),
            "this provision did not record which release it was building, so resuming it could " +
              "upload a studio that does not match the database schema already created for it; " +
              REPROVISION_DESTROYS,
          );
        }
        // The heartbeat is handed over with the job: runProvisionJob starts its own, and two
        // beating on one lease is two writers on one claim.
        stopHeartbeat();
        deps.log("provision.resume_pooled", {
          tenant: tenant.id,
          job: jobId,
          from: inferStep(done),
          release: job.to_release,
        });
        // No key, by construction: this branch exists BECAUSE the tenant brought none. Passing null
        // is what selects the shared shape inside the endpoints step, the same way the original
        // provision selected it.
        return await runProvisionJob(deps, jobId, tenant, null, clock, budgetMs, {
          done,
          release: job.to_release,
        });
      }
      // An unrecognised value is its own case, NOT a fall-through into the shared branch. The column
      // is written by one call site with a typed value, so reaching this means something else wrote
      // it, and guessing which shape it meant is how a BYO tenant ends up on the shared pool.
      throw new ProvisionFailure(
        inferStep(done),
        `this provision records an unrecognised RunPod shape (${JSON.stringify(recordedMode)}), so ` +
          `it cannot be resumed; ${REPROVISION_DESTROYS}`,
      );
    }

    // ---- PAST THE BOUNDARY: EACH GUARD NAMES WHAT IT CONSUMES ------------------------------------
    //
    // Reaching here means wfp_upload completed AND progress is contiguous, so runpod_endpoints and
    // everything before it completed too. That makes each absence below a WRITE THAT DID NOT LAND or
    // a value that no longer parses -- data corruption -- rather than a phase that has not happened.
    // Re-provision DESTROYS (cp#304); do not promise a resume.
    const endpoints = readTenantEndpoints(tenant);
    if (!endpoints.length) {
      throw new ProvisionFailure(
        "runpod_endpoints",
        "the endpoints recorded for this tenant cannot be read, although the provision got past the " +
          `step that writes them; ${REPROVISION_DESTROYS}`,
      );
    }
    if (!tenant.studio_token_enc) {
      throw new ProvisionFailure(
        "wfp_upload",
        "no studio token is recorded for this tenant, although the provision got past the step that " +
          `writes it, so its studio cannot be reached; ${REPROVISION_DESTROYS}`,
      );
    }
    const studioApiToken = await decryptStudioToken(deps.kek, tenant.studio_token_enc);
    const script = deps.tenantScriptName(tenant.slug);

    // THE RELEASE THIS TENANT IS ACTUALLY ON, not the plane's current pin (cp#301).
    //
    // WHAT WAS WRONG: this function passed `deps.release` to runModuleSteps and wrote it to
    // modules_release. `deps.release` is the PLANE-WIDE STUDIO_RELEASE, read fresh on every
    // invocation, while the studio worker was uploaded from whatever the pin was at `wfp_upload`
    // time and recorded in tenants.studio_release. A resume that runs after the operator advances
    // the pin therefore gave the tenant a studio from release A and MODULES FROM RELEASE B.
    //
    // That is precisely the pairing module-bundle-r2.ts says cannot happen: "Modules ship WITH the
    // studio release they were built and conformance-proven against (one tag, one artifact), so a
    // tenant's studio and its modules can never be a mismatched pair." The resume path could
    // produce exactly that pair, and the window is real -- STUDIO_RELEASE moved v1.13.0 -> v1.19.3
    // in a single day on 2026-08-03.
    //
    // Same lesson the MODULE UPGRADE route already learned (see `release` being a required argument
    // rather than deps.release, below): a release is a property of the WORK, not of the moment the
    // work happens to be driven.
    //
    // REFUSES rather than falling back. A fallback to deps.release is exactly the wrong shape here:
    // it would turn "I cannot tell which release this tenant is on" into a confident wrong answer,
    // which is the mismatch this block exists to prevent.
    //
    // WHAT IT NEEDS, stated rather than positional (cp#301 item 2): the release THE STUDIO ON THIS
    // TENANT WAS UPLOADED FROM, because the modules it is about to install must pair with those
    // exact bytes. Past the boundary that fact is tenants.studio_release, written by setTenantScript
    // alongside script_name inside wfp_upload. So this is unreachable for two independent reasons
    // now -- the pre-upload region refuses above, and the contiguity check proves the step that
    // writes it ran -- which makes it a structural assertion rather than an expected path.
    //
    // THE PRE-UPLOAD REGION WILL NEED A DIFFERENT SOURCE, and it now exists: provision_jobs
    // .to_release, recorded at job creation (migration 0022). When item 3 admits that region, the
    // release comes from the JOB row there and from the TENANT row here. Two regions, two sources,
    // neither falling back to deps.release.
    const pinnedRelease = tenant.studio_release;
    if (!pinnedRelease) {
      throw new ProvisionFailure(
        "wfp_upload",
        "no studio release recorded for this tenant, so the modules that pair with its studio " +
          `cannot be identified; ${REPROVISION_DESTROYS}`,
      );
    }

    await runModuleSteps(
      deps,
      {
        tenantId: tenant.id,
        slug: tenant.slug,
        script,
        endpoints,
        studioApiToken,
        release: pinnedRelease,
        // Restated from the ROW for the same reason TELEMETRY_DB is: an upload REPLACES the
        // binding set, so a bucket not passed here is R2_RENDERS silently stripped off a
        // tenant that had it -- which does not break the module, it redirects its writes to
        // the operator bucket (cp#284).
        tenantBucketName: tenant.r2_bucket_name,
        telemetryD1Id: tenant.d1_database_id,
        // From the ROW: the endpoints step completed in an earlier invocation, so it is written.
        runpodMode: readRunPodMode(tenant.runpod_mode),
      },
      // Resume semantics: skip what the progress record says is already done. The UPGRADE caller
      // passes the opposite (always run), which is the entire behavioural difference between the
      // two and the reason this is a parameter rather than a hardcoded rule.
      { shouldRun: (step) => !complete(step), onDone: mark },
    );

    // Same write as the non-resumed path, and it has to be restated here rather than left to the
    // caller: a provision that yielded and resumed reaches completion through THIS function and
    // never runs the tail of runProvisionJob. Missing it here would mean the column is populated
    // only for tenants whose provision happened to fit in one invocation, which is exactly the kind
    // of state that looks correct until the slow case shows up.
    // The release we ACTUALLY uploaded from, so the column is a record rather than a guess. Writing
    // deps.release here would restate the current pin regardless of what these modules were built
    // from, which is the same defect one field over.
    await deps.store.setTenantModulesRelease(tenant.id, pinnedRelease);
    await deps.store.setTenantStatus(tenant.id, "awaiting_invoke_key");
    await deps.store.finishJob(jobId, "succeeded", null, null);
    deps.log("provision.resumed_to_completion", { tenant: tenant.id });
    return { ok: true, status: "awaiting_invoke_key" };
  } catch (e) {
    if (e instanceof ProvisionYield) {
      // cp#158: hand the lease back NOW rather than leaving it to expire. A yield means this driver
      // is done writing, so the up-to-60s remainder of its lease is pure dead time before the next
      // poll can drive. Order is load-bearing: stop the heartbeat FIRST, or a beat still queued
      // behind this await re-arms the lease we just cleared and reinstates the whole delay.
      stopHeartbeat();
      const released = await deps.store.releaseJobLease(jobId);
      deps.log("provision.yielded", {
        tenant: tenant.id,
        after: e.after,
        elapsedMs: clock.now() - startedAt,
        resumed: true,
        leaseReleased: released,
      });
      return { ok: false, yielded: true, after: e.after };
    }
    const step = e instanceof ProvisionFailure ? e.step : e instanceof TenantModuleError ? e.step : inferStep(done);
    const message =
      e instanceof CfApiError || e instanceof ProvisionFailure || e instanceof TenantModuleError ? e.message : String(e);
    deps.log("provision.failed", { tenant: tenant.id, step, message, resumed: true });
    await deps.store.finishJob(jobId, "failed", step, message);
    await deps.store.setTenantStatus(tenant.id, "failed");
    await rollbackFailedProvision(deps, tenant.id);
    return { ok: false, step, message };
  } finally {
    stopHeartbeat();
  }
}

/**
 * Best-effort unwind after a failed provision (cf#91). Never throws: the caller has already
 * recorded the failure, and a teardown exception must not erase that record.
 */
async function rollbackFailedProvision(deps: ProvisionDeps, tenantId: string): Promise<void> {
  try {
    const fresh = await deps.store.getTenantById(tenantId);
    if (!fresh) {
      deps.log("provision.rollback_skipped", { tenant: tenantId, reason: "tenant_missing" });
      return;
    }
    const result = await teardownTenant(deps, fresh, { deleteData: true });
    deps.log("provision.rollback", {
      tenant: tenantId,
      ok: result.ok,
      failures: result.failures,
    });
  } catch (e) {
    deps.log("provision.rollback_error", { tenant: tenantId, error: String(e) });
  }
}

/**
 * The module half of provisioning, as ONE subroutine shared by resume and upgrade (cf#103).
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it writes no tenant status and finishes no job. Those are the
 * two things resume and upgrade must NOT share -- resume ends a provision (awaiting_invoke_key),
 * upgrade must leave a live tenant exactly as live as it found it. Keeping both out of here is what
 * makes the sharing safe; a shared helper that also owned the terminal writes would be the
 * same-function-with-reset-state design that was rejected.
 *
 * `release` is a REQUIRED ARGUMENT, not deps.release. That is the fix for the defect this route was
 * built on top of: deps.release is the PLANE-WIDE STUDIO_RELEASE, so every module fetch used to
 * silently mean "whatever the plane is pinned to right now". Making it a parameter forces every
 * caller to say which release it means, and makes the tenant-visible answer auditable.
 */
export interface ModuleStepsHooks {
  shouldRun(step: MarkableProvisionStep): boolean;
  onDone(step: MarkableProvisionStep): Promise<void>;
}

export interface ModuleStepsArgs {
  tenantId: string;
  /**
   * The tenant SLUG, needed because the per-tenant AI Gateway token name derives from it (cf#56).
   * Required rather than optional on purpose: an upgrade that could not name the token would upload
   * plan-enhance WITHOUT its credential and silently drop the tenant onto the free local provider,
   * which is precisely the quiet degrade this seam exists to make impossible.
   */
  slug: string;
  script: string;
  endpoints: TenantEndpoint[];
  studioApiToken: string;
  release: string;
  /**
   * The tenant studio D1 uuid, bound onto the recording modules as TELEMETRY_DB (cp#248). Typed
   * nullable because the tenant RECORD is (a half-built tenant may have no database yet), and
   * uploadTenantModules refuses on a missing one -- one refusal in one place, rather than each
   * caller inventing its own message.
   */
  telemetryD1Id: string | null;
  /**
   * The tenant's own R2 bucket, bound as R2_RENDERS on the modules that write renders (cp#284).
   *
   * Nullable for the same reason telemetryD1Id is -- the tenant RECORD is -- and uploadTenantModules
   * owns the single refusal. Every caller of this seam runs against a tenant whose r2_bucket step
   * completed, so `tenant.r2_bucket_name` is the authoritative source at all three call sites.
   */
  tenantBucketName: string | null;
  /**
   * The tenant's RunPod shape, which decides whether the proxy pair is bound (cp#288). Every caller
   * of this seam runs against a tenant whose endpoints step already completed, so the ROW is
   * authoritative and `readRunPodMode(tenant.runpod_mode)` is the right source at all three call
   * sites -- unlike the fresh provision, which decides the mode in the same run and must carry it.
   *
   * Required, and narrowed rather than `string | null`, so a caller cannot pass the raw column and
   * cannot omit it: an upload REPLACES the binding set, so a mode not passed here is a proxy pair
   * silently stripped off a shared tenant that already had it, the same trap TELEMETRY_DB carries.
   */
  runpodMode: RunPodMode;
  /** Bundles already fetched by the caller (the upgrade path fetches all of them up front). */
  prefetched?: Map<string, ModuleBundle>;
}

export async function runModuleSteps(
  deps: ProvisionDeps,
  args: ModuleStepsArgs,
  hooks: ModuleStepsHooks,
): Promise<void> {
  const { tenantId, script, endpoints, studioApiToken } = args;
  // The explicit release overrides deps.release for every module fetch below.
  const at: ProvisionDeps = { ...deps, release: args.release };

  if (hooks.shouldRun("modules_upload")) {
    // cf#56: an upgrade/converge must (re)mint the tenant AI Gateway token, not just ship bytes.
    // This is the cp#137 lesson applied to a credential: an EXISTING tenant gains plan-enhance on
    // converge, and a module uploaded without its credential is a module that quietly runs on the
    // wrong provider. Revoke-then-mint by name, same shape as provision, so a converge cannot leave
    // two live grants for one tenant behind it.
    let aigTokenValue: string | null = null;
    if (at.aiGatewayId) {
      try {
        await at.tokenMinter.revokeByName(tenantAigTokenName(args.slug));
      } catch (e) {
        at.log("aig_token.revoke_failed", { tenant: tenantId, error: String(e) });
      }
      aigTokenValue = (await at.tokenMinter.mintAigToken(tenantAigTokenName(args.slug))).value;
    }
    await uploadTenantModules(
      at,
      args.release,
      tenantId,
      args.slug,
      endpoints,
      args.telemetryD1Id,
      args.tenantBucketName,
      args.runpodMode,
      args.prefetched,
      aigTokenValue,
    );
    await hooks.onDone("modules_upload");
  }
  if (hooks.shouldRun("modules_install")) {
    await installTenantModules(at, tenantId, script, studioApiToken);
    await hooks.onDone("modules_install");
  }
  if (hooks.shouldRun("verify")) {
    const bindings = await at.cf.getScriptBindings(at.namespace, script);
    const names = new Set(bindings.map((b) => b.name));
    const required = [
      "DB",
      "R2_RENDERS",
      "ASSETS",
      "SPEND_RATE_LIMITER",
      ...REQUIRED_TENANT_STUDIO_VARS,
      ...endpoints.map((e) => e.endpointVar),
    ];
    for (const need of required) {
      if (!names.has(need)) throw new ProvisionFailure("verify", `tenant worker is missing the ${need} binding after upload`);
    }
    const secrets = await at.cf.getScriptSecretNames(at.namespace, script);
    for (const need of ["R2_S3_SECRET_ACCESS_KEY", "STUDIO_API_TOKEN"]) {
      if (!secrets.includes(need)) throw new ProvisionFailure("verify", `tenant worker is missing the ${need} secret after upload`);
    }
    const probe = await at.callTenantStudio(script, { method: "GET", path: "/", studioApiToken });
    if (probe.status >= 500) {
      throw new ProvisionFailure("verify", `tenant studio root returned ${probe.status}; the worker is not serving`);
    }
    const installedModules = await verifyTenantModulesInstalled(at, script, studioApiToken);
    at.log("provision.modules_installed", { tenant: tenantId, modules: installedModules });
    await hooks.onDone("verify");
  }
}

/** Everything the upgrade needs, gathered by a preflight that has written nothing. */
export interface ModuleUpgradeContext {
  script: string;
  endpoints: TenantEndpoint[];
  studioApiToken: string;
  release: string;
  bundles: Map<string, ModuleBundle>;
}

/** A preflight refusal, carrying the HTTP shape the route should answer with. */
export interface ModuleUpgradeRefusal {
  code: string;
  status: number;
  message: string;
}

export type ModuleUpgradePreflight =
  | { ok: true; context: ModuleUpgradeContext }
  | { ok: false; refusal: ModuleUpgradeRefusal };

/**
 * Everything that can be checked WITHOUT writing, checked before anything is written (cf#103).
 *
 * This exists as its own function, called by the route BEFORE it creates a job row, so that a
 * refusal is structurally incapable of leaving state behind: no job, no NULLed release, no
 * half-swapped module. The blast-radius gate on this whole route is "a failed upgrade must leave
 * the tenant serving", and the cheapest way to honour it is for the overwhelmingly likely failures
 * (bad release pin, incomplete tenant, studio not answering) to happen here, where there is nothing
 * to leave behind.
 *
 * Fetching every module bundle is part of PREFLIGHT for that reason, even though it is the
 * expensive step: a release missing one bundle must refuse before the first upload, not after the
 * third.
 */
export async function preflightModuleUpgrade(
  deps: ProvisionDeps,
  tenant: Tenant,
  release: string,
): Promise<ModuleUpgradePreflight> {
  const refuse = (code: string, status: number, message: string): ModuleUpgradePreflight => ({
    ok: false,
    refusal: { code, status, message },
  });

  if (tenant.deleted_at !== null) return refuse("tenant_deleted", 404, "this tenant no longer exists");
  // Suspension is the admin kill switch and is checked before the lifecycle, exactly as routing
  // does it: shipping new code into a suspended tenant would be working around the kill switch.
  if (tenant.suspended_at !== null) {
    return refuse("tenant_suspended", 409, "this tenant is suspended; resume it before upgrading modules");
  }
  // ONLY a live tenant. An unfinished provision belongs to the resume path, which knows how to
  // finish it; overlapping that here would give one tenant two drivers with different terminal
  // writes. Refusing is not a limitation, it is the boundary between the two operations.
  if (tenant.status !== "live") {
    return refuse(
      "tenant_not_live",
      409,
      `module upgrade requires a live tenant; this one is ${tenant.status}. ` +
        "An unfinished provision is resumed through the provision job, not upgraded.",
    );
  }
  if (!tenant.script_name) {
    return refuse("tenant_has_no_studio", 409, "this tenant has no studio script recorded; it cannot be upgraded");
  }

  const endpoints = readTenantEndpoints(tenant);
  // Every catalog module must have its endpoint, checked HERE rather than discovered mid-upload:
  // uploadTenantModules throws on a missing endpoint, and finding that out after two modules were
  // already swapped is precisely the mixed state this route exists to avoid.
  // Only ENDPOINT-BACKED specs can be missing an endpoint (cf#56). A spec with no endpointKey
  // (plan-enhance, which reaches the AI Gateway rather than RunPod) has nothing to be missing, and
  // including it here would refuse EVERY upgrade with a nonsense "missing the endpoint(s) needed
  // by: plan-enhance" -- the check inverted into a permanent blocker. Mirrors the same
  // endpointKey-guarded lookup in uploadTenantModules, which is the thing this pre-checks.
  const missing = TENANT_MODULE_CATALOG.filter(
    (spec) => spec.endpointKey !== undefined && !endpoints.some((e) => e.key === spec.endpointKey),
  );
  if (missing.length) {
    return refuse(
      "tenant_endpoints_incomplete",
      422,
      `this tenant is missing the endpoint(s) needed by: ${missing.map((m) => m.module).join(", ")}`,
    );
  }
  if (!tenant.studio_token_enc) {
    return refuse("tenant_studio_token_missing", 422, "no studio token recorded for this tenant");
  }
  let studioApiToken: string;
  try {
    studioApiToken = await decryptStudioToken(deps.kek, tenant.studio_token_enc);
  } catch (e) {
    return refuse("tenant_studio_token_unreadable", 422, `the stored studio token could not be decrypted: ${String(e)}`);
  }

  // The tenant must be SERVING before we touch it. If it is already broken, an upgrade would be
  // blamed for a fault it did not cause, and "leave the tenant serving" is unverifiable when it was
  // not serving to begin with.
  const probe = await deps.callTenantStudio(tenant.script_name, { method: "GET", path: "/", studioApiToken });
  if (probe.status >= 500) {
    return refuse(
      "tenant_studio_not_serving",
      422,
      `the tenant studio answered ${probe.status} before the upgrade started; fix that first`,
    );
  }

  let bundles: Map<string, ModuleBundle>;
  try {
    bundles = await prefetchModuleBundles(deps, release);
  } catch (e) {
    return refuse("module_bundle_unavailable", 422, e instanceof TenantModuleError ? e.message : String(e));
  }

  return { ok: true, context: { script: tenant.script_name, endpoints, studioApiToken, release, bundles } };
}

export type ModuleUpgradeOutcome =
  | { ok: true; release: string; modules: string[] }
  | { ok: false; step: ProvisionStep; message: string };

/**
 * Ship newly published modules to a LIVE tenant (cf#103 half two).
 *
 * WHY THIS IS A SIBLING OF continueProvisionJob AND NOT THAT FUNCTION WITH steps_done RESET:
 * that function ends a PROVISION. Its success path writes setTenantStatus("awaiting_invoke_key"),
 * which routingStatusFor maps to a non-routable state and tenantRefusal answers with 503 "this
 * studio is still being set up". Pointed at a live tenant it would therefore take a paying customer
 * DARK on the path where everything went RIGHT. That is not a mismatch of intent to paper over; it
 * is proof that the two operations have different terminal state machines, and the terminal writes
 * are the one thing they must not share. Reuse of the middle is real and lives in runModuleSteps.
 *
 * THE STATUS RULE, which is the whole safety story: this function NEVER writes tenants.status. Not
 * on entry, not on success, not on failure. A live tenant stays live for the entire upgrade, so
 * routing keeps dispatching to its unchanged script_name and its users keep being served. Progress
 * and failure live on the JOB row. A "provisioning-shaped" transit would have meant every user
 * getting 503 + retry-after for the duration, which is an outage, not a state.
 *
 * WHAT A USER CAN STILL NOTICE, stated honestly rather than rounded up to seamless: module scripts
 * are replaced by in-place PUT and there is no atomic multi-script swap on Workers for Platforms.
 * The STUDIO never stops serving, but a module invocation inside the swap window may execute old or
 * new bytes. Both are conformance-gated, so neither is broken -- see the cross-module note below.
 *
 * NO AUTOMATIC ROLLBACK, deliberately. Rolling back means issuing MORE writes against a tenant that
 * just failed a write, on the same path that is already failing, to reach a state we have not
 * verified is reachable. Instead the failure is recorded in full and the tenant keeps serving;
 * rollback is re-running this same route at the previous release, which the job row preserves
 * (from_release) precisely because modules_release is NULLed before the first write.
 *
 * CROSS-MODULE COMPATIBILITY of a partially-upgraded state, stated from the catalog rather than
 * assumed from the conformance gate: the six RunPod catalog modules serve four hooks -- keyframe
 * (`keyframe`), own-gpu (`motion.backend`), speech-upscale (`speech`), and finish-upscale +
 * finish-lipsync + finish-rife (all three `finish`). Modules on DIFFERENT hooks never see each
 * other output, so those three groups are mutually independent and a mixed state across them is not
 * expressible.
 *
 * cp#284 MADE THE `finish` GROUP A CHAIN OF THREE, AND THIS PARAGRAPH IS STILL WRITTEN FOR TWO.
 * The chaining argument below is sound for any adjacent pair in the chain and has NOT been
 * re-derived for a three-long chain -- specifically, whether a mixed state across three links can
 * express an incompatibility the two-link argument does not cover is an open question, not a
 * settled one. Flagged rather than silently generalised. The coupled group is the `finish`
 * modules, which CHAIN: each takes FinishInput{shot_id, clip_key} and returns
 * FinishOutput{clip_key}, so each consumes the output key of the one before it. A mixed
 * finish chain therefore means two vendored copies of that contract meeting on one clip. That is
 * bounded, but NOT by conformance (which is per-module and says nothing about pairs): it is bounded
 * by the `api: "vivijure-module/2"` version the contract carries, because an incompatible change to
 * the finish payload requires bumping it and the studio install gate rejects an api it does not
 * accept -- so an incompatible mixed chain fails at INSTALL, leaving the old module resident and
 * the tenant serving. The residual this does NOT cover is a semantic redefinition of an existing
 * field WITHOUT an api bump; that is a release-discipline defect which would break a full
 * re-provision just as badly, and it is a known limit of this route rather than something it can
 * detect.
 */
export async function upgradeTenantModules(
  deps: ProvisionDeps,
  jobId: string,
  tenant: Tenant,
  context: ModuleUpgradeContext,
  clock: ProvisionClock = realClock,
  budgetMs: number = PROVISION_INVOCATION_BUDGET_MS,
): Promise<ModuleUpgradeOutcome> {
  const startedAt = clock.now();
  const done: MarkableProvisionStep[] = [];
  const timeStep = stepTimer(startedAt);
  const mark = async (step: MarkableProvisionStep) => {
    done.push(step);
    await deps.store.updateJobProgress(jobId, step, JSON.stringify(done));
    // ONE clock read, reused for both the timing and the budget check. Reading the clock twice
    // would be the obvious way to write this and it would be wrong: the tests drive a hand-rolled
    // clock that ADVANCES ON EVERY READ, so a second read would change when a yield fires. That is
    // perturbing the instrument the measurement is about (cp#18), not a style preference.
    const at = clock.now();
    deps.log("provision.step", { tenant: tenant.id, job: jobId, phase: "module_upgrade", ...timeStep(step, at) });
    if (!YIELD_UNSAFE_STEPS.has(step) && at - startedAt >= budgetMs) throw new ProvisionYield(step);
  };

  const stopHeartbeat = startLeaseHeartbeat(deps, jobId);
  try {
    // Same lease treatment as provision (#44): the route claims before 202; this covers direct
    // callers and renews if the claim expired between accept and execution.
    await deps.store.setJobRunning(jobId);

    // Clear the recorded module release BEFORE the first upload. From here until success the tenant
    // is not known to be uniformly at any one release, and the column must say so: a value left
    // standing through a partial failure would assert a uniformity the resident scripts do not
    // have. NULL means "consult the job row", which is why from_release lives there.
    await deps.store.setTenantModulesRelease(tenant.id, null);

    await runModuleSteps(
      deps,
      {
        tenantId: tenant.id,
        slug: tenant.slug,
        script: context.script,
        endpoints: context.endpoints,
        studioApiToken: context.studioApiToken,
        release: context.release,
        prefetched: context.bundles,
        // Restated from the ROW for the same reason TELEMETRY_DB is: an upload REPLACES the
        // binding set, so a bucket not passed here is R2_RENDERS silently stripped off a
        // tenant that had it -- which does not break the module, it redirects its writes to
        // the operator bucket (cp#284).
        tenantBucketName: tenant.r2_bucket_name,

        // From the RECORD. A module upgrade re-uploads the module scripts, and an upload REPLACES
        // the binding set, so TELEMETRY_DB has to be restated here or an upgrade would silently
        // strip it back off a tenant that already had it (cp#248).
        telemetryD1Id: tenant.d1_database_id,
        // Same restatement, same reason, for the proxy pair (cp#288).
        runpodMode: readRunPodMode(tenant.runpod_mode),
      },
      // An upgrade re-runs every module step against a tenant that already completed them, which is
      // exactly what resume must never do.
      { shouldRun: () => true, onDone: mark },
    );

    await deps.store.setTenantModulesRelease(tenant.id, context.release);
    await deps.store.finishJob(jobId, "succeeded", null, null);
    deps.log("module_upgrade.succeeded", { tenant: tenant.id, release: context.release });
    // NOTE what is absent and must stay absent: no setTenantStatus call. The tenant was live on the
    // way in and is live on the way out.
    return { ok: true, release: context.release, modules: TENANT_MODULE_CATALOG.map((m) => m.module) };
  } catch (e) {
    // A yield here is NOT resumable the way a provision is: there is no upgrade continuation
    // driver, so leaving the job "running" would strand it forever. Record it as the honest failure
    // it is, naming the mixed state and how to resolve it, and leave the tenant serving.
    if (e instanceof ProvisionYield) {
      const message =
        `the upgrade ran out of its invocation budget after ${e.after}; module bytes may be mixed ` +
        "(see steps_done) and the tenant is still serving. Re-run the upgrade to finish it, or " +
        "re-run at from_release to go back.";
      deps.log("module_upgrade.exhausted", { tenant: tenant.id, after: e.after, release: context.release });
      await deps.store.finishJob(jobId, "failed", e.after, message);
      return { ok: false, step: e.after, message };
    }
    const step = e instanceof ProvisionFailure ? e.step : e instanceof TenantModuleError ? e.step : inferStep(done);
    const message =
      e instanceof CfApiError || e instanceof ProvisionFailure || e instanceof TenantModuleError ? e.message : String(e);
    deps.log("module_upgrade.failed", { tenant: tenant.id, step, message, release: context.release });
    await deps.store.finishJob(jobId, "failed", step, message);
    // Again: NO setTenantStatus. continueProvisionJob writes "failed" here, which would make a
    // still-serving paying tenant answer 503 to its own users. That single line is the difference
    // between a failed upgrade and an outage.
    return { ok: false, step, message };
  } finally {
    stopHeartbeat();
  }
}

const inferStep = (done: ProvisionStep[]): ProvisionStep =>
  PROVISION_STEPS[Math.min(done.length, PROVISION_STEPS.length - 1)];

/**
 * Upload the tenant studio script, and REFUSE HONESTLY if the video-finish binding cannot be
 * attached (cf#118).
 *
 * WHY THIS IS NOT A CATCH-AND-CONTINUE. Dropping the binding and provisioning anyway would hand the
 * operator a tenant that looks fully provisioned while silently lacking a tier the plane is
 * CONFIGURED to provide -- the render would then degrade to per-shot clips with a reason blaming an
 * unbound binding, which is true and useless, because the operator set the service id and believes
 * it is there. That is the isolation-theater / silent-degrade class (#245 / #249): the failure has
 * to be named at the moment it happens, at the step that owns it.
 *
 * The named message exists because CF's own words here ("your credentials are not authorized for the
 * requested VPC resource") are accurate and point at the wrong owner: the person reading a failed
 * provision needs to know it is the PLANE's upload credential that is short a scope, not anything
 * about the tenant.
 */
async function uploadStudioScript(
  deps: ProvisionDeps,
  args: Parameters<CfApi["uploadUserWorker"]>[0],
): Promise<void> {
  try {
    await deps.scriptUploadCf.uploadUserWorker(args);
  } catch (e) {
    const attachingVpc = args.bindings.some((b) => b.type === "vpc_service");
    const vpcRefusal = e instanceof CfApiError && e.cfErrors.some((c) => c.code === CF_VPC_BINDING_UNAUTHORIZED);
    if (attachingVpc && vpcRefusal) {
      throw new ProvisionFailure(
        "wfp_upload",
        "video-finish binding refused: the plane's SCRIPT UPLOAD credential is not authorized for " +
          "Workers VPC (needs Connectivity Directory access). The tenant was NOT provisioned without " +
          "the tier -- fix CF_WORKER_UPLOAD_TOKEN, or clear VIDEO_FINISH_VPC_SERVICE_ID to run this " +
          "plane without video finishing on purpose.",
      );
    }
    throw e;
  }
}

export async function uploadStudioAssets(
  deps: ProvisionDeps,
  slug: string,
  assets: NonNullable<Awaited<ReturnType<StudioBundleSource["fetch"]>>["assets"]>,
): Promise<string | undefined> {
  const script = deps.tenantScriptName(slug);
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const a of assets) manifest[a.path] = { hash: a.hash, size: a.size };

  // SAME credential as the script PUT that consumes this session's JWT (cf#118). Splitting them
  // across two tokens would be a seam nobody tested: the completion JWT is minted by one client and
  // redeemed by another, and "it probably does not care which token" is exactly the assumption this
  // repo keeps getting burned by. One credential owns the whole studio-script upload.
  const session = await deps.scriptUploadCf.createAssetsUploadSession(deps.namespace, script, manifest);
  // No buckets to fill means every asset is already resident in the namespace (WfP dedupes assets
  // by hash ACROSS the namespace, so tenant N+1 ships the same UI for free). The session JWT is
  // then already the completion JWT.
  if (!session.buckets?.length) return session.jwt;

  const byHash = new Map(assets.map((a) => [a.hash, a]));
  let completion: string | undefined = session.jwt;
  for (const bucket of session.buckets) {
    const files = bucket
      .map((hash) => byHash.get(hash))
      .filter((a): a is NonNullable<typeof a> => Boolean(a))
      .map((a) => ({ hash: a.hash, base64: a.base64, contentType: a.contentType }));
    if (!files.length) continue;
    const res = await deps.scriptUploadCf.uploadAssetBucket(session.jwt ?? "", files);
    if (res.jwt) completion = res.jwt;
  }
  return completion;
}

/**
 * Tear a tenant down. Best-effort and ORDERED so that the tenant stops being reachable FIRST:
 * pulling the worker before deleting its data means no request can hit a half-deleted studio.
 * The R2 credential is revoked BEFORE the bucket/D1 it points at (credential-first among data
 * resources; cf#91), and revoke falls back to the deterministic token name when the id was never
 * persisted. Every failure is collected and reported rather than thrown, because a teardown that
 * stops at the first error leaves the most dangerous leftovers (a live credential) behind.
 */
export interface TeardownOutcome {
  /** True when nothing FAILED. Absence is not a failure (cp#110), so it does not clear this flag. */
  ok: boolean;
  /** What refused (the guard) or did not work (a real error). Retry or investigate. */
  failures: { resource: string; error: string }[];
  /**
   * What was already gone when we went to delete it (cp#110). Not a failure and not a reap: the
   * resource is in the state teardown wanted, but this plane is not the thing that put it there.
   */
  absent: { resource: string; detail: string }[];
}

export interface TeardownOpts {
  deleteData: boolean;
  /**
   * cp#106 option C: when true, referrers that are ALL status=`deleted` do not block. Live
   * referrers still always refuse. Only set after the operator has named this row as owner via
   * `i_own` on the admin teardown route; the decision is audited there, not here.
   */
  ignoreTombstoneReferrers?: boolean;
}

export async function teardownTenant(
  deps: ProvisionDeps,
  tenant: Tenant,
  opts: TeardownOpts,
): Promise<TeardownOutcome> {
  const failures: { resource: string; error: string }[] = [];
  // ALREADY GONE is not a failure, and it is not a reap either (cp#110). It gets its own list so
  // the failure list stays clean -- the row can reach "provably reaped" -- while the fact that we
  // found nothing to delete survives into the response and the audit record instead of reading
  // identically to a delete we performed.
  const absent: { resource: string; detail: string }[] = [];

  // ---- THE PRESERVATION INTERLOCK (cp#118) ----------------------------------------------------
  //
  // FIRST, BEFORE THE REFERENTIAL GUARD AND BEFORE ANY DELETE. An open preservation hold means this
  // tenant is under a statutory duty to keep material we would otherwise destroy here: 18 U.S.C.
  // 2258A(h) after our own CyberTipline submission, 2703(f) after a governmental request, or an
  // internal hold on a report that has not reached either yet.
  //
  // WHY IT REFUSES THE WHOLE PASS rather than just the data legs. ABUSE-RESPONSE-RUNBOOK.md
  // Section 5.2 does not say "tear down carefully" while a report is open, it says teardown is
  // NEVER permitted and SUSPEND is the lever (instant, reversible, audited, destroys nothing).
  // Pulling the worker while refusing the bucket would be a partial teardown nobody asked for, and
  // it would also remove the studio an investigation may still need to reach. So: touch nothing.
  //
  // WHY IT IS A REFUSAL AND NOT A FAILURE. Same vocabulary as the referential guard (#23): the
  // route splits `refused:` out of the failure list because they need opposite follow-up. A
  // refusal here is the interlock WORKING, and there is nothing to retry -- the only way past it is
  // a human releasing the hold, which is its own audited admin action.
  //
  // FAIL CLOSED, and note which direction that is: if the store cannot answer whether a hold
  // exists, we refuse. An un-run teardown is recoverable by running it again; destroying preserved
  // evidence is not, and 2258A(h) makes the well-meant version of that mistake crime-adjacent.
  try {
    const held = await deps.store.listPreservationHolds(tenant.id, { openOnly: true });
    if (held.length > 0) {
      const who = held
        .map((h) => {
          // The clock is REPORTED, never enforced. An elapsed floor still blocks: 2258A(h)(5)
          // permits preserving longer and 2258B(c) puts destruction on a law-enforcement request,
          // so "the year is up" is a fact for a human to weigh, not a release.
          const clock = h.expires_at ? `preserve-until ${h.expires_at}` : "no clock set";
          return `${h.id} (${h.kind}, ${clock}, opened ${h.opened_at} by ${h.opened_by}: ${h.reason})`;
        })
        .join("; ");
      const error =
        `refused: ${held.length} open preservation hold(s) on this tenant, teardown is NEVER ` +
        `permitted while one is open -- suspend instead, and release the hold explicitly if the ` +
        `duty is genuinely over: ${who}`;
      deps.log("teardown.preservation_hold", { tenant: tenant.id, holds: held.length });
      const only = [{ resource: "preservation_hold", error }];
      await recordTeardownSafely(deps, tenant.id, only);
      return { ok: false, failures: only, absent };
    }
  } catch (e) {
    const error =
      `refused: could not determine whether a preservation hold is open, refusing every deletion: ${String(e)}`;
    deps.log("teardown.preservation_hold_unknown", { tenant: tenant.id, error: String(e) });
    const only = [{ resource: "preservation_hold", error }];
    await recordTeardownSafely(deps, tenant.id, only);
    return { ok: false, failures: only, absent };
  }

  // ---- THE REFERENTIAL GUARD (#23) -------------------------------------------------------------
  //
  // A resource id on this row does NOT mean the object is this tenant's to delete. Resource names
  // derive from the SLUG, and the house pattern frees a slug by RENAMING the old row, so the old row
  // keeps its ids while the next tenant to take that slug provisions onto the same names -- and
  // therefore the same objects. Slug reuse is resource reuse.
  //
  // A census of the live plane found ONE physical D1 referenced by nine successive tenant rows:
  // eight tombstones and the LIVE tenant. Tearing down any one of those tombstones with
  // deleteData would have deleted the live tenant's database, bucket and studio worker. Nothing in
  // the code prevented it; the only thing that did was that no caller existed yet. This issue wires
  // a caller, so the guard has to exist first.
  //
  // FAIL CLOSED, and note which direction that is. If the guard cannot answer, we do not know whose
  // the resources are, and "delete anyway" is the one answer that cannot be taken back. An
  // un-run teardown leaves resources alive, which is recoverable by running it again.
  let blocked: Map<TenantResourceKind, ResourceReferrer[]>;
  try {
    const referrers = await deps.store.findResourceReferrers(tenant.id, {
      d1_database_id: tenant.d1_database_id,
      r2_bucket_name: tenant.r2_bucket_name,
      r2_token_id: tenant.r2_token_id,
      script_name: tenant.script_name,
    });
    blocked = new Map();
    for (const r of referrers) {
      const list = blocked.get(r.resource) ?? [];
      list.push(r);
      blocked.set(r.resource, list);
    }
  } catch (e) {
    // Cannot prove ownership -> reap nothing. Recorded as its own resource so the row says WHY it
    // is untouched rather than reading as a teardown that found nothing to do.
    const error = `referential guard could not run, refusing every deletion: ${String(e)}`;
    deps.log("teardown.guard_failed", { tenant: tenant.id, error: String(e) });
    const only = [{ resource: "guard", error }];
    await recordTeardownSafely(deps, tenant.id, only);
    return { ok: false, failures: only, absent };
  }

  /**
   * Refuse a resource another row still points at, and say who.
   *
   * Default: ANY referrer blocks, not just a live one. Without provenance, a resource shared only
   * with tombstones is still not provably ours -- refusing is honest and reversible (cp#106).
   *
   * Option D: when `tenant_resource_ownership` records THIS tenant as the owner and no referrer is
   * live, tombstone-only aliases do not block. Written at provision; not silent last-referrer-wins.
   *
   * Option C, the operator hatch (cp#334): a LEGACY row, meaning one with no ownership claim at
   * all, reaps past tombstone-only referrers when the operator asserts `ignoreTombstoneReferrers`.
   * Three things still refuse, and they are what keeps C from undoing D: a live referrer, a
   * recorded owner that is not this tenant, and an ownership lookup that FAILED (unknown is not
   * legacy). The operator must have named this row via `i_own` on the admin route; that decision is
   * audited there, not invented here.
   */
  const resourceKeyFor = (r: TenantResourceKind): string | null => {
    if (r === "d1") return tenant.d1_database_id;
    if (r === "r2_bucket") return tenant.r2_bucket_name;
    if (r === "r2_token") return tenant.r2_token_id;
    if (r === "worker") return tenant.script_name;
    return null;
  };

  const guarded = async (resource: TenantResourceKind): Promise<boolean> => {
    const hits = blocked.get(resource);
    if (!hits?.length) return false;
    const who = hits.map((h) => `${h.tenant_id} (${h.slug}, status=${h.status})`).join(", ");
    const live = hits.some((h) => h.status !== "deleted");
    const key = resourceKeyFor(resource);
    let recordedOwner: string | null = null;
    // NULL IS TWO DIFFERENT ANSWERS AND ONLY ONE OF THEM MAY OPEN THE HATCH.
    //
    // `recordedOwner === null` means EITHER "the lookup succeeded and this is a legacy row with no
    // ownership claim" -- which is exactly the population option C exists for -- OR "the lookup
    // threw and we do not know". Collapsing those lets a transient D1 failure during an `i_own`
    // teardown silently downgrade D back to C, on the one path where all three cp#106 rulings chose
    // the recoverable direction. Could-not-determine must not render as a determination.
    let ownerLookupFailed = false;
    if (key) {
      try {
        recordedOwner = await deps.store.getResourceOwner(resource, key);
      } catch (e) {
        ownerLookupFailed = true;
        deps.log("teardown.ownership_lookup_failed", {
          tenant: tenant.id,
          resource,
          error: e instanceof Error ? e.message : "lookup failed",
        });
      }
    }
    // D: recorded owner + tombstone-only referrers -> allow
    if (recordedOwner === tenant.id && !live) {
      deps.log("teardown.ownership_allows", {
        tenant: tenant.id,
        resource,
        referrers: hits.length,
      });
      return false;
    }
    // C (operator i_own): only for LEGACY rows with no ownership claim. A recorded owner that is
    // not this tenant always wins over i_own -- otherwise the hatch would undo option D.
    if (!live && !recordedOwner && !ownerLookupFailed && opts.ignoreTombstoneReferrers) {
      deps.log("teardown.tombstone_referrers_overridden", {
        tenant: tenant.id,
        resource,
        referrers: hits.length,
      });
      return false;
    }
    const error =
      `refused: ${resource} is still referenced by ${hits.length} other tenant row(s): ${who}` +
      (live
        ? " -- AT LEAST ONE IS NOT DELETED, this resource is in use"
        : recordedOwner && recordedOwner !== tenant.id
          ? ` -- recorded owner is ${recordedOwner}, not this tenant (i_own cannot override a recorded owner)`
          : ownerLookupFailed
            ? " -- all referrers are tombstones, but the ownership lookup FAILED, so whether this tenant owns the resource is UNKNOWN. i_own is refused on an unknown, not on a legacy row. Retry once the store is reachable (cp#106)"
            : ` -- all referrers are tombstones and NO owner is recorded (legacy); re-run with i_own: "${tenant.id}" after verifying ownership, or re-provision to record ownership (cp#106)`);
    failures.push({ resource, error });
    deps.log("teardown.refused", {
      tenant: tenant.id,
      resource,
      referrers: hits.length,
      live,
      owner: recordedOwner,
      // cp#106: distinguishes "no owner recorded" from "we could not find out". Without it the log
      // row for a store outage is byte-identical to the row for a legacy resource.
      owner_lookup_failed: ownerLookupFailed,
    });
    return true;
  };

  /**
   * Try to delete, and on success blank the column so the row stops claiming a resource that is
   * gone. Blanking ONLY on success is the whole point: a row that blanks on failure would read as
   * reaped while a customer's bucket is still there.
   */
  const clearColumn = async (resource: string, clears: TenantResourceKind) => {
    try {
      await deps.store.clearTenantResource(tenant.id, clears);
    } catch (e) {
      // The resource IS gone; only the bookkeeping failed. Recorded distinctly so it is never
      // read as "the delete failed" -- the two need opposite follow-up actions.
      failures.push({ resource: `${resource}_record`, error: String(e) });
      deps.log("teardown.record_failed", { tenant: tenant.id, resource, error: String(e) });
    }
  };

  /**
   * absentWhen is how a leg says which error PROVES the resource is already gone (cp#110). Such a
   * delete reached this call goal earlier, by something else, so the column blanks exactly as it
   * would on a success -- but the fact is pushed to `absent`, never swallowed, because "we deleted
   * it" and "it was not there when we looked" are different facts and the second usually means a
   * resource was removed out of band, which an operator may want to know about.
   */
  const attempt = async (
    resource: string,
    fn: () => Promise<unknown>,
    clears?: TenantResourceKind,
    absentWhen?: (e: unknown) => boolean,
  ) => {
    try {
      await fn();
      if (clears) await clearColumn(resource, clears);
    } catch (e) {
      if (absentWhen?.(e)) {
        // Event name is teardown.<resource>_absent, matching the teardown.r2_token_absent line below.
        absent.push({ resource, detail: String(e) });
        deps.log(`teardown.${resource}_absent`, { tenant: tenant.id, error: String(e) });
        if (clears) await clearColumn(resource, clears);
        return;
      }
      failures.push({ resource, error: String(e) });
      deps.log("teardown.failed", { tenant: tenant.id, resource, error: String(e) });
    }
  };

  /**
   * MINT -> WORK -> REVOKE, with the mint and the revoke HERE so the credential lifetime is visible
   * at the call site rather than buried in r2-empty.ts (that module states the invariant and
   * deliberately owns neither half).
   *
   * Every cycle mints its OWN bucket-scoped credential and revokes it before returning, on every
   * path. The tempting alternative -- mint once, carry it across resumable cycles -- would store or
   * strand a live grant, which is the orphaned-credential class this path exists to close.
   *
   * A bucket too large for one budget does NOT fail terminally: the cycle reports what it deleted,
   * this throws so attempt() records the honest stop and leaves the column INTACT (blanking happens
   * only on success), and re-running teardown continues from where this cycle stopped.
   */
  const emptyThenDeleteBucket = async (bucket: string): Promise<void> => {
    const cred = await deps.tokenMinter.mintBucketToken(tenantR2TeardownTokenName(tenant.slug), bucket);
    try {
      const result: EmptyBucketResult = await emptyBucketBounded({
        endpoint: deps.r2Endpoint,
        bucket,
        credential: { accessKeyId: cred.id, secretAccessKey: await sha256Hex(cred.value) },
        budgetMs: TEARDOWN_EMPTY_BUDGET_MS,
        now: deps.now,
        sleep: deps.sleep,
        fetch: deps.fetch,
        log: deps.log,
      });
      if (!result.emptied) {
        throw new Error(
          `bucket not emptied this cycle (deleted ${result.deleted} object(s)` +
            (result.stalled ? `, stalled: ${result.stalled}` : "") +
            `); re-run teardown to continue`,
        );
      }
      deps.log("teardown.bucket_emptied", { tenant: tenant.id, bucket, deleted: result.deleted });
      await deps.cf.deleteR2Bucket(bucket);
    } finally {
      // A stranded bucket-scoped grant is the worst leftover this path can produce, so a failed
      // revoke is RECORDED on the row, not merely logged. It is its own resource name because it
      // needs the opposite follow-up from a failed delete: revoke it by hand, now.
      try {
        await deps.tokenMinter.revoke(cred.id);
      } catch (e) {
        failures.push({
          resource: "r2_empty_credential",
          error: `teardown credential ${cred.id} could NOT be revoked, revoke it by hand: ${String(e)}`,
        });
        deps.log("teardown.empty_credential_stranded", { tenant: tenant.id, bucket, error: String(e) });
      }
    }
  };


  // Delete the worker by its STORED name, falling back to the derivation only when the row has none.
  //
  // These are not the same fact. script_name records what was ACTUALLY created; tenantScriptName(slug)
  // recomputes what we WOULD create today. They agree only while the naming scheme is unchanged, and
  // tenants.ts already states that routing dispatches to the STORED name because it is authoritative
  // at request time. Teardown reading the derivation instead meant the two halves disagreed about
  // which script a tenant owns: the moment a release changes the scheme, teardown deletes the name it
  // would use now and ORPHANS the one that actually exists -- a live user Worker left serving in the
  // namespace, which for a tenant being torn down is the single worst leftover.
  // Latent today (both derive from the same immutable slug), which is exactly why it is worth fixing
  // before something makes it live. Caught by Strummer during the reclaim-lease seam review.
  const scriptToDelete = tenant.script_name ?? deps.tenantScriptName(tenant.slug);
  if (!(await guarded("worker"))) {
    // cp#110: a not-found on THIS delete is success-equivalent. Before it, the guarded sweep that
    // met two already-gone tenant scripts recorded each as a retryable failure, so the column kept
    // claiming a worker that does not exist, teardown_failures kept a permanent entry no re-run
    // could clear, and the row could never reach the provably-reaped state #23 exists to make
    // reachable. The classifier is narrow (404 AND code 10007) precisely so this does not become
    // "swallow everything", which would be worse than the bug.
    await attempt(
      "worker",
      () => deps.cf.deleteUserWorker(deps.namespace, scriptToDelete),
      "worker",
      isScriptAbsent,
    );
  }
  // Module scripts next (cf#99): the studio (discovery) is already gone, so sweeping the tenant's
  // module scripts cannot tear a /poll out from under a live studio. Prefix sweep + census; every
  // failure is surfaced (a live-configured module worker is exactly what must not be left behind).
  const moduleTeardown = await teardownTenantModules(deps, tenant.id);
  for (const f of moduleTeardown.failures) failures.push(f);
  for (const a of moduleTeardown.absent) absent.push(a);

  // Credential BEFORE bucket/D1 (cf#91): kill the live grant, then the resources it points at.
  // Prefer the persisted id; always attempt by-name as well when id is missing OR revoke-by-id
  // failed (the unpersisted-id class and the "id on a row we are about to blank" class).
  const tokenName = tenantR2TokenName(tenant.slug);
  let revokedById = false;
  const tokenGuarded = await guarded("r2_token");
  if (tenant.r2_token_id && !tokenGuarded) {
    try {
      await deps.tokenMinter.revoke(tenant.r2_token_id);
      revokedById = true;
      await deps.store.clearTenantResource(tenant.id, "r2_token").catch((e: unknown) => {
        failures.push({ resource: "r2_token_record", error: String(e) });
      });
    } catch (e) {
      failures.push({ resource: "r2_token", error: String(e) });
      deps.log("teardown.failed", { tenant: tenant.id, resource: "r2_token", error: String(e) });
    }
  }
  if (!revokedById && !tokenGuarded) {
    await attempt("r2_token_by_name", async () => {
      const hit = await deps.tokenMinter.revokeByName(tokenName);
      if (!hit && !tenant.r2_token_id) {
        // Nothing to revoke: either never minted, or already gone. Not a failure.
        deps.log("teardown.r2_token_absent", { tenant: tenant.id, name: tokenName });
      }
    });
  }

  // cf#56 / cf#98: per-tenant AI Gateway Run tokens (module + studio). BY NAME ONLY, because their
  // ids are deliberately not persisted: unlike the R2 credential (whose id doubles as the S3 access
  // key id) these tokens are only ever needed in order to revoke them, so the deterministic name IS
  // the handle. Revoked here, alongside the R2 grant -- a stranded live grant bills to US.
  //
  // Guarded on the SAME r2_token guard, deliberately: both names derive from the SLUG, so if slug
  // reuse means another live row owns these credentials, neither may be revoked out from under it.
  if (!tokenGuarded) {
    await attempt("aig_token_by_name", async () => {
      const hit = await deps.tokenMinter.revokeByName(tenantAigTokenName(tenant.slug));
      if (!hit) {
        // Never minted (a plane with no gateway configured) or already gone. Not a failure.
        deps.log("teardown.aig_token_absent", { tenant: tenant.id, name: tenantAigTokenName(tenant.slug) });
      }
    });
    await attempt("aig_studio_token_by_name", async () => {
      const hit = await deps.tokenMinter.revokeByName(tenantStudioAigTokenName(tenant.slug));
      if (!hit) {
        deps.log("teardown.aig_studio_token_absent", {
          tenant: tenant.id,
          name: tenantStudioAigTokenName(tenant.slug),
        });
      }
    });
  }

  if (opts.deleteData) {
    // ---- HARVEST BEFORE REAP (cp#270, for vivijure-cf#225) --------------------------------------------
    //
    // ORDERED AHEAD OF THE D1 DELETE, and that order is the entire point. The RunPod job -> tenant
    // index is built by a periodic sweep that READS each tenant database, which leaves one hole:
    // every job submitted between the last sweep and this deletion. Harvesting here closes it, and
    // turns a race into a guarantee -- after this line the source is gone forever, so this is the
    // last moment the mapping can be recovered at all.
    //
    // A FAILED HARVEST FAILS THE TEARDOWN. It joins `failures`, so the row does not reach the
    // provably-reaped state and a re-run will try again. That is deliberate and it is the
    // uncomfortable direction: it means a tenant database we cannot read blocks a teardown. The
    // alternative is deleting the only copy of the attribution that vivijure-cf#225's report-driven
    // investigation depends on, in order to finish a cleanup that can safely be retried. An
    // un-run teardown is recoverable; a deleted mapping is not.
    //
    // NOT A FAILURE, and the distinction is why the harvest asks sqlite_master rather than reading
    // an error string: a tenant with NO `runpod_job_log` table has nothing to harvest and is a
    // complete harvest of nothing. That is the normal state for a provision that died before its
    // migrations ran, which is exactly the population rollbackFailedProvision tears down -- so
    // treating an absent table as an error would make every failed provision unreapable.
    if (tenant.d1_database_id && !(await guarded("d1"))) {
      try {
        const harvest = await harvestTenantJobLog(deps.cf, tenant.d1_database_id);
        if (!harvest.complete) {
          // A partial read is refused rather than indexed. Indexing the first N and continuing
          // would delete the source while claiming coverage we do not have, which is worse than
          // stopping: the index would look authoritative and be silently short.
          throw new Error(
            `job log exceeded the ${HARVEST_ROW_CAP}-row harvest ceiling, so the index would be ` +
              "silently short of the log we are about to delete; paging is needed before this " +
              "tenant can be torn down",
          );
        }
        const written = await deps.store.indexRunpodJobs(tenant.id, tenant.slug, harvest.rows);
        deps.log("teardown.job_index_harvested", {
          tenant: tenant.id,
          rows: harvest.rows.length,
          written,
          table_absent: harvest.tableAbsent,
        });
      } catch (e) {
        failures.push({ resource: "job_index_harvest", error: String(e) });
        deps.log("teardown.job_index_harvest_failed", { tenant: tenant.id, error: String(e) });
      }
    }
    // The D1 delete is CONDITIONAL on the harvest above having succeeded. Checking `failures`
    // rather than threading a boolean is deliberate: it means any future leg that records a
    // harvest failure also stops the delete, instead of a new failure mode quietly bypassing the
    // one interlock that protects the mapping.
    const harvestFailed = failures.some((f) => f.resource === "job_index_harvest");
    if (tenant.d1_database_id && !(await guarded("d1")) && !harvestFailed) {
      await attempt("d1", () => deps.cf.deleteD1(tenant.d1_database_id!), "d1");
    }
    // EMPTY-THEN-DELETE (cf#72), wired here by this issue caller work.
    //
    // THE CONSTRAINT, live-proven: R2 refuses to delete a NON-EMPTY bucket, and the R2 REST API has
    // no object-list or object-delete endpoint at all (404). Emptying only goes through the S3 API,
    // under a bucket-scoped credential. So before this leg existed, deleteR2Bucket succeeded only
    // for a tenant that never rendered, and a tenant that was ever live is precisely the population
    // that HAS rendered.
    //
    // ORDER IS THE SAFETY PROPERTY: guarded() runs BEFORE anything is minted or listed. Emptying is
    // the irreversible half (an emptied bucket is gone whether or not the delete that follows
    // succeeds), and slug reuse IS resource reuse, so a bucket another row still references must
    // never be OPENED at all, rather than opened and then spared. The refusal short-circuits while
    // no credential exists.
    if (tenant.r2_bucket_name && !(await guarded("r2_bucket"))) {
      await attempt("r2_bucket", () => emptyThenDeleteBucket(tenant.r2_bucket_name!), "r2_bucket");
    }
  }

  // RUNPOD IS NEVER TOUCHED HERE, and since cp#270 that holds for two different reasons which are
  // worth separating, because one of them used to be an accident:
  //
  //   DEDICATED: their endpoints are THEIRS, on their account. We never touch it beyond what they
  //     authorized; de-provision shows them a "delete these on RunPod" checklist instead.
  //   SHARED: the endpoints on the row are the PLANE's pool, shared with every other shared
  //     tenant and with production. Deleting one because a tenant left would take the tier down.
  //
  // Before pooling, the safety here rested on the plane holding no credential that COULD delete a
  // RunPod endpoint. That is no longer true -- the plane now holds a pool invoke key -- so the
  // reason has to be stated rather than inherited. It is invoke-only and cannot delete anything,
  // and no RunPod delete call exists anywhere in this function; the log line below records that
  // the pooled case was CONSIDERED, so a later reader adding a reap leg sees it was a decision.
  if (readRunPodMode(tenant.runpod_mode) === "shared") {
    deps.log("teardown.runpod_pool_not_owned", {
      tenant: tenant.id,
      endpoints: readTenantEndpoints(tenant).map((e) => e.id),
      reaped: false,
      reason: "shared pool, owned by the plane and in use by other tenants",
    });
  }

  // The row records what happened, including the clean case. "Teardown ran and reaped everything"
  // and "no teardown has ever run" are different facts and the data has to be able to tell them
  // apart -- that indistinguishability is what forced the cf#103 Tier B refusal.
  await recordTeardownSafely(deps, tenant.id, failures);
  // ok is about FAILURES only. An already-gone resource did not fail, so a pass whose only finding
  // is absence is a clean pass -- which is the whole point of cp#110.
  return { ok: failures.length === 0, failures, absent };
}

/**
 * Persist the teardown outcome without ever letting the bookkeeping erase the result.
 *
 * teardownTenant is best-effort by contract, and a throw from the RECORD would discard the failure
 * list its caller needs -- the exact "one failure strands a live credential" shape the collect-don't-
 * throw design exists to prevent.
 */
async function recordTeardownSafely(
  deps: ProvisionDeps,
  tenantId: string,
  failures: { resource: string; error: string }[],
): Promise<void> {
  try {
    await deps.store.recordTeardown(tenantId, failures);
  } catch (e) {
    deps.log("teardown.record_failed", { tenant: tenantId, resource: "teardown_record", error: String(e) });
  }
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
