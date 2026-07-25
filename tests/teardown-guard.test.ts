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
import { CfApiError } from "../src/cf-api";
import { tenantModuleScriptPrefix } from "../src/tenant-modules";
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
  /** Buckets a teardown cycle minted an EMPTYING credential for (cf#72). */
  mint: string[];
  /** Every S3 request the emptying loop issued. A refused bucket must never be OPENED. */
  s3: string[];
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
      async mintBucketToken(_name: string, bucket: string) {
        log.mint.push(bucket);
        return { id: `emptycred-${bucket}`, value: "TEARDOWN_CREDENTIAL_SECRET" };
      },
      async revoke(id: string) {
        log.revoke.push(id);
      },
      async revokeByName(name: string) {
        log.revokeByName.push(name);
        return false;
      },
    },
    r2Endpoint: "https://acct.r2.cloudflarestorage.com",
    now: () => 1_000_000,
    sleep: async () => {},
    // Scripted S3: an EMPTY listing, so the emptying loop reaches its terminal state from an
    // observed read (its own rule) and the bucket delete that follows is what is under test. Every
    // request is recorded because these tests assert a refused bucket was never OPENED, which is a
    // stronger claim than never deleted -- emptying is the irreversible half.
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      log.s3.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`,
        { status: 200 },
      );
    }) as unknown as typeof fetch,
    namespace: "vivijure-tenants",
    moduleNamespace: "vivijure-tenant-modules",
    tenantScriptName: (slug: string) => `tenant-${slug}-studio`,
    log: () => {},
  } as unknown as ProvisionDeps;
  return { deps, log };
}

function emptyLog(): CallLog {
  return { deleteD1: [], deleteR2Bucket: [], deleteUserWorker: [], revoke: [], revokeByName: [], mint: [], s3: [] };
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
    // The tenant own credential first, then the ephemeral emptying credential this cycle minted.
    // Both being here is the POSITIVE CONTROL for every never-opened assertion below: the recorder
    // does see mints, S3 requests and revokes when the guard lets the work happen.
    expect(log.revoke).toEqual(["tok-solo", "emptycred-bkt-solo"]);
    expect(log.mint).toEqual(["bkt-solo"]);
    expect(log.s3.length, "the emptying loop really did open the bucket").toBeGreaterThan(0);
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
    // AND THE IRREVERSIBLE HALF: no credential was minted and the bucket was never listed. A guard
    // that refused the DELETE but let the emptying run first would pass every assertion above while
    // having already destroyed the live tenant films.
    expect(log.mint).toEqual([]);
    expect(log.s3).toEqual([]);

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
    expect(log.mint).toEqual([]);
    expect(log.s3).toEqual([]);
  });

  it("a bucket it could not empty is NOT deleted, NOT blanked, and the credential is still revoked", async () => {
    await store.createTenant("ten_big", "big", "acct_1", "failed");
    await own("ten_big", { bucket: "bkt-big" });
    const big = (await store.getTenantById("ten_big"))!;

    // A bucket with objects whose DeleteObjects fails: the loop stalls rather than emptying. This is
    // the shape a real oversized or erroring bucket takes, and the whole point of the cycle design.
    (deps as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      log.s3.push(`${method} ${String(input)}`);
      if (method === "POST") return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>renders/film-1/out.mp4</Key></Contents></ListBucketResult>`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const res = await teardownTenant(deps, big, { deleteData: true });

    expect(res.ok).toBe(false);
    const bucketFailure = res.failures.find((f) => f.resource === "r2_bucket")!;
    expect(bucketFailure.error).toContain("re-run teardown to continue");

    // Not emptied means not deleted, and not deleted means the row keeps claiming it. A row that
    // blanked here would read as reaped while the customer objects are still there.
    expect(log.deleteR2Bucket).toEqual([]);
    expect((await store.getTenantById("ten_big"))!.r2_bucket_name).toBe("bkt-big");

    // MINT -> WORK -> REVOKE holds on the failure path too. This is the assertion that a stranded
    // bucket-scoped grant cannot be left behind by a cycle that did not finish.
    expect(log.mint).toEqual(["bkt-big"]);
    expect(log.revoke).toEqual(["emptycred-bkt-big"]);
  });
});

