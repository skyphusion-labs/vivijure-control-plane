// Envelope encryption for the per-tenant studio API token (#40 hosted tier; auth ruling 2026-07-18),
// and the two-key RING that makes the KEK rotatable (cp#95).
//
// The control plane injects each tenant's STUDIO_API_TOKEN at the dispatch layer (routing.ts), so it
// must hold the token VALUE at rest -- the one credential in this Worker not stored as a bare hash.
// Holding a usable secret is the exception, so it is encrypted: AES-256-GCM under a KEK that lives
// ONLY as a worker secret (STUDIO_TOKEN_KEK), never in D1. A control-plane D1 dump without the KEK
// yields nothing usable, preserving the "a D1 dump is worthless" property crypto.ts documents.
//
// Wire format: base64( iv[12] || ciphertext+tag ). A KEK is a base64-encoded 32-byte key.
//
// ---------------------------------------------------------------------------------------------
// WHY A RING AND NOT A KEY (cp#95)
//
// Rotation used to be impossible: one binding, one key, and `tenants.studio_token_enc` readable
// under that key alone. A credential you cannot rotate calmly is one you rotate badly, and the
// absence of the capability distorted a real decision during the 2026-07-25 recovery.
//
// The ring holds up to two keys and separates the two directions:
//
//   READ  tries BOTH keys, always. A row is readable whether it was written before, during, or
//         after a rotation, so the plane never stops serving mid-window.
//   WRITE uses exactly ONE key, named explicitly by `STUDIO_TOKEN_KEK_ENCRYPT_SLOT`.
//
// WHY THE WRITE SLOT IS A CONFIG VAR AND NOT D1 STATE. Two reasons, both load-bearing:
//
//   1. CONVERGENCE. The re-encryption sweep and the live write path must target the SAME key or the
//      sweep never finishes: sweep a row to the new key, let a provision write the next one under
//      the old key, repeat forever. Naming the slot in config makes "which key are we writing?" one
//      fact with one home, which both the sweep and the provisioner read.
//   2. CHANGE CONTROL. Flipping the write direction of every customer credential in the system is a
//      deploy, reviewable and revertable in git, not a hidden toggle someone can flick at 2am. It is
//      also the IaC-first rule this estate runs on.
//
// WHY THE MISSING-SLOT CASE IS A HARD ERROR RATHER THAN A FALLBACK. If the slot names `next` and no
// next key is installed, encryption REFUSES. Silently falling back to the primary would write live
// customer credentials under a key the operator believes is retired -- the failure would be
// invisible until the day someone deleted the wrong binding. Refusing is loud, and a refused
// provision is recoverable; a row encrypted under a forgotten key is not.
//
// REVERSIBILITY, stated precisely. While BOTH keys are installed, every step is reversible: reads
// try both, so flipping the slot back and re-running the sweep converges the other way. Neither key
// may be REMOVED until a full census shows zero rows depend on it -- that is what `kekCensus` in
// kek-rotation.ts is for, and why promotion is gated on it rather than on someone's memory.

const IV_BYTES = 12;

/** Which installed key new ciphertext is written under. Read direction always tries both. */
export type KekSlot = "primary" | "next";

/**
 * The installed keys plus the write direction.
 *
 * `primary` is `STUDIO_TOKEN_KEK` (the key in force). `next` is `STUDIO_TOKEN_KEK_NEXT`, present
 * only during a rotation window. `encryptSlot` names which one new ciphertext is written under.
 */
export interface KekRing {
  primary: string;
  next?: string;
  encryptSlot: KekSlot;
}

/** Raised when the ring cannot honour its own configuration. Never carries a key value. */
export class KekRingError extends Error {
  constructor(readonly code: "encrypt_slot_unavailable", message: string) {
    super(message);
    this.name = "KekRingError";
  }
}

