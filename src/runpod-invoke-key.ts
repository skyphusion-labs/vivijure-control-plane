// Key-B (stored invoke key) scope verification at paste time (#52; ruled in at the #52 design gate).
//
// WHY THIS EXISTS: the two-key custody design says the ONLY RunPod credential we ever store is a
// Restricted, endpoint-scoped INVOKE key. Nothing stops a tenant from pasting the wrong key, and
// the most likely wrong key is the powerful one (the transient graphql Read/Write provisioning key
// they just used). Storing that would silently throw away the entire custody win. So we verify the
// key's SHAPE before it is ever stored, and reject honestly if it is wrong.
//
// The probe semantics below are not guesses: they are the empirically resolved #60 probe matrix.
//   Restricted + invoke-scoped (what we WANT):
//     GET https://api.runpod.ai/v2/<id>/health  -> 200 on an in-scope endpoint, 403 out of scope
//     POST https://api.runpod.io/graphql        -> DENIED (401)
//   Restricted + graphql Read/Write (what we must REFUSE):
//     graphql -> 200. That is the tell, and it is the whole test.
//
// Fail CLOSED: anything we cannot positively confirm is a rejection, never a stored key.

const RUNPOD_INVOKE_BASE = "https://api.runpod.ai/v2";
const RUNPOD_GRAPHQL = "https://api.runpod.io/graphql";

export type InvokeKeyRejection =
  | "bad_prefix"
  | "graphql_capable"
  | "endpoint_out_of_scope"
  | "endpoint_unreachable"
  | "no_endpoints";

export interface InvokeKeyVerdict {
  ok: boolean;
  reason?: InvokeKeyRejection;
  /** The endpoints that answered 200. Present on rejection too, so the message can be specific. */
  inScope: string[];
  /** Endpoints that answered 403 (real, enforced, out-of-scope) or otherwise refused. */
  outOfScope: string[];
  detail?: string;
}

/**
 * Keys minted after 2024-11 carry the rpa_ prefix. A legacy key has different permission semantics
 * (it predates scoped keys entirely), so it cannot be the endpoint-scoped key this flow requires.
 * Cheap client-side-shaped check; the probes below are what actually decide.
 */
export function hasModernKeyPrefix(key: string): boolean {
  return key.startsWith("rpa_");
}

export async function verifyInvokeKeyScope(
  key: string,
  endpointIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<InvokeKeyVerdict> {
  if (endpointIds.length === 0) {
    return { ok: false, reason: "no_endpoints", inScope: [], outOfScope: [] };
  }
  if (!hasModernKeyPrefix(key)) {
    return {
      ok: false,
      reason: "bad_prefix",
      inScope: [],
      outOfScope: [],
      detail: "this does not look like a current RunPod key (expected an rpa_ prefix)",
    };
  }

  // 1. The refusal that matters most: a key that can reach graphql is a provisioning-capable key,
  //    and we do not store those. Checked FIRST so a too-powerful key is rejected before we bother
  //    probing endpoints with it.
  const graphqlReachable = await probeGraphql(key, fetchImpl);
  if (graphqlReachable) {
    return {
      ok: false,
      reason: "graphql_capable",
      inScope: [],
      outOfScope: [],
      detail:
        "that key has GraphQL access, which can create and delete resources across your whole " +
        "RunPod account. We will not store a key that powerful. Create a Restricted key with " +
        "api.runpod.io/graphql set to None and api.runpod.ai restricted to your 4 vivijure endpoints.",
    };
  }

  // 2. Positive control: the key must actually reach EVERY endpoint the studio will submit to.
  //    A key that is merely powerless would pass step 1; only this proves it is the RIGHT key.
  const inScope: string[] = [];
  const outOfScope: string[] = [];
  let unreachable: string | null = null;

  for (const id of endpointIds) {
    const result = await probeEndpointHealth(key, id, fetchImpl);
    if (result === "in_scope") inScope.push(id);
    else if (result === "out_of_scope") outOfScope.push(id);
    else {
      outOfScope.push(id);
      unreachable = id;
    }
  }

  if (inScope.length === endpointIds.length) return { ok: true, inScope, outOfScope };

  if (unreachable && outOfScope.length === 1) {
    return {
      ok: false,
      reason: "endpoint_unreachable",
      inScope,
      outOfScope,
      detail: `could not reach endpoint ${unreachable} to verify the key; nothing was stored`,
    };
  }
  return {
    ok: false,
    reason: "endpoint_out_of_scope",
    inScope,
    outOfScope,
    detail:
      `that key does not cover ${outOfScope.length} of your ${endpointIds.length} vivijure ` +
      "endpoints. Scope it to all four, then paste it again.",
  };
}

/** true = the key reached graphql (too powerful to store). Fails CLOSED: an error reads as reachable? No. */
async function probeGraphql(key: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(RUNPOD_GRAPHQL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "query { myself { id } }" }),
    });
    // 401/403 is the GOOD outcome here: the key cannot reach graphql.
    if (res.status === 401 || res.status === 403) return false;
    if (!res.ok) return false;
    // A 200 from graphql can still carry an errors array instead of data; only real data proves reach.
    const body = (await res.json().catch(() => null)) as { data?: { myself?: unknown } | null } | null;
    return Boolean(body?.data?.myself);
  } catch {
    // A transport failure is NOT evidence the key is safe. But it is also not evidence it is
    // graphql-capable, and returning true here would reject a correct key on a network blip. The
    // endpoint probes below still have to pass, so a blip fails the verification overall anyway.
    return false;
  }
}

async function probeEndpointHealth(
  key: string,
  endpointId: string,
  fetchImpl: typeof fetch,
): Promise<"in_scope" | "out_of_scope" | "error"> {
  try {
    const res = await fetchImpl(`${RUNPOD_INVOKE_BASE}/${endpointId}/health`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (res.ok) return "in_scope";
    // 403 = per-endpoint scoping is real and this endpoint is outside it (#60-proven).
    // 401 = the key is not an invoke key at all.
    if (res.status === 401 || res.status === 403) return "out_of_scope";
    return "error";
  } catch {
    return "error";
  }
}
