// Tenant render-module provisioning: the studio-to-endpoint bridge the hosted spec missed (cf#99).
//
// A fully-provisioned tenant (live, serving, authenticated, spend-limited, 4 GPU endpoints) still has
// ZERO render modules until this runs: discoverModules reads installed_modules + MODULE_DISPATCH, and
// the endpoint-id vars #93 sets are read by MODULE WORKERS the provisioner never created. This module
// creates them, per tenant, THE SAME WAY self-host does -- which is the whole parity story:
//
//   1. Upload tenant-configured copies of the module workers into ONE shared dispatch namespace
//      (vivijure-tenant-modules), script names TENANT-ID-prefixed so tenants never collide and a
//      teardown is a prefix sweep. Each copy carries only THAT tenant's endpoint id (here) + key B
//      (installed later, in installInvokeKey) -- custody is bounded per-script by its own secret.
//   2. The tenant studio gets a MODULE_DISPATCH binding -> vivijure-tenant-modules in its WfP upload
//      metadata (live-proven a WfP user worker CAN carry a dispatch_namespace binding; cf#99 step 1).
//      The studio BYTES are unchanged -- the binding is upload metadata, not code -- so parity holds.
//   3. Install each module through the studio's OWN POST /api/modules/install route (driven over the
//      TENANT_DISPATCH seam): the studio runs the REAL conformance gate against the resident script
//      through its MODULE_DISPATCH and seeds installed_modules in the tenant D1. No install logic is
//      duplicated here; the tenant studio is byte-identical to a self-hoster's.
//
// KEY-B ORDERING, load-bearing: modules are uploaded + installed DURING provisioning, before key B
// exists. That is safe because module conformance is envelope+degrade only (async GPU modules return
// pending/degrade; the gate never triggers real GPU work), and every module answers the conformance
// probe with a well-formed { ok:false } envelope BEFORE it ever reads a RunPod credential. Key B lands
// on the module scripts in installInvokeKey, alongside the studio -- the module can then render.

import type { CfApi, WorkerBinding } from "./cf-api";
import { classifyVpcBindingFailure, isScriptAbsent } from "./cf-api";
import {
  MODULE_PROXY_BASE_BINDING,
  MODULE_PROXY_TOKEN_BINDING,
  mintTenantProxyToken,
} from "./runpod-proxy-auth";
import type { TenantEndpoint } from "./provisioner";
import { vpcBackedPlan } from "./runpod";
import type { ResolvedDoor } from "./runpod";
import type { RunPodMode } from "./runpod-pool";

/**
 * A pre-built module worker bundle, fetched by name from the pinned release. Same seam as
 * StudioBundleSource and for the same reason: the control plane is a Worker and cannot bundle at
 * provision time, so a module worker arrives as a published, integrity-checked artifact. Modules ship
 * no static assets (pure workers), so this carries only the module + its compat config, verbatim.
 */
export interface ModuleBundle {
  mainModule: string;
  moduleText: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
}

export interface ModuleBundleSource {
  /** The published module bundle for `moduleName` at `release`, unmodified (parity depends on it). */
  fetch(release: string, moduleName: string): Promise<ModuleBundle>;
}

/**
 * One catalog entry: a module worker and which of the tenant's endpoints (by TenantEndpoint.key) its
 * RUNPOD_ENDPOINT_ID points at. This is DATA, not logic -- adding a capability is a row here, the same
 * discipline as runpod.ts's endpoint specs and the bare-skeleton doctrine (nothing module-specific is
 * hardcoded in the provision flow). `module` is the bundle name in the release AND the module's
 * manifest name; the resident script name is tenant-prefixed (tenantModuleScriptName).
 */
export interface TenantModuleSpec {
  module: string;
  /**
   * Which tenant endpoint this module renders against, or OMITTED for a module that is not
   * RunPod-backed at all (cf#56).
   *
   * Optional because plan-enhance broke the assumption every earlier entry shared. It is an LLM
   * pass reached through the AI Gateway, so there is no endpoint to point it at, and the honest
   * encoding is an absent key rather than a sentinel endpoint that exists only to satisfy a type.
   * uploadTenantModules therefore requires an endpoint ONLY for the specs that declare one; a spec
   * that declares an endpointKey the tenant lacks still fails loudly, which is the check that
   * mattered originally and is unchanged.
   */
  endpointKey?: string;
  /**
   * Bind the AI Gateway trio (AI + GATEWAY_ID + per-tenant CF_AIG_TOKEN) onto this module (cf#56).
   * Data, not a name check, so the flow stays free of module-specific branching per the
   * bare-skeleton doctrine.
   */
  needsAiGateway?: boolean;
  /**
   * This module submits RunPod jobs and records each one in `runpod_job_log`, so it needs the tenant
   * studio D1 bound as TELEMETRY_DB (vivijure-cf#279, routed here as cp#248). Data, not a name
   * check, for the same reason needsAiGateway is: the provision flow stays free of module-specific
   * branching.
   *
   * Set ONLY on the modules that record. A module that submits no RunPod job has nothing to write,
   * and handing it the tenant database it never reads would widen its reach for no gain.
   *
   * The binding NAME is read off the module source, never chosen here: the write helper reads
   * env.TELEMETRY_DB, so a binding under any other name IS an absent binding -- the write warns and
   * no-ops, and the module still answers ok:true on /ready, because the job log is deliberately not
   * part of ok. A typo here is silent everywhere except the telemetry field itself.
   */
  recordsRunpodJobs?: boolean;
  /**
   * The RunPod PUBLIC model slug this module submits to, for a module that reaches RunPod WITHOUT
   * one of our own endpoints (cp#284 / cf#394 wave 1).
   *
   * WHY THIS EXISTS RATHER THAN A BOOLEAN. The eight cost-door modules submit to vendor-hosted
   * public slugs (`kling-v2-1-i2v-pro`, `wan-2-6-i2v`, ...) instead of a tenant endpoint, so they
   * reach RunPod with `endpointKey` absent. Carrying the SLUG rather than a flag lets a test assert
   * this catalog against `PUBLIC_ENDPOINT_ALLOWLIST` in runpod-proxy.ts, which is the list the plane
   * proxy will actually admit -- a bare boolean would be two facts that agree only by memory.
   *
   * IT IS NOT BOUND ONTO THE WORKER. The module hard-codes its own slug; this is the plane's
   * record of which slug that is. Binding it would create a second source of truth for a value the
   * module already owns.
   */
  publicEndpoint?: string;
  /**
   * This module writes finished render bytes into the TENANT's R2 bucket, so it needs an
   * `r2_bucket` binding named R2_RENDERS (cp#284 / cf#394 wave 1).
   *
   * MEASURED FROM THE MODULE SOURCES, not assumed: across the fifteen catalog modules the split is
   * exact and has no overlap with `endpointKey`. The eight cost-door modules declare `R2_RENDERS`
   * in their Env and do one `env.R2_RENDERS.put` in the Worker; the other seven declare it nowhere,
   * because their far end writes and the studio imports the result.
   *
   * WITHOUT THIS BINDING THE ROW IS WORSE THAN ABSENT. A tenant module uploaded with no R2_RENDERS
   * does not fail: the self-host wrangler.toml names the OPERATOR bucket, so the tenant's renders
   * would land in ours. That is why the rows and this binding are one change and uploadTenantModules
   * REFUSES rather than uploading a writer with no tenant bucket to write to.
   *
   * A CAPABILITY, NOT A CREDENTIAL. An r2_bucket binding puts no secret in the tenant namespace and
   * has nothing to roll, which is why the cp#270 bounded-residency argument (built to stop a
   * standing CREDENTIAL going stale, cf#83) does not reach this case.
   */
  writesTenantRenders?: boolean;
}

/**
 * The tenant module set. NEITHER "4 endpoint-backed capabilities" NOR a uniform binding set any
 * more, which is what this paragraph used to claim: cp#284 / cf#394 wave 1 added the eight
 * GPUless cost-door modules, which reach RunPod through PUBLIC vendor slugs and declare no
 * endpoint of ours at all. Derive the populations from the catalog, never from this prose --
 * `reachesRunpod` is the RunPod-reaching set (14 of 15 today, `plan-enhance` the only exclusion),
 * `spec.endpointKey` the endpoint-backed subset, `spec.writesTenantRenders` the tenant-R2 writers.
 * The binding set below branches on each of those separately. Extending the hosted tier is a row
 * here, plus the matching endpoint in runpod.ts for an endpoint-backed module.
 *
 * THE UPSTREAM RECORDING SET IS NOW FULLY CATALOGUED (cp#284, cf#394 wave 0). Six module workers
 * record RunPod jobs upstream and all six are here. The note that used to sit in this space said
 * `finish-rife` was published as a tenant bundle and provisioned by nothing -- true from cp#248
 * until this row landed, and retired rather than deleted so a reader meeting the six/five
 * discrepancy in an older doc knows which way it was resolved.
 *
 * IT WAS ALWAYS THE ROW AND NOTHING ELSE. finish-rife reads no operator-only binding (its Env is
 * the two RunPod credentials, the proxy pair, and TELEMETRY_DB), sits on the shared route seam, and
 * its bundle is published by the same release as every other catalog module. It declares an
 * `R2_RENDERS` bucket in its own wrangler.toml for the SELF-HOST deploy and reads it nowhere -- the
 * binding does not appear in its Env interface at all -- so it is not in the cp#270 tenant-R2
 * envelope lane and needs nothing from it.
 */
export const TENANT_MODULE_CATALOG: readonly TenantModuleSpec[] = [
  { module: "keyframe", endpointKey: "backend", recordsRunpodJobs: true },
  { module: "own-gpu", endpointKey: "backend", recordsRunpodJobs: true },
  { module: "finish-upscale", endpointKey: "upscale", recordsRunpodJobs: true },
  { module: "finish-lipsync", endpointKey: "lipsync", recordsRunpodJobs: true },
  { module: "speech-upscale", endpointKey: "audio-upscale", recordsRunpodJobs: true },
  // cp#284 / cf#394 wave 0. Rides the SAME shared backend endpoint as keyframe and own-gpu, which
  // is read off the module rather than chosen here: its wrangler.toml binds RUNPOD_ENDPOINT_ID from
  // the store secret BACKEND_RUNPOD_ENDPOINT_ID. Records, so it takes TELEMETRY_DB; endpoint-backed,
  // so on a shared tenant it takes the cp#288 proxy pair like the other four.
  { module: "finish-rife", endpointKey: "backend", recordsRunpodJobs: true },
  // cf#56: the Opus director pass. NOT endpoint-backed -- it reaches Anthropic through OUR AI
  // Gateway on unified billing, so the cost is ours and the per-tenant CF_AIG_TOKEN is what makes
  // that cost attributable and revocable one tenant at a time. Spend stays bounded today by the
  // tenant studio own SPEND_DAILY_CEILING, which cf#256 put the planner routes inside.
  //
  // ORDERING: this entry is only safe once a studio release actually PUBLISHES the plan-enhance
  // bundle (vivijure-cf PR for cf#56). moduleBundle.fetch throws on a release that predates it, and
  // that failure is loud at modules_upload rather than silent, but it would fail every provision.
  { module: "plan-enhance", needsAiGateway: true },
  // ---- cp#284 / cf#394 WAVE 1: the GPUless cost door -------------------------------------------
  //
  // Conrad ruled these IN SCOPE for the hosted tier on 2026-08-02 ("I want the cloud-i2v modules on
  // the hosted door, it's literally one of the selling points"). A hosted tenant had no cost door at
  // all: these eight were published by every release the plane pins and uploaded by nothing.
  //
  // NO endpointKey, BY MEASUREMENT rather than by omission: none of the eight declares
  // RUNPOD_ENDPOINT_ID in its Env. They submit to the vendor-hosted public slug carried below.
  //
  // recordsRunpodJobs on all eight, established BY EFFECT against two controls: each imports
  // runpod-job-log and reads TELEMETRY_DB exactly as `keyframe` (a known recorder) does, while
  // `plan-enhance` (a known non-recorder) does neither. Migration 0020 is the reason it matters --
  // it added `endpoint_id` specifically because these eight submit to eight DISTINCT slugs at
  // different prices, so the endpoint is the only thing that says what a job COST.
  { module: "alibaba-wan", publicEndpoint: "wan-2-6-i2v", recordsRunpodJobs: true, writesTenantRenders: true },
  { module: "alibaba-wan-lora", publicEndpoint: "wan-2-2-t2v-720-lora", recordsRunpodJobs: true, writesTenantRenders: true },
  { module: "google-veo", publicEndpoint: "google-veo3-1-fast-i2v", recordsRunpodJobs: true, writesTenantRenders: true },
  { module: "kling", publicEndpoint: "kling-v2-1-i2v-pro", recordsRunpodJobs: true, writesTenantRenders: true },
  { module: "minimax-hailuo", publicEndpoint: "minimax-hailuo-2-3-fast", recordsRunpodJobs: true, writesTenantRenders: true },
  { module: "narration-gen", publicEndpoint: "minimax-speech-02-hd", recordsRunpodJobs: true, writesTenantRenders: true },
  { module: "seedance", publicEndpoint: "seedance-v1-5-pro-i2v", recordsRunpodJobs: true, writesTenantRenders: true },
  { module: "vidu-q3", publicEndpoint: "vidu-q3-i2v", recordsRunpodJobs: true, writesTenantRenders: true },
];

