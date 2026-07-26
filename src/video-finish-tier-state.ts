// cp#136: the plane WRITES the finish-tier state the panel READS.
//
// THE GAP THIS CLOSES. vivijure-cf resolves three states for the video-finish tier
// (src/video-finish-availability.ts): `available` when VIDEO_FINISH_VPC is bound, `provisionable`
// when it is absent but somebody can still attach it, and `unprovisionable` when no operator action
// reaches that studio. The panel reads the third off the studio var VIDEO_FINISH_TIER_STATE, and
// NOTHING in this plane ever wrote that var, so the third state could not occur in production. The
// sentence written for it (cf#243) shipped into a state no studio could enter.
//
// WHY THE WRITER IS A DECLARATION AND NOT A DERIVATION, decided on cp#136 and worth keeping written
// down, because "compute it" is the obvious wrong answer and it is obvious for a good reason. There
// is no plane-side condition that computes unreachability:
//
//   VIDEO_FINISH_VPC_SERVICE_ID set    the studio gets the binding and resolves `available` by
//                                      OBSERVATION; the var is irrelevant.
//   VIDEO_FINISH_VPC_SERVICE_ID unset  an operator can set it and reach the studio through cp#112
//                                      refresh-studio-bindings, so "not yet" is a promise that can
//                                      still be kept, and `provisionable` is the honest answer.
//
// Every derived writer therefore writes `provisionable` forever and leaves `unprovisionable`
// exactly as unreachable as it was. Worse, the nearby-sounding condition is a trap: the finish tier
// being DOWN is transient, and the sentence this state displays ("cannot be turned on for it") is
// permanent. Wiring an outage to a permanent claim would tell every tenant the tier can never be
// turned on, and would keep saying it after the container came back. Unreachability is a fact about
// the world outside what this plane can act on, so a human declares it, with a reason, audited.
//
// THE SHAPE: one writer, one source of truth, projected at every write.
//
//   tenants.video_finish_unreachable   the RECORD (migration 0011). Listable, auditable, survives a
//                                      bytes move, and is the thing an operator can ask about.
//   VIDEO_FINISH_TIER_STATE            a PROJECTION of that record onto the studio, re-derived at
//                                      every write to the studio: the provision upload, the
//                                      studio-upgrade re-upload, and the admin route below.
//
// RE-DERIVED, not carried, and this is the part that is easy to get wrong. The upgrade path carries
// every censused binding forward as `inherit` (cp#139), which PRESERVES a var rather than dropping
// it. Left alone, a studio marked unreachable and later cleared would keep displaying the sentence
// across the next bytes move, because inherit does not know the record changed. So both write paths
// strip this var out of the carried set and re-add it from the record. A studio that drifts is
// converged by the next write in either direction instead of quietly disagreeing with the plane.
//
// THE READER FLOOR, and it is a refusal rather than a warning. Setting this var on a studio whose
// bundle predates the reader is a silent no-op: the reader landed in vivijure-cf ba61789, first
// tagged v1.9.0, and the one live tenant runs v1.6.0 (Strummer measured it in the deployed bytes,
// string absent, count 0). That is the cf#98 / cf#118 / cp#112 failure family -- a change that looks
// applied and reaches nobody -- and this route refuses to join it. The check is not a version-string
// comparison: it asks the STUDIO what it serves, and requires the `capability:video-finish` key to
// be present in host.hooks_unavailable before it will write. A served field is the tenant assertion
// about itself; a release number is our claim about it.

import type { WorkerBinding } from "./cf-api";
import type { ProvisionDeps } from "./provisioner";
import type { Tenant } from "./store";
import { decryptStudioToken } from "./token-crypto";

/** The studio var the panel reads. Named here once; both write paths import it. */
export const VIDEO_FINISH_TIER_STATE_VAR = "VIDEO_FINISH_TIER_STATE";

/**
 * The ONE value this plane ever writes into that var.
 *
 * `provisionable` is deliberately NOT written: absent is already the conservative default on the
 * panel side, and a var that says the same thing as its own absence is a second way to express one
 * state, which is how two sources of truth start.
 */
export const VIDEO_FINISH_UNPROVISIONABLE = "unprovisionable";

