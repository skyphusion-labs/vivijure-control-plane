// PayPal payment rail (cp#193).
//
// Implements PaymentRail against PayPal Orders API v2 (intent CAPTURE) and the webhook verify
// endpoint. Stripe is not the rail. No credential is hardcoded; missing client id+secret is
// `not_configured`. Token cache is isolate-local so a Worker does not re-auth on every checkout.

import type { MicroUsd } from "./credits";
import { MICRO_PER_USD } from "./credits";
import {
  MIN_TENANT_TOPUP_MICRO_USD,
  PaymentRailError,
  type PaymentRail,
  type SettlementEvent,
  type TopUpIntent,
} from "./payment-rail";

const SANDBOX_API = "https://api-m.sandbox.paypal.com";
const LIVE_API = "https://api-m.paypal.com";

/** Whole cents in micro-USD. PayPal amounts are 2-decimal USD strings; leftover micros cannot be sent. */
const MICRO_PER_CENT = 10_000;

const CAPTURE_COMPLETED = "PAYMENT.CAPTURE.COMPLETED";

export type PayPalRailConfig = {
  clientId: string;
  clientSecret: string;
  webhookId: string;
  /** `live` -> api-m.paypal.com; anything else, including unset, is sandbox. */
  paypalEnv?: string;
  fetchImpl?: typeof fetch;
};

type CachedToken = { token: string; expiresAtMs: number; clientId: string };

let cachedToken: CachedToken | null = null;

/** Test hook: the isolate cache would otherwise leak a mock token across cases. */
export function resetPayPalTokenCache(): void {
  cachedToken = null;
}

export function paypalApiBase(paypalEnv?: string): string {
  return paypalEnv?.trim() === "live" ? LIVE_API : SANDBOX_API;
}

export function paypalCredentialsPresent(env: {
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
}): boolean {
  return Boolean(env.PAYPAL_CLIENT_ID?.trim() && env.PAYPAL_CLIENT_SECRET?.trim());
}

export function paypalDoorConfigured(env: {
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
}): boolean {
  return paypalCredentialsPresent(env) && Boolean(env.PAYPAL_WEBHOOK_ID?.trim());
}

/** Integer micro-USD -> PayPal `value` string (`"10.00"`). Rejects leftover micros that are not whole cents. */
export function microUsdToPayPalValue(micro: MicroUsd): string {
  if (!Number.isSafeInteger(micro) || micro <= 0 || micro % MICRO_PER_CENT !== 0) {
    throw new PaymentRailError(
      "invalid_amount",
      "amount_micro_usd must be a positive whole number of cents (1e-2 USD) in micro-USD",
    );
  }
  const dollars = Math.trunc(micro / MICRO_PER_USD);
  const cents = Math.trunc((micro % MICRO_PER_USD) / MICRO_PER_CENT);
  return `${dollars}.${String(cents).padStart(2, "0")}`;
}

/** PayPal `value` (`"10.00"`) -> micro-USD. Null when the string is not a 2-decimal USD amount. */
export function paypalValueToMicroUsd(value: string): MicroUsd | null {
  const m = /^([0-9]+)\.([0-9]{2})$/.exec(value);
  if (!m) return null;
  const dollars = Number(m[1]);
  const cents = Number(m[2]);
  const micro = dollars * MICRO_PER_USD + cents * MICRO_PER_CENT;
  return Number.isSafeInteger(micro) ? micro : null;
}

