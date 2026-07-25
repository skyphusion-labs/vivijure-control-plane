// THE PRESERVATION INTERLOCK (cp#118): the technical control that replaces an operator remembering
// a paragraph.
//
// WHAT IT IS FOR. teardownTenant with delete_data empties a tenant R2 bucket and drops its D1.
// ABUSE-RESPONSE-RUNBOOK.md Section 5.2 says teardown is NEVER permitted on a tenant with an open
// report or preservation duty -- suspend is the lever, because it is instant, reversible, audited
// and destroys nothing. Until this interlock, nothing in the code enforced that. Destroying
// material under 18 U.S.C. 2258A(h) is not an embarrassment, it is crime-adjacent.
//
// THE STORE HERE IS REAL. "Is a hold open" is a SQL question and the answer gates an irreversible
// lever, so it is asked of real SQLite built from the real migration ledger. A fake would be my own
// reimplementation of the WHERE clause, which is exactly what must not be trusted here.
//
// THE CFAPI IS A RECORDING PROXY, and the assertions are about the CALL LOG. "The bucket survived"
// can be true for reasons other than the interlock working; what must be proven is that the delete
// was never ISSUED. A CONTROL test proves the recorder records, because a recorder that silently
// records nothing makes every never-called assertion pass.
//
// EVERY REFUSAL HAS A POSITIVE CONTROL NEXT TO IT. A guard that refuses everything is a broken
// feature that looks like a working one.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { handle } from "../src/index";
import { D1Store } from "../src/store-d1";
import { d1Over, freshMigratedDb } from "./sqlite-d1";
import { teardownTenant, type ProvisionDeps } from "../src/provisioner";
import { MemoryStore } from "./memory-store";
import type { ControlPlaneDeps, ProvisionerWiring } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import type { PreservationHold } from "../src/store";

interface CallLog {
  deleteD1: string[];
  deleteR2Bucket: string[];
  deleteUserWorker: string[];
  revoke: string[];
  s3: string[];
}

const emptyLog = (): CallLog => ({ deleteD1: [], deleteR2Bucket: [], deleteUserWorker: [], revoke: [], s3: [] });

function recordingDeps(store: D1Store, log: CallLog): ProvisionDeps {
  return {
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
        return { id: `emptycred-${bucket}`, value: "TEARDOWN_CREDENTIAL_SECRET" };
      },
      async revoke(id: string) {
        log.revoke.push(id);
      },
      async revokeByName() {
        return false;
      },
    },
    r2Endpoint: "https://acct.r2.cloudflarestorage.com",
    now: () => 1_000_000,
    sleep: async () => {},
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
}

