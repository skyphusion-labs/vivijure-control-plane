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
import { CfApiError } from "./cf-api";
import { applyStudioMigrations, type StudioMigration } from "./migrate";
import { randomToken } from "./crypto";
import type { TenantR2Creds } from "./runpod";
import type { ControlPlaneStore, Tenant } from "./store";
import { decryptStudioToken, encryptStudioToken } from "./token-crypto";
import { REQUIRED_TENANT_STUDIO_VARS, assertDispositionCoversContract } from "./tenant-studio-env";
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
  namespace: string;
  /** The shared dispatch namespace tenant MODULE scripts live in (vivijure-tenant-modules). */
  moduleNamespace: string;
  release: string;
  tenantScriptName(slug: string): string;
  /** Base64 KEK for encrypting the tenant STUDIO_API_TOKEN value at rest (token-crypto.ts). */
  kek: string;
  /** Optional per-tenant daily spend ceiling set as SPEND_DAILY_CEILING; null -> studio default. */
  spendDailyCeiling: string | null;
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
 * Run a provision job to completion or to an honest failure.
 *
 * runpodApiKey is key A: transient, used once, never stored. Pass null to resume the CF-side steps
 * only; the run then stops honestly at runpod_endpoints rather than pretending.
 */
export async function runProvisionJob(
  deps: ProvisionDeps,
  jobId: string,
  tenant: Tenant,
  runpodApiKey: string | null,
  clock: ProvisionClock = realClock,
  budgetMs: number = PROVISION_INVOCATION_BUDGET_MS,
): Promise<ProvisionOutcome> {
  const startedAt = clock.now();
  const done: MarkableProvisionStep[] = [];

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
    done.push(step);
    await deps.store.updateJobProgress(jobId, step, JSON.stringify(done));
    // ONE clock read, reused for both the timing and the budget check. Reading the clock twice
    // would be the obvious way to write this and it would be wrong: the tests drive a hand-rolled
    // clock that ADVANCES ON EVERY READ, so a second read would change when a yield fires. That is
    // perturbing the instrument the measurement is about (cp#18), not a style preference.
    const at = clock.now();
    deps.log("provision.step", { tenant: tenant.id, job: jobId, phase: "provision", ...timeStep(step, at) });
    if (!YIELD_UNSAFE_STEPS.has(step) && at - startedAt >= budgetMs) throw new ProvisionYield(step);
  };

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
      built = await deps.bundle.fetch(deps.release);
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

    // 1. D1. Adopt-on-exists makes a re-run safe.
    const db = await deps.cf.createD1(tenantD1Name(tenant.slug));
    await deps.store.setTenantD1(tenant.id, db.uuid);
    await mark("d1_create");

    // 2. Migrations: the SAME migration files the studio ships, applied only where missing and
    //    recorded per-migration in the schema_migrations table of the tenant D1 (#105). This step
    //    MUST tolerate an adopted, already-migrated D1: the previous unconditional replay assumed
    //    the files were all CREATE TABLE IF NOT EXISTS, and died on the first ALTER TABLE.
    const migrated = await applyStudioMigrations(deps.cf, db.uuid, built.migrations);
    deps.log("d1.migrate", {
      tenant: tenant.id,
      applied: migrated.applied,
      seeded: migrated.seeded,
    });
    await mark("d1_migrate");

    // 3. Bucket per tenant (not a prefix): satellite-visible R2 creds must reach ONLY this tenant.
    const bucket = tenantBucketName(tenant.slug);
    await deps.cf.createR2Bucket(bucket);
    await deps.store.setTenantBucket(tenant.id, bucket);
    await mark("r2_bucket");

    // 4. Bucket-scoped creds. Re-minted on every run: we never stored the value, so there is
    //    nothing to reuse. The previous token is revoked first so a retry does not leave a trail of
    //    live grants behind it.
    const previousTokenId = tenant.r2_token_id;
    if (previousTokenId) {
      try {
        await deps.tokenMinter.revoke(previousTokenId);
      } catch (e) {
        // A stale token that will not revoke must not strand the tenant, but it MUST be visible:
        // it is a live credential we failed to clean up.
        deps.log("r2_token.revoke_failed", { tenant: tenant.id, error: String(e) });
      }
    }
    const token = await deps.tokenMinter.mintBucketToken(tenantR2TokenName(tenant.slug), bucket);
    // Persist the id IMMEDIATELY (cf#91 / #93): if we die between mint and the next await, teardown
    // can still revoke by id. Hashing the secret value is pure CPU and can wait.
    await deps.store.setTenantR2Token(tenant.id, token.id);
    // R2 S3 semantics: access key id = token id, secret = SHA-256 hex of the token value. Derived
    // ONCE here and used for both the satellite templates and the worker secret, so they cannot
    // disagree.
    const s3Secret = await sha256Hex(token.value);
    await mark("r2_token");

    // 5. RunPod (#54). The ONLY step that needs key A, which is why it is a parameter and why its
    //    absence is an honest stop rather than a skip.
    if (!runpodApiKey) {
      return { ok: false, step: "runpod_endpoints", message: "runpod_key_required" };
    }
    const endpoints = await deps.runpod.createEndpoints(runpodApiKey, tenant.slug, {
      endpoint: deps.r2Endpoint,
      accessKeyId: token.id,
      secretAccessKey: s3Secret,
      bucket,
    });
    await deps.store.setTenantEndpoints(tenant.id, JSON.stringify(endpoints));
    await mark("runpod_endpoints");

    // 6. Upload the PUBLISHED studio release, unmodified. No hosted fork exists to drift.
    //    Already fetched at step 0; reused here rather than re-read, so the worker we upload and the
    //    schema we applied are provably the same artifact and not two reads that could differ.
    let assetsJwt: string | undefined;
    if (built.assets?.length) assetsJwt = await uploadAssets(deps, tenant.slug, built.assets);

    // The tenant's studio API token. Minted here, set as the tenant-studio secret (satisfying its
    // AUTH_MODE=token fail-closed gate), and ALSO persisted control-plane-side (encrypted) because
    // the dispatcher injects it for the owner's browser (auth ruling 2026-07-18). It is the one
    // credential stored as a VALUE; token-crypto encrypts it under STUDIO_TOKEN_KEK before D1.
    const studioApiToken = randomToken();

    // Each created endpoint carries the studio env var its id belongs in (spec.endpointVar); the
    // studio cannot dispatch a render without these. The mapping is DATA from the provision plan, so
    // adding a service is a plan entry, not an edit here.
    const endpointBindings = endpoints.map((e) => ({ type: "plain_text" as const, name: e.endpointVar, text: e.id }));

    await deps.cf.uploadUserWorker({
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
        { type: "d1", name: "DB", id: db.uuid },
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
      ],
    });
    await deps.store.setTenantScript(tenant.id, deps.tenantScriptName(tenant.slug), deps.release);
    // Persist the token VALUE, encrypted, so the dispatcher can inject it. Never plaintext at rest.
    await deps.store.setTenantStudioToken(tenant.id, await encryptStudioToken(deps.kek, studioApiToken));
    await mark("wfp_upload");

    // 7. Upload the tenant MODULE scripts (cf#99) into the shared modules namespace, each carrying
    //    its endpoint id. Key B is NOT bound yet -- it lands in installInvokeKey, alongside the
    //    studio. The studio (with its MODULE_DISPATCH binding) is already up, so the install pass
    //    below can reach these. Idempotent-by-name (adopt-on-exists), like every other step.
    await uploadTenantModules(deps, tenant.id, endpoints);
    await mark("modules_upload");

    // 8. Install each module through the studio's OWN conformance-gated route (cf#99): the studio
    //    runs the live suite against the resident script via its now-bound MODULE_DISPATCH and
    //    seeds installed_modules in the tenant D1. No install logic is duplicated here.
    await installTenantModules(deps, tenant.id, deps.tenantScriptName(tenant.slug), studioApiToken);
    await mark("modules_install");

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
      deps.log("provision.yielded", { tenant: tenant.id, after: e.after, elapsedMs: clock.now() - startedAt });
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
  const done: ProvisionStep[] = PROVISION_STEPS.filter((s) => stepsDone.includes(s));
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
  const complete = (step: ProvisionStep) => done.includes(step);

  try {
    // The resumability boundary, checked rather than assumed.
    if (!complete("wfp_upload")) {
      throw new ProvisionFailure(
        inferStep(done),
        "provisioning was interrupted before the studio was uploaded, and the RunPod key needed to " +
          "finish it is never stored; start provisioning again to continue",
      );
    }
    const endpoints = readTenantEndpoints(tenant);
    if (!endpoints.length) {
      throw new ProvisionFailure("runpod_endpoints", "no endpoints recorded for this tenant; re-provision to continue");
    }
    if (!tenant.studio_token_enc) {
      throw new ProvisionFailure("wfp_upload", "no studio token recorded for this tenant; re-provision to continue");
    }
    const studioApiToken = await decryptStudioToken(deps.kek, tenant.studio_token_enc);
    const script = deps.tenantScriptName(tenant.slug);

    await runModuleSteps(
      deps,
      { tenantId: tenant.id, script, endpoints, studioApiToken, release: deps.release },
      // Resume semantics: skip what the progress record says is already done. The UPGRADE caller
      // passes the opposite (always run), which is the entire behavioural difference between the
      // two and the reason this is a parameter rather than a hardcoded rule.
      { shouldRun: (step) => !complete(step), onDone: mark },
    );

    await deps.store.setTenantStatus(tenant.id, "awaiting_invoke_key");
    await deps.store.finishJob(jobId, "succeeded", null, null);
    deps.log("provision.resumed_to_completion", { tenant: tenant.id });
    return { ok: true, status: "awaiting_invoke_key" };
  } catch (e) {
    if (e instanceof ProvisionYield) {
      deps.log("provision.yielded", { tenant: tenant.id, after: e.after, elapsedMs: clock.now() - startedAt, resumed: true });
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
  script: string;
  endpoints: TenantEndpoint[];
  studioApiToken: string;
  release: string;
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
    await uploadTenantModules(at, tenantId, endpoints, args.prefetched);
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
  const missing = TENANT_MODULE_CATALOG.filter((spec) => !endpoints.some((e) => e.key === spec.endpointKey));
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
    bundles = await prefetchModuleBundles({ ...deps, release }, release);
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
 * assumed from the conformance gate: the five catalog modules serve four hooks -- keyframe
 * (`keyframe`), own-gpu (`motion.backend`), speech-upscale (`speech`), and finish-upscale +
 * finish-lipsync (both `finish`). Modules on DIFFERENT hooks never see each other output, so those
 * three are mutually independent and a mixed state across them is not expressible. The one coupled
 * pair is the two `finish` modules, which CHAIN: each takes FinishInput{shot_id, clip_key} and
 * returns FinishOutput{clip_key}, so the second consumes the output key of the first. A mixed
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
        script: context.script,
        endpoints: context.endpoints,
        studioApiToken: context.studioApiToken,
        release: context.release,
        prefetched: context.bundles,
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
  }
}

