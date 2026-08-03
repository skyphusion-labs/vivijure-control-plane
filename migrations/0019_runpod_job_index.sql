-- The control-plane-side RunPod job -> tenant index (cp#270, for vivijure-cf#225).
--
-- WHY IT EXISTS. On the dedicated shape the endpoint NAME carried attribution for free: an endpoint
-- is called `vivijure-<slug>-<key>`, so a job on it belongs to that tenant by construction. Pooling
-- removes that. A pooled endpoint's jobs are a mixture, and the only remaining map from a RunPod job
-- id back to a tenant is a fan-out scan of every tenant database.
--
-- WHY THAT MATTERS ENOUGH TO BE A TABLE. vivijure-cf#225 is the report-driven CSAM enforcement path, and it
-- is the one sanctioned deviation from the no-surveillance posture. A credible report arrives and
-- the entire procedure is reaching the specific job. A design that makes that reachable only by
-- scanning every tenant database degrades the one enforcement mechanism this product has committed
-- to. That is why this is not a nice-to-have.
--
-- WHY IT IS HARVESTED AND NOT PUSHED (ruled 2026-08-01). The obvious shape is for the submitting
-- module worker to write here at submit. It was rejected, and the reasoning is worth keeping: the
-- facility is used a handful of times a year, so a synchronous hot-path write on EVERY render pays a
-- continuous cost for an occasional need. A push also has to arrive somehow -- either a new
-- authenticated ingress on the render path whose failure mode is silent lost attribution, or a D1
-- binding to THIS database on every tenant module worker, which widens the reach of a tenant-facing
-- worker to control-plane storage. The control plane already holds every `d1_database_id` because it
-- created them, so it can simply READ. Nothing is on the render path, no tenant worker gains a
-- binding, and there is nothing to fail silently mid-render.
--
-- WHAT IS COPIED, AND WHY IT IS MORE THAN THE TWO COLUMNS THE NAME PROMISES. `job_id -> tenant_id`
-- is the requirement, but the tenant database is DELETED at teardown, so anything not copied is gone
-- forever at exactly the moment the index becomes the only record. The extra columns are the same
-- machine-generated labels vivijure-cf migration 0014 already stores (module name, an outcome from a
-- closed set, two unix timestamps). No content, no prompts, no titles, no keys -- the ids-and-labels
-- telemetry posture is unchanged, and this is a copy of it rather than a widening of it.
--
-- WHAT IS DELIBERATELY ABSENT: the RunPod ENDPOINT id. Migration 0014 omits it on purpose (the module
-- /ready probe reports it as a boolean and never as a value) and copying it here would break that
-- convention for no gain -- on a pooled endpoint it is the same value for every tenant, so it
-- attributes nothing.
--
-- COVERAGE IS NOT RETROSPECTIVE. Tenants already deleted are unrecoverable and nothing here tries;
-- their databases are gone. This index covers jobs harvested from a tenant that still exists at the
-- time of a sweep, plus every job present at teardown.

CREATE TABLE IF NOT EXISTS runpod_job_index (
  -- The RunPod job id, and the reason this table can exist at all: RunPod cannot enumerate jobs, so
  -- an id nobody wrote down is unreachable the moment the job ends.
  job_id       TEXT PRIMARY KEY,
  -- THE POINT OF THE TABLE. Not a foreign key: the tenant row may be a tombstone or gone, and the
  -- whole value of this index is that it outlives the tenant it describes.
  tenant_id    TEXT NOT NULL,
  -- The tenant SLUG as it was at harvest time. Denormalised deliberately: slugs are LEASES and get
  -- reused, so resolving one later would answer about whoever holds it now. Recorded here it stays a
  -- fact about this job.
  tenant_slug  TEXT NOT NULL,
  module       TEXT,
  outcome      TEXT,
  submitted_at INTEGER,
  terminal_at  INTEGER,
  -- When WE copied the row, so a reader can tell a fresh harvest from a stale one, and so a partial
  -- sweep is diagnosable rather than looking identical to a complete one.
  harvested_at TEXT NOT NULL
);

-- The vivijure-cf#225 access path: given a tenant under investigation, its jobs in time order.
CREATE INDEX IF NOT EXISTS idx_runpod_job_index_tenant
  ON runpod_job_index (tenant_id, submitted_at);
