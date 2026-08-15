### feat(teardown): operator `i_own` to override tombstone-only referrers (cp#106)

The referential guard correctly refuses resources other rows still claim, including tombstones, so
orphans like the rollins-e2e lineage studio worker and R2 bucket (cp#269 / cp#283) were permanently unreapable
without inventing silent last-referrer-wins.

**Option C from cp#106:** `POST /api/admin/tenants/:id/teardown` accepts `i_own: "<this tenant id>"`.
When it matches the row under teardown, referrers that are **all** `status=deleted` no longer block.
The decision is audited on `tenant.teardown` with the actor. Wrong `i_own` gives a 400. Default
remains refuse (safe).

**Narrowed by option D (cp#335, merged first).** The hatch now applies to LEGACY rows ONLY, meaning
rows with no `tenant_resource_ownership` claim at all. Three things still refuse regardless of
`i_own`, and they are what keeps C from undoing D:

- a LIVE referrer (C is a tiebreak among the dead, never an override of the guard);
- a recorded owner that is not this tenant (the ownership row wins over an operator assertion);
- an ownership lookup that FAILED, because could-not-determine is not the same answer as legacy.

The refusal message on a legacy row hands the operator the exact `i_own` value to re-run with.

