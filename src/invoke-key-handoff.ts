// cp#169: the operator-initiated, owner-completed invoke-key handoff (Conrad ruling, PATH 3).
//
// THE STRAND. `POST /api/admin/tenants/:id/reprovision-runpod` (cp#137) rebuilds a live tenant's
// four RunPod endpoints. New endpoints get new ids, so the tenant's stored key B is scoped to ids
// that no longer exist, and the last step of every repair is "install a fresh invoke key" -- on a
// route that resolves a SESSION, because the admin bearer is honoured only under /api/admin/. The
// operator who performed the repair therefore cannot finish it. Observed live during the cp#137
// remediation: a correctly-scoped key in the operator's hand, and the tenant sat at
// awaiting_invoke_key until the account owner signed in and pasted one.
//
// THE RULING, and what it does and does not move. Conrad: "we want to make things as convenient as
// possible while maintaining operator action." So the INITIATIVE moves to the operator and the
// CREDENTIAL DECISION stays with the owner. The plane mints a one-time link bound to one tenant and
// one set of endpoint ids; the operator hands it over through their support channel; the owner opens
// it, reads what happened, and pastes their own key. The operator never sees or holds the key, and
// no admin-gated install route exists (option 2 on cp#169, deliberately not taken: it would let an
// operator credential place a RunPod key on a customer studio, which is the custody expansion the
// two-key design exists to prevent).
//
// WHAT THE LINK CAN AND CANNOT DO, because "a link that installs a credential" deserves a precise
// bound rather than a reassuring adjective. It authorizes ONE install, on ONE tenant, and the key
// offered still has to pass verifyInvokeKeyScope UNCHANGED: refused if it can reach graphql, and
// required to reach all four of THIS tenant's endpoints. Those endpoints live in the TENANT's own
// RunPod account, so a stranger holding the link and no credential to that account can install
// nothing at all. The bound is RunPod's scoping, not our expiry; the expiry is what keeps a handed
// -over link from lingering in a support thread forever.
//
// WHAT IS STORED: the SHA-256 of the token and nothing else of it. The plaintext exists once, in the
// admin response the operator reads. The token value is never logged, never audited, and never
// returned to any caller a second time -- the same rule login_tokens and sessions follow. The audit
// rows for ISSUANCE and CONSUMPTION carry the handoff `id`, which is what lets them be correlated
// without either naming any part of the secret.
//
// SINGLE-USE IS BURNED ON A COMPLETED INSTALL, and that qualifier is load-bearing in two directions:
//   - a REJECTED key must not burn the link, or a typo re-strands the owner exactly as before;
//   - the 202 "modules have not picked it up yet" path must not burn it either, because that
//     response's own instruction is to RETRY the request, and a burnt link makes its advice a lie.
// So consumption happens only when the install reached `live`, and only through the store's
// conditional UPDATE, so two concurrent completions cannot both count.

import { newId, randomToken, sha256Hex } from "./crypto";
import type { ControlPlaneStore, InvokeKeyHandoff, Tenant } from "./store";
import { tenantEndpointIds } from "./tenants";

/**
 * How long a handed-over link stays usable.
 *
 * 72 hours, chosen for the channel this actually travels through: an operator repairs a tenant, then
 * reaches a customer through support, and a link that expires before a working day has passed sends
 * the operator back to mint another one, which is friction with no security return. The security
 * bound on this link is RunPod's scoping (see the header), not the clock, so the clock's job is only
 * to stop a link lingering in a support thread indefinitely.
 */
export const HANDOFF_TTL_HOURS = 72;

/** The page the owner opens. Served from public/install-key.html by the front-door assets. */
export const HANDOFF_PATH = "/install-key";

/** The query parameter carrying the token. Named once; the page and the routes both import it. */
export const HANDOFF_TOKEN_PARAM = "t";

