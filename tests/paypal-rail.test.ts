// PayPalRail (cp#193). Fetch is mocked; no live PayPal call, no credential.

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE, startSession } from "../src/auth";
import { MICRO_PER_USD } from "../src/credits";
import { topUpAvailable } from "../src/credits-api";
import type { ControlPlaneDeps } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import { handle } from "../src/index";
import { PaymentRailError, applySettlement } from "../src/payment-rail";
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
  },
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
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
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
      tenant_id: TEN,
      amount_micro_usd: USD(10),
      external_ref: "CAP-99",
      note: "paypal PAYMENT.CAPTURE.COMPLETED",
    });
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
    const event = await rail.parseSettlement(captureReq({ body: { event_type: "CHECKOUT.ORDER.APPROVED", resource: {} } }));
    expect(event).toBeNull();
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

  it("400s an unverified webhook and credits nothing", async () => {
    const d = { ...deps, fetch: mockFetch({ verify: () => jsonRes({ verification_status: "FAILURE" }) }) };
    const res = await webhook(CAPTURE_BODY, env(PAYPAL), d);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unverified" });
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
