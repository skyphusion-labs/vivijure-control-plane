// Types for the pure helpers in api-token-checks.js (cf#94). Hand-authored (no
// build step) so tests typecheck under the CI tsc gate.

export type TokenState = "absent" | "present" | "unknown";
export type TokenCustody = "shared" | "separate";

export interface TokenPayload {
  configured?: boolean;
  created_at?: string | null;
  last_rotated_at?: string | null;
  /** Masked, backend-supplied. NEVER a plaintext token. */
  display?: string;
  custody?: string;
  /** Present only when the plane actually serves MCP for this tenant. */
  mcp_url?: string | null;
}

export interface TokenViewModel {
  state: TokenState;
  display: string;
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
