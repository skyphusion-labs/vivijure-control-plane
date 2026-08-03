// The control plane's ONE injectable seam (#52).
//
// This is the productionReindexDeps discipline from the studio: production has exactly one wiring
// function, tests replace the whole bundle, and there is no second code path that only tests take.
// A stubbed dep set proves a decision path; it never proves the shipped artifact, which is why
// productionDeps() is what the live wrangler dev verify drives.

import { r2StudioBundleSource } from "./bundle-r2";
import { r2ModuleBundleSource } from "./module-bundle-r2";
import { CfApi } from "./cf-api";
import { aiGatewayLogReader } from "./ai-gateway-logs";
import type { GatewayLogReader } from "./llm-spend-rollup";
import type { LlmSpendStore } from "./llm-spend-ingest";
import type { LlmSpendReadStore } from "./llm-spend-window";
import { LlmSpendD1 } from "./store-d1";
import type { ControlPlaneEnv } from "./env";
import { studioKekRing, tenantModuleProxy } from "./env";
import type { MailSender } from "./email";
import { posternSender } from "./email";
import {
  readTenantApiToken,
  issueTenantApiToken,
  revokeTenantApiToken,
  type ApiTokenState,
  type MintedApiToken,
} from "./tenant-api-token";
import {
  continueProvisionJob,
  preflightModuleUpgrade,
  runProvisionJob,
  teardownTenant,
  upgradeTenantModules,
  type ModuleUpgradeContext,
  type ModuleUpgradePreflight,
  type ProvisionDeps,
  type TeardownOutcome,
} from "./provisioner";
import { convergeTenantTemplateImages, createTenantEndpoints } from "./runpod";
import { parseSharedPool, readRunPodMode } from "./runpod-pool";
import type { SharedRunPodPool } from "./runpod-pool";
import type { ControlPlaneStore, CreditStore, Tenant } from "./store";
import {
  preflightRunPodReprovision,
  reprovisionTenantRunPod,
  type ReprovisionContext,
  type ReprovisionPreflight,
  type ReprovisionResult,
} from "./tenant-runpod-reprovision";
import {
  detachTenantStudioBinding,
  preflightStudioBindingDetach,
  preflightStudioBindings,
  refreshTenantStudioBindings,
  type StudioBindingDetach,
  type StudioBindingDetachRefusal,
  type StudioBindingRefresh,
  type StudioBindingRefusal,
} from "./tenant-studio-bindings";
import {
  applyAbuseReportUrl,
  hostedAbuseReportUrl,
  preflightAbuseReportUrl,
  type AbuseReportUrlRefusal,
  type AbuseReportUrlResult,
} from "./tenant-abuse-report";
import {
  applyStorageQuota,
  preflightStorageQuota,
  tenantStorageQuota,
  type StorageQuotaIntent,
  type StorageQuotaRefusal,
  type StorageQuotaResult,
} from "./tenant-storage-quota";
import {
  preflightStudioUpgrade,
  upgradeTenantStudio,
  type StudioUpgradeContext,
  type StudioUpgradePreflight,
  type StudioUpgradeOutcome,
} from "./tenant-studio-upgrade";
import {
  canonicalStoryboard,
  SMOKE_PROJECT_NAME,
  SMOKE_PROMPT,
  SMOKE_SCENE_SECONDS,
  SMOKE_SHOT_ID,
  type StudioReply,
  type TenantStudioSmokeClient,
} from "./smoke-render";
import { D1Store } from "./store-d1";
import type { KekRing } from "./token-crypto";
import { decryptStudioToken } from "./token-crypto";
import { CfTokenMinter } from "./token-minter";
import {
  applyVideoFinishTierState,
  preflightVideoFinishTierState,
  type VideoFinishTierStateIntent,
  type VideoFinishTierStateRefusal,
  type VideoFinishTierStateResult,
} from "./video-finish-tier-state";
import {
  TENANT_MODULE_CATALOG,
  awaitTenantModulesReady,
  probeTenantModuleReadiness,
  tenantModuleProxyBinding,
  tenantModuleProxyUnboundReason,
  tenantModuleScriptName,
  type ModuleReadiness,
  type TenantModuleObservation,
} from "./tenant-modules";

/** The secret name the studio reads its stored invoke key (key B) from (src/env.ts). */
export const TENANT_RUNPOD_SECRET = "RUNPOD_API_KEY";

/**
 * What the router needs from the provisioner: launch a job, install a verified key. The router
 * never sees CfApi or the namespace; custody of both stays here.
 */