/** The link, assembled in ONE place so the page path and the routes cannot drift apart. */
export function handoffUrl(origin: string, token: string): string {
  return `${origin}${HANDOFF_PATH}?${HANDOFF_TOKEN_PARAM}=${token}`;
}

export type HandoffMintRefusalCode =
  | "tenant_deleted"
  | "no_endpoints"
  | "not_provisioned";

export type HandoffResolveRefusalCode =
  | "handoff_unknown"
  | "handoff_expired"
  | "handoff_consumed"
  | "handoff_tenant_missing"
  | "handoff_endpoints_changed";

export interface HandoffRefusal<C> {
  code: C;
  status: number;
  message: string;
}

export interface MintedHandoff {
  /** The correlation id. Safe to log and audit; it is not part of the secret. */
  id: string;
  /**
   * THE ONLY TIME THIS VALUE EXISTS OUTSIDE THIS FUNCTION. Returned to the operator once, stored
   * only as a hash, never logged.
   */
  url: string;
  expires_at: string;
  /** The endpoint ids this handoff is bound to, so the operator can see what they are handing over. */
  endpoints: string[];
}

export type HandoffMintOutcome =
  | { ok: true; minted: MintedHandoff }
  | { ok: false; refusal: HandoffRefusal<HandoffMintRefusalCode> };

export interface HandoffContext {
  handoff: InvokeKeyHandoff;
  tenant: Tenant;
  /** The tenant's CURRENT endpoint ids, already proven to match the ones the handoff was bound to. */
  endpoints: string[];
}

export type HandoffResolveOutcome =
  | { ok: true; context: HandoffContext }
  | { ok: false; refusal: HandoffRefusal<HandoffResolveRefusalCode> };

