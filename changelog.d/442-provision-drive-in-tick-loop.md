### fix(provision): drive a job until it stops moving inside one tick, not once per 5 minutes (cp#429)

The cron drive shipped in v1.26.0 drove each tenant **exactly once per tick**. A drive buys at most
PROVISION_INVOCATION_BUDGET_MS (15s) before it yields, and the cron fires every 5 minutes, so that
is 15 seconds of work per 300 seconds of clock: **a 5% duty cycle**, roughly twenty times slower
than the poll path it substitutes for, and 3 to 5 ticks (10 to 25 minutes) for a fresh provision
nobody is watching. It would have been perfectly defensible as "it completes".

**It also defeated cp#158, which is the part worth keeping.** That lease hand-back exists precisely
so a yielding driver does not sit on a dead 60s lease before the next driver takes over. Driving
once per tick made the job wait five minutes anyway. Every guard was individually intact and
correctly inherited; what was thrown away was the OPTIMISATION one of those guards was written to
buy. No test could see it, because none measured how many times a tick drives, and each guard
passes its own tests either way. **Inheriting a guard correctly and then wasting the thing it
bought is a failure mode with no name and no detector.**

A tenant is now driven repeatedly inside one tick, until it stops moving.

**Termination does not rest on the budget.** Every no-dispatch path out of driveJobIfNeeded is
stable under re-reading the same row (terminal, wrong kind, cp#132 queued-and-undriven, lost claim,
no provisioner), so a refusal ENDS that tenant instead of being retried. Only a pass that actually
drove continues. The budget is a bound, not the terminator.

**The job row is RE-READ every iteration and the fresh read is what gets driven.** getLatestJobForTenant
sits inside the loop body, above driveJobIfNeeded, so no pass ever sees the previous pass object.
That is load-bearing rather than tidy: finishJob has no status predicate (cp#438, cp#443), so a
stale in-memory row reaching the reap could flip a tenant that has since SUCCEEDED back to failed.

**A WALL BUDGET, NOT A DRIVE COUNT.** A count is a proxy for time and means something different the
day step durations change. PROVISION_DRIVE_TICK_BUDGET_MS is 120s, sized against the 5-minute
period: this half runs LAST, after the meter and the sweep, so all three must fit inside 300s or
ticks overlap. PROVISION_DRIVE_TENANT_SLICE_MS (60s) stops one long tail eating the tick and
starving other in-flight provisions. MAX_PROVISION_DRIVES_PER_TICK is **gone rather than renamed**:
it counted tenants, and nothing counts tenants now.

**Every tick states how it ENDED**, not only when truncated: outcome is budget_spent or drained,
always logged, with drives, tenants seen and tenants deferred. Only drained means there was nothing
left to do. A silent tick used to read as that either way, which is the same self-sealing absence as
a truncated page.

**Watched red for the right reason:** the assertion is that ONE tick drives the SAME job more than
once, and against the single-drive cut it fails with "expected 2 times, got 1". Deliberately not
"the tenant finished", which could go green for other causes. The driver double emulates a real
yield, persisting progress and handing the lease back, so the test drives the real contention path.
Two termination tests ship with it: a cp#132 queued job must not be retried inside the tick, and a
completed job must not be driven a second time.
