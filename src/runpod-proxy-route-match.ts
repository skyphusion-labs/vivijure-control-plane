// The proxy's URL surface, in ONE place (cp#290).
//
// A LEAF: it imports one TYPE and nothing else. Both route halves need the matcher, and the poll
// half is required to reach no store, so the matcher cannot live in the file that holds the store.
//
// ------------------------------------------------------------------------------------------------
// THE SHAPE IS RUNPOD'S OWN, ON PURPOSE. Every module in the estate builds its RunPod URL as
// `https://api.runpod.ai/v2/<endpoint>` plus `/run`, `/status/<id>`, `/cancel/<id>` or `/health`
// (measured at vivijure-cf@d26db49 and again at b295309, statement-level: **14 of 26** modules with
// a src/index.ts reference the host -- of which 8 hard-code a public slug and 6 read
// RUNPOD_ENDPOINT_ID -- and those four suffixes are the complete verb set -- no `runsync`, no
// `purge-queue`. The count is pinned by tests/runpod-proxy-census.test.ts so an unreproduced
// figure cannot re-land as "measured" evidence; cp#298). Mounting the proxy at the same suffixes
// makes the module-side change a single base-string swap:
//
//     const base = env.RUNPOD_PROXY_BASE ?? "https://api.runpod.ai/v2";
//
// and nothing else. A prettier URL scheme here would have cost a rewrite of every call site.
//
// WHAT IS DELIBERATELY ABSENT IS THE POINT OF THE WHOLE ISSUE. `purge-queue` takes no job id and
// wipes an endpoint's queue for EVERY tenant on it; RunPod's per-endpoint scoping is a three-value
// enum with no operation axis, so no key configuration can permit `run` while refusing it. This
// matcher is where that refusal finally exists: an unmatched path under the proxy prefix is a 404,
// never a pass-through. `runsync` is absent for a different reason -- nothing uses it, and a verb
// the meter has never seen is a verb the meter cannot price.
// ------------------------------------------------------------------------------------------------

import type { PassthroughOp } from "./runpod-proxy-poll";

/** Everything the proxy serves lives under here. */
export const PROXY_PREFIX = "/api/runpod";

/** What a tenant module gets bound as RUNPOD_PROXY_BASE, appended to the plane's public origin.
 *  The `/v2` is RunPod's, kept so the suffixes below are byte-identical to the direct path. */
export const PROXY_UPSTREAM_PREFIX = `${PROXY_PREFIX}/v2`;

/** Where RunPod is told to call back. The per-job token is appended as the LAST path segment, so a
 *  log or intermediary that truncates a query string cannot silently strip the credential. */
export const PROXY_WEBHOOK_PREFIX = `${PROXY_PREFIX}/webhook`;

export type ProxyRoute =
  | { kind: "submit"; endpointId: string }
  | { kind: "poll"; op: PassthroughOp; endpointId: string; jobId?: string }
  | { kind: "webhook"; token: string }
  /** Under the prefix but not a route we serve. A REFUSAL, distinct from `null`, so the router
   *  answers 404 itself instead of letting the path fall through to the session gate below it. */
  | { kind: "unknown" };

/** Endpoint ids and public model slugs are both [a-z0-9-] in practice; job ids add `_`. Anchored,
 *  so a segment carrying a slash, a dot or an encoded traversal never reaches a URL we build. */
const SEGMENT = /^[A-Za-z0-9_-]+$/;
/** 32 bytes of CSPRNG, hex. Length is checked here so a malformed token is refused by shape before
 *  any lookup happens at all. */
const TOKEN = /^[0-9a-f]{64}$/;

/**
 * Classify a request path. Returns null when it is not ours at all, so the caller can fall through
 * to the rest of the router.
 *
 * PURE and exported for its own tests: this is the file that decides which verbs exist, and a verb
 * list nobody can test is a verb list nobody has checked.
 */
export function matchProxyRoute(method: string, path: string): ProxyRoute | null {
  if (path !== PROXY_PREFIX && !path.startsWith(`${PROXY_PREFIX}/`)) return null;

  if (path.startsWith(`${PROXY_WEBHOOK_PREFIX}/`)) {
    const token = path.slice(PROXY_WEBHOOK_PREFIX.length + 1);
    if (method === "POST" && TOKEN.test(token)) return { kind: "webhook", token };
    return { kind: "unknown" };
  }

  if (path.startsWith(`${PROXY_UPSTREAM_PREFIX}/`)) {
    const rest = path.slice(PROXY_UPSTREAM_PREFIX.length + 1).split("/");
    const [endpointId, op, jobId] = rest;
    if (!endpointId || !SEGMENT.test(endpointId)) return { kind: "unknown" };
    if (rest.length === 2 && op === "run" && method === "POST") return { kind: "submit", endpointId };
    if (rest.length === 2 && op === "health" && method === "GET") {
      return { kind: "poll", op: "health", endpointId };
    }
    if (rest.length === 3 && jobId && SEGMENT.test(jobId)) {
      if (op === "status" && method === "GET") return { kind: "poll", op: "status", endpointId, jobId };
      if (op === "cancel" && method === "POST") return { kind: "poll", op: "cancel", endpointId, jobId };
    }
    return { kind: "unknown" };
  }

  return { kind: "unknown" };
}
