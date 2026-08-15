// The SHARED RunPod endpoint pool (cp#270).
//
// WHAT THIS IS. Conrad ruled 2026-08-01 that the hosted SHARED tier will never provision dedicated
// per-tenant RunPod endpoints: shared tenants ride the endpoints that already exist. This module is
// the plane-side half of that -- it turns a configured pool into the SAME TenantEndpoint[] shape the
// dedicated path produces, so nothing downstream has to know which shape it got.
//
// WHY THAT WORKS AT ALL, and it is worth stating because it is why this file is small: both
// consumers of the endpoint list are already indifferent to where the ids came from.
// uploadTenantModules binds `{plain_text RUNPOD_ENDPOINT_ID: endpoint.id}` and the studio upload
// binds `endpoints.map(e => ({name: e.endpointVar, text: e.id}))`. Neither reads a name, an owner, or
// an account. The dedicated path is the one that carries the extra machinery (key A, quota
// preflight, template env, adopt-by-name), and pooling simply does not enter it.
//
// WHAT THIS FILE DELIBERATELY DOES NOT HOLD: the pool's invoke key. The endpoints are identifiers
// and are safe to log, report and store; the key is a secret that goes from env straight into a
// worker secret binding and is never persisted, exactly like every other credential in this repo.
// Keeping them in separate values means a log line or an error message built from a pool cannot
// carry the credential by accident.
//
// THE HAZARD THIS FILE IS SHAPED AGAINST. A partially-configured pool is worse than an absent one: a
// tenant whose keyframe module has an endpoint and whose lipsync module does not is a studio that
// provisions green, serves, and then fails on the one render path nobody smoke-tested. So a pool is
// ALL-OR-NOTHING, and an incomplete one REFUSES rather than resolving the keys it happens to have.

import { endpointBackedPlan, vpcBackedPlan } from "./runpod";
import type { TenantEndpoint } from "./provisioner";

/**
 * How a tenant reaches RunPod. Recorded on the tenant row (migration 0018) rather than derived, so
 * a reader that must not treat a pooled endpoint as tenant property has a fact to branch on.
 */
export type RunPodMode = "dedicated" | "shared";

/** Narrow a stored column value. Anything unrecognised reads as dedicated, which is the SAFE
 *  direction: a dedicated reading makes teardown and reconcile treat the endpoints as tenant
 *  property and refuse to touch shared ones only by the referential guard, whereas a wrong SHARED
 *  reading would exempt a genuinely dedicated tenant from reaping. Fail toward doing less. */
export const readRunPodMode = (raw: string | null | undefined): RunPodMode =>
  raw === "shared" ? "shared" : "dedicated";

/** One configured pool member: the endpoint id, plus the name RunPod actually holds it under. */
export interface PoolEndpointConfig {
  id: string;
  /**
   * The endpoint's REAL name on the account.
   *
   * REQUIRED, not cosmetic, and this is the one piece of config burden this module insists on. The
   * name is what lets reconcile-runpod.ts identify a pool member in an operator's inventory snapshot
   * and refuse to call it an orphan. Without it the exclusion would have to key on id alone, which
   * works right up until the pool is reconfigured and a stale id silently stops being protected.
   */
  name: string;
}

export interface SharedRunPodPool {
  /** The pool as the provisioner's own endpoint type. Same shape the dedicated path returns. */
  endpoints: TenantEndpoint[];
  /** Every pool endpoint id, for the reconcile exclusion. Derived here so there is one source. */
  ids: ReadonlySet<string>;
  /** Every pool endpoint name, same purpose. */
  names: ReadonlySet<string>;
}

export type PoolConfigResult =
  | { ok: true; pool: SharedRunPodPool }
  | { ok: false; detail: string };

/**
 * The plan keys a pool MUST cover: every endpoint-backed entry in PROVISION_PLAN.
 *
 * Read off the plan rather than listed here, so adding a satellite to the plan makes every existing
 * pool config REFUSE until it is extended. That refusal is the point: the alternative is a new
 * capability that silently has no endpoint on the shared tier, which is the quiet-degrade class this
 * repo keeps refusing.
 */
export const requiredPoolKeys = (): string[] => endpointBackedPlan().map((spec) => spec.key);

/**
 * Parse the SHARED_RUNPOD_ENDPOINTS var into a pool.
 *
 * SHAPE: a JSON object keyed by PROVISION_PLAN key.
 *   {"backend":{"id":"abc123","name":"vivijure-prod-backend"}, "upscale":{...}, ...}
 *
 * ONE shape, no shorthand. A bare-string form ("backend":"abc123") would be friendlier and would
 * also mean two parse paths and a name that is sometimes absent -- and the name is exactly what the
 * reconcile exclusion depends on. Two accepted shapes is how the less-tested one rots.
 *
 * Every refusal names the field, because this is deploy config: the person reading the error is
 * looking at a var they just set, and "invalid pool" would send them to the code instead of the
 * value.
 */
