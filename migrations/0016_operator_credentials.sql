-- cp#219: named, scoped operator credentials.
--
-- WHAT THIS REPLACES. Until now the entire /api/admin/* surface was gated by ONE shared bearer,
-- CONTROL_PLANE_ADMIN_TOKEN. That credential has two properties that this table exists to end:
--   1. It carries NO scope. Anyone holding it holds every admin capability over every tenant, so a
--      crew member who needs to read one tenant status cannot be given that without being given
--      teardown, money minting, and the KEK sweep at the same time.
--   2. It names NOBODY. Its audit rows record the actor as the literal string "admin-token", which
--      proves an event occurred and nothing whatever about who caused it. cp#193 shipped around
--      that by recording `operator_claimed` on a money row: a name typed into a form, stored and
--      labelled as a claim precisely because recording it as verified would put false attribution
--      into a money audit.
--
-- THE SHARED TOKEN SURVIVES, deliberately, as break-glass and as the ONLY credential that may mint
-- or revoke rows in this table. A scoped credential able to mint an unscoped one would hold every
-- scope by way of two requests, so credential lifecycle is root-only by construction rather than by
-- a scope that could be granted by mistake.
--
-- CUSTODY: the plaintext token exists exactly once, in the mint response. This table stores only its
-- SHA-256 hex, the same rule the platform already applies to login tokens, session tokens and the
-- studio api_tokens table, and it is what makes a D1 dump of this table worthless to whoever reads
-- it. There is deliberately no masked-display column: keeping a prefix to show back implies keeping
-- something, and a visible absence is the honest signal.
CREATE TABLE IF NOT EXISTS operator_credentials (
  id            TEXT PRIMARY KEY,
  -- The authenticated operator identity. This string is what lands in admin_audit.actor as
  -- `operator:<name>` and in a manual credit as `operator_authenticated`, so it is an identity
  -- rather than a label: pick it to name a person, never a purpose.
  name          TEXT NOT NULL,
  -- SHA-256 hex of the token. UNIQUE so two credentials cannot resolve the same bearer, which would
  -- make attribution ambiguous at exactly the moment it matters.
  token_sha256  TEXT NOT NULL UNIQUE,
  -- Space-separated, canonicalised (deduped and sorted) at mint time. Space-separated rather than
  -- JSON because every read is an exact membership test and a scope id is by construction a token
  -- with no spaces in it; storing a document here would invite partial-match reads.
  --
  -- VALIDATED AT MINT AGAINST THE CATALOGUE IN src/operator-auth.ts. An unknown scope is REFUSED,
  -- never stored and never silently dropped: a credential quietly minted without the scope its
  -- holder asked for is a credential whose holder believes they can do something they cannot, and
  -- the opposite mistake is worse still.
  scopes        TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- Who minted it. Today always the root token (`admin-token`), because minting is root-only; the
  -- column is here so that stays visible rather than assumed.
  created_by    TEXT NOT NULL,
  -- Stamped on every authenticated request this credential makes. Its purpose is REVOCATION being
  -- operable: a credential nobody can tell is dormant is a credential nobody dares revoke. Written
  -- outside the request path (ctx.waitUntil) so a failed stamp can never turn into a failed auth.
  last_used_at  TEXT,
  -- Optional. NULL means no expiry, which is the honest default for crew credentials that are
  -- revoked by decision rather than by calendar. When set it is enforced at auth time, not by a
  -- sweep, so an expired credential is dead the moment it is presented.
  expires_at    TEXT,
  -- Soft revocation. The row STAYS, because deleting it would erase the fact that a credential
  -- existed at the time of the audit rows that name it, and an audit trail whose principals can
  -- vanish is not a trail.
  revoked_at    TEXT,
  revoked_by    TEXT
);

-- Names are unique among LIVE credentials only. Revoked rows keep their name so history reads
-- correctly, and re-issuing to the same person after a revocation is an ordinary mint rather than a
-- collision. Partial index because that is exactly the rule: two live credentials answering to one
-- operator name would make `operator:joan` in the audit trail ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_credentials_live_name
  ON operator_credentials (name) WHERE revoked_at IS NULL;

-- The auth path: hash the presented bearer, look it up. UNIQUE on token_sha256 already provides the
-- index; named here only so the access path is not accidental.

-- The audit read path (cp#219: "durable and reviewable, so the claim is checkable"). admin_audit
-- has been append-only with no reader since 0001; a record nobody can read is not reviewable.
-- Filtering is by target (a tenant id) and by recency, which is what these two support.
CREATE INDEX IF NOT EXISTS idx_admin_audit_target_id ON admin_audit (target, id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_id ON admin_audit (id);
