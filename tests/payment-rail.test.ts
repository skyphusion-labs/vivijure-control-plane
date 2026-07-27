// The payment rail seam and the operator credit route (cp#193).
//
// NO PAYMENT PROCESSOR APPEARS IN THIS FILE, in any mode. Not a Stripe client, not a test-mode key,
// not a recorded fixture of one. The rail under test needs no processor, and the interface exists so
// that adding one later is a new class rather than a change to the money path.
//
// The ledger behind these routes is a REAL D1Store over real SQLite from the real migrations, for
// the reason argued on the CreditStore interface: this repo has no fake ledger, and a route that
// mints money is the last place to introduce one.

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { MICRO_PER_USD } from "../src/credits";
import type { ControlPlaneDeps } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import { handle } from "../src/index";
import {
  DEFAULT_MANUAL_CREDIT_CEILING_MICRO_USD,
  ManualRail,
  PaymentRailError,
  applySettlement,
  validateCreditAmount,
} from "../src/payment-rail";
import { D1Store } from "../src/store-d1";
import { MemoryStore } from "./memory-store";
import { d1Over, freshMigratedDb } from "./sqlite-d1";

const ORIGIN = "https://studio.example.com";
const ADMIN_TOKEN = "admin-token";
const TEN = "ten_abc123";
const USD = (n: number) => n * MICRO_PER_USD;

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

describe("the rail interface", () => {
  it("ManualRail refuses to invent a checkout surface it does not have", async () => {
    // A rail that returned a plausible URL would advertise a door that goes nowhere, which is the
    // Apple-SSO failure shape: a button that throws is worse than an absent one.
    await expect(new ManualRail().createTopUp()).rejects.toBeInstanceOf(PaymentRailError);
  });

  it("ManualRail refuses to verify a webhook it cannot verify", async () => {
    await expect(new ManualRail().parseSettlement()).rejects.toBeInstanceOf(PaymentRailError);
  });
});

describe("amount validation", () => {
  const C = DEFAULT_MANUAL_CREDIT_CEILING_MICRO_USD;

  it("refuses anything that is not a positive whole number of micro-USD", () => {
    for (const bad of [undefined, null, "10", 1.5, 0, -1, NaN, Infinity, 1e400]) {
      expect(validateCreditAmount(bad, C).ok).toBe(false);
    }
  });

  it("CONTROL: a well-formed amount passes, so the rejections are not a dead function", () => {
    const v = validateCreditAmount(USD(10), C);
    expect(v.ok).toBe(true);
  });

  it("refuses above the ceiling and NAMES the knob that would allow it", () => {
    // The refusal has to be actionable: an operator who genuinely means USD 500 needs to know how,
    // or they will look for a way around the check instead of through it.
    const v = validateCreditAmount(C + 1, C);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain("MANUAL_CREDIT_CEILING_MICRO_USD");
  });

  it("accepts exactly the ceiling (the boundary is inclusive)", () => {
    expect(validateCreditAmount(C, C).ok).toBe(true);
  });
});

