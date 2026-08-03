// Plane-side RunPod invocation proxy (cp#288).
//
// WHAT IT IS FOR. On the shared tier no tenant-namespace script may hold a RunPod credential
// (CLAUDE.md, Conrad 2026-08-02: a consumer reaches RunPod through our product or not at all, BYOK
// excepted). Tenant module workers call the plane; the plane holds the key and calls RunPod. The
// verb-scoping question stops being load-bearing because there is no distributed credential to
// scope: RunPod's per-endpoint control has no operation axis, so no configuration can ever permit
// `run` while refusing `purge-queue`.
//
// THE SECOND REASON, which arrived from the metering lane and is now the larger one: the plane sees
// every submission, so the (job id -> tenant) map is produced AT SOURCE instead of reconstructed by
// a fan-out scan of every tenant database.
//
// ------------------------------------------------------------------------------------------------
// STRUCTURAL RULE: METER AT SUBMIT AND AT TERMINAL. NEVER ON THE POLL PATH.
//
// Polls are unbounded -- the orchestrator is client-driven at an 8s browser cadence and the finish
// phase issues one poll PER PENDING SHOT per tick, so a job is polled ceil(seconds/8) times. D1
// processes queries sequentially, so a write per poll makes the plane's database a fleet-wide
// serialization point at (shots x ticks) writes per render instead of ~2 per job.
//
// This file is the SUBMIT and TERMINAL half and it is the only half that takes a store. The poll
// pass-through lives in runpod-proxy-poll.ts, which is handed no store and imports nothing from
// here -- so a poll cannot meter because it has nothing to write to, which is a property of the
// module graph rather than of anyone's discipline. tests/runpod-proxy-poll.test.ts asserts that
// separation and fails if a future edit reconnects them.
// ------------------------------------------------------------------------------------------------

import type { ControlPlaneStore } from "./store";

/** RunPod's API host. Every submitter in the estate targets this one host, which is what makes a
 *  single chokepoint possible at all. */
export const RUNPOD_HOST = "https://api.runpod.ai";

/**
 * THE ALLOW-LIST. A submit to anything not named here is REFUSED, because an endpoint the proxy
 * does not know is an endpoint the meter cannot price.
 *
 * TWO KINDS, and conflating them is how a reconciliation silently omits half the spend:
 *
 *  - POOL endpoints are our own serverless endpoint IDs, resolved per-tenant at provision time from
 *    SHARED_RUNPOD_ENDPOINTS. They are opaque ids and are NOT listed here; they arrive as data.
 *
 *  - PUBLIC endpoints are RunPod's hosted third-party model slugs, hard-coded in the module source
 *    because they are the same for everyone. These are the GPUless cost door, which Conrad ruled IN
 *    SCOPE for the hosted tier on 2026-08-02 ("I want the cloud-i2v modules on the hosted door, it's
 *    literally one of the selling points").
 *
 * Measured at vivijure-cf@b295309, statement-level, against a denominator of 26 modules carrying a
 * src/index.ts: 14 reference api.runpod.ai/v2/, of which 8 hard-code a public slug and 6 read
 * RUNPOD_ENDPOINT_ID from env. Note `narration-gen` builds its URL by CONCATENATION
 * (`"https://api.runpod.ai/v2/" + MODEL`), so a line-level matcher for the literal returns 7 and
 * misses it -- match statements, not lines, and print the denominator.
 */
export const PUBLIC_ENDPOINT_ALLOWLIST: readonly string[] = [
  "wan-2-6-i2v", // alibaba-wan
  "wan-2-2-t2v-720-lora", // alibaba-wan-lora
  "google-veo3-1-fast-i2v", // google-veo
  "kling-v2-1-i2v-pro", // kling
  "minimax-hailuo-2-3-fast", // minimax-hailuo
  "minimax-speech-02-hd", // narration-gen
  "seedance-v1-5-pro-i2v", // seedance
  "vidu-q3-i2v", // vidu-q3
];

