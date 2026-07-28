// The credit READ routes (cp#192), driven through the REAL router with a REAL ledger behind them.
//
// WHAT IS FAKE HERE AND WHAT IS NOT, because on a money surface that distinction is the test's whole
// value. Accounts, sessions and tenant lifecycle use the existing MemoryStore -- none of that is
// money. The CREDIT store is a real D1Store over real SQLite built from the real migrations, so
// every balance these routes serve was computed by a SQL engine from rows a SQL engine accepted.
// There is deliberately no fake ledger anywhere in this repo (see the CreditStore doc comment), and
// a route test that invented one would be the exact stub-shaped proof that rule exists to prevent.
//
// Bias, matching routes.test.ts: every guard is watched REFUSING, and every refusal has a positive
// control beside it so "everything refuses" cannot pass for a working feature.

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE, startSession } from "../src/auth";
import { MICRO_PER_USD } from "../src/credits";
import type { ControlPlaneDeps } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import { handle } from "../src/index";
import { D1Store } from "../src/store-d1";
import { MemoryStore } from "./memory-store";
import { d1Over, freshMigratedDb } from "./sqlite-d1";

const ORIGIN = "https://studio.example.com";
const ADMIN_TOKEN = "admin-token";
const USD = (n: number) => n * MICRO_PER_USD;
const T0 = "2026-07-27T10:00:00.000Z";

const env = (over: Partial<ControlPlaneEnv> = {}): ControlPlaneEnv =>
  ({
    CP_DB: {} as D1Database,
    AUP_VERSION: "1",
    AUP_URL: `${ORIGIN}/aup`,
    CONTROL_PLANE_HOST: "studio.example.com",
    CONTROL_PLANE_ADMIN_TOKEN: ADMIN_TOKEN,
    CP_RATE_LIMIT: { limit: async () => ({ success: true }) },
    ...over,
  }) as ControlPlaneEnv;

const ctx = { waitUntil: () => {}, passThroughOnException() {} } as unknown as ExecutionContext;
const req = (path: string, init: RequestInit = {}) =>
  new Request(`${ORIGIN}${path}`, { ...init, headers: { origin: ORIGIN, ...(init.headers as Record<string, string>) } });

