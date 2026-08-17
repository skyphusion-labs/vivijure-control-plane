// Types for the pure front-door helpers in front-door-checks.js. Hand-authored
// (no build step) so tests typecheck under the CI tsc gate.

export interface MeTenant {
  id: string;
  slug: string;
  status: string;
  url?: string | null;
  suspended_reason?: string | null;
}

export interface MePayload {
  account?: { id: string; email: string; created_at?: string } | null;
  aup?: { required_version: string; accepted: boolean } | null;
  tenant?: MeTenant | null;
}

export interface PlatformConfig {
  signups_enabled?: boolean;
  aup_version?: string;
  auth_methods?: string[];
}

// The signed-out screen is ONE route. "signups-closed" was removed with the
// lockout it caused: the switch decides what that screen SAYS, never whether it
// carries a sign-in form. signupsOpen() answers the copy question separately.
export type ShellRoute =
  | "auth" | "aup" | "onboarding" | "go-live"
  | "studio" | "suspended" | "building" | "failed" | "deleted" | "unknown";

export const METHOD_LABELS: Record<string, string>;
export const AUTH_ERRORS: Record<string, string>;
export function methodLabel(method: string): string;
export function orderMethods(methods: string[] | null | undefined): string[];
export function shellRoute(me: MePayload | null | undefined): ShellRoute;
export function signupsOpen(config?: PlatformConfig | null): boolean;
export function authErrorCopy(code: string | null | undefined): string | null;
export function shouldWatch(route: ShellRoute | string | null | undefined): boolean;
