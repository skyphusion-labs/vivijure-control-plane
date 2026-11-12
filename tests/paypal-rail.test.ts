// PayPalRail (cp#193). Fetch is mocked; no live PayPal call, no credential.

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE, startSession } from "../src/auth";
import { MICRO_PER_USD } from "../src/credits";
import { topUpAvailable } from "../src/credits-api";
import type { ControlPlaneDeps } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import { handle } from "../src/index";
import { PaymentRailError, applySettlement, settlementMismatch } from "../src/payment-rail";
import {
  PayPalRail,
  microUsdToPayPalValue,
  paypalApiBase,
  paypalValueToMicroUsd,
  resetPayPalTokenCache,
} from "../src/paypal-rail";
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

const PAYPAL = {
  PAYPAL_CLIENT_ID: "client-id",
  PAYPAL_CLIENT_SECRET: "client-secret",
  PAYPAL_WEBHOOK_ID: "webhook-id",
  PAYPAL_ENV: "sandbox",
};

const CAPTURE_BODY = {
  id: "WH-1",
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: {
    id: "CAP-99",
    custom_id: TEN,
    amount: { currency_code: "USD", value: "10.00" },
    supplementary_data: { related_ids: { order_id: "ORDER-1" } },
  },
};

/**
 * CHECKOUT.ORDER.APPROVED: the buyer authorised, and NO money has moved yet. This is the event the
 * plane was missing entirely -- without a capture call after it, the order simply expires.
 */
const APPROVED_BODY = {
  id: "WH-2",
  event_type: "CHECKOUT.ORDER.APPROVED",
  resource: {
    id: "ORDER-1",
    purchase_units: [{ custom_id: TEN, amount: { currency_code: "USD", value: "10.00" } }],
  },
};

/** What POST /v2/checkout/orders/ORDER-1/capture answers. The capture id is the money's own id. */
const CAPTURE_RESPONSE = {
  id: "ORDER-1",
  status: "COMPLETED",
  purchase_units: [
    {
      payments: {
        captures: [
          { id: "CAP-99", status: "COMPLETED", custom_id: TEN, amount: { currency_code: "USD", value: "10.00" } },
        ],
      },
    },
  ],
};

const TRANSMISSION = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/cert.pem",
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-sig": "sig-1",
  "paypal-transmission-time": "2026-08-16T00:00:00Z",
};

