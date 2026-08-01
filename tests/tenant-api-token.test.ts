// The tenant's programmatic studio token (cf#94).
//
// The security claim this feature makes to a USER is "your studio stores only a one-way hash of it,
// so nobody, including us, can show it to you again". A test that reads final state cannot check
// that: it would pass just as happily if we stored the value and cleared it later. So the store and
// the tenant DB are RECORDING PROXIES and the assertion is that the plaintext was never PASSED to
// either -- with a control proving the recorders record.

import { describe, it, expect, beforeEach } from "vitest";
import {
  readTenantApiToken,
  issueTenantApiToken,
  revokeTenantApiToken,
  ApiTokenError,
  PROGRAMMATIC_TOKEN_NAME,
  type TenantApiTokenDeps,
} from "../src/tenant-api-token";
import type { Tenant } from "../src/store";

const TOKEN_VALUE = "b".repeat(64);

function tenant(over: Partial<Tenant> = {}): Tenant {
  return {
    id: "ten_1", slug: "s", account_id: "acct_1", status: "live",
    script_name: "tenant-s-studio", d1_database_id: "db-1", r2_bucket_name: null,
    endpoints_json: null, r2_token_id: null, studio_release: null, modules_release: null,
    studio_token_enc: null, created_at: "", live_at: "", suspended_at: null, suspended_reason: null,
    deleted_at: null, reclaim_lease_until: null, reclaim_lease_token: null,
    api_token_rotated_at: null, teardown_at: null, teardown_failures: null,
    runpod_mode: "dedicated",
    ...over,
  } as Tenant;
}

interface Recorder { sql: { sql: string; params: unknown[] }[]; storeCalls: string[] }

function deps(over: { rows?: Record<string, unknown>[]; secrets?: string[]; throwOn?: "query" | "secrets" } = {}) {
  const rec: Recorder = { sql: [], storeCalls: [] };
  let rows = over.rows ?? [];
  const d: TenantApiTokenDeps = {
    cf: {
      async getScriptSecretNames() {
        if (over.throwOn === "secrets") throw new Error("wfp unreachable");
        return over.secrets ?? ["STUDIO_API_TOKEN"];
      },
      async queryD1(_db: string, sql: string, params?: unknown[]) {
        if (over.throwOn === "query") throw new Error("D1 down");
        rec.sql.push({ sql, params: params ?? [] });
        if (/^SELECT/.test(sql.trim())) return [{ results: rows }];
        if (/^INSERT/.test(sql.trim())) {
          rows = [{ name: PROGRAMMATIC_TOKEN_NAME, created_at: "2026-07-25T00:00:00Z" }];
          return [{ results: [] }];
        }
        if (/^UPDATE/.test(sql.trim())) {
          rows = [];
          return [{ results: [] }];
        }
        return [{ results: [] }];
      },
    } as unknown as TenantApiTokenDeps["cf"],
    store: {
      async setApiTokenRotatedAt(id: string) {
        rec.storeCalls.push(`setApiTokenRotatedAt:${id}`);
      },
    } as unknown as TenantApiTokenDeps["store"],
    namespace: "ns",
    randomToken: () => TOKEN_VALUE,
    // The fake hash must NOT contain its input. The first version returned `sha(${s})`, which made
    // the "plaintext was never passed" assertion below unfalsifiable -- it tripped on the hash
    // itself, and worse, it could not have distinguished a stored hash from a stored plaintext. A
    // stub that embeds the secret in its output destroys the very property the test exists to check.
    sha256Hex: async (s: string) => "h" + [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16),
  };
  return { d, rec };
}

