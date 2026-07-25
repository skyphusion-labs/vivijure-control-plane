// cp#112: deliver a studio-level binding to a tenant that ALREADY EXISTS.
//
// THE GAP THIS CLOSES. `VIDEO_FINISH_VPC` is attached in the studio-script upload, and that upload
// happens in exactly one place: `runProvisionJob`. `continueProvisionJob` refuses anything short of
// `wfp_upload`, `upgradeTenantModules` deliberately never touches the studio, and teardown deletes.
// So cf#118 reached tenants provisioned AFTER the knob was set and nobody else, permanently, with no
// operator action in the plane that changed it.
//
// WHY THIS IS A BINDING PATCH AND NOT A RE-UPLOAD, which is a deliberate divergence from the sizing
// note on cp#112 ("same bundle fetch + binding set as step 6"). Two reasons, both load-bearing:
//
//   1. SECRET CUSTODY. A live tenant studio carries four secrets (censused on the live tenant
//      2026-07-25): R2_S3_ACCESS_KEY_ID, R2_S3_SECRET_ACCESS_KEY, RUNPOD_API_KEY, STUDIO_API_TOKEN.
//      The plane can reconstruct exactly two of them. R2_S3_SECRET_ACCESS_KEY is the SHA-256 of an
//      R2 token value we never stored (only its id), and RUNPOD_API_KEY is key B, transient by
//      ruling. A re-upload that re-states the binding set therefore cannot re-state those two, and a
//      tenant that loses them stops rendering: presign throws without the R2 secret, and dispatch
//      dies without key B. Recovery would need the tenant to re-paste key B AND a token re-mint with
//      a matching RunPod template rewrite. "Must not strand the tenant" is the care standard cp#112
//      itself sets, and a re-upload cannot meet it with values the plane does not hold.
//   2. NOT CONFLATING TWO OPERATIONS. Re-uploading the bundle moves the tenant onto whatever release
//      the plane is pinned to. That is a release change on a live tenant, and this plane already
//      treats that as its own deliberate operation with its own job kind, preflight, and
//      from_release/to_release record (the module-upgrade lane). Doing it as a side effect of "give
//      this tenant a binding" would ship an unrecorded, unasked-for release change.
//
// So this route changes BINDINGS ONLY. The studio bytes, the studio release, and tenants.status are
// untouched, and the tests assert all three.
//
// THE MECHANISM. `PATCH .../scripts/<script>/settings` with the full desired binding set, where
// every binding we are keeping is sent as `{ type: "inherit", name }` -- the documented way to carry
// a binding forward from the latest version without holding its value. That is what makes the secret
// problem above disappear rather than be managed: we never handle a secret value at all.
//
// UNVERIFIED SEAM, STATED RATHER THAN ASSUMED: the PATCH body shape and `inherit` over a
// `secret_text` binding are read off Cloudflare's API reference, and no test in this repo hands that
// request to Cloudflare. Per the standing rule that a layer exercised only through a fake is
// UNTESTED, the tests below prove decision paths only; the contract itself needs one live probe
// against a throwaway script in the tenants namespace before this ships. The readback in
// `refreshTenantStudioBindings` is the runtime guard for the same doubt: it re-censuses through a
// DIFFERENT credential than the one that wrote, and reports any binding or secret that went missing
// instead of trusting a success:true.

import { CfApiError, type WorkerBinding } from "./cf-api";
import type { ProvisionDeps } from "./provisioner";
import type { Tenant } from "./store";

/** The studio binding name the video-finish tier is reached through (cf#118). */
export const VIDEO_FINISH_BINDING = "VIDEO_FINISH_VPC";

/** CF's own code for "this credential may not attach a Workers VPC binding" (cf#118 probe). */
const CF_VPC_BINDING_UNAUTHORIZED = 10196;

/**
 * A named, operator-readable failure from the PATCH itself. Carries the status the route answers
 * with, so the router never has to re-derive what a CF error meant.
 */
export class StudioBindingError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StudioBindingError";
  }
}

/**
 * A refusal that happens BEFORE anything is written, so the caller can answer without having
 * touched the tenant. Same split as preflightUpgrade: the refusal and the work are not one call.
 */
export interface StudioBindingRefusal {
  code: "not_provisioned" | "video_finish_unconfigured";
  status: number;
  message: string;
}

/** What the operator gets back: the readback, not our opinion of the write. */
export interface StudioBindingRefresh {
  ok: boolean;
  script: string;
  service_id: string;
  /** True when the tenant already carried the binding; the PATCH still runs (it converges the id). */
  already_present: boolean;
  bindings_before: string[];
  bindings_after: string[];
  secrets_before: string[];
  secrets_after: string[];
  /** Names present before and absent after. MUST be empty; non-empty is the strand this route fears. */
  missing_bindings: string[];
  missing_secrets: string[];
}

const names = (list: { name: string }[]): string[] => list.map((b) => b.name).sort();

/**
 * Everything that can refuse, checked without writing.
 *
 * `video_finish_unconfigured` is cp#109's honest refusal wearing this route's clothes: a plane that
 * does not run the tier has nothing to deliver, and saying so is better than a 200 that changed
 * nothing. `not_provisioned` is the other end: a tenant whose studio was never uploaded has no
 * script to patch, and the fix is a provision, not this.
 */