/**
 * The panel key that PROVES the reader is live in the bundle a studio is running.
 *
 * Kept in sync with vivijure-cf VIDEO_FINISH_CAPABILITY_KEY by the reader-floor probe itself: if the
 * panel ever renamed it, this probe would stop finding it and the route would refuse to write rather
 * than write something nobody reads, which is the correct direction to fail in.
 */
export const VIDEO_FINISH_CAPABILITY_KEY = "capability:video-finish";

/** Is this tenant declared unreachable? D1 carries the flag as an integer; 1 is the only true. */
export function isVideoFinishUnreachable(tenant: Pick<Tenant, "video_finish_unreachable">): boolean {
  return Number(tenant.video_finish_unreachable) === 1;
}

/**
 * The projection: what this record means for the studio binding set. Empty for a reachable tenant,
 * because ABSENT is the state, not a value meaning absent.
 */
export function videoFinishTierStateBindings(
  tenant: Pick<Tenant, "video_finish_unreachable">,
): WorkerBinding[] {
  if (!isVideoFinishUnreachable(tenant)) return [];
  return [{ type: "plain_text", name: VIDEO_FINISH_TIER_STATE_VAR, text: VIDEO_FINISH_UNPROVISIONABLE }];
}

/**
 * Carry a binding set forward while RE-DERIVING this one var from the record.
 *
 * Both studio write paths call this, and both need it for the same reason from opposite directions:
 * a `plain_text` binding omitted from an upload or a settings patch is DROPPED, while an inherited
 * one SURVIVES. So dropping is how a cleared record reaches the studio, and re-adding is how a set
 * record reaches a studio that did not have it. Filtering first makes the outcome depend on the
 * record alone rather than on what happened to be bound already.
 */
export function withVideoFinishTierState(
  carried: WorkerBinding[],
  tenant: Pick<Tenant, "video_finish_unreachable">,
): WorkerBinding[] {
  return [
    ...carried.filter((b) => b.name !== VIDEO_FINISH_TIER_STATE_VAR),
    ...videoFinishTierStateBindings(tenant),
  ];
}

/** What the operator asked for. `reason` is mandatory when marking and meaningless when clearing. */
export interface VideoFinishTierStateIntent {
  unreachable: boolean;
  reason: string | null;
}

export interface VideoFinishTierStateRefusal {
  code:
    | "not_provisioned"
    | "tenant_deleted"
    | "tenant_studio_token_missing"
    | "tenant_studio_token_unreadable"
    | "studio_not_serving"
    | "studio_reader_absent";
  status: number;
  message: string;
}

export interface VideoFinishTierStateContext {
  script: string;
  studioApiToken: string;
  /** The sentence the studio serves for the capability key BEFORE the write, verbatim, or null. */
  servedReasonBefore: string | null;
}

export type VideoFinishTierStatePreflight =
  | { ok: true; context: VideoFinishTierStateContext }
  | { ok: false; refusal: VideoFinishTierStateRefusal };

/** The READBACK, not our opinion of the write. */
export interface VideoFinishTierStateResult {
  ok: boolean;
  script: string;
  unreachable: boolean;
  reason: string | null;
  /** Was the var bound on the studio before and after. The plane contract, censused not assumed. */
  var_present_before: boolean;
  var_present_after: boolean;
  bindings_before: string[];
  bindings_after: string[];
  secrets_before: string[];
  secrets_after: string[];
  /** Present before and absent after. MUST be empty; non-empty is the strand every write path fears. */
  missing_bindings: string[];
  missing_secrets: string[];
  /**
   * What the STUDIO now says, verbatim, for `capability:video-finish`. This is the reader-side half
   * of the evidence and the reason the route reads it back at all: the plane can prove it bound a
   * var, but only the studio can prove the panel projection changed. Reported and never compared
   * against a copy of the sentence, because the sentence is vivijure-cf copy and a second copy here
   * would be a drift source with no owner.
   */
  served_reason_before: string | null;
  served_reason_after: string | null;
  served_reason_changed: boolean;
}

const names = (list: { name: string }[]): string[] => list.map((b) => b.name).sort();

/**
 * Ask the studio what it serves for the video-finish capability key.
 *
 * Returns `undefined` when the studio could not be read at all, and `null` when it answered and the
 * key is absent. Those are different facts and the caller treats them differently: unreadable is a
 * refusal, absent-key is the reader floor.
 */