describe("tenant programmatic API token", () => {
  let h: ReturnType<typeof deps>;
  beforeEach(() => {
    h = deps();
  });

  it("reports not configured before anything is minted", async () => {
    const state = await readTenantApiToken(h.d, tenant());
    expect(state).toEqual({ configured: false, name: null, created_at: null, last_rotated_at: null });
  });

  it("mints, and returns the plaintext EXACTLY once", async () => {
    const minted = await issueTenantApiToken(h.d, tenant());
    expect(minted.token).toBe(TOKEN_VALUE);
    expect(minted.name).toBe(PROGRAMMATIC_TOKEN_NAME);

    const state = await readTenantApiToken(h.d, tenant());
    expect(state.configured).toBe(true);
    // The projection carries NO field that could hold the value, masked or otherwise.
    expect(JSON.stringify(state)).not.toContain(TOKEN_VALUE);
    expect(Object.keys(state).sort()).toEqual(["configured", "created_at", "last_rotated_at", "name"]);
  });

  it("CONTROL: the recorders record, so the never-passed assertions below mean something", async () => {
    await issueTenantApiToken(h.d, tenant());
    expect(h.rec.sql.length, "SQL recorder must have captured statements").toBeGreaterThan(0);
    expect(h.rec.sql.some((c) => /INSERT/.test(c.sql))).toBe(true);
  });

  it("NEVER passes the plaintext to the tenant database -- only its hash", async () => {
    await issueTenantApiToken(h.d, tenant());
    const everyParam = h.rec.sql.flatMap((c) => c.params.map(String)).join("|");
    const everySql = h.rec.sql.map((c) => c.sql).join("|");
    expect(everyParam, "plaintext must never be bound into a statement").not.toContain(TOKEN_VALUE);
    expect(everySql, "plaintext must never be interpolated into SQL").not.toContain(TOKEN_VALUE);
    const expectedHash = await h.d.sha256Hex(TOKEN_VALUE);
    expect(everyParam, "the HASH is what gets stored").toContain(expectedHash);
  });

  it("rotation replaces in ONE statement and stamps the plane-side rotation fact", async () => {
    await issueTenantApiToken(h.d, tenant());
    h.rec.storeCalls.length = 0;
    const second = await issueTenantApiToken(h.d, tenant());
    expect(second.token).toBe(TOKEN_VALUE);
    // First mint is not a rotation; the second is.
    expect(h.rec.storeCalls).toEqual(["setApiTokenRotatedAt:ten_1"]);
    const insert = h.rec.sql.filter((c) => /INSERT/.test(c.sql)).pop()!;
    expect(insert.sql, "upsert, so there is never a window with two live credentials").toContain("ON CONFLICT");
  });

  it("first mint does NOT claim a rotation", async () => {
    await issueTenantApiToken(h.d, tenant());
    expect(h.rec.storeCalls).toEqual([]);
  });

  it("revoke soft-deletes the way the studio gate reads it", async () => {
    await issueTenantApiToken(h.d, tenant());
    await revokeTenantApiToken(h.d, tenant());
    const update = h.rec.sql.filter((c) => /UPDATE/.test(c.sql)).pop()!;
    expect(update.sql).toContain("revoked_at = datetime('now')");
    expect((await readTenantApiToken(h.d, tenant())).configured).toBe(false);
  });

  it("refuses a tenant that is not live", async () => {
    await expect(issueTenantApiToken(h.d, tenant({ status: "provisioning" }))).rejects.toMatchObject({
      code: "tenant_not_live",
    });
  });

  it("refuses a tenant with no studio DB yet", async () => {
    await expect(issueTenantApiToken(h.d, tenant({ d1_database_id: null }))).rejects.toMatchObject({
      code: "not_provisioned",
    });
  });

  it("REFUSES when the studio has no STUDIO_API_TOKEN -- the button that would throw", async () => {
    // The studio's gate 403s when the operator secret is unset, BEFORE it consults named tokens. A
    // token minted here would be refused on arrival, so we refuse to mint it instead.
    const g = deps({ secrets: ["SOMETHING_ELSE"] });
    await expect(issueTenantApiToken(g.d, tenant())).rejects.toMatchObject({ code: "not_provisioned" });
    expect(g.rec.sql, "must not touch the tenant DB when it cannot honour the result").toHaveLength(0);
  });

  it("an unreachable tenant DB is NOT reported as 'no token'", async () => {
    // Reporting a live credential as absent is the more dangerous direction to be wrong in.
    const g = deps({ throwOn: "query" });
    await expect(readTenantApiToken(g.d, tenant())).rejects.toMatchObject({ code: "tenant_unreachable" });
  });

  it("an unreachable studio worker is surfaced, not swallowed", async () => {
    const g = deps({ throwOn: "secrets" });
    await expect(readTenantApiToken(g.d, tenant())).rejects.toBeInstanceOf(ApiTokenError);
  });
});
