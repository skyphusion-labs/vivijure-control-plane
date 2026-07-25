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
import {
  teardownTenant,
  tenantR2TokenName,
  tenantR2TeardownTokenName,
  type ProvisionDeps,
} from "../src/provisioner";
import { signSigV4 } from "../src/sigv4";
import { emptyBucketBounded } from "../src/r2-empty";
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
/**
 * ACCOUNT tokens, not user tokens. CfApi mints and revokes at `/accounts/{acct}/tokens`, and the
 * original version of this helper asked `/user/tokens/{id}` -- a different collection, which answers
 * 404 for a live account token and would have reported every revoke as successful without one having
 * happened. Fixed here rather than left as a trap now that the revoke leg is actually exercised.
 */
async function tokenExists(id: string): Promise<boolean> {
  const res = await fetch(`${API}/accounts/${ACCOUNT}/tokens/${id}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
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

/**
 * Minted tokens, registered the instant they exist, for the same reason as `created`: a run that
 * dies mid-assertion must not leave a live bucket-scoped credential on the account. A stranded
 * grant is the worst leftover this file can produce.
 */
const createdTokens: string[] = [];

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
    // cf#72: teardown now EMPTIES a bucket over the S3 API before deleting it, so these four are
    // load-bearing here and are the real ones. The notSupplied getter for r2Endpoint fired the
    // moment that leg landed, exactly as designed, which is how this file learned it needed them.
    r2Endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    get runpod() { return notSupplied("runpod"); },
    get bundle() { return notSupplied("bundle"); },
    get moduleBundle() { return notSupplied("moduleBundle"); },
    get release() { return notSupplied("release"); },
    get kek() { return notSupplied("kek"); },
    get spendDailyCeiling() { return notSupplied("spendDailyCeiling"); },
    get callTenantStudio() { return notSupplied("callTenantStudio"); },
    get callTenantModule() { return notSupplied("callTenantModule"); },
  } as unknown as ProvisionDeps;
});

/**
 * Build the four resources a half-built Tier A tenant carries, for real.
 *
 * `slug` is a PARAMETER, and that is a fix rather than a flourish: every test in this file used to
 * share one set of slug-derived names, so a test that deleted the bucket and the next test that
 * re-created it under the SAME name raced R2 own create-after-delete consistency. It passed alone
 * and failed in the full run, which is the worst way for a fixture to be wrong. Each test that wants
 * its own resources now says so.
 */
async function buildHalfBuiltTenant(slug: string = SLUG): Promise<Tenant> {
  const d1Name = `vivijure-tenant-${slug}`;
  const bucket = `vivijure-tenant-${slug}`;
  const script = `tenant-${slug}-studio`;
  const db = await cf.createD1(d1Name);
  created.d1.push(db.uuid);
  await cf.createR2Bucket(bucket);
  created.buckets.push(bucket);
  await cf.uploadUserWorker({
    namespace: NAMESPACE,
    scriptName: script,
    mainModule: "index.js",
    moduleText: "export default { async fetch() { return new Response(`rehearsal`); } };",
    compatibilityDate: "2026-06-01",
    bindings: [],
  });
  created.scripts.push(script);
  return {
    id: `ten_rehearsal_${slug}`,
    slug,
    account_id: "acct_rehearsal",
    status: "failed",
    script_name: script,
    d1_database_id: db.uuid,
    r2_bucket_name: bucket,
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

/**
 * THE SWEEP, and TWO defects it is the fix for -- both found by verifying the ACCOUNT after a run
 * rather than by trusting the run (2026-07-25, cf#224 Lane A2).
 *
 *  1. It lived INSIDE the first describe, so vitest scoped it there. The block added for the
 *     emptying leg has its own resources and its own deliberately-surviving ones (the guard refusal
 *     test must leave the bucket alive to prove the objects are still there), and NOTHING swept
 *     them. Three runs stranded three D1s, two buckets, three workers and TWO LIVE BUCKET-SCOPED
 *     CREDENTIALS on the account. File-level now, so it covers every block.
 *  2. It deleted buckets with a bare deleteR2Bucket, which CANNOT remove a bucket that has objects
 *     -- the exact constraint this file now exercises. A rehearsal that writes objects and sweeps
 *     with a call that refuses non-empty buckets strands the bucket every time.
 *
 * It also sweeps BY NAME PREFIX, not only the in-process registry: a previous run that died before
 * its sweep is invisible to the registry, and the whole point is that nothing this file created is
 * left alive. Anything it cannot remove is printed LOUDLY rather than swallowed -- a silent cleanup
 * failure is how the credentials got stranded in the first place.
 */
const NAME_PREFIX = "rollins-rehearsal-";
const RESOURCE_PREFIX = `vivijure-tenant-${NAME_PREFIX}`;

afterAll(async () => {
  if (!LIVE) return;
  const leftovers: string[] = [];

  for (const id of createdTokens) {
    try { await cf.revokeToken(id); } catch { /* already revoked */ }
  }

  // Tokens first: a live grant is the worst thing to leave behind, and it is also what the bucket
  // sweep below needs to not collide with.
  try {
    for (const t of await cf.listAccountTokens()) {
      if (!t.name.includes(NAME_PREFIX)) continue;
      try { await cf.revokeToken(t.id); } catch (e) { leftovers.push(`token ${t.name}: ${String(e).slice(0, 120)}`); }
    }
  } catch (e) {
    leftovers.push(`token census failed: ${String(e).slice(0, 120)}`);
  }

  try {
    const res = await fetch(`${API}/accounts/${ACCOUNT}/r2/buckets`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = (await res.json()) as { result?: { buckets?: { name: string }[] } };
    for (const b of body.result?.buckets ?? []) {
      if (!b.name.startsWith(RESOURCE_PREFIX)) continue;
      try {
        // EMPTY THEN DELETE, the same cycle the code under test runs, because a bare delete cannot
        // remove a bucket this file deliberately filled.
        const cred = await minter.mintBucketToken(`${b.name}-sweep`, b.name);
        try {
          await emptyBucketBounded({
            endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
            bucket: b.name,
            credential: { accessKeyId: cred.id, secretAccessKey: await sha256Hex(cred.value) },
            budgetMs: 30_000,
            now: () => Date.now(),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            fetch,
            log: () => {},
          });
          await cf.deleteR2Bucket(b.name);
        } finally {
          await cf.revokeToken(cred.id).catch(() => leftovers.push(`SWEEP CREDENTIAL ${cred.id} NOT REVOKED`));
        }
      } catch (e) {
        leftovers.push(`bucket ${b.name}: ${String(e).slice(0, 120)}`);
      }
    }
  } catch (e) {
    leftovers.push(`bucket census failed: ${String(e).slice(0, 120)}`);
  }

  try {
    const res = await fetch(`${API}/accounts/${ACCOUNT}/d1/database?per_page=100`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as { result?: { uuid: string; name: string }[] };
    for (const db of body.result ?? []) {
      if (!db.name.startsWith(RESOURCE_PREFIX)) continue;
      try { await cf.deleteD1(db.uuid); } catch (e) { leftovers.push(`d1 ${db.name}: ${String(e).slice(0, 120)}`); }
    }
  } catch (e) {
    leftovers.push(`d1 census failed: ${String(e).slice(0, 120)}`);
  }

  for (const ns of [NAMESPACE, MODULE_NAMESPACE]) {
    try {
      const res = await fetch(`${API}/accounts/${ACCOUNT}/workers/dispatch/namespaces/${ns}/scripts`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const body = (await res.json()) as { result?: { id: string }[] };
      for (const script of body.result ?? []) {
        if (!script.id.includes(NAME_PREFIX)) continue;
        try { await cf.deleteUserWorker(ns, script.id); } catch (e) { leftovers.push(`script ${script.id}: ${String(e).slice(0, 120)}`); }
      }
    } catch (e) {
      leftovers.push(`script census failed on ${ns}: ${String(e).slice(0, 120)}`);
    }
  }

  if (leftovers.length > 0) {
    console.error(`LEFTOVERS THIS SWEEP COULD NOT REMOVE (reap them by hand):\n  ${leftovers.join("\n  ")}`);
  }
}, 300_000);

describe.skipIf(!LIVE)("reclaim teardown, live against real Cloudflare", () => {
  let tenant: Tenant;

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
// ALREADY GONE, AGAINST REAL CLOUDFLARE (cp#110).
//
// The unit suite proves the CLASSIFICATION and the blanking over a recording proxy and real SQL.
// What it cannot prove is the thing that started this: what Cloudflare actually answers when the
// script is not there. That answer was live-probed while writing the fix (HTTP 404, code 10007) and
// this is the same fact exercised end to end -- a worker removed OUT OF BAND, exactly as happened to
// the two rows the guarded sweep met, then a teardown that has to come back clean.
//
// SPEND: $0, one trivial user Worker. deleteData is FALSE, so no D1 and no bucket are involved.
// ---------------------------------------------------------------------------------------------
describe.skipIf(!LIVE)("cp#110: a studio worker that is already gone", () => {
  it("records it as ABSENT, blanks the column, and reports a clean pass", async () => {
    const slug = `${NAME_PREFIX}cp110-${RUN}`;
    const script = `tenant-${slug}-studio`;
    const store = new D1Store(d1Over(freshMigratedDb()));
    await store.createAccount("acct_cp110", "cp110@example.com");
    await store.createTenant("ten_cp110", slug, "acct_cp110", "failed");

    await cf.uploadUserWorker({
      namespace: NAMESPACE,
      scriptName: script,
      mainModule: "index.js",
      moduleText: "export default { async fetch() { return new Response(`rehearsal`); } };",
      compatibilityDate: "2026-06-01",
      bindings: [],
    });
    created.scripts.push(script);
    await store.setTenantScript("ten_cp110", script, "test");

    // POSITIVE CONTROL, the rule this whole file is built on: absence at the end proves nothing
    // unless presence at the start was proven first, by a witness other than the client under test.
    expect(await scriptExists(NAMESPACE, script), "the script must really be there first").toBe(true);

    // OUT OF BAND: something else removes it. This is the live shape of the defect, not a fixture.
    await cf.deleteUserWorker(NAMESPACE, script);
    expect(await scriptExists(NAMESPACE, script)).toBe(false);

    const cpDeps = {
      cf,
      tokenMinter: minter,
      namespace: NAMESPACE,
      moduleNamespace: MODULE_NAMESPACE,
      tenantScriptName: (s: string) => `tenant-${s}-studio`,
      log: (event: string, fields: Record<string, unknown>) => void logged.push({ event, fields }),
      store,
      r2Endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    } as unknown as ProvisionDeps;

    const row = (await store.getTenantById("ten_cp110"))!;
    const res = await teardownTenant(cpDeps, row, { deleteData: false });

    // The DELETE really was issued against real Cloudflare and really answered not-found.
    expect(res.absent.map((a) => a.resource), JSON.stringify(res.absent)).toContain("worker");
    expect(
      res.failures.filter((f) => f.resource === "worker"),
      `worker must not be a failure: ${JSON.stringify(res.failures)}`,
    ).toEqual([]);
    // The log line an operator would go looking for, naming the fact rather than hiding it.
    expect(logged.some((l) => l.event === "teardown.worker_absent")).toBe(true);

    // THE DEFECT, closed: the row stops claiming a worker that does not exist.
    expect((await store.getTenantById("ten_cp110"))!.script_name).toBeNull();
  }, 120_000);
});


// ---------------------------------------------------------------------------------------------
// THE NEVER-CREATED WORKER, END TO END (cp#110 severity upgrade).
//
// The strand Rollins hit live on Lane V: a provision that yields BEFORE wfp_upload leaves
// script_name NULL, teardown falls back to the DERIVED name, and the delete 404s on a worker that
// was never created. Recorded as a failure, that gated the reclaim -- which is the only recovery
// the code names -- so the account was stuck permanently on its first attempt.
//
// This drives the recovery sequence (claimReclaim -> teardownTenant -> reclaimSlug) with a REAL
// store and REAL Cloudflare, on a slug whose worker genuinely does not exist. It is the JOIN the
// unit suites cannot make: teardown-guard.test.ts proves the ok flag over a recording proxy,
// routes.test.ts proves the route gate over a fake teardown, and only this proves both against the
// answer Cloudflare actually gives.
//
// SPEND: $0 and, unusually, ZERO resources created -- the whole point is that nothing was ever
// there. Nothing to sweep.
// ---------------------------------------------------------------------------------------------
describe.skipIf(!LIVE)("cp#110: a worker that was NEVER created does not strand the reclaim", () => {
  it("claims, reaps clean over a 404 on a derived name, and frees the row", async () => {
    const slug = `${NAME_PREFIX}cp110nc-${RUN}`;
    const script = `tenant-${slug}-studio`;
    const store = new D1Store(d1Over(freshMigratedDb()));
    await store.createAccount("acct_nc", "nc@example.com");
    await store.createTenant("ten_nc", slug, "acct_nc", "failed");

    // The row this population carries: no script_name ever written.
    const seeded = (await store.getTenantById("ten_nc"))!;
    expect(seeded.script_name, "the population under test never got a script_name").toBeNull();
    // And the derived name really is absent on the account, so the 404 below is the real thing
    // rather than a fixture. Witnessed by the namespace listing, not by the client under test.
    expect(await scriptExists(NAMESPACE, script)).toBe(false);

    const ncDeps = {
      cf,
      tokenMinter: minter,
      namespace: NAMESPACE,
      moduleNamespace: MODULE_NAMESPACE,
      tenantScriptName: (s: string) => `tenant-${s}-studio`,
      log: (event: string, fields: Record<string, unknown>) => void logged.push({ event, fields }),
      store,
      r2Endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    } as unknown as ProvisionDeps;

    // 1. The owner claims the row (the serialization point the route uses).
    const claimed = await store.claimReclaim("ten_nc", "acct_nc", 120);
    expect(claimed, "a Tier A failed row must be reclaimable by its owner").not.toBeNull();

    // 2. The reap. THE FLAG THE ROUTE GATES ON: ok. False here is the permanent strand.
    const reaped = await teardownTenant(ncDeps, claimed!.tenant, { deleteData: true });
    expect(reaped.ok, `teardown failures: ${JSON.stringify(reaped.failures)}`).toBe(true);
    expect(reaped.absent.map((a) => a.resource)).toContain("worker");

    // 3. Completion, which the strand never reached.
    const reclaimed = await store.reclaimSlug("ten_nc", "acct_nc", claimed!.lease_token);
    expect(reclaimed, "the reclaim must complete: this is the recovery the customer needs").not.toBeNull();
    expect(reclaimed!.status).toBe("pending");
    expect(reclaimed!.script_name).toBeNull();
  }, 120_000);
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
      r2Endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
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


// ---------------------------------------------------------------------------------------------
// THE POPULATION THAT COULD NOT BE REAPED (#23 caller work, cf#72, and #38's narrower gaps).
//
// Everything above tears down buckets that are EMPTY. That is the tenant who never rendered, and a
// tenant that was ever live is precisely the tenant who HAS rendered: R2 refuses to delete a
// non-empty bucket, so the real population was unreachable. This block builds a bucket with objects
// in it and reaps it for real.
//
// It also closes the two narrower gaps #38 recorded:
//   - the R2 token REVOKE leg, unexercised because nothing here ever minted one. It does now, with a
//     real minted token, and absence is proven by raw REST at the ACCOUNT token path.
//   - the ephemeral emptying credential: MINT -> WORK -> REVOKE has to hold against real Cloudflare,
//     not just against a recording proxy, or a teardown strands a live bucket-scoped grant.
//
// AND THE GUARD, LIVE. teardown-guard.test.ts proves the refusal against real SQL with a recording
// proxy; what it structurally cannot prove is that a refused bucket still HAS ITS OBJECTS afterwards.
// Emptying is the irreversible half, so that is the assertion that matters, and it needs real R2.
// ---------------------------------------------------------------------------------------------

/** R2 S3 semantics: access key id = token id, secret = SHA-256 hex of the token VALUE. */
async function sha256Hex(v: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const amzNow = (): string => new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");

async function s3Request(
  cred: { accessKeyId: string; secretAccessKey: string },
  args: { method: string; url: string; body?: string },
): Promise<Response> {
  const signed = await signSigV4({
    method: args.method,
    url: args.url,
    headers: {},
    body: args.body,
    accessKeyId: cred.accessKeyId,
    secretAccessKey: cred.secretAccessKey,
    region: "auto",
    service: "s3",
    amzDate: amzNow(),
  });
  return await fetch(args.url, { method: args.method, headers: signed.headers, body: args.body });
}

/** Objects, written with the TENANT's own credential -- the same way a render writes them. */
async function fillBucket(bucket: string, cred: { accessKeyId: string; secretAccessKey: string }): Promise<number> {
  const endpoint = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
  const keys = ["renders/film-1/out.mp4", "keyframes/shot-1.png", "weird &<>\'\" key.txt"];
  // A freshly minted R2 credential is not usable immediately (~3s measured), so the first write waits.
  for (let i = 0; i < 25; i++) {
    const r = await s3Request(cred, {
      method: "PUT",
      url: `${endpoint}/${bucket}/${keys[0].split("/").map(encodeURIComponent).join("/")}`,
      body: "x",
    });
    if (r.status < 300) break;
    await new Promise((res) => setTimeout(res, 1500));
  }
  for (const k of keys.slice(1)) {
    const r = await s3Request(cred, {
      method: "PUT",
      url: `${endpoint}/${bucket}/${k.split("/").map(encodeURIComponent).join("/")}`,
      body: "x",
    });
    expect(r.status, `PUT ${k}`).toBeLessThan(300);
  }
  return keys.length;
}

/** How many objects a bucket holds RIGHT NOW, read with a signed request rather than inferred. */
async function objectCount(bucket: string, cred: { accessKeyId: string; secretAccessKey: string }): Promise<number> {
  const res = await s3Request(cred, {
    method: "GET",
    url: `https://${ACCOUNT}.r2.cloudflarestorage.com/${bucket}?list-type=2`,
  });
  const xml = await res.text();
  return [...xml.matchAll(/<Contents>/g)].length;
}

