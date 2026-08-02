// The POLL half of the plane-side RunPod proxy (cp#288). Stateless pass-through, by construction.
//
// ------------------------------------------------------------------------------------------------
// THIS MODULE EXISTS TO BE INCAPABLE OF METERING. That is its whole design.
//
// The rule is "meter at SUBMIT and at TERMINAL, never on the poll path", and a rule enforced by
// people reading a comment is not enforced. So the separation is structural instead:
//
//   - this module imports NOTHING from runpod-proxy.ts and nothing from any store;
//   - its deps type has no store field, so there is no handle to write through even by accident;
//   - in deployment the poll route is intended to run on a Worker with NO D1 binding at all, which
//     makes the property hold at the wrangler layer as well as the module layer.
//
// A poll cannot record a job because it has nothing to record into. tests/runpod-proxy-poll.test.ts
// asserts the import graph and fails if a future edit reconnects them.
//
// WHY IT MATTERS QUANTITATIVELY, not just tidily: the orchestrator is client-driven at an 8s browser
// cadence and the finish phase polls once PER PENDING SHOT per tick, so a job is polled
// ceil(job_seconds / 8) times. D1 processes queries sequentially. A write per poll turns the plane's
// database into a fleet-wide serialization point at (shots x ticks) writes per render, against ~2
// per job for submit-and-terminal.
// ------------------------------------------------------------------------------------------------

export interface RunpodPollDeps {
  /** The only capability this half has. Note the absence of a store: that absence IS the control. */
  fetchImpl: typeof fetch;
  runpodApiKey: () => Promise<string>;
}

/** Status and health are GETs and pass through untouched. `cancel` is a POST but carries no billing
 *  consequence and must stay reachable -- the modules issue it deliberately as the F17 spend-leak
 *  guard, and blocking it would leave jobs running and billing. */
export type PassthroughOp = "status" | "health" | "cancel";

export function upstreamUrlFor(op: PassthroughOp, endpointId: string, jobId?: string): string {
  const base = "https://api.runpod.ai/v2/" + encodeURIComponent(endpointId);
  if (op === "health") return base + "/health";
  if (!jobId) throw new Error(op + " requires a job id");
  return base + "/" + op + "/" + encodeURIComponent(jobId);
}

/**
 * Forward one poll upstream and hand the response back verbatim.
 *
 * DELIBERATELY NOT INTERPRETED. The modules' existing transport handling reads an unreachable
 * upstream as "still running" (`return { ok: true, pending: true }` on a poll catch, in all six
 * endpoint-backed modules). That was correct when the upstream was RunPod. Once the upstream is
 * OURS, the same code turns a degraded or mid-deploy plane into a silent forever-pend for every
 * in-flight tenant job, with no error surfacing anywhere.
 *
 * This function therefore does NOT invent a status when the upstream fails. It reports a plane-
 * authored refusal distinguishably (see PLANE_REFUSAL_HEADER) so the module can tell "the plane
 * refused" from "RunPod blipped" -- the third state that has to exist before the modules can degrade
 * honestly. Teaching the modules to READ that header is a vivijure-cf change, filed separately; this
 * side emits it so the two can land independently.
 */
export const PLANE_REFUSAL_HEADER = "x-vivijure-plane-refusal";

export async function passthrough(
  deps: RunpodPollDeps,
  op: PassthroughOp,
  endpointId: string,
  jobId?: string,
): Promise<Response> {
  let key: string;
  try {
    key = await deps.runpodApiKey();
  } catch (e) {
    return planeRefusal("credential-unavailable", (e as Error).message);
  }
  if (!key) return planeRefusal("credential-unavailable", "no RunPod credential on the proxy");
  try {
    const resp = await deps.fetchImpl(upstreamUrlFor(op, endpointId, jobId), {
      method: op === "cancel" ? "POST" : "GET",
      headers: { authorization: "Bearer " + key },
    });
    return resp;
  } catch (e) {
    // A transport failure reaching RunPod is NOT a plane refusal: it is the same condition the
    // modules already handle, and mislabelling it would make a RunPod blip look like our outage.
    return new Response(JSON.stringify({ error: "upstream unreachable: " + (e as Error).message }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}

function planeRefusal(reason: string, detail: string): Response {
  return new Response(JSON.stringify({ error: "plane refusal: " + reason, detail }), {
    status: 503,
    headers: { "content-type": "application/json", [PLANE_REFUSAL_HEADER]: reason },
  });
}
