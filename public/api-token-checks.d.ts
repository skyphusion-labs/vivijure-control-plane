// Types for the pure helpers in api-token-checks.js (cf#94). Hand-authored (no
// build step) so tests typecheck under the CI tsc gate.
//
// Matches the contract Rollins committed: no `display` (the studio stores only a
// SHA-256 hash, so there is nothing to mask) and no `custody` on the wire (it is
// settled architecture, not runtime state; the optional field remains as a
// tripwire only).

export type TokenState = "absent" | "present" | "unknown";
export type TokenCustody = "shared" | "separate";

export interface TokenPayload {
  configured?: boolean;
  /** The named row in the tenant's api_tokens table, e.g. "programmatic". */
  name?: string | null;
  created_at?: string | null;
  last_rotated_at?: string | null;
  /** Not sent today. Honoured if a future payload ever declares shared custody. */
  custody?: string;
  /** Present only when the plane actually serves MCP for this tenant. */
  mcp_url?: string | null;
}

export interface TokenViewModel {
  state: TokenState;
  name: string | null;
  custody: TokenCustody | null;
  created_at: string | null;
  last_rotated_at: string | null;
}

export interface TokenSnippet {
  id: string;
  label: string;
  body: string;
}

export const TOKEN_ERRORS: Record<string, string>;
export function tokenView(payload: TokenPayload | null | undefined): TokenViewModel;
export function tokenErrorCopy(code: string | null | undefined): string | null;
export function rotateWarning(custody: TokenCustody | null | undefined): string;
export function revokeWarning(): string;
export function revealNotice(): string;
export function safeStudioUrl(url: string | null | undefined): string | null;
export function snippets(
  studioUrl: string | null | undefined,
  payload?: TokenPayload | null,
): TokenSnippet[];
export function whenLabel(iso: string | null | undefined): string;
export function summaryLine(view: TokenViewModel | null | undefined): string;
