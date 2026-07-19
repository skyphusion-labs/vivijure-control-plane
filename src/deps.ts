// The control plane's ONE injectable seam (#52).
//
// This is the productionReindexDeps discipline from the studio: production has exactly one wiring
// function, tests replace the whole bundle, and there is no second code path that only tests take.
// A stubbed dep set proves a decision path; it never proves the shipped artifact, which is why
// productionDeps() is what the live wrangler dev verify drives.

import { r2StudioBundleSource } from "./bundle-r2";
import { r2ModuleBundleSource } from "./module-bundle-r2";
import { CfApi } from "./cf-api";
import type { ControlPlaneEnv } from "./env";
import type { MailSender } from "./email";
import { posternSender } from "./email";
import {
  continueProvisionJob,
  preflightModuleUpgrade,
  runProvisionJob,
  teardownTenant,
  upgradeTenantModules,
  type ModuleUpgradeContext,
  type ModuleUpgradePreflight,
  type ProvisionDeps,
} from "./provisioner";
import { createTenantEndpoints } from "./runpod";
import type { ControlPlaneStore, Tenant } from "./store";
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
import { decryptStudioToken } from "./token-crypto";
import { CfTokenMinter } from "./token-minter";
import {
  TENANT_MODULE_CATALOG,
  awaitTenantModulesReady,
  tenantModuleScriptName,
  type ModuleReadiness,
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
   * Install the VERIFIED invoke key as the tenant studio secret AND every tenant module script, then
   * PROVE the modules actually serve it before the caller flips the tenant live (cf#114). Throws on
   * API failure, and on a readiness probe that fails or times out -- the tenant then stays at
   * awaiting_invoke_key rather than being promoted on credentials nothing has proven.
   */
  installInvokeKey(tenant: Tenant, key: string): Promise<ModuleReadiness>;
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
  teardown(tenant: Tenant, opts: { deleteData: boolean }): Promise<{
    ok: boolean;
    failures: { resource: string; error: string }[];
  }>;
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
}

export function productionDeps(env: ControlPlaneEnv): ControlPlaneDeps {
  const store = new D1Store(env.CP_DB);
  return {
    store,
    mailer: posternSender(env),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    now: () => Date.now(),
    provisioner: provisionerWiring(env, store),
  };
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
  const deps: ProvisionDeps = {
    store,
    cf,
    runpod: { createEndpoints: (key, slug, r2) => createTenantEndpoints(key, slug, r2) },
    bundle: r2StudioBundleSource(STUDIO_RELEASES),
    // Module bundles ship in the SAME release mirror, per-module subpath (cf#99).
    moduleBundle: r2ModuleBundleSource(STUDIO_RELEASES),
    tokenMinter: new CfTokenMinter(cf),
    r2Endpoint: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    namespace: DISPATCH_NAMESPACE,
    moduleNamespace: TENANT_MODULE_NAMESPACE,
    release: STUDIO_RELEASE,
    tenantScriptName: (slug) => `tenant-${slug}-studio`,
    kek: STUDIO_TOKEN_KEK,
    // Always set a ceiling: a hosted tenant with no daily cap has no cost bound. Operator-tunable.
    spendDailyCeiling: env.TENANT_SPEND_DAILY_CEILING ?? "25",
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

  return {
    smokeClient: tenantStudioSmokeClient(env, STUDIO_TOKEN_KEK),
    async start(jobId, tenant, runpodApiKey) {
      // runProvisionJob records every outcome on the job row; the return value is the same fact.
      // A "yielded" outcome is normal under #112: progress is persisted and the next poll resumes.
      await runProvisionJob(deps, jobId, tenant, runpodApiKey);
    },
    async resume(jobId, tenant, stepsDone) {
      await continueProvisionJob(deps, jobId, tenant, stepsDone);
    },
    async installInvokeKey(tenant, key): Promise<ModuleReadiness> {
      if (!tenant.script_name) throw new Error("tenant has no studio worker to install the key on");
      // Key B lands on the studio AND every tenant module script (cf#99): the studio reads its own
      // RUNPOD_API_KEY, and each module worker reads it to reach RunPod. Rotates in place
      // (putScriptSecret, no re-upload). Module script names are deterministic from the tenant id.
      await cf.putScriptSecret(DISPATCH_NAMESPACE, tenant.script_name, TENANT_RUNPOD_SECRET, key);
      for (const spec of TENANT_MODULE_CATALOG) {
        await cf.putScriptSecret(
          TENANT_MODULE_NAMESPACE,
          tenantModuleScriptName(tenant.id, spec.module),
          TENANT_RUNPOD_SECRET,
          key,
        );
      }
      // cf#114: the secrets PUT returning 200 does NOT mean the edge serves the key yet. Prove it on
      // the modules before the caller promotes the tenant, or fail honestly saying we could not.
      return await awaitTenantModulesReady(deps, tenant.id);
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
export function tenantStudioSmokeClient(env: ControlPlaneEnv, kek: string): TenantStudioSmokeClient {
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