/**
 * Does this module reach RunPod at all, by EITHER route (cp#284)?
 *
 * THE CANONICAL POPULATION PREDICATE. If the question is "which modules have something to do with
 * RunPod", this is the answer. It has now been the right answer to THREE distinct questions -- and
 * every one of them was FIRST attempted with a proxy for it, and every one of those proxies was
 * wrong in a DIFFERENT direction. That is why this is written down rather than rediscovered.
 *
 *   1. WHICH MODULES GET THE PROXY PAIR BOUND (cp#284/cp#317). First tried as `if (endpoint)`. The
 *      eight cost-door modules reach RunPod at a PUBLIC vendor slug with no endpoint of ours, so
 *      they would have been uploaded to a shared tenant with no pair, taken the unbound branch, and
 *      reached RunPod on the direct RUNPOD_API_KEY -- a consumer holding a credential on our
 *      account, which CLAUDE.md forbids outright. FAILED SILENTLY: the renders would have worked.
 *
 *   2. WHICH MODULES KEEP THE RUNPOD KEY (cp#290). First tried as `runpod_mode === "shared"` alone.
 *      The mode can disagree with the bind decision -- a shared tenant on a plane that resolves no
 *      proxy gets no pair -- and retiring on the mode then invents a state the code has never had:
 *      NEITHER pair NOR key. FAILS LOUD, and every render on that tenant dies.
 *
 *   3. WHICH MODULES ARE PROBED FOR READINESS (cp#323). First tried as the whole catalog.
 *      `plan-enhance` reaches no RunPod and answers an AI-gateway-shaped /ready, which classifies
 *      `misconfigured` -- non-retryable, so it throws. NO TENANT COULD COMPLETE AN INVOKE-KEY
 *      INSTALL, in any mode. FAILED AT PROVISION, and was green in test because the fixture fed it
 *      a body production cannot produce.
 *
 * THE RULE: do NOT derive a new population from `endpointKey`, from `runpod_mode`, or from the
 * catalog. Those are the three that have already been tried, and they failed silently, fatally and
 * at provision respectively. Use this predicate, or explain at the call site why the question is
 * genuinely a different one.
 *
 * `plan-enhance` is the negative case and still the only one: it reaches Anthropic through the AI
 * Gateway and submits no RunPod job. It is what gives every use of this predicate a real subject
 * rather than a population that happens to be everything.
 */
/**
 * Bindings that must NEVER appear on a tenant module worker (cf#361).
 *
 * Modules call `reconcileRunpodEndpointWorkersMax` against the RunPod MANAGEMENT API when
 * `RUNPOD_WORKERS_MAX` is set. That is intentional on operator-hosted modules. On a tenant
 * namespace it would put management reach one binding away from the paying consumer -- safe today
 * only because this builder never emits the name. Pin the refusal so omission becomes design.
 */
export const TENANT_MODULE_FORBIDDEN_BINDINGS: readonly string[] = [
  "RUNPOD_WORKERS_MAX",
];

/** Throw if any forbidden management binding snuck onto a tenant module upload (cf#361). */
export function assertNoTenantModuleForbiddenBindings(
  moduleName: string,
  bindings: readonly { name: string }[],
): void {
  const names = new Set(bindings.map((b) => b.name));
  for (const forbidden of TENANT_MODULE_FORBIDDEN_BINDINGS) {
    if (names.has(forbidden)) {
      throw new TenantModuleError(
        "modules_upload",
        `module ${moduleName}: binding ${forbidden} is forbidden on tenant modules (cf#361: ` +
          "management API reach must stay operator-only; refuse rather than upload)",
      );
    }
  }
}

export const reachesRunpod = (spec: TenantModuleSpec): boolean =>
  Boolean(spec.endpointKey) || Boolean(spec.publicEndpoint);

/**
 * The proxy credential this tenant's module workers will carry, or null when they will not be
 * proxied (cp#288 / cp#290).
 *
 * THE ONE EXPRESSION, and that is the whole reason it exists as a function. TWO decisions now turn
 * on this fact: whether uploadTenantModules BINDS the proxy pair, and whether installInvokeKey
 * INSTALLS the direct RunPod key on the module scripts. Written out twice they are two expressions
 * that can disagree, and there is exactly one state they can disagree INTO: neither pair nor key,
 * a module with no route to RunPod at all, whose every render dies. MODULE_PROXY_BASE_BINDING
 * already says a half-bound pair must never exist; this keeps the key on the same footing.
 *
 * NOT `runpodMode === "shared"` ALONE, which is the trap this replaces. Shared is NECESSARY and not
 * SUFFICIENT: a shared tenant on a plane with no CONTROL_PLANE_HOST or no RUNPOD_PROXY_SIGNING_KEY
 * resolves no proxy at all (tenantModuleProxy, env.ts), and a tenant id the mint refuses gets no
 * token. Retire the key on the MODE and you retire it for tenants that never received a proxy. The
 * predicate has to be the thing that actually decides, which is the cp#317 finding one layer over:
 * there the population was right and the predicate was wrong, and it is the predicate again here.
 *
 * PER TENANT, NOT PER MODULE. The mint is a pure HMAC over the tenant id, so every module in the
 * catalog computes the identical answer. Hoisting it out of the upload loop makes that a stated
 * property rather than something that happens to hold fifteen times.
 */
export async function tenantModuleProxyBinding(
  runpodMode: RunPodMode,
  runpodProxy: { base: string; signingKey: string } | null,
  tenantId: string,
): Promise<{ base: string; token: string } | null> {
  if (runpodMode !== "shared") return null;
  if (!runpodProxy) return null;
  const token = await mintTenantProxyToken(runpodProxy.signingKey, tenantId);
  if (!token) return null;
  return { base: runpodProxy.base, token };
}

/**
 * WHY the pair was not bound, for the log line only. Never a control-flow input: the decision is
 * tenantModuleProxyBinding above, and this exists so an operator reading `module.runpod_proxy_unbound`
 * gets the repair rather than two set/unset fields to infer it from. Three causes, three repairs:
 * the tenant is not on the shared tier (expected, and the overwhelmingly common case today), the
 * plane configures no proxy, or the mint refused this tenant id.
 */
export function tenantModuleProxyUnboundReason(
  runpodMode: RunPodMode,
  runpodProxy: { base: string; signingKey: string } | null,
  bound: { base: string; token: string } | null,
): string {
  if (bound) return "bound";
  if (runpodMode !== "shared") return "not_shared_mode";
  if (!runpodProxy) return "plane_configures_no_proxy";
  return "mint_refused_tenant_id";
}

/**
 * The per-tenant script-name prefix in the shared modules namespace. Derived from the TENANT ID (not
 * the display slug): stable across renames, collision-free, and it makes teardown a prefix sweep (the
 * cf#99 ruling). Tenant ids look like `ten_<hex>`; the underscore is not valid in a Worker script name,
 * so it is normalized to a hyphen. The hex tail keeps it unique after normalization. Ends with `-` so
 * `startsWith(prefix)` cannot match a different tenant whose id is a prefix of this one.
 */
export const tenantModuleScriptPrefix = (tenantId: string): string =>
  tenantId.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + "-";

/** The resident script name for one tenant module (e.g. `ten-<hex>-keyframe`). */
export const tenantModuleScriptName = (tenantId: string, moduleName: string): string =>
  tenantModuleScriptPrefix(tenantId) + moduleName;

/** Steps this file can fail at, mapped straight onto ProvisionStep so the job row reads honestly. */
export type TenantModuleStep = "modules_upload" | "modules_install" | "verify";

/** A module-provisioning failure carrying the step it failed at (the provisioner maps it 1:1 to a
 *  ProvisionFailure so resume + the job row attribute it correctly). */
export class TenantModuleError extends Error {
  constructor(
    readonly step: TenantModuleStep,
    message: string,
  ) {
    super(message);
    this.name = "TenantModuleError";
  }
}

/**
 * Upload ONE tenant module script, on the SCRIPT UPLOAD credential, with the cf#118 guard the
 * studio path has always had.
 *
 * WHY THIS EXISTS AT ALL (cp#464). The door pool attaches `vpc_service` bindings to MODULE workers.
 * The studio attaches one to the STUDIO worker. Those were uploaded by two different credentials,
 * only one of which had ever been granted Connectivity Directory, and nothing anywhere stated that
 * the two had to match. The symptom was a provision dying with raw Cloudflare prose at a step whose
 * sibling has carried a written-for-humans message since cf#118.
 *
 * The guard is here rather than at the call site because a bare upload is exactly what went wrong:
 * the general path was written after the special case and inherited nothing from it.
 */
async function uploadModuleScript(
  deps: TenantModuleDeps,
  module: string,
  args: Parameters<CfApi["uploadUserWorker"]>[0],
): Promise<void> {
  try {
    await deps.scriptUploadCf.uploadUserWorker(args);
  } catch (e) {
    const verdict = classifyVpcBindingFailure(e, args.bindings.some((b) => b.type === "vpc_service"));
    if (verdict.kind === "refused") {
      throw new TenantModuleError(
        "modules_upload",
        "door binding refused for module " + module + ": the plane SCRIPT UPLOAD credential is not " +
          "authorized for Workers VPC (needs Connectivity Directory access). The tenant was NOT " +
          "provisioned without its doors -- fix the upload credential, or clear the door service ids " +
          "to run this plane without own-iron doors on purpose.",
      );
    }
    if (verdict.kind === "unmatched") {
      // THE GUARD REPORTING ITS OWN OBSOLESCENCE (cp#462). A VPC binding failed and the code we key
      // on did not match, which is the precise state in which this guard is inert. Logging what
      // Cloudflare actually said turns the FIRST silent miss into a loud one, instead of leaving a
      // dead predicate to be discovered by an operator reading raw vendor prose months later.
      deps.log("module_upload.vpc_guard_did_not_match", {
        module,
        codes: verdict.codes,
        messages: verdict.messages,
      });
    }
    throw e;
  }
}

