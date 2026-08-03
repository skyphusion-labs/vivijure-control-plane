// The METERING half of the plane-side RunPod proxy, wired to routes (cp#290).
//
// cp#291 landed the primitives -- allow-list, webhook trust model, terminal parser, poll separation
// -- and said so plainly: they had no caller, so every ruling on cp#290 guarded nothing in
// production. This file is the caller. Two entry points, and they are the only two writes a job
// ever produces: `handleProxySubmit` opens the row, `handleProxyWebhook` closes it.
//
// ------------------------------------------------------------------------------------------------
// THE CALLBACK IS AN UNTRUSTED TRIGGER, NEVER EVIDENCE. Binding ruling on cp#290.
//
// MEASURED 2026-08-02: a RunPod terminal callback carries NO authentication of any kind (whole
// header set: `user-agent: Go-http-client/2.0` plus Cloudflare's own cf-*). Anyone who learns the
// URL can POST to it. Under deduct-on-success a forged COMPLETED is a forged CHARGE, so this is
// financial integrity rather than hygiene, and it takes two independent defences:
//
//   1. An opaque per-job token in the path, verified BEFORE any write.
//   2. The inbound body is never read. Terminal facts come from a GET /status WE issue against
//      RunPod with OUR credential.
//
// Defence 2 is what survives a leaked token, and it is STRUCTURAL here rather than promised:
// `handleProxyWebhook` is not handed the Request at all. A handler that never receives a body
// cannot read one, whatever a future edit intends.
// ------------------------------------------------------------------------------------------------
//
// WHAT THIS FILE DOES NOT DO, stated so nobody reads a gap as an oversight: it moves no money. The
// ruling bills on the final delivered video length, per FILM, on the last writer -- a property of
// the film.finish chain that the proxy never sees. What lands here is the per-JOB record that
// billing is computed FROM (`renders.output_ms` is the other half, cf#369 entry 2).

import { bearerFrom, sha256Hex } from "./crypto";
import {
  RUNPOD_HOST,
  buildUpstreamSubmitBody,
  callbackUrlFor,
  isAllowedEndpoint,
  mintWebhookToken,
  terminalFactsFromStatus,
  ProxyError,
  type RunpodProxyDeps,
} from "./runpod-proxy";
// The poll half is a LEAF and this direction of dependency is the safe one: the metering half may
// know about the poll half's refusal vocabulary; the reverse would hand a poll a store.
import { PLANE_REFUSAL_HEADER } from "./runpod-proxy-poll";
import { verifyTenantProxyToken } from "./runpod-proxy-auth";
import type { Tenant } from "./store";

/** Why a submit was refused. Every value is a distinguishable state on the wire, because a module
 *  that cannot tell "your studio is suspended" from "the plane is broken" degrades wrongly. */
export type SubmitRefusal =
  | "unauthorized"
  | "unknown_tenant"
  | "tenant_not_live"
  | "tenant_suspended"
  | "not_shared_mode"
  | "endpoint_not_allowed"
  | "bad_body";

/**
 * The tenant gate, PURE and separate so it can be tested without a network or a store.
 *
 * SUSPENSION IS CHECKED OFF ITS OWN COLUMN, not off `status`: the store never writes "suspended"
 * into status (two independent facts, two independent columns), so reading it there would mean the
 * kill switch never fires. Same trap routing.ts documents, same answer.
 *
 * MODE IS CHECKED TOO, and this is the parity guarantee in one line: only a `shared` tenant may
 * submit through the plane. A dedicated or BYO tenant holds its own key in its own RunPod account
 * and its path does not change at all, which is what keeps a self-hoster from ever needing us.
 */
export function submitRefusal(tenant: Tenant): SubmitRefusal | null {
  if (tenant.deleted_at !== null) return "unknown_tenant";
  if (tenant.suspended_at !== null) return "tenant_suspended";
  if (tenant.status !== "live") return "tenant_not_live";
  if (tenant.runpod_mode !== "shared") return "not_shared_mode";
  return null;
}

const HTTP_FOR: Record<SubmitRefusal, number> = {
  unauthorized: 401,
  unknown_tenant: 403,
  tenant_not_live: 403,
  tenant_suspended: 403,
  not_shared_mode: 403,
  endpoint_not_allowed: 403,
  bad_body: 400,
};

