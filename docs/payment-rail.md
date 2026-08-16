# The payment rail: what the crew built, and what Conrad must provision himself

Tracking issue: `vivijure-control-plane#193`, under `cp#173` (prepaid credits).

**Nothing in this repository contains a payment credential.** The ledger talks to PayPal through
`PaymentRail`; `ManualRail` still needs no processor. The list in Part 2 is the work only the
account owner can do, written to be executed without reading any code.

## Part 1: what exists now

| Piece | Where | State |
| --- | --- | --- |
| `PaymentRail` interface | `src/payment-rail.ts` | built |
| `ManualRail` (operator-credited top-ups) | `src/payment-rail.ts` | built, usable |
| `applySettlement` (the only path that creates credit) | `src/payment-rail.ts` | built |
| `POST /api/admin/tenants/:id/credits/manual` | `src/index.ts` | built, admin-gated |
| `PayPalRail` | `src/paypal-rail.ts` | built; live only after Part 2 credentials exist |
| `POST /api/tenant/:id/credits/topup` | `src/index.ts` | built, owner session |
| `POST /api/webhooks/paypal` | `src/index.ts` | built; 400 if unverified, 200 on replay |

`ManualRail` is a real rail, not a placeholder. Comping an account, correcting an incident, and
honouring a refund are permanent operator needs that outlive any processor. It is also what lets the
whole system be exercised end to end (purchase, hold, capture, balance, refusal) with no payment
integration at all.

### The operator credit path, and its limits stated plainly

`POST /api/admin/tenants/<tenant-id>/credits/manual`, admin bearer, body:

```json
{
  "amount_micro_usd": 10000000,
  "operator": "conrad",
  "reason": "comped after the 2026-07-27 render incident",
  "reference": "incident-2026-07-27-conrad-1"
}
```

- `amount_micro_usd` is **integer micro-USD** (1e-6 USD). USD 10.00 is `10000000`. There are no
  decimals anywhere in the ledger.
- `reference` is **yours and must be unique per credit**. It is the idempotency anchor: retrying with
  the same reference credits once, no matter how many times it is sent. Retrying with a NEW reference
  credits again, which is what you want when you genuinely mean to issue a second credit.
- `operator` is **asserted, not authenticated.** This plane has one shared admin token, so the system
  can prove that somebody holding the operator credential acted, and can never prove which human. The
  name is recorded and labelled as a claim. Real per-operator identity needs the admin console
  (`cp#89`). This limitation is written into the audit record rather than hidden.
- Both `operator` and `reason` are required; a credit with no stated reason is refused.
- A single credit above **USD 100** is refused, naming `MANUAL_CREDIT_CEILING_MICRO_USD`. That
  ceiling is a typo catcher, not a policy: it exists so a stray keystroke cannot turn USD 10.00 into
  USD 10,000.00 on the one surface that mints money from nothing. Raising it is a deliberate config
  change.
- Every attempt is written to `admin_audit`, **including replays**, because a burst of retries is
  either a broken client or somebody probing and an audit that records only first attempts shows
  neither.

## Part 2: what Conrad must provision, in order

The rail in this repo is **PayPal Business**, not Stripe. Stripe is not the processor. Nothing on
this list can or should be done on his behalf. Each item says what to create, what it is called,
where it goes, and how to know it worked.

`ManualRail` stays. Operator credits do not go through PayPal.

### 1. The PayPal Business account

You already have this. Confirm it is the **business identity that should appear on customer
statements and receipts**. That is the name a tenant sees and the name on every receipt.

### 2. An app in developer.paypal.com

Create a REST app under that Business account.

1. Start in **sandbox**. Create (or use) a sandbox app and take its **client id** and **secret**.
2. Live later: a live app under the same account, a second client id+secret, and `PAYPAL_ENV=live`.
   Do not point sandbox credentials at live, or live credentials at sandbox.

*Verify:* the app exists in the PayPal Developer Dashboard and shows a client id.

### 3. Tax configuration: RULED, and NOT a blocker

**Conrad, 2026-07-27: "As a reseller here in Texas we do not have to charge sales tax."** His
domain, his prior experience in this state, and it closes what this document previously listed as a
launch-blocking step.

The scope is stated deliberately rather than generalised to "no tax applies": **Texas, as a
reseller.** Writing the scope down is what makes this re-checkable if the business situation
changes, and a scoped ruling is worth more later than a confident unscoped one.

