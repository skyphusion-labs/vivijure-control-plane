// Named, scoped operator credentials (cp#219).
//
// THE GAP THIS CLOSES. `/api/admin/*` was gated by ONE shared bearer. Holding it meant holding every
// admin capability over every tenant, and its audit rows record the actor as the literal string
// "admin-token", so the trail proves an event happened and nothing about who caused it. cp#193
// shipped around that on the money surface by storing `operator_claimed` -- a name typed into a
// form, deliberately labelled a claim, because recording it as verified would put false attribution
// into a money audit. That workaround was correct and it is evidence of the gap, not a fix.
//
// THE PRODUCT STANCE THIS ENCODES, ruled by Conrad 2026-07-27 and not re-litigated here: operator
// reach into a hosted tenant is inherent to hosting rather than a leak in it, the honest answer to
// anyone wanting assured zero-operator-access is self-host (a first-class door at absolute parity),
// and the access is held but exercised only on a report. So the work is SCOPING and ATTRIBUTION,
// never withholding. Two consequences shape this file:
//   - a credential grants only what its holder needs, so delegating one capability stops meaning
//     delegating all of them;
//   - every exercise records WHO, authenticated rather than claimed, because "we hold access we do
//     not routinely use" is marketing unless the trail makes it checkable.
//
// WHAT SCOPES DO AND DO NOT DO, stated here so nobody reads more into them than is true. A scope
// bounds what a credential can DO. It is only loosely a bound on what its holder can SEE: a
// credential with tenants:read plus studio:operate can reach a tenant's rendered output. Scoping is
// least privilege, not a privacy boundary, and the disclosure has to say so.

import { constantTimeEqual, sha256Hex } from "./crypto";
import type { OperatorCredential } from "./store";

/**
 * THE SCOPE CATALOGUE. Small on purpose: one entry per genuine hazard class, not one per route. A
 * scope per route would be unusable and would drift the day a route is added; a scope per hazard is
 * a decision an operator can actually make about a colleague ("read state, run upgrades, never tear
 * anything down, never mint money").
 *
 * The summaries are the text the console shows. They describe the CAPABILITY honestly, including
 * where it reaches tenant material, because the operator granting one reads this and nothing else.
 */
export const OPERATOR_SCOPES = [
  {
    id: "tenants:read",
    summary:
      "Read tenant records, provisioning state, credit balances, preservation holds and smoke-render results, " +
      "plus fleet-level reports (the tenant census, our R2 usage, RunPod reconciliation) and the audit trail. " +
      "Includes fetching a smoke-render artifact, which is rendered tenant content.",
  },
  {
    id: "tenants:write",
    summary:
      "Change a tenant's state without rebuilding it: suspend and resume, storage quota, abuse-report URL, " +
      "video-finish binding and tier state, opening and releasing preservation holds.",
  },
  {
    id: "tenants:destroy",
    summary: "Tear a tenant down. Irreversible, so it is its own scope and never folded into tenants:write.",
  },
  {
    id: "studio:operate",
    summary:
      "Run the studio: module and studio upgrades, refreshing studio bindings, re-provisioning RunPod, " +
      "starting a smoke render (which spends GPU), and minting an invoke-key handoff for an owner.",
  },
  {
    id: "credits:write",
    summary: "Issue an operator credit. This mints money from nothing and is the most abusable surface here.",
  },
  { id: "platform:settings", summary: "Flip platform-wide switches, today the signups gate." },
  {
    id: "meter:operate",
    summary:
      "Run the metering pipeline: force an ingest tick, which advances the ingestion watermark, and " +
      "force an overage settlement, which turns already-measured usage into ledger rows. Separate " +
      "from credits:write, which mints money from nothing on the manual rail, and from " +
      "platform:settings, because neither is a switch: these move the cursors a billing period is " +
      "built from.",
  },
  { id: "keys:rotate", summary: "Read KEK status and run the re-encryption sweep over stored studio tokens." },
] as const;

export type OperatorScope = (typeof OPERATOR_SCOPES)[number]["id"];

/** Every scope, in catalogue order. What the ROOT break-glass credential holds. */
export const ALL_SCOPES: readonly OperatorScope[] = OPERATOR_SCOPES.map((s) => s.id);

const KNOWN = new Set<string>(ALL_SCOPES);

export function isKnownScope(value: string): value is OperatorScope {
  return KNOWN.has(value);
}

/**
 * An authenticated admin caller.
 *
 * `operator` is the AUTHENTICATED human name, or null for the shared root token, which names nobody.
 * Callers that record attribution branch on exactly that null: a name is either authenticated or it
 * is a claim, and the two must never be written into the same field.
 */
export interface OperatorPrincipal {
  kind: "root" | "credential";
  /** What lands in admin_audit.actor: "admin-token" for root, "operator:<name>" for a credential. */
  actor: string;
  operator: string | null;
  credential_id: string | null;
  scopes: readonly OperatorScope[];
}

