-- cp#118: an INTERLOCK between an open preservation obligation and irreversible teardown.
--
-- Before this table, nothing in the code stopped `teardownTenant(..., { deleteData: true })` from
-- emptying a tenant R2 bucket and dropping its D1 while an abuse report was open. The only control
-- was an operator remembering a paragraph of ABUSE-RESPONSE-RUNBOOK.md Section 5.2. A procedural
-- control where a technical one belongs, and the failure mode is destruction of material we are
-- statutorily required to preserve (18 U.S.C. 2258A(h)), which 2258A(h) makes crime-adjacent
-- rather than merely embarrassing.
--
-- A TABLE, NOT A COLUMN, and the reason is in the statute rather than in taste. TWO different
-- clocks can run on the SAME tenant at the SAME time (runbook Section 5.3):
--
--   * 2258A(h)(1) -- OUR CyberTipline submission starts a 1-YEAR preservation. (Pub. L. 118-59
--     substituted "1 year" for "90 days" in 2024; any source still saying 90 days for THIS clock is
--     quoting repealed text.)
--   * 2703(f) -- a GOVERNMENTAL ENTITY request starts 90 DAYS, extended a further 90 on renewal.
--
-- 2258A(h)(4) states the preservation subsection does not limit 2703 authority, so both can be
-- live at once, with different starts, different lengths, and different release conditions. One
-- column cannot carry two clocks, two reasons and two openers, and a column would silently lose the
-- second hold the moment the first was released -- which is exactly the case where releasing looks
-- safe and is not.
--
-- EXPIRY DOES NOT AUTO-RELEASE, deliberately, and this is the load-bearing design decision here.
-- `expires_at` is the FLOOR of the preservation duty, not an instruction to delete: 2258A(h)(5)
-- permits preserving longer, and 2258B(c) says destruction happens on LAW ENFORCEMENT request, never
-- on a timer of ours. So the interlock keys on `released_at IS NULL` alone. A hold whose clock has
-- passed still blocks and is reported as "clock elapsed, still open" -- a human decides, in the
-- open, with an audit row. A clock that silently unblocked evidence destruction would be the same
-- defect this table exists to close, wearing a calendar.
CREATE TABLE preservation_holds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  -- Which duty this hold represents. Kept as text rather than an enum because the set is statutory
  -- and can grow; the vocabulary is documented in docs/control-plane.md and validated at the route.
  --   ncmec_2258a_h -- our CyberTipline submission, 1 year
  --   le_2703_f     -- a governmental preservation request, 90 days, renewable
  --   internal      -- an open report with no statutory clock attached YET (the common first state)
  kind TEXT NOT NULL,
  -- MANDATORY. A hold nobody can explain is not auditable, and this one blocks a destructive lever.
  reason TEXT NOT NULL,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  opened_by TEXT NOT NULL,
  -- The floor of the duty. NULL is honest for an `internal` hold whose clock has not started.
  expires_at TEXT,
  -- Open is released_at IS NULL. Release is an explicit, audited, human act.
  released_at TEXT,
  released_by TEXT,
  release_reason TEXT
);

-- The interlock question is "does this tenant have ANY open hold", asked on every destructive pass.
CREATE INDEX idx_preservation_holds_open ON preservation_holds (tenant_id, released_at);
