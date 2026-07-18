-- #53: columns the provisioner writes.
--
-- r2_token_id is the ID of the tenant's bucket-scoped R2 token, NOT its value. The value is a
-- credential and is written straight into a worker secret and then dropped; only a worker secret
-- ever holds it. We keep the id because teardown has to REVOKE the token: without it, deleting a
-- tenant would leave a live credential behind pointing at a deleted bucket, which is an orphaned
-- grant, not a tidy-up problem.
ALTER TABLE tenants ADD COLUMN r2_token_id TEXT;
