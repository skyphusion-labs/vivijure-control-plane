// cp#95: census and re-encryption sweep for a STUDIO_TOKEN_KEK rotation.
//
// WHAT THIS IS FOR. `tenants.studio_token_enc` is the only customer credential this plane stores as
// a usable value. Rotating the key that protects it means rewriting every one of those rows, and a
// loop over live customer credentials is exactly the kind of code that must be boring: resumable,
// idempotent, and safe to run twice on a bad day.
//
// THE THREE-BUCKET CENSUS IS THE POINT. AES-GCM cannot distinguish "wrong key" from "tampered
// ciphertext" -- both are an auth-tag failure. A two-bucket census (done / not done) would therefore
// file a CORRUPT row under "still needs rotating", the sweep would try it forever, and the operator
// would read a shrinking backlog as progress while one row silently never converged. So rows land in
// three buckets and the third one is an alarm, not a work item:
//
//   on_target      readable under the write-slot key. Nothing to do.
//   needs_rotation readable under the OTHER installed key. The sweep's actual work list.
//   unreadable     readable under NEITHER installed key. The sweep does not touch these and
//                  `safe_to_promote` is false while any exist. Dropping a key with one of these
//                  outstanding is how a tenant loses its token permanently.
//
// WHY PROMOTION IS GATED ON A MEASUREMENT. "Every row is on the new key" is precisely the claim a
// person is most likely to believe one pass too early. `safe_to_promote` is computed from a full
// census, never from the sweep's own report of what it did -- the same reason cp#112 reads back
// through a different credential instead of trusting `success: true`.
//
// WHAT THIS MODULE NEVER DOES. It never returns, logs, or records a token value or a key value. A
// plaintext exists only inside `rotateOne`, between the decrypt and the re-encrypt, and is dropped.

import type { KekRing, KekSlot } from "./token-crypto";
import { decryptStudioTokenWithSlot, encryptStudioToken, rotationWindowOpen } from "./token-crypto";

/** A row this module can work on: an id and the ciphertext. Deliberately not the whole Tenant. */
export interface EncryptedTokenRow {
  id: string;
  slug: string;
  studio_token_enc: string;
}

/**
 * The store surface this needs, named here rather than importing the whole ControlPlaneStore, so the
 * blast radius of a rotation sweep is legible from its own file.
 */
export interface KekRotationStore {
  /** EVERY row carrying a studio token, whatever its status. A deleted-but-present row still holds
   *  a customer credential encrypted under a key we are about to retire. */
  listEncryptedStudioTokens(): Promise<EncryptedTokenRow[]>;
  /** Compare-and-set. Writes only if the stored ciphertext is still the one we decrypted, so a
   *  provision that re-minted the token mid-sweep is never clobbered. Returns whether it wrote. */
  setTenantStudioTokenIfUnchanged(id: string, expectedEnc: string, newEnc: string): Promise<boolean>;
}

export interface KekCensus {
  window_open: boolean;
  encrypt_slot: KekSlot;
  /** Rows carrying a studio_token_enc at all. Rows without one are not a rotation concern. */
  total: number;
  on_target: number;
  needs_rotation: number;
  /** Slugs only, never ids-with-values. Loud by design: this list should always be empty. */
  unreadable: string[];
  /**
   * True only when a full census found every row on the write-slot key and nothing unreadable.
   * The operator gate for dropping the other key. False whenever the answer is not KNOWN.
   */
  safe_to_promote: boolean;
}

/**
 * Classify every stored token against the ring. Reads only; changes nothing.
 *
 * An EMPTY estate answers `safe_to_promote: true` with `total: 0`, and that is correct rather than
 * vacuous: there is genuinely no row depending on the other key. The count is returned alongside so
 * an operator reading "safe" can see WHY it is safe, and never mistakes "nothing to check" for
 * "checked everything" -- an empty answer that reads like a passing answer is the defect family this
 * estate has been bitten by, so the number is always in the answer.
 */
