-- Control-plane schema (#52, epic #40). PLATFORM data only.
--
-- HARD BOUNDARY: tenant studio data (projects, storyboards, renders, cast, spend counters, module
-- config) lives in the TENANT's OWN D1 database and NEVER here. The studio is single-operator by
-- design (#292 identity strip) and each tenant is the operator of their own studio instance; this
-- database knows only who signed up, which tenant instances exist, and what we provisioned.
-- tests/control-plane/schema-guard.test.ts asserts that boundary against this file.
--
-- Credential rule, inherited from migrations/0009_api_tokens.sql (#445): only the SHA-256 hex hash
-- of a token is ever stored. A dump of this database yields no usable credential.

-- A human who signed up. Email is the canonical identity across every auth method.
CREATE TABLE IF NOT EXISTS accounts (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  suspended_at     TEXT,
  suspended_reason TEXT,
  deleted_at       TEXT
);

-- One row per (provider, subject). Apple needs NO schema change: it is provider='apple'.
CREATE TABLE IF NOT EXISTS account_identities (
  provider      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_account ON account_identities (account_id);

-- Magic-link tokens. Hash only: the plaintext exists once, in the mail postern sends.
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_email ON login_tokens (email);

-- Cookie sessions. Hash only, same reason.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id);

-- SSO round-trip state: CSRF state + PKCE verifier. Short-lived, single-use.
CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  verifier    TEXT,
  redirect_to TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);

-- One studio instance per tenant. `status` is the LIFECYCLE ONLY; suspension is the orthogonal
-- suspended_at flag, so resuming restores the real state instead of guessing "live".
-- endpoints_json is written by the provisioner (#53/#54) and read
-- by the invoke-key scope check; it is a JSON array of the tenant's 4 RunPod endpoint ids.
CREATE TABLE IF NOT EXISTS tenants (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  status           TEXT NOT NULL,
  script_name      TEXT,
  d1_database_id   TEXT,
  r2_bucket_name   TEXT,
  endpoints_json   TEXT,
  studio_release   TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  live_at          TEXT,
  suspended_at     TEXT,
  suspended_reason TEXT,
  deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tenants_account ON tenants (account_id);
CREATE INDEX IF NOT EXISTS idx_tenants_status  ON tenants (status);

-- Versioned, blocking, logged AUP acceptance. APPEND-ONLY: a new version is a new row, never an
-- update, so the record of what was accepted when is immutable. The IP is HASHED, not stored raw:
-- the record only has to prove who accepted what and when.
CREATE TABLE IF NOT EXISTS aup_acceptances (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  aup_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_hash     TEXT,
  user_agent  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_aup_account_version ON aup_acceptances (account_id, aup_version);

-- Durable, resumable provisioning. steps_done drives resume; error_step/error_message carry the
-- REAL step error (honest failures, never a cosmetic "provisioning failed"). lease_until mirrors
-- the proven single-runner lease from migrations/0007_film_advance_lease.sql so two runners cannot
-- double-provision. The job RUNNER lands in #53; #52 owns these rows and the status machine.
CREATE TABLE IF NOT EXISTS provision_jobs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL,
  step          TEXT,
  steps_done    TEXT NOT NULL DEFAULT '[]',
  error_step    TEXT,
  error_message TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  lease_until   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON provision_jobs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON provision_jobs (status);

-- Global switches. DB-backed, not vars: an admin switch must flip instantly, without a deploy.
CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);
INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('signups_enabled', 'true');

-- Admin action trail. A suspend is the kind of action that should never be un-attributable.
CREATE TABLE IF NOT EXISTS admin_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