function refuse(reason: SubmitRefusal): Response {
  // Carries the plane-refusal header for the same reason the poll half does: the modules read an
  // unreachable upstream as "still running", so a plane refusal that looks like a transport blip
  // becomes a silent forever-pend. This header is the third state that lets them degrade honestly.
  return new Response(JSON.stringify({ error: "plane refusal: " + reason }), {
    status: HTTP_FOR[reason],
    headers: { "content-type": "application/json", [PLANE_REFUSAL_HEADER]: reason },
  });
}

function planeUnavailable(reason: string, detail: string): Response {
  return new Response(JSON.stringify({ error: "plane refusal: " + reason, detail }), {
    status: 503,
    headers: { "content-type": "application/json", [PLANE_REFUSAL_HEADER]: reason },
  });
}

/** The module's own name, for attribution only. TENANT-ASSERTED and treated as such: it labels a
 *  row, it never prices one. What a job cost is priced off the endpoint, which the tenant cannot
 *  misreport because the proxy read it off the URL it was willing to forward. */
export const MODULE_HEADER = "x-vivijure-module";

/** RunPod answers a submit with `{"id": "...", "status": "IN_QUEUE"}`. Parsed defensively: a body we
 *  cannot read is NOT a reason to fail the tenant's render, it is a reason to leave the row unopened
 *  and let the harvester find the job later. */
function jobIdFrom(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id ? parsed.id : null;
  } catch {
    return null;
  }
}

/**
 * POST <proxy base>/<endpoint>/run.
 *
 * ORDER MATTERS AND IS DELIBERATE: authenticate, resolve the tenant, check the allow-list, and only
 * then read the body. Nothing touches the store or the network until the caller has proved who it
 * is, so an unauthenticated flood costs one HMAC and nothing else.
 */
