-- cp#185: the per-tenant LLM spend roll-up. Usage rows, a completeness record, and the watermark.
--
-- WHY A ROLL-UP AND NOT A LIVE QUERY (ruled by mackaye, 2026-07-27). Three reasons, by weight:
--   1. Fail-closed at zero needs a STORED balance. If the credit ledger computed a balance live off
--      the AI Gateway logs API, a gateway outage or a slow query becomes either a false deny or,
--      worse, a fail-open. A stored row makes the deny a local read.
--   2. Gateway log retention is FINITE, and COUNT-based rather than time-based: 10,000,000 rows,
--      DELETE_OLDEST, no time window at all. A live aggregate therefore silently CHANGES ITS ANSWER
--      once the oldest requests age out. A stored row is permanent.
--   3. Idempotency is achievable here and is not achievable in the pull model: a watermark plus the
--      natural key below means a re-run double-charges nobody.
--
-- UNIT: integer MICRO-USD (1e-6 USD), matching credit_ledger exactly. Never a float in a money
-- column. Cloudflare reports cost as a float, so the conversion happens ONCE, here, at ingest:
-- round(cost * 1000000). Doing it at read time would put a rounding rule at every call site and let
-- two readers disagree about the same row.
--
-- WHY THE ATTRIBUTION KEY IS WHAT IT IS. The gateway records authentication as a BOOLEAN: it logs
-- THAT a request was authenticated, never WHICH token did it. So the per-tenant token is an access
-- and revocation boundary carrying ZERO attribution. cf-aig-metadata, emitted by the plan-enhance
-- module and copied into the log verbatim, is the entire attribution mechanism. tenant_id below is
-- read from that metadata ON THE ROW, never inferred from the fact that a filter returned the row.

-- ---------------------------------------------------------------------------------------------
-- The completeness record. Created FIRST: llm_spend_events references it.
--
-- THIS TABLE ANSWERS A PROVEN HAZARD, not a defensive habit. The AI Gateway logs endpoint returns
-- HTTP 200, success=true, total_count=0 for a gateway id THAT DOES NOT EXIST, verified against
-- this-gateway-does-not-exist-xyzzy-9999 and byte-identical in shape to the real gateway. So an
-- empty result is indistinguishable from wrong-gateway, wrong-account, no-permission, rows aged
-- out, and genuinely-no-spend. A meter that reads that zero and reports zero spend UNDER-BILLS US,
-- not the tenant.
--
-- So every run records what it actually managed to do, and a consumer bills a period ONLY when
-- status is complete AND control_passed is 1. An absent or incomplete period is UNBILLABLE, which
-- is a different fact from zero.
CREATE TABLE IF NOT EXISTS llm_rollup_periods (
  id             TEXT PRIMARY KEY,
  window_start   TEXT NOT NULL,
  window_end     TEXT NOT NULL,
  -- complete   = pagination ran to exhaustion for this window
  -- incomplete = the window was cut short (error mid-page, page cap hit); rows are real but partial
  -- failed     = nothing trustworthy was read at all
  status         TEXT NOT NULL CHECK (status IN ('complete','incomplete','failed')),
  -- SEPARATE from status deliberately: a run can paginate to exhaustion and still have a FAILED
  -- positive control, and those are different facts. Collapsing them lets a run that proved nothing
  -- look finished.
  control_passed INTEGER NOT NULL CHECK (control_passed IN (0,1)),
  -- Present so a suspicious zero is VISIBLE rather than inferred from an absence of rows.
  rows_ingested  INTEGER NOT NULL CHECK (rows_ingested >= 0),
  -- HAVE NOT FINISHED READING versus THE ROWS ARE GONE. Retention is 10,000,000 rows DELETE_OLDEST
  -- with no time window, so a roll-up that stops for long enough loses rows permanently. That is a
  -- different operator response from a page cap: one is resumable, the other is not, and both would
  -- otherwise read as merely incomplete. Set when the oldest row still in the gateway is NEWER than
  -- the watermark, which means everything between them was deleted unread.
  gap_detected   INTEGER NOT NULL DEFAULT 0 CHECK (gap_detected IN (0,1)),
  started_at     TEXT NOT NULL,
  finished_at    TEXT
);