export interface ProvisionerWiring {
  /** Run a provision job to completion or honest failure. Never throws; the job row is the record. */
  start(jobId: string, tenant: Tenant, runpodApiKey: string | null): Promise<void>;
  /**
   * Drive an unfinished job forward one invocation (#112). Called from the POLL route, so it has no
   * key A and can only complete a job that already reached the studio upload; it refuses honestly
   * otherwise. `stepsDone` comes from the job row the caller already read.
   */
  resume(jobId: string, tenant: Tenant, stepsDone: readonly string[]): Promise<void>;
  /**
   * Install the VERIFIED invoke key as the tenant studio secret, and on every tenant module script
   * EXCEPT where those modules are proxied, then PROVE the modules actually serve a credential
   * before the caller flips the tenant live (cf#114). Throws on API failure, and on a readiness
   * probe that fails or times out -- the tenant then stays at awaiting_invoke_key rather than being
   * promoted on credentials nothing has proven.
   *
   * THE EXCEPTION IS THE POINT (cp#288). A proxied module reaches RunPod through the plane on its
   * RUNPOD_PROXY_TOKEN and must hold no RunPod credential at all; an unproxied one (dedicated, BYO,
   * self-host) still needs the key and still gets it. The two cases are decided by the SAME
   * expression that binds the proxy pair, never by a second reading of the tenant's mode.
   *
   * Readiness is unaffected by the exception, and that is measured rather than assumed: a proxied
   * module's /ready reports `credentials.runpod_api_key = Boolean(route.credential)` where the
   * credential IS the proxy token, so it answers true with no RunPod key bound. The field keeps its
   * name deliberately (vivijure-cf modules/_shared/runpod-route.ts).
   */
  installInvokeKey(tenant: Tenant, key: string): Promise<ModuleReadiness>;
  /**
   * Does this plane offer the SHARED tier (cp#270)?
   *
   * A BOOLEAN, not the pool. The only caller is the provision route, which needs to answer one
   * question -- may a tenant provision without bringing a RunPod key -- and handing it the pool
   * would let a route grow its own opinion about which endpoints a tenant gets. The provisioner
   * owns that decision and this is the smallest fact the route needs to stop refusing.
   *
   * True ONLY when both halves resolved (endpoints AND invoke key). A half-configured pool
   * answers false, so the route gives the same honest runpod_key_required a plane with no shared
   * tier gives, rather than accepting a provision it cannot finish.
   */
  offersSharedTier(): boolean;
  /**
   * The plane's CURRENT studio release pin (cp#301).
   *
   * A STRING, not the bundle, and the mirror of offersSharedTier above: the provision route needs
   * exactly one fact -- which release this attempt is being created against -- so it can record it
   * on the job row before any step runs. The provisioner still owns fetching and validating the
   * artifact; this is only the pin's identity.
   *
   * WHY THE ROUTE NEEDS IT AT ALL: a resume driven by a poll reads the pin at POLL time, and the
   * pin moves (STUDIO_RELEASE went v1.13.0 to v1.19.3 in one day on 2026-08-03). Recording it at
   * job creation is what makes "which release is this job building" answerable later, instead of
   * being re-derived from whatever the plane happens to hold.
   */
  currentRelease(): string;
  /**
   * The shared pool's invoke key, or null when this plane offers no shared tier (cp#270).
   *
   * A SECRET crossing this interface, which is unusual here and is justified only by what it
   * avoids: the alternative was a second install path for shared tenants, and the invoke-key
   * install is the one place the custody verification lives. cp#169 already established that the
   * verification must hold by IDENTITY rather than imitation -- one function, two callers. A
   * third caller with its own copy would be the drift that rule exists to prevent, so the key
   * travels to the existing function instead of the function being duplicated for the key.
   *
   * The ONLY legitimate use is to pass it to performInvokeKeyInstall. It must never be logged,
   * returned in a response, or written to D1 -- the same rule every other credential here obeys.
   */
  sharedPoolInvokeKey(): string | null;
  /**
   * Ask every module script this tenant has what it can do RIGHT NOW (cp#248): one unauthenticated
   * GET /ready each, no retry, no spend, no GPU, no tenant credential.
   *
   * Exists because the one fact cf#279 added to /ready -- whether the worker can record a RunPod job
   * -- gates nothing by design, so nothing ever waits for it and no existing route reports it. A
   * field that gates nothing and is reported nowhere cannot be checked, which is the same shape as
   * not having it. This is the looking.
   */
  moduleReadiness(tenant: Tenant): Promise<TenantModuleObservation[]>;
  /**
   * The tenant's PROGRAMMATIC studio token (cf#94). Lives here because this is where the CF client
   * and the dispatch namespace already are, and because the plane deliberately stores no part of
   * the credential -- these calls reach into the TENANT's own database, which only ever holds a hash.
   */
  apiToken: {
    read(tenant: Tenant): Promise<ApiTokenState>;
    issue(tenant: Tenant): Promise<MintedApiToken>;
    revoke(tenant: Tenant): Promise<void>;
  };
  /**
   * Reap the cloud resources a HALF-BUILT tenant left behind, for the reclaim path (cf#103).
   *
   * Never throws: teardownTenant collects every failure and reports them, because a teardown that
   * stops at the first error leaves the most dangerous leftovers behind. The caller decides what a
   * partial failure means -- for reclaim it means DO NOT complete, since the row is the only record
   * of what still needs reaping.
   *
   * Only ever called by the winner of claimReclaim. Teardown is the destructive half and every
   * tenant resource name derives from the SLUG rather than the attempt, so two callers issuing
   * these deletes concurrently would delete each other resources.
   */
  /**
   * Read ONE tenant bucket usage for the admin aggregate (cf#56). READ ONLY, and a narrow capability
   * rather than a CfApi handle on purpose: this interface exposes what the plane can DO, not the
   * client it does it with, so a reads-only surface cannot quietly acquire write reach later.
   */
  r2Usage(bucket: string): Promise<{ payloadBytes: number; objectCount: number }>;
  teardown(tenant: Tenant, opts: { deleteData: boolean }): Promise<TeardownOutcome>;
  /**
   * Check everything a module upgrade needs WITHOUT writing anything (cf#103), so the route can
   * refuse before it creates a job. Split from upgradeModules for exactly that reason: the refusal
   * and the work must not be the same call, or a refusal leaves a job row behind.
   */
  preflightUpgrade(tenant: Tenant, release: string): Promise<ModuleUpgradePreflight>;
  /**
   * Ship the module set to a LIVE tenant at an explicit release. Never throws (the job row is the
   * record) and NEVER writes tenants.status -- the tenant stays live and serving throughout, which
   * is the blast-radius gate on this whole route.
   */
  upgradeModules(jobId: string, tenant: Tenant, context: ModuleUpgradeContext): Promise<void>;
  /**
   * Check everything a STUDIO bytes move needs WITHOUT writing anything (cp#139), so the route can
   * refuse before it creates a job. Same split, same reason, as preflightUpgrade.
   */
  preflightStudioUpgrade(tenant: Tenant, release: string): Promise<StudioUpgradePreflight>;
  /**
   * Move a LIVE tenant's studio bytes onto an explicit release, in place, bindings preserved.
   *
   * Never throws (the job row is the record) and NEVER writes tenants.status: the tenant stays live
   * and serving throughout, which is the blast-radius gate on this route exactly as it is on the
   * module upgrade. Returns the READBACK so the caller records evidence, not a success flag.
   */
  upgradeStudio(jobId: string, tenant: Tenant, context: StudioUpgradeContext): Promise<StudioUpgradeOutcome>;
  /**
   * Deliver a studio-level BINDING to a tenant that already exists (cp#112).
   *
   * Split preflight/work for the same reason as the module upgrade: the refusal must not have
   * written anything. Never changes tenants.status, the studio release, or the studio bytes, so a
   * live tenant keeps serving throughout; the return value is a READBACK through a different
   * credential than the one that wrote, not a success flag.
   */
  refreshStudioBindings(tenant: Tenant): Promise<
    | { ok: false; refusal: StudioBindingRefusal }
    | { ok: true; result: StudioBindingRefresh }
  >;
  /**
   * Check everything a RunPod rebuild needs WITHOUT writing anything (cp#137). Same preflight split
   * as every other route here: the refusal and the work are not the same call.
   */
  preflightReprovisionRunPod(tenant: Tenant): Promise<ReprovisionPreflight>;
  /**
   * Rebuild a tenant's four RunPod endpoints and re-point everything that names them (cp#137).
   *
   * Takes key A as an ARGUMENT and nothing else keeps it: transient by ruling, exactly as the
   * provision path treats it. Throws ReprovisionError on failure, carrying a step and a message that
   * has already been scrubbed of every secret this pass was holding.
   */
  reprovisionRunPod(tenant: Tenant, context: ReprovisionContext, runpodApiKey: string): Promise<ReprovisionResult>;
  /**
   * Declare a tenant unreachable for the video-finish tier, or un-declare it (cp#136).
   *
   * Same split, same reasons, as refreshStudioBindings: the preflight must not have written
   * anything, the tenant keeps serving throughout, and the return is a READBACK through a different
   * credential than the one that wrote. It reads the studio TWICE on purpose -- once before, to
   * refuse when the studio cannot observe the var at all, and once after, so the operator sees the
   * sentence the panel now serves rather than only the binding the plane thinks it set.
   */
  /**
   * Take the video-finish binding OFF a tenant studio (cp#136 criterion 3).
   *
   * The MIRROR of refreshStudioBindings, through the same census-then-inherit machinery, and the
   * reason it exists at all: no other writer in this plane can produce a tier-ABSENT studio, so the
   * state the panel describes could never be displayed on a live tenant. There is deliberately no
   * `reattach` member here -- reattaching IS refreshStudioBindings, and calling that one rather than
   * writing a second implementation is what makes "restores exactly what refresh produces" true by
   * identity instead of by imitation.
   */
  detachStudioBinding(tenant: Tenant): Promise<
    | { ok: false; refusal: StudioBindingDetachRefusal }
    | { ok: true; result: StudioBindingDetach }
  >;
  setVideoFinishTierState(
    tenant: Tenant,
    intent: VideoFinishTierStateIntent,
  ): Promise<
    | { ok: false; refusal: VideoFinishTierStateRefusal }
    | { ok: true; result: VideoFinishTierStateResult }
  >;
  /**
   * Converge an EXISTING tenant studio onto this plane's abuse-report URL (cp#164).
   *
   * The other half of the two-door problem cp#112 and cp#136 both hit: the provision path and the
   * studio upgrade reach new tenants and tenants whose bytes move, and nothing reached the ones
   * already live. Same split and same reasons as refreshStudioBindings -- the preflight writes
   * nothing, the tenant keeps serving throughout, and the return is a READBACK through a different
   * credential than the one that wrote, plus what the STUDIO itself now advertises.
   */
  setAbuseReportUrl(tenant: Tenant): Promise<
    | { ok: false; refusal: AbuseReportUrlRefusal }
    | { ok: true; result: AbuseReportUrlResult }
  >;
  /**
   * Converge an EXISTING tenant studio onto this plane's per-tenant storage ceiling (cp#183).
   *
   * The provision path caps new tenants and the studio upgrade caps tenants whose bytes move;
   * nothing reached the ones already live, which on this plane is all of them. Same preflight split
   * and same reasons as setAbuseReportUrl, plus one this var can afford and that one could not: the
   * preflight PROBES the studio for the core#52 reader first, so a bundle that would silently
   * ignore the ceiling is refused before anything is written rather than diagnosed afterwards.
   */
  setStorageQuota(tenant: Tenant, intent?: StorageQuotaIntent): Promise<
    | { ok: false; refusal: StorageQuotaRefusal }
    | { ok: true; result: StorageQuotaResult }
  >;
  /**
   * The operator verification client (cp#45): four typed calls against THIS tenant's own studio.
   *
   * It lives on ProvisionerWiring because this is where the KEK and the dispatch binding already
   * are, so custody does not spread. It also means the smoke-render route inherits the same honest
   * refusal as every other route here: no provisioner wiring configured, no verification offered
   * (503), rather than a route that looks present and cannot work.
   */
  smokeClient: TenantStudioSmokeClient;
}

