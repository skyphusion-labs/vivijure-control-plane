import { describe, expect, it } from "vitest";

import { decryptStudioToken, encryptStudioToken } from "../src/token-crypto";

const KEK = btoa("0123456789abcdef0123456789abcdef"); // 32 bytes -> valid AES-256 key
const OTHER = btoa("FEDCBA9876543210FEDCBA9876543210");

describe("token-crypto (per-tenant STUDIO_API_TOKEN envelope)", () => {
  it("round-trips a token value under the same KEK", async () => {
    const blob = await encryptStudioToken(KEK, "rpa_studio_secret");
    expect(blob).not.toContain("rpa_studio_secret"); // control: ciphertext, not plaintext
    expect(await decryptStudioToken(KEK, blob)).toBe("rpa_studio_secret");
  });

  it("produces a DIFFERENT ciphertext each time (random IV), still decrypting to the same value", async () => {
    const a = await encryptStudioToken(KEK, "same");
    const b = await encryptStudioToken(KEK, "same");
    expect(a).not.toBe(b);
    expect(await decryptStudioToken(KEK, a)).toBe("same");
    expect(await decryptStudioToken(KEK, b)).toBe("same");
  });

  it("REFUSES to decrypt under the wrong KEK (a D1 dump without the KEK is useless)", async () => {
    const blob = await encryptStudioToken(KEK, "rpa_studio_secret");
    await expect(decryptStudioToken(OTHER, blob)).rejects.toBeTruthy();
  });

  it("rejects a KEK that is not 32 bytes", async () => {
    await expect(encryptStudioToken(btoa("too-short"), "x")).rejects.toThrow(/32-byte/);
  });
});
