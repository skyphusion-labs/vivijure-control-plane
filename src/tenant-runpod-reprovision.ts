// cp#137 remediation: rebuild a LIVE tenant's RunPod endpoints, through a plane mechanism.
//
// THE SITUATION THIS ANSWERS. cp#137's detection half proved the standing testbed reads status=live
// while all four endpoints its record names are 404: they lived in a scratch RunPod account and died
// in a debris sweep. The record was deliberately left untouched, because the fix is not an UPDATE
// statement -- a corrected record pointing at endpoints that still do not exist would be the same
// lie with fresher ids. The tenant needs its endpoints BACK.
//
// WHY THIS IS NOT runProvisionJob. That function provisions a tenant from nothing: it creates D1,
// migrates it, creates the bucket, uploads the studio bytes at whatever release the plane is pinned
// to, and ends by writing a terminal job state. Pointed at a live tenant to fix four endpoints it
// would move the studio release nobody asked to move (the cf#103 rule), rewrite a D1 that is fine,
// and make a four-endpoint repair indistinguishable from a fresh build. This route changes the
// RunPod layer and exactly the wiring that names it, and nothing else.
//
// WHY IT CANNOT REUSE THE OLD R2 CREDENTIAL, which is forced rather than chosen. The satellite
// TEMPLATES carry the tenant's R2 credential in their env, and rebuilding them means writing that
// credential again. The plane stored the token ID only; the S3 secret is the SHA-256 of a token
// VALUE we deliberately never kept (provisioner.ts step 4). So there is no path where the old
// credential reaches the new templates, and the honest move is a fresh mint whose value goes to the
// templates and to the studio secret in the same pass. Revoke-then-mint, in the provisioner's own
// order, so a re-run does not leave a trail of live grants.
//
// THE CUSTODY BOUNDARY IS UNCHANGED. Key A arrives in the request, is passed as an argument, and is
// never stored, never logged, and never placed on a response. Every message that leaves this module
// goes through `redactSecrets` first, because the values that must not escape are exactly the values
// this module is holding while it runs, and an upstream error is quite capable of quoting the
// request it was given back at us.
//
// WHAT IT DELIBERATELY DOES NOT DO: mint key B. RunPod has no key-creation API and a key cannot be
// scoped to endpoints that did not exist a moment ago, which is what forces two-phase onboarding
// (runpod.ts). New endpoints mean new ids, so the stored key B is scoped to four dead ones and the
// tenant CANNOT render until a fresh Restricted key is minted in the console and installed through
// the existing invoke-key route. Saying so, and writing the status that means it, is the whole point.

import type { WorkerBinding } from "./cf-api";
import { sha256Hex } from "./crypto";
import {
  readTenantEndpoints,
  runModuleSteps,
  tenantR2TokenName,
  type ProvisionDeps,
  type TenantEndpoint,
} from "./provisioner";
import type { TemplateConvergence } from "./runpod";
import { readRunPodMode } from "./runpod-pool";
import type { Tenant } from "./store";
import { prefetchModuleBundles, TenantModuleError, type ModuleBundle } from "./tenant-modules";
import { decryptStudioToken } from "./token-crypto";

/**
 * The studio secrets this pass REPLACES rather than inherits, because their values changed with the
 * mint. Everything else on the script travels as `inherit` (cp#112): the plane cannot reproduce the
 * studio token or key B, and a binding omitted from a settings PATCH is DROPPED, not kept.
 */
export const REPROVISION_REPLACED_SECRETS = ["R2_S3_ACCESS_KEY_ID", "R2_S3_SECRET_ACCESS_KEY"] as const;

/** Where a failure happened, in words an operator can act on. */
export type ReprovisionStep =
  | "status"
  | "templates_converge"
  | "r2_token"
  | "runpod_endpoints"
  | "studio_bindings"
  | "modules";

export class ReprovisionError extends Error {
  constructor(
    readonly step: ReprovisionStep,
    message: string,
  ) {
    super(message);
    this.name = "ReprovisionError";
  }
}

