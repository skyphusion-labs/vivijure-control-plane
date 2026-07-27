-- cp#169: the operator-initiated, owner-completed invoke-key handoff (Conrad ruling, PATH 3).
--
-- THE STRAND THIS CLOSES. `POST /api/admin/tenants/:id/reprovision-runpod` (cp#137) rebuilds a live
-- tenant's four RunPod endpoints, and the new endpoints have NEW ids, so the tenant's stored key B
-- (scoped to the ids just replaced) no longer works. The last step is always "install a fresh
-- invoke key", and that route is SESSION-gated: the admin bearer is honoured only under /api/admin/,
-- so the operator who just performed the repair cannot complete it. Observed live during the cp#137
-- remediation: the operator held a correctly-scoped key and the tenant still sat at
-- awaiting_invoke_key until the account owner signed in.
--
-- WHY A HANDOFF ROW RATHER THAN AN ADMIN INSTALL ROUTE (options 2 vs 3 on cp#169). An admin-gated
-- install would let an operator credential put a RunPod key on a customer studio, which is the
-- custody expansion the two-key design exists to prevent. The ruling keeps the credential decision
-- with the OWNER and moves only the INITIATIVE to the operator: the plane mints a one-time link, the
-- operator hands it over through their support channel, and the owner pastes their own key into a
-- page that authorizes exactly one install on exactly one tenant.
--
-- WHAT IS STORED, and what deliberately is not. The token is a 256-bit random value that exists in
-- plaintext exactly ONCE, in the admin response the operator reads; D1 gets only its SHA-256, the
-- same rule login_tokens and sessions already follow (0001_init.sql), so a control-plane D1 dump
-- yields no usable link. `id` exists so the ISSUANCE and CONSUMPTION audit rows can be correlated
-- without either of them naming any part of the secret.
--
-- WHY THE ENDPOINT IDS ARE ON THE ROW. Two jobs, and both matter:
--   1. The page shows the owner WHICH four endpoints to scope their new key to. Those are the ids
--      the repair produced, and a link that cannot name them sends the owner back to the operator.
--   2. STALENESS. If the tenant is reprovisioned again before the link is used, the ids on this row
--      no longer match the tenant's current endpoints, and installing a key scoped to the recorded
--      set would store a credential for endpoints that no longer exist -- the exact failure the
--      handoff exists to repair. The consume path refuses on that mismatch instead.
--
-- THE POWER OF A LEAKED LINK IS BOUNDED BY RUNPOD, not only by our expiry, and this is why a
-- multi-day TTL is defensible for a support-channel handoff. Anyone holding the link can install a
-- key ONLY if that key passes verifyInvokeKeyScope unchanged: not graphql-capable, and reaching all
-- four of THIS tenant's endpoints, which live in the TENANT's own RunPod account. A stranger with
-- the link and no credential to that account can install nothing.
--
-- SINGLE-USE IS BURNED ON A COMPLETED INSTALL ONLY. A rejected key must not burn the link (a typo
-- would stranding the owner exactly as before), and neither must the 202 "modules still picking it
-- up" path, whose own instruction is to RETRY the request. consumed_at is written only when the
-- tenant reaches live.
CREATE TABLE IF NOT EXISTS invoke_key_handoffs (
  token_hash     TEXT PRIMARY KEY,
  id             TEXT NOT NULL UNIQUE,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  -- JSON array of the four RunPod endpoint ids this handoff was issued against.
  endpoints_json TEXT NOT NULL,
  -- The admin actor that issued it, so an unexpected install has a person attached to it.
  issued_by      TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT NOT NULL,
  consumed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoke_key_handoffs_tenant ON invoke_key_handoffs (tenant_id);
