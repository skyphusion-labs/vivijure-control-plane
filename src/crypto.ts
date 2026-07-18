// Credential primitives for the control plane (#52).
//
// Every stored credential in this Worker is a SHA-256 hex hash, never a plaintext: login tokens,
// session tokens, the admin token. That is the studio's api_tokens rule (#445) applied to the
// platform, and it is what makes a control-plane D1 dump worthless to an attacker.
//
// No dependencies: crypto.subtle is the Workers runtime (and Node's webcrypto under vitest).

/** SHA-256 hex of a string. The one hashing entry point; mint hashes, the gate hashes and looks up. */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time compare via SHA-256 digest-compare, then XOR-fold: hash both sides and compare the
 * digests, so the loop always runs over a fixed 32 bytes and leaks neither length nor first-differing
 * byte. Same construction as the studio's src/auth-gate.ts.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const ua = new Uint8Array(da);
  const ub = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

/** A random 256-bit token, hex. The plaintext exists once (in a mail or a cookie); D1 gets the hash. */
export function randomToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A public id with a type prefix: acct_, ten_, job_. 96 bits is ample and keeps ids short. */
export function newId(prefix: "acct" | "ten" | "job"): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return `${prefix}_${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Pull a Bearer token off a request. Authorization is canonical and authenticates every method. */
export function bearerFrom(request: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

/** RFC4648 base64url, no padding. Used for PKCE and the OIDC JWT legs. */
export function b64url(input: Uint8Array | string): string {
  const u8 = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE S256 challenge for the Google leg. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}
