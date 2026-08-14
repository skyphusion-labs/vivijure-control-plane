### feat(teardown): operator `i_own` to override tombstone-only referrers (cp#106)

The referential guard correctly refuses resources other rows still claim, including tombstones, so
orphans like rollins-e2e's studio worker and R2 bucket (cp#269 / cp#283) were permanently unreapable
without inventing silent "last referrer wins".

**Option C from cp#106:** `POST /api/admin/tenants/:id/teardown` accepts `i_own: "<this tenant id>"`.
When it matches the row under teardown, referrers that are **all** `status=deleted` no longer block.
A live referrer still always refuses. The decision is audited on `tenant.teardown` with the actor.
Wrong `i_own` → 400. Default remains refuse (safe).
