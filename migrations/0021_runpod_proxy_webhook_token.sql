-- The per-job webhook credential the proxy's callback route verifies (cp#290, ruling 1 on cp#290).
--
-- WHY A COLUMN AND NOT A DERIVED VALUE, because deriving it would have been cheaper and I tried.
-- The natural shape is a MAC over the job id: no storage, no index, verifiable statelessly. It
-- cannot work. RunPod takes the `webhook` URL in the /run body, so the URL must be built BEFORE the
-- submit -- and the job id does not exist until that submit RESPONDS. The token therefore has to be
-- minted first and mapped to the job id afterwards, which is a row.
--
-- THE HASH, NOT THE TOKEN. Same rule as every other credential in this plane (crypto.ts): what is
-- stored is SHA-256 hex, so a read of this database yields no live callback credential. The route
-- hashes what it was presented and looks that up; the raw token exists only in the URL RunPod holds.
--
-- WHAT IT IS FOR. RunPod's terminal callback carries NO authentication of any kind -- MEASURED
-- 2026-08-02, the entire header set is `user-agent: Go-http-client/2.0` plus Cloudflare's own cf-*.
-- An unauthenticated public URL that moves a billing ledger is the whole risk in one sentence, so
-- the token is verified before ANY write. It is PER JOB rather than global or per tenant: a single
-- leaked token exposes exactly one job.
--
-- WHAT "EXPIRES" IT, STATED AS THE CODE ACTUALLY BEHAVES. An earlier version of this comment said
-- the first terminal write expires the token. It does not, and the distinction was found in review
-- (cp#293) by reading the route rather than this comment. TWO SEPARATE GUARANTEES, and only the
-- narrower one comes from the SQL:
--
--   the LEDGER cannot be corrupted   -- `WHERE terminal_at IS NULL` on the close, so first terminal
--                                       write wins and every repeat is a no-op. This is a property
--                                       of the statement and holds regardless of any caller.
--   the TOKEN buys nothing after     -- NOT from this schema. The row is still findable by its token
--   the row closes                      hash by design (a duplicate delivery must be answerable), so
--                                       the route is what has to stop: it short-circuits on a
--                                       non-null terminal_at and answers 200 before issuing any
--                                       upstream request. See handleProxyWebhook.
--
-- The gap between them was real: without that short-circuit a leaked token bought unlimited
-- authenticated GET /status calls on our own RunPod credential. Nothing in this file would have
-- told you, which is the point -- a security comment that promises more than the code delivers is
-- worse than no comment, because the next reader trusts it instead of checking.
--
-- SECOND DEFENCE, and the one that survives a leak: even a token that verifies buys only the right
-- to say "look at this job now". The terminal facts come from a GET /status we issue against RunPod
-- with our own credential. The inbound body is never read. See src/runpod-proxy-routes.ts.
ALTER TABLE runpod_job_index ADD COLUMN webhook_token_sha256 TEXT;

-- UNIQUE so two open jobs can never share a callback credential, PARTIAL so the millions of
-- harvested rows that will never have one do not collide on NULL and do not sit in the index.
-- Note SQLite treats NULLs as distinct in a unique index anyway; the WHERE clause is about SIZE,
-- and about the index being scanned only for the rows the callback route can actually match.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runpod_job_index_webhook_token
  ON runpod_job_index (webhook_token_sha256)
  WHERE webhook_token_sha256 IS NOT NULL;
