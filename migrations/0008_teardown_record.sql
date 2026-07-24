-- #23: a teardown that leaves no record. "A tenant is deleted" and "its resources were reaped" are
-- different facts, and the database only ever recorded the first one.
--
-- teardownTenant is best-effort by design: it COLLECTS failures rather than throwing, so one failed
-- delete cannot strand a live credential behind it. That shape is right, but the result was handed
-- to the caller and written down nowhere, so nothing in the data could distinguish a clean teardown
-- from a partial one -- and a partial one is precisely the case that needs a human.
--
-- teardown_failures is the JSON array teardownTenant returns ('[]' on a clean reap). teardown_at is
-- when the attempt ran. Both NULL means no teardown has ever been attempted, which is a third state
-- and must stay distinguishable from "attempted, clean".
ALTER TABLE tenants ADD COLUMN teardown_at TEXT;
ALTER TABLE tenants ADD COLUMN teardown_failures TEXT;
