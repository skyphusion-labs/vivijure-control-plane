import { describe, expect, it } from "vitest";

import { kekCensus, sweepReencrypt, type KekRotationStore } from "../src/kek-rotation";
import { decryptStudioToken, encryptStudioToken, kekRing } from "../src/token-crypto";

const KEK = btoa("0123456789abcdef0123456789abcdef");
const NEXT = btoa("ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP");
const ALIEN = btoa("FEDCBA9876543210FEDCBA9876543210");

const oldRing = kekRing(KEK);
const windowPrimary = kekRing(KEK, NEXT, "primary");
const windowNext = kekRing(KEK, NEXT, "next");

/**
 * A store whose ONLY job is to be honest about the CAS.
 *
 * Deliberately not a mock that records calls: the properties under test are what the DATA looks like
 * afterwards, and a call-recording fake would let a sweep "pass" while writing nothing.
 */
class RotationStore implements KekRotationStore {
  rows = new Map<string, { id: string; slug: string; studio_token_enc: string }>();
  /** Fires once, before the next CAS, to simulate a concurrent provision re-minting a token. */
  raceOnce?: (row: { id: string; studio_token_enc: string }) => void;

  add(id: string, slug: string, enc: string) {
    this.rows.set(id, { id, slug, studio_token_enc: enc });
  }

  async listEncryptedStudioTokens() {
    return [...this.rows.values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => ({ ...r }));
  }

  async setTenantStudioTokenIfUnchanged(id: string, expectedEnc: string, newEnc: string) {
    const row = this.rows.get(id);
    if (!row) return false;
    if (this.raceOnce) {
      const fn = this.raceOnce;
      this.raceOnce = undefined;
      fn(row);
    }
    if (row.studio_token_enc !== expectedEnc) return false;
    row.studio_token_enc = newEnc;
    return true;
  }
}

async function seed(): Promise<RotationStore> {
  const store = new RotationStore();
  store.add("ten_a", "alpha", await encryptStudioToken(oldRing, "tok-a"));
  store.add("ten_b", "bravo", await encryptStudioToken(oldRing, "tok-b"));
  store.add("ten_c", "charlie", await encryptStudioToken(kekRing(NEXT), "tok-c"));
  return store;
}

describe("kekCensus (cp#95)", () => {
  it("counts rows by WHICH key opens them, and answers safe_to_promote off that", async () => {
    const census = await kekCensus(await seed(), windowNext);
    expect(census).toMatchObject({
      window_open: true,
      encrypt_slot: "next",
      total: 3,
      on_target: 1, // charlie, already on NEXT
      needs_rotation: 2, // alpha + bravo, still on the primary
      unreadable: [],
      safe_to_promote: false,
    });
  });

  it("flips its verdict when the write slot points the other way, with no data change", async () => {
    const store = await seed();
    const census = await kekCensus(store, windowPrimary);
    // Same three rows; "on target" is a claim about the DIRECTION, so it must move with the slot.
    expect(census.on_target).toBe(2);
    expect(census.needs_rotation).toBe(1);
    expect(census.safe_to_promote).toBe(false);
  });

  it("reports an UNREADABLE row separately and refuses promotion while one exists", async () => {
    const store = await seed();
    store.add("ten_d", "delta", await encryptStudioToken(kekRing(ALIEN), "tok-d"));
    const census = await kekCensus(store, windowNext);
    // The whole point of the third bucket: a corrupt or foreign-key row must NOT be filed as
    // "needs rotation", because the sweep can never clear it and the backlog would never converge.
    expect(census.unreadable).toEqual(["delta"]);
    expect(census.needs_rotation).toBe(2);
    expect(census.safe_to_promote).toBe(false);
  });

  it("refuses promotion for an UNREADABLE row EVEN WHEN nothing else needs rotating", async () => {
    // ISOLATES the second half of safe_to_promote. Caught by mutation testing: the case above has a
    // non-zero needs_rotation, so it stays red if the unreadable check is deleted entirely -- it
    // proved the verdict, not the clause. Here every readable row is already on target, so the ONLY
    // thing that can hold the verdict false is the unreadable one.
    const store = new RotationStore();
    store.add("ten_a", "alpha", await encryptStudioToken(kekRing(NEXT), "tok-a"));
    store.add("ten_d", "delta", await encryptStudioToken(kekRing(ALIEN), "tok-d"));

    const census = await kekCensus(store, windowNext);
    expect(census.needs_rotation).toBe(0);
    expect(census.unreadable).toEqual(["delta"]);
    expect(census.safe_to_promote).toBe(false);
  });

  it("answers safe_to_promote TRUE on an empty estate, and shows the count that makes it true", async () => {
    const census = await kekCensus(new RotationStore(), windowNext);
    // An empty answer must never READ like a passing answer without its number attached.
    expect(census.total).toBe(0);
    expect(census.safe_to_promote).toBe(true);
  });
});