/** The slice of provisioner wiring the module orchestration needs. ProvisionDeps satisfies this
 *  structurally, so there is ONE wiring seam (deps.ts) and no second injection surface. */
export interface TenantModuleDeps {
  cf: CfApi;
  /**
   * THE CREDENTIAL THAT UPLOADS SCRIPTS, which is not always the same one as `cf` (cp#464).
   *
   * cf#118 split script upload onto its own token and granted THAT token the Connectivity Directory
   * access a `vpc_service` binding needs. The module path was written earlier and kept using `cf`,
   * so when the door pool started attaching VPC bindings on module workers it was uploading with a
   * credential that had never been granted the permission -- and the failure was invisible until a
   * provision died on it.
   *
   * Both clients still exist because they are different grants, not different code paths. What is
   * fixed here is that ONE of them is responsible for every upload that can attach a VPC binding,
   * so there is no longer a pair to keep in sync by hand.
   */
  scriptUploadCf: CfApi;
  /** The shared dispatch namespace tenant module scripts live in (vivijure-tenant-modules). */
  moduleNamespace: string;
  /**
   * The AI Gateway slug bound onto AI-Gateway-backed modules as GATEWAY_ID (cf#56), or null when
   * this plane has none configured. An identifier, not a secret, so it rides as plain_text exactly
   * like RUNPOD_ENDPOINT_ID. Null means the module is uploaded WITHOUT the trio and falls back to
   * the free Workers AI local provider, which is a real degrade rather than a failure: pickProvider
   * needs GATEWAY_ID and CF_AIG_TOKEN both, and returns "local" when either is missing.
   */
  aiGatewayId: string | null;
  /**
   * Where a tenant module sends its RunPod calls and the key that signs the credential it presents
   * there (cp#288), or null when this plane configures no proxy -- no CONTROL_PLANE_HOST to build
   * an origin from, or no RUNPOD_PROXY_SIGNING_KEY to mint against (provisionerWiring, deps.ts).
   *
   * Null uploads the modules WITHOUT the pair, so they keep reaching RunPod with their direct
   * RUNPOD_API_KEY. That is the pre-proxy behaviour unchanged, not a degrade invented here.
   *
   * The SIGNING KEY rather than a minted token, unlike aigTokenValue which arrives as a value: the
   * mint is a pure HMAC over the tenant id (runpod-proxy-auth.ts) with no credential-minting REACH
   * to keep out of this file, and it is per-tenant while this deps bundle is per-deploy -- so there
   * is no wiring-time value to pass.
   */
  runpodProxy: { base: string; signingKey: string } | null;
  moduleBundle: ModuleBundleSource;
  /**
   * The OWN-IRON DOORS (cp#396), keyed by PROVISION_PLAN key, or an empty record on a plane that
   * configures none.
   *
   * A door is a PAIR and both halves are required: the Connectivity Directory service id the
   * vpc_service binding resolves, and the bearer the container checks. BOTH OR NEITHER, resolved
   * once in deps.ts -- a binding without its token is not a partial rollout, it is a module that
   * switches transport and is refused 401 on every call, which is strictly worse than never
   * switching. Same rule as the cp#288 proxy pair.
   *
   * Absent means the vpc-backed capability is NOT BOUND, and uploadTenantModules refuses rather
   * than uploading a module with no route to its door at all.
   */
  vpcDoors: Record<string, ResolvedDoor[]>;
  /** Dispatch a GET to one tenant MODULE script over TENANT_MODULE_DISPATCH (cf#114). Separate from
   *  callTenantStudio because module scripts live in a DIFFERENT dispatch namespace and take no
   *  bearer: /ready is unauthenticated by design (it carries booleans, never values, and the control
   *  plane must be able to ask before the tenant has a working credential to authenticate with). */
  callTenantModule(scriptName: string, path: string): Promise<{ status: number; text: string }>;
  /** Dispatch a request to the tenant studio over TENANT_DISPATCH (the same seam probeTenantRoot uses),
   *  attaching the studio bearer so the AUTH_MODE=token gate passes. */
  callTenantStudio(
    scriptName: string,
    init: { method: string; path: string; studioApiToken: string; body?: string },
  ): Promise<{ status: number; text: string }>;
  log(event: string, fields: Record<string, unknown>): void;
}

/**
 * Step modules_upload: create the shared namespace if missing, then upload each tenant module script
 * with its endpoint id (RUNPOD_ENDPOINT_ID, plain_text -- an endpoint id is not a secret). Key B is
 * deliberately NOT bound here; it lands in installInvokeKey. Idempotent-by-name: a re-run adopts the
 * namespace and re-PUTs each script. Returns the script names it uploaded.
 */
/**
 * Fetch EVERY catalog module bundle for a release before anything is uploaded (cf#103).
 *
 * WHY THIS EXISTS AS A SEPARATE PASS: uploadTenantModules fetches and uploads in one loop, so a
 * release that is missing the 4th bundle swaps modules 1-3 and only then fails. On a fresh
 * provision that is survivable (the tenant was never serving). On an UPGRADE of a live tenant it
 * is the difference between a zero-write refusal and a paying tenant left with mixed module bytes.
 * The most likely real failure here is a bad release pin or an empty mirror slot, which this turns
 * into a failure that has written nothing.
 *
 * Deliberately NOT wired into the provision path in this change: that path works, is live-proven,
 * and reordering its writes is a separate, separately-verified change (tracked as cf#103 follow-up)
 * rather than a drive-by on the way past.
 */
export async function prefetchModuleBundles(
  deps: TenantModuleDeps,
  release: string,
): Promise<Map<string, ModuleBundle>> {
  const bundles = new Map<string, ModuleBundle>();
  for (const spec of TENANT_MODULE_CATALOG) {
    try {
      bundles.set(spec.module, await deps.moduleBundle.fetch(release, spec.module));
    } catch (e) {
      throw new TenantModuleError(
        "modules_upload",
        `fetch module bundle ${spec.module} at ${release}: ${(e as Error).message}`,
      );
    }
  }
  return bundles;
}