// IDEMPOTENT DELETE (cp#110): a delete that answers NOT FOUND reached its goal earlier.
//
// FOUND IN PRODUCTION, not in theory. The lead guarded sweep through the shipped teardown route met
// two tenant rows whose studio script was already gone; CF answered each delete
// `wfp.deleteScript: This Worker does not exist on your account`, teardown recorded it as a failure,
// and so the column kept claiming a worker that does not exist, teardown_failures kept an entry no
// re-run could ever clear, and the row could never reach provably-reaped.
//
// THE CF SHAPE IS LIVE-PROBED, not assumed (2026-07-25, provisioner credential, both dispatch
// namespaces): HTTP 404 with `{code: 10007, message: "This Worker does not exist on your account."}`.
// The fixtures below are built from that probe, so the classifier is tested against what Cloudflare
// actually returns rather than against my recollection of it.
//
// THE STORE IS REAL (same harness as the guard tests above): the claim under test is "the column
// blanks", which is a SQL fact. Asserting it through a fake would assert my reimplementation of the
// UPDATE. The CfApi remains a recording proxy, so absence is proven by the call log plus a real
// read-back, never by the return value alone.
//
// AND EVERY ABSENT-IS-FINE TEST HERE IS PAIRED WITH A REAL-FAILURE CONTROL. A fix of this shape
// fails in exactly one direction -- classifying too much as "already gone" -- and a suite that only
// proves 404s pass would be green for a change that swallowed everything.
describe("teardown idempotent delete (cp#110)", () => {
  let store: D1Store;
  let log: CallLog;
  let deps: ProvisionDeps;

  /** CF own answer to a delete of a script that is not there, as live-probed. */
  const scriptGone = () =>
    new CfApiError("wfp.deleteScript", 404, [{ code: 10007, message: "This Worker does not exist on your account." }]);

  const setDelete = (fn: (ns: string, name: string) => Promise<void>) => {
    (deps.cf as unknown as { deleteUserWorker: typeof fn }).deleteUserWorker = async (ns, name) => {
      log.deleteUserWorker.push(name);
      return await fn(ns, name);
    };
  };

  beforeEach(async () => {
    store = new D1Store(d1Over(freshMigratedDb()));
    log = emptyLog();
    deps = recordingDeps(store, log).deps;
    await store.createAccount("acct_1", "a@b.com");
    await store.createTenant("ten_gone", "gone", "acct_1", "failed");
    await store.setTenantScript("ten_gone", SCRIPT, "v1.0.0");
    await store.setTenantD1("ten_gone", D1_ID);
  });

  const row = async () => (await store.getTenantById("ten_gone"))!;

  it("BLANKS the column when the worker is already gone, and the pass reads clean", async () => {
    setDelete(async () => {
      throw scriptGone();
    });

    const before = await row();
    const res = await teardownTenant(deps, before, { deleteData: true });

    // The delete WAS issued (this is not a skip), it answered not-found, and that is not a failure.
    expect(log.deleteUserWorker).toEqual([SCRIPT]);
    expect(res.failures, JSON.stringify(res.failures)).toEqual([]);
    expect(res.ok).toBe(true);

    // Recorded, not swallowed: "we deleted it" and "it was not there" stay different facts.
    expect(res.absent).toEqual([{ resource: "worker", detail: expect.stringContaining("does not exist") }]);

    // THE DEFECT, as a read-back through the real UPDATE: the row stops claiming a script that is
    // not there, and the failure list is clearable rather than permanent.
    const after = await row();
    expect(after.script_name, "the column blanks -- this is the whole issue").toBeNull();
    expect(after.teardown_failures, "clean pass records [] rather than a permanent entry").toBe("[]");
  });

  it("POSITIVE CONTROL: a REAL delete failure is still a failure and the column still claims the script", async () => {
    // 403 is a real error with a real follow-up (fix the credential and re-run). If the fix
    // swallowed this, teardown would report a clean reap over a worker that is still serving.
    setDelete(async () => {
      throw new CfApiError("wfp.deleteScript", 403, [{ code: 10000, message: "Authentication error" }]);
    });

    const res = await teardownTenant(deps, await row(), { deleteData: true });

    expect(res.ok).toBe(false);
    expect(res.absent).toEqual([]);
    expect(res.failures.find((f) => f.resource === "worker")?.error).toContain("Authentication error");
    expect((await row()).script_name, "NOT reaped -> must still be claimed").toBe(SCRIPT);
  });

  it("POSITIVE CONTROL: a 404 carrying NO CF code is not proof of absence", async () => {
    // The shape CfApi builds when a response body is not JSON at all: status only, no codes. The
    // status alone must not be enough, or any 404 this API can produce (a dispatch namespace that
    // does not exist, say) would blank a column over a live resource.
    setDelete(async () => {
      throw new CfApiError("wfp.deleteScript", 404, []);
    });

    const res = await teardownTenant(deps, await row(), { deleteData: true });

    expect(res.ok).toBe(false);
    expect(res.absent).toEqual([]);
    expect((await row()).script_name).toBe(SCRIPT);
  });

  it("POSITIVE CONTROL: a plain Error is not proof of absence either", async () => {
    setDelete(async () => {
      throw new Error("script busy");
    });

    const res = await teardownTenant(deps, await row(), { deleteData: true });

    expect(res.ok).toBe(false);
    expect(res.absent).toEqual([]);
    expect((await row()).script_name).toBe(SCRIPT);
  });

  it("keeps going: an already-gone worker does not stop the rest of the reap", async () => {
    setDelete(async () => {
      throw scriptGone();
    });

    await teardownTenant(deps, await row(), { deleteData: true });

    expect(log.deleteD1).toEqual([D1_ID]);
    expect((await row()).d1_database_id).toBeNull();
  });

  it("MODULE SCRIPTS: one that vanished between the list and the delete is absent, not failed", async () => {
    const script = `${tenantModuleScriptPrefix("ten_gone")}keyframe`;
    // Listing sees it, the delete says it is gone, and the census afterwards agrees -- the race a
    // best-effort sweep actually hits.
    let listed = 0;
    (deps.cf as unknown as { listNamespaceScripts: () => Promise<string[]> }).listNamespaceScripts = async () =>
      listed++ === 0 ? [script] : [];
    setDelete(async (_ns, name) => {
      if (name === script) throw scriptGone();
    });

    const res = await teardownTenant(deps, await row(), { deleteData: true });

    expect(res.ok, JSON.stringify(res.failures)).toBe(true);
    expect(res.absent.map((a) => a.resource)).toEqual([`module:${script}`]);
  });

  it("MODULE POSITIVE CONTROL: a real module delete failure still fails, and the census still runs", async () => {
    const script = `${tenantModuleScriptPrefix("ten_gone")}keyframe`;
    (deps.cf as unknown as { listNamespaceScripts: () => Promise<string[]> }).listNamespaceScripts = async () => [
      script,
    ];
    setDelete(async (_ns, name) => {
      if (name === script) throw new CfApiError("wfp.deleteScript", 500, [{ code: 10013, message: "Internal error" }]);
    });

    const res = await teardownTenant(deps, await row(), { deleteData: true });

    expect(res.ok).toBe(false);
    expect(res.absent).toEqual([]);
    expect(res.failures.map((f) => f.resource)).toContain(`module:${script}`);
    // The census is the independent witness and it still ran: the script is genuinely still there.
    expect(res.failures.map((f) => f.resource)).toContain("modules_census");
  });
});
