# The payment rail: what the crew built, and what Conrad must provision himself

Tracking issue: `vivijure-control-plane#193`, under `cp#173` (prepaid credits).

**Nothing in this repository contains a payment credential, and no payment account has been created
by the crew.** The ledger was built against an interface with one rail that needs no processor, so
the entire credit path is provable today. The list in Part 2 is the work only the account owner can
do, written to be executed without reading any code.

## Part 1: what exists now

| Piece | Where | State |
| --- | --- | --- |
| `PaymentRail` interface | `src/payment-rail.ts` | built |
| `ManualRail` (operator-credited top-ups) | `src/payment-rail.ts` | built, usable |
| `applySettlement` (the only path that creates credit) | `src/payment-rail.ts` | built |
| `POST /api/admin/tenants/:id/credits/manual` | `src/index.ts` | built, admin-gated |
| A Stripe rail | nowhere | **not built, blocked on Part 2** |

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

Nothing on this list can or should be done on his behalf. Each item says what to create, what it is
called, where it goes, and how to know it worked.

### 1. The Stripe account

Create it in **the business identity that should appear on customer statements and receipts**. This
is the name a tenant sees on their card statement and the name on every receipt; changing it later is
a support burden, so it is worth a minute now.

### 2. Business verification and a payout bank account

Stripe holds funds until this clears. **Do this before launch, not at first payout.** A launch that
discovers an unverified account is a launch that stops with customer money already taken.

*Verify:* the Stripe dashboard shows payouts enabled, with no outstanding verification requests.

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

### 4. Products and prices for the top-up packs

The **USD 10 minimum top-up is ruled**. The rest of the ladder (whether there is a USD 25 or USD 50
pack, and what they cost) is not, and is yours to set.

*Verify:* each price object exists and its amount matches what the pricing surface will claim.

### 5. Two secrets, and how they must travel

| Secret | What it is | Scope it to |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | a **restricted** API key | creating checkout sessions and reading payments ONLY. Not account management, not payouts, not team. |
| `STRIPE_WEBHOOK_SECRET` | the signing secret for the webhook endpoint | that endpoint alone |

**How they travel, and this is not a style preference.** Both go straight from the Stripe dashboard
into `wrangler secret put <NAME>` in your own shell. Neither is ever pasted into a file in this
repository, an issue, a pull request, a chat message, or a runbook. There is no configuration in this
design that reads a payment credential from a tracked file, and adding one would be a defect.

*Verify:* `wrangler secret list` shows both names. It shows names only, which is the point: the value
is never readable back, from anywhere, including by us.

### 6. The webhook endpoint

We give you the URL once the Stripe rail route exists (it does not yet). You register it in Stripe,
subscribe it to the payment-success event, and paste the resulting signing secret per item 5.

*Verify:* Stripe's dashboard shows a successful test delivery, and the tenant's balance moves by the
expected amount exactly once.

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

## Part 3: what the crew does once Part 2 exists

1. Build a `StripeRail` implementing `PaymentRail` (checkout session out, verified webhook in).
2. Route the verified webhook through the existing `applySettlement`, so purchases stay idempotent on
   Stripe's own event id with no new money path.
3. **Flip credit enforcement on** (`CREDITS_ENFORCING`). This is a named acceptance criterion of
   `cp#193`: a purchase door that opens while the ledger is still in counting mode means tenants can
   buy credits that refuse nothing. The two flip together, and `cp#193` does not close while the
   plane is still counting.
