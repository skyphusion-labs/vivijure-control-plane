// DEPLOY-TIME scope gate for the SHARED pool invoke key (cp#396).
//
// THE HOLE THIS CLOSES. SHARED_RUNPOD_ENDPOINTS is a repo VARIABLE and SHARED_RUNPOD_INVOKE_KEY is
// a SECRET, set independently, by hand, at different times. Nothing reads a RunPod key permission
// set from code -- there is no scope endpoint -- so a pool naming an endpoint the key cannot reach
// is invisible to every check this repo had. It provisions green, serves, and dies at a tenant
// FIRST RENDER on the one capability nobody submitted to. That is the same quiet-degrade shape
// runpod-pool.ts refuses a partial pool for, one layer up: the pool can be COMPLETE and still be
// unreachable.
//
// IT IS THE SAME PROBE, NOT A SECOND ONE. verifyInvokeKeyScope already resolves exactly this
// question at tenant paste time (#52 / #60): GET /v2/<id>/health answers 200 in scope and 403 out
// of it, per endpoint, enforced by RunPod rather than asserted by us. Reimplementing that here
// would give the plane two probes that can disagree about the same key, so this composes it.
//
// WHY IT BELONGS ON THE DEPLOY PATH AND NOT AT RUNTIME. The pool is read on every provision, but a
// plane that discovers the mismatch while a tenant is waiting has already accepted the tenant. The
// deploy is the last moment refusing is free.

import { parseSharedPool } from "./runpod-pool";
import { verifyInvokeKeyScope } from "./runpod-invoke-key";

/** Why a plane was refused, or why it was allowed. One field, so a caller cannot read a refusal
 *  as a pass by looking at the wrong property. */
export type PoolScopeState =
  | "no_shared_tier"
  | "scope_verified"
  | "half_configured"
  | "pool_unparseable"
  | "key_out_of_scope";

export interface PoolScopeVerdict {
  ok: boolean;
  state: PoolScopeState;
  /** Pool endpoint ids the key really reached. Never a credential, only identifiers. */
  inScope: string[];
  /** Pool endpoint ids the key was refused on. This is the actionable half of a refusal. */
  outOfScope: string[];
  detail: string;
}

/**
 * Verify that the shared invoke key can reach EVERY endpoint the shared pool names.
 *
 * BOTH-OR-NEITHER, restated here because this is the layer that can see both halves. env.ts says
 * it in prose: either alone offers nothing. A pool with no key is a tenant that cannot render; a
 * key with no pool is a credential with nothing to spend. Half a pool is not a degraded pool.
 *
 * FAIL CLOSED on anything not positively confirmed, inherited from verifyInvokeKeyScope: an
 * endpoint that errored is counted OUT of scope, never quietly in.
 */
export async function verifySharedPoolScope(
  rawPool: string | undefined | null,
  invokeKey: string | undefined | null,
  fetchImpl: typeof fetch = fetch,
): Promise<PoolScopeVerdict> {
  const pool = rawPool?.trim() || null;
  const key = invokeKey?.trim() || null;

  if (!pool && !key) {
    return {
      ok: true,
      state: "no_shared_tier",
      inScope: [],
      outOfScope: [],
      detail: "this plane offers no shared tier (neither the pool nor its invoke key is set), which is a supported shape and not a gap",
    };
  }
  if (!pool || !key) {
    return {
      ok: false,
      state: "half_configured",
      inScope: [],
      outOfScope: [],
      detail:
        "the shared tier is HALF configured: " +
        (pool ? "SHARED_RUNPOD_ENDPOINTS is set but SHARED_RUNPOD_INVOKE_KEY is not" : "SHARED_RUNPOD_INVOKE_KEY is set but SHARED_RUNPOD_ENDPOINTS is not") +
        ". Either alone offers nothing, so set both or neither",
    };
  }

  // The pool has to be WELL FORMED before its ids mean anything. This reuses the one parser, so
  // every refusal it already owns (a missing plan key, an own-iron key named as an endpoint)
  // reaches the deploy with its own words rather than being re-derived into different ones.
  const parsed = parseSharedPool(pool);
  if (!parsed.ok) {
    return { ok: false, state: "pool_unparseable", inScope: [], outOfScope: [], detail: parsed.detail };
  }

  const ids = parsed.pool.endpoints.map((e) => e.id);
  const verdict = await verifyInvokeKeyScope(key, ids, fetchImpl);
  if (verdict.ok) {
    return {
      ok: true,
      state: "scope_verified",
      inScope: verdict.inScope,
      outOfScope: [],
      detail: "the shared invoke key reaches all " + ids.length + " pool endpoint(s)",
    };
  }
  return {
    ok: false,
    state: "key_out_of_scope",
    inScope: verdict.inScope,
    outOfScope: verdict.outOfScope,
    detail:
      "the shared invoke key does NOT cover " + verdict.outOfScope.length + " of the " + ids.length +
      " endpoint(s) SHARED_RUNPOD_ENDPOINTS names (" + verdict.outOfScope.join(", ") + "). " +
      "Refusing the deploy: this fails at a tenant first render, not here. Underlying reason: " +
      (verdict.reason ?? "unknown") + (verdict.detail ? " -- " + verdict.detail : ""),
  };
}
