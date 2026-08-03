// The credential a tenant module worker presents to the plane-side RunPod proxy (cp#288, cp#290).
//
// WHAT IT REPLACES. Today the plane writes the pool RunPod invoke key onto the tenant studio and
// every tenant module script (deps.ts installInvokeKey, 1+5 copies per tenant). Under the proxy no
// tenant-namespace script holds a RunPod credential at all: it holds THIS, which is worthless
// anywhere except our own plane. That is the hard invariant satisfied by construction rather than
// by policy -- a consumer reaches RunPod through our product or not at all (CLAUDE.md, Conrad
// 2026-08-02), BYOK excepted.
//
// ------------------------------------------------------------------------------------------------
// WHY IT IS STATELESS, AND THIS IS THE ONE DESIGN DECISION IN THE FILE.
//
// The obvious shape is a random token whose hash sits in a table: mint, store, look up on each call.
// It is the shape every other credential in this Worker uses, and it is WRONG HERE for one reason:
// the poll half of the proxy is required to hold no store. That requirement is not tidiness -- it
// is what makes a poll structurally incapable of metering (runpod-proxy-poll.ts), and the intended
// deployment is a poll Worker with NO D1 binding at all, so the property holds at the wrangler layer
// too. A poll route that must read a token table to authenticate CANNOT run on a Worker without a
// database. Choosing a stored token today would quietly foreclose the split we are building toward,
// and nothing would ever report that it had.
//
// So verification is a keyed MAC over the tenant id: no lookup, no table, no binding. The signing
// key is a Worker secret that never leaves the plane; the token is derived from it and is inert
// against RunPod, against Cloudflare, and against every surface except our own routes.
//
// WHAT THIS COSTS, STATED RATHER THAN GLOSSED. A stateless token cannot be revoked by deleting a
// row. Per-tenant refusal is therefore enforced ON THE SUBMIT PATH, which reads the tenant row
// anyway and refuses anything not live, not shared-mode, or suspended -- and submit is the only path
// that spends money. A refused tenant can still poll and cancel the jobs it already has in flight
// for the minutes they take to end. That is deliberate: cancel is the spend-leak guard, and taking
// it away from a tenant we have just suspended would leave their running jobs billing us. The
// coarse lever remains rotating the signing key, which invalidates every tenant at once.
// ------------------------------------------------------------------------------------------------

import { timingSafeEqual } from "./constant-time";

/** Version prefix. A format change gets a new one so an old token is REFUSED rather than
 *  reinterpreted -- a credential parsed under the wrong rules is a credential believed. */
export const PROXY_TOKEN_PREFIX = "vjp1";

/**
 * The two bindings a tenant module worker carries so it reaches RunPod THROUGH this plane rather
 * than directly (cp#288). Declared here, once, because the plane writes these names
 * (tenant-modules.ts) and the module reads them out of its own env, and a name restated in two
 * files is a fork waiting to happen -- the failure of a drifted name is an unread binding, which
 * looks exactly like a module that was never given one.
 *
 * BASE is the plane origin plus PROXY_UPSTREAM_PREFIX (runpod-proxy-route-match.ts), so the module
 * side is a single base-string swap and every suffix stays byte-identical to the direct RunPod
 * path. TOKEN is what mintTenantProxyToken returns below, presented as a bearer.
 *
 * BOTH OR NEITHER, and this is the one thing to get right at the call site. A module with NEITHER
 * keeps using its direct RUNPOD_API_KEY, which is the pre-proxy behaviour and works. A module with
 * a BASE and no TOKEN does not degrade: it switches to the proxy and is refused 401 on every call,
 * and nothing on the plane reports why.
 */
export const MODULE_PROXY_BASE_BINDING = "RUNPOD_PROXY_BASE";
export const MODULE_PROXY_TOKEN_BINDING = "RUNPOD_PROXY_TOKEN";

/** The MAC covers the prefix as well as the tenant id, so a v2 token can never verify as a v1 one
 *  for the same tenant. Domain separation is cheap here and impossible to retrofit. */
function macInput(tenantId: string): string {
  return `${PROXY_TOKEN_PREFIX}.${tenantId}`;
}

async function hmacHex(signingKey: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Mint the token for one tenant. Deterministic for a given (signing key, tenant), so re-minting is
 * idempotent and a re-provision does not silently issue a second live credential.
 *
 * Returns null when the plane has no signing key. FAIL CLOSED, and note WHICH direction that is:
 * an unconfigured plane mints nothing, so a tenant is provisioned without a proxy credential and
 * fails loudly at its first submit, rather than being handed a token nothing can verify.
 */
export async function mintTenantProxyToken(signingKey: string | undefined, tenantId: string): Promise<string | null> {
  if (!signingKey) return null;
  // A dot is the separator, so a tenant id carrying one would make the token ambiguous to parse.
  // Ids are `ten_<hex>` and cannot, but the guard is here because the day that changes, this file
  // is not where anyone will look.
  if (!tenantId || tenantId.includes(".")) return null;
  return `${PROXY_TOKEN_PREFIX}.${tenantId}.${await hmacHex(signingKey, macInput(tenantId))}`;
}

/**
 * Verify a presented token and return the tenant id it authenticates, or null.
 *
 * NULL IS THE ONLY FAILURE VALUE and every rejection path returns it: no signing key, wrong prefix,
 * malformed, bad MAC. A caller cannot accidentally distinguish "this plane cannot verify" from
 * "this token is forged" and treat one of them as an accept, which is the shape of most auth bugs
 * that ship.
 */
export async function verifyTenantProxyToken(
  signingKey: string | undefined,
  token: string | null | undefined,
): Promise<string | null> {
  if (!signingKey || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [prefix, tenantId, mac] = parts;
  if (prefix !== PROXY_TOKEN_PREFIX || !tenantId || !mac) return null;
  const expected = await hmacHex(signingKey, macInput(tenantId));
  // Constant time, so the MAC cannot be recovered a nibble at a time from response timing.
  return timingSafeEqual(mac, expected) ? tenantId : null;
}