**PARKED, not a blocker:** purchasers outside the US can carry different obligations (VAT and
similar). That is a future-jurisdiction question, it does not gate the purchase door opening, and it
is recorded on `cp#193` rather than solved here.

### 4. The USD 10 floor, not a product catalog

The **USD 10 minimum top-up is ruled**. The tenant posts `amount_micro_usd`; the rail creates a
PayPal order for that amount. There is no Stripe-style price object to pre-create. The rest of the
ladder (whether the UI offers USD 25 or USD 50) is yours to set on the surface; the rail will accept
any whole-cent amount at or above USD 10.

### 5. Credentials, and how they must travel

| Name | Kind | What it is |
| --- | --- | --- |
| `PAYPAL_CLIENT_ID` | wrangler **var** (or GitHub Actions repo var) | sandbox client id now; live client id when you flip |
| `PAYPAL_CLIENT_SECRET` | wrangler **secret** | the matching secret. **chmod 600 file, then `wrangler secret put`. Never chat, never a tracked file.** |
| `PAYPAL_WEBHOOK_ID` | wrangler **var** (or secret, if you prefer it out of the render) | the webhook endpoint id PayPal assigns in step 6 |
| `PAYPAL_ENV` | wrangler **var** | empty or `sandbox` now; `live` only when the live app is wired |

**How the secret travels, and this is not a style preference.** Copy the client secret from the
PayPal dashboard into a `chmod 600` file on your laptop (not this repository, not a chat, not an
issue). Then:

```
npx wrangler secret put PAYPAL_CLIENT_SECRET < that-file
```

(or paste from the file in your own shell). The value is never readable back. `wrangler secret list`
shows the name only.

`PAYPAL_CLIENT_ID`, `PAYPAL_WEBHOOK_ID`, and `PAYPAL_ENV` can be repository variables / wrangler
vars. They are identifiers, not the secret. Empty means the rail is not offered.

*Verify:* `wrangler secret list` shows `PAYPAL_CLIENT_SECRET`. The three vars are set on the Worker
(or empty, if you have not provisioned yet).

### 6. The webhook endpoint

URL, once this plane is deployed:

```
https://<CONTROL_PLANE_HOST>/api/webhooks/paypal
```

Register that URL on the same REST app. Subscribe it to **`PAYMENT.CAPTURE.COMPLETED`** (money has
arrived; do not settle on `CHECKOUT.ORDER.APPROVED`). Copy the webhook **id** into
`PAYPAL_WEBHOOK_ID`.

*Verify:* PayPal's dashboard shows a successful delivery, and the tenant's balance moves by the
expected amount exactly once. A replay of the same capture is `200` with `applied: false`.

### 7. A decision only you can make: refunds, expiry, and account closure

Unaffected by the tax ruling above; these are consumer-protection surface rather than preferences:

1. Are unused credits refundable, and on what terms?
2. Do credits expire? (If yes, this interacts with consumer law in several jurisdictions.)
3. What happens to a remaining balance when an account is closed?

**This belongs in Ernst's lane before the purchase door opens, not after.** The answers become
customer-facing terms, and the ledger will need to implement whatever is decided (expiry in
particular would need a mechanism that does not exist today).

### Related open question, already recorded

A lapsed prepaid tenant at zero credits **still has stored bytes, and stored bytes keep billing us
every month** whether or not they return. Fail-closed stops new submissions and does nothing about
storage already in R2. That is a retention-policy question inseparable from what we promise a tenant
happens to their films, recorded on `cp#195` and awaiting Conrad. It is listed here because it and
item 7 are the same conversation.

## Part 3: what remains after the rail exists

The `PayPalRail` is built. Settlements go through the existing `applySettlement`, idempotent on
PayPal's capture id, namespaced `paypal:`. `ManualRail` is unchanged.

**Do not flip `CREDITS_ENFORCING` in the same act as wiring credentials.** A purchase door in front
of a counting ledger sells credits that refuse nothing; flipping enforcement is a named acceptance
criterion of `cp#193` and happens when you decide the door is proven, not when the class lands.

`credits_apply` stays false for every tenant until `compute_mode` exists. Configuring PayPal does
not invent a billing relationship for a BYOK studio.