export async function handleProxySubmit(
  deps: RunpodProxyDeps,
  request: Request,
  endpointId: string,
): Promise<Response> {
  const tenantId = await verifyTenantProxyToken(deps.signingKey, bearerFrom(request));
  if (!tenantId) return refuse("unauthorized");

  let tenant: Tenant | null;
  try {
    tenant = await deps.store.getTenantById(tenantId);
  } catch (e) {
    // FAIL CLOSED on a broken lookup: a store we cannot read cannot tell us whether this tenant is
    // suspended, and submitting on "probably fine" walks a suspended studio past the kill switch.
    return planeUnavailable("store-unavailable", (e as Error).message);
  }
  if (!tenant) return refuse("unknown_tenant");
  const gate = submitRefusal(tenant);
  if (gate) return refuse(gate);

  // THE CHOKEPOINT. An endpoint the proxy does not know is an endpoint the meter cannot price, and
  // forwarding it would put unattributed spend on our own credit.
  if (!isAllowedEndpoint(endpointId, deps.poolEndpointIds)) return refuse("endpoint_not_allowed");

  let tenantBody: unknown;
  try {
    tenantBody = await request.json();
  } catch {
    return refuse("bad_body");
  }

  let key: string;
  try {
    key = await deps.runpodApiKey();
  } catch (e) {
    return planeUnavailable("credential-unavailable", (e as Error).message);
  }
  if (!key) return planeUnavailable("credential-unavailable", "no RunPod credential on the proxy");

  // Minted BEFORE the submit because RunPod takes the callback URL in the /run body. The mapping to
  // a job id can only be written afterwards -- see the race note below, which is real and bounded.
  const webhookToken = mintWebhookToken();
  let upstreamBody: Record<string, unknown>;
  try {
    // The clamp argument is deliberately omitted: the seam exists, the value does not, per the
    // ruling on cp#288. The endpoint-level execution timeout was raised ABOVE RunPod's stock
    // 600000ms because that default was killing real jobs, so a clamp implemented from the
    // documented default would kill tenant jobs the same way. The number is observed max + 30%,
    // per endpoint, and it is not measured yet.
    upstreamBody = buildUpstreamSubmitBody(tenantBody, callbackUrlFor(deps.callbackBase, webhookToken));
  } catch (e) {
    if (e instanceof ProxyError) return refuse("bad_body");
    throw e;
  }

  let upstream: Response;
  try {
    upstream = await deps.fetchImpl(`${RUNPOD_HOST}/v2/${encodeURIComponent(endpointId)}/run`, {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify(upstreamBody),
    });
  } catch (e) {
    // NOT a plane refusal: a transport failure reaching RunPod is the condition the modules already
    // handle, and mislabelling it would make a RunPod blip look like our outage.
    return new Response(JSON.stringify({ error: "upstream unreachable: " + (e as Error).message }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  const text = await upstream.text();
  const jobId = upstream.ok ? jobIdFrom(text) : null;

  if (jobId) {
    try {
      await deps.store.openRunpodProxyJob({
        job_id: jobId,
        tenant_id: tenant.id,
        tenant_slug: tenant.slug,
        module: request.headers.get(MODULE_HEADER),
        endpoint_id: endpointId,
        submitted_at: deps.now(),
        webhook_token_sha256: await sha256Hex(webhookToken),
      });
    } catch (e) {
      // THE RENDER IS ALREADY SUBMITTED. Failing the caller here would not unsubmit it; it would
      // only break the tenant's render on top of losing the row. So: log loudly and pass the
      // upstream answer through. The harvester is the backstop for exactly this -- an unrecorded
      // proxy job is still in the tenant's own job log, which is why 0019's harvest path stays and
      // must not be retired as superseded.
      console.error("runpod_proxy.open_failed", JSON.stringify({ job: jobId, error: String(e) }));
    }
  } else if (upstream.ok) {
    // A 2xx with no id is RunPod changing its response shape under us, and it is silent by nature:
    // the tenant's render proceeds and the meter never sees the job.
    console.error("runpod_proxy.no_job_id", JSON.stringify({ endpoint: endpointId, status: upstream.status }));
  }

  // Verbatim pass-through. The module parses RunPod's own body, so anything we reshape here is a
  // second contract to keep in sync with a vendor's.
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

/**
 * POST <plane>/api/runpod/webhook/<token>.
 *
 * NOTE THE SIGNATURE: no Request. That is the untrusted-trigger ruling made structural -- there is
 * no body in scope to be read, so no future edit can quietly start believing one.
 *
 * WHAT THE STATUS CODES MEAN HERE, because they are talking to RunPod's retry machinery rather than
 * to a user. Measured 2026-08-02: three attempts at +0s, +5.0s, +15.0s against a receiver returning
 * 500 (the documented "10-second delay" is wrong). So a non-2xx buys two more attempts over ~20s,
 * and that is exactly the recovery window for the one race this design has: a job that terminates
 * before our own submit-time write lands. An unknown token therefore answers 404 rather than 401 --
 * not because the caller deserves the distinction, but because a retry is free and might close a
 * row the reconciler would otherwise have to.
 */
export async function handleProxyWebhook(deps: RunpodProxyDeps, token: string): Promise<Response> {
  // FOUND LIVE, on the first `wrangler dev` probe (cp#290): an unwrapped lookup here turned a
  // store error into the router's generic 500 internal_error, which is indistinguishable in a log
  // from a bug in this handler and tells an operator nothing. Its sibling on the submit path was
  // already wrapped. Same posture as there -- name the failure, fail closed, write nothing.
  let ref;
  try {
    ref = await deps.store.findRunpodProxyJobByWebhookToken(await sha256Hex(token));
  } catch (e) {
    console.error("runpod_proxy.webhook_lookup_failed", JSON.stringify({ error: String(e) }));
    return planeUnavailable("store-unavailable", (e as Error).message);
  }
  if (!ref) {
    // The token is not logged. A rejected credential in a log line is still a credential, and this
    // one is valid for exactly one job's billing row.
    console.error("runpod_proxy.webhook_unverified", JSON.stringify({ reason: "no job for token" }));
    return new Response(JSON.stringify({ error: "unknown callback" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  // ALREADY CLOSED: answer and stop, BEFORE spending anything upstream.
  //
  // The ledger never needed this -- closeRunpodProxyJob is guarded by `terminal_at IS NULL`, so a
  // duplicate could not corrupt a closed row either way. What this bounds is OUTBOUND WORK.
  //
  // AND THAT SQL GUARD IS NOT NOW REDUNDANT, so do not remove it as superseded by this check. This
  // is read-then-act and has a race window: two callbacks arriving together both read a null
  // terminal_at and both proceed. The statement is what actually serialises them, and one of the two
  // still lands `changes === 0`. This bounds cost; the SQL bounds correctness. Without
  // it the route ran the authoritative GET /status on every repeat delivery and then discarded the
  // result at `changes === 0`, so a leaked per-job token bought unlimited authenticated requests on
  // OUR RunPod credential, indefinitely, for that job. That is precisely the residual the per-job
  // token exists to bound, and migration 0021 claimed it was already bounded. Caught in review on
  // cp#293 by reading the code rather than the comment.
  //
  // 200, NOT a refusal: a duplicate is NORMAL. RunPod delivered one job's terminal three times with
  // byte-identical bodies when the receiver merely looked slow (measured), and 200 is what stops the
  // retries. Filtering the lookup to open rows instead would 404 a legitimate duplicate and keep
  // RunPod retrying, which is worse.
  //
  // NOTE FOR ANYONE ADDING REFINEMENT LATER: this forecloses "a callback with better facts refines a
  // row the reconciler closed as unknown". That behaviour does not exist today -- the close guard
  // already refused it, so the old code merely paid for the read and threw the answer away. If it is
  // ever wanted, it needs its own explicit condition (close WHERE outcome = 'unknown'), not the
  // deletion of this short-circuit.
  if (ref.terminal_at !== null) {
    console.log(
      "runpod_proxy.terminal_duplicate",
      JSON.stringify({ job: ref.job_id, reason: "row already closed; no upstream read" }),
    );
    return new Response(JSON.stringify({ ok: true, closed: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (!ref.endpoint_id) {
    console.error("runpod_proxy.webhook_no_endpoint", JSON.stringify({ job: ref.job_id }));
    return planeUnavailable("row-incomplete", "job row carries no endpoint id");
  }

  let key: string;
  try {
    key = await deps.runpodApiKey();
  } catch (e) {
    return planeUnavailable("credential-unavailable", (e as Error).message);
  }
  if (!key) return planeUnavailable("credential-unavailable", "no RunPod credential on the proxy");

  // THE AUTHORITATIVE READ. Our request, our credential, RunPod's answer. Everything written below
  // comes from here and nothing comes from the caller.
  let status: unknown;
  try {
    const resp = await deps.fetchImpl(
      `${RUNPOD_HOST}/v2/${encodeURIComponent(ref.endpoint_id)}/status/${encodeURIComponent(ref.job_id)}`,
      { headers: { authorization: "Bearer " + key } },
    );
    if (!resp.ok) {
      console.error("runpod_proxy.status_read_failed", JSON.stringify({ job: ref.job_id, status: resp.status }));
      return planeUnavailable("status-read-failed", "upstream status " + resp.status);
    }
    status = await resp.json();
  } catch (e) {
    console.error("runpod_proxy.status_unreachable", JSON.stringify({ job: ref.job_id, error: String(e) }));
    return planeUnavailable("status-unreachable", (e as Error).message);
  }

  const facts = terminalFactsFromStatus(ref.job_id, status);
  if (!facts) {
    // Verified caller, authoritative read, job not terminal: a real race, not an attack. No write.
    // Non-2xx so the remaining attempts fire; the reconciler is the backstop that does not share
    // this gate.
    console.error("runpod_proxy.callback_not_terminal", JSON.stringify({ job: ref.job_id }));
    return planeUnavailable("not-terminal", "authoritative status is not terminal");
  }

  const changes = await deps.store.closeRunpodProxyJob({
    job_id: facts.jobId,
    outcome: facts.outcome,
    status_raw: facts.statusRaw,
    execution_ms: facts.executionMs,
    delay_ms: facts.delayMs,
    terminal_at: deps.now(),
  });

  // A duplicate is NORMAL, not an error: RunPod delivered one job's terminal three times with
  // byte-identical bodies when the receiver merely looked slow. Logged at info so the rate is
  // observable, and 200 either way so the retries stop.
  console.log(
    "runpod_proxy.terminal",
    JSON.stringify({
      job: facts.jobId,
      status: facts.statusRaw,
      outcome: facts.outcome,
      execution_ms: facts.executionMs,
      first_write: changes === 1,
    }),
  );
  return new Response(JSON.stringify({ ok: true, closed: changes === 1 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
