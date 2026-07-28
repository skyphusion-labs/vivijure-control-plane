// Types for the pure operator-console helpers in admin-checks.js. Hand-authored (no build step) so
// the tests typecheck under the CI tsc gate.

export interface ScopeCatalogueEntry {
  id: string;
  summary: string;
}

/** One row of the server's own authorization table, as served by whoami. */
export interface RequirementRow {
  method: string;
  /** The RegExp SOURCE, rebuilt client-side. First match wins, exactly as the server does it. */
  pattern: string;
  requires: string;
}

export interface WhoAmI {
  actor: string;
  kind: "root" | "credential";
  /** null for the shared root credential, which names nobody. */
  operator: string | null;
  credential_id: string | null;
  scopes: string[];
  catalogue: ScopeCatalogueEntry[];
  requirements: RequirementRow[];
}

export interface ScopeRow extends ScopeCatalogueEntry {
  held: boolean;
}

export interface Sections {
  identity: boolean;
  tenants: boolean;
  audit: boolean;
  settings: boolean;
  credentials: boolean;
  /** True for the break-glass credential, which the console declines to drive routine work with. */
  breakGlassNotice: boolean;
}

export interface TenantAction {
  id: string;
  label: string;
  method: string;
  /** Suffix appended to the tenant route, or null for an action that is not tenant-scoped. */
  path: string | null;
  needsReason: boolean;
  danger: boolean;
}

export interface RawAuditRow {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: string;
}

export interface AuditRowView {
  id: number;
  when: string;
  who: string;
  attributed: boolean;
  what: string;
  isTenantRead: boolean;
  target: string;
  detail: string;
}

export interface OperatorCredentialView {
  id: string;
  name: string;
  scopes: string[];
  created_at: string;
  created_by: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

export type MintResult =
  | { ok: true; payload: { name: string; scopes: string[]; expires_in_days?: number } }
  | { ok: false; message: string };

export const TENANT_ACTIONS: TenantAction[];
export function scopeRows(whoami: WhoAmI | null | undefined): ScopeRow[];
export function canDo(whoami: WhoAmI | null | undefined, scope: string): boolean;
export function isRoot(whoami: WhoAmI | null | undefined): boolean;
export function sectionsFor(whoami: WhoAmI | null | undefined): Sections;
export const PROBE_TENANT: string;
export function requirementFor(
  whoami: WhoAmI | null | undefined,
  method: string,
  path: string,
): string | null;
export function canCall(whoami: WhoAmI | null | undefined, method: string, path: string): boolean;
export function actionPath(action: TenantAction, tenantId: string): string;
export function principalLabel(whoami: WhoAmI | null | undefined): string;
export function tenantActions(whoami: WhoAmI | null | undefined): TenantAction[];
export function auditRow(row: Partial<RawAuditRow> | null | undefined): AuditRowView;
export function mintPayload(
  name: unknown,
  scopes: string[] | null | undefined,
  expiresDays: unknown,
): MintResult;
export function credentialState(
  credential: Partial<OperatorCredentialView> | null | undefined,
  nowIso: string,
): "live" | "revoked" | "expired" | "unknown";
export function tokenShapeHint(token: string): { level: "" | "ok" | "warn"; text: string };
export function errorCopy(body: { error?: string; message?: string } | null | undefined, status: number): string;