describe("POST /api/admin/tenants/:id/credits/manual", () => {
  let store: MemoryStore;
  let db: DatabaseSync;
  let credits: D1Store;
  let deps: ControlPlaneDeps;

  beforeEach(async () => {
    store = new MemoryStore();
    db = freshMigratedDb();
    credits = new D1Store(d1Over(db));
    await store.createAccount("acct_1", "a@b.com");
    await store.createTenant(TEN, "hero", "acct_1", "live");
    await credits.createAccount("acct_1", "a@b.com");
    await credits.createTenant(TEN, "hero", "acct_1", "live");
    deps = {
      store,
      mailer: { send: async () => {} },
      fetch: (async () => new Response("aup")) as unknown as typeof fetch,
      now: () => 1_750_000_000_000,
      credits,
    };
  });

  const post = (body: unknown, id = TEN, d: ControlPlaneDeps = deps, e = env()) =>
    handle(
      new Request(`${ORIGIN}/api/admin/tenants/${id}/credits/manual`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { origin: ORIGIN, "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      e,
      ctx,
      d,
    );

  const GOOD = { amount_micro_usd: USD(10), operator: "conrad", reason: "comped after an incident", reference: "ref-1" };

  it("credits the tenant and the balance moves", async () => {
    expect((await post(GOOD)).status).toBe(200);
    expect((await credits.readBalanceSums(TEN)).settled).toBe(USD(10));
  });

  it("a retried credit with the SAME reference credits once", async () => {
    await post(GOOD);
    const again = await post(GOOD);
    // 200 on a replay, not 409: a caller retrying after a timeout must be able to reach a success
    // and stop, or the retry loop never ends.
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ applied: false });
    expect((await credits.readBalanceSums(TEN)).settled).toBe(USD(10));
  });

  it("CONTROL: a NEW reference credits again, so the guard is the reference and not a broken route", async () => {
    await post(GOOD);
    await post({ ...GOOD, reference: "ref-2" });
    expect((await credits.readBalanceSums(TEN)).settled).toBe(USD(20));
  });

  it("refuses a credit with no operator, no reason, or no reference, and credits nothing", async () => {
    for (const [field, body] of [
      ["operator", { ...GOOD, operator: "  " }],
      ["reason", { ...GOOD, reason: "" }],
      ["reference", { ...GOOD, reference: "" }],
    ] as const) {
      const res = await post(body);
      expect(res.status, field).toBe(400);
    }
    expect((await credits.readBalanceSums(TEN)).settled).toBe(0);
  });

  it("refuses above the ceiling, and honours a raised ceiling", async () => {
    const big = { ...GOOD, amount_micro_usd: USD(500) };
    expect((await post(big)).status).toBe(400);
    expect((await credits.readBalanceSums(TEN)).settled).toBe(0);

    // CONTROL: the same request under a deliberately raised knob succeeds, proving the refusal was
    // the ceiling rather than the amount being unacceptable in principle.
    const raised = env({ MANUAL_CREDIT_CEILING_MICRO_USD: String(USD(1000)) });
    expect((await post(big, TEN, deps, raised)).status).toBe(200);
    expect((await credits.readBalanceSums(TEN)).settled).toBe(USD(500));
  });

  it("requires the admin bearer", async () => {
    const res = await handle(
      new Request(`${ORIGIN}/api/admin/tenants/${TEN}/credits/manual`, {
        method: "POST",
        body: JSON.stringify(GOOD),
        headers: { origin: ORIGIN, "content-type": "application/json" },
      }),
      env(),
      ctx,
      deps,
    );
    expect(res.status).toBe(401);
    expect((await credits.readBalanceSums(TEN)).settled).toBe(0);
  });

  it("404s an unknown tenant instead of creating money for nobody", async () => {
    expect((await post(GOOD, "ten_ffffff")).status).toBe(404);
  });

  it("503s rather than crediting when no ledger is wired", async () => {
    expect((await post(GOOD, TEN, { ...deps, credits: undefined })).status).toBe(503);
  });

  it("audits every attempt INCLUDING the replay", async () => {
    await post(GOOD);
    await post(GOOD);
    const rows = store.audit.filter((r) => r.action === "tenant.credit_manual");
    // Two attempts, two audit rows: an audit that recorded only first attempts could show neither a
    // broken client nor somebody probing.
    expect(rows).toHaveLength(2);
    expect(JSON.parse(String(rows[0].detail))).toMatchObject({ applied: true, operator_claimed: "conrad" });
    expect(JSON.parse(String(rows[1].detail))).toMatchObject({ applied: false });
  });

  it("records the operator as a CLAIM, never as a verified identity", async () => {
    // One shared admin token means the bearer proves someone holds the credential and never which
    // human. The field name carries that so a money audit cannot be misread as attribution.
    await post(GOOD);
    const row = store.audit.find((r) => r.action === "tenant.credit_manual");
    expect(String(row?.detail)).toContain("operator_claimed");
    expect(String(row?.detail)).not.toContain('"operator":');
  });
});

describe("applySettlement", () => {
  it("namespaces idempotency by rail, so two rails cannot collide on a shared reference", async () => {
    const db = freshMigratedDb();
    const credits = new D1Store(d1Over(db));
    await credits.createAccount("acct_1", "a@b.com");
    await credits.createTenant(TEN, "hero", "acct_1", "live");

    const event = { tenant_id: TEN, amount_micro_usd: USD(10), external_ref: "evt_1", note: null };
    const a = await applySettlement(credits, { railId: "manual", event, rowId: "led_1", now: "2026-07-27T10:00:00.000Z" });
    const b = await applySettlement(credits, { railId: "stripe", event, rowId: "led_2", now: "2026-07-27T10:00:00.000Z" });
    const replay = await applySettlement(credits, { railId: "manual", event, rowId: "led_3", now: "2026-07-27T10:00:00.000Z" });

    expect([a.applied, b.applied, replay.applied]).toEqual([true, true, false]);
    // Two distinct rails settled; the manual replay did not.
    expect((await credits.readBalanceSums(TEN)).settled).toBe(USD(20));
  });
});
