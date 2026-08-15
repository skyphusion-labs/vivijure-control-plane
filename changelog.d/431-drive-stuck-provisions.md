### fix(provision): drive stuck provisions from the cron, so an operator-created tenant can finish (cp#431)

**The poll IS the engine** was true and complete while every tenant was self-provisioned: the owner
browser polled, and each poll advanced the job under a fresh waitUntil. **Operator-provision has no
browser.** The route returns 202, its own driver runs until the invocation budget yields, and then
nothing ever polls, so the tenant sits at `provisioning` forever. Since the BYOK purge that route
is the ONLY way a tenant comes into existence, so this was every tenant, permanently.

**Measured before it was written**, not inferred: a live tenant stuck 36 minutes at `provisioning`
with `url` and `studio_release` null, while `GET /api/tenant/<id>/job` answered **401** to an
operator token and no admin equivalent existed. There was no path to advance it by hand at all --
not a missing caller, a missing capability.

**THE SUBTLETY THAT DECIDES THE FIX, and it is why adding a poller naively would have been worse
than the bug.** `MAX_JOB_STALE_MS` declares a job lost after ten IDLE minutes. That was sound while
a poller existed to notice promptly. With nothing polling, idleness is the NORMAL state of a
healthy job between five-minute ticks -- so a sweep reusing that rule would have declared every
stranded tenant `failed` on first contact, including the one this was written for. The sweep uses
**TOTAL AGE** instead, capped generously at two hours, which is the honest runaway guard once idle
time carries no information.

Both guards from the poll path are kept unchanged: a job no driver has ever taken is left alone
(cp#132 -- claiming it races the driver starting under waitUntil), and only the lease winner drives.

It sweeps TENANTS rather than jobs, because `listTenants` already filters by status and no store
method lists jobs. That needs no new store surface and no migration, and a tenant stuck at
`provisioning` is exactly the condition being repaired.

`POST /api/admin/provision-sweep/run` forces a tick and returns the counts, the same shape and the
same reason as the llm-meter run route: an operator must be able to read what a tick DID rather
than infer it from a green log, and between cron ticks it is the only way to unstick a tenant.

The regression test drives `runScheduledTick`, not the sweep function, deliberately: that body
exists on main, so the test was **watched failing against main at `4bf478e`** (3 of 5 red, both
CONTROLs correctly green, since they assert an absence main satisfies trivially).
