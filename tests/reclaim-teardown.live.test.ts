// RECLAIM TEARDOWN REHEARSAL -- LIVE, against real Cloudflare (cf#103, release gate for #36).
//
// WHY THIS EXISTS. teardownTenant got its FIRST production caller in #36 (the reclaim path). Every
// test covering it runs over a mocked CfApi and a MemoryStore, which prove the DECISION PATH -- which
// calls happen, in which order, and which do not -- and never the shipped artifact. Its first REAL
// exercise must not be a customer studio.
//
// WHAT MAKES THIS A PROOF RATHER THAN A GREEN LOG. A delete issued against a name that does not exist
// SUCCEEDS. So "teardown reported ok" is worth nothing on its own, and that silence is the exact
// failure class this sprint kept turning up. Therefore:
//   1. every resource is PROVEN PRESENT before teardown runs (positive control), and
//   2. absence afterwards is proven by RAW REST CALLS, not through CfApi -- the client that did the
//      deleting does not get to be the witness that it worked.
//
// RUN:
//   set -a; . ~/.cf-provisioner.env; set +a
//   CF_ACCOUNT_ID=<id> RECLAIM_REHEARSAL=1 npx vitest run tests/reclaim-teardown.live.test.ts
//
// SPEND: $0. A D1, an empty R2 bucket and one trivial user Worker, created and destroyed inside the
// run. No RunPod, no GPU, no renders.
//
// ONE LEG IS NOT COVERED, AND IT IS A CREDENTIAL LIMIT RATHER THAN AN OVERSIGHT. This rehearsal does
// NOT mint an R2 token, so teardown R2-token REVOKE is not exercised. Cloudflare refuses
// API-created tokens any token-management rights (tokens.create -> "Unauthorized to access requested
// resource"), which is the same constraint ProvisionDeps.tokenMinter already documents. Proving that
// leg needs a dashboard-created credential, which is deliberately not held here. The tenant row
// therefore carries r2_token_id: null and teardown skips the revoke by its own conditional -- so
// this file proves three of the four resources, and says so rather than implying four.
//
// SAFETY: every name carries a rollins-rehearsal- prefix and a per-run suffix, so it can only ever
// touch resources this file created seconds earlier. afterAll sweeps whatever a failed assertion
// left behind.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CfApi } from "../src/cf-api";
import { CfTokenMinter } from "../src/token-minter";
import { teardownTenant, type ProvisionDeps } from "../src/provisioner";
import type { Tenant } from "../src/store";
import { D1Store } from "../src/store-d1";
import { d1Over, freshMigratedDb } from "./sqlite-d1";

declare const process: { env: Record<string, string | undefined> };

const TOKEN = process.env.CF_PROVISIONER_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const LIVE = process.env.RECLAIM_REHEARSAL === "1" && Boolean(TOKEN) && Boolean(ACCOUNT);

const NAMESPACE = "vivijure-tenants";
const MODULE_NAMESPACE = "vivijure-tenant-modules";
const RUN = Date.now().toString(36).slice(-6);
const SLUG = `rollins-rehearsal-${RUN}`;
const D1_NAME = `vivijure-tenant-${SLUG}`;
const BUCKET = `vivijure-tenant-${SLUG}`;
const SCRIPT = `tenant-${SLUG}-studio`;

const API = "https://api.cloudflare.com/client/v4";

/**
 * Raw REST, deliberately NOT CfApi. The point of the after-check is independence: proving a delete
 * worked by asking the same client that issued it would be the same shape of mistake as asserting a
 * response body with the code that built it.
 */