export interface ControlPlaneDeps {
  store: ControlPlaneStore;
  mailer: MailSender;
  /** Outbound fetch (SSO token exchange, RunPod probes). Injectable so tests never hit the network. */
  fetch: typeof fetch;
  now(): number;
  /**
   * Absent when the deploy lacks any of the provisioner env (env.ts); the provision and invoke-key
   * routes then refuse with 503 provisioner_unconfigured instead of parking tenants on jobs nothing
   * will ever run. That absence-refusal is deliberate and tested, same rule as the admin gate.
   */
  provisioner?: ProvisionerWiring;
  /**
   * The credit ledger (cp#189). OPTIONAL for the same reason `provisioner` is: a deploy without it is
   * a valid deployment shape, and the money routes refuse with an honest 503 rather than answering
   * from nothing. A balance route that returned zeros on an unwired store would be the worst possible
   * failure here -- an unknown wearing a number's clothes, on the one surface where that decides
   * whether someone can work.
   */
  credits?: CreditStore;
  /**
   * cp#185: the LLM spend meter's READ and WRITE halves of D1. Always present in production (it is
   * the same database this plane already owns), so unlike `credits` its absence is a test shape
   * rather than a deployment shape.
   */
  llmSpend?: LlmSpendStore & LlmSpendReadStore;
  /**
   * cp#185: the live AI Gateway log reader. ABSENT is a real deployment shape -- a plane with no
   * gateway configured, or no read token installed, genuinely cannot meter -- and the ingest route
   * then refuses 503 rather than recording an observation it did not make.
   */
  gatewayLogs?: GatewayLogReader;
}

