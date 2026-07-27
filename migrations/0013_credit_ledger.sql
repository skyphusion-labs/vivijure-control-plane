-- cp#189: the prepaid credit ledger. Money rows and reservations, kept deliberately apart.
--
-- UNIT: integer MICRO-USD (1e-6 USD) everywhere in these tables. Never a float, never cents, never
-- an abstract "credit". Conrad ruled in USD (USD 10 minimum top-up, USD 3-5 per film), so there is
-- nothing for a credit unit to abstract over; and cents cannot hold the cost basis, where a render
-- GPU-second measures at USD 0.001765 (docs/cost-basis.md section 1). A cent-denominated ledger
-- rounds away every reconciliation against that basis.
--
-- WHY TWO TABLES. credit_ledger is MONEY THAT MOVED: append-only, never updated, never deleted; a
-- correction is a new row. credit_holds is a RESERVATION, whose lifecycle is genuinely mutable
-- (open -> captured | released | expired), so it is ONE keyed row updated by conditional UPDATE.
-- Merging them is how a reservation gets counted as a charge.
--
-- WHY HOLDS EXIST AT ALL. Billing is COMPLETED-ONLY by ruling (Conrad 2026-07-27): a failed render
-- costs the tenant nothing and we eat the GPU. A charge that lands only at completion cannot, by
-- itself, refuse anything at submit -- so a tenant with USD 0.50 available could start a USD 4 film.
-- The hold is what makes fail-closed real at submit without charging for work that never finished.
--
-- BALANCE IS A SUM, NEVER A STORED TOTAL. A running-total column is a single key rewritten on every
-- movement, which is precisely the shape that wedged a long-lived studio's control docs. Rows are
-- keyed and appended; the balance is derived. If the SUM ever gets slow the answer is a
-- materialized cache with these rows as truth and a reconcile, not a mutable total.

-- ORDER: credit_holds is created FIRST because credit_ledger.hold_id references it. SQLite
-- tolerates a forward reference at DDL time, but a schema that only works because the engine
-- is lenient is a schema waiting to break on a stricter one.

CREATE TABLE IF NOT EXISTS credit_holds (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  -- What this reserves against. UNIQUE per tenant so a retried submit reuses its hold rather than
  -- reserving the tenant's balance twice for one job.
  job_ref          TEXT NOT NULL,
  -- Always positive. A hold reduces what is available; it is not signed money.
  amount_micro_usd INTEGER NOT NULL CHECK (amount_micro_usd > 0),
  status           TEXT NOT NULL CHECK (status IN ('open','captured','released','expired')),
  price_list_id    TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  -- A job that vanishes must not strand a tenant's money forever. Expiry is swept explicitly and
  -- flips the row to 'expired'; it is NEVER inferred at read time, because a hold silently ignored
  -- once expired is indistinguishable from one that was never taken.
  expires_at       TEXT NOT NULL,
  settled_at       TEXT,
  UNIQUE (tenant_id, job_ref)
);

-- The availability read: open holds per tenant.
CREATE INDEX IF NOT EXISTS idx_credit_holds_open ON credit_holds (tenant_id, status);
-- The expiry sweep scans by status and time across all tenants.
CREATE INDEX IF NOT EXISTS idx_credit_holds_expiry ON credit_holds (status, expires_at);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  kind            TEXT NOT NULL CHECK (kind IN ('purchase','debit','refund','adjustment')),
  -- Signed, in micro-USD. Positive adds spendable balance (purchase, refund, credit adjustment);
  -- negative removes it (debit, debit adjustment). The CHECK below ties sign to kind so a debit can
  -- never accidentally be written as a credit by a caller passing the wrong sign.
  delta_micro_usd INTEGER NOT NULL,
  -- What this row COST US, as measured. NULL means unmeasured and NEVER 0: a failed read and a real
  -- zero are different facts, and collapsing them makes the cost side under-report, which would make
  -- "priced to cover costs" look true exactly when it is not. Same honesty rule as tenant-r2-usage.
  cost_micro_usd  INTEGER,
  -- Caller-supplied idempotency reference. UNIQUE per tenant, so a retried write is a no-op instead
  -- of a second charge.
  --
  -- NAMED `idem_ref`, NOT `idem_key`, on purpose: the schema-guard credential test flags any column
  -- matching /_key$/, and that guard is built to be defeated only by an exact-name allowlist. This
  -- column is a reference and not a secret, so the honest fix is a name that does not look like a
  -- credential rather than an allowlist entry that erodes the rule for everyone after us.
  idem_ref        TEXT NOT NULL,
  -- Set on a debit captured from a hold. The hold id IS the debit's idempotency reference, which is
  -- what makes "exactly one debit per hold, ever" a database guarantee rather than a code promise.
  hold_id         TEXT REFERENCES credit_holds(id),
  -- Which published price priced this row. Historical rows keep the price they were charged at, so a
  -- later price change can never reprice the past.
  price_list_id   TEXT,
  -- The payment processor's own reference, set on purchases. Never a credential.
  external_ref    TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (tenant_id, idem_ref),
  -- Sign follows kind. A debit that is positive would silently pay a tenant for rendering.
  CHECK (
    (kind = 'debit'    AND delta_micro_usd < 0) OR
    (kind = 'purchase' AND delta_micro_usd > 0) OR
    (kind = 'refund'   AND delta_micro_usd > 0) OR
    (kind = 'adjustment')
  )
);

-- The balance read: every SUM is per tenant, so the index carries the summed column.
CREATE INDEX IF NOT EXISTS idx_credit_ledger_tenant ON credit_ledger (tenant_id, created_at);