export async function kekCensus(store: KekRotationStore, ring: KekRing): Promise<KekCensus> {
  const rows = await store.listEncryptedStudioTokens();
  let onTarget = 0;
  let needsRotation = 0;
  const unreadable: string[] = [];

  for (const row of rows) {
    try {
      const { slot } = await decryptStudioTokenWithSlot(ring, row.studio_token_enc);
      if (slot === ring.encryptSlot) onTarget++;
      else needsRotation++;
    } catch {
      unreadable.push(row.slug);
    }
  }

  return {
    window_open: rotationWindowOpen(ring),
    encrypt_slot: ring.encryptSlot,
    total: rows.length,
    on_target: onTarget,
    needs_rotation: needsRotation,
    unreadable: unreadable.sort(),
    safe_to_promote: needsRotation === 0 && unreadable.length === 0,
  };
}

export interface SweepResult {
  /** Rows examined this run (bounded by `limit`). */
  examined: number;
  /** Rows already on the write-slot key. Idempotency shows up here on a second run. */
  skipped_on_target: number;
  rotated: number;
  /** Rows whose ciphertext changed under us mid-sweep; re-run picks them up. Not an error. */
  raced: number;
  /** Slugs of rows no installed key could open. Never touched. */
  unreadable: string[];
  /** True when this run examined every row; false means run again to continue. */
  complete: boolean;
}

/**
 * Re-encrypt stored tokens under the write-slot key.
 *
 * RESUMABLE by construction rather than by bookkeeping: the work list is derived from the data on
 * every run (a row is work iff it does not decrypt under the write slot), so there is no cursor to
 * persist, no progress row to go stale, and an interrupted run leaves a consistent estate. Running
 * it twice is a no-op the second time, which is the property that makes it safe to run when unsure.
 *
 * BOUNDED: `limit` caps rows examined per run so the sweep fits a Worker request. The default is
 * generous because this population is small (single digits at the time of writing) and a real cap
 * that never fires is better than an unbounded loop that fires once.
 *
 * REFUSES OUTSIDE A WINDOW. With only one key installed there is nothing to rotate toward, and the
 * only thing this could do is burn CPU re-encrypting rows under the key they already carry. That is
 * not harmless -- it rewrites every customer credential for no reason -- so it is refused.
 */
export async function sweepReencrypt(
  store: KekRotationStore,
  ring: KekRing,
  opts: { limit?: number } = {},
): Promise<SweepResult> {
  if (!rotationWindowOpen(ring)) {
    throw new Error(
      "no rotation window is open (STUDIO_TOKEN_KEK_NEXT is not installed), so there is no second " +
        "key to rotate toward; install it and redeploy before sweeping",
    );
  }
  const limit = opts.limit ?? 500;
  const rows = await store.listEncryptedStudioTokens();
  const batch = rows.slice(0, limit);

  let skipped = 0;
  let rotated = 0;
  let raced = 0;
  const unreadable: string[] = [];

  for (const row of batch) {
    let slot: KekSlot;
    let plaintext: string;
    try {
      ({ slot, plaintext } = await decryptStudioTokenWithSlot(ring, row.studio_token_enc));
    } catch {
      // Left exactly as it is. A row we cannot read is a row we must not overwrite: re-encrypting
      // would destroy the only ciphertext, and the value might still be recoverable from an escrowed
      // key we have not tried. It is reported and the census refuses promotion while it exists.
      unreadable.push(row.slug);
      continue;
    }
    if (slot === ring.encryptSlot) {
      skipped++;
      continue;
    }
    const reencrypted = await encryptStudioToken(ring, plaintext);
    // CAS on the ciphertext we actually read. A provision that re-minted this tenant's token while
    // we held the old plaintext would otherwise be silently reverted -- and the tenant would be left
    // authenticating with a token its studio no longer accepts.
    const wrote = await store.setTenantStudioTokenIfUnchanged(row.id, row.studio_token_enc, reencrypted);
    if (wrote) rotated++;
    else raced++;
  }

  return {
    examined: batch.length,
    skipped_on_target: skipped,
    rotated,
    raced,
    unreadable: unreadable.sort(),
    complete: batch.length === rows.length,
  };
}