export async function uploadTenantModules(
  deps: TenantModuleDeps,
  /**
   * The release THIS WORK is building, stated by the caller (cp#315).
   *
   * REQUIRED and explicit, never read off deps. It used to be `deps.release` -- the PLANE-WIDE
   * STUDIO_RELEASE, read fresh at the moment of driving -- while the studio came from the job's
   * recorded pin. A resumed shared provision therefore got a studio from release A and modules
   * from release B, silently and with ok:true, which is exactly the pair module-bundle-r2.ts says
   * can never happen: "Modules ship WITH the studio release they were built and conformance-proven
   * against (one tag, one artifact)."
   *
   * The FIELD was deleted from TenantModuleDeps rather than this argument merely being added, and
   * that is the load-bearing half: every other call site threaded the release correctly and this
   * one did not, so "remember to pass it" was already the condition that produced the bug. With no
   * `release` on deps there is nothing to forget -- omitting it does not compile. Same reasoning
   * this file already gives for tenantSlug and runpodMode being required rather than optional.
   */
  release: string,
  tenantId: string,
  /**
   * The tenant display slug, carried into `cf-aig-metadata` as a HUMAN LABEL only (cp#185).
   *
   * REQUIRED rather than optional, deliberately. Attribution keys on `tenantId`, so a missing slug
   * is not a correctness bug -- which is exactly why an optional parameter would rot here: a caller
   * omits it, nothing fails, spend still meters correctly, and a future session discovers the label
   * is missing and has to re-plumb it under a live tenant. Required means the COMPILER catches an
   * omission at the call site instead of a human catching it in a log months later.
   */
  tenantSlug: string,
  endpoints: TenantEndpoint[],
  /**
   * The tenant STUDIO D1 uuid, bound as TELEMETRY_DB on every module that records RunPod jobs
   * (cp#248).
   *
   * WHICH DATABASE, settled against the shipped migration rather than inferred: `runpod_job_log` is
   * vivijure-cf migration 0014, which rides the STUDIO release and is applied to the tenant studio
   * database at provision. So the job log lives in the same database the studio itself gets as DB.
   * A separate telemetry database would be a table nothing migrates.
   *
   * REQUIRED, and an absent id fails the step loudly rather than uploading a module that would
   * record nothing. That mirrors the self-host posture exactly: each module wrangler.toml carries a
   * placeholder database_id and wrangler hard-fails on it, so neither door can ship a module that
   * silently drops every row.
   */
  telemetryD1Id: string | null,
  /**
   * The tenant's own R2 bucket name, bound as R2_RENDERS on every module that writes renders
   * (cp#284 / cf#394 wave 1).
   *
   * REQUIRED and nullable, exactly like telemetryD1Id above and for the same reason: the tenant
   * RECORD is nullable (a half-built tenant may have no bucket yet), so the caller must state what
   * it has and ONE refusal lives here rather than each caller inventing its own message. Required
   * rather than optional means a caller cannot omit it and silently upload a writer bound to
   * nothing -- the same compile-time property cp#315 established for `release`.
   */
  tenantBucketName: string | null,
  /**
   * Which RunPod shape this tenant is on, and therefore whether the proxy pair is bound at all
   * (cp#288).
   *
   * THE CROSS-REPO CONTRACT SAYS SHARED ONLY, and the consequence of ignoring it is not a missed
   * optimisation. vivijure-cf@67302960 modules/_shared/runpod-route.ts branches on
   * RUNPOD_PROXY_BASE being BOUND and states in terms that this is NOT a failover: bound means
   * proxied, and a proxied module that cannot authenticate refuses honestly rather than finding
   * another way to RunPod. Our own submit path then answers 403 `not_shared_mode` for anything that
   * is not shared (runpod-proxy-routes.ts). So binding this on a dedicated tenant does not degrade
   * it, it breaks every render on it, with the fallback deliberately unavailable.
   *
   * TYPED AS THE NARROWED UNION, NOT `string | null`. The tenants column is
   * `NOT NULL DEFAULT 'dedicated'` and a caller holding it raw cannot pass it here without going
   * through readRunPodMode(), so the narrowing rule has one home and forgetting it is a compile
   * error rather than a tenant-visible outage. readRunPodMode maps anything unrecognised to
   * 'dedicated', which is the correct failure direction here: dedicated binds nothing, the module
   * stays on the direct path, and the direct path works.
   *
   * REQUIRED and positioned with the other tenant facts rather than appended as an optional, for
   * the reason `tenantSlug` above and `release` on runModuleSteps both already give: an optional
   * would let a caller omit it, bind nothing, and look correct.
   */
  runpodMode: RunPodMode,
  /** Pre-fetched bundles (prefetchModuleBundles). When absent each bundle is fetched inline, which
   *  is the original provision behaviour and is left exactly as it was. */
  prefetched?: Map<string, ModuleBundle>,
  /**
   * This tenant freshly-minted AI Gateway Run token VALUE (cf#56), or null when none was minted.
   * Passed in rather than minted here so this file keeps no credential-minting reach, and so the
   * caller can persist nothing: the value goes straight into a secret_text binding and is dropped.
   */
  aigTokenValue?: string | null,
): Promise<string[]> {
  // FIRST, before the namespace is touched or a byte is uploaded: a refusal here has changed
  // nothing. A tenant record with no D1 id is a broken tenant, not a tenant that should quietly get
  // modules which cannot record (cp#248).
  if (!telemetryD1Id) {
    throw new TenantModuleError(
      "modules_upload",
      "no tenant D1 id for the TELEMETRY_DB binding; refusing to upload module workers that would " +
        "record no RunPod job rows (cp#248). Repair tenants.d1_database_id or re-provision",
    );
  }
  await deps.cf.createDispatchNamespace(deps.moduleNamespace);
  // ONE decision for the tenant, taken BEFORE the loop, because installInvokeKey has to reach the
  // identical one. See tenantModuleProxyBinding: the pair and the direct key are two halves of the
  // same choice and must never be decided by two expressions.
  const moduleProxy = await tenantModuleProxyBinding(runpodMode, deps.runpodProxy, tenantId);
  const moduleProxyReason = tenantModuleProxyUnboundReason(runpodMode, deps.runpodProxy, moduleProxy);
  const scriptNames: string[] = [];
  for (const spec of TENANT_MODULE_CATALOG) {
    // THREE CASES, and keeping them apart is the point (cp#396).
    //
    //   1. no endpointKey at all      -> not endpoint-backed (cf#56, plan-enhance). Legitimate.
    //   2. endpointKey, VPC-BACKED     -> served by our own iron. No RunPod endpoint exists for it
    //                                     BY DESIGN, so the absence must NOT throw. It binds a door
    //                                     instead, below.
    //   3. endpointKey, endpoint-backed, and the tenant lacks it -> still a loud failure, unchanged.
    //
    // Collapsing 2 into 3 is what made the first attempt at this split kill EVERY provision:
    // trimming the plan orphaned finish-upscale and speech-upscale, and the guard below threw on
    // both, shared and dedicated alike. Collapsing 2 into 1 would be worse in the other direction --
    // a module that silently reaches nothing.
    const vpcCapability = spec.endpointKey ? vpcBackedPlan().find((c) => c.key === spec.endpointKey) : undefined;
    const endpoint = spec.endpointKey && !vpcCapability ? endpoints.find((e) => e.key === spec.endpointKey) : undefined;
    if (spec.endpointKey && !vpcCapability && !endpoint) {
      throw new TenantModuleError(
        "modules_upload",
        `module ${spec.module} needs the ${spec.endpointKey} endpoint, which the tenant does not have`,
      );
    }
    // A vpc-backed capability with no configured door is the SAME class of failure as a missing
    // endpoint, and is refused with the knob named. Uploading it anyway would produce a module that
    // takes neither transport: no endpoint id, no door, and a first render that dies.
    // The POOL for this capability. ZERO doors is the refusal, not fewer-than-all: a pool of one is
    // a working pool (vivijure-cf pickDoor is n % pool.length), so a plane that has configured one
    // box and not the other still provisions and simply concentrates on the box it has.
    const doors = vpcCapability ? deps.vpcDoors[vpcCapability.key] : undefined;
    if (vpcCapability && (!doors || doors.length === 0)) {
      // NAMES EVERY DOOR VAR, not just the first. An operator who set only the second door pair
      // would otherwise be told to set vars they have already set, with nothing pointing at the
      // legacy pair that is actually missing.
      const knobs = vpcCapability.doors
        .map((d) => `${d.serviceIdVar} + ${d.doorTokenVar}`)
        .join(", or ");
      throw new TenantModuleError(
        "modules_upload",
        `module ${spec.module} is served by our own iron, but this plane configures no door for ` +
          `${vpcCapability.key}: set at least one pair -- ${knobs}`,
      );
    }
    let bundle: ModuleBundle;
    const ready = prefetched?.get(spec.module);
    if (ready) {
      bundle = ready;
    } else {
      try {
        bundle = await deps.moduleBundle.fetch(release, spec.module);
      } catch (e) {
        throw new TenantModuleError("modules_upload", `fetch module bundle ${spec.module}: ${(e as Error).message}`);
      }
    }
    const scriptName = tenantModuleScriptName(tenantId, spec.module);
    const bindings: WorkerBinding[] = [];
    if (endpoint) {
      // The endpoint id the module renders against. plain_text: not a secret, mirrors how the studio
      // provisioner binds its endpoint-id vars. The module reads env.RUNPOD_ENDPOINT_ID (string-typed
      // via secretValue), so a plain_text binding drops straight in.
      bindings.push({ type: "plain_text", name: "RUNPOD_ENDPOINT_ID", text: endpoint.id });
    }
    if (vpcCapability && doors) {
      // THE OWN-IRON DOOR POOL (cp#396), following the VIDEO_FINISH_VPC precedent in provisioner.ts:
      // a vpc_service binding plus the bearer the container checks, ONCE PER BOX.
      //
      // EVERY configured door is bound, in plan order. vivijure-cf builds doorPool() from these and
      // round-robins with pickDoor, so binding only one would concentrate every tenant render on a
      // single box while the other idled -- correct, but at half capacity and with no signal
      // attached to the difference.
      //
      // NO RUNPOD_ENDPOINT_ID IS BOUND, and that is not an omission. vivijure-cf resolves the door
      // pool FIRST and branches on it being non-empty before it ever reads a RunPod credential, so
      // a door-bound module never needs an endpoint id. Binding an empty string to satisfy a shape
      // would be the exact failure this split exists to remove: it uploads clean and dies at the
      // tenant first render.
      //
      // The NAMES come from the module Env, not from us -- see PlannedDoor. Getting one wrong
      // produces a binding nothing reads, which is SILENT, so they are carried as data on the plan
      // rather than written here.
      for (const door of doors) {
        bindings.push({ type: "vpc_service", name: door.bindingName, service_id: door.serviceId });
        // secret_text, never plain_text: this is a BEARER. A plain_text binding is readable from
        // the dashboard and the API, which is how a door token becomes a secret nobody rotated.
        bindings.push({ type: "secret_text", name: door.doorTokenBinding, text: door.token });
      }
    }
    if (reachesRunpod(spec)) {
      // cp#288: the pair that lets this module reach RunPod THROUGH the plane instead of holding a
      // RunPod-capable credential in the tenant namespace. Bound on every module that REACHES
      // RunPod -- a module that submits no RunPod job has nothing to send through a proxy, and
      // handing it a plane credential widens its reach for no gain (the TELEMETRY_DB discipline
      // above). `plan-enhance` is still the only such module and still the negative control.
      //
      // KEYED ON reachesRunpod, NOT ON endpointKey (cp#284) -- this block used to sit inside
      // `if (endpoint)`. Why that was wrong, and why no fresh population should be derived here, is
      // stated ONCE at the definition of reachesRunpod. The detail local to THIS site: the modules
      // it would have missed take the unbound branch of vivijure-cf
      // modules/_shared/runpod-route.ts, which reaches RunPod on the direct RUNPOD_API_KEY.
      //
      // THE ORDERING WAS LOAD-BEARING AND IS NOW SATISFIED (cf#394). This comment used to say the
      // key was still installed on every module script and that vivijure-cf modules "FALL BACK" to
      // it. Both halves were wrong to leave standing. On the FALL BACK: the cf helper says in terms
      // that the branch is BOUND-ness and NEVER a failover -- a proxied module with a broken token
      // refuses honestly rather than finding another way to RunPod, because a shared tenant that
      // could fall back to a direct key is the exact thing the proxy exists to make impossible.
      // On the key: cf v1.20.0 shipped that helper and is the pinned STUDIO_RELEASE, so the
      // ordering condition ("only after that has shipped may the plane stop installing the key")
      // is MET, and installInvokeKey no longer installs it on a proxied tenant's modules.
      //
      // WHICH LEAVES ONE RULE FOR ANYONE EDITING EITHER SIDE: the pair and the key are decided by
      // ONE expression (tenantModuleProxyBinding) read by both this function and installInvokeKey.
      // Do not re-derive either of them from runpodMode here.
      //
      // BOTH OR NEITHER. See MODULE_PROXY_BASE_BINDING: a base without a token is not a partial
      // rollout, it is a module that switches to the proxy and is refused 401 on every call.
      //
      // SHARED ONLY. See the runpodMode parameter: on any other shape the pair must not be bound at
      // all, because bound-and-refused is strictly worse than never bound.
      if (moduleProxy) {
        bindings.push({
          type: "plain_text",
          name: MODULE_PROXY_BASE_BINDING,
          text: moduleProxy.base,
        });
        // secret_text: it authenticates this tenant to OUR routes and is worthless anywhere else,
        // but it is still a credential. Deterministic per tenant, so a re-provision re-derives the
        // same value rather than leaving a second live one behind it.
        bindings.push({
          type: "secret_text",
          name: MODULE_PROXY_TOKEN_BINDING,
          text: moduleProxy.token,
        });
      } else {
        // PER MODULE deliberately, even though the decision is per tenant: this is the line an
        // operator greps when one module is not reaching RunPod, and a single tenant-level line
        // would not tell them which scripts it covered. The REASON is computed once above and
        // names the repair (tenantModuleProxyUnboundReason), rather than leaving the reader to
        // infer it from two set/unset fields.
        deps.log("module.runpod_proxy_unbound", {
          tenant: tenantId,
          module: spec.module,
          mode: runpodMode,
          proxy: deps.runpodProxy ? "set" : "unset",
          reason: moduleProxyReason,
        });
      }
    }
    if (spec.writesTenantRenders) {
      // cp#284 / cf#394 wave 1: THE TENANT's bucket, not the operator's.
      //
      // WHY A REFUSAL AND NOT A SKIP. A module uploaded without this binding does not fail. Its
      // self-host wrangler.toml declares `bucket_name = "vivijure"` -- the OPERATOR bucket -- so an
      // unbound upload is not a module that cannot write, it is a module that writes a paying
      // tenant's renders into our own bucket and reports success. Silent, wrong, and discoverable
      // only by someone auditing bucket contents. So a writer with no tenant bucket is a hard stop.
      //
      // SAME BUCKET THE STUDIO ALREADY HAS. provisioner.ts binds this exact bucket on the tenant
      // studio as R2_RENDERS (and as R2), so this grants the module scripts the reach the studio
      // already holds, over the same object. Measured, not assumed: there is one bucket per tenant,
      // created by createR2Bucket with no lifecycle, CORS or policy configuration, so there is no
      // per-binding permission surface on which a module could differ from the studio.
      //
      // AND IT REMOVES A COLLISION RATHER THAN ADDING ONE. clipKey() is
      // `renders/<project>/clips/<shot>_<vendor>.mp4`, which carries NO tenant component: in a
      // single operator bucket two tenants with the same project and shot ids would overwrite each
      // other. Per-tenant buckets make that unrepresentable.
      if (!tenantBucketName) {
        throw new TenantModuleError(
          "modules_upload",
          `module ${spec.module} writes tenant renders but the tenant has no R2 bucket recorded; ` +
            "uploading it would write those renders into the operator bucket",
        );
      }
      bindings.push({ type: "r2_bucket", name: "R2_RENDERS", bucket_name: tenantBucketName });
    }
    if (spec.recordsRunpodJobs) {
      // cp#248 / vivijure-cf#279. RunPod cannot enumerate jobs, so a job id this worker does not
      // write down at submit is unreachable the moment the job ends -- there is no backfill, and the
      // endpoint health counters cannot substitute (they bucket four terminal statuses into two and
      // exclude the CANCELLED these modules produce deliberately).
      //
      // Attached to EVERY module in the catalog that records, for every tenant, at upload. There is
      // no per-tenant subset here: this loop uploads the whole catalog, and installation (which a
      // tenant CAN change from their own studio) happens later and separately. A module a tenant
      // never installs is never dispatched, so it records nothing because it runs nothing -- not
      // because it lacks the binding.
      bindings.push({ type: "d1", name: "TELEMETRY_DB", id: telemetryD1Id });
    }
    if (spec.needsAiGateway) {
      // env.AI is what the module actually calls, BOTH ways: .gateway(GATEWAY_ID).getUrl("anthropic")
      // for the Opus pass and .run(<model>) for the free local fallback. Bound unconditionally, so a
      // plane with no gateway configured still gets a working module on the local provider instead
      // of one that throws on every call.
      bindings.push({ type: "ai", name: "AI" });
      // Attribution for the hosted per-tenant Opus meter (cp#185). The gateway records
      // `authentication` as a BOOLEAN -- it logs THAT a request was authenticated, never WHICH
      // token -- so the per-tenant CF_AIG_TOKEN below is the access and revocation boundary and
      // carries no attribution at all. `cf-aig-metadata`, built by the module from these two vars,
      // is the entire attribution mechanism. Two different jobs, kept apart on purpose.
      //
      // plain_text, not secret_text: a tenant id is an opaque identifier and the slug is already
      // public in the tenant own URL. Same treatment as RUNPOD_ENDPOINT_ID.
      //
      // Bound UNCONDITIONALLY for a gateway-backed module rather than alongside the token pair
      // below. If the trio is unconfigured the module runs on the free local provider and never
      // makes a gateway call, so these are simply unread; gating them on the token would couple two
      // unrelated things and invite the next reader to think attribution is optional when the
      // gateway IS configured. A self-hosted install gets neither var and sends no header, which is
      // the parity-correct behaviour: a self-hoster bills their own account.
      bindings.push({ type: "plain_text", name: "TENANT_ID", text: tenantId });
      bindings.push({ type: "plain_text", name: "TENANT_SLUG", text: tenantSlug });
      // BOTH or NEITHER, deliberately: pickProvider returns "opus" only when GATEWAY_ID and
      // CF_AIG_TOKEN are both present, so binding one alone would advertise nothing and change
      // nothing. Half the pair is the silent-no-op case this guard exists to prevent.
      if (deps.aiGatewayId && aigTokenValue) {
        bindings.push({ type: "plain_text", name: "GATEWAY_ID", text: deps.aiGatewayId });
        // Straight from the mint into a worker secret. Never persisted, never logged.
        bindings.push({ type: "secret_text", name: "CF_AIG_TOKEN", text: aigTokenValue });
      } else {
        deps.log("module.ai_gateway_unconfigured", {
          tenant: tenantId,
          module: spec.module,
          gateway: deps.aiGatewayId ? "set" : "unset",
          token: aigTokenValue ? "set" : "unset",
        });
      }
    }
    // cf#361: design, not omission -- refuse management bindings before they reach a tenant script.
    assertNoTenantModuleForbiddenBindings(spec.module, bindings);
    await uploadModuleScript(deps, spec.module, {
      namespace: deps.moduleNamespace,
      scriptName,
      mainModule: bundle.mainModule,
      moduleText: bundle.moduleText,
      compatibilityDate: bundle.compatibilityDate,
      compatibilityFlags: bundle.compatibilityFlags,
      bindings,
    });
    scriptNames.push(scriptName);
  }
  return scriptNames;
}