/**
 * Build a ring from raw config values.
 *
 * Trimmed and empty-means-absent, the same rule `videoFinishServiceId` uses: a whitespace-only
 * secret is a paste accident, and treating it as a key would produce a ring that claims two keys and
 * has one. An unrecognized slot value falls back to `primary` -- the pre-rotation behaviour -- rather
 * than guessing, and the census route reports the configuration so the typo is visible.
 */
export function kekRing(primary: string, next?: string, encryptSlot?: string): KekRing {
  const cleanedNext = next?.trim() || undefined;
  const slot: KekSlot = encryptSlot?.trim() === "next" ? "next" : "primary";
  return { primary: primary.trim(), next: cleanedNext, encryptSlot: slot };
}

/** True when a second key is installed, i.e. a rotation window is open. */
export const rotationWindowOpen = (ring: KekRing): boolean => ring.next !== undefined;

async function importKek(kekBase64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(kekBase64), (c) => c.charCodeAt(0));
  if (raw.byteLength !== 32) throw new Error("a studio token KEK must be a base64-encoded 32-byte key");
  return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toB64(u8: Uint8Array): string {
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The key named by the write slot, or a NAMED refusal. Never returns the wrong key quietly. */
export function encryptionKey(ring: KekRing): string {
  if (ring.encryptSlot === "primary") return ring.primary;
  if (ring.next) return ring.next;
  throw new KekRingError(
    "encrypt_slot_unavailable",
    "STUDIO_TOKEN_KEK_ENCRYPT_SLOT names 'next' but STUDIO_TOKEN_KEK_NEXT is not installed. " +
      "Refusing to encrypt: falling back to the primary key would write customer credentials " +
      "under a key the operator believes is out of use. Install the next key or set the slot back " +
      "to 'primary', then redeploy.",
  );
}

async function encryptUnder(kekBase64: string, plaintext: string): Promise<string> {
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

async function decryptUnder(kekBase64: string, blob: string): Promise<string> {
  const key = await importKek(kekBase64);
  const raw = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  const iv = raw.subarray(0, IV_BYTES);
  const ct = raw.subarray(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/** Encrypt a token value for at-rest storage in control-plane D1, under the configured write slot. */
export async function encryptStudioToken(ring: KekRing, plaintext: string): Promise<string> {
  return await encryptUnder(encryptionKey(ring), plaintext);
}

/**
 * Decrypt a stored token value, trying the write slot FIRST and the other key second.
 *
 * Write-slot-first is not cosmetic: during a sweep most rows are already on the target key, so the
 * common path is one AES operation rather than two.
 *
 * Returns which key actually worked, because that is the fact a rotation census needs and the fact
 * a plain decrypt throws away. Callers that do not care use `decryptStudioToken`.
 */
export async function decryptStudioTokenWithSlot(
  ring: KekRing,
  blob: string,
): Promise<{ slot: KekSlot; plaintext: string }> {
  const order: KekSlot[] = ring.encryptSlot === "next" ? ["next", "primary"] : ["primary", "next"];
  let firstError: unknown;
  for (const slot of order) {
    const key = slot === "primary" ? ring.primary : ring.next;
    if (!key) continue;
    try {
      return { slot, plaintext: await decryptUnder(key, blob) };
    } catch (e) {
      // AES-GCM cannot tell "wrong key" from "tampered ciphertext" -- both surface as an auth-tag
      // failure. So a failure here is NEVER interpreted, only carried: if every installed key fails,
      // the FIRST error is rethrown and the caller reports a row it could not read, rather than this
      // code deciding which of the two it was. kekCensus counts that population separately for
      // exactly this reason.
      firstError ??= e;
    }
  }
  throw firstError ?? new Error("no studio token KEK is installed");
}

/** Decrypt a stored token value under any installed key. Throws when no installed key opens it. */
export async function decryptStudioToken(ring: KekRing, blob: string): Promise<string> {
  return (await decryptStudioTokenWithSlot(ring, blob)).plaintext;
}