export interface HandoffDeps {
  store: Pick<ControlPlaneStore, "createInvokeKeyHandoff" | "getInvokeKeyHandoff" | "consumeInvokeKeyHandoff" | "getTenantById">;
  now(): number;
  /** Injected so tests are deterministic. Production passes the crypto.ts primitives. */
  randomToken?: () => string;
  newHandoffId?: () => string;
  sha256Hex?: (s: string) => Promise<string>;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const token_ = (deps: HandoffDeps) => (deps.randomToken ?? randomToken)();
const id_ = (deps: HandoffDeps) => (deps.newHandoffId ?? (() => newId("ikh")))();
const hash_ = (deps: HandoffDeps, v: string) => (deps.sha256Hex ?? sha256Hex)(v);

/**
 * Mint a handoff for a tenant, or refuse.
 *
 * EVERY REFUSAL THE INSTALL ITSELF WOULD MAKE IS MADE HERE FIRST, and that is the point of checking
 * them at mint time rather than at paste time: the operator learns that a tenant has no endpoints or
 * no studio while they are still at the console, instead of the customer discovering it after being
 * sent a link. A handoff that could only ever end in a 409 should never have been handed over.
 */
export async function mintInvokeKeyHandoff(
  deps: HandoffDeps,
  tenant: Tenant,
  issuedBy: string,
  origin: string,
): Promise<HandoffMintOutcome> {
  const refuse = (
    code: HandoffMintRefusalCode,
    status: number,
    message: string,
  ): HandoffMintOutcome => ({ ok: false, refusal: { code, status, message } });

  if (tenant.deleted_at !== null) return refuse("tenant_deleted", 404, "this tenant no longer exists");
  const endpoints = tenantEndpointIds(tenant);
  if (endpoints.length === 0) {
    return refuse(
      "no_endpoints",
      409,
      "this tenant has no endpoints recorded, so there is nothing for a key to be scoped to; " +
        "it needs a provision or a reprovision, not a handoff link",
    );
  }
  if (!tenant.script_name) {
    return refuse(
      "not_provisioned",
      409,
      "this tenant has no studio script recorded, so a key would have nowhere to be installed; " +
        "finish provisioning before handing a link over",
    );
  }

  const token = token_(deps);
  const id = id_(deps);
  const expiresAt = iso(deps.now() + HANDOFF_TTL_HOURS * 60 * 60 * 1000);
  await deps.store.createInvokeKeyHandoff({
    token_hash: await hash_(deps, token),
    id,
    tenant_id: tenant.id,
    endpoints_json: JSON.stringify(endpoints),
    issued_by: issuedBy,
    expires_at: expiresAt,
  });
  return { ok: true, minted: { id, url: handoffUrl(origin, token), expires_at: expiresAt, endpoints } };
}

/** The ids a handoff was issued against, tolerant of a row we cannot parse (which is then stale). */
export function handoffEndpoints(handoff: InvokeKeyHandoff): string[] {
  try {
    const parsed: unknown = JSON.parse(handoff.endpoints_json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Resolve a token to a usable handoff WITHOUT consuming it, or refuse with a reason a person can act
 * on. Used by both the context read (the page) and the install, so the two cannot disagree about
 * whether a link is usable.
 *
 * THE STALENESS CHECK IS THE ONE WORTH READING TWICE. A handoff is bound to the endpoint ids that
 * existed when it was issued. If the tenant is reprovisioned again before the link is used, those
 * ids are dead, and an install that verified against them would store a key scoped to endpoints that
 * no longer exist -- precisely the state the handoff exists to repair, re-entered through the
 * mechanism meant to fix it. So a mismatch REFUSES and says a new link is needed. The comparison is
 * order-insensitive: the provisioner emits a fixed order, but a set difference is what is actually
 * meant, and depending on the order would fail a handoff that is genuinely fine.
 */
export async function resolveInvokeKeyHandoff(
  deps: HandoffDeps,
  token: string,
): Promise<HandoffResolveOutcome> {
  const refuse = (
    code: HandoffResolveRefusalCode,
    status: number,
    message: string,
  ): HandoffResolveOutcome => ({ ok: false, refusal: { code, status, message } });

  if (!token) return refuse("handoff_unknown", 404, "this link is not valid");
  const handoff = await deps.store.getInvokeKeyHandoff(await hash_(deps, token));
  // UNKNOWN and EXPIRED are deliberately different sentences. "Not valid" sends a person back to
  // the operator; "expired" tells them exactly what to ask for, which is a new link.
  if (!handoff) return refuse("handoff_unknown", 404, "this link is not valid");
  if (handoff.consumed_at) {
    return refuse(
      "handoff_consumed",
      409,
      "this link has already been used. Your key was installed; if something is still wrong, ask " +
        "your operator for a new link rather than re-pasting into this one",
    );
  }
  if (handoff.expires_at <= iso(deps.now())) {
    return refuse("handoff_expired", 410, "this link has expired. Ask your operator for a new one");
  }

  const tenant = await deps.store.getTenantById(handoff.tenant_id);
  if (!tenant || tenant.deleted_at !== null) {
    return refuse("handoff_tenant_missing", 404, "the studio this link was issued for no longer exists");
  }

  const current = tenantEndpointIds(tenant);
  const bound = handoffEndpoints(handoff);
  const same =
    current.length > 0 &&
    current.length === bound.length &&
    [...current].sort().join(",") === [...bound].sort().join(",");
  if (!same) {
    return refuse(
      "handoff_endpoints_changed",
      409,
      "this studio's render endpoints have changed since this link was issued, so a key scoped to " +
        "the endpoints it names would not work. Ask your operator for a new link",
    );
  }
  return { ok: true, context: { handoff, tenant, endpoints: current } };
}

/**
 * Burn a handoff after a COMPLETED install. Returns false when something else got there first,
 * which the caller reports rather than treats as a failure: the install itself already succeeded,
 * and the only fact in question is which request consumed the link.
 */
export async function burnInvokeKeyHandoff(deps: HandoffDeps, handoff: InvokeKeyHandoff): Promise<boolean> {
  const row = await deps.store.consumeInvokeKeyHandoff(handoff.token_hash, iso(deps.now()));
  return row !== null;
}
