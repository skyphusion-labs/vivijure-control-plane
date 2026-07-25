import { describe, expect, it } from "vitest";

import {
  decryptStudioToken,
  decryptStudioTokenWithSlot,
  encryptStudioToken,
  encryptionKey,
  KekRingError,
  kekRing,
  rotationWindowOpen,
} from "../src/token-crypto";

const KEK = btoa("0123456789abcdef0123456789abcdef"); // 32 bytes -> valid AES-256 key
const NEXT = btoa("ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP");
const OTHER = btoa("FEDCBA9876543210FEDCBA9876543210");

const single = kekRing(KEK);
const other = kekRing(OTHER);
/** A window that is open but still WRITING under the old key: step 2 of a rotation. */
const windowPrimary = kekRing(KEK, NEXT, "primary");
/** The same window after the write direction is flipped: step 3. */
const windowNext = kekRing(KEK, NEXT, "next");

describe("token-crypto (per-tenant STUDIO_API_TOKEN envelope)", () => {
  it("round-trips a token value under the same KEK", async () => {
    const blob = await encryptStudioToken(single, "rpa_studio_secret");
    expect(blob).not.toContain("rpa_studio_secret"); // control: ciphertext, not plaintext
    expect(await decryptStudioToken(single, blob)).toBe("rpa_studio_secret");
  });

  it("produces a DIFFERENT ciphertext each time (random IV), still decrypting to the same value", async () => {
    const a = await encryptStudioToken(single, "same");
    const b = await encryptStudioToken(single, "same");
    expect(a).not.toBe(b);
    expect(await decryptStudioToken(single, a)).toBe("same");
    expect(await decryptStudioToken(single, b)).toBe("same");
  });

  it("REFUSES to decrypt under the wrong KEK (a D1 dump without the KEK is useless)", async () => {
    const blob = await encryptStudioToken(single, "rpa_studio_secret");
    await expect(decryptStudioToken(other, blob)).rejects.toBeTruthy();
  });

  it("rejects a KEK that is not 32 bytes", async () => {
    await expect(encryptStudioToken(kekRing(btoa("too-short")), "x")).rejects.toThrow(/32-byte/);
  });
});

describe("kekRing construction (cp#95)", () => {
  it("treats a whitespace-only next key as ABSENT rather than as a second key", () => {
    const ring = kekRing(KEK, "   ");
    expect(ring.next).toBeUndefined();
    expect(rotationWindowOpen(ring)).toBe(false);
  });

  it("defaults the write slot to primary, and treats an unrecognized slot as primary", () => {
    expect(kekRing(KEK, NEXT).encryptSlot).toBe("primary");
    expect(kekRing(KEK, NEXT, "PRIMARY-ish").encryptSlot).toBe("primary");
    expect(kekRing(KEK, NEXT, "next").encryptSlot).toBe("next");
  });

  it("reports the window open ONLY when a second key is installed", () => {
    expect(rotationWindowOpen(single)).toBe(false);
    expect(rotationWindowOpen(windowPrimary)).toBe(true);
  });
});

describe("kek ring read/write directions (cp#95)", () => {
  it("writes under the PRIMARY key when the slot says primary, even with a window open", async () => {
    const blob = await encryptStudioToken(windowPrimary, "tok");
    // Proven by the key that opens it, not by which function was called.
    expect(await decryptStudioToken(kekRing(KEK), blob)).toBe("tok");
    await expect(decryptStudioToken(kekRing(NEXT), blob)).rejects.toBeTruthy();
  });

  it("writes under the NEXT key when the slot says next", async () => {
    const blob = await encryptStudioToken(windowNext, "tok");
    expect(await decryptStudioToken(kekRing(NEXT), blob)).toBe("tok");
    await expect(decryptStudioToken(kekRing(KEK), blob)).rejects.toBeTruthy();
  });

  it("READS a value written under EITHER key, whichever direction the slot points", async () => {
    const oldBlob = await encryptStudioToken(kekRing(KEK), "written-before");
    const newBlob = await encryptStudioToken(kekRing(NEXT), "written-after");

    // This is the property dispatcher-injected auth depends on: mid-rotation, both populations of
    // rows must open, or half the tenants lose their token for the length of the window.
    expect(await decryptStudioToken(windowPrimary, oldBlob)).toBe("written-before");
    expect(await decryptStudioToken(windowPrimary, newBlob)).toBe("written-after");
    expect(await decryptStudioToken(windowNext, oldBlob)).toBe("written-before");
    expect(await decryptStudioToken(windowNext, newBlob)).toBe("written-after");
  });

  it("reports WHICH key opened a blob, which is the fact a census needs", async () => {
    const oldBlob = await encryptStudioToken(kekRing(KEK), "a");
    const newBlob = await encryptStudioToken(kekRing(NEXT), "b");
    expect((await decryptStudioTokenWithSlot(windowNext, oldBlob)).slot).toBe("primary");
    expect((await decryptStudioTokenWithSlot(windowNext, newBlob)).slot).toBe("next");
  });

  it("throws for a blob NO installed key opens, rather than reporting a slot", async () => {
    const alien = await encryptStudioToken(kekRing(OTHER), "not ours");
    await expect(decryptStudioTokenWithSlot(windowNext, alien)).rejects.toBeTruthy();
  });
});

describe("the encrypt slot REFUSES rather than falling back (cp#95)", () => {
  it("throws a NAMED error when the slot says next and no next key is installed", () => {
    const misconfigured = kekRing(KEK, undefined, "next");
    // NEGATIVE TEST WITH TEETH: the tempting implementation silently uses the primary here, which
    // would write live customer credentials under a key the operator believes is out of use.
    expect(() => encryptionKey(misconfigured)).toThrow(KekRingError);
    expect(() => encryptionKey(misconfigured)).toThrow(/Refusing to encrypt/);
  });

  it("CONTROL: the same call succeeds once the next key is actually installed", () => {
    // Without this control the test above would pass against a function that always threw.
    expect(encryptionKey(kekRing(KEK, NEXT, "next"))).toBe(NEXT);
    expect(encryptionKey(kekRing(KEK, NEXT, "primary"))).toBe(KEK);
  });

  it("the refusal reaches the encrypt path, not just the key selector", async () => {
    await expect(encryptStudioToken(kekRing(KEK, undefined, "next"), "x")).rejects.toThrow(KekRingError);
  });
});
