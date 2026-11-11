// Types for public/auth-callback.js. Hand-authored (no build step) so tests typecheck.

export function tokenFromHash(hash: unknown): string;

export function wire(
  doc: { getElementById(id: string): unknown },
  loc: { hash: string; pathname: string },
  hist: { replaceState(data: unknown, unused: string, url: string): void } | null,
): boolean;
