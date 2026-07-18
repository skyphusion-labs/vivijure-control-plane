// Hand-rolled SSO: Google (OIDC) + GitHub (OAuth). Apple is a seam, parked (#52).
//
// No dependencies, per the ruling and the house rule: each provider is two fetches and some claim
// checking. crypto.subtle only.
//
// THE ONE SECURITY INVARIANT: a provider identity may only reach an account when the provider
// asserts the email as VERIFIED. Google must say email_verified; GitHub's address must be primary
// AND verified. Without that, anyone who sets an arbitrary unverified email at any provider takes
// over the matching vivijure account. Every path here returns a VerifiedIdentity or nothing.

import { b64url, pkceChallenge, randomToken } from "./crypto";
import type { ControlPlaneEnv } from "./env";
import { publicOrigin } from "./env";
import type { AuthProvider } from "./store";

export interface VerifiedIdentity {
  provider: AuthProvider;
  /** The provider's stable subject id. NOT the email: emails change, subjects do not. */
  subject: string;
  email: string;
}

export type SsoProvider = "google" | "github" | "apple";

/**
 * A provider is offered only when BOTH its public id and its secret are configured. This is what
 * makes /api/platform/config a projection of real capability instead of a hardcoded list, and it is
 * the whole Apple seam: the day Conrad stages the Team ID, Services ID, and .p8, Apple appears in
 * auth_methods with no code change. Until then it is absent rather than broken.
 */
export function configuredProviders(env: ControlPlaneEnv): SsoProvider[] {
  const out: SsoProvider[] = [];
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) out.push("google");
  if (env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET) out.push("github");
  if (env.APPLE_TEAM_ID && env.APPLE_SERVICES_ID && env.APPLE_PRIVATE_KEY) out.push("apple");
  return out;
}

export function isSsoProvider(v: string): v is SsoProvider {
  return v === "google" || v === "github" || v === "apple";
}

export function redirectUri(env: ControlPlaneEnv, provider: SsoProvider): string {
  return `${publicOrigin(env)}/auth/${provider}/callback`;
}

/** The authorize-URL leg. Returns the URL plus the state row the caller must persist. */
export async function authorizeUrl(
  env: ControlPlaneEnv,
  provider: SsoProvider,
  redirectTo: string | null,
): Promise<{ url: string; state: string; verifier: string | null }> {
  const state = randomToken();

  if (provider === "google") {
    // PKCE on a confidential client is belt-and-braces, and it costs one hash.
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID ?? "");
    url.searchParams.set("redirect_uri", redirectUri(env, "google"));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", await pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString(), state, verifier };
  }

  if (provider === "github") {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", env.GITHUB_OAUTH_CLIENT_ID ?? "");
    url.searchParams.set("redirect_uri", redirectUri(env, "github"));
    url.searchParams.set("scope", "read:user user:email");
    url.searchParams.set("state", state);
    return { url: url.toString(), state, verifier: null };
  }

  // Apple: the seam. Reaching here means configuredProviders() offered it, which cannot happen
  // until the credentials are staged. Explicit throw over a half-built flow that pretends to work.
  throw new Error("apple sign-in is not implemented yet (Team ID + Services ID + .p8 pending)");
}

/** The callback leg: code -> a VERIFIED identity, or null if the provider will not vouch for it. */
export async function exchangeCode(
  env: ControlPlaneEnv,
  provider: SsoProvider,
  code: string,
  verifier: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedIdentity | null> {
  if (provider === "google") return await exchangeGoogle(env, code, verifier, fetchImpl);
  if (provider === "github") return await exchangeGithub(env, code, fetchImpl);
  return null;
}

async function exchangeGoogle(
  env: ControlPlaneEnv,
  code: string,
  verifier: string | null,
  fetchImpl: typeof fetch,
): Promise<VerifiedIdentity | null> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri(env, "google"),
      grant_type: "authorization_code",
      ...(verifier ? { code_verifier: verifier } : {}),
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { id_token?: string } | null;
  if (!body?.id_token) return null;

  // Signature verification is intentionally omitted, and this is the ONE place that is defensible:
  // OIDC Core 3.1.3.7 item 6 permits skipping it when the ID token comes straight from the token
  // endpoint over TLS with client authentication, which is exactly this request. The transport IS
  // the proof. Claims below are still checked; skipping THOSE would be the real bug.
  const claims = decodeJwtPayload(body.id_token);
  if (!claims) return null;

  const iss = typeof claims.iss === "string" ? claims.iss : "";
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") return null;
  if (claims.aud !== env.GOOGLE_OAUTH_CLIENT_ID) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;

  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string" ? claims.email : "";
  // Google sends email_verified as a bool or the string "true" depending on the flow.
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (!sub || !email || !verified) return null;

  return { provider: "google", subject: sub, email };
}

async function exchangeGithub(
  env: ControlPlaneEnv,
  code: string,
  fetchImpl: typeof fetch,
): Promise<VerifiedIdentity | null> {
  const tokenRes = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: env.GITHUB_OAUTH_CLIENT_ID ?? "",
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri(env, "github"),
    }),
  });
  if (!tokenRes.ok) return null;
  const token = ((await tokenRes.json().catch(() => null)) as { access_token?: string } | null)?.access_token;
  if (!token) return null;

  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "vivijure-control-plane",
  };

  const userRes = await fetchImpl("https://api.github.com/user", { headers });
  if (!userRes.ok) return null;
  const user = (await userRes.json().catch(() => null)) as { id?: number } | null;
  if (typeof user?.id !== "number") return null;

  // GitHub's /user.email is whatever the user typed into their profile and is NOT proof of
  // anything. The primary+verified entry from /user/emails is the only address we will trust.
  const emailsRes = await fetchImpl("https://api.github.com/user/emails", { headers });
  if (!emailsRes.ok) return null;
  const emails = (await emailsRes.json().catch(() => null)) as
    | { email?: string; primary?: boolean; verified?: boolean }[]
    | null;
  if (!Array.isArray(emails)) return null;
  const primary = emails.find((e) => e.primary && e.verified && typeof e.email === "string");
  if (!primary?.email) return null;

  return { provider: "github", subject: String(user.id), email: primary.email };
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const pad = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