export function productionDeps(env: ControlPlaneEnv): ControlPlaneDeps {
  const store = new D1Store(env.CP_DB);
  return {
    store,
    mailer: posternSender(env),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    now: () => Date.now(),
    provisioner: provisionerWiring(env, store),
    // The SAME D1Store instance. D1Store implements both interfaces, so production has one object and
    // one connection; the split into two interfaces is about what callers may depend on, not about
    // there being two stores.
    credits: store,
    // The SAME database again, behind its own class: the meter's tables are disjoint from the
    // platform tables and nothing in ControlPlaneStore should be able to reach them by accident.
    llmSpend: new LlmSpendD1(env.CP_DB),
    gatewayLogs: llmMeterReader(env),
  };
}

/**
 * The live gateway reader, or undefined when this deploy cannot honestly meter. Exported so the
 * wiring test takes the SAME construction production takes rather than a re-derivation of it.
 *
 * REFUSES RATHER THAN THROWS on a bad gateway id. aiGatewayLogReader throws when pointed at prism,
 * which is correct at its own boundary, but a throw HERE would take down every unrelated route on
 * the plane (productionDeps runs on every request) over a misconfigured meter. So the refusal is
 * caught, logged loudly and named, and the meter reports itself unconfigured -- which is exactly
 * what it is. Loud and inert beats a plane that will not serve.
 */
export function llmMeterReader(env: ControlPlaneEnv): GatewayLogReader | undefined {
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const gatewayId = env.TENANT_AI_GATEWAY_ID?.trim();
  const token = env.AI_GATEWAY_READ_TOKEN;
  if (!accountId || !gatewayId || !token) return undefined;
  try {
    return aiGatewayLogReader({
      accountId,
      gatewayId,
      token,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    });
  } catch (e) {
    console.error("llm_meter.reader_refused", (e as Error).message);
    return undefined;
  }
}

/**
 * Per-request ceiling on a dispatch to the tenant studio (#112). Small on purpose: every caller runs
 * inside a provision job with a bounded execution budget, so a request that cannot answer quickly is
 * more useful as an honest error than as a wait that outlives the invocation.
 */
const TENANT_STUDIO_FETCH_TIMEOUT_MS = 5_000;