describe.skipIf(!LIVE)("a bucket that was RENDERED INTO, live (#23 caller, cf#72, #38 revoke leg)", () => {
  it("empties it, deletes it, and revokes BOTH credentials -- proven by raw REST", async () => {
    const tenant = await buildHalfBuiltTenant(`${SLUG}-full`);

    // A REAL minted token, which is the leg #38 recorded as unexercised. It is also what makes the
    // objects below real: they are written with the tenant own credential, not a test shortcut.
    const token = await minter.mintBucketToken(tenantR2TokenName(tenant.slug), tenant.r2_bucket_name!);
    createdTokens.push(token.id);
    const cred = { accessKeyId: token.id, secretAccessKey: await sha256Hex(token.value) };
    const written = await fillBucket(tenant.r2_bucket_name!, cred);

    // POSITIVE CONTROLS, both of them. Presence first, because absence at the end proves nothing
    // otherwise; and then the OLD BEHAVIOUR STILL BITING, so "the delete worked" cannot be true for
    // the boring reason that the bucket was empty all along.
    expect(await objectCount(tenant.r2_bucket_name!, cred)).toBe(written);
    expect(await tokenExists(token.id), "the minted token must exist before the revoke leg runs").toBe(true);
    await expect(cf.deleteR2Bucket(tenant.r2_bucket_name!)).rejects.toThrow(/not empty/i);

    const withToken = { ...tenant, r2_token_id: token.id } as Tenant;
    const result = await teardownTenant(deps, withToken, { deleteData: true });
    expect(result.ok, `teardown failures: ${JSON.stringify(result.failures)}`).toBe(true);

    // Absence witnessed independently of the client that did the deleting.
    expect(await bucketExists(tenant.r2_bucket_name!), "the bucket must be GONE").toBe(false);
    expect(await d1Exists(tenant.d1_database_id!)).toBe(false);
    expect(await scriptExists(NAMESPACE, tenant.script_name!)).toBe(false);

    // THE REVOKE LEG (#38): the tenant credential is gone, by id, at the account token path.
    expect(await tokenExists(token.id), "the tenant R2 token must be revoked").toBe(false);

    // AND THE EPHEMERAL ONE. A teardown that reaps everything but strands its own bucket-scoped
    // grant has rebuilt the orphaned-credential class the cycle design exists to close.
    const leftover = await cf.findTokenByName(tenantR2TeardownTokenName(tenant.slug));
    expect(leftover, "the emptying credential must not outlive the cycle").toBeNull();
  }, 300_000);

  it("the GUARD refuses an aliased bucket, and the objects are STILL THERE afterwards", async () => {
    const store = new D1Store(d1Over(freshMigratedDb()));
    await store.createAccount("acct_alias", "alias@example.com");

    const built = await buildHalfBuiltTenant(`${SLUG}-alias`);
    const token = await minter.mintBucketToken(tenantR2TokenName(built.slug), built.r2_bucket_name!);
    createdTokens.push(token.id);
    const cred = { accessKeyId: token.id, secretAccessKey: await sha256Hex(token.value) };
    const written = await fillBucket(built.r2_bucket_name!, cred);

    // THE LIVE-PLANE SHAPE, rebuilt: a LIVE row and a tombstone renamed off the slug, both still
    // carrying the same ids. Slug reuse is resource reuse.
    await store.createTenant("ten_alias_live", built.slug, "acct_alias", "live");
    await store.setTenantD1("ten_alias_live", built.d1_database_id!);
    await store.setTenantBucket("ten_alias_live", built.r2_bucket_name!);
    await store.setTenantScript("ten_alias_live", built.script_name!, "test");
    // The TOKEN has to be on both rows too, and getting this wrong the first time was instructive:
    // the guard asks whether another ROW references the resource, so a token id passed in the tenant
    // object but absent from every row has no referrer and is correctly NOT refused. The alias must
    // exist in the data, not just in the argument.
    await store.setTenantR2Token("ten_alias_live", token.id);
    await store.createTenant("ten_alias_dead", `${built.slug}-old`, "acct_alias", "failed");
    await store.setTenantStatus("ten_alias_dead", "deleted");
    await store.setTenantD1("ten_alias_dead", built.d1_database_id!);
    await store.setTenantBucket("ten_alias_dead", built.r2_bucket_name!);
    await store.setTenantScript("ten_alias_dead", built.script_name!, "test");
    await store.setTenantR2Token("ten_alias_dead", token.id);
    const dead = (await store.getTenantById("ten_alias_dead"))!;

    const aliasDeps = {
      cf,
      tokenMinter: minter,
      namespace: NAMESPACE,
      moduleNamespace: MODULE_NAMESPACE,
      tenantScriptName: (slug: string) => `tenant-${slug}-studio`,
      log: (event: string, fields: Record<string, unknown>) => void logged.push({ event, fields }),
      store,
      r2Endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    } as unknown as ProvisionDeps;

    const result = await teardownTenant(aliasDeps, dead, { deleteData: true });

    expect(result.ok).toBe(false);
    const refused = Object.fromEntries(result.failures.map((f) => [f.resource, f.error]));
    for (const r of ["d1", "r2_bucket", "worker", "r2_token"]) {
      expect(refused[r], `${r} must be refused`).toMatch(/^refused:/);
      expect(refused[r]).toContain("AT LEAST ONE IS NOT DELETED");
    }

    // THE ASSERTION THIS FILE EXISTS FOR, and the one no mocked suite can make: the live tenant
    // resources are still there, and the bucket still holds every object. A guard that refused the
    // DELETE but let the emptying run first would leave an intact-looking bucket with nothing in it.
    expect(await bucketExists(built.r2_bucket_name!)).toBe(true);
    expect(await d1Exists(built.d1_database_id!)).toBe(true);
    expect(await scriptExists(NAMESPACE, built.script_name!)).toBe(true);
    expect(await objectCount(built.r2_bucket_name!, cred), "the films must still be there").toBe(written);
    expect(await tokenExists(token.id), "a refused credential is not revoked").toBe(true);

    // And no emptying credential was ever minted: the refusal short-circuits before the mint.
    expect(await cf.findTokenByName(tenantR2TeardownTokenName(built.slug))).toBeNull();
  }, 300_000);
});
