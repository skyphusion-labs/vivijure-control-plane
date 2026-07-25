# Managed compute: metering + prepaid credits (Lane B2 design)

Status: DESIGN, ruled by Conrad 2026-07-25 (vivijure-cf#224 comments). Build lands when it fits;
this document plus the schema draft is the sprint deliverable.

## The model (the Cloudflare AI Gateway pattern)

Two honest modes for hosted GPU compute, tenant's choice, markup stated up front:

| Mode | Whose RunPod account | Who bills the tenant | Cost to tenant |
|---|---|---|---|
| `byok` (default, current architecture) | Theirs; endpoints created ON their account with THEIR key at provision | RunPod, directly | RunPod list price |
| `managed` | Ours; jobs run on our prod endpoints via the dispatch proxy | Us, one bill, prepaid credits | RunPod-derived rate + a published markup |

This is exactly Cloudflare's Unified Billing posture: BYOK and pay the vendor directly (cheaper),
or pay us for the convenience of one bill and prepaid credits, with the fee stated plainly.
Cloudflare itself requires prepay for frontier-model access through AI Gateway below Enterprise;
we take the same stance.

## Non-negotiables (from the ruling; do not weaken in implementation)

1. **Our prod RunPod key NEVER lands in a tenant studio.** An account-wide key is account-wide
   blast radius. Managed tenants reach our endpoints ONLY server-side, through the control-plane
   dispatch proxy. The key stays a control-plane secret.
2. **Prepaid credits only. No postpaid path in v1.** Managed spend is always backed by an existing
   credit balance. The per-tenant cap IS the remaining balance; at zero the studio gets an honest
   `quota_exceeded`, never a silent queue or a surprise invoice.
3. **The meter is rate-independent.** Usage rows record what happened (execution time, endpoint
   class); money is computed at debit time from the rate card. The markup can change without
   touching the meter, and historical usage stays reinterpretable.
4. **Honest and up front.** The markup is published on the pricing surface. No hidden margin.

## Architecture

```
tenant studio (managed mode)
  -> POST control-plane /api/dispatch/{endpoint-class}     auth: studio token (existing)
       1. resolve tenant, assert compute_mode = 'managed'
       2. balance check: available_credit > 0 else 402 quota_exceeded
       3. submit to OUR RunPod endpoint (key from control-plane secret, server-side)
       4. record usage_events row (job accepted)
  <- job id; studio polls the same proxy for status
       5. on terminal status: capture executionTime + endpoint class,
          price from rate_card, append credit_ledger debit
```

- The proxy IS the meter. There is no path to our endpoints that bypasses it, so metering is
  complete by construction.
- `byok` tenants never touch the proxy; their studios keep the existing direct-to-their-endpoints
  wiring. `runpod_key_required` (409) applies to byok provisioning only.
- Provisioner: `managed` tenants SKIP tenant-account endpoint creation entirely; the studio is
  provisioned with the dispatch route instead of endpoint ids.
- Mode is switchable later (a managed tenant bringing their own key migrates to byok by running
  the normal endpoint-provision leg; a byok tenant going managed just needs the route + credits).

## Pricing shape

- Unit: RunPod `executionTime` (ms) per job, per endpoint class (render / upscale / musetalk /
  audio-upscale / wan-train). This is the number RunPod bills US on, so cost capture is exact.
- `rate_card` maps endpoint class -> credit price per second, versioned with effective dates.
  Rates derive from RunPod list price for the underlying GPU class plus the published markup.
- Credits are prepaid in fixed packs; purchase mechanics (payment processor) are OUT of this
  design's scope and gated behind Conrad's signups lever. The ledger is processor-agnostic: a
  purchase is just a credit row with an external reference.

## Schema draft (D1, next migration)

```sql
-- tenants gains the mode; existing rows are all byok
ALTER TABLE tenants ADD COLUMN compute_mode TEXT NOT NULL DEFAULT 'byok'
  CHECK (compute_mode IN ('byok', 'managed'));

CREATE TABLE usage_events (
  id            TEXT PRIMARY KEY,          -- ulid
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  job_id        TEXT NOT NULL,             -- RunPod job id
  endpoint_class TEXT NOT NULL,            -- render|upscale|musetalk|audio_upscale|wan_train
  submitted_at  TEXT NOT NULL,             -- ISO
  terminal_at   TEXT,                      -- ISO, null until terminal
  terminal_status TEXT,                    -- COMPLETED|FAILED|CANCELLED|TIMED_OUT
  execution_ms  INTEGER,                   -- RunPod executionTime, null until terminal
  UNIQUE (tenant_id, job_id)
);

CREATE TABLE credit_ledger (
  id            TEXT PRIMARY KEY,          -- ulid
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  delta_credits INTEGER NOT NULL,          -- +purchase / -debit, integer credits (no floats)
  kind          TEXT NOT NULL CHECK (kind IN ('purchase','debit','adjustment')),
  usage_event_id TEXT REFERENCES usage_events(id),  -- set on debits
  rate_card_id  TEXT,                      -- rate used, set on debits
  external_ref  TEXT,                      -- processor reference, set on purchases
  created_at    TEXT NOT NULL
);

CREATE TABLE rate_card (
  id            TEXT PRIMARY KEY,
  endpoint_class TEXT NOT NULL,
  credits_per_second INTEGER NOT NULL,
  effective_from TEXT NOT NULL,            -- ISO; newest effective_from <= now wins
  note          TEXT                       -- e.g. "RunPod A100 list + published markup"
);
```

Balance = `SUM(delta_credits)` over the tenant's ledger; enforce non-negative at debit time
inside a single D1 batch (usage terminal update + debit append) so a crash cannot double-debit.
Failed/cancelled jobs with `execution_ms` still debit (RunPod billed us); zero-execution
failures debit nothing.

## Failure honesty

- Balance exhausted mid-job: the job finishes (we already owe RunPod), the debit takes the
  balance negative, and further submissions 402 until topped up. Negative balances are visible,
  not hidden; that bounded overshoot (one in-flight job per class) is the accepted cost of not
  killing paid work.
- Proxy down: managed studios degrade with the same honest-hooks pattern as every other
  unavailable capability (`host.hooks_unavailable`), never a mock.
- Meter write failure AFTER RunPod accept: the job proceeds; reconciliation sweeps RunPod job
  history against usage_events (the UNIQUE key makes the sweep idempotent). We eat the cost of
  a metering gap rather than double-charge on retry ambiguity.

## Out of scope (v1)

Payment processor integration; per-class spend caps beyond the balance itself; usage dashboards
(admin can query D1); byok<->managed self-serve switching UI (admin-assisted at first).