/**
 * Step modules_install: drive the tenant studio's own POST /api/modules/install for each module
 * script. The studio runs conformance against the resident script through its MODULE_DISPATCH and
 * INSERTs the installed_modules row on a green suite (201). A non-201 is an honest, module-named
 * failure carrying the studio's own words. Requires the studio to already carry the MODULE_DISPATCH
 * binding (bound in the studio upload, which runs before this). Returns the installed module names.
 */
/**
 * How long to wait for a freshly-uploaded STUDIO_API_TOKEN to become the one the edge serves, and
 * the backoff schedule inside that window. Deliberately bounded: this converts a propagation race
 * into a wait, and it must NEVER become an indefinite retry that hides a genuinely bad credential.
 */
/**
 * BUDGET, and why it is this small (#112 / the run-4 hang): this probe runs inside a provision job
 * driven by waitUntil, whose extension window is on the order of 30 seconds. The original 60s
 * deadline could not fit that, so a probe that actually waited would be killed mid-sleep, taking the
 * whole job with it and stranding the tenant at "provisioning" with no error. Bounding the retry
 * loop was not enough: the loop has to finish well inside the execution budget it runs in.
 *
 * 15s with a 2s backoff cap still covers a propagation blip (the thing this exists for) while
 * leaving the rest of the job room to finish and write an honest terminal state.
 */
export const STUDIO_TOKEN_PROBE_DEADLINE_MS = 15_000;
const STUDIO_TOKEN_PROBE_BACKOFF_MS = [250, 500, 1000, 2000] as const;

/** Injectable clock + sleep, so the probe is testable without burning real seconds. Production
 *  passes neither and gets the real ones. */
