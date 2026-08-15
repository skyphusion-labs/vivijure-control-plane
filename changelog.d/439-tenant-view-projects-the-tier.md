### fix(api): tenantView projects the render tier, and the shared invoke-key branch finally has tests (cp#439)

`tenantView` projected ten fields and not the tier, so the front door could not tell a SHARED tenant
from a DEDICATED one. The two need different screens, and the consequence was a hard wall rather
than a cosmetic gap.

Every operator-provisioned tenant is shared (`operatorProvision` fixes `runpodMode: "shared"`). The
shared branch of `installInvokeKey` is correct and complete: a POST carrying a key is refused with
`invoke_key_not_accepted` (*there is no key for you to provide*), and a POST with NO key makes the
plane supply its own pool key and promote the tenant to live. So **the only request that succeeds is
an empty-bodied POST** -- and a wizard that cannot see the tier cannot know to send one. Type
nothing and the button is inert; type anything and you are told there is no key for you to provide.
A shared tenant could not go live through the UI at all.

**NULL is the part that matters, and it is not the column being nullable.** `tenants.runpod_mode` is
`NOT NULL DEFAULT dedicated` (migration 0018) and is written INSIDE the `runpod_endpoints` step, so
before that step every row reads `dedicated` whether or not it is one -- this tree already says so,
in `store.ts`, on `ProvisionJob.runpod_mode`. Projecting the raw column would have shipped the exact
defect being fixed: a value collapsing "genuinely dedicated" and "not decided yet" into one string a
client picks a screen from. So the projection is `RunPodMode | null`, and the untrustworthy region
is unrepresentable rather than merely documented.

Settled-ness is read off `endpoints_json`, and the DIRECTION of that inference is why it is safe:
the provisioner writes the mode BEFORE the endpoint list on both branches, deliberately, so
endpoints present implies the mode was written while the reverse does not hold. Reading it this way
can only under-claim (report not-decided for a tenant whose mode is settled, in the crash window)
and can never assert a tier nobody wrote. Fail toward claiming less, as `readRunPodMode` does.

**The coverage half.** Neither `invoke_key_not_accepted` nor `shared_pool_unconfigured` appeared
anywhere under `tests/` (bare grep, exit 1) while 20+ sibling refusal codes did, so the zero was a
real gap and not a wrong pattern. Precisely scoped: the PROVISION route recording
`provision_jobs.runpod_mode` was already covered; the INSTALL route shared branch was not, in either
direction. That is why 1900 passing tests never saw the wall. Now covered: the refusal, the
`shared_pool_unconfigured` 503 asserted as a CONTRAST against a configured leg (null is the wiring
double default, so a lone assertion would pass against a route that could never install a pool key
at all), the empty-body success asserting the installed key is the plane own sentinel and not
anything a caller supplied, and a DEDICATED control proving the empty-body path did not simply stop
requiring keys for everybody. These tests pass on `main` as well: the branch works and was merely
unwitnessed, so they are regression coverage rather than proof of a fix. They were confirmed
load-bearing by planting a mutation that disables the shared branch and watching them go red.

Note for anyone writing more of these: `dedicated` is the DEFAULT, so `shared` is the non-default
probe value. A test asserting `dedicated` can pass by accident; one asserting `shared` cannot.

**The pattern, because this is the second instance in one night.** cp#433 and cp#439 are the same
bug in different clothes: a payload that collapses two states needing different screens, where the
backend computed the distinction correctly and simply did not project it. Both were found from the
UI side by someone who could not write honest copy with what the route returned. Worth auditing the
remaining projections for a third.

**Scoped, NOT fixed here: `handoffInstall` has the same hole.** It refuses an empty key up front
(`invoke_key_required`) and calls `performInvokeKeyInstall` directly, skipping the shared branch
entirely, so the pool path is structurally unreachable through the operator handoff and a shared
tenant owner who follows a handoff link has no way to succeed. Not fixed here because there are two
defensible fixes with different blast radii (accept an empty key on the handoff route for shared
tenants, or refuse to ISSUE a handoff for a shared tenant at all), and choosing between them is a
product decision on a custody path, not a defect fix.
