// THE REFERENTIAL GUARD (#23): teardown must not reap a resource another tenant row still points at.
//
// WHY THIS FILE EXISTS, from a census of the LIVE plane rather than from theory. Nine tenant rows,
// eight tombstones and one live tenant, ALL referencing ONE physical D1; six of them also sharing the
// live tenant's bucket and studio worker. Cause: resource names derive from the SLUG, and the house
// pattern frees a slug by RENAMING the old row, so the old row keeps its ids while the next tenant to
// take that slug provisions onto the same names. Slug reuse is resource reuse.
//
// So `teardownTenant(<any tombstone>, { deleteData: true })` would have deleted the LIVE tenant's
// database, bucket and worker. Nothing in the code stopped it. The only thing that did was that no
// production caller existed -- safety by absence, which stops being safety the moment #23 wires one.
//
// THE STORE HERE IS REAL. The guard is a SQL question ("does any other row reference this?"), and
// answering it against a hand-written fake would be asserting my own reimplementation of the query,
// not the query. Real migration ledger, real SQL engine (sqlite-d1.ts, the #32 harness).
//
// THE CFAPI IS A RECORDING PROXY, and that is not the same as a fake that returns success. "The
// resource survived" can be true for reasons other than the guard working. What must be proven is
// that the delete was never ISSUED, so every destructive call is recorded and the assertions are
// about the CALL LOG. A control assertion proves the recorder records, because a recorder that
// silently records nothing makes every "was never called" assertion pass.

import { describe, it, expect, beforeEach } from "vitest";
import { D1Store } from "../src/store-d1";
import { d1Over, freshMigratedDb } from "./sqlite-d1";
import { teardownTenant, type ProvisionDeps } from "../src/provisioner";
import type { Tenant } from "../src/store";

const D1_ID = "db-shared-0001";
const BUCKET = "vivijure-tenant-shared";
const SCRIPT = "tenant-shared-studio";
const TOKEN_ID = "tok-shared-0001";

interface CallLog {
  deleteD1: string[];
  deleteR2Bucket: string[];
  deleteUserWorker: string[];
  revoke: string[];
  revokeByName: string[];
}

function recordingDeps(store: D1Store, log: CallLog): { deps: ProvisionDeps; log: CallLog } {
  const deps = {
    store,
    cf: {
      async deleteD1(id: string) {
        log.deleteD1.push(id);
      },
      async deleteR2Bucket(name: string) {
        log.deleteR2Bucket.push(name);
      },
      async deleteUserWorker(_ns: string, name: string) {
        log.deleteUserWorker.push(name);
      },
      async listNamespaceScripts() {
        return [] as string[];
      },
    },
    tokenMinter: {
      async revoke(id: string) {
        log.revoke.push(id);
      },
      async revokeByName(name: string) {
        log.revokeByName.push(name);
        return false;
      },
    },
    namespace: "vivijure-tenants",
    moduleNamespace: "vivijure-tenant-modules",
    tenantScriptName: (slug: string) => `tenant-${slug}-studio`,
    log: () => {},
  } as unknown as ProvisionDeps;
  return { deps, log };
}

function emptyLog(): CallLog {
  return { deleteD1: [], deleteR2Bucket: [], deleteUserWorker: [], revoke: [], revokeByName: [] };
}

