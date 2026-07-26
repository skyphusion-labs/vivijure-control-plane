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
// THE CONTRACT IS MEASURED, NOT READ OFF A DOCS PAGE, and measuring it caught a defect. Live probe
// 2026-07-25 against a throwaway `rehearsal-`prefixed script in the tenants namespace (recorded on
// cp#112), which established three things:
//
//   1. The endpoint takes MULTIPART, not JSON. The first implementation sent `application/json` --
//      which is what the API reference reads like -- and Cloudflare refuses that with `10001
//      Content-Type must be one of: multipart/form-data`. It would have failed on every call. The
//      wire shape now has its own regression test (tests/cf-api-settings-patch.test.ts).
//   2. `inherit` DOES preserve a `secret_text` binding across the patch. The probe secret was still
//      bound and still listed after two patches. This is what makes the route safe on a tenant whose
//      secrets the plane cannot reproduce.
//   3. A binding OMITTED from the patch is DROPPED (probe step 3 removed a plain_text binding by
//      leaving it out). The docs do not state this. It is why the census-then-inherit-everything
//      shape below is mandatory rather than stylistic.
//
// The readback in `refreshTenantStudioBindings` stays regardless: it re-censuses through a DIFFERENT
// credential than the one that wrote, and reports any binding or secret that went missing instead of
// trusting a success:true.