async function raw(path: string): Promise<number> {
  const res = await fetch(`${API}/accounts/${ACCOUNT}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return res.status;
}

async function d1Exists(id: string): Promise<boolean> {
  return (await raw(`/d1/database/${id}`)) === 200;
}
async function bucketExists(name: string): Promise<boolean> {
  return (await raw(`/r2/buckets/${name}`)) === 200;
}
/**
 * Existence by LIST MEMBERSHIP, and the reason is a defect this file already committed once.
 *
 * The obvious check -- GET .../scripts/<name> and test for 200 -- is WRONG. Cloudflare answers 200
 * with a body of {"script": null} for a script that does not exist, so the status code answers "did
 * the API respond", not "is it there". Written that way, this rehearsal reported a LIVE worker after
 * a successful teardown and would have been read as teardown failing to delete. The code under test
 * was right; the witness was broken.
 *
 * The namespace listing cannot be ambiguous in that way, and it is the same census teardown itself
 * uses to prove module scripts are gone.
 */
async function scriptExists(namespace: string, name: string): Promise<boolean> {
  const res = await fetch(`${API}/accounts/${ACCOUNT}/workers/dispatch/namespaces/${namespace}/scripts`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const body = (await res.json()) as { result?: { id?: string }[] };
  return (body.result ?? []).some((s) => s.id === name);
}
async function tokenExists(id: string): Promise<boolean> {
  const res = await fetch(`${API}/user/tokens/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return res.status === 200;
}

const notSupplied = (field: string): never => {
  throw new Error(`reclaim rehearsal touches only teardown; ProvisionDeps.${field} is not supplied`);
};

/**
 * Resources are recorded the INSTANT they exist, not when the builder returns.
 *
 * The first version of this file tracked cleanup off the finished tenant object, so when a mid-build
 * step threw, the builder never returned, the sweep saw nothing, and a real D1 and a real bucket were
 * left behind on the account. That is the "a teardown that can fail strands live resources silently"
 * failure in miniature, committed by the very file written to catch it. Anything created goes in here
 * first; the sweep works from this, never from the happy path.
 */
const created: { d1: string[]; buckets: string[]; scripts: string[] } = { d1: [], buckets: [], scripts: [] };

let cf: CfApi;
let minter: CfTokenMinter;
let deps: ProvisionDeps;
let rehearsalStore: D1Store;
const logged: { event: string; fields: Record<string, unknown> }[] = [];

beforeAll(() => {
  if (!LIVE) return;
  rehearsalStore = new D1Store(d1Over(freshMigratedDb()));
  cf = new CfApi(ACCOUNT!, TOKEN!);
  minter = new CfTokenMinter(cf);
  deps = {
    cf,
    tokenMinter: minter,
    namespace: NAMESPACE,
    moduleNamespace: MODULE_NAMESPACE,
    tenantScriptName: (slug: string) => `tenant-${slug}-studio`,
    log: (event: string, fields: Record<string, unknown>) => void logged.push({ event, fields }),
    // #23: teardown now READS THE STORE by design -- the referential guard has to ask whether any
    // other row still points at these resources, and blanking/recording are store writes. The
    // notSupplied getter did exactly its job here: the day teardown started reading the store, this
    // file failed loud instead of running against a silently wrong value. So it gets a real one.
    //
    // A fresh migrated store with no other tenant rows is the honest fixture for THIS file: it
    // proves the guard's clean path (nothing else references these resources, so nothing is
    // refused). The aliasing refusals are proven in teardown-guard.test.ts against the same real
    // SQL, where the referring rows can be constructed deliberately.
    store: rehearsalStore,
    get runpod() { return notSupplied("runpod"); },
    get bundle() { return notSupplied("bundle"); },
    get moduleBundle() { return notSupplied("moduleBundle"); },
    get r2Endpoint() { return notSupplied("r2Endpoint"); },
    get release() { return notSupplied("release"); },
    get kek() { return notSupplied("kek"); },
    get spendDailyCeiling() { return notSupplied("spendDailyCeiling"); },
    get callTenantStudio() { return notSupplied("callTenantStudio"); },
    get callTenantModule() { return notSupplied("callTenantModule"); },
  } as unknown as ProvisionDeps;
});

/** Build the four resources a half-built Tier A tenant carries, for real. */
async function buildHalfBuiltTenant(): Promise<Tenant> {
  const db = await cf.createD1(D1_NAME);
  created.d1.push(db.uuid);
  await cf.createR2Bucket(BUCKET);
  created.buckets.push(BUCKET);
  await cf.uploadUserWorker({
    namespace: NAMESPACE,
    scriptName: SCRIPT,
    mainModule: "index.js",
    moduleText: "export default { async fetch() { return new Response(`rehearsal`); } };",
    compatibilityDate: "2026-06-01",
    bindings: [],
  });
  created.scripts.push(SCRIPT);
  return {
    id: `ten_rehearsal_${RUN}`,
    slug: SLUG,
    account_id: "acct_rehearsal",
    status: "failed",
    script_name: SCRIPT,
    d1_database_id: db.uuid,
    r2_bucket_name: BUCKET,
    // NULL on purpose: see the header. Minting needs a dashboard-created credential we do not hold,
    // and teardown skips the revoke on a null. Leaving a FAKE id here would be worse than skipping:
    // teardown would try to revoke a token that never existed, Cloudflare would answer, and the leg
    // would look exercised while proving nothing.
    r2_token_id: null,
    endpoints_json: null,
    studio_release: null,
    modules_release: null,
    studio_token_enc: null,
    created_at: new Date().toISOString(),
    live_at: null,
    suspended_at: null,
    suspended_reason: null,
    deleted_at: null,
    reclaim_lease_until: null,
    reclaim_lease_token: null,
  } as unknown as Tenant;
}

describe.skipIf(!LIVE)("reclaim teardown, live against real Cloudflare", () => {
  let tenant: Tenant;

  afterAll(async () => {
    if (!LIVE) return;
    // Sweeps the REGISTRY, not the happy-path tenant object, so a failure part-way through building
    // still cleans up everything that got as far as existing. Best effort and silent: cleanup, not
    // assertion. Anything it cannot remove is reported by the run that follows, because the account
    // listing is checked out of band.
    for (const id of created.d1) {
      try { await cf.deleteD1(id); } catch { /* already gone */ }
    }
    for (const name of created.buckets) {
      try { await cf.deleteR2Bucket(name); } catch { /* already gone */ }
    }
    for (const name of created.scripts) {
      try { await cf.deleteUserWorker(NAMESPACE, name); } catch { /* already gone */ }
    }
  }, 120_000);

  it("reaps a real half-built tenant, and the resources are ACTUALLY gone", async () => {
    tenant = await buildHalfBuiltTenant();

    // POSITIVE CONTROL. Without this, every absence assertion below would also pass against a
    // tenant that was never built -- which is precisely how a delete-by-wrong-name reports success.
    expect(await d1Exists(tenant.d1_database_id!)).toBe(true);
    expect(await bucketExists(BUCKET)).toBe(true);
    expect(await scriptExists(NAMESPACE, SCRIPT)).toBe(true);

    const result = await teardownTenant(deps, tenant, { deleteData: true });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);

    // Absence, proven by RAW REST rather than by the client that did the deleting.
    expect(await scriptExists(NAMESPACE, SCRIPT)).toBe(false);
    expect(await d1Exists(tenant.d1_database_id!)).toBe(false);
    expect(await bucketExists(BUCKET)).toBe(false);
  }, 180_000);

  it("REPORTS a real failure instead of swallowing it, and still reaps what it can", async () => {
    const t = await buildHalfBuiltTenant();
    tenant = t;
    // Delete the D1 out from under teardown so its own delete meets a database that is already gone.
    // A REAL Cloudflare error rather than an injected one, which is the point: the mocked suite can
    // only prove we handle a failure we invented.
    await cf.deleteD1(t.d1_database_id!);
    expect(await d1Exists(t.d1_database_id!)).toBe(false);

    const result = await teardownTenant(deps, t, { deleteData: true });

    // The whole reason the reclaim path refuses to complete on a partial teardown: it must SAY SO,
    // because the row is the only remaining record of what still needs reaping.
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.resource)).toContain("d1");
    expect(String(result.failures.find((f) => f.resource === "d1")?.error)).not.toBe("");
    // And it kept going: teardown COLLECTS failures rather than stopping at the first one, so the
    // worker and the bucket are still reaped.
    expect(await scriptExists(NAMESPACE, SCRIPT)).toBe(false);
    expect(await bucketExists(BUCKET)).toBe(false);
  }, 180_000);
});