describe("sweepReencrypt (cp#95)", () => {
  it("rewrites every stale row under the write slot and leaves the values intact", async () => {
    const store = await seed();
    const result = await sweepReencrypt(store, windowNext);

    expect(result).toMatchObject({ examined: 3, rotated: 2, skipped_on_target: 1, raced: 0, complete: true });
    // VERIFIED BY READING THE DATA BACK under the target key alone -- not by trusting the counters.
    const after = await store.listEncryptedStudioTokens();
    const values = await Promise.all(after.map((r) => decryptStudioToken(kekRing(NEXT), r.studio_token_enc)));
    expect(values.sort()).toEqual(["tok-a", "tok-b", "tok-c"]);
    expect((await kekCensus(store, windowNext)).safe_to_promote).toBe(true);
  });

  it("is IDEMPOTENT: a second run rotates nothing and changes no ciphertext", async () => {
    const store = await seed();
    await sweepReencrypt(store, windowNext);
    const snapshot = (await store.listEncryptedStudioTokens()).map((r) => r.studio_token_enc);

    const second = await sweepReencrypt(store, windowNext);
    expect(second).toMatchObject({ rotated: 0, skipped_on_target: 3 });
    expect((await store.listEncryptedStudioTokens()).map((r) => r.studio_token_enc)).toEqual(snapshot);
  });

  it("is RESUMABLE: a bounded run finishes the job when re-run", async () => {
    const store = await seed();
    const first = await sweepReencrypt(store, windowNext, { limit: 1 });
    expect(first.complete).toBe(false);
    expect((await kekCensus(store, windowNext)).safe_to_promote).toBe(false);

    await sweepReencrypt(store, windowNext);
    expect((await kekCensus(store, windowNext)).safe_to_promote).toBe(true);
  });

  it("does NOT clobber a token re-minted underneath it; the race is reported, not swallowed", async () => {
    const store = await seed();
    const reminted = await encryptStudioToken(windowNext, "re-minted-by-a-provision");
    store.raceOnce = (row) => {
      if (row.id === "ten_a") row.studio_token_enc = reminted;
    };

    const result = await sweepReencrypt(store, windowNext);
    expect(result.raced).toBe(1);
    // The provision's value SURVIVED. Without the CAS the tenant would be left authenticating with
    // a token its own studio no longer accepts, which is worse than an unrotated row.
    expect(await decryptStudioToken(windowNext, store.rows.get("ten_a")!.studio_token_enc)).toBe(
      "re-minted-by-a-provision",
    );
  });

  it("NEVER overwrites a row no installed key can open", async () => {
    const store = await seed();
    const alienBlob = await encryptStudioToken(kekRing(ALIEN), "tok-d");
    store.add("ten_d", "delta", alienBlob);

    const result = await sweepReencrypt(store, windowNext);
    expect(result.unreadable).toEqual(["delta"]);
    // Byte-identical: the only ciphertext for that value is still there to be recovered with the
    // right key. Re-encrypting it under a key we could not read it with would destroy it.
    expect(store.rows.get("ten_d")!.studio_token_enc).toBe(alienBlob);
  });

  it("leaves safe_to_promote FALSE after a fully successful sweep if any row is unreadable", async () => {
    const store = new RotationStore();
    store.add("ten_a", "alpha", await encryptStudioToken(oldRing, "tok-a"));
    store.add("ten_d", "delta", await encryptStudioToken(kekRing(ALIEN), "tok-d"));

    const result = await sweepReencrypt(store, windowNext);
    expect(result).toMatchObject({ rotated: 1, complete: true, unreadable: ["delta"] });
    // Everything the sweep COULD do, it did. The gate still holds, because dropping the old key now
    // would make delta unrecoverable, and "the sweep finished" is not the same claim as "no row
    // depends on the outgoing key".
    expect((await kekCensus(store, windowNext)).safe_to_promote).toBe(false);
  });

  it("REFUSES to run with no rotation window open", async () => {
    const store = await seed();
    await expect(sweepReencrypt(store, oldRing)).rejects.toThrow(/no rotation window is open/);
  });

  it("CONTROL: the same store sweeps fine once the window IS open", async () => {
    // Without this, the refusal test above would also pass against a sweep that never worked.
    const store = await seed();
    await expect(sweepReencrypt(store, windowNext)).resolves.toMatchObject({ rotated: 2 });
  });
});