export class PayPalRail implements PaymentRail {
  readonly id = "paypal";

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly webhookId: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: PayPalRailConfig) {
    this.clientId = cfg.clientId.trim();
    this.clientSecret = cfg.clientSecret.trim();
    this.webhookId = cfg.webhookId.trim();
    this.base = paypalApiBase(cfg.paypalEnv);
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async createTopUp(args: { tenantId: string; amountMicroUsd: MicroUsd }): Promise<TopUpIntent> {
    if (!this.clientId || !this.clientSecret) {
      throw new PaymentRailError("not_configured", "PayPal client id and secret are not set");
    }
    if (!Number.isSafeInteger(args.amountMicroUsd) || args.amountMicroUsd < MIN_TENANT_TOPUP_MICRO_USD) {
      throw new PaymentRailError(
        "invalid_amount",
        `amount_micro_usd must be at least ${MIN_TENANT_TOPUP_MICRO_USD} (USD 10)`,
      );
    }
    const value = microUsdToPayPalValue(args.amountMicroUsd);
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${this.base}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "paypal-request-id": requestId(),
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: { currency_code: "USD", value },
            custom_id: args.tenantId,
          },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`paypal_order_create_failed:${res.status}`);
    }
    const body = (await res.json()) as {
      id?: unknown;
      links?: Array<{ rel?: unknown; href?: unknown }>;
    };
    const orderId = typeof body.id === "string" ? body.id : "";
    const approve = (body.links ?? []).find((l) => l.rel === "approve" && typeof l.href === "string");
    if (!orderId || !approve || typeof approve.href !== "string") {
      throw new Error("paypal_order_missing_approve_link");
    }
    return { checkout_url: approve.href, external_ref: orderId };
  }

  async parseSettlement(request: Request): Promise<SettlementEvent | null> {
    if (!this.clientId || !this.clientSecret || !this.webhookId) {
      throw new PaymentRailError("not_configured", "PayPal webhook verification is not configured");
    }

    const raw = await request.text();
    const transmission = {
      auth_algo: request.headers.get("paypal-auth-algo") ?? "",
      cert_url: request.headers.get("paypal-cert-url") ?? "",
      transmission_id: request.headers.get("paypal-transmission-id") ?? "",
      transmission_sig: request.headers.get("paypal-transmission-sig") ?? "",
      transmission_time: request.headers.get("paypal-transmission-time") ?? "",
    };
    if (Object.values(transmission).some((v) => !v)) {
      throw new PaymentRailError("unverified", "missing PayPal transmission headers");
    }

    let webhookEvent: unknown;
    try {
      webhookEvent = JSON.parse(raw);
    } catch {
      throw new PaymentRailError("unverified", "webhook body is not JSON");
    }

    const token = await this.accessToken();
    const verify = await this.fetchImpl(`${this.base}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "paypal-request-id": requestId(),
      },
      body: JSON.stringify({
        ...transmission,
        webhook_id: this.webhookId,
        webhook_event: webhookEvent,
      }),
    });
    if (!verify.ok) {
      throw new PaymentRailError("unverified", `paypal verify returned ${verify.status}`);
    }
    const verdict = (await verify.json()) as { verification_status?: unknown };
    if (verdict.verification_status !== "SUCCESS") {
      throw new PaymentRailError("unverified", "paypal webhook signature was not SUCCESS");
    }

    return settlementFromVerifiedEvent(webhookEvent);
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (
      cachedToken &&
      cachedToken.clientId === this.clientId &&
      cachedToken.expiresAtMs > now + 30_000
    ) {
      return cachedToken.token;
    }
    const basic = btoa(`${this.clientId}:${this.clientSecret}`);
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        "paypal-request-id": requestId(),
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      throw new Error(`paypal_oauth_failed:${res.status}`);
    }
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new Error("paypal_oauth_missing_token");
    }
    const expiresInSec = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 300;
    cachedToken = {
      token: body.access_token,
      expiresAtMs: now + expiresInSec * 1000,
      clientId: this.clientId,
    };
    return cachedToken.token;
  }
}

function requestId(): string {
  return crypto.randomUUID();
}

function settlementFromVerifiedEvent(event: unknown): SettlementEvent | null {
  if (!event || typeof event !== "object") return null;
  const rec = event as Record<string, unknown>;
  if (rec.event_type !== CAPTURE_COMPLETED) return null;

  const resource = rec.resource;
  if (!resource || typeof resource !== "object") return null;
  const cap = resource as Record<string, unknown>;

  const tenantId = typeof cap.custom_id === "string" ? cap.custom_id.trim() : "";
  if (!tenantId) return null;

  const amountObj = cap.amount && typeof cap.amount === "object" ? (cap.amount as Record<string, unknown>) : null;
  if (!amountObj || amountObj.currency_code !== "USD" || typeof amountObj.value !== "string") return null;
  const amount = paypalValueToMicroUsd(amountObj.value);
  if (amount === null || amount <= 0) return null;

  const captureId = typeof cap.id === "string" ? cap.id : "";
  const orderId = orderIdFromCapture(cap);
  const externalRef = captureId || orderId;
  if (!externalRef) return null;

  return {
    tenant_id: tenantId,
    amount_micro_usd: amount,
    external_ref: externalRef,
    note: "paypal PAYMENT.CAPTURE.COMPLETED",
  };
}

function orderIdFromCapture(cap: Record<string, unknown>): string {
  const supp = cap.supplementary_data;
  if (!supp || typeof supp !== "object") return "";
  const related = (supp as Record<string, unknown>).related_ids;
  if (!related || typeof related !== "object") return "";
  const orderId = (related as Record<string, unknown>).order_id;
  return typeof orderId === "string" ? orderId : "";
}
