// Envelope encryption for the per-tenant studio API token (#40 hosted tier; auth ruling 2026-07-18).
//
// The control plane injects each tenant's STUDIO_API_TOKEN at the dispatch layer (routing.ts), so it
// must hold the token VALUE at rest -- the one credential in this Worker not stored as a bare hash.
// Holding a usable secret is the exception, so it is encrypted: AES-256-GCM under a KEK that lives
// ONLY as a worker secret (STUDIO_TOKEN_KEK), never in D1. A control-plane D1 dump without the KEK
// yields nothing usable, preserving the "a D1 dump is worthless" property crypto.ts documents.
//
// Wire format: base64( iv[12] || ciphertext+tag ). The KEK is a base64-encoded 32-byte key.

const IV_BYTES = 12;

async function importKek(kekBase64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(kekBase64), (c) => c.charCodeAt(0));
  if (raw.byteLength !== 32) throw new Error("STUDIO_TOKEN_KEK must be a base64-encoded 32-byte key");
  return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toB64(u8: Uint8Array): string {
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Encrypt a token value for at-rest storage in control-plane D1. */
export async function encryptStudioToken(kekBase64: string, plaintext: string): Promise<string> {
  const key = await importKek(kekBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(iv.byteLength + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, iv.byteLength);
  return toB64(out);
}

/** Decrypt a stored token value for dispatch-time injection. Throws on a wrong KEK or tampering. */
export async function decryptStudioToken(kekBase64: string, blob: string): Promise<string> {
  const key = await importKek(kekBase64);
  const raw = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  const iv = raw.subarray(0, IV_BYTES);
  const ct = raw.subarray(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