async function servedCapabilityReason(
  deps: ProvisionDeps,
  script: string,
  studioApiToken: string,
): Promise<string | null | undefined> {
  let res: { status: number; text: string };
  try {
    res = await deps.callTenantStudio(script, { method: "GET", path: "/api/modules", studioApiToken });
  } catch {
    return undefined;
  }
  if (res.status >= 300) return undefined;
  try {
    const body = JSON.parse(res.text) as { host?: { hooks_unavailable?: Record<string, unknown> } };
    const map = body?.host?.hooks_unavailable;
    if (!map || typeof map !== "object") return null;
    const reason = map[VIDEO_FINISH_CAPABILITY_KEY];
    return typeof reason === "string" ? reason : null;
  } catch {
    return undefined;
  }
}

/**
 * Everything that can refuse, checked BEFORE anything is written.
 *
 * THE READER FLOOR APPLIES TO MARKING ONLY, and the asymmetry is deliberate. Marking a studio that
 * cannot read the var writes something nobody will ever see, which is the defect this issue exists
 * to stop. CLEARING is always allowed: it removes a label, it converges a studio that may be
 * carrying a stale one, and refusing it would leave the only way to un-say something behind a probe
 * that has nothing to do with un-saying it.
 */
export async function preflightVideoFinishTierState(
  deps: ProvisionDeps,
  tenant: Tenant,
  intent: VideoFinishTierStateIntent,
): Promise<VideoFinishTierStatePreflight> {
  const refuse = (
    code: VideoFinishTierStateRefusal["code"],
    status: number,
    message: string,
  ): VideoFinishTierStatePreflight => ({ ok: false, refusal: { code, status, message } });

  if (tenant.deleted_at !== null) return refuse("tenant_deleted", 404, "this tenant no longer exists");
  if (!tenant.script_name) {
    return refuse(
      "not_provisioned",
      409,
      "this tenant has no studio script recorded, so there is no studio to project the state onto; " +
        "it needs a provision, not a tier-state write",
    );
  }
  if (!tenant.studio_token_enc) {
    return refuse("tenant_studio_token_missing", 422, "no studio token recorded for this tenant");
  }
  let studioApiToken: string;
  try {
    studioApiToken = await decryptStudioToken(deps.kek, tenant.studio_token_enc);
  } catch (e) {
    return refuse("tenant_studio_token_unreadable", 422, "the stored studio token could not be decrypted: " + String(e));
  }

  const servedReasonBefore = await servedCapabilityReason(deps, tenant.script_name, studioApiToken);
  if (servedReasonBefore === undefined) {
    return refuse(
      "studio_not_serving",
      422,
      "the tenant studio did not answer GET /api/modules with readable JSON, so what it reads " +
        "cannot be established; fix that before declaring anything about it",
    );
  }
  // THE FLOOR. An absent capability key means the panel projection for this tier is not running in
  // the bundle this studio serves, for one of two reasons, and the message names both because the
  // fix differs: the tier is BOUND (the resolver reports nothing at all, and a label would be inert
  // because an observation beats it), or the bundle PREDATES the reader (v1.9.0, vivijure-cf
  // ba61789) and the var would be a silent no-op.
  if (intent.unreachable && servedReasonBefore === null) {
    return refuse(
      "studio_reader_absent",
      422,
      "this studio does not serve the " +
        VIDEO_FINISH_CAPABILITY_KEY +
        " key on GET /api/modules, so setting " +
        VIDEO_FINISH_TIER_STATE_VAR +
        " would reach nobody. Either the video-finish tier is BOUND here (the panel resolves " +
        "available by observation and a label cannot override it), or the studio runs a bundle that " +
        "predates the reader (vivijure-cf v1.9.0). Move the studio bytes first, then re-run.",
    );
  }
  return { ok: true, context: { script: tenant.script_name, studioApiToken, servedReasonBefore } };
}

