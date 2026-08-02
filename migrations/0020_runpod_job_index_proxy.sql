-- The PUSH path into runpod_job_index (cp#288), alongside the existing harvest path.
--
-- WHY THIS EXISTS WHEN 0019 RULED "HARVESTED, NOT PUSHED". That ruling was correct when written and
-- is not overturned; a second consumer arrived. 0019 weighed a submit-time write against ONE
-- facility used a handful of times a year (the report-driven CSAM enforcement path -- and note that
-- 0019 cites it as `cp#225`, which resolves to an unrelated merged docs PR; the real issue is
-- vivijure-cf#225). Two of its three stated grounds do not survive the plane-side proxy:
--
--   "a new authenticated ingress on the render path"  -- the ingress IS the submit path now. Every
--                                                        POST /run transits the plane by construction.
--                                                        Its failure mode is a failed submit, which is
--                                                        loud, not silent lost attribution.
--   "a D1 binding on every tenant module worker"      -- not required. The plane holds the binding
--                                                        because the plane makes the call.
--   "continuous cost for an occasional need"          -- SURVIVES for enforcement, DIES for metering.
--                                                        Deduct-on-success needs a per-job record for
--                                                        every job, investigated or not.
--
-- THE HARVESTER STAYS. A push only knows about jobs the plane saw, so it cannot cover pre-proxy
-- jobs, dedicated-mode tenants, or anything that bypassed the proxy -- and it cannot replace the
-- ordered harvest-before-reap step at teardown, which is what makes the index outlive its source.

-- endpoint_id: DELIBERATELY REVERSING 0019's exclusion, and the reason it was excluded no longer
-- holds. 0019 omitted it because "on a pooled endpoint it is the same value for every tenant, so it
-- attributes nothing." True of the four pooled GPU endpoints. NOT true of the cost door: the eight
-- cloud modules submit to eight DISTINCT public model slugs (wan-2-6-i2v, kling-v2-1-i2v-pro,
-- seedance-v1-5-pro-i2v, ...) at different prices, so the endpoint is the only thing that says what
-- a job COST. Without it a per-tenant spend figure cannot be computed at all.
--
-- It is an endpoint identifier, not tenant content, and the ids-and-labels telemetry posture is
-- unchanged.
ALTER TABLE runpod_job_index ADD COLUMN endpoint_id TEXT;

-- Where the row came from. Not decoration: a harvested row and a pushed row have different
-- freshness and different coverage, and a reader that cannot tell them apart will treat an absent
-- push as an absent JOB. 'proxy' | 'harvest'.
ALTER TABLE runpod_job_index ADD COLUMN source TEXT;

-- RunPod's own execution and queue split, taken from the authoritative GET /status we issue (never
-- from the inbound webhook body -- see runpod-proxy.ts on why the callback is a trigger, not
-- evidence).
--
-- NULL IS NOT ZERO AND THE DISTINCTION IS LOAD-BEARING. Measured 2026-08-02: a CANCELLED job's
-- terminal payload carries NO executionTime and NO delayTime at all -- only id, status, input and
-- the webhook url. A zero written into execution_ms would read as a real measurement of a job that
-- took no time, and would under-count the ledger silently. Absent stays NULL.
ALTER TABLE runpod_job_index ADD COLUMN execution_ms INTEGER;
ALTER TABLE runpod_job_index ADD COLUMN delay_ms INTEGER;

-- The verbatim RunPod terminal status (COMPLETED / FAILED / CANCELLED / TIMED_OUT). `outcome` holds
-- our own closed vocabulary; this holds the vendor's, so a vendor state we have not modelled yet is
-- still recoverable rather than collapsed into the nearest label we happen to own.
ALTER TABLE runpod_job_index ADD COLUMN status_raw TEXT;

-- When the terminal write landed, distinct from terminal_at (which is when the JOB ended). The gap
-- between them is push latency, and it is the only way to tell a promptly-closed row from one the
-- reconciler swept up hours later.
ALTER TABLE runpod_job_index ADD COLUMN closed_at TEXT;

-- The reconciler's work queue: rows the proxy opened and no terminal write has closed. Partial
-- index so it stays small -- it is scanned on a schedule and must not grow with total job count.
CREATE INDEX IF NOT EXISTS idx_runpod_job_index_open
  ON runpod_job_index (submitted_at)
  WHERE terminal_at IS NULL;