/** Exported for the wiring test: the same construction production takes. */
export function provisionerWiring(env: ControlPlaneEnv, store: ControlPlaneStore): ProvisionerWiring | undefined {
  const {
    CF_PROVISIONER_TOKEN,
    CF_ACCOUNT_ID,
    DISPATCH_NAMESPACE,
    TENANT_MODULE_NAMESPACE,
    STUDIO_RELEASE,
    STUDIO_RELEASES,
    STUDIO_TOKEN_KEK,
  } = env;
  if (
    !CF_PROVISIONER_TOKEN ||
    !CF_ACCOUNT_ID ||
    !DISPATCH_NAMESPACE ||
    !TENANT_MODULE_NAMESPACE ||
    !STUDIO_RELEASE ||
    !STUDIO_RELEASES ||
    !STUDIO_TOKEN_KEK
  ) {
    return undefined;
  }

  const cf = new CfApi(CF_ACCOUNT_ID, CF_PROVISIONER_TOKEN);
  // cf#118: script upload runs on its OWN credential when one is configured, and FALLS BACK to the
  // provisioner otherwise. The fallback is what keeps this a single code path -- a plane without the
  // new credential behaves exactly as it did before the split, rather than gaining a second mode.
  const scriptUploadCf = env.CF_WORKER_UPLOAD_TOKEN
    ? new CfApi(CF_ACCOUNT_ID, env.CF_WORKER_UPLOAD_TOKEN)
    : cf;
  // cp#270: resolve the shared pool ONCE, here, beside every other piece of provisioner config.
  //
  // A REFUSAL RESOLVES TO NULL, and the log line is the whole of the safety story: a malformed or
  // partial SHARED_RUNPOD_ENDPOINTS must never become a partially-wired tenant, so it degrades to
  // "this plane has no shared tier" and the provision route answers runpod_key_required. That is a
  // tenant who cannot provision, which is loud, rather than a tenant provisioned onto three of
  // four capabilities, which is silent. The refusal detail is LOGGED because a plane whose
  // operator believes it offers a shared tier and does not would otherwise have nothing to read.
  //
  // THREE PARTS OR NONE (cp#285). It was two -- endpoints and invoke key -- and the third is the
  // PROXY CONFIG, on the same argument and for a reason Conrad's 2026-08-03 ruling made binding:
  // the hosted tier must hold no RunPod key it could extract. A shared tenant reaches RunPod through
  // the plane proxy or not at all, so a plane that cannot MINT proxy tokens (no CONTROL_PLANE_HOST,
  // or no RUNPOD_PROXY_SIGNING_KEY) cannot serve a shared tenant without handing it the direct key.
  //
  // REFUSING THE TIER IS THE LOUD ANSWER. The route replies runpod_key_required -- a tenant who
  // cannot provision -- rather than provisioning one we would have to violate the ruling to serve.
  //
  // WHAT THIS BUYS, AND ITS LIMIT, STATED RATHER THAN IMPLIED. It makes `shared` imply `proxied`
  // AT PROVISION TIME, which is the moment `runpod_mode` is written. It does NOT hold for the
  // lifetime of a tenant: the row stays `shared` for ever, so an operator who later removes the
  // signing key leaves existing shared tenants whose next key install would find no proxy. That
  // residual is exactly why installInvokeKey keeps its OWN predicate (tenantModuleProxyBinding)
  // rather than trusting the mode -- this narrows the window, the predicate closes it, and neither
  // one makes the other redundant.
  //
  // The key without the endpoints has nothing to invoke; the endpoints without the key produce
  // module workers whose /ready reports the credential unset and whose first render 401s; and
  // either without the proxy produces a tenant we cannot serve within the ruling. No part is a
  // degraded pool.
  const poolConfig = parseSharedPool(env.SHARED_RUNPOD_ENDPOINTS);
  const poolInvokeKey = env.SHARED_RUNPOD_INVOKE_KEY?.trim() || null;
  // Resolved ONCE and reused for the provisioner wiring below, so the config that decides whether
  // this plane offers the shared tier and the config that binds the pair onto a module are the same
  // read. Two reads of one fact is how they drift.
  const moduleProxy = tenantModuleProxy(env);
  // Did anyone ASK for a shared tier? Read from the raw vars rather than from poolConfig.ok,
  // because the case that most needs the log line is the one where the config is set and WRONG:
  // keying the diagnostic off a successful parse would stay silent for exactly that operator.
  const poolRequested = Boolean(env.SHARED_RUNPOD_ENDPOINTS?.trim()) || Boolean(poolInvokeKey);
  let sharedPool: SharedRunPodPool | null = null;
  if (poolRequested) {
    if (!poolConfig.ok) {
      console.error("shared_pool.refused", poolConfig.detail);
    } else if (!poolInvokeKey) {
      console.error("shared_pool.refused", "SHARED_RUNPOD_ENDPOINTS is set but SHARED_RUNPOD_INVOKE_KEY is not");
    } else if (!moduleProxy) {
      // NAMED SEPARATELY from the other two refusals, because the repair is different and an
      // operator who has set both pool vars will otherwise have no idea why the tier is off.
      console.error(
        "shared_pool.refused",
        "the shared pool is configured but this plane cannot mint proxy tokens (CONTROL_PLANE_HOST " +
          "or RUNPOD_PROXY_SIGNING_KEY is unset), and a shared tenant must reach RunPod through the " +
          "proxy rather than holding our key (cp#285)",
      );
    } else {
      sharedPool = poolConfig.pool;
    }
  }

  const deps: ProvisionDeps = {
    store,
    cf,
    scriptUploadCf,
    sharedPool,
    // Null unless the pool is fully configured, so the key can never be bound onto a tenant whose
    // endpoints did not resolve.
    sharedPoolInvokeKey: sharedPool ? poolInvokeKey : null,
    // Trimmed, and empty-means-absent: a whitespace-only value is a config typo, and treating it as
    // a service id would attach a binding CF cannot resolve.
    videoFinishServiceId: env.VIDEO_FINISH_VPC_SERVICE_ID?.trim() || null,
    runpod: {
      createEndpoints: (key, slug, r2) => createTenantEndpoints(key, slug, r2),
      // cp#137: adopt-by-name reuses a template's IMAGE, so a long-lived tenant's templates have to
      // be walked onto the current pins before anything is rebuilt on them.
      convergeTemplateImages: (key, slug) => convergeTenantTemplateImages(key, slug),
    },
    bundle: r2StudioBundleSource(STUDIO_RELEASES),
    // Module bundles ship in the SAME release mirror, per-module subpath (cf#99).
    moduleBundle: r2ModuleBundleSource(STUDIO_RELEASES),
    tokenMinter: new CfTokenMinter(cf),
    r2Endpoint: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    // The teardown bucket-emptying loop is budgeted, so its clock, sleep and fetch are injected
    // (#23 / cf#72) rather than reached for globally. Production takes the real three here; a test
    // replaces the whole bundle, same as every other dep.
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    namespace: DISPATCH_NAMESPACE,
    moduleNamespace: TENANT_MODULE_NAMESPACE,
    release: STUDIO_RELEASE,
    tenantScriptName: (slug) => `tenant-${slug}-studio`,
    // cp#95: the RING, not a key. Provision writes under the configured write slot, and anything
    // this deps bundle decrypts opens under EITHER installed key, so a provision landing mid
    // rotation is neither refused nor written under a key the sweep has already walked past.
    kek: studioKekRing(env),
    // Always set a ceiling: a hosted tenant with no daily cap has no cost bound. Operator-tunable.
    //
    // EMPTY MEANS ABSENT, and that is not pedantry (cp#218). This var is declared in the four
    // deploy lists as ALLOW_EMPTY, so an unset knob arrives as "" rather than undefined, and ??
    // only catches undefined -- every tenant would have been provisioned with SPEND_DAILY_CEILING
    // set to the empty string, which is not a ceiling. Same rule kekRing() and videoFinishServiceId
    // already use.
    spendDailyCeiling: env.TENANT_SPEND_DAILY_CEILING?.trim() || "25",
    // cf#56: the AI Gateway that AI-Gateway-backed tenant modules bind as GATEWAY_ID. NO default:
    // an unset var means this plane names no gateway, and plan-enhance then runs on the free local
    // Workers AI provider. Defaulting to a slug would bind tenants to a gateway nobody chose, and
    // the wrong gateway is worse than none -- skyphusion-llm is prism, not ours to point tenants at.
    aiGatewayId: env.TENANT_AI_GATEWAY_ID ?? null,
    // cp#288: where a tenant module sends its RunPod calls and what signs the credential it
    // presents there. Derived in env.ts (tenantModuleProxy) rather than assembled here, so the
    // rule about when it is null has ONE statement and this wiring cannot drift from it. Reuses the
    // value resolved above, so the shared-tier gate and this binding cannot disagree.
    runpodProxy: moduleProxy,
    // cp#164: the intake page a reporter is sent to, DERIVED from the one host fact this plane
    // holds rather than configured beside it. Hosted-only by construction -- it is computed from
    // control-plane env, and the studio bytes we upload are the published release unmodified.
    abuseReportUrl: hostedAbuseReportUrl(env),
    // cp#183: the per-tenant R2 storage ceiling, CONFIGURED rather than derived (it prices what we
    // are willing to carry, which no code here knows) and validated once here so no write path
    // re-parses it. Unset = no ceiling, with NO default: an invented number would be a pricing
    // decision smuggled in as a fallback, and wrong for any other operator running this plane.
    storageQuota: tenantStorageQuota(env),
    // NOTE the shape: this is the plane DEFAULT, not the answer. cp#173 gives us two tenant classes
    // (BYOK/self-host capped by a refusal threshold, prepaid bounded by a credit balance instead),
    // so every writer resolves plane-default-plus-tenant-record through resolveStorageQuota rather
    // than reading this field directly.
    // Prove SERVING at verify: dispatch straight to the tenant worker (bypassing the control-plane
    // status gate, which 503s a still-provisioning tenant) and report the status. A Bearer is
    // attached so an auth-gated root also answers; the static root needs none once ASSETS is bound.
    callTenantStudio: async (scriptName, init) => {
      const stub = env.TENANT_DISPATCH.get(scriptName);
      const headers: Record<string, string> = { authorization: `Bearer ${init.studioApiToken}` };
      if (init.body !== undefined) headers["content-type"] = "application/json";
      // EVERY dispatch to the tenant studio is time-bounded (#112). A hung studio fetch would
      // otherwise block the provision job until the invocation is evicted, which strands the tenant
      // at "provisioning" with no error rather than failing honestly. This is a defect in its own
      // right: bounding a retry loop does nothing if one request inside it can hang forever.
      const res = await stub.fetch(
        new Request(`https://tenant.internal${init.path}`, {
          method: init.method,
          headers,
          body: init.body,
          signal: AbortSignal.timeout(TENANT_STUDIO_FETCH_TIMEOUT_MS),
        }),
      );
      return { status: res.status, text: await res.text() };
    },
    // cf#114: reach ONE tenant module script over its own dispatch namespace. No bearer -- /ready is
    // unauthenticated by design. Time-bounded like every other dispatch (#112): a hung module must
    // not hold the invoke-key route open. An unbound namespace answers 404, which the probe reads as
    // "cannot verify" and reports, rather than as a false pass.
    callTenantModule: async (scriptName, path) => {
      if (!env.TENANT_MODULE_DISPATCH) return { status: 404, text: "TENANT_MODULE_DISPATCH not bound" };
      const stub = env.TENANT_MODULE_DISPATCH.get(scriptName);
      const res = await stub.fetch(
        new Request(`https://module.internal${path}`, {
          signal: AbortSignal.timeout(TENANT_STUDIO_FETCH_TIMEOUT_MS),
        }),
      );
      return { status: res.status, text: await res.text() };
    },
    // Structured, greppable, and NEVER carries a secret (provisioner discipline).
    log: (event, fields) => console.log("provision", { event, ...fields }),
  };

  // 256 bits of token. The VALUE exists here and in the HTTP response exactly once and is stored
  // nowhere: the tenant's studio DB keeps only its SHA-256 hash.
  const apiTokenDeps = {
    cf,
    store,
    namespace: DISPATCH_NAMESPACE,
    randomToken: () => {
      const raw = new Uint8Array(32);
      crypto.getRandomValues(raw);
      return [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
    },
    sha256Hex: async (s: string) => {
      const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    },
  };

  return {
    r2Usage: (bucket: string) => cf.getR2BucketUsage(bucket),
    apiToken: {
      read: (tenant) => readTenantApiToken(apiTokenDeps, tenant),
      issue: (tenant) => issueTenantApiToken(apiTokenDeps, tenant),
      revoke: (tenant) => revokeTenantApiToken(apiTokenDeps, tenant),
    },
    smokeClient: tenantStudioSmokeClient(env, studioKekRing(env)),
    async refreshStudioBindings(tenant) {
      // Preflight FIRST and separately: a refusal must leave the tenant untouched, and this route
      // has no job row to record one on.
      const pre = preflightStudioBindings(deps, tenant);
      if (!pre.ok) return { ok: false, refusal: pre.refusal };
      return { ok: true, result: await refreshTenantStudioBindings(deps, tenant, pre.script, pre.serviceId) };
    },
    async preflightReprovisionRunPod(tenant): Promise<ReprovisionPreflight> {
      return await preflightRunPodReprovision(deps, tenant);
    },
    async reprovisionRunPod(tenant, context, runpodApiKey): Promise<ReprovisionResult> {
      return await reprovisionTenantRunPod(deps, tenant, context, runpodApiKey);
    },
    async detachStudioBinding(tenant) {
      const pre = preflightStudioBindingDetach(tenant);
      if (!pre.ok) return { ok: false, refusal: pre.refusal };
      return { ok: true, result: await detachTenantStudioBinding(deps, tenant, pre.script) };
    },
    async setStorageQuota(tenant, intent) {
      // Preflight FIRST and separately, exactly as the routes beside it: a refusal must leave the
      // tenant untouched, and this one carries the reader-floor probe, so the refusal that matters
      // most here happens before any binding is patched.
      const pre = await preflightStorageQuota(deps, tenant, intent);
      if (!pre.ok) return { ok: false, refusal: pre.refusal };
      return { ok: true, result: await applyStorageQuota(deps, tenant, pre.context) };
    },
    async setAbuseReportUrl(tenant) {
      // Preflight FIRST and separately: a refusal must leave the tenant untouched, and this route
      // has no job row to record one on. It also establishes what the studio advertised BEFORE, so
      // the result carries both sides of the change rather than only our own write.
      const pre = await preflightAbuseReportUrl(deps, tenant);
      if (!pre.ok) return { ok: false, refusal: pre.refusal };
      return { ok: true, result: await applyAbuseReportUrl(deps, tenant, pre.context) };
    },
    async setVideoFinishTierState(tenant, intent) {
      // Preflight FIRST and separately, for the same reason as above, plus one specific to this
      // route: the refusal it exists for (a studio that cannot read the var) must happen before the
      // record is written, or the plane would remember a declaration it failed to deliver.
      const pre = await preflightVideoFinishTierState(deps, tenant, intent);
      if (!pre.ok) return { ok: false, refusal: pre.refusal };
      return { ok: true, result: await applyVideoFinishTierState(deps, tenant, pre.context, intent) };
    },
    async start(jobId, tenant, runpodApiKey) {
      // runProvisionJob records every outcome on the job row; the return value is the same fact.
      // A "yielded" outcome is normal under #112: progress is persisted and the next poll resumes.
      await runProvisionJob(deps, jobId, tenant, runpodApiKey);
    },
    async resume(jobId, tenant, stepsDone) {
      await continueProvisionJob(deps, jobId, tenant, stepsDone);
    },
    offersSharedTier(): boolean {
      return sharedPool !== null;
    },
    currentRelease(): string {
      // deps.release, not the env var re-read: one source, so the pin a job records and the pin the
      // provisioner would fetch cannot be two different reads of the same config.
      return deps.release;
    },
    sharedPoolInvokeKey(): string | null {
      return deps.sharedPoolInvokeKey;
    },
    async installInvokeKey(tenant, key): Promise<ModuleReadiness> {
      if (!tenant.script_name) throw new Error("tenant has no studio worker to install the key on");
      // Key B lands on the studio (cf#99): the studio reads its own RUNPOD_API_KEY. Rotates in
      // place (putScriptSecret, no re-upload).
      //
      // THE STUDIO COPY IS STILL INSTALLED ON EVERY TIER, INCLUDING SHARED, AND THAT IS A KNOWN
      // GAP RATHER THAN THE INTENDED END STATE (cp#288, Conrad 2026-08-03: the hosted tier must
      // hold no RunPod key it could extract, in any fashion). The studio genuinely SUBMITS RunPod
      // work -- cast LoRA training, vivijure-core runpod-submit submitTrainLoraJob, reached from
      // vivijure-cf src/index.ts via handleCastTrainLora -- and vivijure-core has no proxy branch
      // at all, so removing this copy before core learns the proxy would break that path rather
      // than close the hole. Closing it is a core release, then a cf release, then a plane change;
      // it is tracked separately. Retiring the FIFTEEN module copies below does not depend on it.
      await cf.putScriptSecret(DISPATCH_NAMESPACE, tenant.script_name, TENANT_RUNPOD_SECRET, key);
      // THE SAME EXPRESSION uploadTenantModules used to decide whether to bind the proxy pair. Not
      // a second reading of the mode: see tenantModuleProxyBinding for why two expressions here can
      // only disagree into the one state that breaks every render (neither pair nor key).
      //
      // A PROXIED MODULE MUST NOT RECEIVE THIS KEY. It reaches RunPod through the plane on its
      // RUNPOD_PROXY_TOKEN, so the direct key is dead weight AND a live invariant violation -- a
      // consumer holding a RunPod credential on our account. An UNPROXIED module still needs it:
      // that is dedicated, BYO and the self-host door, which is the permanently supported unbound
      // branch of vivijure-cf modules/_shared/runpod-route.ts and must never lose the key.
      const moduleProxy = await tenantModuleProxyBinding(
        readRunPodMode(tenant.runpod_mode),
        deps.runpodProxy,
        tenant.id,
      );
      if (moduleProxy) {
        // Deliberately LOUD and deliberately not silent-by-omission: absence is the mechanism on
        // this path, so a reader has to be able to tell "retired on purpose" from "the install
        // loop never ran". Counted from the catalog, never from a remembered number.
        deps.log("modules_invoke_key_retired", {
          tenant: tenant.id,
          modules: TENANT_MODULE_CATALOG.length,
          reason: "proxied",
        });
      } else {
        deps.log("modules_invoke_key_installed", {
          tenant: tenant.id,
          modules: TENANT_MODULE_CATALOG.length,
          reason: tenantModuleProxyUnboundReason(readRunPodMode(tenant.runpod_mode), deps.runpodProxy, moduleProxy),
        });
        for (const spec of TENANT_MODULE_CATALOG) {
          await cf.putScriptSecret(
            TENANT_MODULE_NAMESPACE,
            tenantModuleScriptName(tenant.id, spec.module),
            TENANT_RUNPOD_SECRET,
            key,
          );
        }
      }
      // cf#114: the secrets PUT returning 200 does NOT mean the edge serves the key yet. Prove it on
      // the modules before the caller promotes the tenant, or fail honestly saying we could not.
      return await awaitTenantModulesReady(deps, tenant.id);
    },
    async moduleReadiness(tenant): Promise<TenantModuleObservation[]> {
      return await probeTenantModuleReadiness(deps, tenant.id);
    },
    async teardown(tenant, opts) {
      return await teardownTenant(deps, tenant, opts);
    },
    async preflightUpgrade(tenant, release): Promise<ModuleUpgradePreflight> {
      return await preflightModuleUpgrade(deps, tenant, release);
    },
    async upgradeModules(jobId, tenant, context) {
      await upgradeTenantModules(deps, jobId, tenant, context);
    },
    async preflightStudioUpgrade(tenant, release): Promise<StudioUpgradePreflight> {
      return await preflightStudioUpgrade(deps, tenant, release);
    },
    async upgradeStudio(jobId, tenant, context): Promise<StudioUpgradeOutcome> {
      return await upgradeTenantStudio(deps, jobId, tenant, context);
    },
  };
}

/**
 * Per-call ceilings for the operator smoke render (cp#45). Deliberately NOT the 5s provision
 * ceiling: these run in an operator-initiated request rather than inside a provision job's step
 * budget, and the bundle leg does real work (tar assembly) in the studio. Still bounded, for the
 * same reason everything else here is -- a hung studio must fail honestly, not hold the route open.
 */
const SMOKE_BUNDLE_TIMEOUT_MS = 25_000;
const SMOKE_SUBMIT_TIMEOUT_MS = 15_000;
const SMOKE_POLL_TIMEOUT_MS = 10_000;
const SMOKE_ARTIFACT_TIMEOUT_MS = 25_000;

/**
 * The tenant-studio client the operator verification route drives (cp#45).
 *
 * CUSTODY IS THE WHOLE POINT. The tenant token is decrypted HERE, per call, used on the dispatch
 * stub, and dropped. It is never returned, never logged, never placed on a response, and never
 * crosses the TenantStudioSmokeClient interface. An operator drives this route and receives an
 * artifact; there is no code path by which they receive a credential.
 *
 * Every path below is a CONSTANT. The client takes no caller-supplied path or body, so it cannot be
 * turned into a general operator proxy into customer studios.
 */
export function tenantStudioSmokeClient(env: ControlPlaneEnv, kek: KekRing): TenantStudioSmokeClient {
  const dispatch = async (
    tenant: Tenant,
    init: { method: string; path: string; body?: string; timeoutMs: number; accept?: string },
  ): Promise<Response> => {
    if (!tenant.script_name) throw new Error("tenant has no studio script to dispatch to");
    if (!tenant.studio_token_enc) throw new Error("tenant has no stored studio token");
    const token = await decryptStudioToken(kek, tenant.studio_token_enc);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.accept) headers["accept"] = init.accept;
    const stub = env.TENANT_DISPATCH.get(tenant.script_name);
    return await stub.fetch(
      new Request(`https://tenant.internal${init.path}`, {
        method: init.method,
        headers,
        body: init.body,
        signal: AbortSignal.timeout(init.timeoutMs),
      }),
    );
  };

  const asReply = async (res: Response): Promise<StudioReply> => ({ status: res.status, text: await res.text() });

  return {
    async putCanonicalBundle(tenant) {
      const res = await dispatch(tenant, {
        method: "POST",
        path: "/api/storyboard/bundle",
        // characterRefs is REQUIRED by the route and legitimately empty: the canonical smoke render
        // has no cast, which is also why it is the cheapest thing that still renders.
        body: JSON.stringify({ storyboard: canonicalStoryboard(), characterRefs: {} }),
        timeoutMs: SMOKE_BUNDLE_TIMEOUT_MS,
      });
      return await asReply(res);
    },
    async submitKeyframeRender(tenant, bundleKey) {
      const res = await dispatch(tenant, {
        method: "POST",
        path: "/api/storyboard/render",
        // keyframesOnly is what keeps this cheap AND what removes the motion_backend requirement:
        // the studio skips motion, finish, assemble and mux entirely. One shot, one keyframe.
        body: JSON.stringify({
          bundleKey,
          keyframesOnly: true,
          project: SMOKE_PROJECT_NAME,
          scenes: [{ shot_id: SMOKE_SHOT_ID, prompt: SMOKE_PROMPT, seconds: SMOKE_SCENE_SECONDS }],
        }),
        timeoutMs: SMOKE_SUBMIT_TIMEOUT_MS,
      });
      return await asReply(res);
    },
    async pollRender(tenant, studioJobId) {
      const res = await dispatch(tenant, {
        method: "GET",
        path: `/api/storyboard/render/${encodeURIComponent(studioJobId)}`,
        timeoutMs: SMOKE_POLL_TIMEOUT_MS,
      });
      return await asReply(res);
    },
    async fetchArtifact(tenant, key) {
      // The studio serves artifact bytes under a prefix allowlist; the key comes from ITS OWN poll
      // response, so it is never operator-supplied. Encoded per segment: the key contains slashes
      // that are path structure, not data.
      const path = `/api/artifact/${key.split("/").map(encodeURIComponent).join("/")}`;
      const res = await dispatch(tenant, { method: "GET", path, timeoutMs: SMOKE_ARTIFACT_TIMEOUT_MS });
      if (res.status !== 200) {
        return { status: res.status, bytes: null, contentType: res.headers.get("content-type") ?? "" };
      }
      return {
        status: 200,
        bytes: await res.arrayBuffer(),
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
      };
    },
  };
}