export interface ReprovisionRefusal {
  code: string;
  status: number;
  message: string;
}

export interface ReprovisionContext {
  script: string;
  studioApiToken: string;
  bucket: string;
  /** The release the module scripts are re-uploaded at: the tenant's OWN recorded release, never the
   *  plane default. Re-uploading at deps.release would ship an unasked-for module release as a side
   *  effect of an endpoint repair, which is the defect cf#103 made a rule about. */
  modulesRelease: string;
  bundles: Map<string, ModuleBundle>;
  /** What the record claimed BEFORE this pass, kept for the report. */
  recorded: TenantEndpoint[];
}

export type ReprovisionPreflight =
  | { ok: true; context: ReprovisionContext }
  | { ok: false; refusal: ReprovisionRefusal };

export interface ReprovisionResult {
  tenant_id: string;
  slug: string;
  script: string;
  /** The ids the record USED to name, so the report shows the swap rather than just the new state. */
  endpoints_before: { key: string; id: string }[];
  /** The ids the record names now. This is what key B must be scoped to. */
  endpoints_after: { key: string; id: string; name: string; endpointVar: string }[];
  templates: TemplateConvergence[];
  /** The fresh R2 token ID. An id, never the value; teardown revokes by exactly this. */
  r2_token_id: string;
  /** True when the previous token was revoked. False is reported, not swallowed: it is a live grant. */
  previous_r2_token_revoked: boolean;
  bindings_after: string[];
  secrets_after: string[];
  /** Both EMPTY by construction: a short readback throws at studio_bindings. Reported anyway, because
   *  "nothing was lost" is the claim this route most needs to be able to show rather than assert. */
  missing_bindings: string[];
  missing_secrets: string[];
  modules_release: string;
  modules_uploaded: string[];
  status: "awaiting_invoke_key";
  /** The one thing a human must now do, with the ids they need to do it. */
  next_step: string;
}

/**
 * Scrub secret VALUES out of anything that might travel (an error message, an audit row, a log).
 *
 * Not belt-and-braces: an upstream client is free to quote the request body it was handed back in a
 * failure, and RunPod's own error text is passed through verbatim by design (runpod.ts keeps its
 * quota sentence intact). This is the one place that can know which strings are the secrets, so it
 * is the place that removes them. Empty and short values are ignored: a blank needle would match
 * everywhere and turn every message into redaction noise.
 */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

/**
 * Everything that can refuse, checked WITHOUT writing (the preflight split every route here uses).
 *
 * The status rule is deliberately a PAIR, not `live` alone: a reprovision that failed half way
 * leaves the tenant at awaiting_invoke_key (see below), and a repair you cannot re-run after it
 * fails is not a repair. Every other lifecycle value belongs to the provision path, which knows how
 * to finish it.
 */