describe("credit read routes", () => {
  let store: MemoryStore;
  let db: DatabaseSync;
  let credits: D1Store;
  let deps: ControlPlaneDeps;
  let cookie: string;

  const TEN = "ten_abc123";

  beforeEach(async () => {
    store = new MemoryStore();
    db = freshMigratedDb();
    credits = new D1Store(d1Over(db));

    const account = await store.createAccount("acct_1", "a@b.com");
    await store.createTenant(TEN, "hero", account.id, "live");
    // The ledger's own foreign keys need the tenant to exist on ITS side too.
    await credits.createAccount("acct_1", "a@b.com");
    await credits.createTenant(TEN, "hero", "acct_1", "live");
    // The AUP gate stands in front of every /api/ route; accept it so these tests exercise the
    // credit routes rather than the gate.
    await store.recordAupAcceptance("acct_1", "1", "sha", null, null);

    const { token } = await startSession(store, account.id, Date.now());
    cookie = `${SESSION_COOKIE}=${token}`;

    deps = {
      store,
      mailer: { send: async () => {} },
      fetch: (async () => new Response("aup")) as unknown as typeof fetch,
      now: () => Date.now(),
      credits,
    };
  });

  const getTenant = (id = TEN, d: ControlPlaneDeps = deps, e = env()) =>
    handle(req(`/api/tenant/${id}/credits`, { headers: { cookie } }), e, ctx, d);
  const getAdmin = (id = TEN, d: ControlPlaneDeps = deps, e = env()) =>
    handle(req(`/api/admin/tenants/${id}/credits`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), e, ctx, d);

  const topUp = (idem: string, micro: number) =>
    credits.appendLedgerRow({
      id: `led_${idem}`, tenantId: TEN, kind: "purchase", deltaMicroUsd: micro, costMicroUsd: null,
      idemRef: idem, priceListId: null, externalRef: `ext_${idem}`, note: null, now: T0,
    });
  const hold = (jobRef: string, micro: number) =>
    credits.takeHold({
      id: `hld_${jobRef}`, tenantId: TEN, jobRef, amountMicroUsd: micro, priceListId: "pl_v1",
      now: T0, expiresAt: "2026-07-27T23:00:00.000Z",
    });

  // ---- refusals, each with its control ------------------------------------------------------

  it("refuses 503 when no credit store is wired, rather than answering zeros", async () => {
    // A balance route that returns 0 on an unwired store is an unknown wearing a number's clothes,
    // on the one surface where that number decides whether somebody can work.
    const res = await getTenant(TEN, { ...deps, credits: undefined });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "credits_unconfigured" });
  });

  it("CONTROL: the same request WITH the store wired answers 200", async () => {
    expect((await getTenant()).status).toBe(200);
  });

  it("refuses 503 when the balance itself cannot be read", async () => {
    // Targets the REAL failure path: the store throws exactly where production's would, and the
    // route must not turn that into a confident zero.
    const broken = { ...deps, credits: { ...credits, readBalanceSums: async () => { throw new Error("d1 down"); } } as never };
    const res = await getTenant(TEN, broken);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "balance_unreadable" });
  });

  it("404s another account's tenant instead of confirming it exists", async () => {
    const other = await store.createAccount("acct_2", "b@b.com");
    await store.createTenant("ten_def456", "villain", other.id, "live");
    // 404 not 403: an authorization error that confirms existence is an enumeration oracle.
    expect((await getTenant("ten_def456")).status).toBe(404);
  });

  it("requires the admin bearer on the admin projection", async () => {
    const res = await handle(req(`/api/admin/tenants/${TEN}/credits`), env(), ctx, deps);
    expect(res.status).toBe(401);
  });

  // ---- what the tenant sees ------------------------------------------------------------------

  it("serves a real balance computed by a real SQL engine", async () => {
    await topUp("t1", USD(10));
    await hold("film_1", USD(4));

    const body = (await (await getTenant()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      settled_micro_usd: USD(10),
      held_micro_usd: USD(4),
      available_micro_usd: USD(6),
      complete: true,
      activity_truncated: false,
    });
  });

  it("reports credits_apply FALSE today, which is what keeps the surface dark", async () => {
    // No tenant is prepaid yet: `tenants.compute_mode` is designed in docs/managed-compute.md and
    // lands with cp#191. Until then the honest answer for every tenant is false, and the UI renders
    // nothing rather than showing a BYOK tenant a USD 0.00 balance they never signed up for.
    const body = (await (await getTenant()).json()) as Record<string, unknown>;
    expect(body.credits_apply).toBe(false);
    expect(body.topup_available).toBe(false);
  });

  it("the fields are PRESENT even when false, so the client never has to guess from an absence", async () => {
    const body = (await (await getTenant()).json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["credits_apply", "topup_available"]));
  });

  it("money crosses the wire as integers, never a formatted string", async () => {
    // A formatted number cannot be compared, summed, or re-rendered; rounding at the source is how a
    // balance and its statement come to disagree.
    await topUp("t1", 1_765);
    const body = (await (await getTenant()).json()) as Record<string, unknown>;
    expect(body.settled_micro_usd).toBe(1_765);
    expect(typeof body.settled_micro_usd).toBe("number");
    expect(JSON.stringify(body)).not.toContain("USD ");
  });

  it("shows a FAILED job as an explicit no-charge line with a reason", async () => {
    // The completed-only policy made legible: a tenant learns it from their own failed render rather
    // than from a pricing page. Silence here would read as a lost record.
    await topUp("t1", USD(10));
    const h = await hold("film_flop", USD(4));
    await credits.releaseHold(h.hold.id, T0);

    const body = (await (await getTenant()).json()) as { activity: Record<string, unknown>[] };
    const line = body.activity.find((a) => a.job_ref === "film_flop");
    expect(line).toMatchObject({ kind: "no_charge_failed", delta_micro_usd: 0 });
    expect(String(line?.no_charge_reason)).toContain("not charged");
  });

  it("CONTROL: a COMPLETED job shows exactly one charge line and no no-charge line", async () => {
    // Proves the test above reflects the failure, not a projection that labels everything no-charge.
    await topUp("t1", USD(10));
    const h = await hold("film_good", USD(4));
    await credits.captureHold({ holdId: h.hold.id, ledgerRowId: "led_d1", costMicroUsd: 914_000, note: null, now: T0 });

    const body = (await (await getTenant()).json()) as { activity: Record<string, unknown>[] };
    expect(body.activity.filter((a) => a.kind === "charge")).toHaveLength(1);
    expect(body.activity.filter((a) => a.kind === "no_charge_failed")).toHaveLength(0);
    expect(body.activity.filter((a) => a.job_ref === "film_good")).toHaveLength(0);
  });

  it("reports the enforcement mode, so counting mode is never a guess", async () => {
    const counting = (await (await getTenant()).json()) as { enforcing: boolean };
    expect(counting.enforcing).toBe(false);
    const enforcing = (await (await getTenant(TEN, deps, env({ CREDITS_ENFORCING: "true" }))).json()) as {
      enforcing: boolean;
    };
    expect(enforcing.enforcing).toBe(true);
  });

  // ---- what the operator sees ----------------------------------------------------------------

  it("the admin view adds the cost side and the ratio", async () => {
    await topUp("t1", USD(10));
    const h = await hold("film_1", USD(4));
    await credits.captureHold({ holdId: h.hold.id, ledgerRowId: "led_d1", costMicroUsd: USD(2), note: null, now: T0 });

    const body = (await (await getAdmin()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ cost_known_micro_usd: USD(2), charges_missing_cost: 0, price_to_cost: 2 });
  });

  it("the ratio is NULL, never a fabricated number, when no cost was measured", async () => {
    await topUp("t1", USD(10));
    const h = await hold("film_1", USD(4));
    await credits.captureHold({ holdId: h.hold.id, ledgerRowId: "led_d1", costMicroUsd: null, note: null, now: T0 });

    const body = (await (await getAdmin()).json()) as Record<string, unknown>;
    expect(body.price_to_cost).toBeNull();
    // The unmeasured row is COUNTED, not hidden: it is the reason the ratio is absent.
    expect(body.charges_missing_cost).toBe(1);
  });

  it("the tenant view never leaks the cost side", async () => {
    // What a job cost US is operator information. The tenant is owed their price and their balance.
    await topUp("t1", USD(10));
    const h = await hold("film_1", USD(4));
    await credits.captureHold({ holdId: h.hold.id, ledgerRowId: "led_d1", costMicroUsd: USD(2), note: null, now: T0 });

    const body = (await (await getTenant()).json()) as Record<string, unknown>;
    expect(body.cost_known_micro_usd).toBeUndefined();
    expect(body.price_to_cost).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("cost");
  });

  // ---- zero-ledger tenant (cp#192 review: mackaye verified live against the deployed
  // rollins-e2e testbed on 2026-07-28 -- GET /api/admin/tenants/{id}/credits on a tenant with no
  // ledger rows returned 200 with complete: true and price_to_cost: null. Pinning that here as a
  // regression so it stays true without needing another live call to re-prove it.) ----

  it("a freshly-created tenant with no ledger rows reads complete, not absent", async () => {
    // complete means "this answer is missing nothing", not "there is data here". An empty ledger
    // IS the whole ledger, so a zero-row read is as complete as a thousand-row one; collapsing
    // "no rows yet" into "the read might be partial" would make every brand-new tenant look like a
    // failed read.
    const body = (await (await getTenant()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      settled_micro_usd: 0,
      held_micro_usd: 0,
      available_micro_usd: 0,
      complete: true,
      activity_truncated: false,
    });
    expect((body.activity as unknown[]).length).toBe(0);
  });

  it("CONTROL: the same tenant after a real purchase is still complete, so the flag is not just a zero-row default", async () => {
    // Proves the assertion above is reading a real SUM over rows, not a special case that only
    // fires when the ledger happens to be empty.
    await topUp("t1", USD(10));
    const body = (await (await getTenant()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ settled_micro_usd: USD(10), complete: true });
  });

  it("the admin view on a zero-ledger tenant reports price_to_cost as null, never a fabricated 0", async () => {
    // A computed ratio of 0 asserts "we measured a price-to-cost ratio and it is zero", which is a
    // different and false claim from "nothing has been priced yet". NULL is the honest answer, and
    // this is the no-charges-at-all case (charges_missing_cost: 0), distinct from the existing
    // "unmeasured cost on a real charge" test above (charges_missing_cost: 1).
    const body = (await (await getAdmin()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      complete: true,
      price_to_cost: null,
      cost_known_micro_usd: 0,
      charges_missing_cost: 0,
    });
  });
});