describe("teardown referential guard", () => {
  let store: D1Store;
  let log: CallLog;
  let deps: ProvisionDeps;

  beforeEach(async () => {
    store = new D1Store(d1Over(freshMigratedDb()));
    log = emptyLog();
    deps = recordingDeps(store, log).deps;
    await store.createAccount("acct_1", "a@b.com");
  });

  /** Give a row the resource ids it claims to own. */
  async function own(id: string, refs: { d1?: string; bucket?: string; token?: string; script?: string }) {
    if (refs.d1) await store.setTenantD1(id, refs.d1);
    if (refs.bucket) await store.setTenantBucket(id, refs.bucket);
    if (refs.token) await store.setTenantR2Token(id, refs.token);
    if (refs.script) await store.setTenantScript(id, refs.script, "v1.0.0");
  }

  it("CONTROL: the recorder actually records, so 'never called' assertions mean something", async () => {
    await store.createTenant("ten_solo", "solo", "acct_1", "failed");
    await own("ten_solo", { d1: "db-solo", bucket: "bkt-solo", token: "tok-solo", script: "scr-solo" });
    const solo = (await store.getTenantById("ten_solo"))!;

    const res = await teardownTenant(deps, solo, { deleteData: true });

    expect(res.ok, JSON.stringify(res.failures)).toBe(true);
    expect(log.deleteD1).toEqual(["db-solo"]);
    expect(log.deleteR2Bucket).toEqual(["bkt-solo"]);
    expect(log.deleteUserWorker).toEqual(["scr-solo"]);
    expect(log.revoke).toEqual(["tok-solo"]);
  });

  it("REFUSES every resource a LIVE row still references, and issues no delete at all", async () => {
    // The live plane's exact shape: a live tenant, and a tombstone renamed off the slug that still
    // carries the same ids.
    await store.createTenant("ten_live", "shared", "acct_1", "live");
    await own("ten_live", { d1: D1_ID, bucket: BUCKET, token: TOKEN_ID, script: SCRIPT });

    await store.createTenant("ten_dead", "shared-old", "acct_1", "failed");
    await own("ten_dead", { d1: D1_ID, bucket: BUCKET, token: TOKEN_ID, script: SCRIPT });
    const dead = (await store.getTenantById("ten_dead"))!;

    const res = await teardownTenant(deps, dead, { deleteData: true });

    expect(res.ok).toBe(false);
    const refused = Object.fromEntries(res.failures.map((f) => [f.resource, f.error]));
    for (const r of ["d1", "r2_bucket", "worker", "r2_token"]) {
      expect(refused[r], `${r} must be refused`).toMatch(/^refused:/);
      expect(refused[r], `${r} must name the live referrer`).toContain("ten_live");
      expect(refused[r]).toContain("AT LEAST ONE IS NOT DELETED");
    }

    // THE ASSERTION THAT MATTERS: nothing was even asked for.
    expect(log.deleteD1).toEqual([]);
    expect(log.deleteR2Bucket).toEqual([]);
    expect(log.deleteUserWorker).toEqual([]);
    expect(log.revoke).toEqual([]);
    expect(log.revokeByName).toEqual([]);

    // And the live tenant's row is untouched: still owns everything it owned.
    const live = (await store.getTenantById("ten_live"))!;
    expect(live.d1_database_id).toBe(D1_ID);
    expect(live.r2_bucket_name).toBe(BUCKET);
    expect(live.script_name).toBe(SCRIPT);
  });

  it("refuses a resource shared only with TOMBSTONES too, and says so without crying wolf", async () => {
    // Any referrer blocks: a resource shared only with deleted rows is still not provably ours, and
    // picking a winner among tombstones is a rule nobody has written. But the message must NOT claim
    // a live blocker, or the warning stops meaning anything when there IS one.
    await store.createTenant("ten_t1", "t-one", "acct_1", "failed");
    await store.setTenantStatus("ten_t1", "deleted");
    await own("ten_t1", { d1: D1_ID });

    await store.createTenant("ten_t2", "t-two", "acct_1", "failed");
    await store.setTenantStatus("ten_t2", "deleted");
    await own("ten_t2", { d1: D1_ID });
    const t2 = (await store.getTenantById("ten_t2"))!;

    const res = await teardownTenant(deps, t2, { deleteData: true });

    const d1Failure = res.failures.find((f) => f.resource === "d1")!;
    expect(d1Failure.error).toMatch(/^refused:/);
    expect(d1Failure.error).toContain("ten_t1");
    expect(d1Failure.error).not.toContain("AT LEAST ONE IS NOT DELETED");
    expect(log.deleteD1).toEqual([]);
  });

  it("blanks a column ONLY on that resource's successful deletion", async () => {
    await store.createTenant("ten_mix", "mixed", "acct_1", "failed");
    await own("ten_mix", { d1: "db-mix", bucket: "bkt-mix", script: "scr-mix" });
    const mix = (await store.getTenantById("ten_mix"))!;

    // The bucket delete fails the way real R2 fails a non-empty bucket; everything else succeeds.
    (deps.cf as unknown as { deleteR2Bucket: (n: string) => Promise<void> }).deleteR2Bucket = async () => {
      throw new Error("The bucket you tried to delete is not empty");
    };

    const res = await teardownTenant(deps, mix, { deleteData: true });
    expect(res.ok).toBe(false);

    const after = (await store.getTenantById("ten_mix"))!;
    expect(after.d1_database_id, "reaped -> blanked").toBeNull();
    expect(after.script_name, "reaped -> blanked").toBeNull();
    // THE POINT: a row that blanked this too would read as reaped while the customer's films are
    // still sitting in a live bucket.
    expect(after.r2_bucket_name, "NOT reaped -> must still be claimed").toBe("bkt-mix");
  });

  it("records the outcome on the row, and 'clean' stays distinguishable from 'never ran'", async () => {
    await store.createTenant("ten_rec", "recorded", "acct_1", "failed");
    await own("ten_rec", { d1: "db-rec" });

    const before = (await store.getTenantById("ten_rec"))!;
    expect(before.teardown_at, "never attempted").toBeNull();
    expect(before.teardown_failures).toBeNull();

    await teardownTenant(deps, before, { deleteData: true });

    const after = (await store.getTenantById("ten_rec"))!;
    expect(after.teardown_at).not.toBeNull();
    expect(after.teardown_failures, "attempted and clean is '[]', not null").toBe("[]");
  });

  it("FAILS CLOSED: a guard that cannot answer reaps nothing", async () => {
    await store.createTenant("ten_blind", "blind", "acct_1", "failed");
    await own("ten_blind", { d1: "db-blind", bucket: "bkt-blind", script: "scr-blind", token: "tok-blind" });
    const blind = (await store.getTenantById("ten_blind"))!;

    // Watched failing before it is trusted: the guard's own query is what breaks.
    (deps.store as unknown as { findResourceReferrers: () => Promise<never> }).findResourceReferrers =
      async () => {
        throw new Error("D1 unavailable");
      };

    const res = await teardownTenant(deps, blind, { deleteData: true });

    expect(res.ok).toBe(false);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0].resource).toBe("guard");
    expect(res.failures[0].error).toContain("refusing every deletion");

    // Cannot prove ownership -> touch nothing. An un-run teardown is recoverable; a wrong delete
    // is not.
    expect(log.deleteD1).toEqual([]);
    expect(log.deleteR2Bucket).toEqual([]);
    expect(log.deleteUserWorker).toEqual([]);
    expect(log.revoke).toEqual([]);
  });
});
