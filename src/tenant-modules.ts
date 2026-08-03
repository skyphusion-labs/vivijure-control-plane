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
import { isScriptAbsent } from "./cf-api";
import {
  MODULE_PROXY_BASE_BINDING,
  MODULE_PROXY_TOKEN_BINDING,
  mintTenantProxyToken,
} from "./runpod-proxy-auth";
import type { TenantEndpoint } from "./provisioner";
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
 * The tenant module set = the 4 endpoint-backed capabilities (keyframe + own-gpu both ride the backend
 * endpoint; upscale / lipsync / audio-upscale each get their own). Every module here reads exactly
 * RUNPOD_ENDPOINT_ID + RUNPOD_API_KEY (verified against each module's Env), which is why the binding
 * set below is uniform. Extending the hosted tier is a row here plus the matching endpoint in runpod.ts.
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
 * THE PREDICATE THE PROXY PAIR ACTUALLY NEEDS, and it used to be `endpointKey` by accident. That
 * conflated "has an endpoint of ours" with "talks to RunPod", which was true while every
 * RunPod-reaching module was endpoint-backed and became false the moment the cost door arrived.
 * Keying the proxy on the wrong property would have left all eight on the DIRECT RunPod key on a
 * shared tenant -- a consumer holding a RunPod credential on our account, which CLAUDE.md forbids
 * outright ("a consumer reaches RunPod through our product or not at all").
 *
 * `plan-enhance` is still the negative case and still the only one: it reaches Anthropic through the
 * AI Gateway and submits no RunPod job, so the discipline the pair-binding comment describes is
 * unchanged and still has a real subject.
 */
export const reachesRunpod = (spec: TenantModuleSpec): boolean =>
  Boolean(spec.endpointKey) || Boolean(spec.publicEndpoint);

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

/** The slice of provisioner wiring the module orchestration needs. ProvisionDeps satisfies this
 *  structurally, so there is ONE wiring seam (deps.ts) and no second injection surface. */
export interface TenantModuleDeps {
  cf: CfApi;
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
  const scriptNames: string[] = [];
  for (const spec of TENANT_MODULE_CATALOG) {
    // A spec WITHOUT an endpointKey is not endpoint-backed (cf#56, plan-enhance) and legitimately
    // has no endpoint. A spec WITH one that the tenant lacks is still a loud failure, unchanged.
    const endpoint = spec.endpointKey ? endpoints.find((e) => e.key === spec.endpointKey) : undefined;
    if (spec.endpointKey && !endpoint) {
      throw new TenantModuleError(
        "modules_upload",
        `module ${spec.module} needs the ${spec.endpointKey} endpoint, which the tenant does not have`,
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
    if (reachesRunpod(spec)) {
      // cp#288: the pair that lets this module reach RunPod THROUGH the plane instead of holding a
      // RunPod-capable credential in the tenant namespace. Bound on every module that REACHES
      // RunPod -- a module that submits no RunPod job has nothing to send through a proxy, and
      // handing it a plane credential widens its reach for no gain (the TELEMETRY_DB discipline
      // above). `plan-enhance` is still the only such module and still the negative control.
      //
      // KEYED ON reachesRunpod, NOT ON endpointKey (cp#284). This block sat inside `if (endpoint)`,
      // which was correct only while every RunPod-reaching module was endpoint-backed. The eight
      // cost-door modules submit to PUBLIC vendor slugs with no endpoint of ours, so under the old
      // predicate they would have been uploaded to a SHARED tenant with no proxy pair, taken the
      // unbound branch of modules/_shared/runpod-route.ts, and reached RunPod on the direct
      // RUNPOD_API_KEY. That is a consumer holding a RunPod credential on our account, which
      // CLAUDE.md forbids outright. The predicate, not the population, was the defect.
      //
      // ADDITIVE ON PURPOSE, AND THE ORDERING IS LOAD-BEARING (cf#394). RUNPOD_API_KEY is still
      // installed on every module script by installInvokeKey (deps.ts) and nothing here touches
      // that. vivijure-cf teaches its modules to prefer this base and FALL BACK to the direct key
      // first; only after that has shipped and been verified may the plane stop installing the key.
      // Binding the pair before a module reads it costs two unread vars. Removing the key before a
      // module can fall back strands every render on that tenant.
      //
      // BOTH OR NEITHER. See MODULE_PROXY_BASE_BINDING: a base without a token is not a partial
      // rollout, it is a module that switches to the proxy and is refused 401 on every call.
      //
      // SHARED ONLY. See the runpodMode parameter: on any other shape the pair must not be bound at
      // all, because bound-and-refused is strictly worse than never bound.
      const proxied = runpodMode === "shared";
      const proxyToken =
        proxied && deps.runpodProxy ? await mintTenantProxyToken(deps.runpodProxy.signingKey, tenantId) : null;
      if (proxied && deps.runpodProxy && proxyToken) {
        bindings.push({
          type: "plain_text",
          name: MODULE_PROXY_BASE_BINDING,
          text: deps.runpodProxy.base,
        });
        // secret_text: it authenticates this tenant to OUR routes and is worthless anywhere else,
        // but it is still a credential. Deterministic per tenant, so a re-provision re-derives the
        // same value rather than leaving a second live one behind it.
        bindings.push({
          type: "secret_text",
          name: MODULE_PROXY_TOKEN_BINDING,
          text: proxyToken,
        });
      } else {
        // Named separately so the two reasons are distinguishable in the log: an unconfigured plane
        // and a tenant id the mint refuses are different problems with different repairs.
        // Three distinguishable reasons, because they have three different repairs: this tenant is
        // not on the shared tier (expected, and the overwhelmingly common case today), the plane
        // configures no proxy, or the mint refused this tenant id.
        deps.log("module.runpod_proxy_unbound", {
          tenant: tenantId,
          module: spec.module,
          mode: runpodMode,
          proxy: deps.runpodProxy ? "set" : "unset",
          token: proxyToken ? "set" : "unset",
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
    await deps.cf.uploadUserWorker({
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

/** The /ready envelope, as the module contract defines it (vivijure-cf#114). Booleans only. */
interface ModuleReadyBody {
  ok?: boolean;
  module?: string;
  credentials?: { runpod_api_key?: boolean; runpod_endpoint_id?: boolean };
  /**
   * vivijure-cf#279: can the version the edge SERVES record a RunPod job at all. Deliberately NOT
   * part of the module ok flag (telemetry must never gate a render), which is exactly why nothing
   * waits on it and it has to be LOOKED at -- see probeTenantModuleReadiness.
   *
   * Optional because a module image published before cf#279 does not report it. An absent field is
   * unknown, never false.
   */
  telemetry?: { job_log?: boolean };
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
   * Whether the RUNNING worker resolved TELEMETRY_DB (vivijure-cf#279).
   *
   * THREE VALUES, and collapsing them re-creates the defect this exists to end. true and false are
   * the worker own answer. null is "this worker reported no such field", which is a module image
   * predating cf#279, or a module that did not answer at all -- NOT a no. Reporting an absent field
   * as false would say the binding is missing when what is missing is the report.
   */
  job_log: boolean | null;
  /** Whether this module records RunPod jobs at all. A module that submits no job is EXPECTED to
   *  report no job_log and must not read as a gap. */
  records_runpod_jobs: boolean;
  /** Bounded response head, present when nothing usable was parsed. The 404 disjunction (stale
   *  image / absent script / control plane cannot dispatch) is diagnosable only from what came back. */
  detail?: string;
}

/**
 * Probe every catalog module for one tenant, once, and report what each said.
 *
 * READ-ONLY and free: /ready costs no GPU, spends nothing, and needs no tenant credential. No retry
 * and no deadline -- this is an operator asking a question, not a gate deciding a promotion, and a
 * retry loop here would blur "answered slowly" into "answered".
 */
export async function probeTenantModuleReadiness(
  deps: TenantModuleDeps,
  tenantId: string,
): Promise<TenantModuleObservation[]> {
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
          detail: res.text.slice(0, 200) || "(empty)",
        };
      }
      const creds = body.credentials;
      return {
        ...base,
        ok: typeof body.ok === "boolean" ? body.ok : null,
        credentials:
          creds && typeof creds.runpod_api_key === "boolean" && typeof creds.runpod_endpoint_id === "boolean"
            ? { runpod_api_key: creds.runpod_api_key, runpod_endpoint_id: creds.runpod_endpoint_id }
            : null,
        job_log: typeof body.telemetry?.job_log === "boolean" ? body.telemetry.job_log : null,
      };
    }),
  );
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
): Promise<ModuleReadiness> {
  const started = timing.now();
  let attempts = 0;
  const verified: string[] = [];
  const unverified: UnverifiedModule[] = [];
  let pending = TENANT_MODULE_CATALOG.map((spec) => spec.module);
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
      });
      return { verified, unverified, unconfirmed: [], attempts, elapsedMs };
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
      return { verified, unverified, unconfirmed: [...pending], attempts, elapsedMs };
    }
    await timing.sleep(wait);
  }
}