export interface ProbeTiming {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realTiming: ProbeTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Wait until the tenant studio actually SERVES the token we just uploaded (#108).
 *
 * The studio script name is slug-based, so a re-provision ADOPTS an existing script object. The
 * fresh STUDIO_API_TOKEN rides that upload as a secret_text binding, but the edge can still be
 * serving the PREVIOUS version, which carries the PREVIOUS token. The install loop then 403s and the
 * whole provision dies. A brand-new script has no previous version, which is why this only ever bit
 * the adopt path.
 *
 * WHAT IS AND IS NOT RETRYABLE, because this is the line between a wait and a cover-up:
 * 403 is retried, and ONLY inside this window, because 403 is exactly what a stale serving version
 * looks like. Any other non-200 fails immediately -- it is a real error, not a race. A token that is
 * genuinely wrong exhausts the window and fails loudly with attempts and elapsed time, so a bad
 * credential can never be silently absorbed by the retry.
 */
export async function awaitStudioTokenLive(
  deps: TenantModuleDeps,
  studioScriptName: string,
  studioApiToken: string,
  timing: ProbeTiming = realTiming,
  deadlineMs: number = STUDIO_TOKEN_PROBE_DEADLINE_MS,
): Promise<{ attempts: number; elapsedMs: number }> {
  const started = timing.now();
  let attempts = 0;
  let last = "";

  for (;;) {
    attempts += 1;
    const res = await deps.callTenantStudio(studioScriptName, {
      method: "GET",
      path: "/api/modules/installed",
      studioApiToken,
    });
    const elapsedMs = timing.now() - started;

    if (res.status === 200) {
      deps.log("studio_token.live", { script: studioScriptName, attempts, elapsedMs });
      return { attempts, elapsedMs };
    }

    last = `${res.status}: ${res.text.slice(0, 200)}`;

    // Not a propagation shape. Fail now rather than spending the window on it.
    if (res.status !== 403) {
      throw new TenantModuleError(
        "modules_install",
        `studio token probe -> ${last} (not retryable; attempts=${attempts}, elapsed=${elapsedMs}ms)`,
      );
    }

    const wait = STUDIO_TOKEN_PROBE_BACKOFF_MS[Math.min(attempts - 1, STUDIO_TOKEN_PROBE_BACKOFF_MS.length - 1)];
    if (elapsedMs + wait >= deadlineMs) {
      throw new TenantModuleError(
        "modules_install",
        `studio never served the uploaded STUDIO_API_TOKEN -> ${last} ` +
          `(gave up after ${attempts} attempts, ${elapsedMs}ms; either propagation is far slower than ` +
          `${deadlineMs}ms or the token is wrong)`,
      );
    }
    await timing.sleep(wait);
  }
}

export async function installTenantModules(
  deps: TenantModuleDeps,
  tenantId: string,
  studioScriptName: string,
  studioApiToken: string,
  timing?: ProbeTiming,
): Promise<string[]> {
  // The studio must be serving OUR token before the first install, or the adopt path 403s (#108).
  // Done once, here, rather than per-module: the race is about the script version, not the module.
  await awaitStudioTokenLive(deps, studioScriptName, studioApiToken, timing ?? realTiming);

  const installed: string[] = [];
  for (const spec of TENANT_MODULE_CATALOG) {
    const scriptName = tenantModuleScriptName(tenantId, spec.module);
    const res = await deps.callTenantStudio(studioScriptName, {
      method: "POST",
      path: "/api/modules/install",
      studioApiToken,
      body: JSON.stringify({ script_name: scriptName }),
    });
    if (res.status !== 201) {
      throw new TenantModuleError(
        "modules_install",
        `install ${spec.module} (${scriptName}) -> ${res.status}: ${res.text.slice(0, 300)}`,
      );
    }
    installed.push(spec.module);
  }
  return installed;
}

/**
 * Verify (module half): the tenant studio reports a NON-EMPTY installed-module set. This is the
 * automated, in-job gate (a render past discovery + moving pixels needs key B and is the out-of-band
 * release gate). Returns the installed module names; throws verify on empty or an unreadable list.
 */
export async function verifyTenantModulesInstalled(
  deps: TenantModuleDeps,
  studioScriptName: string,
  studioApiToken: string,
): Promise<string[]> {
  const res = await deps.callTenantStudio(studioScriptName, {
    method: "GET",
    path: "/api/modules/installed",
    studioApiToken,
  });
  if (res.status !== 200) {
    throw new TenantModuleError("verify", `GET /api/modules/installed -> ${res.status}: ${res.text.slice(0, 200)}`);
  }
  let parsed: { modules?: { name?: string }[] };
  try {
    parsed = JSON.parse(res.text) as { modules?: { name?: string }[] };
  } catch {
    throw new TenantModuleError("verify", "GET /api/modules/installed returned non-JSON");
  }
  const names = (parsed.modules ?? []).map((m) => m.name).filter((n): n is string => typeof n === "string");
  if (names.length === 0) {
    throw new TenantModuleError("verify", "tenant studio reports zero installed modules after provisioning");
  }
  return names;
}

/**
 * Tear down a tenant's module scripts: sweep every resident script whose name starts with the tenant
 * prefix out of the shared namespace, then census that zero remain (the cf#99 teardown ruling:
 * rows-then-scripts-then-verify). The installed_modules ROWS die with the tenant D1 (teardownTenant
 * deletes the studio worker first, so discovery is already dark, then the D1). Best-effort: every
 * failure is collected, never thrown, so one stuck script cannot strand the rest (a live-configured
 * module worker is exactly what must not be left behind).
 */
export async function teardownTenantModules(
  deps: TenantModuleDeps,
  tenantId: string,
): Promise<{
  ok: boolean;
  failures: { resource: string; error: string }[];
  absent: { resource: string; detail: string }[];
}> {
  const failures: { resource: string; error: string }[] = [];
  const absent: { resource: string; detail: string }[] = [];
  const prefix = tenantModuleScriptPrefix(tenantId);
  let scripts: string[];
  try {
    scripts = (await deps.cf.listNamespaceScripts(deps.moduleNamespace)).filter((s) => s.startsWith(prefix));
  } catch (e) {
    // Cannot list => cannot prove anything is gone. Report it; do not claim a clean teardown.
    return { ok: false, failures: [{ resource: "modules_list", error: String(e) }], absent };
  }
  for (const script of scripts) {
    try {
      await deps.cf.deleteUserWorker(deps.moduleNamespace, script);
    } catch (e) {
      // Same classification as the studio worker (cp#110). Here it is a RACE rather than the common
      // case -- these names came out of the listing moments ago -- but a script that vanished
      // between the list and the delete is still in the state this loop wanted, and the census
      // below is what proves it. Only a real error (403, 500, a 404 with no code) keeps a failure.
      if (isScriptAbsent(e)) {
        absent.push({ resource: `module:${script}`, detail: String(e) });
        deps.log("teardown.module_absent", { tenant: tenantId, script, error: String(e) });
        continue;
      }
      failures.push({ resource: `module:${script}`, error: String(e) });
      deps.log("teardown.module_failed", { tenant: tenantId, script, error: String(e) });
    }
  }
  // Census: prove zero scripts with the prefix remain (verify-before-declare, per the ruling).
  try {
    const remaining = (await deps.cf.listNamespaceScripts(deps.moduleNamespace)).filter((s) => s.startsWith(prefix));
    if (remaining.length > 0) {
      failures.push({
        resource: "modules_census",
        error: `${remaining.length} module script(s) still resident: ${remaining.join(", ")}`,
      });
    }
  } catch (e) {
    failures.push({ resource: "modules_census", error: String(e) });
  }
  return { ok: failures.length === 0, failures, absent };
}

// ---------------------------------------------------------------------------
// cf#114: module credential-readiness probe
// ---------------------------------------------------------------------------

/**
 * BUDGET (cf#112 / cf#113). This probe runs inside the INVOKE-KEY ROUTE, not a waitUntil job, so it
 * is bounded by a request the customer is actively waiting on. 10s across ALL FIVE modules, not 10s
 * each: every round probes the still-pending scripts CONCURRENTLY, so the deadline is wall-clock for
 * the whole set. Five sequential deadlines would be a 50s route, which is a hang wearing a fix.
 *
 * It either fits this budget or fails honestly. It never sleeps past it.
 */
export const MODULE_READY_PROBE_DEADLINE_MS = 10_000;
const MODULE_READY_BACKOFF_MS = [250, 500, 1000, 2000] as const;

/**
 * The /ready envelope, as the module contract defines it (vivijure-cf#114).
 *
 * NOT booleans only, and that line is what this file used to say. `telemetry.job_log` is a
 * tri-state STRING as of vivijure-cf 815c9ff0 (cp#378); the rest of the envelope is booleans.
 */
interface ModuleReadyBody {
  ok?: boolean;
  module?: string;
  credentials?: { runpod_api_key?: boolean; runpod_endpoint_id?: boolean };
  /**
   * vivijure-cf#279: can the version the edge SERVES record a RunPod job at all. Deliberately NOT
   * part of the module ok flag (telemetry must never gate a render), which is exactly why nothing
   * waits on it and it has to be LOOKED at -- see probeTenantModuleReadiness.
   *
   * TYPED `unknown` ON PURPOSE, and this is the defect cp#378 fixes. This field was declared
   * `boolean` while the modules had emitted a tri-state STRING since vivijure-cf 815c9ff0
   * (2026-08-01). A `typeof === "boolean"` test does not throw on a string, it just answers no,
   * so every module read `null` for twelve days and the readiness route could prove nothing.
   * Declaring the WIRE type as what it is (unparsed input) and refusing in ONE audited place is
   * what stops the next shape change from being silent -- a narrower declaration here would only
   * move the lie from the parser to the type.
   *
   * Optional because a module image published before cf#279 does not report it. An absent field is
   * unknown, never false. See parseJobLogReadiness for every shape this accepts.
   */
  telemetry?: { job_log?: unknown };
}

/**
 * What one /ready answer means. This classification IS the line between a wait and a cover-up, so it
 * is a pure function with its own tests rather than inline branching.
 *
 *  - "ready"           both credentials readable on the version the edge serves. Done.
 *  - "not_visible_yet" endpoint id present, key absent. THE ONLY RETRYABLE SHAPE: the endpoint id is
 *                      bound at upload and the key is written later, so this exact combination is
 *                      what propagation looks like and nothing else is.
 *  - "no_ready_route"  404: a module image published before /ready existed. Not retryable (waiting
 *                      cannot make an endpoint appear) and not a failure of the key install.
 *  - "misconfigured"   any other shape, including the endpoint id being ABSENT. That is a real
 *                      provisioning defect: the endpoint id is bound at upload, so if it is missing
 *                      the upload is wrong and no amount of waiting fixes it. Fails immediately --
 *                      spending the window on it would be pretending it might resolve.
 */
export type ModuleReadyVerdict = "ready" | "not_visible_yet" | "unverifiable" | "misconfigured";

/**
 * `expectedModule` is checked against the manifest name the module ECHOES back. That echo is the
 * only defence on the answering path against probing the WRONG script: script names are
 * tenant-prefixed and derived, so a naming bug would otherwise read a healthy neighbour as proof
 * that THIS module is ready. A mismatch is a hard failure, never a wait.
 *
 * On the 404 path there is no echo to check, and that is a limit worth stating plainly rather than
 * papering over: a 404 means "no module answered GET /ready at this script name", which is a module
 * image predating the endpoint OR a script that is not there at all. The two are INDISTINGUISHABLE
 * from here, so the verdict is named `unverifiable` (not `no_ready_route`, which would assert the
 * first reading) and the reported detail says both.
 */
export function classifyReadyResponse(status: number, text: string, expectedModule: string): ModuleReadyVerdict {
  if (status === 404) return "unverifiable";
  if (status !== 200) return "misconfigured";
  let body: ModuleReadyBody;
  try {
    body = JSON.parse(text) as ModuleReadyBody;
  } catch {
    // A 200 that is not the contract envelope is not evidence of anything. Refuse honestly rather
    // than reading a malformed body optimistically.
    return "misconfigured";
  }
  // The echo has to MATCH. A module that answers as something else means we are talking to the wrong
  // script, and treating its credentials as this module's would be a false pass of the worst kind.
  if (typeof body.module !== "string" || body.module !== expectedModule) return "misconfigured";
  const creds = body.credentials;
  if (!creds || typeof creds.runpod_api_key !== "boolean" || typeof creds.runpod_endpoint_id !== "boolean") {
    return "misconfigured";
  }
  if (creds.runpod_api_key && creds.runpod_endpoint_id) return "ready";
  if (creds.runpod_endpoint_id && !creds.runpod_api_key) return "not_visible_yet";
  return "misconfigured";
}

/**
 * What a module says about its ability to RECORD a RunPod job (vivijure-cf `JobLogReadiness`).
 *
 * THIS IS ONE HALF OF A CROSS-REPO CONTRACT. The other half is `modules/_shared/runpod-job-log.ts`
 * in vivijure-cf, and nothing in THIS repo can keep the two in step -- a rename there is invisible
 * here until something reads a real module. That is not a gap this file can close; it is closed by
 * the live pre-deploy smoke, which drives real modules and REFUSES a value it does not recognise
 * rather than coercing it (tests/pre-deploy-smoke.live.test.ts). Asserting these literals against
 * each other inside this repo would be a self-consistency check wearing an integration test's
 * clothes.
 */
export type JobLogReadiness = "ok" | "unavailable" | "unknown";

/** The union, enumerable, so a matcher over it prints a denominator instead of hardcoding three. */
export const JOB_LOG_READINESS_VALUES: readonly JobLogReadiness[] = ["ok", "unavailable", "unknown"];

/**
 * Read `telemetry.job_log` off a /ready body. THE ONE PLACE this shape is interpreted.
 *
 * TOTAL, and deliberately so -- every input lands somewhere named, and NOTHING lands on "ok"
 * except an explicit yes. The mapping:
 *
 *   "ok" | "unavailable" | "unknown"   the current contract, carried through verbatim.
 *   true                               LEGACY (pre-815c9ff0) yes  -> "ok".
 *   false                              LEGACY no                  -> "unavailable".
 *   absent / undefined                 -> null. The image predates cf#279 and cannot say.
 *   anything else                      -> null, and the caller records the raw value.
 *
 * WHY LEGACY BOOLEANS ARE STILL ACCEPTED. A tenant pinned to a `modules_release` older than
 * 815c9ff0 still emits booleans, and its modules still record perfectly well. Dropping those
 * tenants to `null` would report a WORKING telemetry binding as unprovable, which is the same
 * class of false alarm cp#378 exists to end, pointed the other way. Backward compatibility here
 * is not politeness, it is the difference between a correct answer and a manufactured incident.
 *
 * WHY AN UNRECOGNISED STRING IS NOT "unknown". "unknown" is a module SAYING it could not tell.
 * An unrecognised value means the two repos' contracts have diverged, which is a code defect with
 * a different remedy, so it must not be laundered into a state the module can legitimately report.
 * It returns null (this plane got no usable answer) and the raw value is surfaced in `detail`.
 */
export function parseJobLogReadiness(raw: unknown): JobLogReadiness | null {
  if (typeof raw === "boolean") return raw ? "ok" : "unavailable";
  if (typeof raw === "string" && (JOB_LOG_READINESS_VALUES as readonly string[]).includes(raw)) {
    return raw as JobLogReadiness;
  }
  return null;
}

/**
 * True when the module sent a job_log value this plane does not understand, as opposed to sending
 * nothing. Both parse to null; only this one means the contract moved.
 */
export function isUnrecognisedJobLog(raw: unknown): boolean {
  return raw !== undefined && parseJobLogReadiness(raw) === null;
}

/**
 * ONE module observation from a SINGLE unauthenticated GET /ready: what the running worker says
 * about itself, verbatim and unjudged.
 *
 * Separate from classifyReadyResponse on purpose. That function decides whether to WAIT or FAIL a
 * key install, and telemetry must never be an input to it: a module without a job log still renders,
 * and making readiness depend on telemetry would convert a reporting gap into an outage. This shape
 * is the other half -- the thing an operator LOOKS at, which is the only way a field that gates
 * nothing ever gets seen (cp#248).
 */
export interface TenantModuleObservation {
  module: string;
  /** The tenant-prefixed script actually probed. Named so a wrong-script read is diagnosable. */
  script: string;
  status: number;
  /** The module own ok flag, or null when nothing parseable answered as this module. */
  ok: boolean | null;
  credentials: { runpod_api_key: boolean; runpod_endpoint_id: boolean } | null;
  /**
   * Whether the RUNNING worker resolved TELEMETRY_DB (vivijure-cf#279), as the module said it.
   *
   * FOUR VALUES, AND THE FOURTH IS THE WHOLE REASON THIS IS NOT A BOOLEAN (cp#378):
   *
   *   "ok"           the binding resolved in the running worker. The ONLY value that proves it.
   *   "unavailable"  the worker answered that it CANNOT record. A real defect, and a measurement.
   *   "unknown"      the worker PROBED and could not tell. Also a measurement, and not the same
   *                  fact as the one below.
   *   null           this worker reported no such field, or nothing answered as this module. The
   *                  image predates cf#279. NOT a no, and NOT the module saying "unknown".
   *
   * THE LAST TWO ARE WHY THIS FIELD DID NOT BECOME `boolean | null` WITH "unknown" MAPPED TO null.
   * That mapping is lossy in the one direction an operator acts on: "unknown" is fixed by looking
   * at the telemetry binding, null is fixed by moving `modules_release` forward. Collapsed, one
   * null would carry both remedies and the reader would be sent to whichever the prose named --
   * which is exactly how the comment on the readiness route sent a reader to a stale pin while THIS
   * bug was the cause. A field cannot be allowed to repeat the defect its own route was reported for.
   */
  job_log: JobLogReadiness | null;
  /** Whether this module records RunPod jobs at all. A module that submits no job is EXPECTED to
   *  report no job_log and must not read as a gap. */
  records_runpod_jobs: boolean;
  /**
   * WHAT EVERY SAMPLE SAID, in order (cp#254).
   *
   * The route reports `job_log` from the LAST sample. That value is a reading, not a conclusion,
   * and this array is what lets a caller tell those apart: `["unavailable","ok"]` and
   * `["ok","ok"]` produce the same `job_log` and mean completely different things. The first is a
   * module mid-convergence whose answer will change again; the second is a module that said the
   * same thing twice.
   *
   * WHY THE READS ARE REPORTED RATHER THAN RESOLVED. cp#254 considered settling inside the route by
   * retrying until the answer stops changing, and ruled against it for a reason that has not
   * changed: the case that needs settling is exactly the case where the answer keeps changing, so a
   * bounded retry there either returns an arbitrary value or has to fail. This route is a cheap
   * question an operator asks, not a promotion gate; it says what it saw and how many times, and
   * the caller decides.
   */
  readings: ModuleReadingState[];
  /** The denominator, so a reader does not have to count `readings` to know what `settled` rests on. */
  reads: number;
  /**
   * Every sample agreed. NOT "converged", and the difference is load-bearing.
   *
   * The measured convergence window on the replace path is 40 to 50 seconds (cp#254) and the gap
   * between samples is 250ms, so two samples that agree can still be two reads of the same
   * transient. `settled: true` therefore means only this: nothing in this probe contradicted the
   * reported value. `settled: false` is the strong direction -- it is positive proof the reading is
   * mid-convergence and must not be acted on.
   *
   * FALSE WHEN FEWER THAN TWO SAMPLES WERE TAKEN, deliberately. A single sample agrees with itself,
   * so deriving `settled` from one read would produce a flag that can never be false: a green that
   * cannot go red, which is the exact defect class this field exists inside.
   */
  settled: boolean;
  /** Bounded response head, present when nothing usable was parsed. The 404 disjunction (stale
   *  image / absent script / control plane cannot dispatch) is diagnosable only from what came back.
   *
   *  ALSO set when the body parsed fine but `telemetry.job_log` carried a value this plane does not
   *  recognise. Absent-field and unrecognised-value both read `job_log: null`, and without the raw
   *  value beside it an operator cannot tell "the pin is old" from "the contract moved". */
  detail?: string;
}

/**
 * Short pause between the /ready samples on the operator module-readiness path (cp#254).
 *
 * WHAT THIS GAP IS FOR, AND WHAT IT IS NOT FOR. It is NOT an attempt to outrun the convergence
 * window. The window was MEASURED in the cp#254 thread at 40 to 50 seconds on the replace path
 * (sequences TFTFFF and FTFFF), so 250ms sits entirely inside it and no gap this route could afford
 * would sit outside it. The gap exists so that two adjacent samples can DISAGREE, which is the only
 * thing this route can honestly detect. Agreement across a 250ms gap is weak evidence and is
 * reported as exactly that; disagreement is proof the reading is mid-convergence.
 *
 * The earlier reading of this constant (#349) was that the second sample is the better answer. It
 * is not: two reads inside one transient are two reads of the same transient, and returning the
 * later one launders it, because a second agreeing read reads as corroboration. See
 * probeTenantModuleReadiness.
 */
export const MODULE_READINESS_PROBE_GAP_MS = 250;

/**
 * How many /ready samples the operator readiness probe takes per module (cp#254).
 *
 * TWO IS THE FLOOR, NOT A TUNING CHOICE. `settled` below is "every sample agreed", and a single
 * sample agrees with itself by construction -- a one-sample probe could only ever report
 * `settled: true`, which is a flag that cannot go red. Dropping this to 1 does not weaken the
 * signal, it deletes it, and the suite says so rather than passing quietly.
 */
export const MODULE_READINESS_SAMPLES = 2;

/**
 * What ONE /ready sample said about a module ability to record, as a single named state (cp#254).
 *
 * THE FOURTH AND FIFTH STATES ARE THE POINT. `job_log` alone cannot carry them: an unreachable
 * probe and a module that answered without the field both read `null` there, and the #255 smoke had
 * to invent a separate `x` glyph for the first because they have completely different causes (the
 * control plane cannot dispatch, versus the tenant module image is old). Keeping them apart per
 * sample is what makes a sequence like `x x ok` legible instead of looking like a flap.
 *
 *   "ok" | "unavailable" | "unknown"  what the module said, verbatim (see JobLogReadiness).
 *   "absent"                          the module answered AS ITSELF but carried no usable job_log:
 *                                     the field was missing, or the value is one this plane does
 *                                     not recognise. `detail` on the observation separates those.
 *   "unreachable"                     nothing answered as this module: a non-200, an unparseable
 *                                     body, or an answer echoing a DIFFERENT module name. This is
 *                                     not a statement about the module at all.
 */
export type ModuleReadingState = JobLogReadiness | "absent" | "unreachable";

/** One sample, before the samples of a run are folded into an observation. */
type ModuleSample = Omit<TenantModuleObservation, "readings" | "reads" | "settled"> & {
  reading: ModuleReadingState;
};

async function observeTenantModulesOnce(
  deps: TenantModuleDeps,
  tenantId: string,
): Promise<ModuleSample[]> {
  return await Promise.all(
    TENANT_MODULE_CATALOG.map(async (spec) => {
      const script = tenantModuleScriptName(tenantId, spec.module);
      const res = await deps.callTenantModule(script, "/ready");
      const base = {
        module: spec.module,
        script,
        status: res.status,
        records_runpod_jobs: Boolean(spec.recordsRunpodJobs),
      };
      let body: ModuleReadyBody | null = null;
      if (res.status === 200) {
        try {
          body = JSON.parse(res.text) as ModuleReadyBody;
        } catch {
          body = null;
        }
      }
      // The SAME echo check the key-install probe makes, and for the same reason: script names are
      // tenant-prefixed and derived, so an answer from a neighbouring script would otherwise be read
      // as this module answering. A mismatch is not evidence about this module at all.
      if (!body || body.module !== spec.module) {
        return {
          ...base,
          ok: null,
          credentials: null,
          job_log: null,
          // NOT "absent". Nothing answered as this module, so this sample says nothing about the
          // module at all -- collapsing it into "the module reported no field" would put a control
          // plane dispatch failure and a stale tenant image under one word.
          reading: "unreachable" as const,
          detail: res.text.slice(0, 200) || "(empty)",
        };
      }
      const creds = body.credentials;
      const rawJobLog = body.telemetry?.job_log;
      const jobLog = parseJobLogReadiness(rawJobLog);
      return {
        ...base,
        reading: jobLog ?? ("absent" as const),
        ok: typeof body.ok === "boolean" ? body.ok : null,
        credentials:
          creds && typeof creds.runpod_api_key === "boolean" && typeof creds.runpod_endpoint_id === "boolean"
            ? { runpod_api_key: creds.runpod_api_key, runpod_endpoint_id: creds.runpod_endpoint_id }
            : null,
        job_log: jobLog,
        // A value we do not recognise is reported, never swallowed. It reads null like an absent
        // field does, and only this string separates "the pin is old" from "the contract moved".
        ...(isUnrecognisedJobLog(rawJobLog)
          ? { detail: `unrecognised telemetry.job_log: ${JSON.stringify(rawJobLog).slice(0, 100)}` }
          : {}),
      };
    }),
  );
}

/**
 * Probe every catalog module for one tenant and report what each said, AND how sure that is.
 *
 * READ-ONLY and free: /ready costs no GPU, spends nothing, and needs no tenant credential. This is
 * an operator asking a question, not a gate deciding a promotion -- so it is NOT the multi-second
 * wait that `awaitTenantModulesReady` runs.
 *
 * IT SAMPLES TWICE AND DISCARDS NOTHING (cp#254). #349 (`bf35182be2`) sampled twice and returned
 * the SECOND read, discarding the first. That is the option cp#254 ruled against, and against the
 * measured data it is worse than one sample rather than better: the convergence window is 40 to 50
 * seconds, the gap is 250ms, so both samples land inside one transient. On the reproduced FTFFF
 * sequence, taking the second read reports "ok" for a worker with no database bound -- and it now
 * looks corroborated, because two reads were taken.
 *
 * So both reads are KEPT. `job_log` is still the last sample, because a route has to report
 * something and the newest read is the least stale one; `readings`, `reads` and `settled` are what
 * say whether that value can be acted on. An operator who needs a settled answer re-asks after the
 * window, which is the thing this route is cheap enough to allow.
 *
 * Injectable `timing` keeps the gap testable without burning real wall clock; injectable `samples`
 * exists so the one-sample floor is a path a test can DRIVE rather than a claim in a comment.
 */
export async function probeTenantModuleReadiness(
  deps: TenantModuleDeps,
  tenantId: string,
  timing: ProbeTiming = realTiming,
  gapMs: number = MODULE_READINESS_PROBE_GAP_MS,
  samples: number = MODULE_READINESS_SAMPLES,
): Promise<TenantModuleObservation[]> {
  const rounds: ModuleSample[][] = [];
  for (let i = 0; i < Math.max(1, samples); i += 1) {
    if (i > 0) await timing.sleep(gapMs);
    rounds.push(await observeTenantModulesOnce(deps, tenantId));
  }
  return foldModuleSamples(rounds);
}

/**
 * Fold the per-round samples into one observation per module.
 *
 * Keyed by MODULE NAME rather than by array position. Both rounds walk the same catalog so the
 * positions do line up today, but a positional fold would attach one module readings to another
 * module observation the moment that stopped being true, and it would do it silently -- the same
 * wrong-script hazard the echo check upstream exists to refuse, moved into the merge.
 */
function foldModuleSamples(rounds: ModuleSample[][]): TenantModuleObservation[] {
  const last = rounds[rounds.length - 1];
  return last.map((sample) => {
    const readings = rounds
      .map((round) => round.find((s) => s.module === sample.module))
      .filter((s): s is ModuleSample => s !== undefined)
      .map((s) => s.reading);
    const { reading: _dropped, ...rest } = sample;
    return {
      ...rest,
      readings,
      reads: readings.length,
      // TWO CONDITIONS, and the length one is not defensive padding: with one read the `every` below
      // is vacuously true, so without it this flag could never be false. See the field doc.
      settled: readings.length >= 2 && readings.every((r) => r === readings[0]),
    };
  });
}

/**
 * The two summaries the readiness route publishes beside the raw observations (cp#254).
 *
 * A NAMED FUNCTION RATHER THAN INLINE ROUTE CODE so the probe and the summary can be driven as one
 * chain in a test with nothing stubbed between them. The defect this replaces was invisible at the
 * probe (which returned a plausible value) and invisible at the route (which faithfully summarised
 * it); it was only visible in the pair.
 */
export interface ModuleReadinessSummary {
  /**
   * Modules that submit RunPod jobs and were NOT SHOWN to be able to record one.
   *
   * "ok" IS THE ONLY PASS, and it must be an "ok" every sample agreed on. The test is written as
   * `!(ok && settled)` rather than as a list of failing values ON PURPOSE: a list has to be
   * maintained against a contract in another repo, and the day it falls behind, the new value it
   * has never heard of falls through as PROVEN. Inverting it means an unrecognised state, and an
   * unsettled one, are unproven by default -- the safe direction, and the one that stays safe
   * without anyone remembering to update this line.
   *
   * "unavailable", "unknown", null and unsettled are ALL in here on purpose: "the binding is
   * missing", "the worker could not tell", "this image is too old to say" and "the reading is still
   * moving" are four different problems with one consequence for an operator about to act (rows
   * nobody will get, or a decision resting on a value that will change). They stay distinguishable
   * per module in the observations; this summary deliberately does not rank them.
   */
  records_unproven: string[];
  /**
   * Modules whose samples DISAGREED, so their reported value is mid-convergence.
   *
   * NOT filtered to the recording modules, unlike the field above. This is a statement about the
   * quality of the reading, not about telemetry: a module flapping between unreachable and
   * answering tells an operator the probe itself is not settled, and that is worth seeing whether
   * or not that module records anything.
   */
  unsettled: string[];
}

export function summariseModuleReadiness(
  modules: readonly TenantModuleObservation[],
): ModuleReadinessSummary {
  return {
    records_unproven: modules
      .filter((m) => m.records_runpod_jobs && !(m.job_log === "ok" && m.settled))
      .map((m) => m.module),
    unsettled: modules.filter((m) => !m.settled).map((m) => m.module),
  };
}

/**
 * One module that could not be PROVEN ready, and why. Reported per module, never swallowed and never
 * collapsed into a single summary string: a mixed fleet (some modules answering, some not) has to
 * name EVERY module that went unproven or the operator cannot act on it.
 */
export interface UnverifiedModule {
  module: string;
  /** Deliberately not "no_ready_route": from a 404 we cannot tell WHICH cause it was. */
  reason: "unverifiable";
  detail: string;
  /** The script actually probed. Named so a wrong-script bug is diagnosable from the report alone. */
  script: string;
}

/** The outcome the invoke-key route reports to the tenant. */
export interface ModuleReadiness {
  verified: string[];
  unverified: UnverifiedModule[];
  /**
   * Modules still in the not_visible_yet shape when the deadline expired (control-plane#17).
   *
   * DISTINCT FROM `unverified` on purpose. `unverified` means we could not observe the module at
   * all (nothing answered). `unconfirmed` means the module answered honestly that it cannot see the
   * key YET -- the key install genuinely succeeded, the condition is benign, and it resolves itself.
   * That deserves a soft, actionable answer rather than a failure.
   *
   * It does NOT deserve a live flip: an unconfirmed module is exactly the run-5 state this whole
   * design exists to keep customers out of. Soft response, tenant stays gated.
   */
  unconfirmed: string[];
  /**
   * Catalog modules this probe DELIBERATELY did not ask, because they carry no RunPod credential to
   * propagate and this contract is about RunPod credential propagation (cf#114).
   *
   * REPORTED RATHER THAN SILENT, and that is the whole reason the field exists. A module dropped
   * from a probe's population is indistinguishable from a module the probe forgot, and "deliberately
   * excluded" and "never looked at" must not render identically -- that is the shape this file's own
   * `unverifiable` vocabulary was written to avoid, applied to the population instead of the verdict.
   * A reader counting `verified + unverified + unconfirmed + notProbed` gets the catalog back.
   */
  notProbed: string[];
  attempts: number;
  elapsedMs: number;
}

/**
 * Wait until every tenant module script SERVES its freshly-installed key (cf#114).
 *
 * Called after the key-B fan-out and BEFORE the tenant flips to live, which is the whole point: the
 * window this closes is the one between "the secret was written" and "the version the edge serves
 * can read it". A throw here leaves the tenant at awaiting_invoke_key rather than promoting it to
 * live on credentials nothing has proven, which is the correct failure.
 *
 * OLD MODULE IMAGES (404). A module published before /ready existed cannot answer, and hard-failing
 * on that would mean a tenant pinned to an older release can no longer install a key at all -- worse
 * than the defect being fixed. It is also not something waiting can resolve. So it is neither
 * retried nor fatal: it is recorded as UNVERIFIED and reported explicitly in the route response and
 * the log. The install genuinely succeeded; what we cannot do is prove propagation. Saying so is
 * honest. Silently treating it as ready would be the fake guarantee this whole design rejected.
 * This path is transitional -- it disappears once the pinned release carries /ready everywhere.
 */
export async function awaitTenantModulesReady(
  deps: TenantModuleDeps,
  tenantId: string,
  timing: ProbeTiming = realTiming,
  deadlineMs: number = MODULE_READY_PROBE_DEADLINE_MS,
  /**
   * The catalog this probe derives its population from. Injected for the SAME reason `timing` is:
   * the empty-population floor below is a real refusal path, and a guard that cannot be driven is a
   * guard nobody has watched fail. Production never passes it.
   */
  catalog: readonly TenantModuleSpec[] = TENANT_MODULE_CATALOG,
): Promise<ModuleReadiness> {
  const started = timing.now();
  let attempts = 0;
  const verified: string[] = [];
  const unverified: UnverifiedModule[] = [];
  // THE POPULATION IS THE RUNPOD-REACHING SET, NOT THE CATALOG, and getting that wrong was a
  // launch blocker rather than a nicety.
  //
  // WHAT WENT WRONG. This contract asks one question -- can the version the edge serves READ ITS
  // RUNPOD CREDENTIAL (cf#114) -- and classifyReadyResponse enforces it by requiring boolean
  // `runpod_api_key` and `runpod_endpoint_id` in the body. `plan-enhance` reaches Anthropic through
  // the AI Gateway and submits no RunPod job, so it answers with `gateway_id` / `cf_aig_token` and
  // carries neither required field. That falls to `misconfigured`, which is explicitly NOT
  // retryable and THROWS -- so every invoke-key install failed, for every tenant, in every mode.
  //
  // It was armed by a change that made things BETTER: vivijure-cf#308 extended GET /ready from 6
  // modules to 26. Before it, plan-enhance had no /ready at all, answered 404, and classified
  // `unverifiable` -- recorded and benign. After it, the same module answers 200 in a shape this
  // contract does not accept. A COVERAGE IMPROVEMENT CONVERTED A BENIGN 404 INTO A FATAL VERDICT
  // on the critical path of every tenant going live, and it is invisible to both repos' suites
  // because each half is correct on its own. Only the cross-repo pair is wrong (cf#403).
  //
  // KEYED ON reachesRunpod. Why that predicate and not a fresh one derived from the catalog is
  // stated ONCE, at the definition of reachesRunpod -- three uses, three wrong first attempts, and
  // the rule for a fourth. Pointer rather than a second copy: this file already carries the lesson
  // that a hand-maintained duplicate of one fact drifts by construction.
  let pending = catalog.filter(reachesRunpod).map((spec) => spec.module);
  const notProbed = catalog.filter((spec) => !reachesRunpod(spec)).map((s) => s.module);
  // POSITIVE-EVIDENCE FLOOR. An empty population would make this function return a clean readiness
  // for a tenant nothing was ever asked about -- a green that cannot go red, which is precisely the
  // failure class this probe exists inside. If the predicate ever excludes everything, that is a
  // defect in the catalog or the predicate and it must be loud, never a pass.
  if (pending.length === 0) {
    throw new TenantModuleError(
      "verify",
      `no RunPod-reaching modules in a catalog of ${catalog.length}: refusing to report ` +
        "readiness for a tenant whose module set was never probed (reachesRunpod excluded every row)",
    );
  }
  let last = "";

  for (;;) {
    attempts += 1;
    const results = await Promise.all(
      pending.map(async (moduleName) => {
        const scriptName = tenantModuleScriptName(tenantId, moduleName);
        const res = await deps.callTenantModule(scriptName, "/ready");
        return { moduleName, scriptName, res, verdict: classifyReadyResponse(res.status, res.text, moduleName) };
      }),
    );
    const elapsedMs = timing.now() - started;

    const stillPending: string[] = [];
    for (const r of results) {
      if (r.verdict === "ready") {
        verified.push(r.moduleName);
      } else if (r.verdict === "unverifiable") {
        unverified.push({
          module: r.moduleName,
          reason: "unverifiable",
          script: r.scriptName,
          // HONEST about the ambiguity: a 404 here is "nothing answered GET /ready", and it has at
          // least three causes we CANNOT tell apart from this layer:
          //   1. the module image predates the endpoint (a stale release pin);
          //   2. no module is present under this script name (wrong name / failed upload);
          //   3. the probe never left the control plane at all -- callTenantModule returns a
          //      SYNTHETIC 404 when TENANT_MODULE_DISPATCH is unbound, which is a CP deploy defect
          //      and has nothing to do with the tenant or the release.
          // The module echo that would disambiguate only exists on an ANSWERING response, so naming
          // any one of these as THE cause would send an operator chasing the wrong system -- cause 3
          // pointed at a release pin is exactly the wrong-system trap. Hence the disjunction, plus
          // the raw response text, which is where the "TENANT_MODULE_DISPATCH not bound" sentinel
          // actually distinguishes cause 3 for whoever reads it.
          detail:
            `${r.scriptName} did not answer GET /ready (404): either the module image predates ` +
            "/ready, or the probe could not reach it (no module under that script name, or the " +
            "control plane cannot dispatch to the module namespace). Credential propagation could " +
            "not be verified either way. Response: " +
            `${r.res.text.slice(0, 200) || "(empty)"}. ` +
            "Check that response first: if it names a missing binding the defect is in the control " +
            "plane deploy, not the tenant; otherwise re-provision against a release that carries " +
            "/ready, and if it still 404s the script is missing, not stale",
        });
      } else if (r.verdict === "misconfigured") {
        // NOT retryable. Failing now rather than spending the window pretending this might resolve
        // is what stops the retry from laundering a real misconfiguration into a success.
        throw new TenantModuleError(
          "verify",
          `module ${r.moduleName} (${r.scriptName}) /ready -> ${r.res.status}: ` +
            `${r.res.text.slice(0, 200)} (not retryable; attempts=${attempts}, elapsed=${elapsedMs}ms)`,
        );
      } else {
        stillPending.push(r.moduleName);
        last = `${r.moduleName}: ${r.res.status} ${r.res.text.slice(0, 120)}`;
      }
    }
    pending = stillPending;

    if (pending.length === 0) {
      deps.log("modules_ready", {
        tenant: tenantId,
        attempts,
        elapsedMs,
        verified: verified.length,
        unverified: unverified.map((u) => u.module),
        // THE DENOMINATOR, beside the result: `probed` and `catalog` together make a shrunken
        // population visible instead of inferable. A verified count alone reads identically whether
        // the probe asked fourteen modules or one.
        probed: verified.length + unverified.length,
        catalog: catalog.length,
        notProbed,
      });
      return { verified, unverified, unconfirmed: [], notProbed, attempts, elapsedMs };
    }

    const wait = MODULE_READY_BACKOFF_MS[Math.min(attempts - 1, MODULE_READY_BACKOFF_MS.length - 1)];
    if (elapsedMs + wait >= deadlineMs) {
      // DEADLINE with everything still in the not_visible_yet shape (control-plane#17).
      //
      // This is NOT a failure and must not be reported as one. Every module here answered /ready
      // honestly saying the endpoint id is bound and the key is not readable YET; the secrets PUT
      // already succeeded; the condition is propagation and it resolves on its own. Measured live on
      // 2026-07-18: a first-ever key write to five fresh module scripts exceeded a 10s deadline and
      // passed about a minute later. Failing that customer -- worse, failing them opaquely -- was the
      // defect, not the propagation.
      //
      // The line this must never cross: ONLY this shape gets the soft outcome. Every `misconfigured`
      // verdict already threw above, immediately, before any waiting. Widening this to cover a real
      // misconfiguration would be exactly the laundering the design refuses.
      deps.log("modules_unconfirmed", {
        tenant: tenantId,
        attempts,
        elapsedMs,
        unconfirmed: pending,
        last,
      });
      return { verified, unverified, unconfirmed: [...pending], notProbed, attempts, elapsedMs };
    }
    await timing.sleep(wait);
  }
}
