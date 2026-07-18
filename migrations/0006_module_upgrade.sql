-- The module-upgrade route (cf#103 half two): ship newly published modules to a LIVE tenant.
--
-- WHY A SECOND RELEASE COLUMN AND NOT studio_release: they are two different facts. studio_release
-- records the release whose STUDIO BYTES this tenant runs, written only by the studio upload. An
-- upgrade ships MODULE bytes and deliberately does not touch the studio, so folding the module
-- release into studio_release would make that column claim the studio moved when it did not. Two
-- facts, two columns -- the same discipline as suspended_at vs status.
--
-- WHY IT IS NULLABLE AND WHAT NULL MEANS: NULL is not "unknown legacy row", it is a LOAD-BEARING
-- state meaning "not known to be uniformly at any one release; consult the job row". The upgrade
-- NULLs this BEFORE its first upload and writes the target only on full success, so a partial
-- failure (modules 1-3 swapped, module 4 dead) leaves NULL rather than a value asserting a
-- uniformity that does not hold. Existing rows read NULL, which is correct for them: nothing has
-- ever recorded their module release, and the plane-wide STUDIO_RELEASE they were provisioned at
-- is not a per-tenant fact we can honestly backfill.
ALTER TABLE tenants ADD COLUMN modules_release TEXT;

-- WHY THE JOB CARRIES BOTH ENDS: rollback is "re-run the upgrade at the previous release" (there is
-- deliberately no automatic rollback -- see upgradeTenantModules). Once modules_release is NULLed at
-- the start of an upgrade, the PREVIOUS release is no longer recoverable from the tenant row, and it
-- is needed in exactly the state that lost it: a failed upgrade. The job row is where it survives.
-- to_release is recorded alongside it so the pair reads as an intent ("R_old -> R_new") rather than
-- a bare target, which is what makes a failed job self-describing without cross-referencing.
ALTER TABLE provision_jobs ADD COLUMN from_release TEXT;
ALTER TABLE provision_jobs ADD COLUMN to_release TEXT;
