// Types for the pure helpers in handoff-checks.js (cp#169). Hand-authored (no
// build step) so tests typecheck under the CI tsc gate.

export interface HandoffEndpointRow {
  id: string;
  name: string | null;
  label: string | null;
}

export interface HandoffContextPayload {
  handoff_id?: string;
  slug?: string;
  status?: string;
  expires_at?: string;
  endpoints?: unknown;
}

export const TOKEN_PARAM: string;
export const LINK_ERRORS: Record<string, string>;
export function tokenFromSearch(search: string | null | undefined): string;
export function linkErrorCopy(code: string | null | undefined, serverMessage?: string | null): string;
export function endpointRows(payload: HandoffContextPayload | null | undefined): HandoffEndpointRow[];
export function expiryNote(expiresAt: string | null | undefined, nowMs?: number): string;