describe("teardown interlock against an open preservation hold", () => {
  let store: D1Store;
  let log: CallLog;
  let deps: ProvisionDeps;

  beforeEach(async () => {
    store = new D1Store(d1Over(freshMigratedDb()));
    log = emptyLog();
    deps = recordingDeps(store, log);
    await store.createAccount("acct_1", "a@b.com");
    await store.createTenant("ten_held", "held", "acct_1", "live");
    await store.setTenantD1("ten_held", "db-held");
    await store.setTenantBucket("ten_held", "bkt-held");
    await store.setTenantR2Token("ten_held", "tok-held");
    await store.setTenantScript("ten_held", "tenant-held-studio", "v1.0.0");
  });

  const row = async () => (await store.getTenantById("ten_held"))!;

  const hold = (over: Partial<Parameters<D1Store["openPreservationHold"]>[0]> = {}) =>
    store.openPreservationHold({
      id: "hold_aaaa1111",
      tenant_id: "ten_held",
      kind: "internal",
      reason: "report received, triage pending",
      opened_by: "admin",
      expires_at: null,
      ...over,
    });

  it("CONTROL: with NO hold, teardown proceeds and the recorder really records", async () => {
    // Without this, every never-called assertion below would pass on a broken recorder, and a
    // suite in which nothing can ever be deleted is not evidence that the interlock works.
    const res = await teardownTenant(deps, await row(), { deleteData: true });

    expect(res.ok, JSON.stringify(res.failures)).toBe(true);
    expect(log.deleteUserWorker).toEqual(["tenant-held-studio"]);
    expect(log.deleteD1).toEqual(["db-held"]);
    expect(log.deleteR2Bucket).toEqual(["bkt-held"]);
    expect(log.s3.length, "the emptying loop really did open the bucket").toBeGreaterThan(0);
  });

  it("REFUSES the whole pass while a hold is open, and issues NOT ONE destructive call", async () => {
    await hold();

    const res = await teardownTenant(deps, await row(), { deleteData: true });

    expect(res.ok).toBe(false);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0].resource).toBe("preservation_hold");
    // The guard vocabulary (#23): the route splits refused out of failed because they need
    // opposite follow-up. There is nothing to retry here; only a human release lifts it.
    expect(res.failures[0].error.startsWith("refused:")).toBe(true);
    expect(res.failures[0].error).toContain("hold_aaaa1111");
    expect(res.failures[0].error).toContain("suspend instead");

    // NOTHING was touched. Not the worker, not the credential, not the bucket -- and the bucket was
    // never even OPENED, which is the stronger claim: emptying is the irreversible half.
    expect(log.deleteUserWorker).toEqual([]);
    expect(log.deleteD1).toEqual([]);
    expect(log.deleteR2Bucket).toEqual([]);
    expect(log.revoke).toEqual([]);
    expect(log.s3).toEqual([]);

    // And the row still claims every resource, so nothing reads as reaped.
    const after = await row();
    expect(after.script_name).toBe("tenant-held-studio");
    expect(after.d1_database_id).toBe("db-held");
    expect(after.r2_bucket_name).toBe("bkt-held");
    expect(after.r2_token_id).toBe("tok-held");
  });

  it("refuses a data-KEEPING teardown too: the studio worker is evidence-adjacent", async () => {
    // delete_data false still pulls the worker, the module scripts and the credential. The runbook
    // does not say tear down carefully while a report is open; it says suspend instead.
    await hold();

    const res = await teardownTenant(deps, await row(), { deleteData: false });

    expect(res.ok).toBe(false);
    expect(log.deleteUserWorker).toEqual([]);
    expect(log.revoke).toEqual([]);
  });

  it("names EVERY open hold and both statutory clocks, because two can run at once", async () => {
    // 2258A(h)(1) is 1 year from OUR submission; 2703(f) is 90 days from a governmental request,
    // renewable. 2258A(h)(4) says the two do not limit each other, so an operator has to see both.
    await hold({ id: "hold_ncmec01", kind: "ncmec_2258a_h", reason: "CyberTipline report filed", expires_at: "2027-07-25T00:00:00.000Z" });
    await hold({ id: "hold_le000001", kind: "le_2703_f", reason: "FBI preservation request 24-1234", expires_at: "2026-10-23T00:00:00.000Z" });

    const res = await teardownTenant(deps, await row(), { deleteData: true });

    const error = res.failures[0].error;
    expect(error).toContain("2 open preservation hold(s)");
    expect(error).toContain("hold_ncmec01");
    expect(error).toContain("ncmec_2258a_h");
    expect(error).toContain("2027-07-25T00:00:00.000Z");
    expect(error).toContain("hold_le000001");
    expect(error).toContain("le_2703_f");
    expect(error).toContain("2026-10-23T00:00:00.000Z");
  });

  it("an ELAPSED clock still blocks: the floor of a duty is not permission to delete", async () => {
    // THE LOAD-BEARING DESIGN DECISION. 2258A(h)(5) permits preserving longer, and 2258B(c) puts
    // destruction on a law-enforcement request rather than on a timer of ours. A clock that
    // silently unblocked a destructive pass would be this same defect wearing a calendar.
    await hold({ kind: "le_2703_f", expires_at: "2020-01-01T00:00:00.000Z", reason: "long-elapsed request" });

    const res = await teardownTenant(deps, await row(), { deleteData: true });

    expect(res.ok).toBe(false);
    expect(res.failures[0].resource).toBe("preservation_hold");
    expect(log.deleteR2Bucket).toEqual([]);
  });

  it("lifts ONLY when the LAST hold is released, and each release is single-use", async () => {
    await hold({ id: "hold_first001" });
    await hold({ id: "hold_second01", kind: "le_2703_f", reason: "police request" });

    expect(await store.releasePreservationHold("hold_first001", "admin", "reporter withdrew")).not.toBeNull();
    // Still held: one down, one open. A release that lifted the interlock here would be the
    // multiple-concurrent-holds bug a single column would have shipped.
    const stillHeld = await teardownTenant(deps, await row(), { deleteData: true });
    expect(stillHeld.ok).toBe(false);
    expect(log.deleteR2Bucket).toEqual([]);

    // A second release of the SAME hold changes nothing and says so: the audit row for the first
    // release is the record of who decided the duty was over.
    expect(await store.releasePreservationHold("hold_first001", "admin", "again")).toBeNull();

    expect(await store.releasePreservationHold("hold_second01", "admin", "LE confirmed closed")).not.toBeNull();
    const freed = await teardownTenant(deps, await row(), { deleteData: true });
    expect(freed.ok, JSON.stringify(freed.failures)).toBe(true);
    expect(log.deleteR2Bucket).toEqual(["bkt-held"]);
  });

  it("FAILS CLOSED: a store that cannot answer the hold question reaps nothing", async () => {
    // Watched failing before it is trusted: the interlock query itself breaks.
    (deps.store as unknown as { listPreservationHolds: () => Promise<never> }).listPreservationHolds = async () => {
      throw new Error("D1 unavailable");
    };

    const res = await teardownTenant(deps, await row(), { deleteData: true });

    expect(res.ok).toBe(false);
    expect(res.failures[0].resource).toBe("preservation_hold");
    expect(res.failures[0].error).toContain("could not determine");
    expect(log.deleteD1).toEqual([]);
    expect(log.deleteR2Bucket).toEqual([]);
    expect(log.deleteUserWorker).toEqual([]);
  });

  it("records the refusal on the ROW, so a later reader sees why nothing was reaped", async () => {
    await hold();
    await teardownTenant(deps, await row(), { deleteData: true });

    const after = await row();
    expect(after.teardown_at, "the attempt happened and is dated").not.toBeNull();
    const recorded = JSON.parse(after.teardown_failures!) as { resource: string; error: string }[];
    expect(recorded[0].resource).toBe("preservation_hold");
  });
});