/**
 * RECONCILIATION MUST QUERY BOTH BILLING SCOPES. Noted here rather than built.
 *
 * The public slugs above are a DIFFERENT RunPod billing product from our own serverless endpoints;
 * `GET /v2/billing/serverless` is keyed on `serverlessId` and the docs state it is distinct from the
 * public-endpoint product. A reconciler built only on the serverless scope omits the entire cost
 * door AND READS AS BALANCED, because a missing scope returns no rows rather than an error. That is
 * group-by-hides-zeros at the vendor boundary: the failure is silent and flattering.
 */
export const RECONCILIATION_REQUIRES_BOTH_BILLING_SCOPES = true;

/** Terminal RunPod statuses. TIMED_OUT and CANCELLED are terminal and a naive poll walks past both,
 *  which is how a row sits at `submitted` forever (vivijure-cf#298, observed live). */
export const TERMINAL_STATUSES: readonly string[] = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];

/** Our own closed outcome vocabulary, mirroring the module-side one so the two halves of the index
 *  agree. Only `completed` is billable under Conrad's deduct-on-success rule. */
export type JobOutcome =
  | "submitted"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed-out"
  /**
   * WE WILL NEVER KNOW. Written only by the sweep, only when RunPod no longer has the job AND the
   * row is past the retention horizon -- never inferred, never a default, and never billable
   * (isBillable answers on `completed` alone, so this is safe by construction rather than by care).
   *
   * It exists because the alternative is worse in both directions. A row left `submitted` forever
   * reads as an in-flight job and quietly inflates what looks like work in progress; a row closed
   * as `failed` asserts something nobody observed. `unknown` is the only honest terminal, and it is
   * deliberately ugly to read in a report, because a rising count of these is a real signal about
   * the push path rather than a tidy default.
   */
  | "unknown";

export function outcomeForStatus(status: string): JobOutcome | undefined {
  switch (status) {
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    case "TIMED_OUT":
      return "timed-out";
    default:
      return undefined;
  }
}

/** Deduct-on-success, Conrad's ruling: deduction happens on SUCCESSFULLY COMPLETED jobs only, never
 *  on failures. Expressed as a function so no caller re-derives it from a status string. */
export function isBillable(outcome: JobOutcome | undefined): boolean {
  return outcome === "completed";
}

/**
 * MEASURED 2026-08-02 (cp#288 phase 2a), against a receiver returning 500 on every attempt:
 * RunPod delivered the terminal webhook 3 times at +0s, +5.009s, +15.007s. So the total
 * push-delivery window is ~20 SECONDS.
 *
 * RunPod's own documentation says "up to 2 more times with a 10-second delay". THE COUNT IS RIGHT
 * AND THE DELAYS ARE NOT. Do not re-derive this from the docs.
 *
 * This is ONE measurement of ONE job. It is a named constant with its provenance attached rather
 * than a magic number precisely because it must not harden into a contract: treat it as an observed
 * order of magnitude that bounds how long the meter may wait on the push before the reconciler is
 * the answer.
 */
export const OBSERVED_WEBHOOK_DELIVERY_WINDOW_MS = 20_000;

/** How long a row may sit open before the reconciler adopts it. Deliberately well past the observed
 *  delivery window so a slow-but-working push is never raced by a sweep. */
export const RECONCILER_ADOPT_AFTER_MS = 5 * 60_000;

/**
 * How long RunPod keeps an async result, after which a job id is unanswerable forever.
 *
 * BANDED HONESTLY, because the sweep's correctness must not depend on this number being right.
 * It is NOT a measurement and it is NOT from a vendor doc I have read: it traces to our own comment
 * at vivijure-cf@main `modules/_shared/runpod-job-log.ts:82` ("RunPod keeps async results for ~30
 * minutes and has no job-history API"), which is prose we wrote. Treat it as a WORKING FIGURE.
 *
 * SO THE SWEEP DOES NOT GATE ON IT. It asks RunPod about every eligible row regardless of age;
 * this value is only ever used as a SECOND, CORROBORATING condition before writing `unknown`, and
 * a row that fails either condition is left OPEN. If the real horizon is shorter we simply learn
 * nothing from a lost job (already true); if it is longer we leave rows open a while longer, which
 * says "nobody knows" out loud. Neither direction can produce a fabricated terminal, which is the
 * property that matters when the input is a number nobody measured.
 */