/**
 * Write the record, project it onto the studio, and read BOTH back.
 *
 * ORDER IS RECORD FIRST, PROJECTION SECOND, and the choice is about which half-failure is safe. If
 * the record lands and the patch fails, the plane is right and the next write to that studio
 * converges it -- and the failure is loud. If the patch landed and the record write failed, the
 * studio would be displaying a sentence the plane has no memory of, and the next bytes move would
 * silently un-say it. The source of truth goes first.
 *
 * NEVER writes tenants.status, tenants.studio_release, or the studio bytes: a live tenant is serving
 * throughout, exactly as the cp#112 binding refresh is.
 */
export async function applyVideoFinishTierState(
  deps: ProvisionDeps,
  tenant: Tenant,
  context: VideoFinishTierStateContext,
  intent: VideoFinishTierStateIntent,
): Promise<VideoFinishTierStateResult> {
  const { script, studioApiToken, servedReasonBefore } = context;

  // Census BEFORE, through the provisioner credential (reads). Secret NAMES only; these endpoints
  // never return values and this file never wants one.
  const before = await deps.cf.getScriptBindings(deps.namespace, script);
  const secretsBefore = await deps.cf.getScriptSecretNames(deps.namespace, script);
  const varPresentBefore = before.some((b) => b.name === VIDEO_FINISH_TIER_STATE_VAR);

  // (1) The record, which is the source of truth.
  await deps.store.setTenantVideoFinishUnreachable(
    tenant.id,
    intent.unreachable ? { reason: intent.reason as string, at: new Date(deps.now()).toISOString() } : null,
  );

  // (2) The projection. Everything else travels as `inherit`, so no binding VALUE is handled here --
  //     which is what lets this run against a tenant whose secrets the plane cannot reproduce
  //     (cp#112 measured that inherit preserves a secret_text binding across the patch).
  const carried: WorkerBinding[] = before.map((b) => ({ type: "inherit" as const, name: b.name }));
  const desired = withVideoFinishTierState(carried, {
    video_finish_unreachable: intent.unreachable ? 1 : 0,
  });
  await deps.scriptUploadCf.patchScriptSettings(deps.namespace, script, desired);

  // (3) Read back through the OTHER credential. success:true is the writing client opinion of its
  //     own work, and this route risk is a binding set that came back smaller than it went in.
  const after = await deps.cf.getScriptBindings(deps.namespace, script);
  const secretsAfter = await deps.cf.getScriptSecretNames(deps.namespace, script);
  const afterNames = new Set(after.map((b) => b.name));
  const afterSecrets = new Set(secretsAfter);
  const missingBindings = names(before)
    .filter((n) => n !== VIDEO_FINISH_TIER_STATE_VAR)
    .filter((n) => !afterNames.has(n));
  const missingSecrets = [...secretsBefore].sort().filter((n) => !afterSecrets.has(n));
  const varPresentAfter = afterNames.has(VIDEO_FINISH_TIER_STATE_VAR);

  // (4) The reader half: what the panel projection now says. The plane cannot assert the WORDS
  //     (they are vivijure-cf copy), so it reports them and reports whether they changed.
  const servedAfter = await servedCapabilityReason(deps, script, studioApiToken);
  const servedReasonAfter = servedAfter === undefined ? null : servedAfter;

  const result: VideoFinishTierStateResult = {
    ok: missingBindings.length === 0 && missingSecrets.length === 0 && varPresentAfter === intent.unreachable,
    script,
    unreachable: intent.unreachable,
    reason: intent.unreachable ? intent.reason : null,
    var_present_before: varPresentBefore,
    var_present_after: varPresentAfter,
    bindings_before: names(before),
    bindings_after: names(after),
    secrets_before: [...secretsBefore].sort(),
    secrets_after: [...secretsAfter].sort(),
    missing_bindings: missingBindings,
    missing_secrets: missingSecrets,
    served_reason_before: servedReasonBefore,
    served_reason_after: servedReasonAfter,
    served_reason_changed: servedReasonBefore !== servedReasonAfter,
  };

  deps.log("video_finish_tier_state.write", {
    tenant: tenant.id,
    script,
    ok: result.ok,
    unreachable: intent.unreachable,
    var_present_before: varPresentBefore,
    var_present_after: varPresentAfter,
    served_reason_changed: result.served_reason_changed,
    missing_bindings: missingBindings,
    missing_secrets: missingSecrets,
  });

  return result;
}