function mockFetch(handlers: {
  token?: () => Response;
  order?: (init: RequestInit) => Response;
  verify?: (init: RequestInit) => Response;
  capture?: (init: RequestInit, orderId: string) => Response;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const cap = /\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(url);
    if (cap) {
      return (handlers.capture ?? (() => jsonRes(CAPTURE_RESPONSE)))(init ?? {}, cap[1]);
    }
    if (url.endsWith("/v1/oauth2/token")) {
      return (handlers.token ?? (() => jsonRes({ access_token: "tok", expires_in: 3600 })))();
    }
    if (url.endsWith("/v2/checkout/orders")) {
      return (handlers.order ?? (() => jsonRes({ id: "ORDER-1", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1" }] })))(
        init ?? {},
      );
    }
    if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
      return (handlers.verify ?? (() => jsonRes({ verification_status: "SUCCESS" })))(init ?? {});
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  resetPayPalTokenCache();
  vi.unstubAllGlobals();
});

describe("amount conversion", () => {
  it("formats whole cents as a 2-decimal USD string", () => {
    expect(microUsdToPayPalValue(USD(10))).toBe("10.00");
    expect(microUsdToPayPalValue(10_500_000)).toBe("10.50");
  });

  it("refuses leftover micros that are not a whole cent", () => {
    expect(() => microUsdToPayPalValue(USD(10) + 1)).toThrow(PaymentRailError);
  });

  it("parses a PayPal value back to the same micro-USD", () => {
    expect(paypalValueToMicroUsd("10.00")).toBe(USD(10));
    expect(paypalValueToMicroUsd("10.5")).toBeNull();
  });
});

describe("paypalApiBase", () => {
  it("is sandbox unless PAYPAL_ENV is exactly live", () => {
    expect(paypalApiBase(undefined)).toBe("https://api-m.sandbox.paypal.com");
    expect(paypalApiBase("sandbox")).toBe("https://api-m.sandbox.paypal.com");
    expect(paypalApiBase("live")).toBe("https://api-m.paypal.com");
  });
});

describe("topUpAvailable", () => {
  it("is false until client id, secret, and webhook id are all set", () => {
    expect(topUpAvailable({})).toBe(false);
    expect(topUpAvailable({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s" })).toBe(false);
    expect(topUpAvailable(PAYPAL)).toBe(true);
  });
});

describe("PayPalRail.createTopUp", () => {
  it("posts a CAPTURE order and returns the approve link", async () => {
    let posted: unknown;
    const rail = new PayPalRail({
      ...{
        clientId: PAYPAL.PAYPAL_CLIENT_ID,
        clientSecret: PAYPAL.PAYPAL_CLIENT_SECRET,
        webhookId: PAYPAL.PAYPAL_WEBHOOK_ID,
      },
      fetchImpl: mockFetch({
        order: (init) => {
          posted = JSON.parse(String(init.body));
          expect(init.headers && new Headers(init.headers).get("paypal-request-id")).toBeTruthy();
          return jsonRes({
            id: "ORDER-1",
            links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1" }],
          });
        },
      }),
    });

    const intent = await rail.createTopUp({ tenantId: TEN, amountMicroUsd: USD(10) });
    expect(intent).toEqual({
      checkout_url: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1",
      external_ref: "ORDER-1",
    });
    expect(posted).toMatchObject({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: "10.00" }, custom_id: TEN }],
    });
  });

  it("sends a return_url and a cancel_url so the buyer lands back on the plane", async () => {
    let posted: any;
    const rail = new PayPalRail({
      clientId: "id",
      clientSecret: "s",
      webhookId: "wh",
      returnUrl: `${ORIGIN}/?topup=done`,
      cancelUrl: `${ORIGIN}/?topup=cancelled`,
      fetchImpl: mockFetch({
        order: (init) => {
          posted = JSON.parse(String(init.body));
          return jsonRes({ id: "ORDER-1", links: [{ rel: "approve", href: "https://x/approve" }] });
        },
      }),
    });
    await rail.createTopUp({ tenantId: TEN, amountMicroUsd: USD(10) });
    expect(posted.application_context).toMatchObject({
      return_url: `${ORIGIN}/?topup=done`,
      cancel_url: `${ORIGIN}/?topup=cancelled`,
      user_action: "PAY_NOW",
      shipping_preference: "NO_SHIPPING",
    });
  });

  it("omits application_context entirely when no return URL is configured", async () => {
    let posted: any;
    const rail = new PayPalRail({
      clientId: "id",
      clientSecret: "s",
      webhookId: "wh",
      fetchImpl: mockFetch({
        order: (init) => {
          posted = JSON.parse(String(init.body));
          return jsonRes({ id: "ORDER-1", links: [{ rel: "approve", href: "https://x/approve" }] });
        },
      }),
    });
    await rail.createTopUp({ tenantId: TEN, amountMicroUsd: USD(10) });
    expect(posted.application_context).toBeUndefined();
  });

  it("refuses below the USD 10 floor", async () => {
    const rail = new PayPalRail({
      clientId: "id",
      clientSecret: "s",
      webhookId: "wh",
      fetchImpl: mockFetch({}),
    });
    await expect(rail.createTopUp({ tenantId: TEN, amountMicroUsd: USD(9) })).rejects.toMatchObject({
      code: "invalid_amount",
    });
  });

  it("throws not_configured when credentials are missing", async () => {
    const rail = new PayPalRail({
      clientId: "",
      clientSecret: "",
      webhookId: "",
      fetchImpl: mockFetch({}),
    });
    await expect(rail.createTopUp({ tenantId: TEN, amountMicroUsd: USD(10) })).rejects.toMatchObject({
      code: "not_configured",
    });
  });
});

describe("PayPalRail.parseSettlement", () => {
  const captureReq = (over: { headers?: Record<string, string>; body?: unknown } = {}) =>
    new Request("https://studio.example.com/api/webhooks/paypal", {
      method: "POST",
      headers: { "content-type": "application/json", ...TRANSMISSION, ...over.headers },
      body: JSON.stringify(over.body ?? CAPTURE_BODY),
    });

  it("returns a settlement for a verified CAPTURE.COMPLETED", async () => {
    const rail = new PayPalRail({
      clientId: "id",
      clientSecret: "s",
      webhookId: "wh",
      fetchImpl: mockFetch({}),
    });
    const event = await rail.parseSettlement(captureReq());
    expect(event).toEqual({
      kind: "settlement",
      settlement: {
        tenant_id: TEN,
        amount_micro_usd: USD(10),
        external_ref: "CAP-99",
        note: "paypal PAYMENT.CAPTURE.COMPLETED",
        order_ref: "ORDER-1",
      },
    });
  });

  it("reports a verified CHECKOUT.ORDER.APPROVED as an order awaiting CAPTURE, not as a settlement", async () => {
    // THE DEFECT THIS FILE MISSED: the old parser answered null here, so the one event that says
    // "collect the money now" was indistinguishable from an event we do not care about.
    const rail = new PayPalRail({
      clientId: "id",
      clientSecret: "s",
      webhookId: "wh",
      fetchImpl: mockFetch({}),
    });
    const event = await rail.parseSettlement(captureReq({ body: APPROVED_BODY }));
    expect(event).toEqual({ kind: "approved", order_ref: "ORDER-1", tenant_ref: TEN });
  });

  it("throws unverified when PayPal does not say SUCCESS", async () => {
    const rail = new PayPalRail({
      clientId: "id",
      clientSecret: "s",
      webhookId: "wh",
      fetchImpl: mockFetch({ verify: () => jsonRes({ verification_status: "FAILURE" }) }),
    });
    await expect(rail.parseSettlement(captureReq())).rejects.toMatchObject({ code: "unverified" });
  });

  it("returns null for an unrelated verified event type", async () => {
    const rail = new PayPalRail({
      clientId: "id",
      clientSecret: "s",
      webhookId: "wh",
      fetchImpl: mockFetch({}),
    });
    const event = await rail.parseSettlement(captureReq({ body: { event_type: "PAYMENT.CAPTURE.DENIED", resource: {} } }));
    expect(event).toBeNull();
  });

  it("returns null for an APPROVED event carrying no tenant reference", async () => {
    // Nothing to capture FOR. Answering null keeps a malformed event a no-op rather than a capture
    // whose proceeds could not be attributed to anybody.
    const rail = new PayPalRail({
      clientId: "id",
      clientSecret: "s",
      webhookId: "wh",
      fetchImpl: mockFetch({}),
    });
    const event = await rail.parseSettlement(
      captureReq({ body: { event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORDER-1", purchase_units: [{}] } } }),
    );
    expect(event).toBeNull();
  });
});

describe("PayPalRail.captureApprovedOrder", () => {
  const rail = (over: Partial<Parameters<typeof mockFetch>[0]> = {}) =>
    new PayPalRail({ clientId: "id", clientSecret: "s", webhookId: "wh", fetchImpl: mockFetch(over) });

  it("POSTs the capture and reports the settlement from the CAPTURE's own facts", async () => {
    let seenOrder = "";
    let requestId: string | null = null;
    const r = rail({
      capture: (init, orderId) => {
        seenOrder = orderId;
        requestId = new Headers(init.headers).get("paypal-request-id");
        expect(init.method).toBe("POST");
        return jsonRes(CAPTURE_RESPONSE);
      },
    });
    const out = await r.captureApprovedOrder({ order_ref: "ORDER-1", tenant_ref: TEN });
    expect(seenOrder).toBe("ORDER-1");
    // DERIVED FROM THE ORDER, not random: a retried capture must be the same request to PayPal.
    expect(requestId).toBe("capture-ORDER-1");
    expect(out).toEqual({
      kind: "settled",
      settlement: {
        tenant_id: TEN,
        amount_micro_usd: USD(10),
        external_ref: "CAP-99",
        note: "paypal capture of order ORDER-1",
        order_ref: "ORDER-1",
      },
    });
  });

  it("reports already_captured rather than throwing on PayPal's 422", async () => {
    const r = rail({
      capture: () =>
        jsonRes({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] }, 422),
    });
    expect(await r.captureApprovedOrder({ order_ref: "ORDER-1", tenant_ref: TEN })).toEqual({
      kind: "already_captured",
    });
  });

  it("throws on a transient PayPal failure so the caller can let PayPal retry", async () => {
    const r = rail({ capture: () => jsonRes({ name: "INTERNAL_SERVER_ERROR" }, 500) });
    await expect(r.captureApprovedOrder({ order_ref: "ORDER-1", tenant_ref: TEN })).rejects.toThrow(
      /paypal_order_capture_failed:500/,
    );
  });

  it("refuses to attribute a capture whose custom_id disagrees with the order's", async () => {
    // Crediting the WRONG tenant is worse than not crediting: it is money taken from one account and
    // given to another, and no later reconciliation can tell it from a legitimate purchase.
    const r = rail({
      capture: () =>
        jsonRes({
          ...CAPTURE_RESPONSE,
          purchase_units: [
            {
              payments: {
                captures: [
                  {
                    id: "CAP-99",
                    status: "COMPLETED",
                    custom_id: "ten_someone_else",
                    amount: { currency_code: "USD", value: "10.00" },
                  },
                ],
              },
            },
          ],
        }),
    });
    await expect(r.captureApprovedOrder({ order_ref: "ORDER-1", tenant_ref: TEN })).rejects.toThrow(
      /paypal_capture_tenant_mismatch/,
    );
  });

  it("throws when the capture reported no completed capture at all", async () => {
    const r = rail({ capture: () => jsonRes({ id: "ORDER-1", status: "COMPLETED", purchase_units: [{}] }) });
    await expect(r.captureApprovedOrder({ order_ref: "ORDER-1", tenant_ref: TEN })).rejects.toThrow(
      /paypal_capture_missing_capture/,
    );
  });
});

describe("PayPal routes", () => {
  let store: MemoryStore;
  let db: DatabaseSync;
  let credits: D1Store;
  let deps: ControlPlaneDeps;
  let cookie: string;

  beforeEach(async () => {
    store = new MemoryStore();
    db = freshMigratedDb();
    credits = new D1Store(d1Over(db));
    const account = await store.createAccount("acct_1", "a@b.com");
    await store.createTenant(TEN, "hero", account.id, "live");
    await credits.createAccount("acct_1", "a@b.com");
    await credits.createTenant(TEN, "hero", "acct_1", "live");
    await credits.recordTopUpOrder({
      rail: "paypal",
      order_ref: "ORDER-1",
      tenant_id: TEN,
      amount_micro_usd: USD(10),
      created_at: "2026-08-16T00:00:00.000Z",
    });
    await store.recordAupAcceptance("acct_1", "1", "sha", null, null);
    const { token } = await startSession(store, account.id, Date.now());
    cookie = `${SESSION_COOKIE}=${token}`;
    deps = {
      store,
      mailer: { send: async () => {} },
      fetch: mockFetch({}),
      now: () => 1_750_000_000_000,
      credits,
    };
  });

  const topup = (body: unknown, e = env(PAYPAL), d = deps) =>
    handle(
      new Request(`${ORIGIN}/api/tenant/${TEN}/credits/topup`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { origin: ORIGIN, "content-type": "application/json", cookie },
      }),
      e,
      ctx,
      d,
    );

  const webhook = (body: unknown, e = env(PAYPAL), d = deps) =>
    handle(
      new Request(`${ORIGIN}/api/webhooks/paypal`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", ...TRANSMISSION },
      }),
      e,
      ctx,
      d,
    );

  it("POST /api/tenant/:id/credits/topup returns the PayPal approve URL", async () => {
    const res = await topup({ amount_micro_usd: USD(10) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      checkout_url: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1",
      external_ref: "ORDER-1",
      rail: "paypal",
    });
  });

  it("refuses a top-up below USD 10 and does not call PayPal orders", async () => {
    const order = vi.fn();
    const d = { ...deps, fetch: mockFetch({ order: () => (order(), jsonRes({})) }) };
    const res = await topup({ amount_micro_usd: USD(9) }, env(PAYPAL), d);
    expect(res.status).toBe(400);
    expect(order).not.toHaveBeenCalled();
  });

  it("503s not_configured when PayPal credentials are absent", async () => {
    const res = await topup({ amount_micro_usd: USD(10) }, env());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "not_configured" });
  });

  it("credits the tenant on a verified capture webhook", async () => {
    const res = await webhook(CAPTURE_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true });
    expect((await credits.readBalanceSums(TEN)).settled).toBe(USD(10));
  });

  it("returns 200 applied:false on a replayed capture", async () => {
    expect((await webhook(CAPTURE_BODY)).status).toBe(200);
    const again = await webhook(CAPTURE_BODY);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ applied: false });
    expect((await credits.readBalanceSums(TEN)).settled).toBe(USD(10));
  });

  it("captures the approved order and credits the tenant", async () => {
    // THE WHOLE FINDING IN ONE ASSERTION. Before this change the route answered 200 applied:false
    // here, the order was never captured, it expired, and the balance never moved.
    const captured: string[] = [];
    const d = {
      ...deps,
      fetch: mockFetch({
        capture: (_init, orderId) => {
          captured.push(orderId);
          return jsonRes(CAPTURE_RESPONSE);
        },
      }),
    };
    const res = await webhook(APPROVED_BODY, env(PAYPAL), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true });
    expect(captured).toEqual(["ORDER-1"]);
    expect((await credits.readBalanceSums(TEN)).settled).toBe(USD(10));
  });

  it("credits ONCE when the capture webhook arrives after the approval that captured it", async () => {
    // Both legs carry PayPal's own capture id, so the ledger's unique index is what makes crediting
    // from the capture RESPONSE and from the later webhook the same row rather than two purchases.
    expect((await webhook(APPROVED_BODY)).status).toBe(200);
    const late = await webhook(CAPTURE_BODY);
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({ applied: false });
    expect((await credits.readBalanceSums(TEN)).settled).toBe(USD(10));
  });

  it("503s on a failed capture so PayPal retries the approval, and credits nothing", async () => {
    const d = { ...deps, fetch: mockFetch({ capture: () => jsonRes({ name: "INTERNAL_SERVER_ERROR" }, 500) }) };
    const res = await webhook(APPROVED_BODY, env(PAYPAL), d);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "capture_failed" });
    expect((await credits.readBalanceSums(TEN)).settled).toBe(0);
  });

  it("answers 200 applied:false when PayPal says the order was already captured", async () => {
    // The CAPTURE.COMPLETED leg owns that money. Answering 503 would make PayPal retry an approval
    // that can never succeed, forever.
    const d = {
      ...deps,
      fetch: mockFetch({
        capture: () => jsonRes({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] }, 422),
      }),
    };
    const res = await webhook(APPROVED_BODY, env(PAYPAL), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: false });
    expect((await credits.readBalanceSums(TEN)).settled).toBe(0);
  });

  it("400s an unverified webhook and credits nothing", async () => {
    const d = { ...deps, fetch: mockFetch({ verify: () => jsonRes({ verification_status: "FAILURE" }) }) };
    const res = await webhook(CAPTURE_BODY, env(PAYPAL), d);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unverified" });
    expect((await credits.readBalanceSums(TEN)).settled).toBe(0);
  });

  // ---- fc#2052: credit only an order this plane created, for its recorded tenant and amount ----

  it("records the order at checkout, before the buyer is sent to pay", async () => {
    const d = {
      ...deps,
      fetch: mockFetch({
        order: () => jsonRes({ id: "ORDER-7", links: [{ rel: "approve", href: "https://pp.example/ORDER-7" }] }),
      }),
    };
    expect((await topup({ amount_micro_usd: USD(25) }, env(PAYPAL), d)).status).toBe(200);
    expect(await credits.getTopUpOrder("paypal", "ORDER-7")).toMatchObject({
      tenant_id: TEN,
      amount_micro_usd: USD(25),
    });
  });

  it("refuses the checkout when the order cannot be recorded", async () => {
    const d = { ...deps, credits: Object.assign(Object.create(credits), { recordTopUpOrder: async () => { throw new Error("d1 down"); } }) };
    const res = await topup({ amount_micro_usd: USD(10) }, env(PAYPAL), d);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "topup_failed" });
  });

  it("does not capture an approved order this plane never created", async () => {
    const captured: string[] = [];
    const d = { ...deps, fetch: mockFetch({ capture: (_i, id) => (captured.push(id), jsonRes(CAPTURE_RESPONSE)) }) };
    const body = { ...APPROVED_BODY, resource: { ...APPROVED_BODY.resource, id: "ORDER-ELSEWHERE" } };
    const res = await webhook(body, env(PAYPAL), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: false });
    expect(captured).toEqual([]);
    expect((await credits.readBalanceSums(TEN)).settled).toBe(0);
  });

  it("does not capture an approved order whose tenant differs from the recorded one", async () => {
    const captured: string[] = [];
    const d = { ...deps, fetch: mockFetch({ capture: (_i, id) => (captured.push(id), jsonRes(CAPTURE_RESPONSE)) }) };
    const body = {
      ...APPROVED_BODY,
      resource: { ...APPROVED_BODY.resource, purchase_units: [{ custom_id: "ten_other", amount: { currency_code: "USD", value: "10.00" } }] },
    };
    const res = await webhook(body, env(PAYPAL), d);
    expect(await res.json()).toEqual({ applied: false });
    expect(captured).toEqual([]);
  });

  it("does not credit a capture for an order this plane never created", async () => {
    const body = { ...CAPTURE_BODY, resource: { ...CAPTURE_BODY.resource, supplementary_data: { related_ids: { order_id: "ORDER-ELSEWHERE" } } } };
    const res = await webhook(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: false });
    expect((await credits.readBalanceSums(TEN)).settled).toBe(0);
  });

  it("does not credit a capture that names a different tenant than the recorded order", async () => {
    await credits.createTenant("ten_other", "other", "acct_1", "live");
    const body = { ...CAPTURE_BODY, resource: { ...CAPTURE_BODY.resource, custom_id: "ten_other" } };
    const res = await webhook(body);
    expect(await res.json()).toEqual({ applied: false });
    expect((await credits.readBalanceSums("ten_other")).settled).toBe(0);
    expect((await credits.readBalanceSums(TEN)).settled).toBe(0);
  });

  it("does not credit a capture whose amount differs from the recorded order", async () => {
    const body = { ...CAPTURE_BODY, resource: { ...CAPTURE_BODY.resource, amount: { currency_code: "USD", value: "500.00" } } };
    const res = await webhook(body);
    expect(await res.json()).toEqual({ applied: false });
    expect((await credits.readBalanceSums(TEN)).settled).toBe(0);
  });

  it("does not credit a capture that carries no order id", async () => {
    const { supplementary_data: _drop, ...resource } = CAPTURE_BODY.resource;
    const res = await webhook({ ...CAPTURE_BODY, resource });
    expect(await res.json()).toEqual({ applied: false });
    expect((await credits.readBalanceSums(TEN)).settled).toBe(0);
  });

  it("503s when the recorded order cannot be read, so PayPal retries", async () => {
    const d = { ...deps, credits: Object.assign(Object.create(credits), { getTopUpOrder: async () => { throw new Error("d1 down"); } }) };
    const res = await webhook(CAPTURE_BODY, env(PAYPAL), d);
    expect(res.status).toBe(503);
    expect((await credits.readBalanceSums(TEN)).settled).toBe(0);
  });

  it("applySettlement replay is namespaced on the paypal rail id", async () => {
    const event = {
      tenant_id: TEN,
      amount_micro_usd: USD(10),
      external_ref: "CAP-99",
      note: null,
    };
    const a = await applySettlement(credits, { railId: "paypal", event, rowId: "led_1", now: "2026-08-16T00:00:00.000Z" });
    const replay = await applySettlement(credits, { railId: "paypal", event, rowId: "led_2", now: "2026-08-16T00:00:00.000Z" });
    expect([a.applied, replay.applied]).toEqual([true, false]);
    expect((await credits.readBalanceSums(TEN)).settled).toBe(USD(10));
  });
});

describe("settlementMismatch (fc#2052)", () => {
  const order = { rail: "paypal", order_ref: "ORDER-1", tenant_id: TEN, amount_micro_usd: USD(10), created_at: "t" };
  const ok = { tenant_id: TEN, amount_micro_usd: USD(10), external_ref: "CAP-1", note: null, order_ref: "ORDER-1" };
  it("matches only when order id, tenant and amount all agree", () => {
    expect(settlementMismatch(ok, order)).toBeNull();
    expect(settlementMismatch({ ...ok, order_ref: undefined }, order)).toBe("no_order_ref");
    expect(settlementMismatch(ok, null)).toBe("unknown_order");
    expect(settlementMismatch({ ...ok, order_ref: "ORDER-2" }, order)).toBe("unknown_order");
    expect(settlementMismatch({ ...ok, tenant_id: "ten_other" }, order)).toBe("tenant_mismatch");
    expect(settlementMismatch({ ...ok, amount_micro_usd: USD(11) }, order)).toBe("amount_mismatch");
  });
});
