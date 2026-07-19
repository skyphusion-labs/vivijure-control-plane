-- Operator verification route (cp#45).
--
-- The release standard is that nothing is verified until someone has looked at the actual output.
-- For a hosted tenant that was unperformable: the only credential that can drive a tenant studio is
-- encrypted in D1 and decryptable only inside this worker. This table is the record of the operator
-- smoke renders that close that hole, and it is ALSO the spend guard -- the guard is a conditional
-- INSERT against these rows, so the WRITE authorizes rather than a check the caller ran earlier.
--
-- Every column here is a control-plane fact or a hash. No tenant credential, no presigned URL, and
-- no artifact bytes land in D1: artifact_key is an R2 key in the TENANT's bucket, useless without
-- the tenant token this worker never hands out.
CREATE TABLE IF NOT EXISTS smoke_renders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  -- running | succeeded | failed. Terminal states are written once, by the poll that observed them.
  status TEXT NOT NULL DEFAULT 'running',
  -- tenants.modules_release AS IT WAS at submit time. This is the whole point of the route: it says
  -- WHICH module bytes the observed pixels came out of. NULL is meaningful (not known uniform).
  modules_release TEXT,
  -- The studio-side job id, so an operator can correlate with the tenant studio's own record.
  studio_job_id TEXT,
  -- The bundle this render was submitted against, in the tenant's own R2.
  bundle_key TEXT,
  -- Proof of the FETCHED artifact, never of an inferred one. All four are written together, only
  -- after the bytes were actually pulled through this worker. A COMPLETED studio job with no
  -- fetchable bytes is recorded as FAILED, because phase=done is not a pass.
  artifact_key TEXT,
  artifact_bytes INTEGER,
  artifact_sha256 TEXT,
  artifact_content_type TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

-- The guard reads by tenant and by time on every submit; the daily cap reads by time across all
-- tenants. Both indexes exist so the gate stays cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_smoke_renders_tenant ON smoke_renders (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_smoke_renders_created ON smoke_renders (created_at DESC);