/** The audit actor for a named credential. One place, so the trail cannot drift into two formats. */
export function operatorActor(name: string): string {
  return `operator:${name}`;
}

/**
 * Stored scopes -> catalogue scopes.
 *
 * UNKNOWN ENTRIES ARE DROPPED, and that direction is deliberate: a scope retired from the catalogue
 * must grant nothing, and dropping can only ever NARROW a credential. The opposite policy (honour
 * what is stored) would let a scope survive its own removal.
 */
export function parseScopes(stored: string | null | undefined): OperatorScope[] {
  return String(stored ?? "")
    .split(/\s+/)
    .filter(isKnownScope);
}

/** Canonical storage form: deduped, catalogue order, space separated. */
export function formatScopes(scopes: readonly OperatorScope[]): string {
  return ALL_SCOPES.filter((s) => scopes.includes(s)).join(" ");
}

/**
 * Validate a mint request's scope list.
 *
 * REFUSES an unknown scope rather than dropping it. Silently dropping would mint a credential whose
 * holder believes they hold something they do not, and the failure would surface later as a
 * confusing 403 during whatever incident prompted the mint. Refuses an empty list too: a credential
 * that authenticates and can do nothing is far more likely a mistake than an intention.
 */
export function canonicaliseScopes(
  input: unknown,
): { ok: true; scopes: OperatorScope[] } | { ok: false; message: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, message: `scopes must be a non-empty array; known scopes are ${ALL_SCOPES.join(", ")}` };
  }
  const unknown = input.filter((s) => typeof s !== "string" || !isKnownScope(s));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `unknown scope(s) ${unknown.map(String).join(", ")}; known scopes are ${ALL_SCOPES.join(", ")}`,
    };
  }
  const scopes = ALL_SCOPES.filter((s) => (input as string[]).includes(s));
  return { ok: true, scopes };
}

/**
 * Operator names are an identity that lands in a money audit, so the shape is tight: lowercase, no
 * spaces, no punctuation that could be confused for the `operator:` prefix or for a scope separator.
 */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export function isValidOperatorName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name);
}

/**
 * FAIL CLOSED ON AN UNPARSEABLE EXPIRY. A row whose expires_at cannot be read is treated as expired,
 * not as never-expiring: the alternative is a credential that outlives its expiry because a
 * timestamp was written in a shape nobody anticipated.
 */
export function isExpired(credential: Pick<OperatorCredential, "expires_at">, nowIso: string): boolean {
  if (!credential.expires_at) return false;
  const at = Date.parse(credential.expires_at);
  const now = Date.parse(nowIso);
  if (Number.isNaN(at) || Number.isNaN(now)) return true;
  return at <= now;
}

export interface OperatorAuthStore {
  getOperatorCredentialByHash(hash: string): Promise<OperatorCredential | null>;
}

/**
 * Resolve a presented bearer to a principal, or null (which the caller answers with 401).
 *
 * NAMED CREDENTIALS ARE CHECKED FIRST. They are the normal path, and the ordering means a value
 * present in both places resolves to the one that carries attribution rather than the one that does
 * not. The lookup is a hash equality in SQL rather than a constant-time compare: the stored value is
 * a SHA-256 preimage-resistant digest, so what a timing signal could leak is whether a guessed
 * 256-bit token exists, which is the same thing the response already says.
 *
 * FAILS CLOSED IN BOTH DIRECTIONS. An unset root secret means no root surface, not an open one
 * (unchanged from isAdmin). A revoked or expired credential resolves to null, checked here rather
 * than by a sweep, so revocation takes effect on the very next request.
 */
export async function resolveOperator(
  presented: string | null,
  rootSecret: string | undefined,
  store: OperatorAuthStore,
  nowIso: string,
): Promise<OperatorPrincipal | null> {
  if (!presented) return null;

  const credential = await store.getOperatorCredentialByHash(await sha256Hex(presented));
  if (credential && !credential.revoked_at && !isExpired(credential, nowIso)) {
    return {
      kind: "credential",
      actor: operatorActor(credential.name),
      operator: credential.name,
      credential_id: credential.id,
      scopes: parseScopes(credential.scopes),
    };
  }

  if (rootSecret && (await constantTimeEqual(presented, rootSecret))) {
    // The shared break-glass credential. It holds everything AND names nobody, which is exactly why
    // its actor string stays "admin-token": root-token use must be visibly un-attributed in the
    // trail rather than borrowing an identity it cannot prove.
    return { kind: "root", actor: "admin-token", operator: null, credential_id: null, scopes: ALL_SCOPES };
  }

  return null;
}

export function hasScope(principal: OperatorPrincipal, scope: OperatorScope): boolean {
  return principal.scopes.includes(scope);
}
