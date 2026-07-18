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
import { continueProvisionJob, runProvisionJob, type ProvisionDeps } from "./provisioner";
import { createTenantEndpoints } from "./runpod";
import type { ControlPlaneStore, Tenant } from "./store";
import { D1Store } from "./store-d1";
import { STUDIO_MIGRATION_SET } from "./studio-migrations";
import { CfTokenMinter } from "./token-minter";
import { TENANT_MODULE_CATALOG, tenantModuleScriptName } from "./tenant-modules";

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
  /** Install the VERIFIED invoke key as the tenant studio secret. Throws on API failure. */
  installInvokeKey(tenant: Tenant, key: string): Promise<void>;
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
    // Structured, greppable, and NEVER carries a secret (provisioner discipline).
    log: (event, fields) => console.log("provision", { event, ...fields }),
  };

  return {
    async start(jobId, tenant, runpodApiKey) {
      // runProvisionJob records every outcome on the job row; the return value is the same fact.
      // A "yielded" outcome is normal under #112: progress is persisted and the next poll resumes.
      await runProvisionJob(deps, jobId, tenant, runpodApiKey, STUDIO_MIGRATION_SET);
    },
    async resume(jobId, tenant, stepsDone) {
      await continueProvisionJob(deps, jobId, tenant, stepsDone);
    },
    async installInvokeKey(tenant, key) {
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
    },
  };
}
