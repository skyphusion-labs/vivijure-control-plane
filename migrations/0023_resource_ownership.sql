-- Resource ownership provenance (cp#106 option D).
--
-- WHY. Resource names derive from the slug; slug reuse is resource reuse. Multiple tenant rows
-- (including tombstones) can point at one physical D1 / bucket / script. The referential guard
-- refuses any shared resource, which is correct without a rule for "who owns it" -- and permanently
-- unreapable orphans (cp#269 / #283) are the cost of that silence.
--
-- Option C (i_own) is the audited human hatch for the backlog. Option D records the owner at
-- CREATE time going forward so the true provisioner can reap past tombstone-only referrers without
-- inventing silent last-referrer-wins.
--
-- WHAT IS ABSENT: content, credentials, prompts. Only kind + physical key + owner tenant id + time.
-- Legacy rows (no ownership row) keep the refuse-all-referrers default until an operator uses i_own.

CREATE TABLE IF NOT EXISTS tenant_resource_ownership (
  resource_kind TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  owner_tenant_id TEXT NOT NULL,
  provisioned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (resource_kind, resource_key)
);

CREATE INDEX IF NOT EXISTS idx_resource_ownership_owner
  ON tenant_resource_ownership (owner_tenant_id);
