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
import type { TenantEndpoint } from "./provisioner";

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
  endpointKey: string;
}

/**
 * The tenant module set = the 4 endpoint-backed capabilities (keyframe + own-gpu both ride the backend
 * endpoint; upscale / lipsync / audio-upscale each get their own). Every module here reads exactly
 * RUNPOD_ENDPOINT_ID + RUNPOD_API_KEY (verified against each module's Env), which is why the binding
 * set below is uniform. Extending the hosted tier is a row here plus the matching endpoint in runpod.ts.
 */
export const TENANT_MODULE_CATALOG: readonly TenantModuleSpec[] = [
  { module: "keyframe", endpointKey: "backend" },
  { module: "own-gpu", endpointKey: "backend" },
  { module: "finish-upscale", endpointKey: "upscale" },
  { module: "finish-lipsync", endpointKey: "lipsync" },
  { module: "speech-upscale", endpointKey: "audio-upscale" },
];

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
  moduleBundle: ModuleBundleSource;
  release: string;
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
export async function uploadTenantModules(
  deps: TenantModuleDeps,
  tenantId: string,
  endpoints: TenantEndpoint[],
): Promise<string[]> {
  await deps.cf.createDispatchNamespace(deps.moduleNamespace);
  const scriptNames: string[] = [];
  for (const spec of TENANT_MODULE_CATALOG) {
    const endpoint = endpoints.find((e) => e.key === spec.endpointKey);
    if (!endpoint) {
      throw new TenantModuleError(
        "modules_upload",
        `module ${spec.module} needs the ${spec.endpointKey} endpoint, which the tenant does not have`,
      );
    }
    let bundle: ModuleBundle;
    try {
      bundle = await deps.moduleBundle.fetch(deps.release, spec.module);
    } catch (e) {
      throw new TenantModuleError("modules_upload", `fetch module bundle ${spec.module}: ${(e as Error).message}`);
    }
    const scriptName = tenantModuleScriptName(tenantId, spec.module);
    const bindings: WorkerBinding[] = [
      // The endpoint id the module renders against. plain_text: not a secret, mirrors how the studio
      // provisioner binds its endpoint-id vars. The module reads env.RUNPOD_ENDPOINT_ID (string-typed
      // via secretValue), so a plain_text binding drops straight in.
      { type: "plain_text", name: "RUNPOD_ENDPOINT_ID", text: endpoint.id },
    ];
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
): Promise<{ ok: boolean; failures: { resource: string; error: string }[] }> {
  const failures: { resource: string; error: string }[] = [];
  const prefix = tenantModuleScriptPrefix(tenantId);
  let scripts: string[];
  try {
    scripts = (await deps.cf.listNamespaceScripts(deps.moduleNamespace)).filter((s) => s.startsWith(prefix));
  } catch (e) {
    // Cannot list => cannot prove anything is gone. Report it; do not claim a clean teardown.
    return { ok: false, failures: [{ resource: "modules_list", error: String(e) }] };
  }
  for (const script of scripts) {
    try {
      await deps.cf.deleteUserWorker(deps.moduleNamespace, script);
    } catch (e) {
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
  return { ok: failures.length === 0, failures };
}