export const OBSERVED_RESULT_RETENTION_MS = 30 * 60_000;

// ------------------------------------------------------------------------------------------------
// WEBHOOK AUTHENTICITY. The callback is an UNTRUSTED TRIGGER, never evidence.
//
// MEASURED 2026-08-02: a RunPod terminal callback carries NO authentication of any kind. The full
// header set is `user-agent: Go-http-client/2.0` plus Cloudflare's own cf-* -- no signature, no
// HMAC, no shared secret, no bearer. Nothing distinguishes a genuine callback from any POST a
// stranger sends to the same URL.
//
// So an unauthenticated public URL that mutates a ledger is the entire problem in one sentence: a
// forged `{"id": "<job>", "status": "COMPLETED"}` would bill a tenant.
//
// TWO INDEPENDENT DEFENCES, both required:
//   1. An opaque, per-job, unguessable token in the callback path, verified before ANY write.
//   2. The callback is treated as "look at this job now" and NEVER as "this is what happened". The
//      authoritative terminal state comes from a GET /status/{id} WE initiate against RunPod with
//      OUR credential. The inbound body is not read for anything that reaches the ledger.
//
// Defence 2 is what makes the design correct even if the token leaks, and it is why the richness of
// the observed payload (it does carry status/executionTime/delayTime) does not change the shape:
// rich payload, untrusted channel.
// ------------------------------------------------------------------------------------------------