export async function preflightRunPodReprovision(
  deps: ProvisionDeps,
  tenant: Tenant,
): Promise<ReprovisionPreflight> {
  const refuse = (code: string, status: number, message: string): ReprovisionPreflight => ({
    ok: false,
    refusal: { code, status, message },
  });

  if (tenant.deleted_at !== null) return refuse("tenant_deleted", 404, "this tenant no longer exists");
  // The kill switch is checked before the lifecycle, exactly as routing and the module upgrade do it:
  // rebuilding a suspended tenant's render capacity would be working around it.
  if (tenant.suspended_at !== null) {
    return refuse("tenant_suspended", 409, "this tenant is suspended; resume it before rebuilding its endpoints");
  }
  if (tenant.status !== "live" && tenant.status !== "awaiting_invoke_key") {
    return refuse(
      "tenant_not_reprovisionable",
      409,
      `rebuilding endpoints requires a tenant that finished provisioning; this one is ${tenant.status}. ` +
        "An unfinished provision is finished through the provision job, not repaired here.",
    );
  }
  if (!tenant.script_name) {
    return refuse("not_provisioned", 409, "this tenant has no studio script recorded; it needs a provision, not a repair");
  }
  // cp#270: a SHARED-tier tenant has no endpoints of its own to rebuild. Everything this route
  // does to RunPod -- converge the tenant's templates onto the current pins, re-mint the R2
  // credential into the template env, recreate the endpoints -- would be aimed at the PLANE's
  // production pool, on the plane's own account, on behalf of one tenant. It would rewrite the
  // template env every other shared tenant renders through.
  //
  // Refused rather than made mode-aware. A pooled tenant's render capacity is not repaired by
  // rebuilding anything per-tenant; if the pool is broken the pool is fixed, once, for everyone.
  if (readRunPodMode(tenant.runpod_mode) === "shared") {
    return refuse(
      "tenant_on_shared_pool",
      409,
      "this tenant rides the shared endpoint pool and owns no endpoints to rebuild; repairing the " +
        "pool is an operator action on the pool itself, not a per-tenant reprovision",
    );
  }
  if (!tenant.r2_bucket_name) {
    return refuse(
      "tenant_bucket_missing",
      422,
      "no R2 bucket recorded for this tenant, so there is nothing to scope a fresh credential to",
    );
  }
  // REQUIRED, and NOT defaulted to deps.release. The module scripts carry the endpoint ids, so they
  // must be re-uploaded; doing that at the plane default would move a live tenant onto a module
  // release nobody asked for, as a side effect of an endpoint repair.
  if (!tenant.modules_release) {
    return refuse(
      "modules_release_unknown",
      422,
      "this tenant has no recorded module release, so re-uploading its module scripts would have to " +
        "guess a version; run the module upgrade route at an explicit release first",
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

  // The studio must be SERVING before we touch its bindings. If it is already broken, this pass
  // would be blamed for a fault it did not cause, and "the studio kept serving" is unverifiable when
  // it was not serving to begin with.
  const probe = await deps.callTenantStudio(tenant.script_name, { method: "GET", path: "/", studioApiToken });
  if (probe.status >= 500) {
    return refuse(
      "tenant_studio_not_serving",
      422,
      `the tenant studio answered ${probe.status} before anything was changed; fix that first`,
    );
  }

  // Fetch every module bundle up front, in preflight, for the cf#103 reason: a release missing one
  // bundle must refuse before the first RunPod write, not after the endpoints have been rebuilt.
  let bundles: Map<string, ModuleBundle>;
  try {
    bundles = await prefetchModuleBundles(deps, tenant.modules_release);
  } catch (e) {
    return refuse("module_bundle_unavailable", 422, e instanceof TenantModuleError ? e.message : String(e));
  }

  return {
    ok: true,
    context: {
      script: tenant.script_name,
      studioApiToken,
      bucket: tenant.r2_bucket_name,
      modulesRelease: tenant.modules_release,
      bundles,
      recorded: readTenantEndpoints(tenant),
    },
  };
}

/**
 * Rebuild the four endpoints and re-point everything that names them.
 *
 * ORDER IS THE DESIGN, and the first write is the one that looks out of place:
 *
 *   status -> templates -> r2 token -> endpoints -> studio bindings -> modules
 *
 * THE STATUS WRITE COMES FIRST, before anything is touched, and that is the thesis of cp#137 rather
 * than bookkeeping. The moment this pass begins, the studio's wiring is being replaced and the
 * stored key B is scoped to endpoints that are about to stop being the ones the tenant uses. Leaving
 * `live` in place for the duration -- or worse, restoring it at the end while key B is still the old
 * one -- would be a record presenting a capability the system does not have, which is the exact
 * defect this issue exists to end. It also means a failure ANYWHERE below leaves an honest status
 * behind rather than one that has to be repaired by whoever reads the error.
 *
 * `failed` is deliberately NOT written on error: the studio still exists, still serves, and its data
 * is untouched. What is true after a half-finished pass is precisely "this tenant is waiting for an
 * invoke key", and that is what the row says.
 */
export async function reprovisionTenantRunPod(
  deps: ProvisionDeps,
  tenant: Tenant,
  context: ReprovisionContext,
  runpodApiKey: string,
): Promise<ReprovisionResult> {
  // Every value in here is a secret this function is holding while it runs. Anything thrown out of
  // it is scrubbed against this list before it reaches a caller, an audit row, or a log line.
  const secrets: (string | null)[] = [runpodApiKey];
  let step: ReprovisionStep = "status";
  const fail = (e: unknown): never => {
    const raw = e instanceof Error ? e.message : String(e);
    throw new ReprovisionError(step, redactSecrets(raw, secrets));
  };

  try {
    await deps.store.setTenantStatus(tenant.id, "awaiting_invoke_key");

    // 1. The pins the plane holds reach the templates BEFORE the endpoints are rebuilt on them.
    step = "templates_converge";
    const templates = await deps.runpod.convergeTemplateImages(runpodApiKey, tenant.slug);

    // 2. A fresh bucket-scoped credential, because the old one's VALUE was never ours to keep.
    step = "r2_token";
    let previousRevoked = false;
    if (tenant.r2_token_id) {
      try {
        await deps.tokenMinter.revoke(tenant.r2_token_id);
        previousRevoked = true;
      } catch (e) {
        // A stale token that will not revoke must not strand the repair, but it MUST be visible: it
        // is a live credential we failed to clean up. Same posture as the provisioner.
        deps.log("reprovision.r2_revoke_failed", { tenant: tenant.id, token: tenant.r2_token_id, error: String(e) });
      }
    }
    const token = await deps.tokenMinter.mintBucketToken(tenantR2TokenName(tenant.slug), context.bucket);
    secrets.push(token.value);
    // Persist the id IMMEDIATELY, before any await that could strand it: if we die here, teardown can
    // still revoke by id (the cf#91 rule). The VALUE is never persisted anywhere.
    await deps.store.setTenantR2Token(tenant.id, token.id);
    const s3Secret = await sha256Hex(token.value);
    secrets.push(s3Secret);

    // 3. The endpoints. Idempotent by name and template-first, so the fresh credential reaches every
    //    template before an endpoint is built on it (#83).
    step = "runpod_endpoints";
    const endpoints = await deps.runpod.createEndpoints(runpodApiKey, tenant.slug, {
      endpoint: deps.r2Endpoint,
      accessKeyId: token.id,
      secretAccessKey: s3Secret,
      bucket: context.bucket,
    });
    if (endpoints.length === 0) throw new Error("RunPod returned no endpoints; refusing to record an empty set");
    await deps.store.setTenantEndpoints(tenant.id, JSON.stringify(endpoints));

    // 4. Re-point the studio: the four endpoint-id vars and the two R2 secrets change, everything
    //    else INHERITS. Inherit is what makes this safe on a tenant whose secrets the plane cannot
    //    reproduce (the studio token, and the old key B), and a binding left OUT of a settings PATCH
    //    is dropped rather than kept -- measured on a live probe, cp#112.
    step = "studio_bindings";
    const readback = await repointStudioBindings(deps, context.script, endpoints, token.id, s3Secret);

    // 5. The module scripts carry the endpoint ids too, so they are re-uploaded at the tenant's OWN
    //    recorded release and re-installed through the studio's conformance-gated route. This drops
    //    the old key B from the module scripts, which is correct: it is scoped to dead endpoints, and
    //    the invoke-key route puts the new one on the studio AND every module in one pass.
    step = "modules";
    const moduleScripts: string[] = [];
    await runModuleSteps(
      deps,
      {
        tenantId: tenant.id,
        slug: tenant.slug,
        script: context.script,
        endpoints,
        studioApiToken: context.studioApiToken,
        release: context.modulesRelease,
        prefetched: context.bundles,
        // Restated from the record for the same reason the endpoint ids are: this re-uploads the
        // module scripts, and an upload REPLACES the binding set, so a binding not passed here is a
        // binding dropped (cp#248).
        telemetryD1Id: tenant.d1_database_id,
        // Same restatement, same reason, for the proxy pair (cp#288).
        //
        // THIS READS 'dedicated' ON EVERY REACHABLE PATH, and that is structural rather than a
        // convention anyone has to remember: preflightRunPodReprovision refuses a shared tenant
        // outright (`tenant_on_shared_pool`, above), and this function cannot be entered without a
        // ReprovisionContext, whose only producer is that same preflight AFTER the refusal. The
        // preflight returns a discriminated union, so the context is not reachable on the refusal
        // branch at all.
        //
        // READ FROM THE ROW ANYWAY, and the residual is why. `tenant` is passed SEPARATELY from
        // `context`, so nothing forces the tenant examined by the preflight to be the tenant handed
        // to this call. Today's single caller passes the same variable; a future one need not.
        // Hardcoding 'dedicated' on the strength of the proof above would then bind NO proxy on a
        // shared tenant that reached here, silently, while every other path bound one -- a
        // divergence no test would show. Reading the row is correct under both futures.
        runpodMode: readRunPodMode(tenant.runpod_mode),
      },
      { shouldRun: () => true, onDone: async (done) => void moduleScripts.push(done) },
    );

    const result: ReprovisionResult = {
      tenant_id: tenant.id,
      slug: tenant.slug,
      script: context.script,
      endpoints_before: context.recorded.map((e) => ({ key: e.key, id: e.id })),
      endpoints_after: endpoints.map((e) => ({ key: e.key, id: e.id, name: e.name, endpointVar: e.endpointVar })),
      templates,
      r2_token_id: token.id,
      previous_r2_token_revoked: previousRevoked,
      bindings_after: readback.bindings_after,
      secrets_after: readback.secrets_after,
      missing_bindings: readback.missing_bindings,
      missing_secrets: readback.missing_secrets,
      modules_release: context.modulesRelease,
      modules_uploaded: moduleScripts,
      status: "awaiting_invoke_key",
      // WHO does this step is load-bearing, not a detail of phrasing. The install route is
      // OWNER-authenticated (src/index.ts: the admin bearer is honoured only under /api/admin/,
      // every other /api/ path resolves a session), so the operator who just ran this repair cannot
      // perform it. Saying "POST it" to an operator sends them at a route that will answer 401, which
      // is the same class of defect this issue exists to end: an instruction the system will not
      // honour. Whether that boundary is RIGHT is a live custody question, filed separately.
      next_step:
        "mint a RESTRICTED RunPod invoke key scoped to exactly these endpoint ids (" +
        endpoints.map((e) => e.id).join(", ") +
        "). THE ACCOUNT OWNER must then install it from their own signed-in session, by POSTing it to " +
        `/api/tenant/${tenant.id}/invoke-key: that route is owner-authenticated, so an operator ` +
        "holding the admin token cannot complete this step. The tenant cannot render until then: the " +
        "previously stored key is scoped to the endpoints this pass replaced.",
    };

    deps.log("reprovision.done", {
      tenant: tenant.id,
      endpoints: result.endpoints_after.map((e) => e.id),
      templates_changed: templates.filter((t) => t.changed).length,
      r2_token: token.id,
      missing_bindings: readback.missing_bindings,
      missing_secrets: readback.missing_secrets,
    });
    return result;
  } catch (e) {
    deps.log("reprovision.failed", {
      tenant: tenant.id,
      step,
      // Scrubbed here as well as on the throw: a log line is a place a secret escapes to just as
      // surely as a response body is.
      error: redactSecrets(e instanceof Error ? e.message : String(e), secrets),
    });
    return fail(e);
  }
}

interface StudioRepointReadback {
  bindings_after: string[];
  secrets_after: string[];
  missing_bindings: string[];
  missing_secrets: string[];
}

/**
 * Replace the endpoint-id vars and the R2 credential on a LIVE studio, inheriting everything else.
 *
 * The write goes through the UPLOAD credential and the readback through the provisioner one, on
 * purpose: two different credentials, so the census that proves nothing was lost is not the opinion
 * of the client that did the writing (the cp#112 rule, which exists because this route's whole risk
 * is a binding set that comes back smaller than it went in).
 */
async function repointStudioBindings(
  deps: ProvisionDeps,
  script: string,
  endpoints: TenantEndpoint[],
  accessKeyId: string,
  s3Secret: string,
): Promise<StudioRepointReadback> {
  const before = await deps.cf.getScriptBindings(deps.namespace, script);
  const secretsBefore = await deps.cf.getScriptSecretNames(deps.namespace, script);

  const replacedVars = new Set(endpoints.map((e) => e.endpointVar));
  const replacedSecrets = new Set<string>(REPROVISION_REPLACED_SECRETS);

  const desired: WorkerBinding[] = [
    ...before
      .filter((b) => !replacedVars.has(b.name) && !replacedSecrets.has(b.name))
      .map((b) => ({ type: "inherit" as const, name: b.name })),
    // A secret that exists on the script but is not in the BINDING census still has to be carried:
    // getScriptBindings and getScriptSecretNames are different lists, and a secret omitted from the
    // patch is dropped like any other binding. The studio token and key B live here.
    ...secretsBefore
      .filter((name) => !replacedSecrets.has(name) && !before.some((b) => b.name === name))
      .map((name) => ({ type: "inherit" as const, name })),
    ...endpoints.map((e) => ({ type: "plain_text" as const, name: e.endpointVar, text: e.id })),
    { type: "secret_text" as const, name: "R2_S3_ACCESS_KEY_ID", text: accessKeyId },
    { type: "secret_text" as const, name: "R2_S3_SECRET_ACCESS_KEY", text: s3Secret },
  ];

  await deps.scriptUploadCf.patchScriptSettings(deps.namespace, script, desired);

  const after = await deps.cf.getScriptBindings(deps.namespace, script);
  const secretsAfter = await deps.cf.getScriptSecretNames(deps.namespace, script);
  const afterNames = new Set(after.map((b) => b.name));
  const afterSecrets = new Set(secretsAfter);

  const missingBindings = before.map((b) => b.name).sort().filter((n) => !afterNames.has(n));
  const missingSecrets = [...secretsBefore].sort().filter((n) => !afterSecrets.has(n));
  const missingVars = endpoints.map((e) => e.endpointVar).filter((v) => !afterNames.has(v));

  // FAIL FAST, and this is a deliberate divergence from cp#112, which reports a short readback as
  // ok:false and lets the caller decide. There, the patch IS the operation. Here it is the middle of
  // one: a studio that just lost a secret cannot render whatever the module step does next, and
  // pressing on would re-upload five module scripts, re-run the conformance install, and hand back a
  // long report whose first line is the only one that mattered. Stopping here also leaves the
  // clearest possible state -- the tenant is at awaiting_invoke_key, its studio bytes are untouched,
  // and the operator is told exactly which name went missing.
  if (missingBindings.length || missingSecrets.length || missingVars.length) {
    throw new Error(
      "the studio settings patch did not read back whole: " +
        [
          missingBindings.length ? `bindings lost: ${missingBindings.join(", ")}` : "",
          missingSecrets.length ? `secrets lost: ${missingSecrets.join(", ")}` : "",
          missingVars.length ? `endpoint vars absent: ${missingVars.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("; ") +
        ". The tenant studio is unchanged in its bytes and sits at awaiting_invoke_key; re-run this " +
        "route once the cause is understood.",
    );
  }

  return {
    bindings_after: after.map((b) => b.name).sort(),
    secrets_after: [...secretsAfter].sort(),
    missing_bindings: missingBindings,
    missing_secrets: missingSecrets,
  };
}
