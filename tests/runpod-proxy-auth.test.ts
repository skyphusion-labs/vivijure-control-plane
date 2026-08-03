// The tenant proxy credential (cp#290). Unit-level, because the interesting cases are the ones a
// route test cannot reach: a token edited in flight.
//
// EVERY REJECTION HERE IS PAIRED WITH THE ACCEPT IT DIFFERS FROM BY ONE FIELD. A suite of tokens
// that are all refused would pass identically against a verifier that refuses everything, which is
// the failure mode an auth test is most likely to ship with.

import { describe, expect, it } from "vitest";
import { mintTenantProxyToken, verifyTenantProxyToken, PROXY_TOKEN_PREFIX } from "../src/runpod-proxy-auth";

const KEY = "signing-key-under-test";
const OTHER = "a-different-signing-key";

describe("mint", () => {
  it("produces prefix.tenant.mac with a 64-hex MAC", async () => {
    const token = (await mintTenantProxyToken(KEY, "ten_1"))!;
    const [prefix, tenantId, mac] = token.split(".");
    expect(prefix).toBe(PROXY_TOKEN_PREFIX);
    expect(tenantId).toBe("ten_1");
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is DETERMINISTIC, so re-provisioning cannot issue a second live credential by accident", async () => {
    expect(await mintTenantProxyToken(KEY, "ten_1")).toBe(await mintTenantProxyToken(KEY, "ten_1"));
  });

  it("gives different tenants different tokens", async () => {
    expect(await mintTenantProxyToken(KEY, "ten_1")).not.toBe(await mintTenantProxyToken(KEY, "ten_2"));
  });

  it("mints NOTHING without a signing key: an unconfigured plane hands out no credential", async () => {
    expect(await mintTenantProxyToken(undefined, "ten_1")).toBeNull();
    // Control, so the null above is attributable to the key rather than to the tenant id.
    expect(await mintTenantProxyToken(KEY, "ten_1")).not.toBeNull();
  });

  it("refuses a tenant id carrying the separator, which would make the token ambiguous", async () => {
    expect(await mintTenantProxyToken(KEY, "ten.1")).toBeNull();
    expect(await mintTenantProxyToken(KEY, "")).toBeNull();
  });
});

describe("verify", () => {
  it("accepts what it minted and returns the tenant", async () => {
    const token = (await mintTenantProxyToken(KEY, "ten_1"))!;
    expect(await verifyTenantProxyToken(KEY, token)).toBe("ten_1");
  });

  it("REFUSES a token whose tenant id was edited in flight -- the MAC covers it", async () => {
    const token = (await mintTenantProxyToken(KEY, "ten_1"))!;
    const swapped = token.replace("ten_1", "ten_victim");
    expect(await verifyTenantProxyToken(KEY, swapped)).toBeNull();
    // The unedited original still verifies, so the refusal is the edit and not the verifier.
    expect(await verifyTenantProxyToken(KEY, token)).toBe("ten_1");
  });

  it("REFUSES a token signed by a different key (key rotation invalidates every tenant at once)", async () => {
    const foreign = (await mintTenantProxyToken(OTHER, "ten_1"))!;
    expect(await verifyTenantProxyToken(KEY, foreign)).toBeNull();
    expect(await verifyTenantProxyToken(OTHER, foreign)).toBe("ten_1");
  });

  it("REFUSES a v1 MAC presented under another version prefix (domain separation)", async () => {
    const token = (await mintTenantProxyToken(KEY, "ten_1"))!;
    const [, tenantId, mac] = token.split(".");
    expect(await verifyTenantProxyToken(KEY, `vjp2.${tenantId}.${mac}`)).toBeNull();
  });

  it("REFUSES every malformed shape", async () => {
    for (const bad of ["", "vjp1", "vjp1.ten_1", "vjp1.ten_1.", "vjp1..mac", "vjp1.ten_1.mac.extra", "garbage"]) {
      expect(await verifyTenantProxyToken(KEY, bad)).toBeNull();
    }
  });

  it("REFUSES everything when the plane has no signing key, including a genuine token", async () => {
    const token = (await mintTenantProxyToken(KEY, "ten_1"))!;
    expect(await verifyTenantProxyToken(undefined, token)).toBeNull();
    expect(await verifyTenantProxyToken(KEY, token)).toBe("ten_1");
  });

  it("REFUSES a null or absent bearer without throwing", async () => {
    expect(await verifyTenantProxyToken(KEY, null)).toBeNull();
    expect(await verifyTenantProxyToken(KEY, undefined)).toBeNull();
  });
});