const inferStep = (done: ProvisionStep[]): ProvisionStep =>
  PROVISION_STEPS[Math.min(done.length, PROVISION_STEPS.length - 1)];

async function uploadAssets(
  deps: ProvisionDeps,
  slug: string,
  assets: NonNullable<Awaited<ReturnType<StudioBundleSource["fetch"]>>["assets"]>,
): Promise<string | undefined> {
  const script = deps.tenantScriptName(slug);
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const a of assets) manifest[a.path] = { hash: a.hash, size: a.size };

  const session = await deps.cf.createAssetsUploadSession(deps.namespace, script, manifest);
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
    const res = await deps.cf.uploadAssetBucket(session.jwt ?? "", files);
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
export async function teardownTenant(
  deps: ProvisionDeps,
  tenant: Tenant,
  opts: { deleteData: boolean },
): Promise<{ ok: boolean; failures: { resource: string; error: string }[] }> {
  const failures: { resource: string; error: string }[] = [];
  const attempt = async (resource: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      failures.push({ resource, error: String(e) });
      deps.log("teardown.failed", { tenant: tenant.id, resource, error: String(e) });
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
  await attempt("worker", () => deps.cf.deleteUserWorker(deps.namespace, scriptToDelete));
  // Module scripts next (cf#99): the studio (discovery) is already gone, so sweeping the tenant's
  // module scripts cannot tear a /poll out from under a live studio. Prefix sweep + census; every
  // failure is surfaced (a live-configured module worker is exactly what must not be left behind).
  const moduleTeardown = await teardownTenantModules(deps, tenant.id);
  for (const f of moduleTeardown.failures) failures.push(f);

  // Credential BEFORE bucket/D1 (cf#91): kill the live grant, then the resources it points at.
  // Prefer the persisted id; always attempt by-name as well when id is missing OR revoke-by-id
  // failed (the unpersisted-id class and the "id on a row we are about to blank" class).
  const tokenName = tenantR2TokenName(tenant.slug);
  let revokedById = false;
  if (tenant.r2_token_id) {
    try {
      await deps.tokenMinter.revoke(tenant.r2_token_id);
      revokedById = true;
    } catch (e) {
      failures.push({ resource: "r2_token", error: String(e) });
      deps.log("teardown.failed", { tenant: tenant.id, resource: "r2_token", error: String(e) });
    }
  }
  if (!revokedById) {
    await attempt("r2_token_by_name", async () => {
      const hit = await deps.tokenMinter.revokeByName(tokenName);
      if (!hit && !tenant.r2_token_id) {
        // Nothing to revoke: either never minted, or already gone. Not a failure.
        deps.log("teardown.r2_token_absent", { tenant: tenant.id, name: tokenName });
      }
    });
  }

  if (opts.deleteData) {
    if (tenant.d1_database_id) await attempt("d1", () => deps.cf.deleteD1(tenant.d1_database_id!));
    // KNOWN, LIVE-PROVEN CONSTRAINT: R2 refuses to delete a NON-EMPTY bucket, and R2's REST API has
    // no object-list/delete endpoint at all (404) -- emptying a bucket only goes through the S3 API.
    // So this call SUCCEEDS only for a tenant that never rendered, and for everyone else it fails
    // with CF's own "bucket is not empty". That failure is REPORTED, never swallowed: the caller
    // gets it in `failures` and the tenant's data is still there, which is the safe direction to
    // fail. Emptying-then-deleting needs an S3 client here (mint a bucket cred, ListObjectsV2 +
    // DeleteObjects, delete, revoke) and is tracked as #53 follow-up rather than faked.
    // Caught on real R2; the unit fake said delete always works.
    if (tenant.r2_bucket_name) await attempt("r2_bucket", () => deps.cf.deleteR2Bucket(tenant.r2_bucket_name!));
  }

  // Their RunPod endpoints are THEIRS. We never touch the tenant's RunPod account beyond what they
  // authorized; de-provision shows them a "delete these on RunPod" checklist instead.
  return { ok: failures.length === 0, failures };
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