/** 32 bytes of CSPRNG, hex. Long enough that guessing is not a threat model. */
export function mintWebhookToken(random: (n: number) => Uint8Array = cryptoRandom): string {
  return [...random(32)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cryptoRandom(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Constant-time compare, so a token cannot be recovered a byte at a time from response timing.
 *
 *  RE-EXPORTED, not implemented here (cp#290). The implementation moved DOWN to ./constant-time so
 *  the poll half -- which must import nothing that can reach a store -- can authenticate its caller
 *  without an import path back into this file. Callers and tests of `tokensMatch` are unchanged. */
export { timingSafeEqual as tokensMatch } from "./constant-time";

export interface SubmitTarget {
  /** A pool endpoint id, or a public model slug from the allow-list. */
  endpointId: string;
}

export type ProxyRefusal =
  | "endpoint_not_allowed"
  | "not_shared_mode"
  | "bad_body"
  | "upstream_error"
  | "no_job_id";

export class ProxyError extends Error {
  constructor(
    readonly refusal: ProxyRefusal,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

/**
 * Is this endpoint one the proxy is willing to submit to?
 *
 * `poolEndpointIds` arrives as DATA (the tenant's resolved SHARED_RUNPOD_ENDPOINTS), the public
 * slugs are the compile-time list above. An endpoint in neither is refused: the meter cannot price
 * what it does not know, and silently forwarding it would put unattributed spend on our credit.
 */
export function isAllowedEndpoint(endpointId: string, poolEndpointIds: readonly string[]): boolean {
  if (!endpointId) return false;
  if (poolEndpointIds.includes(endpointId)) return true;
  return PUBLIC_ENDPOINT_ALLOWLIST.includes(endpointId);
}

/**
 * Rewrite a tenant's submit body into the one we send upstream.
 *
 * PURE, and deliberately so: it is the piece with the security-relevant behaviour, so it is
 * testable without a network. Two things happen here and nowhere else.
 *
 *  1. `webhook` is INJECTED (and any tenant-supplied `webhook` is OVERWRITTEN -- a tenant must not
 *     be able to redirect our terminal notification, nor to point it at a third party).
 *  2. `policy` is passed through with the executionTimeout CLAMP SEAM present and UNSET.
 *
 * ON THE CLAMP: the seam exists, the value does not, and that is deliberate per the ruling on
 * cp#288. The endpoint-level execution timeout was raised ABOVE RunPod's stock 600000ms by Conrad
 * because that default was killing real jobs, so a clamp here LOWERS a deliberately-raised ceiling
 * for shared tenants specifically. Anyone implementing a value from RunPod's documented default
 * will kill tenant jobs the same way. The number comes from phase-1 measurement: observed max +30%,
 * PER ENDPOINT, execution time only.
 */
export function buildUpstreamSubmitBody(
  tenantBody: unknown,
  webhookUrl: string,
  clampExecutionTimeoutMs?: number,
): Record<string, unknown> {
  if (!tenantBody || typeof tenantBody !== "object" || Array.isArray(tenantBody)) {
    throw new ProxyError("bad_body", "submit body must be a JSON object");
  }
  const src = tenantBody as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  // Overwrite, never merge: a tenant-supplied webhook is not a preference, it is an attempt to
  // redirect our own terminal signal.
  out.webhook = webhookUrl;
  if (clampExecutionTimeoutMs !== undefined) {
    const policy =
      src.policy && typeof src.policy === "object" && !Array.isArray(src.policy)
        ? { ...(src.policy as Record<string, unknown>) }
        : {};
    const existing = typeof policy.executionTimeout === "number" ? policy.executionTimeout : undefined;
    // Clamp DOWNWARD only. A tenant may ask for less; it may never ask for more than the ceiling.
    policy.executionTimeout =
      existing === undefined ? clampExecutionTimeoutMs : Math.min(existing, clampExecutionTimeoutMs);
    out.policy = policy;
  }
  return out;
}

/** Everything the terminal writer needs, taken from OUR authoritative status read. */
export interface TerminalFacts {
  jobId: string;
  statusRaw: string;
  outcome: JobOutcome;
  /** NULL, never 0, when RunPod did not report it. A CANCELLED job reports neither field. */
  executionMs: number | null;
  delayMs: number | null;
}

/** Parse a RunPod /status envelope into terminal facts, or undefined when the job is not terminal.
 *
 *  NULL-NOT-ZERO IS ENFORCED HERE, once, so no caller can reintroduce a zero. Measured: a CANCELLED
 *  job's payload carries no executionTime and no delayTime at all. A 0 in execution_ms would read as
 *  a real measurement of a job that took no time and would under-count the ledger silently. */
export function terminalFactsFromStatus(jobId: string, status: unknown): TerminalFacts | undefined {
  if (!status || typeof status !== "object") return undefined;
  const s = status as Record<string, unknown>;
  const statusRaw = typeof s.status === "string" ? s.status : "";
  const outcome = outcomeForStatus(statusRaw);
  if (!outcome) return undefined; // IN_QUEUE / IN_PROGRESS / anything unknown: not terminal, no write.
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    jobId,
    statusRaw,
    outcome,
    executionMs: num(s.executionTime),
    delayMs: num(s.delayTime),
  };
}

export interface RunpodProxyDeps {
  /** The ONE un-stubbable seam in production: the real fetch. Tests pass a recorder. */
  fetchImpl: typeof fetch;
  /** Resolves the pool RunPod credential. Never rendered, never returned to a caller. */
  runpodApiKey: () => Promise<string>;
  store: ControlPlaneStore;
  /** Absolute base of the plane's own callback route, e.g. https://plane.example/api/runpod/webhook */
  callbackBase: string;
  /** Signs and verifies the per-tenant proxy credential (runpod-proxy-auth.ts). UNDEFINED on a
   *  plane with no key installed, which fails every submit CLOSED rather than open. */
  signingKey: string | undefined;
  /** The tenant-facing pool endpoint ids, resolved from SHARED_RUNPOD_ENDPOINTS. DATA, not a
   *  compile-time list: they differ per deploy, unlike the public model slugs. */
  poolEndpointIds: readonly string[];
  /** Injectable clock, so a submit's recorded time is deterministic under test. */
  now(): number;
}

/** The callback URL for one job. The token is the LAST path segment so a proxy or log that truncates
 *  a query string cannot silently strip the credential. */
export function callbackUrlFor(base: string, token: string): string {
  return base.replace(/\/+$/, "") + "/" + token;
}
