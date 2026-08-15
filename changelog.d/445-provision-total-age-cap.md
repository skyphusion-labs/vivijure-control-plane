### fix(provision): cap a provision job on TOTAL AGE, because idle time stopped meaning anything (cp#437)

**The premise expired, the rule did not.** `MAX_JOB_STALE_MS` reads IDLE TIME and treats it as
evidence a driver died. That inference was sound while the only driver was a browser poll: a healthy
job was being touched constantly, so a gap meant something had stopped. **Once the cron became a
driver, idle time measures how long ago the last TICK was** -- a property of the cron schedule, not
of the job.

**Worse than uninformative: on a cron-driven job the staleness rule can no longer FIRE at all.**
`claimJob` sets `updated_at = datetime(now)` on every successful claim
(`store-d1.ts:645`, verified at source), and the cron runs every 5 minutes against a 10-minute
window. **Every tick resets the clock the rule is measured by.**

So a job that throws between `claimJob` and the provisioner own catch is re-claimed forever, never
reaped and never reported. **ernst found that edge on the merged code independently of the reasoning
above**, which is why one constant has two arguments behind it: the rule stopped carrying
information, AND there is a concrete loop it can no longer catch.

TOTAL AGE is the quantity that still means something once idleness does not: it measures the job
rather than the schedule, and no amount of re-claiming resets it. Checked BEFORE the staleness rule,
since on a cron-driven job the staleness rule is the one that cannot fire.

The cap is two hours, deliberately generous against a five-minute cadence, and **the number is a
consequence rather than the point** -- a healthy provision yields a handful of times and finishes in
tens of minutes. This is a runaway guard, not a deadline; move it freely, the argument above is what
matters.

**The staleness rule STAYS.** It still catches a job nothing is touching at all, which is a state
that survives the cron existing. This adds a second measure rather than replacing a broken one.

**NOT a fix for cp#438.** That is `finishJob` missing a status predicate. It shares a symptom with
the loop described above and has a different cause, and a job reaped here goes through that same
`finishJob`. Kept separate deliberately so neither looks solved by the other.

Three tests on the existing real-SQLite harness, asserting committed rows: a job past the cap is
reaped **while its `updated_at` is fresh** (the case the idle rule structurally cannot see), a
CONTROL that a job inside the cap is still driven, and a reproduction of the forever loop that ticks
three times without the row ever failing before the cap ends it. **Watched red** with the cap
disabled: both cap tests fail, the control stays green.

## Also here: cp#438 and cp#443, one change because half of it is a trap

finishJob had no status predicate, so a driver that lost its job could overwrite the terminal row
(cp#438). But the reap is TWO writes, and adding the predicate ALONE means the job write refuses
while the tenant write runs anyway -- a studio that provisioned correctly reading failed beside a
job row reading succeeded. A partial guard on a multi-write operation converts a wrong-but-
consistent state into an inconsistent one (cp#443).

So finishJob gains the predicate and reports whether it changed a row, and both reap sites branch on
it. The memory double mirrors both properties.

The test for this nearly shipped unable to fail: the first version pre-closed the job, which never
reaches the reap at all (driveJobIfNeeded returns early on a terminal job), and it passed with the
conditional removed. Now simulated at the store seam and verified to fail without it.

**The reap could kill a driver that was still alive, and the cap made that sharper (cp#451, found by
ernst).** renewJobLease bumps lease_until alone and never updated_at, and both reaps read updated_at
alone, so a driver heartbeating correctly every 20s inside one long step is indistinguishable from a
dead one to the only code that can terminalize it. An age-based guard makes it worse: an honest slow
provision is old but ALIVE, and a runaway guard that cannot tell a runaway from a working driver is
worse than the idle rule it supplements.

The fix is not a new check. jobHasLiveDriver already guards eight admin routes in this file; the reap
was the one terminalizer ignoring it. Both reaps now DEFER while the lease is live: drive nothing,
write nothing, re-examine next pass. A dead driver lapses within JOB_LEASE_SECONDS, so it costs one
cycle and cannot cost a live provision.
