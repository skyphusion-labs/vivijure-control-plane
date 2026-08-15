### fix(provision): the cron drives the provisions nobody is polling (cp#429)

The poll was the ONLY engine. Both provision routes fire exactly one driver under `ctx.waitUntil`
and return 202; that driver spends its `PROVISION_INVOCATION_BUDGET_MS` (15s), persists progress,
hands the lease back and yields. **Every step after it needed an inbound `GET /api/tenant/:id/job`.**

That holds up for a tenant sitting on the onboarding page. It does not hold up at all for an
operator-provisioned tenant, who has no client: nothing polls, so nothing drives, and the studio
never builds.

**And it never failed honestly either, which is the worse half.** The `MAX_JOB_STALE_MS` reap that
declares a lost driver lives INSIDE `driveJobIfNeeded`, which only runs on a poll. An unpolled job
was therefore never reaped: no progress, no terminal state, no signal. It read `provisioning`
forever, which is indistinguishable from a provision that is simply taking a while.

`runScheduledTick` grows a THIRD isolated half, `runPendingProvisionDrive`. The cron already runs
every 5 minutes and already isolates its halves for exactly this reason (cp#290): a throw in one
must not silently skip the others, and the symptom of that coupling is an absence.

**IT ADDS NO GUARDS AND WEAKENS NONE.** The cron does not get its own driver; it reaches the SAME
`driveJobIfNeeded` through a dispatch seam. A cron copy of those guards is a copy that drifts on the
path nobody exercises until something has already gone wrong. So the cron inherits, unchanged:
terminal jobs skipped, the cp#43 kind guard, the cp#132 refusal to claim a job no driver has taken,
the stale reap, and `claimJob` picking a single winner -- which is what makes a cron drive racing a
live tenant poll safe rather than a double-mint.

The seam is the only structural change to the driver: the request path passes `ctx.waitUntil`, the
cron path AWAITS, because a scheduled handler IS its work and `waitUntil` there lets the runtime
call the tick finished mid-write (the same reasoning already written above the handler).

Work is found with the existing `listTenants({status})` over `pending` and `provisioning`; **no new
store surface**. Both bounds are LOGGED rather than silent: a full `TENANT_PAGE_LIMIT` page means
there may be work this tick could not see, and a backlog past `MAX_PROVISION_DRIVES_PER_TICK` says
so and drains on the next tick. A silent cap reads exactly like covered everything.

**The evidence is a row that moved, not a spy that was called.** `tests/scheduled-provision-drive`
builds the REAL `D1Store` over a REAL migrated SQLite, drives the SAME exported tick body the cron
drives, and reads the tenant and job rows back through raw SQL. Against `main` the two that matter
go red for the right reason -- the tenant stays `provisioning`, the abandoned job stays `running` --
and the positive control shows the driver double could have moved the row, so the four refusals are
not vacuous.

**Not yet observed on the live plane.** The fix is unproven against a deployed worker until it ships;
the post-deploy observable is the stuck tenant leaving `provisioning` in `GET /api/admin/tenants`.