export function parseSharedPool(raw: string | undefined | null): PoolConfigResult {
  const trimmed = raw?.trim();
  // EMPTY MEANS ABSENT, matching spendDailyCeiling / videoFinishServiceId / the kek ring (cp#218):
  // these vars are declared ALLOW_EMPTY in the deploy lists, so an unset knob arrives as "" and a
  // `?? undefined` check would treat the empty string as a configured pool.
  if (!trimmed) return { ok: false, detail: "SHARED_RUNPOD_ENDPOINTS is not set" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, detail: `SHARED_RUNPOD_ENDPOINTS is not JSON: ${String(e).slice(0, 120)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, detail: "SHARED_RUNPOD_ENDPOINTS must be a JSON object keyed by plan key" };
  }
  const byKey = parsed as Record<string, unknown>;

  // OWN IRON MUST NOT BE POOLED, and naming one here is REFUSED rather than ignored (cp#396).
  //
  // A config naming upscale or audio-upscale says somebody believes there is a RunPod endpoint for
  // a capability that runs on hardware we operate. The belief is not merely redundant: the shared
  // invoke key grants NO ACCESS to those endpoints, so the id would be unreachable and the failure
  // would surface at a tenant FIRST RENDER rather than here.
  //
  // Silently dropping a key an operator deliberately wrote is the quiet-degrade shape this whole
  // file exists to refuse, and it would leave them believing the pool covers something it does not.
  const vpcNamed = vpcBackedPlan()
    .map((c) => c.key)
    .filter((k) => k in byKey);
  if (vpcNamed.length) {
    return {
      ok: false,
      detail:
        "SHARED_RUNPOD_ENDPOINTS names own-iron capability(ies): " +
        vpcNamed.join(", ") +
        ". These run on hardware we operate and are reached over a Workers VPC binding, not as " +
        "RunPod endpoints, so no endpoint id belongs here and the shared invoke key has no access " +
        "to one. Remove the key rather than pointing it at an endpoint the plane cannot reach",
    };
  }

  const endpoints: TenantEndpoint[] = [];
  const missing: string[] = [];
  for (const spec of endpointBackedPlan()) {
    const entry = byKey[spec.key] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== "object") {
      missing.push(spec.key);
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!id || !name) {
      return {
        ok: false,
        detail:
          `SHARED_RUNPOD_ENDPOINTS["${spec.key}"] must carry a non-empty id AND name; the name is ` +
          "what lets reconciliation recognise a pool endpoint and refuse to report it as orphaned " +
          "debris, so it is not optional",
      };
    }
    endpoints.push({
      key: spec.key,
      label: spec.label,
      id,
      name,
      // Straight from the plan. The studio var an endpoint id belongs in is a property of the
      // CAPABILITY, not of who owns the endpoint, so it is identical on both paths by construction.
      endpointVar: spec.endpointVar,
    });
  }

  // ALL OR NOTHING. See the header: a pool covering three of four capabilities provisions a tenant
  // that renders keyframes and dies on lip sync, green the whole way.
  if (missing.length) {
    return {
      ok: false,
      detail:
        `SHARED_RUNPOD_ENDPOINTS is missing ${missing.length} of ${endpointBackedPlan().length} endpoint-backed plan ` +
        `key(s): ${missing.join(", ")}. A partial pool is refused rather than partially resolved: ` +
        "a tenant with some capabilities pointed at nothing provisions green and fails at the first " +
        "render on the missing path",
    };
  }

  // Two ids the same would mean two capabilities on one endpoint. That IS legitimate on the
  // dedicated path (keyframe and own-gpu share the backend endpoint via the module catalog, not via
  // the plan), but in the PLAN each key is a distinct endpoint, so a duplicate here is a copy-paste
  // in the config rather than an intent. Refuse and say which.
  const seen = new Map<string, string>();
  for (const e of endpoints) {
    const first = seen.get(e.id);
    if (first) {
      return {
        ok: false,
        detail:
          `SHARED_RUNPOD_ENDPOINTS uses endpoint id ${e.id} for both "${first}" and "${e.key}"; ` +
          "each plan key is a distinct endpoint, so this is a duplicated value rather than a pool",
      };
    }
    seen.set(e.id, e.key);
  }

  return {
    ok: true,
    pool: {
      endpoints,
      ids: new Set(endpoints.map((e) => e.id)),
      names: new Set(endpoints.map((e) => e.name)),
    },
  };
}