export function preflightStudioBindings(
  deps: ProvisionDeps,
  tenant: Tenant,
): { ok: true; script: string; serviceId: string } | { ok: false; refusal: StudioBindingRefusal } {
  if (!tenant.script_name) {
    return {
      ok: false,
      refusal: {
        code: "not_provisioned",
        status: 409,
        message:
          "this tenant has no studio script recorded, so there is nothing to patch; " +
          "it needs a provision, not a binding refresh",
      },
    };
  }
  if (!deps.videoFinishServiceId) {
    return {
      ok: false,
      refusal: {
        code: "video_finish_unconfigured",
        status: 409,
        message:
          "this plane is not configured for video finishing (VIDEO_FINISH_VPC_SERVICE_ID is unset), " +
          "so there is no tier to deliver; set it, deploy, then re-run",
      },
    };
  }
  return { ok: true, script: tenant.script_name, serviceId: deps.videoFinishServiceId };
}

/**
 * Give an EXISTING tenant studio the video-finish binding, idempotently.
 *
 * Idempotent by CONVERGENCE rather than by skipping: a tenant that already carries the binding is
 * patched anyway, with the currently configured service id, so a plane that was re-pointed at a new
 * Connectivity Directory service heals the tenant instead of reporting "already present" over a
 * stale id we never read.
 *
 * NEVER writes tenants.status, tenants.studio_release, or the studio bytes. A live tenant is serving
 * throughout.
 */
export async function refreshTenantStudioBindings(
  deps: ProvisionDeps,
  tenant: Tenant,
  script: string,
  serviceId: string,
): Promise<StudioBindingRefresh> {
  // Census BEFORE, through the provisioner credential (reads), so we know what a loss would look
  // like. Secret NAMES only; these endpoints never return values and this file never wants one.
  const before = await deps.cf.getScriptBindings(deps.namespace, script);
  const secretsBefore = await deps.cf.getScriptSecretNames(deps.namespace, script);
  const alreadyPresent = before.some((b) => b.name === VIDEO_FINISH_BINDING);

  // Everything we are keeping travels as `inherit`, so no binding VALUE is handled here -- which is
  // the entire reason this route can run against a tenant whose secrets the plane cannot reproduce.
  const desired: WorkerBinding[] = [
    ...before
      .filter((b) => b.name !== VIDEO_FINISH_BINDING)
      .map((b) => ({ type: "inherit" as const, name: b.name })),
    { type: "vpc_service" as const, name: VIDEO_FINISH_BINDING, service_id: serviceId },
  ];

  try {
    // The WRITE goes through the upload credential: attaching a vpc_service binding needs
    // Connectivity Directory access, which is exactly why cf#118 split the credential in two.
    await deps.scriptUploadCf.patchScriptSettings(deps.namespace, script, desired);
  } catch (e) {
    if (e instanceof CfApiError && e.cfErrors.some((c) => c.code === CF_VPC_BINDING_UNAUTHORIZED)) {
      // Same translation the provision path does, for the same reason: CF blames the caller
      // accurately and uselessly, and an operator reading this needs to know it is the PLANE's
      // credential, not anything about the tenant.
      throw new StudioBindingError(
        "vpc_binding_unauthorized",
        409,
        "video-finish binding refused: the plane SCRIPT UPLOAD credential is not authorized for " +
          "Workers VPC (needs Connectivity Directory access). The tenant was NOT changed -- fix " +
          "CF_WORKER_UPLOAD_TOKEN and re-run.",
      );
    }
    throw e;
  }

  // Read back through the OTHER credential. The PATCH response echoes no bindings, and success:true
  // is the writing client's opinion of its own work (the cf#118 probe rule, applied here because
  // this route's whole risk is a binding set that came back smaller than it went in).
  const after = await deps.cf.getScriptBindings(deps.namespace, script);
  const secretsAfter = await deps.cf.getScriptSecretNames(deps.namespace, script);

  const afterNames = new Set(after.map((b) => b.name));
  const afterSecrets = new Set(secretsAfter);
  const missingBindings = names(before).filter((n) => !afterNames.has(n));
  const missingSecrets = [...secretsBefore].sort().filter((n) => !afterSecrets.has(n));

  const result: StudioBindingRefresh = {
    ok: missingBindings.length === 0 && missingSecrets.length === 0 && afterNames.has(VIDEO_FINISH_BINDING),
    script,
    service_id: serviceId,
    already_present: alreadyPresent,
    bindings_before: names(before),
    bindings_after: names(after),
    secrets_before: [...secretsBefore].sort(),
    secrets_after: [...secretsAfter].sort(),
    missing_bindings: missingBindings,
    missing_secrets: missingSecrets,
  };

  deps.log("studio_bindings.refresh", {
    tenant: tenant.id,
    script,
    ok: result.ok,
    already_present: alreadyPresent,
    bindings_before: result.bindings_before.length,
    bindings_after: result.bindings_after.length,
    missing_bindings: missingBindings,
    missing_secrets: missingSecrets,
  });

  return result;
}
