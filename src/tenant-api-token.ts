// The tenant's PROGRAMMATIC studio token (vivijure-cf#94).
//
// CUSTODY, ruled 2026-07-24 and load-bearing for everything below: this is a SEPARATE token, not a
// reveal of the dispatcher-injected `STUDIO_API_TOKEN`. Rotating or revoking it must never sign the
// owner out of their browser session, and the two lifetimes stay independent.
//
// WHAT THE CONTROL PLANE STORES: nothing. The credential is a row in the TENANT's own studio
// database (`api_tokens`, studio migration 0009, from #445), and that table holds only the SHA-256
// hash. So "we cannot show it to you again" is true BY CONSTRUCTION rather than by discipline --
// there is no copy anywhere to show. That is also why the GET projection has no masked `display`
// field: masking a value implies keeping one, and a visible absence is the honest signal.
//
// The one thing the plane does keep is a lifecycle fact the studio has nowhere to put: WHEN the
// token was last rotated (`tenants.api_token_rotated_at`, migration 0009 here). Rotation replaces
// the studio row, so the studio's own `created_at` can only ever mean "when the current token was
// issued".
//
// THE COUPLING THAT NEARLY SHIPPED A BROKEN BUTTON: the studio's token gate returns 403 when
// `STUDIO_API_TOKEN` is unset, BEFORE it ever consults the named-token table (auth-gate.ts). A
// programmatic token is strictly ADDITIVE to the operator secret, not a replacement. So minting one
// on a studio without that secret would hand the tenant a credential that 403s on arrival. We refuse
// up front instead.

import type { CfApi } from "./cf-api";
import type { ControlPlaneStore, Tenant } from "./store";

/** Fixed, so rotation is idempotent and cannot collide with a satellite's own consumer token. */
export const PROGRAMMATIC_TOKEN_NAME = "programmatic";

/** The secret the studio's token gate requires before named tokens are even consulted. */
const STUDIO_OPERATOR_SECRET = "STUDIO_API_TOKEN";

export type ApiTokenRefusal = "tenant_not_live" | "not_provisioned" | "tenant_unreachable";

export class ApiTokenError extends Error {
  constructor(readonly code: ApiTokenRefusal, message?: string) {
    super(message ?? code);
    this.name = "ApiTokenError";
  }
}

export interface TenantApiTokenDeps {
  cf: Pick<CfApi, "queryD1" | "getScriptSecretNames">;
  store: Pick<ControlPlaneStore, "setApiTokenRotatedAt">;
  namespace: string;
  /** Injectable so tests are deterministic; production passes a 256-bit random hex generator. */
  randomToken: () => string;
  sha256Hex: (s: string) => Promise<string>;
}

export interface ApiTokenState {
  configured: boolean;
  name: string | null;
  created_at: string | null;
  last_rotated_at: string | null;
}

export interface MintedApiToken {
  /** THE ONLY TIME THIS VALUE EVER EXISTS OUTSIDE THE CALLER'S PROCESS. Never persisted, never logged. */
  token: string;
  name: string;
  created_at: string;
}

function rowsOf(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of raw) {
    const results = (entry as { results?: unknown } | null)?.results;
    if (Array.isArray(results)) out.push(...(results as Record<string, unknown>[]));
  }
  return out;
}

/** Every refusal this path can make, decided in ONE place so GET/POST/DELETE cannot drift apart. */
async function requireUsableTenant(deps: TenantApiTokenDeps, tenant: Tenant): Promise<string> {
  if (tenant.status !== "live") throw new ApiTokenError("tenant_not_live");
  if (!tenant.d1_database_id || !tenant.script_name) throw new ApiTokenError("not_provisioned");

  // The additive-token coupling, checked rather than assumed. Refusing here is the difference
  // between an honest "your studio is not finished" and handing over a token that 403s.
  let secrets: string[];
  try {
    secrets = await deps.cf.getScriptSecretNames(deps.namespace, tenant.script_name);
  } catch (e) {
    throw new ApiTokenError("tenant_unreachable", String(e));
  }
  if (!secrets.includes(STUDIO_OPERATOR_SECRET)) {
    throw new ApiTokenError(
      "not_provisioned",
      `tenant studio has no ${STUDIO_OPERATOR_SECRET}; a named token would be refused by its own gate`,
    );
  }
  return tenant.d1_database_id;
}

async function query(deps: TenantApiTokenDeps, db: string, sql: string, params?: unknown[]): Promise<unknown> {
  try {
    return await deps.cf.queryD1(db, sql, params);
  } catch (e) {
    // A tenant database we cannot reach is not "no token"; saying so would report a live credential
    // as absent, which is the more dangerous direction to be wrong in.
    throw new ApiTokenError("tenant_unreachable", String(e));
  }
}

export async function readTenantApiToken(deps: TenantApiTokenDeps, tenant: Tenant): Promise<ApiTokenState> {
  const db = await requireUsableTenant(deps, tenant);
  const rows = rowsOf(
    await query(deps, db, "SELECT name, created_at FROM api_tokens WHERE name = ? AND revoked_at IS NULL;", [
      PROGRAMMATIC_TOKEN_NAME,
    ]),
  );
  const row = rows[0];
  if (!row) return { configured: false, name: null, created_at: null, last_rotated_at: null };
  return {
    configured: true,
    name: String(row.name),
    created_at: row.created_at == null ? null : String(row.created_at),
    last_rotated_at: tenant.api_token_rotated_at,
  };
}

/**
 * Mint, or rotate in place. ONE call for both, because from the tenant's side they are the same
 * request ("give me a working token"), and a separate rotate verb invites a UI that can mint a
 * second live credential by accident.
 */
export async function issueTenantApiToken(deps: TenantApiTokenDeps, tenant: Tenant): Promise<MintedApiToken> {
  const db = await requireUsableTenant(deps, tenant);
  const existing = rowsOf(await query(deps, db, "SELECT name FROM api_tokens WHERE name = ?;", [PROGRAMMATIC_TOKEN_NAME]));
  const isRotation = existing.length > 0;

  const token = deps.randomToken();
  const hash = await deps.sha256Hex(token);

  // Upsert: the old hash is overwritten in the SAME statement that installs the new one, so there is
  // never a window with two live programmatic credentials, and a revoked row is revived rather than
  // blocking on the primary key.
  await query(
    deps,
    db,
    "INSERT INTO api_tokens (name, token_hash, created_at, revoked_at) VALUES (?, ?, datetime('now'), NULL) " +
      "ON CONFLICT(name) DO UPDATE SET token_hash = excluded.token_hash, created_at = datetime('now'), revoked_at = NULL;",
    [PROGRAMMATIC_TOKEN_NAME, hash],
  );

  // Stamped only on a real replacement: a first mint is not a rotation, and conflating them would
  // make the panel claim a rotation that never happened.
  if (isRotation) await deps.store.setApiTokenRotatedAt(tenant.id);

  const state = await readTenantApiToken(deps, tenant);
  return { token, name: PROGRAMMATIC_TOKEN_NAME, created_at: state.created_at ?? "" };
}

export async function revokeTenantApiToken(deps: TenantApiTokenDeps, tenant: Tenant): Promise<void> {
  const db = await requireUsableTenant(deps, tenant);
  // Soft revoke, matching what the studio's gate reads (`revoked_at IS NULL`). Keeping the row means
  // a later mint reuses it rather than racing the primary key, and the tenant's own DB retains the
  // fact that a credential existed.
  await query(deps, db, "UPDATE api_tokens SET revoked_at = datetime('now') WHERE name = ?;", [PROGRAMMATIC_TOKEN_NAME]);
}
