// The POLL half of the proxy, wired to routes (cp#290). Store-free, by construction, still.
//
// ------------------------------------------------------------------------------------------------
// THE WIRING IS WHERE THE SEPARATION PROPERTY WOULD HAVE BEEN LOST, so it gets its own file.
//
// runpod-proxy-poll.ts is incapable of metering because it imports no store and its deps type has
// no store field. That property is worth nothing if the ROUTE that calls it sits in a module that
// holds one -- the handler would simply be one line away from a write handle again. So the poll
// route lives here, and this file's import graph is asserted the same way the module's is
// (tests/runpod-proxy-poll.test.ts, now walking the graph TRANSITIVELY rather than one hop).
//
// It is also what makes the intended deployment possible: a poll Worker with NO D1 binding at all.
// Note what that requires of AUTHENTICATION -- it must verify without a lookup, which is why the
// tenant credential is a keyed MAC rather than a row in a table (runpod-proxy-auth.ts explains the
// trade, including the revocation cost it accepts).
//
// WHY POLLS ARE THE HALF THAT MATTERS QUANTITATIVELY: the orchestrator is client-driven at an 8s
// browser cadence and the finish phase polls once per pending shot per tick, so a job is polled
// ceil(job_seconds / 8) times against ~2 writes for submit-and-terminal. D1 processes queries
// sequentially. A write on this path is a fleet-wide serialization point.
// ------------------------------------------------------------------------------------------------

import { bearerFrom } from "./crypto";
import { PLANE_REFUSAL_HEADER, passthrough, type PassthroughOp, type RunpodPollDeps } from "./runpod-proxy-poll";
import { verifyTenantProxyToken } from "./runpod-proxy-auth";

/**
 * What the poll route may check about its caller, and what it deliberately may not.
 *
 * MAY: that the bearer is a token this plane signed, and that the endpoint is one we are willing to
 * talk to. Both are answerable from a MAC and a list.
 *
 * MAY NOT: that the tenant is still live, unsuspended, or shared-mode -- those live in a row, and
 * reading a row needs a store. That is a deliberate acceptance, not an oversight: submit is the
 * only path that spends money and it enforces all four, so a suspended tenant can start nothing.
 * What it retains is the ability to poll and CANCEL the jobs already in flight, which is the
 * correct outcome anyway -- cancel is the spend-leak guard, and taking it away from a tenant we
 * just suspended would leave their running jobs billing us.
 */
export interface ProxyPollAuth {
  signingKey: string | undefined;
  /**
   * INJECTED AS A FUNCTION, not as a list, and not imported.
   *
   * The allow-list predicate is `isAllowedEndpoint` in runpod-proxy.ts -- the metering half, which
   * this file may not import without putting a path back to the store into its graph. Copying the
   * predicate here would pass every test and leave two definitions of "allowed" to drift apart on a
   * money path. So the ONE implementation is handed in by the router as data, the same way the pool
   * endpoint ids themselves are. There is no second copy and no import.
   */
  isAllowed(endpointId: string): boolean;
}

function refuse(reason: string, status: number): Response {
  return new Response(JSON.stringify({ error: "plane refusal: " + reason }), {
    status,
    headers: { "content-type": "application/json", [PLANE_REFUSAL_HEADER]: reason },
  });
}

/**
 * GET/POST <proxy base>/<endpoint>/{status/<id> | cancel/<id> | health}.
 *
 * `deps` is typed `RunpodPollDeps`, and that type is the guard: TypeScript's excess-property check
 * rejects an object literal carrying a `store` at the call site in index.ts. The separation is
 * therefore enforced by tsc on the wiring, not only by this file's imports.
 */
export async function handleProxyPoll(
  deps: RunpodPollDeps,
  auth: ProxyPollAuth,
  request: Request,
  op: PassthroughOp,
  endpointId: string,
  jobId?: string,
): Promise<Response> {
  const tenantId = await verifyTenantProxyToken(auth.signingKey, bearerFrom(request));
  if (!tenantId) return refuse("unauthorized", 401);

  // The SAME allow-list the submit path enforces, applied here too. Without it a valid token could
  // drive our pool credential at any endpoint on the account -- the token would be authenticating a
  // tenant while authorizing nothing.
  if (!auth.isAllowed(endpointId)) return refuse("endpoint_not_allowed", 403);

  return await passthrough(deps, op, endpointId, jobId);
}