// ---- the admin routes, driven through the real router --------------------------------------------

const ROOT_HOST = "studio.vivijure.com";
const ORIGIN = `https://${ROOT_HOST}`;
const ADMIN_TOKEN = "a".repeat(64);

describe("preservation hold admin routes", () => {
  let store: MemoryStore;
  let deps: ControlPlaneDeps;

  const env = () =>
    ({
      ASSETS: { fetch: async () => new Response("ui") } as unknown as Fetcher,
      CP_DB: {} as D1Database,
      AUP_VERSION: "1",
      AUP_URL: `${ORIGIN}/aup`,
      CONTROL_PLANE_HOST: ROOT_HOST,
      CONTROL_PLANE_ADMIN_TOKEN: ADMIN_TOKEN,
      CP_RATE_LIMIT: { limit: async () => ({ success: true }) },
    }) as unknown as ControlPlaneEnv;

  const ctx = { waitUntil: () => {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const admin = () => ({ authorization: `Bearer ${ADMIN_TOKEN}` });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    });

  beforeEach(async () => {
    store = new MemoryStore();
    deps = {
      store,
      mailer: { send: async () => {} },
      fetch: vi.fn() as unknown as typeof fetch,
      now: () => 1_750_000_000_000,
      provisioner: { teardown: vi.fn(async () => ({ ok: true, failures: [], absent: [] })) } as unknown as ProvisionerWiring,
    } as unknown as ControlPlaneDeps;
    await store.createAccount("acct_1", "a@b.com");
    await store.createTenant("ten_abc123", "hero", "acct_1", "live");
  });

  it("REFUSES an unauthenticated open: this gates a destructive lever both ways", async () => {
    const res = await handle(
      post("/api/admin/tenants/ten_abc123/preservation-holds", { kind: "internal", reason: "x" }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(401);
    expect(store.holds.size).toBe(0);
  });

  it("REFUSES a hold with no reason: an unexplained hold is not auditable", async () => {
    const res = await handle(
      post("/api/admin/tenants/ten_abc123/preservation-holds", { kind: "internal" }, admin()),
      env(), ctx, deps,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("reason_required");
    expect(store.holds.size, "nothing written on a refusal").toBe(0);
  });

  it("REFUSES an unknown kind rather than inventing a clock for it", async () => {
    const res = await handle(
      post("/api/admin/tenants/ten_abc123/preservation-holds", { kind: "vibes", reason: "x" }, admin()),
      env(), ctx, deps,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("invalid_kind");
  });

  it("POSITIVE CONTROL: opens a hold, audits it, and defaults the statutory clock", async () => {
    const res = await handle(
      post(
        "/api/admin/tenants/ten_abc123/preservation-holds",
        { kind: "ncmec_2258a_h", reason: "CyberTipline report 12345 filed" },
        admin(),
      ),
      env(), ctx, deps,
    );
    expect(res.status).toBe(201);
    const { hold } = (await res.json()) as { hold: PreservationHold };
    expect(hold.kind).toBe("ncmec_2258a_h");
    expect(hold.released_at).toBeNull();
    // 1 YEAR, not 90 days: Pub. L. 118-59 amended 2258A(h)(1) in 2024 and anything still saying 90
    // days for THIS clock is quoting repealed text.
    const days = (Date.parse(hold.expires_at!) - Date.parse(hold.opened_at)) / 86_400_000;
    expect(Math.round(days)).toBe(365);

    const entry = store.audit.find((a) => a.action === "tenant.preservation_hold.open")!;
    expect(entry, "an unaudited hold is not a control").toBeDefined();
    expect(JSON.parse(entry.detail!)).toMatchObject({ hold_id: hold.id, kind: "ncmec_2258a_h" });
  });

  it("gives 2703(f) the 90-day clock, so the two duties are never conflated", async () => {
    const res = await handle(
      post(
        "/api/admin/tenants/ten_abc123/preservation-holds",
        { kind: "le_2703_f", reason: "preservation request from a governmental entity" },
        admin(),
      ),
      env(), ctx, deps,
    );
    const { hold } = (await res.json()) as { hold: PreservationHold };
    const days = (Date.parse(hold.expires_at!) - Date.parse(hold.opened_at)) / 86_400_000;
    expect(Math.round(days)).toBe(90);
  });

  it("leaves an internal hold WITHOUT a clock instead of inventing one", async () => {
    const res = await handle(
      post("/api/admin/tenants/ten_abc123/preservation-holds", { kind: "internal", reason: "report received" }, admin()),
      env(), ctx, deps,
    );
    const { hold } = (await res.json()) as { hold: PreservationHold };
    expect(hold.expires_at).toBeNull();
  });

  it("REFUSES a release with no reason, and REFUSES releasing a hold on a DIFFERENT tenant", async () => {
    await store.createTenant("ten_0000beef", "other", "acct_1", "live");
    const opened = await store.openPreservationHold({
      id: "hold_beef0001", tenant_id: "ten_0000beef", kind: "internal",
      reason: "someone else incident", opened_by: "admin", expires_at: null,
    });

    // NOTE the id shape: hold ids are hex (newId) and the route regex enforces that, so a
    // non-hex id 404s at the router before ever reaching the reason check -- which would have made
    // this a refusal that proves nothing. The id here is hex so the request really does reach the
    // guard being tested.
    const noReason = await handle(
      post(`/api/admin/tenants/ten_0000beef/preservation-holds/${opened.id}/release`, {}, admin()),
      env(), ctx, deps,
    );
    expect(noReason.status).toBe(400);

    // The hold id is real, the reason is fine, and the TENANT in the path is the wrong one. An
    // operator working from a pasted id must not lift a hold off another customer row by typo.
    const wrongTenant = await handle(
      post(`/api/admin/tenants/ten_abc123/preservation-holds/${opened.id}/release`, { reason: "typo" }, admin()),
      env(), ctx, deps,
    );
    expect(wrongTenant.status).toBe(404);
    expect((await store.listPreservationHolds("ten_0000beef", { openOnly: true })).length, "still open").toBe(1);
  });

  it("POSITIVE CONTROL: releases with a reason, audits it, and refuses a second release", async () => {
    const opened = await store.openPreservationHold({
      id: "hold_bbbb2222", tenant_id: "ten_abc123", kind: "internal",
      reason: "report received", opened_by: "admin", expires_at: null,
    });

    const res = await handle(
      post(`/api/admin/tenants/ten_abc123/preservation-holds/${opened.id}/release`, { reason: "LE closed the matter" }, admin()),
      env(), ctx, deps,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hold: PreservationHold }).hold.released_at).not.toBeNull();
    expect(store.audit.find((a) => a.action === "tenant.preservation_hold.release")).toBeDefined();

    const again = await handle(
      post(`/api/admin/tenants/ten_abc123/preservation-holds/${opened.id}/release`, { reason: "again" }, admin()),
      env(), ctx, deps,
    );
    expect(again.status).toBe(409);
  });

  it("lists every hold, released ones included: a closed duty is part of the record", async () => {
    await store.openPreservationHold({
      id: "hold_cccc3333", tenant_id: "ten_abc123", kind: "internal",
      reason: "one", opened_by: "admin", expires_at: null,
    });
    await store.releasePreservationHold("hold_cccc3333", "admin", "done");

    const res = await handle(
      new Request(`${ORIGIN}/api/admin/tenants/ten_abc123/preservation-holds`, { headers: { origin: ORIGIN, ...admin() } }),
      env(), ctx, deps,
    );
    expect(res.status).toBe(200);
    const { holds } = (await res.json()) as { holds: PreservationHold[] };
    expect(holds).toHaveLength(1);
    expect(holds[0].released_at).not.toBeNull();
  });
});