import { CfApiError, type WorkerBinding } from "./cf-api";
import { isVideoFinishUnreachable, withVideoFinishTierState } from "./video-finish-tier-state";
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
  code: "not_provisioned" | "video_finish_unconfigured" | "video_finish_declared";
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
  // ONE TRUTH AT A TIME (cp#136). Attaching the tier to a studio the plane has DECLARED unreachable
  // would make the record false the moment it succeeded: the record says no operator action reaches
  // this studio, and this IS an operator action reaching it. The panel would be fine either way (an
  // observed binding beats the label, so nobody is lied to), which is exactly why this has to be
  // caught here -- the harm is a plane record quietly disagreeing with the world, and no reader
  // would ever surface it.
  //
  // It lives in the SHARED preflight rather than only on the cp#136 route, so the cp#112 refresh
  // route inherits it too. Same action, same hazard; a guard that only covers the newer caller is a
  // guard someone routes around by using the older one.
  if (isVideoFinishUnreachable(tenant)) {
    return {
      ok: false,
      refusal: {
        code: "video_finish_declared",
        status: 409,
        message:
          "this tenant is DECLARED unreachable for the video-finish tier, so attaching the tier " +
          "would make that record false. Clear the declaration first " +
          "(POST /api/admin/tenants/<id>/video-finish-tier-state with unreachable=false), then re-run",
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
 * stale id.
 *
 * Precise about WHY that matters, because the loose version of this sentence is wrong: the CF
 * bindings endpoint DOES return `service_id` on a vpc_service binding (read live 2026-07-25). It is
 * our `getScriptBindings` wrapper that surfaces type and name only, so the code deciding here cannot
 * see the id. Re-patching converges regardless, which is why this does not depend on widening the
 * wrapper; if a future change does widen it, this stays correct.
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

// ---------------------------------------------------------------------------------------------
// cp#136 (criterion 3): DETACH the video-finish tier from a live tenant studio.
//
// WHY THIS EXISTS, and it is a gap found by running the drill rather than by reading the code. The
// `unprovisionable` state is now writable, but no studio could DISPLAY it: every binding writer in
// this plane either attaches the tier or preserves it. `runProvisionJob` attaches it whenever the
// service id is configured, `refreshTenantStudioBindings` above always APPENDS it, and the studio
// upgrade carries every censused binding forward as `inherit`. So a tenant that has the tier can
// never be put back into the tier-absent state the sentence describes, and the acceptance criterion
// (a human READS it on a live studio) had no honest path at all. The testbed proved it: the mark
// refused with `studio_reader_absent` because the studio serves `{}` -- tier bound, observed
// available, and correctly so.
//
// WHY IT IS NOT A HAND PATCH, which was the alternative. A settings PATCH omitting a binding DROPS
// it, and that is precisely the failure this file exists to prevent: hand-writing the desired set
// risks dropping a binding or a secret the plane cannot reproduce. So the detach goes through the
// SAME census-then-inherit-everything machinery, with the same readback through the other
// credential, and the only difference from the attach path is which single binding is left out.
//
// WHAT IT DELIBERATELY DOES NOT REQUIRE: `VIDEO_FINISH_VPC_SERVICE_ID`. Detaching does not need a
// service id, because it does not name one. A plane that has lost its tier configuration can still
// take the tier off a tenant, which is the direction you want to be able to move in when something
// is wrong.

/** A refusal for the detach half, checked before anything is written. */
export interface StudioBindingDetachRefusal {
  code: "not_provisioned" | "tenant_deleted" | "video_finish_declared";
  status: number;
  message: string;
}

/** The readback for a detach. Same shape discipline as the refresh above: evidence, not a flag. */
export interface StudioBindingDetach {
  ok: boolean;
  script: string;
  /** True when the tenant did not carry the binding; the PATCH still runs (it converges the set). */
  already_absent: boolean;
  bindings_before: string[];
  bindings_after: string[];
  secrets_before: string[];
  secrets_after: string[];
  /**
   * Names present before and absent after, EXCLUDING the one we meant to remove. Non-empty is the
   * strand this route fears, and keeping the intended removal out of it is what lets `ok` mean
   * "removed exactly one thing".
   */
  missing_bindings: string[];
  missing_secrets: string[];
}

/**
 * Everything that can refuse a detach, checked WITHOUT writing.
 *
 * The declaration guard is the mirror of the one in preflightStudioBindings and the lead constraint
 * on cp#136: one truth at a time. See the FINAL note on that issue for why this direction is the
 * belt to the attach guard braces -- the floor on the mark route already makes it impossible to
 * DECLARE a studio whose tier is bound, so a declared tenant is normally already tier-absent and
 * this refusal is a convergence no-op rather than a save. It is here because "normally" is not a
 * guarantee anyone should have to re-derive at 3am.
 */
export function preflightStudioBindingDetach(
  tenant: Tenant,
): { ok: true; script: string } | { ok: false; refusal: StudioBindingDetachRefusal } {
  if (tenant.deleted_at !== null) {
    return { ok: false, refusal: { code: "tenant_deleted", status: 404, message: "this tenant no longer exists" } };
  }
  if (!tenant.script_name) {
    return {
      ok: false,
      refusal: {
        code: "not_provisioned",
        status: 409,
        message: "this tenant has no studio script recorded, so there is no binding set to patch",
      },
    };
  }
  if (isVideoFinishUnreachable(tenant)) {
    return {
      ok: false,
      refusal: {
        code: "video_finish_declared",
        status: 409,
        message:
          "this tenant is DECLARED unreachable for the video-finish tier. Detaching under a live " +
          "declaration mixes two operator statements about the same capability; clear the " +
          "declaration first if you are undoing it, or leave it in place if you are not",
      },
    };
  }
  return { ok: true, script: tenant.script_name };
}

/**
 * Take the video-finish binding OFF a tenant studio, idempotently, carrying everything else.
 *
 * Idempotent by CONVERGENCE rather than by skipping, exactly like the attach half: a tenant that
 * already lacks the binding is patched anyway, so a studio that disagrees with the plane is brought
 * into line instead of being reported as already fine.
 *
 * NEVER writes tenants.status, tenants.studio_release, or the studio bytes.
 */
export async function detachTenantStudioBinding(
  deps: ProvisionDeps,
  tenant: Tenant,
  script: string,
): Promise<StudioBindingDetach> {
  const before = await deps.cf.getScriptBindings(deps.namespace, script);
  const secretsBefore = await deps.cf.getScriptSecretNames(deps.namespace, script);
  const alreadyAbsent = !before.some((b) => b.name === VIDEO_FINISH_BINDING);

  // Everything except the tier travels as `inherit`, so no binding VALUE is handled here. The cp#136
  // var is RE-DERIVED from the record rather than inherited, for the same reason both write paths do
  // it: a projection that is carried forward is a projection that can outlive its record.
  const desired = withVideoFinishTierState(
    before.filter((b) => b.name !== VIDEO_FINISH_BINDING).map((b) => ({ type: "inherit" as const, name: b.name })),
    tenant,
  );

  try {
    await deps.scriptUploadCf.patchScriptSettings(deps.namespace, script, desired);
  } catch (e) {
    if (e instanceof CfApiError && e.cfErrors.some((c) => c.code === CF_VPC_BINDING_UNAUTHORIZED)) {
      throw new StudioBindingError(
        "vpc_binding_unauthorized",
        409,
        "video-finish detach refused: the plane SCRIPT UPLOAD credential is not authorized for " +
          "Workers VPC (needs Connectivity Directory access). The tenant was NOT changed -- fix " +
          "CF_WORKER_UPLOAD_TOKEN and re-run.",
      );
    }
    throw e;
  }

  const after = await deps.cf.getScriptBindings(deps.namespace, script);
  const secretsAfter = await deps.cf.getScriptSecretNames(deps.namespace, script);
  const afterNames = new Set(after.map((b) => b.name));
  const afterSecrets = new Set(secretsAfter);
  // The intended removal is excluded from the strand check; everything else present before must
  // still be present after.
  const missingBindings = names(before)
    .filter((n) => n !== VIDEO_FINISH_BINDING)
    .filter((n) => !afterNames.has(n));
  const missingSecrets = [...secretsBefore].sort().filter((n) => !afterSecrets.has(n));

  const result: StudioBindingDetach = {
    ok: missingBindings.length === 0 && missingSecrets.length === 0 && !afterNames.has(VIDEO_FINISH_BINDING),
    script,
    already_absent: alreadyAbsent,
    bindings_before: names(before),
    bindings_after: names(after),
    secrets_before: [...secretsBefore].sort(),
    secrets_after: [...secretsAfter].sort(),
    missing_bindings: missingBindings,
    missing_secrets: missingSecrets,
  };

  deps.log("studio_bindings.detach", {
    tenant: tenant.id,
    script,
    ok: result.ok,
    already_absent: alreadyAbsent,
    bindings_before: result.bindings_before.length,
    bindings_after: result.bindings_after.length,
    missing_bindings: missingBindings,
    missing_secrets: missingSecrets,
  });

  return result;
}
