### fix(onboarding): retire the retry transport, and guard against the next phantom (cp#467, cp#474)

`retry()` POSTed `/api/tenant/:id/retry`. The plane serves exactly two literal tenant paths
(`provision`, `slug-available`) and four scoped actions (`api-token`, `credits`, `invoke-key`,
`job`). **`retry` is none of them**, and it has had no caller in `public/` for some time. Its body
also still conditionally advertised `runpod_api_key`, which cp#427 removed the concept of, so it was
advertising a dead field on a dead route.

That is the SECOND phantom after `capacity`, both found by walking. **Walking does not scale**, so
this adds a guard: read the shipped transport and the shipped route table and demand they agree,
with a positive control so an empty extraction cannot pass.

**It found a THIRD within a second, and that one is live.** `/api/tenant/provision-plan` is called
on every walk of the wizard by `loadPlan()`, and the REVIEW step renders from it -- the screen whose
entire job is to show what is about to be created before somebody confirms it. It has never had
anything to show. Filed as cp#474 and deliberately NOT fixed here: retiring a dead route is one
thing, but this one needs a route to EXIST, and that is a plane-side decision.

**The allowlist cleans itself.** Both known phantoms are listed by name with their issue, and an
entry that is no longer called FAILS. A list of exceptions granted to nothing is how a guard quietly
stops guarding -- the next phantom to take one of those names would be waved straight through.

**Why all three survived:** each had a mock that answered it green, so the flow was walkable in
preview and broken in production, and nothing compared the two. **The mock was not drifting from the
contract, it was inventing one**, and the only thing asserting these contracts was something we
wrote to stand in for them.

Probed with `crew-probe` in both directions: pointing a transport at a route the plane does not
serve reds the guard, and staling an allowlist entry reds it too.