-- ---------------------------------------------------------------------------------------------
-- The usage rows. Many, cheap, out-of-order, owned by this lane. credit_ledger is MONEY: few rows,
-- append-only, settled. Keeping them apart means neither constrains the write pattern of the other,
-- and it means a request inside a bundled allowance produces NO money row at all rather than a
-- zero-value one.
CREATE TABLE IF NOT EXISTS llm_spend_events (
  -- ai_gateway today. Named rather than assumed, so a second cost source needs no new table.
  source         TEXT NOT NULL,
  -- The gateway log row id: the ONLY identifier the source of truth assigns, which is exactly what
  -- survives a re-run. With source it forms the primary key, so a repeated roll-up over a window
  -- already written is a no-op BY CONSTRUCTION rather than by the caller remembering to check.
  source_id      TEXT NOT NULL,
  -- NULL means UNATTRIBUTED: a gateway call whose cf-aig-metadata was absent. That is real money
  -- attributable to nobody. It is NEVER dropped and NEVER spread across tenants; a consumer lands
  -- it in a house row and surfaces it as a metric, because a rising unattributed count is how we
  -- find out the emitter regressed. Silently eating it is how we would never find out.
  tenant_id      TEXT,
  -- Human label ONLY, never keyed on: a slug is renameable, so attribution keyed on it would
  -- silently re-point the spend history of one tenant at another after a rename.
  slug           TEXT,
  model          TEXT,
  -- NULLABLE, ruled 2026-07-27. NOT NULL would force a row where the gateway reported no cost to
  -- be written as 0, and downstream 0 reads as THIS REQUEST WAS FREE rather than WE DO NOT KNOW.
  -- Row shapes where that bites: a cached response plausibly has a real 0; an errored or
  -- rate-limited request may carry no cost field; a model CF does not price natively likewise.
  -- Once summed those become indistinguishable, and the error is SILENT and ONE-DIRECTIONAL: we
  -- undercount, therefore undercharge, while the price-to-cost ratio reports cost recovery. In a
  -- system whose stated intent IS cost recovery, a schema that can only be wrong in the direction
  -- that flatters us is the worst available shape.
  --
  -- Only two live gateway rows have ever been observed, so it is NOT established that every row
  -- shape carries a cost. The schema therefore does not foreclose the distinction before the
  -- evidence exists. A NULL-cost row is recorded, visible and UNBILLABLE, never silently free.
  cost_micro_usd INTEGER CHECK (cost_micro_usd IS NULL OR cost_micro_usd >= 0),
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  cached         INTEGER CHECK (cached IN (0,1)),
  -- The created_at the gateway assigned. Places the request in a billing period.
  occurred_at    TEXT NOT NULL,
  -- When this roll-up wrote it. Differs from occurred_at by up to one interval; the pair is what
  -- makes lateness detectable rather than invisible.
  inserted_at    TEXT NOT NULL,
  -- BILLING KEYS ON period_id, NEVER occurred_at (contract with cp#195, explicit not implied).
  -- Summing a period by its time window would let a row arriving after settlement retroactively
  -- change a period already billed, breaking never-reprice from the CONSUMER side no matter how
  -- carefully this side behaves. A late row belongs to the period that INGESTED it, so it is billed
  -- once, in the next statement.
  --
  -- ASSIGNED AT INSERT AND NEVER CHANGED: writes are INSERT OR IGNORE on (source, source_id), so a
  -- re-run leaves the ORIGINAL row and its ORIGINAL period_id in place. That is what makes the
  -- contract above hold under replay rather than by coincidence.
  period_id      TEXT NOT NULL REFERENCES llm_rollup_periods(id),
  PRIMARY KEY (source, source_id)
);

-- Per-tenant windowed reads (the consumer access path). tenant_id first: every read is
-- tenant-scoped, and NULL tenant_id rows group together for the unattributed metric.
CREATE INDEX IF NOT EXISTS idx_llm_spend_tenant_time
  ON llm_spend_events (tenant_id, occurred_at);

-- THE BILLING READ (joan, cp#195): always this tenant, this period. The primary key is identity,
-- not an access path, and at the 10M retention ceiling her billing run would otherwise full-scan
-- per tenant. period_id first because a billing run is period-scoped.
CREATE INDEX IF NOT EXISTS idx_llm_spend_period_tenant
  ON llm_spend_events (period_id, tenant_id);

-- Period-scoped reads, for reconciling a window against its completeness record.
CREATE INDEX IF NOT EXISTS idx_llm_spend_period
  ON llm_spend_events (period_id);

-- ---------------------------------------------------------------------------------------------
-- The ingestion cursor. ONE row, id = ai_gateway. Deliberately NOT part of the consumer schema:
-- the watermark is an implementation detail of ingestion, and putting it in the ledger would invite
-- a consumer to reason about it.
--
-- The gateway supports created_at gt, verified in BOTH directions (gt 2026-01-01 returns rows, gt
-- 2026-12-01 returns none), which is what makes a watermark possible at all.
CREATE TABLE IF NOT EXISTS llm_rollup_watermark (
  id           TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
