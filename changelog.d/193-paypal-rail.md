### feat(credits): PayPal payment rail behind the PaymentRail seam (cp#193)

- `PayPalRail` implements `PaymentRail`: Orders API v2 (intent CAPTURE) for checkout, webhook
  verification via `/v1/notifications/verify-webhook-signature`, settlement only on
  `PAYMENT.CAPTURE.COMPLETED`. Stripe is not the rail. No credential is in the repo.
- New `POST /api/tenant/:id/credits/topup` (owner session, USD 10 floor) returns
  `{ checkout_url, external_ref, rail: "paypal" }`. New `POST /api/webhooks/paypal`: 400 if
  unverified, 200 `{ applied: false }` on replay.
- `topUpAvailable` is true only when client id, secret, and webhook id are all set.
  `creditsApplyToTenant` is unchanged (still false until `compute_mode`). `CREDITS_ENFORCING`
  is not flipped.
- Env: `PAYPAL_CLIENT_ID`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENV` are vars (empty = rail absent /
  sandbox). `PAYPAL_CLIENT_SECRET` is a wrangler secret. `ManualRail` stays for operator credits.