// ---------------------------------------------------------------------------------------------
// THE SEQUENCE, END TO END (#38).
//
// Everything above proves the DESTRUCTIVE half against real Cloudflare. #32 proved the STORE half
// against real SQL built from the real migration ledger. Both were green, and the JOIN between them
// had never run: `claimReclaim -> teardown -> reclaimSlug`, in that order, with a real store on one
// side and real cloud resources on the other. Two proofs meeting at an untested seam is exactly the
// shape this sprint kept finding, so this drives all three steps in one pass.
//
// It uses the SAME store harness as the store-half proofs (sqlite-d1.ts) rather than a second
// "real enough" store invented here, because a rehearsal that swaps the component under test is not
// rehearsing the seam.
//
// What is deliberately NOT claimed: this drives the sequence the route drives, not the HTTP route
// itself (session, AUP gate, and the advisory availability check upstream are covered by
// routes.test.ts). The ordering, the exclusivity write, the blanking and the follow-on job are the
// parts that had never touched real infrastructure, and they are what this covers.
// ---------------------------------------------------------------------------------------------
describe.skipIf(!LIVE)("the reclaim SEQUENCE against a real store and real cloud resources", () => {
  it("claims, reaps for real, blanks the row, and leaves a follow-on job queued", async () => {
    const store = new D1Store(d1Over(freshMigratedDb()));
    await store.createAccount("acct_seq", "seq@example.com");

    // A Tier A row: never-live, owned by this account, half-built. `failed` is the honest status for
    // a provision that died partway, which is the population reclaim exists for.
    const seeded = await store.createTenant("ten_seq", SLUG, "acct_seq", "failed");
    expect(seeded.live_at ?? null).toBeNull();

    // Real resources, then the row is told it owns them -- the ids are Cloudflare's, not invented.
    const built = await buildHalfBuiltTenant();
    await store.setTenantD1("ten_seq", built.d1_database_id!);
    await store.setTenantBucket("ten_seq", built.r2_bucket_name!);
    await store.setTenantScript("ten_seq", built.script_name!, built.studio_release ?? "test");

    // POSITIVE CONTROL. A delete against a name that never existed also succeeds, so absence at the
    // end proves nothing unless presence at the start was proven first.
    expect(await d1Exists(built.d1_database_id!)).toBe(true);
    expect(await bucketExists(built.r2_bucket_name!)).toBe(true);
    expect(await scriptExists(NAMESPACE, built.script_name!)).toBe(true);

    // 1. The row is recognised as reclaimable by its owner.
    const claim = await store.checkSlugAvailability(SLUG, "acct_seq");
    // Narrowed by a throw rather than an expect, so the refusal REASON reaches the failure output.
    // "expected true, got false" would tell us the tier rules disagreed and not a word about why.
    if (!claim.available) throw new Error(`Tier A row did not read as reclaimable: ${claim.reason}`);
    expect(claim.reclaim?.tenant_id).toBe("ten_seq");

    // 2. The claim WRITE is the exclusivity gate, so a second attempt must lose while the first
    //    holds the lease. Proven here in sequence, not only in isolation: this is the write that
    //    makes it safe to start deleting slug-derived resources at all.
    const claimed = await store.claimReclaim("ten_seq", "acct_seq", 120);
    expect(claimed, "the owner's claim must succeed").not.toBeNull();
    const loser = await store.claimReclaim("ten_seq", "acct_seq", 120);
    expect(loser, "a second claim under a live lease must be refused").toBeNull();

    // 3. Teardown, for real, against the resources the row actually owns.
    const seqDeps = {
      cf,
      tokenMinter: minter,
      namespace: NAMESPACE,
      moduleNamespace: MODULE_NAMESPACE,
      tenantScriptName: (slug: string) => `tenant-${slug}-studio`,
      log: (event: string, fields: Record<string, unknown>) => void logged.push({ event, fields }),
      store,
    } as unknown as ProvisionDeps;

    const reaped = await teardownTenant(seqDeps, claimed!.tenant, { deleteData: true });
    expect(reaped.ok, `teardown failures: ${JSON.stringify(reaped.failures)}`).toBe(true);

    // Absence witnessed by RAW REST, not by the client that issued the deletes.
    expect(await d1Exists(built.d1_database_id!)).toBe(false);
    expect(await bucketExists(built.r2_bucket_name!)).toBe(false);
    expect(await scriptExists(NAMESPACE, built.script_name!)).toBe(false);

    // 4. Only now may the row be blanked, and only by the holder of the lease token.
    const wrongToken = await store.reclaimSlug("ten_seq", "acct_seq", "not-the-token");
    expect(wrongToken, "blanking without the winning lease token must be refused").toBeNull();

    const reclaimed = await store.reclaimSlug("ten_seq", "acct_seq", claimed!.lease_token);
    expect(reclaimed, "the winner must be able to blank the row").not.toBeNull();
    expect(reclaimed!.d1_database_id ?? null).toBeNull();
    expect(reclaimed!.r2_bucket_name ?? null).toBeNull();
    expect(reclaimed!.script_name ?? null).toBeNull();
    expect(reclaimed!.status).toBe("pending");

    // The row must no longer point at anything: this is the property whose ABSENCE is filed as #23,
    // and the reclaim path is the one place that already gets it right.
    const after = await store.getTenantBySlug(SLUG);
    expect(after!.d1_database_id ?? null).toBeNull();

    // 5. And the slug is genuinely reusable: a follow-on provision job starts on the same row.
    const job = await store.createProvisionJob("job_seq", "ten_seq", "provision");
    expect(job.tenant_id).toBe("ten_seq");
    expect(["queued", "running"]).toContain(job.status);
  }, 300_000);
});
