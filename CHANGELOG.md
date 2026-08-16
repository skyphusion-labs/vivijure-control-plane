# Changelog

All notable changes to the Vivijure control plane. Versions are SemVer; a `v*` tag on this
repository deploys the control plane (a `v*` tag in `vivijure-cf` deploys the Studio panel, which
is a separate product on a separate cadence).

## Unreleased

## v1.29.1 -- 2026-08-16

### fix(onboarding): preview mock matches wan-train plan; go-live is not invoke

v1.29.0 failed preflight Test: mock plan omitted wan-train, and the intro suite still
looked for `data-step="invoke"` after the BYOK purge.

## v1.29.0 -- 2026-08-16

### feat(credits): PayPal payment rail behind the PaymentRail seam (cp#193)

- `PayPalRail` implements `PaymentRail`: Orders API v2 (intent CAPTURE) for checkout, webhook
  verification via `/v1/notifications/verify-webhook-signature`, settlement only on
  `PAYMENT.CAPTURE.COMPLETED`. Stripe is not the rail. No credential is in the repo.
- New `POST /api/tenant/:id/credits/topup` (owner session, USD 10 floor) returns
  `{ checkout_url, external_ref, rail: "paypal" }`. New `POST /api/webhooks/paypal`: 400 if
  unverified, 200 `{ applied: false }` on replay.
- `topUpAvailable` is true only when client id, secret, and webhook id are all set.
  `creditsApplyToTenant` is unchanged (still false until `compute_mode`). `CREDITS_ENFORCING`
  is not flipped.
- Env: `PAYPAL_CLIENT_ID`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENV` are vars (empty = rail absent /
  sandbox). `PAYPAL_CLIENT_SECRET` is a wrangler secret. `ManualRail` stays for operator credits.

## v1.28.1 -- 2026-08-16

### fix(ci): fixtures match wan-train + CF i2v catalog

v1.28.0 tagged and failed preflight Test. Pin regex accepts `train-*`.
Studio fixtures bind RUNPOD_WAN_TRAIN_ENDPOINT_ID. Catalog counts 19.

## v1.28.0 -- 2026-08-16

### feat(purge): remove the BYOK / dedicated RunPod path (cp#396)

Conrad ruling: the BYOK channel is closed, so its code is REMOVED rather than deferred. Dead code
for a channel nobody builds or tests is a liability, and the shared tier is now armed and is the
only tier.

**3,789 lines deleted against 280 added.** Gone entirely: per-tenant RunPod endpoint creation
(`createTenantEndpoints`, `convergeTenantTemplateImages`, `preflightQuota`, `quotaGuidance`,
`templateEnv`, `invokeKeyRecipe`), the whole RunPod-provisioning seam on `ProvisionDeps`, the
endpoint-rebuild route and its module, the owner invoke-key handoff with its page and client, and
key A itself -- `runProvisionJob` and `provisioner.start` no longer take a key parameter at all,
which is stronger than passing null, because a key can no longer be handed over by mistake.

**THREE THINGS ON THE OBVIOUS PURGE LIST ARE LOAD-BEARING FOR THE SHARED TIER AND STAYED.**
`installInvokeKey`, `verifyInvokeKeyScope` and the `awaiting_invoke_key` state all run for shared
tenants: the plane supplies its POOL key through the same install, the same verification and the
same promotion. Deleting them on the strength of their names would have taken the tier down.

**Closed a hole the purge would otherwise have made permanent.** `invoke_key_not_accepted` and
`shared_pool_unconfigured` had ZERO tests -- every route-level invoke-key test drove a PASTED key,
because the fixture recorded a legacy row by default. That branch is now the ONLY branch, so it has
negative tests plus a control proving the pool key is what gets installed. Watched going red on a
mutation that drops the refusal.

**The dedicated fixture was the carrier for most of the provisioning suite**, not a small set of
dedicated tests: 53 of 58 provisioner cases ran the dedicated branch because the default fixture
was a plane with no pool. Flipping that default to a POOL preserved all of them; only 3 asserted
creation itself and were deleted. The rollback test kept its claim and moved its failure injection
to the studio upload, since `createEndpoints` was the seam it used to throw from.

**A simplification the purge unlocked rather than one it forced.** `YIELD_UNSAFE_STEPS` existed
because `runpod_endpoints` had just created billable endpoints a keyless poll could not use, so a
yield there produced a permanently unresumable job. Nothing is created now: the step is pure config
resolution and a poll re-resolves it identically. The set is EMPTY rather than deleted, so the
mechanism stays available for the next step that earns it and the comment records why this one no
longer does.

**The 13 historical rows are untouched and stay protected.** `runpod_mode` does not record a
provisioning STYLE, it records whose the endpoint ids on a row are, and that still has two answers.
The narrowing is unchanged: never treat a row ids as pool-owned unless it says shared explicitly.
`reconcile-runpod.ts` still iterates the FULL plan to attribute historical endpoint names, and the
migrations stay -- the column outlives the code path and dropping it needs its own migration.
The resume refusal for a legacy dedicated row is kept and now has a test that says LEGACY on the
tin and states the fact explicitly instead of inheriting it from a default.

**Teardown needed no code change and one comment change.** There is no RunPod delete call anywhere
in `teardownTenant`, on any branch, so the protection is structural. But the comment justified that
with two reasons, one per tier; deleting the dedicated half would leave a claim that is false of
every remaining tenant, and a reader who noticed would be one step from adding the reap leg it
exists to prevent.

**The invoke-key route is now SHARED-ONLY, and the handoff removal was CONDITIONAL on proving it.**
`setTenantStatus(..., "live")` occurs at exactly ONE site, `performInvokeKeyInstall`, which after
this change has exactly ONE caller, the session route. So a shared tenant reaches live
without traversing the handoff, which is what made removing an unauthenticated surface safe. A row
that is not recorded shared -- the 13 legacy ones, all dead -- is refused BY NAME
(`tenant_not_on_shared_tier`) rather than dropping through to a 404-shaped silence.

The caller comment on that route named the handoff as one of its callers. Left alone it would
have been a false statement about the security argument the route rests on, which is the same
defect class as the teardown comment above.

### fix(onboarding): purge BYOK from the wizard, so a studio can actually be built (cp#427, cp#439, cp#467)

Conrad ruled the BYOK/dedicated path REMOVED, not deferred (cp#427). This is the wizard half; the
plane half is #430. Together they are the difference between a wizard nobody could finish and one
that works.

**Three walls stood on this path and all three came from the same assumption -- everyone is BYOK.**

**Step 4 asked for a RunPod key** the plane no longer accepts, and would not advance without one.
**Step 5 POSTed to /api/tenant/capacity, a route the plane has never served** (cp#467): two explicit
tenant paths exist and the scoped handler matches ten_ ids, so it 404d, and the 404 rendered as
**We could not check your account with RunPod** with advice to go fix a key that was fine. Its gate
demanded fits === true, which the error path never sets. **Step 8 refused a pasted key** and
promoted on a request carrying none, while the only control was gated on having typed one.

So a shared tenant stopped at 4 and a BYOK tenant cleared 4 and stopped at 5. **Nobody could
complete this wizard on either tier.**

## Both dead steps retire TOGETHER, and that is not tidiness

Removing the key gate alone would have moved everybody from the first wall onto the second, and it
would have read as a regression introduced by the fix. **Never ship a state where the visible
symptom migrates rather than clears.** Nine steps become seven.

## What is left

The go-live step keeps the one action that works: an empty-bodied POST that installs the plane own
pool key. Its other two states are stated rather than guessed -- a legacy dedicated row is
UNSUPPORTED (the route refuses it by name, so key instructions would send somebody to make a
credential nothing accepts), and an unwritten runpod_mode is UNDECIDED, because null is not a tier.

**shared_tier_available survives with a WIDER meaning, and the rename says so.** It answered is a
key optional back when a pasted key still selected a tier. With BYOK gone the pool IS the product,
so it now answers **can this plane provision at all**, and the wizard says so UP FRONT rather than
letting somebody name a studio it could never build. planCanProvision, not keyRequirement.

## Verification

**13 tests went red and every one asserted the retired design.** They were RETIRED citing cp#427,
not adapted to go green -- the ordering test kept the invariants that survive (nothing is created
before an explicit review; going live comes after the build) and lost only the key and capacity
references.

Driven in a real browser on the shipped assets: seven steps, no key field anywhere, the go-live
control present, and **the path that was walled now runs** -- name a studio, click Continue, land
on review rather than into a step that no longer exists.

### The cron can now say whether it is alive (cp#436)

The scheduled handler ran three halves and every one of them reported to the console only. Nothing
persisted the fact that a tick had happened, so the cron could not be observed from outside the
Worker at all: if it stopped firing, every symptom was an ABSENCE (no meter periods, no RunPod
sweep, no provision drives), and an absence is indistinguishable from a plane with nothing to do.

That was tolerable while a dead cron only meant late billing data. It stopped being tolerable when
the cron became the only engine that drives an operator-provisioned tenant to a studio: from that
point a dead cron means no customer ever gets a studio, the tenant reads provisioning forever, and
nothing anywhere reports a fault.

Every tick now stamps a durable heartbeat, and a new operator read, GET /api/admin/cron, serves it
with the staleness already worked out. Two properties it was built to have, because a heartbeat
that lacks them is decoration:

- **It can go RED.** A half that threw is recorded as having thrown, and so is a half that REFUSED
  (no credential, no reader). A run that did nothing because it COULD not must never read like a
  run that did nothing because there was nothing to do.
- **Never-ran and ran-and-found-nothing do not read alike.** A clean tick over an empty plane still
  stamps the row, so the row existing is the evidence the handler executed. A missing row is
  reported as never-ran, not as a healthy quiet plane.

The sharpest case is the provision half. It catches per tenant, deliberately, so that one bad
tenant cannot take the rest of the tick down; the consequence is that it returns NORMALLY when
every drive it attempted failed. Judging it on whether an error escaped would have left it green
through a total outage of the thing it measures, so it is judged on its error count instead.

The write is unconditional and its failure is swallowed. An instrument that can take down the
engine it measures is a worse defect than the blindness it was added to fix.

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

**The seam the merge created, pinned (ernst).** The cap reap is reached from a fresh read, the loop
takes a fresh read on every pass, and a yield hands the lease back, so jobHasLiveDriver does not
defer the next pass. A job that is actively PROGRESSING can therefore cross the age line between
two drives of the SAME tick and be reaped by the very loop driving it. **Neither PR could have
tested that, because it only exists once both land.**

That IS the intended semantics: the cap measures how long a provision has been alive, and being
actively driven does not buy it more time. What matters is that it is pinned rather than
discovered months later, so it is asserted in both directions -- crossing the line reaps, and a
job still inside the cap drives to completion untouched.

**Writing that test found a real interaction I had not seen.** The obvious setup, a two-minute
burn between drives, SILENTLY TESTED NOTHING: two minutes exceeds the 60s per-tenant slice, so the
loop exited on the slice before it ever took the second read. The burn has to cross the cap while
staying inside the slice, which is why the backdate is in seconds rather than minutes and why that
precision is commented in the test. A green run there would have proved only that the loop stops.

### fix(onboarding): classify a provision failure on the CODE, and say what the plane said (cp#448, cp#447)

`handleProvisionError` read `err.status === 409` and called every one of them a key problem. The
provision route serves at least four distinct 409s and only one was ever about a key, so
`tenant_exists`, `slug_taken`, `slug_reclaim_in_progress` and `reclaim_teardown_failed` all rendered
as **Setup needs your key again**.

Two things made that worse than a wrong headline.

**The plane's own sentence was dropped.** The transport sets `err.message` to `body.error` -- the
CODE -- and the screen rendered that. So the owner of a genuinely stuck teardown saw the bare string
`reclaim_teardown_failed` and never the words telling them to stop retrying and contact us.

**And the advice attached to it pointed at a teardown.** Because it believed a key was needed, the
screen told them to provision the same name again, which is the cp#435 destroy path. The one
paragraph in the product that describes the destruction appeared as INSTRUCTIONS in cases where
destruction is not the answer.

Now: classified on the code, and **the plane's message wins whenever it sent one** -- it is written
for the owner, it knows which refusal this is, and nothing the client can infer beats it. The code
is a last resort and is labelled as one rather than dressed up as an explanation. **No path advises
re-provisioning**: under cp#427 there is no key to re-paste, and the destroy route belongs behind the
cp#435 acknowledgement, never in a failure hint.

**`runpod_key_required` is read with its NARROWED meaning.** cp#427 kept the code and changed what
it means -- this deploy has no shared render capacity -- so a client still reading it as *bring a
key* would send somebody after a key that no longer exists anywhere in the product.

**cp#447 went with it**, because it lived in the same handler. A `data-next` button relabelled *Back
to the key step* advanced BY INDEX into the render-key step: forward, past its own gate, on a page
holding none of the state that step needs. The step it named no longer exists either. **A failure
screen that cannot offer a correct action now offers none.**

**Watched red first:** 7 against merged main for the classifier, 3 for the wiring, controls green.
One of the wiring assertions had to be rewritten mid-flight -- it forbade the PHRASE *Back to the key
step*, which caught the comment explaining why the control was removed. It now asserts on the
assignment instead, because a test that made me delete the explanation to stay green would have been
the test dictating the wrong thing.

### fix(audit): record owner reclaim teardown and write teardown intent first (cp#456, cp#398)

Owner reclaim teardown (`deleteData: true`) wrote no audit row, while the identical operator
teardown did. A real reclaim tonight destroyed a D1, R2 bucket, R2 token, and studio worker and
left the newest audit entry as an earlier operator provision.

Both destructive paths now write `*.intent` BEFORE `provisioner.teardown` and a completion row
after. A failed intent write aborts before anything is deleted. The owner actor is
`account:<id>`, not an operator token. Partial failures land in the completion detail.

### fix(auth): do not spend a magic link on GET (cp#437)

`GET /auth/email/callback` rendered a session from an unauthenticated GET, so the first fetch
won: mail scanners, prefetch, and preview fetches burned the link. The GET now serves a confirm
page and changes nothing. `POST /auth/email/callback` with the form token is the spend.

A POST of the mailed URL with no form body does not consume the token. Remaining bearer
property: a client that submits the form still spends it. That is the product.

Test: GET (including `Purpose: prefetch`) leaves `consumed_at` null; POST after GET signs in;
an intent-audit throw leaves resources in place on both teardown paths.

### fix(provision): a refused finishJob must not roll back a succeeded studio (cp#461)

`finishJob` reports whether it actually closed a row, and a caller pairing it with a tenant-status
write MUST branch on the result (cp#443). Both reap sites already do. `runProvisionJob` and
`continueProvisionJob` did not.

The reachable corner is a zombie driver: it loses its lease, a successor finishes the provision,
then the zombie fails. `finishJob` correctly refuses. The catch still wrote `setTenantStatus(failed)`
and `rollbackFailedProvision`, which deletes the D1, R2 bucket, and token of a studio that
succeeded.

Both catch paths now treat a refused close as "this driver does not own the outcome": no tenant
write, no teardown.

Test: successor closes as succeeded inside the step that then throws; the zombie catch is reached
and the successor's studio is untouched. Watched red with the conditional removed.

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

### fix(onboarding): serve the real provision plan, so review is not empty (cp#474)

The review step called `GET /api/tenant/provision-plan` on every walk of the wizard. **The plane
did not serve that route.** The preview mock invented four RunPod endpoints and answered green, so
the flow was walkable in preview and blank in production, on the last screen before anything is
created.

The route now exists and its body is a projection of `PROVISION_PLAN`, the same array the
provisioner builds from. Own-iron rows carry `backing: "vpc"` and a null worker pin; pooled rows
carry the real GPU list and the pinned max. The review renderer stopped appending
"scale-to-zero" to every row, because half the plan is not a RunPod endpoint.

The go-live POST with no key is now an empty JSON body rather than `runpod_invoke_key:""`. Shared
tier already treated both as empty; sending a named empty field was the one leftover that still
looked like a key form.

cp#439, cp#428, cp#467, cp#447, cp#448, cp#449 and cp#435 were already true at this HEAD. This
closes the one wall that was still standing.

### fix(onboarding): burn the tenant invoke-key ritual

The tenant never pastes a RunPod key. `awaiting_invoke_key` was the BYOK parking
name; writes are now `awaiting_go_live`. The go-live route is
`POST /api/tenant/:id/go-live` (old `invoke-key` path still works). Front door
copy no longer asks for "one more key." hosted-tier.md no longer tells anyone
to mint two RunPod tokens. The plane's own `SHARED_RUNPOD_INVOKE_KEY` stays
what it is: our job credential, not a customer step.

### feat(admin): tenant usage view, wan-train on the shared pool, cloud i2v in the catalog

GET /api/admin/tenants/:id/usage lists every recorded RunPod / public-slug job
and every attributed AI Gateway row for that tenant, rolled up by module, with
optional SPEND_PRICEBOOK costs.

wan-train is an endpoint-backed plan key (RUNPOD_WAN_TRAIN_ENDPOINT_ID).
cf-grok-video / cf-seedance / cf-flux-3-video / cf-hh1-r2v join the tenant
catalog. Traefik door URLs stamp onto the studio when the plane vars are set.

## v1.27.0 -- 2026-08-15

### fix(readiness): a module that does not reach RunPod at an endpoint of ours can be READY (cp#396)

The first complete shared-tier provision reached `awaitingInvokeKey` and could not go live.
`finish-upscale` answered `/ready` with `door.bound:true`, `door.token:true`, `route:"vpc"` -- a
healthy module on our own hardware -- and `classifyReadyResponse` called it `misconfigured`, which
is explicitly not retryable, so the install threw.

The classifier required BOTH `runpod_api_key` and `runpod_endpoint_id` as booleans. That encodes an
assumption that every probed module reaches RunPod at an endpoint of ours. **Two whole families do
not, and both were in the probe population for every tenant.**

**DOOR-BACKED** (`finish-upscale`, `speech-upscale`). Runs on our own iron through a door, so the
plane binds no endpoint id BY DESIGN -- `PlannedVpcCapability` says "no endpoint id to bind ... on
purpose rather than by omission". It reported `runpod_endpoint_id:false` and fell to the final
`misconfigured`. The emitting module already says this in its own source: requiring RunPod
credentials of it *"would make a correctly-configured on-iron module report NOT READY, which is the
readiness probe reporting the opposite of the truth"*. cf#480 fixed that half; this is the half
that never followed.

**PUBLIC-SLUG** (the eight cost-door modules). Reaches RunPod at a fixed public vendor url baked
into the image, so it OMITS `runpod_endpoint_id` entirely. It failed one line EARLIER, on the
typeof guard. Every one of the eight carries `publicEndpoint` in the catalog and `reachesRunpod`
includes them, so they are probed for every tenant going live. **Fixing only the door would have
unblocked nothing.**

The predicate is now "does this module have the credentials ITS OWN route requires", read off what
the module reports rather than any list this repo maintains -- a second hand-maintained enumeration
would drift from the first exactly as the upload path drifted from this one.

**A FALSE PASS CLOSED IN THE OTHER DIRECTION.** Before this, a door-backed module with a DEAD door
(`token:false`) but healthy-looking RunPod credentials classified `ready`. The gate was wrong both
ways: it failed healthy on-iron modules and passed broken ones. Pinned by a test whose credentials
are deliberately both true, so only the door can produce the verdict.

**THREE FIXTURES THIS COULD HAVE BEEN WRITTEN WITH ARE IMPOSSIBLE ON THE WIRE**, and the contract
was read in the emitting repo rather than inferred from the captured sample:

- `door.bound:false` cannot occur. The module spreads the whole `door` key away when no door is
  bound, so `bound` is the literal `true` whenever the object exists. Absence is the signal.
- `door.route:"runpod"` cannot occur. There is no such value; on the RunPod path the object is
  absent.
- `route === "vpc"` is NOT a valid discriminator. `route` is a door LABEL, and its values are
  `"vpc"` and `"vpc-<host>"`. A deploy serving only the propagandhi door reports
  `"vpc-propagandhi"` and is perfectly healthy. **The first version of this fix compared route to
  "vpc" and would have failed that deploy**, passing every test written from the captured sample.
  There is now a test for it.

So `parseDoorBacking` narrows to ONE field, `token`, and ignores `bound`, `route` and `routes`.
Every field a narrowing insists on is a field whose rename in the other repo turns a healthy tenant
into a failed provision, and there is no shared type between the repos to keep them in step.

An UNREADABLE door falls through to the credentials rather than failing, deliberately choosing the
quieter option: this gate blocks every tenant going live, and cp#323 is the precedent where an
improvement in the other repo turned a benign verdict fatal and nobody could provision. Tolerating
it silently would be ignoring it, so the door is now reported on the OBSERVATION surface
(`TenantModuleObservation.door`), which also fixes an operator reading a healthy door-backed module
as broken because its `runpod_endpoint_id` is false.

Tests: every fixture is a body checked against the emitting source. Three mutations were planted
(door passes anything, public-slug ignores its key, the absent-endpoint branch removed) and each
produced a distinct red, because a test that only ever passes is decoration. **One dead test was
caught this way during development**: an `unreadable`-door assertion passed for the wrong reason,
since the fallthrough happened to yield the same verdict. It was rewritten to discriminate.

### fix(api): /api/me reports WHICH AUP version was accepted, so a re-gated owner is not shown a first-run screen (cp#433)

`GET /api/me` reported the AUP as `{ required_version, accepted }`, and `accepted` is an exact-version
match against an append-only table. That is correct and deliberate: bumping `AUP_VERSION` re-gates
every account by construction, with no migration and no grandfathering. Nothing here changes it.

What it could not do is tell two people apart. Somebody who has NEVER accepted anything and somebody
who accepted 1.0.0 while the plane moved to 1.1.0 both read `accepted: false`, and the payloads were
byte-identical, so the front door rendered the same screen at both: *One thing before you start. You
need to accept the acceptable-use policy before you can set up a studio.* For the second person that
is wrong on both halves. They are not starting, and they are not setting up a studio; they may have a
running one. This is live: the plane serves 1.1.0 and four accounts accepted 1.0.0 (see
`changelog.d/396-aup-1.1.0-and-pin-gate.md`, which counted them).

`aup.last_accepted` is added, additively, and is populated unconditionally rather than only when
refused, so no client has to know which branch it is in before it can read it:

    aup: { required_version, accepted, last_accepted: { version, accepted_at } | null }

`null` means never accepted anything. Present alongside `accepted: false` means the policy moved under
them, which is a returning owner rather than a new signup, and the panel can finally say the true
thing.

**The UI copy is NOT in this change, and it is tracked at cp#452.** That issue carries the enabling
sentence (the policy changed since you accepted version X on DATE; your studio keeps running;
review and accept to continue) and the note that the offline mock in public/onboarding-api.js is
populated only for its own accepted:true state, so a mock STALE state is a one-line addition left
deliberately to the copy PR rather than guessed at from the backend side.

**This closes an asymmetry the tree already held itself to.** `acceptAup` refuses a stale submission
precisely so nobody is recorded agreeing to wording they were never shown, and the client says
outright that *the policy changed while this page was open*. That honesty existed for the rare
mid-session case and was missing for the common between-sessions one.

Two design points worth stating, because both are places a plausible implementation goes wrong.

Ordering is `ORDER BY id DESC`, never by the version label. `AUP_VERSION` is a free-form string:
production has served `1.0.0` and `1.1.0`, test configuration uses date-shaped labels like
`2026-07-17`, and even inside semver `1.10.0` sorts before `1.9.0` lexicographically. `accepted_at` is second-granularity and ties. The row id
is the only column recording the order the rows arrived in, and the test uses a label pair where
every wrong ordering disagrees with the right one.

`accepted_at` is NORMALIZED to ISO-8601 UTC at the store boundary. The column is written only by the
SQLite `datetime(now)` default, which emits `2026-08-15 18:25:24`: space-separated, no zone. That was
measured against the real engine, not read off the schema, and the raw value is a trap rather than
merely ugly. Kotlin and Swift reject it outright, which is recoverable, but JavaScript `new Date()`
ACCEPTS it and reads it as LOCAL time, so a browser west of UTC would render a consent record hours
before it happened. An unrecognized value is returned raw rather than thrown on, because `/api/me` is
the route a re-gated account uses to discover why it is blocked and a display field must not be able
to 500 it.

Only `version` and `accepted_at` are projected. The row also carries `ip_hash`, `user_agent` and
`aup_sha256`; the caller being entitled to see their own row is not the same claim as needing every
column in it, and a test asserts the serialized payload carries none of them.

### fix(onboarding): read reclaimable, so nobody destroys their own studio by clicking Continue (cp#435)

GET /api/tenant/slug-available answers **available AND reclaimable**. The second is not decoration:
it means the name is free TO THIS ACCOUNT because the row behind it is that account own unfinished
studio. Provisioning over it is not a resume. It runs a teardown with deleteData true and rebuilds
from scratch.

**The client read only availability and printed "is free".** So an operator-provisioned owner,
following the front door own Finish setup link, landed on step 1 of a wizard that did not know his
studio existed, typed the name he already had, was told it was free, and by clicking Continue
deleted the D1 database, the R2 bucket, the R2 token and the studio worker that had been built for
him. No confirmation, no warning, no mention that a studio was there.

**The plane was never at fault.** It computes the distinction, projects it deliberately, and its own
route comment says the preview answers exactly two questions: can I take this name, and if so is it
fresh or my own unfinished studio. The client dropped the second answer on the floor.

Three outcomes now, never two. slugVerdict returns free, taken, or **reclaim**, and reclaim names
the consequence in the verb rather than hinting at it. The page carries a block that says the
database, the storage and the worker exist right now and that continuing deletes them, plus the
honest aside that somebody sent here to FINISH a studio is in the wrong place entirely.

**The gate demands an act, not a click.** canAdvance(name) is unchanged for an ordinary free name;
for a reclaimable one it additionally requires an explicit acknowledgement, and it will not accept a
truthy accident as consent to destroy a studio.

**Consent does not survive a slug edit.** A ticked box is consent to destroy ONE named studio, so
changing the name revokes it. Carrying it forward would let somebody acknowledge the deletion of one
studio and then provision over a different one, which is consent to something they were never shown.

**Watched red first:** 8 reds across two suites against merged main, controls green. The gate tests
fail there with "expected true to be false" -- main really does let you advance over your own studio
with no acknowledgement. Then driven in a REAL BROWSER against the shipped assets, probing with the
non-default value (reclaimable true): warning shown, Continue disabled; acknowledge, Continue
enabled; retype the name, acknowledgement revoked and Continue disabled again. The ordinary
free-name path was re-checked in the same session and is byte-for-byte the old behaviour.

**Review follow-up (ernst): the revocation was claimed, implemented and UNTESTED.** resetReclaimAck
existed and checkSlug called it, and deleting it broke nothing red. A behaviour only the prose
asserts is one the next refactor removes in silence.

So the revocation stopped being a side effect and became a PROPERTY: **consent records WHICH name it
was given for**, and the gate compares that against the name about to be destroyed. A boolean was
consent to whatever the box happened to sit next to. Now consent for one studio cannot open the gate
for another, the guard survives every DOM reset in the file being deleted, and it is testable
without a DOM.

The reset still runs, because it is what stops a stale TICK sitting on screen next to a name it no
longer applies to, and both halves of its wiring are now asserted against the shipped file: it
clears the flag, the recorded consent and the checkbox, and it runs BEFORE the request rather than
after, so a slow answer cannot leave an old tick standing through the whole round trip.

**Each new test was probed by breaking what it guards**, not by reading it: dropping the consent
clear turns the wiring test red, moving the reset after the fetch turns the order test red, and
reverting the gate to a plain boolean turns all three behavioural tests red. Then re-driven in a
browser, including the exact residual review named: acknowledge alpha, edit to beta, come BACK to
alpha without re-ticking. Continue stays disabled.

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

## The SECOND wall, on the same missing-projection pattern

The key step of the wizard sits BEFORE provisioning and gated advance on a non-empty key, so a
shared-tier tenant could not even PROVISION, let alone go live. Same root cause, different moment,
and `tenantView.runpod_mode` cannot fix it: at that point no tenant row exists yet.

The deciding fact is plane-level. `POST /api/tenant/provision` refuses a keyless provision only when
`!offersSharedTier()`, but that predicate was projected on NO client surface at all --
`/api/platform/config` carried `signups_enabled`, `aup_version` and `auth_methods` and nothing about
the tier. So no client could know a key was optional. That is the same defect as cp#433 and the
tenant half of cp#439, for the THIRD time: a distinction the backend computes correctly and does not
project.

`shared_tier_available` now rides on `/api/platform/config`. It is asserted TRUE (the non-default
value; the wiring double returns false) and FALSE, and then asserted to AGREE WITH THE PROVISION
ROUTE in both directions -- a boolean a client renders from is worthless unless it predicts the
refusal it exists to prevent, so the test drives the config route and the provision route together
rather than trusting they read the same predicate.

**Scoped, NOT fixed here: `handoffInstall` has the same hole.** It refuses an empty key up front
(`invoke_key_required`) and calls `performInvokeKeyInstall` directly, skipping the shared branch
entirely, so the pool path is structurally unreachable through the operator handoff and a shared
tenant owner who follows a handoff link has no way to succeed. Not fixed here because there are two
defensible fixes with different blast radii (accept an empty key on the handoff route for shared
tenants, or refuse to ISSUE a handoff for a shared tenant at all), and choosing between them is a
product decision on a custody path, not a defect fix. Filed as cp#454, so the deferral has an
enumerating issue rather than living in a PR comment.

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

### fix(onboarding): boot from the account, so a fresh load lands where the tenant actually is (cp#455)

init() called show("what") unconditionally and never read GET /api/me. That single fact is the root
under five separate defects, because a self-served tenant PASSES THROUGH these screens while an
operator-provisioned one ARRIVES at them, and every step after the first kept what it needed in
page memory a fresh arrival does not have.

The front door already computes the right destination from the same payload, routes people here on
purpose (finish your setup, watch the progress, see what happened), and then hands off to a page
that throws all of it away.

**What a fresh load does now**, from the account rather than from nothing: no tenant goes to step 1
exactly as today; pending or provisioning resumes the real build; awaiting_invoke_key lands on the
render-key step; failed shows the failure; live shows the finished screen.

**And a state the wizard has no screen for returns NULL rather than a guess.** Suspended, deleting,
deleted and anything unmodelled are real states the FRONT DOOR has screens for; starting a setup
wizard for a deleted studio would be exactly the confidently-wrong screen this issue is about.

**It recovers the state the later steps assumed they had.** state.tenantId had exactly ONE
assignment, inside runProvision, which is why a fresh arrival POSTed to /api/tenant/null/invoke-key
and was then told its key was rejected (cp#447). Endpoints come off the payload too, so the list is
populated rather than sitting on a literal loading... forever (cp#449) -- and that fake loading
state is gone from the markup, because a spinner-shaped word hides the honest reading.

**The wizard still OPENS at step 1 and the resume runs after, deliberately.** The self-served
visitor is the common case, must see no delay, and must not have a screen swapped under them for a
tenant they do not have.

**NO NEW BACKEND FIELD.** /api/me already carried the account, the tenant, its status and its
endpoints. The information was there the whole time; only the page refused to look.

**Watched red first: 12 against merged main, controls green.** Then driven in a real browser on the
shipped assets against a plane serving each state: awaiting_invoke_key lands on the render-key step
with the endpoints rendered from the payload; failed shows invocation lost: no progress for over 10
minutes and no longer pitches a fresh studio; and the regression control, an account with NO tenant,
still lands on step 1 with Continue enabled and nothing swapped under it.

### One credential now uploads every script that attaches a VPC binding (cp#464)

Module worker uploads move onto the SCRIPT UPLOAD credential, the same one the studio upload has
used since cf#118. Before this, two different credentials uploaded worker scripts and only one of
them had ever been granted the Connectivity Directory access a vpc_service binding requires. The
door pool attaches those bindings to MODULE workers, so it was uploading with a credential that
could not attach them; nothing stated the two had to match, and nothing detected that they had
diverged. The first symptom was a provision dying on it.

The module upload also gains the cf#118 guard, which it never had: a refusal now arrives as a
sentence naming the plane credential rather than as raw Cloudflare prose about the caller.

And the guard now reports its own obsolescence. A predicate keyed on a vendor error code has an
expiry date nobody wrote down: when the vendor renumbers, a boolean guard answers false forever and
nothing anywhere says it stopped working. When a VPC binding fails and the known code does NOT
match, the codes Cloudflare actually returned are logged, which turns the first silent miss into a
loud one. The code itself is now defined ONCE rather than in two independent copies feeding three
call sites.

## v1.26.0 -- 2026-08-15

### fix(front-door): signing in and signing up are two different questions (cp#428)

With `signups_enabled: false` -- which is the LIVE setting today, and correct, because signups ship
last by ruling -- the hosted front door replaced its entire signed-out screen with a closed notice.
That notice carries no sign-in control. **An account that already existed had no way back into a
studio it already owned.**

Measured on https://studio.vivijure.com before the fix: the whole document had four interactive
elements (brand, self-host link, report-abuse, abuse mailto). No email field, no button.

**The plane was never the problem and is unchanged.** `POST /api/auth/email/start` mails the link to
an address that already has an account while the switch is off, and `src/index.ts` states the rule
in as many words: signups_enabled means can NEW accounts be created, full stop. Only the UI
conflated that with can a KNOWN person get back in.

**Signups stay CLOSED. `signups_enabled` is not touched.**

`shellRoute` no longer takes the platform config AT ALL. The route is a fact about the SESSION; the
switch is a fact about new accounts, answered separately by `signupsOpen(config)`. Keeping the
switch out of the routing function is what stops the two being conflated again, and the test asserts
the arity so a future edit cannot quietly re-admit it.

The signed-out screen is now ONE panel. The switch changes its COPY: a different title and lede, and
the closed-signups callout in place of the pricing one. **The closed copy keeps its voice**, self-host
link and all, down to the line about it not being a consolation prize. The copy was never the bug;
arriving INSTEAD of the way in was.

**Enumeration safety is preserved and asserted.** The 202 is still uninformative, the submit still
lands on the same link-sent screen for every outcome, and the closed-signups text is a fact about the
PLANE that reads identically for every visitor, so it reveals nothing about any address.

**`onboarding.js` carried the same defect one page over**, and worse: a closed switch disabled every
`[data-next]` on the page, freezing exactly the person the plane goes out of its way not to strand.
An operator-provisioned tenant reaches that page to hand over its render key, so a disabled Next is
the difference between a studio that finishes and one that cannot. The banner and the disable now
follow the SESSION, and a `/api/me` failure that is not 401/403 leaves the flow alone rather than
inventing a refusal the plane never made.

**Watched failing first.** Against `main`: 7 reds across the two suites, with every positive control
green (a renamed or empty asset cannot pass these by matching nothing). Then driven in a real
browser against the LIVE plane answer, not jsdom: sign-in reachable with the switch off, submitted,
and the same link-sent screen.

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

## v1.25.0 -- 2026-08-15

**THIS TAG ARMS THE HOSTED SHARED TIER FOR THE FIRST TIME.** Everything below was staged across
three merges; the tag is what fires it. Recorded plainly because whoever reads this later needs to
know this was the moment, not one of the releases around it.

Four things happen at once:

1. **The shared tier is OFFERED where it never has been.** `SHARED_RUNPOD_ENDPOINTS` is written
   with two entries (`backend` and `lipsync`), so `offersSharedTier()` returns true for the first
   time and `POST /api/admin/tenants/provision` stops answering `503 shared_tier_unavailable`.
2. **The deploy-time scope gate runs armed for the first time.** It arms itself off the pool
   variable being non-empty, so that expression has never evaluated true before this deploy. It
   verifies the shared invoke key reaches every endpoint the pool names, and REFUSES the deploy
   otherwise.
3. **Existing accounts get `403 aup_required` until each accepts AUP 1.1.0.** Four accounts exist,
   all internal; no external account can be interrupted by this.
4. **The own-iron door pool goes live.** Tenant video and audio upscale reach hardware we operate
   over Workers VPC bindings rather than RunPod endpoints.

**Why the pool has two entries and not four.** Until the transport split below, a complete pool was
unwritable: it had to name an endpoint for every plan key, including the two upscale capabilities,
and the shared invoke key is deliberately scoped with no access to those. The config could be
complete or reachable, never both. Trimming the pool to the endpoint-backed capabilities is what
made the variable writable at all, and it is the reason this release can be armed.

**One deliberate regression, recorded rather than discovered.** A dedicated (BYOK) tenant no longer
receives RunPod endpoints for video or audio upscale; it reaches our own hardware instead. That is
an accepted, deferred cost of shipping the shared tier first, it affects no live tenant, and the
full enumeration of what a BYOK tenant loses and what a backport must restore is filed separately.

**Operator note.** Provisioning now requires the own-iron door values to be configured. A
vpc-backed capability with no door has no transport at all, so the plane refuses at
`modules_upload` and names the variables to set, rather than provisioning a studio that dies at a
tenant first render.

### feat(runpod): a vpc-backed capability carries a DOOR POOL, one per GPU box (cp#396)

`vivijure-cf` at the pinned v1.28.0 does not read ONE door per capability. Both `finish-upscale`
and `speech-upscale` build `doorPool([...])` from a candidate per box and round-robin with
`pickDoor`: `FINISH_UPSCALE_VPC` + `FINISH_DOOR_TOKEN` for fatmike, and
`FINISH_UPSCALE_VPC_PROPAGANDHI` + `FINISH_DOOR_TOKEN_PROPAGANDHI` for propagandhi. **Four bindings
per capability, not two.**

The first cut of the transport split bound only the legacy door. Not wrong -- `pickDoor` is
`n % pool.length`, so a pool of one is a working pool -- but it would have **concentrated every
tenant render on one box while the other idled**, diverging from the operator studio that already
pools both, with no signal attached to the difference.

`PlannedVpcCapability` now carries `doors: PlannedDoor[]`, `resolveVpcDoors` resolves each, and
`uploadTenantModules` binds every configured one.

**THE REFUSAL LOOSENS TO ZERO DOORS, not fewer-than-all.** A partly-wired plane still provisions and
simply concentrates on the box it has; only an empty pool has no transport at all. Both-or-neither
still applies WITHIN a door: a binding without its bearer is dropped and logged naming both vars,
because attaching it would upload clean and 401 on every render.

**ORDER IS LOAD-BEARING and is asserted.** The legacy door is first and keeps the bare
`DOOR_ROUTE_NAME`, which is what an in-flight poll token carries; `resolveDoor` is a LOOKUP by that
name rather than a pick, so polling any door but the one that MINTED a job reports a live job as
GONE. Reordering the array is the kind of change that looks like tidying and is not.

**`resolveVpcDoors` iterates the PLAN**, so a secret whose name no plan door references is never
read and never reaches an upload. That is what made it safe to set the second-door values before
this landed: they sat inert rather than half-attaching anything.

**The failure mode worth knowing:** setting ONLY the propagandhi ids leaves the legacy-named
capability with no door and refuses every provision at `modules_upload`. The names do not make the
legacy/second relationship obvious, and the legacy pair is the FATMIKE one.

Test fixtures now derive their doors from the plan (`tests/door-fixture.ts`) rather than listing
them, so a third box is a plan edit and nothing else. **Watched failing on the real regression:**
binding only the first door turns both the module-binding and provisioner transport assertions red.
Each door is also asserted to carry its OWN service id, so a copy-paste pointing both at one box
fails rather than silently halving the pool back down.

### feat(runpod): PROVISION_PLAN capabilities carry a TRANSPORT, so upscale reaches our own iron (cp#396)

`SHARED_RUNPOD_ENDPOINTS` is all-or-nothing across plan keys, and the shared invoke key was minted
with NO access to `vivijure-video-upscale` or `vivijure-audio-upscale` because those two run as
always-on serve containers on GPU hardware we operate. **So the correct pool config could not be
WRITTEN AT ALL**: four keys demanded, two of which must not exist. The ruling lived in the
credential and not in the code, and nothing could report the disagreement.

A capability now declares how it is REACHED. `backend` and `lipsync` stay endpoint-backed.
`upscale` and `audio-upscale` are vpc-backed: the tenant MODULE worker reaches them over a Workers
VPC service binding. **A capability is never removed from a tenant, only re-routed** -- a shared
tenant keeps full upscale and reaches our GPU boxes instead of RunPod, consuming no RunPod quota.

`requiredPoolKeys()` now demands coverage for endpoint-backed entries only, which is what makes
`SHARED_RUNPOD_ENDPOINTS` writable with the key exactly as it is already scoped. That was the
point of the change.

**THE BINDING GOES ON THE MODULE, NOT THE STUDIO, and getting that wrong is silent.** Upscale is a
module capability: the studio dispatches to a module worker, and the module worker is what talks to
RunPod or to a door. The names are not ours to choose -- vivijure-cf declares them (cf#480, shipped
v1.21.0, present in the pinned v1.28.0): `FINISH_UPSCALE_VPC` + `FINISH_DOOR_TOKEN` on
`modules/finish-upscale`, `SPEECH_UPSCALE_VPC` + `SPEECH_DOOR_TOKEN` on `speech-upscale`.
`doorBound()` short-circuits before `credentialProblem`, so a door-bound module is bound NO
`RUNPOD_ENDPOINT_ID` at all; binding an empty string to satisfy a shape is exactly the first-render
failure this removes. A binding attached to the studio under a name nothing reads would upload
clean and change nothing.

**THE GUARD THAT SHOULD HAVE EXISTED, and now does.** `uploadTenantModules` throws when a catalog
`endpointKey` has no endpoint. Trimming the plan orphaned `finish-upscale` and `speech-upscale`,
so an earlier attempt at this split **killed every provision, shared and dedicated, at
`modules_upload`** while typecheck was clean and the suite was fully green. Nothing could see it:
the provisioner fixtures were hand-written four-entry endpoint literals, so they passed by asserting
a shape the code could no longer produce. **A fixture that hardcodes what it should derive cannot
fail when the source of truth moves** -- the same defect class as `requiredPoolKeys()` deriving from
the plan, inverted.

`tests/module-transport-coupling.test.ts` reads both real lists and asks the question neither can
answer alone. **Watched failing on the real defect**, not just written: deleting the `upscale`
capability from `PROVISION_PLAN` turns it red naming `finish-upscale`. It carries a seeded-offender
control and a disjointness control, so it cannot pass by comparing two empty sets. The guard also
distinguishes THREE cases where there were two -- no key, key-but-vpc-backed, key-but-missing -- and
only the third still throws.

Every fixture that hardcoded the four-endpoint world is now DERIVED from the plan, so this class
cannot recur silently.

**A NEW HARD PRECONDITION, and it is the thing to know before deploying.** A vpc-backed capability
with no door configured has no transport at all, so `uploadTenantModules` REFUSES and names both
vars. **Until the door vars are set, no tenant can be provisioned.** That is the correct failure
direction -- refusing at provision beats dying at a tenant first render -- but it is a precondition
that did not exist before. Four values, and both halves of each door are required:

| var | contains |
|---|---|
| `FINISH_UPSCALE_VPC_SERVICE_ID` | Connectivity Directory service id for the video upscale door |
| `FINISH_DOOR_TOKEN` | that container LOCAL_FINISH_TOKEN bearer |
| `SPEECH_UPSCALE_VPC_SERVICE_ID` | Connectivity Directory service id for the audio upscale door |
| `SPEECH_DOOR_TOKEN` | that container LOCAL_FINISH_TOKEN bearer |

BOTH OR NEITHER per door: a binding without its bearer is not a partial rollout, it is a module that
switches transport and is then refused 401 on every call. `resolveVpcDoors` drops a half-set door
and logs both var names, because an operator who set one has no other way to find out.

Also derives the endpoint COUNT in `quotaGuidance` from the plan; it read a hardcoded "4 endpoints"
in a tenant-facing message, which the split made simply false.

### ci(deploy): refuse a deploy whose shared pool names an endpoint the invoke key cannot reach (cp#396, cp#389)

`SHARED_RUNPOD_ENDPOINTS` is a repository VARIABLE and `SHARED_RUNPOD_INVOKE_KEY` is a SECRET.
They are set independently, by hand, at different times, and nothing compared them. There is no
RunPod API that reports a key permission set, so the plane cannot read its own credential scope
from code.

Every existing check passes while the two disagree: the pool parses, `requiredPoolKeys()` is
satisfied, provisioning succeeds and the studio is served. The tenant finds it at their FIRST
RENDER, on whichever capability the key does not cover. It is the same quiet-degrade shape
`runpod-pool.ts` refuses a partial pool for, one layer up: **a pool can be COMPLETE and still be
unreachable.**

`src/shared-pool-scope.ts` closes it on the deploy path, and it composes the existing probe rather
than adding a second one. `verifyInvokeKeyScope` already answers exactly this question at tenant
paste time (#52 / #60): `GET /v2/<id>/health` returns 200 in scope and 403 out of it, per
endpoint, ENFORCED by RunPod rather than asserted by us. Two probes that could disagree about one
key would be worse than none.

**This is not hypothetical, and the gate says so about the CURRENT plan.** A valid pool must name
an endpoint for the `upscale` plan key, that endpoint is `4q8idwbk6tyqbq`
(`vivijure-video-upscale`, live on the account), and the shared invoke key is minted with no
access to it. So arming the shared tier today produces exactly this refusal. That is the gate
working, and it is what should block cp#389 until either the key scope or the plan changes. The
refusal names the endpoint and never the key.

**The gate was watched failing on each of its three refusals, not merely written.** Mutating the
scope branch so it never refuses turns the two refusal tests red and leaves the other seven green,
so they discriminate rather than decorate. `SHARED_POOL_SCOPE_REQUIRED=1` with nothing configured
fails and names both absent vars. Setting one half and not the other fails in EVERY mode, which is
deliberate: gating that check on REQUIRED would have let the misconfiguration nearest this file
skip silently.

**The out-of-scope fixture is a real endpoint, and that is the point.** A made-up id would also
produce a refusal, and it would read identically while meaning something else entirely: nothing
there, rather than there and refused. The live control probes that endpoint on its own, so it
holds whether or not the pool names it, and asserts the reason is `endpoint_out_of_scope` rather
than a dead or over-powerful key.

It arms itself off the variable (`SHARED_RUNPOD_ENDPOINTS` non-empty), because an empty pool is a
legitimate value meaning this plane offers no shared tier. Forcing the gate on would fail a
correct deploy; leaving it optional would let a declared tier go unproven.

Also, two refusal MESSAGES that misattributed their own cause. `verifyInvokeKeyScope` told an
operator to scope a key to "your 4 vivijure endpoints" and "all four" from hardcoded literals;
both now derive from the endpoint list, so a plane whose plan holds a different number stops
printing a figure that is simply wrong. A refusal naming the wrong knob sends the reader to it.

## v1.24.0 -- 2026-08-15

### fix(admin): module-readiness reports the uncertainty instead of settling it (cp#254)

`GET /api/admin/tenants/:id/module-readiness` sampled `/ready` twice, 250ms apart, returned the
second sample and discarded the first (PR #349, `bf35182be2`). cp#254 had ruled against settling
inside the route and for reporting the uncertainty, and the merged change did neither: it settled,
badly, and reported nothing about it.

Badly, because of the measured numbers. The convergence window on the replace path is 40 to 50
seconds (reproduced live twice: `TFTFFF` and `FTFFF`), so two samples 250ms apart are two reads of
one transient. On `FTFFF` the second read is `true`, and the worker it described was a `keyframe`
re-uploaded with `TELEMETRY_DB` REMOVED -- the negative control, answered wrong, and now wearing the
appearance of a second opinion. A caller could not tell a mid-convergence answer from a settled one,
which is the defect cp#254 was filed for.

Both samples are now kept. Each module carries `readings` (what every sample said, in order),
`reads` (the denominator) and `settled` (every sample agreed). `job_log` is still the last reading,
and is documented as a reading rather than a conclusion. `records_unproven` no longer counts an
unsettled `"ok"` as proof, and a new `unsettled` array names the modules whose reads disagreed, so
an operator re-asks instead of re-provisioning. `settled: true` is deliberately weak (nothing in
this probe contradicted the value, across a gap far shorter than the window); `settled: false` is
the strong direction and is positive proof the reading is still moving.

A read that never reached the module is kept apart from a module that answered without the field:
both are `job_log: null`, and only the per-sample state (`unreachable` versus `absent`) separates a
control plane that cannot dispatch from a tenant image too old to say.

The pre-deploy smoke now CALLS the shipped summary function instead of restating the route predicate
"character for character" with a comment asking future readers not to let the two diverge.

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

### feat(teardown): record resource ownership at provision (cp#106 option D)

Physical D1 / R2 bucket / R2 token / studio script ids are now claimed in `tenant_resource_ownership`
when the provisioner writes them. Teardown allows the **recorded owner** past tombstone-only
referrers without inventing silent last-referrer-wins. Live referrers still always refuse. Rows with
no ownership claim (legacy) keep the refuse-all-referrers default until re-provision or operator
`i_own` (cp#334).

### test(runpod): guard the downstream backend-label copies against a training clause (cp#367)

The backend endpoint purpose/label was hand-copied in three downstream places besides its source
in `PROVISION_PLAN` (`src/runpod.ts`): `public/onboarding-checks.js`, `public/onboarding-api.js`,
and `docs/hosted-tier.md`. Only the source was guarded (`tests/runpod.test.ts`), so a re-added
training clause in any downstream copy stayed green.

`src/runpod.ts` now exports `NO_TRAINING_CLAUSE = /lora|train/i`, single-sourcing what was an
inline literal in that test file. A new `tests/backend-label-copies-no-training-367.test.ts`
asserts each downstream copy against the same pattern, reading each purpose/label field through
the module data itself (never a whole-file text scan, which would wrongly flag the `cp#303`
comments that document the invariant and contain the word training), plus a test pinning the
count of downstream copies found.

### feat(ci): fail when STUDIO_RELEASE trails the published studio artifact (cf#372)

`STUDIO_RELEASE` is the single value deciding which studio code a hosted tenant runs, and self-host
pulls the same tag straight from the vivijure-cf release. When the pin trails, hosted and self-host
run different code from the same nominal tag, against the absolute hosted/self-host parity
invariant. Nothing anywhere compared those two numbers, so the parity gate read green at the TAG
while being violated at the RUNTIME; the pin went stale three times, and twice the remedy was to
bump the value, which has a 100% recurrence rate.

`scripts/check-studio-pin.mjs` is a sibling of `check-satellite-pins.mjs` and deliberately its
shape: exit 0 current, 1 real drift, 2 could not be PERFORMED and never a pass. RELEASE mode is
credential-free and now runs in `deploy.yml` preflight, so **a control-plane deploy refuses while
its pin trails the latest published studio release** -- advancing the pin stops being a follow-up to
a release and becomes a precondition of one. It is deliberately not the deployed-binding mode
there: during a deploy that binding is exactly what is about to change, and a check that fires on
normal operation is a check somebody mutes.

The second mode is why this is two checks rather than one. The Actions variable is a PROPOSAL:
`render-wrangler.sh` interpolates it into `[vars]` at DEPLOY time and `deploy.yml` fires on a `v*`
tag only, so between setting the variable and cutting a tag the variable reads NEW and the deployed
binding reads OLD. Measured 2026-08-14, control first: variable `v1.26.0`, latest published release
`v1.26.0`, **deployed binding `v1.20.0`**. A check reading only the variable would have been green
with hosted six releases behind. `studio-pin-drift.yml` runs daily on `ubuntu-latest` and reads the
live Worker binding, with a known-positive on the same credential and object class in the same run
because a scope-limited Cloudflare credential returns `success: true` with an empty result.

No tolerance knob, deliberately: a chosen hosted lag is a legitimate answer and belongs in the
script as a reviewed change carrying its reason, not as an env var anyone can set to infinity in a
green run. `tests/workflow-guards.test.py` gains structural assertions so the wiring cannot vanish,
including an ABSENCE assertion that no workflow redirects the checker's endpoint bases -- the one
edit that would leave it green while measuring nothing.

### fix(routing): `tenantRefusal` fails CLOSED on an unmodelled tenant status (cp#390)

`tenantRefusal` (`src/routing.ts:148`) switched on `tenant.status` with no `default` arm. In this
function `null` does not mean "no opinion" -- it MEANS dispatch, and a fall-through returned
`undefined`, which is falsy at its single call site's `if (refused)`. So a tenant whose status the
switch does not model was served the studio rather than refused: the most successful-looking
outcome available, with no error and no log line. That silence is why it survived; from the outside
an unmodelled status and a healthy `live` tenant behaved identically.

`TenantLifecycle` is a COMPILE-TIME claim about a string D1 hands back, so the type system does not
close this. typecheck catches someone adding a state (TS2366 fires on this function), but not a
value arriving at RUNTIME: `tenants.status` is `TEXT NOT NULL` with **no CHECK constraint**, unlike
`credit_holds.status` and `llm_spend_rollup.status` which both carry one. A hand-run migration, a
manual UPDATE, or version skew between a deploy that knows a new state and one that does not all
reach the switch with a value outside the union.

The switch now has an explicit `default` that emits a structured `routing.lifecycle_unmodelled`
event carrying the tenant id and the unrecognised value, then refuses with a 404 -- loud in the log,
generic on the wire. This matches the direction `routingStatusFor()` in `tenant-resolver.ts` already
documents for the same column; two projections of one column falling opposite ways was the defect.

### fix(routing): `routing.lifecycle_unmodelled` gates the status key on PRESENCE, not on type (cp#392)

The cp#392 fix stopped an absent status rendering as the literal string `"undefined"` by including
the `status` key only when the field is a string. That dropped every non-string too, so a status
that is PRESENT and holds `7`, `null`, `true` or an object rendered exactly like a column that is
not there. The event could no longer tell "no status column" from "status held 7", which is the
same ambiguity cp#392 was opened about, inverted.

The key is now included whenever the field is PRESENT on the row. The value keeps its JSON type,
so `7` and `"7"` stay different in the log. Values JSON cannot carry faithfully or safely
(object, array, bigint, symbol, function, a present-but-undefined value, NaN, Infinity) render as
a bracketed type tag such as `[unloggable object]` rather than a plausible-looking string; the
bigint case also keeps `JSON.stringify` from throwing on the refusal path. An absent status still
omits the key entirely, unchanged.

### fix(routing): `routing.lifecycle_unmodelled` no longer renders an absent status as `"undefined"` (cp#392)

The `default` arm added in cp#390 emitted the unrecognised status via
`String((tenant as { status: unknown }).status)`. When `tenant.status` is absent,
`String(undefined)` yields the literal string `"undefined"`, a normal-looking JSON value
indistinguishable from a status column that genuinely holds those six characters. The event exists
to be the only signal on this fail-closed path, so an absence rendered as a plausible value defeats
the point of logging it.

The `status` key is now included only when the field is actually a string; an absent status omits
the key entirely, the same honesty `JSON.stringify` already gives the `tenant` key when
`tenant.id` is absent. An unmodelled-but-present status (e.g. `"archived"`) is still logged
verbatim, unchanged.

### fix(legal): AUP 1.1.0 as a new version, and a gate that stops the label and the bytes drifting apart (cp#396)

`AUP_VERSION` names a policy document and `AUP_URL` points at one, and nothing tied the two
together. On 2026-08-14 `AUP_URL` was repointed at a different document while `AUP_VERSION` stayed
`1.0.0`. The change sat staged in the repository variables, invisible at runtime, armed to swap the
accepted policy text on the next deploy of this Worker for any unrelated reason. Nobody had to
intend it, and nothing would have reported it.

A count against the live control-plane D1 settles what that would have cost: **4 accounts have
accepted 1.0.0** (2026-07-17, 2026-07-25 twice, 2026-08-01), every row recording sha256
`1072c782`. Under the first-serve rule in `docs/legal/hosted/README.md`, 1.0.0 froze the moment it
was served, so the cp#394 correction ships as **`aup/1.1.0.md`**, a new file, rather than as an
edit to the version those four people agreed to. MINOR and not PATCH: 1.1.0 scopes a claim that
1.0.0 makes of ALL tenants (that rendering happens on GPU endpoints running on the tenant own
RunPod account, false for a pooled tenant per `provisioner.ts:202`), which changes what a person
is agreeing to rather than correcting a typo.

`scripts/check-aup-pin.sh` now runs in both deploy jobs before the render. It fetches `AUP_URL`,
hashes the bytes, and refuses the deploy unless they match the sha256 recorded for `AUP_VERSION` in
the new `docs/legal/hosted/aup/SHA256SUMS`. Bump the version without re-pinning the pointer and it
refuses; move the pointer without cutting a version and it refuses; a version with no recorded sha
refuses too, because an unverifiable document is exactly what should not reach a signup gate.

**The endpoint could never have caught this, and it looks like it should have.**
`GET /api/aup/current` returns a `sha256`, but `src/index.ts` computes it at request time from the
bytes it has just fetched, so it agrees with whatever it serves by construction and has nothing to
disagree WITH. A checksum computed downstream of the thing it guards is a receipt, not a control.
The recorded sha is the independent value it can finally be compared against.

Two facts this turned up, recorded in `docs/legal/hosted/README.md` rather than left in a comment
thread. The version changelog claimed both in-place amendments to 1.0.0 were legitimate because
they were pre-serve with zero acceptance records; the count shows the 2026-07-28 amendment landed
after THREE acceptances and the 2026-08-14 one after all four. And no revision of `aup/1.0.0.md` in
this repository has ever hashed to the served value, across all three of its commits: the document
four people accepted exists only in `vivijure-cf` at an orphaned commit. **That file has now been restored** from `vivijure-cf@8a5d96b4` and verified to hash to the
served value. Restoring a frozen version file is not a violation of the freeze: the rule binds
the bytes that were SERVED, and `AUP_URL` still points at the cf commit, so this corrects the
record and changes nothing a tenant can reach. `scripts/check-aup-files-immutable.sh` now hashes
every version file against `SHA256SUMS` on every CI run, which is the check that would have
caught all three in-place edits.

1.1.0 also drops the `Status: DRAFT, not in force` line. The gate hard-blocks live accounts
until they accept; asking them to accept a document that disclaims its own force is either a
false label or a theatrical gate, and it cannot be both.

## v1.23.0 -- 2026-08-13

### docs(modules): control-plane.md matches the shipped 15-entry catalog (cp#284)

`docs/control-plane.md` still described the tenant module bridge as six endpoint-backed workers and
"all six" recording modules. That was true after wave 0 (`finish-rife`) and false after wave 1
(the eight GPUless cost-door rows, plane PR #317 / studio release bundles from cf PR #406). The
section now states the three binding shapes (endpoint-backed, public-slug cost door, AI Gateway),
the `reachesRunpod` population rule, the tenant-R2 refuse path, and which studio/plane pins first
carried the door. No code change -- the catalog and provisioner already ship this on main.
### Docs
- **Docs audit 2026-08-05:** tenant module catalog count; hosted-tier status; managed-compute shipped-vs-design; deploy-runbook plane banner.
- **Standing WAF watch for OWASP 949110 (cp#14).** `docs/waf-post-enforce-watch.md` -- enforce mode has no pre-block signal; keep 949110 at zero on legitimate surfaces.
- **RunPod terms / metered-resale research (cp#287).** Landed Ernst's public-document read at
  `docs/legal/runpod-terms-resale.md` (not legal advice). Consent tripwire, DPA, AUP items for tenants.

- **CI vs deploy guard census (cp#260).** `docs/ci-deploy-guard-census.md` enumerates every executable
  guard asset, where it runs, and the deliberate CI-only residual. Re-measured 2026-08-05 (pins now
  on both paths; `pr-body-guard` added).
### chore(onboarding): remove dead scopeVerdict helper (cp#30)

`scopeVerdict()` had no production caller after the cp#20 client fix (PR #29 deleted the only
reader of a probe payload no route emits). Removed the helper, its types, export, and unit tests.
Live invoke-key UX stays on reason-code copy (`invokeRejectionCopy` / `REJECTION_COPY`).
### fix(admin): module-readiness double-samples /ready after upgrades (cp#254)

`GET /api/admin/tenants/:id/module-readiness` was a single-shot probe. Right after a module upload,
`/ready` can be answered by a stale isolate, so one sample is not evidence either way.
`probeTenantModuleReadiness` now samples twice with a short (~250ms) gap and reports the second
sample. Not the multi-second key-install wait; only a cheap second look. Injectable timing keeps the
gap testable.
### fix(meter): audit the manual tick (and keep settlement audited) (cp#243)

`POST /api/admin/llm-meter/run` was gated `meter:operate` but wrote no `admin_audit` row. A forced
tick advances the ingestion watermark that later statements are built from, so the operator, the
action, and the outcome (`ran` / refusal reason) now land as `meter.tick_llm` (platform action, not
`tenant.read.*`). `POST /api/admin/meter-settle` already wrote `meter.settle_llm`; the gap was the
tick alone. Tests watch both the success and the 503 refusal paths write a row.
### Fixed

- **ci(release): PR CI validates the R2 mirror the provisioner reads, not only the GitHub release
  (cp#319).** `check-release-modules.py` against the GitHub release ran on every PR; the R2 mirror
  path (the one `module-bundle-r2.ts` actually fetches, with no fallback) ran only at deploy. A
  release that was perfect on GitHub but never mirrored therefore passed PR CI and failed at the
  most expensive point. Same-repo PRs now pass `--mirror-bucket` with the same
  `STUDIO_RELEASES_R2_TOKEN` deploy uses; forks keep the credential-free GitHub half and a
  `::notice::` names that the mirror was not checked. `workflow-guards.test.py` pins the shape so
  the two sources cannot diverge again without a structural red.
- **test(aig): credential-boundary guards derive their population from `TENANT_MODULE_CATALOG`
  (cp#314).** `tenant-aig-token.test.ts` looped a hardcoded list of endpoint-backed modules when
  asserting the AI Gateway trio never leaks. When `finish-rife` joined the catalog the guard stayed
  green and simply never looked -- the silent-gap shape, not a red stale assertion. Same doctrine
  the proxy suite already uses: derive the modules to inspect, keep the expectation about what
  must be absent. Attribution vars (`TENANT_ID` / `TENANT_SLUG`) now walk every non-gateway module
  too, not only `keyframe`.
### fix(docs): RunPod proxy census comment said 23 of 26 modules; measured 14 (cp#298)

`src/runpod-proxy-route-match.ts` claimed "23 of 26 modules" referenced `api.runpod.ai` at
vivijure-cf@d26db49. Re-measurement at that sha (and at b295309) is **14**, matching the census
already written in `src/runpod-proxy.ts` (8 public slug + 6 `RUNPOD_ENDPOINT_ID`). The count is
not load-bearing for routing, but a wrong measured figure in a source comment becomes scoping
evidence. Comment corrected; `tests/runpod-proxy-census.test.ts` pins the two comments to the
reproducible split so 23 cannot re-land.
### test(routes): type the provisioner double as every Wiring member (cp#307)

The route suite's provisioner seam double was a hand-written object of `vi.fn()` members,
structurally typed. Widening `ProvisionerWiring` (adding `currentRelease` for cp#301) produced
zero typecheck errors and eight runtime reds saying "currentRelease is not a function".

The double is now built as a `WiringDouble` mapped over `keyof ProvisionerWiring`, so a missing
member fails `tsc -p tsconfig.tests.json` at the factory with the member name. Same completeness
gate that production wiring already has; the suite can no longer invent a partial subject.
### fix(runpod-sweep): log gated refusals so a no-op is distinguishable from silence (cp#300)

`runRunpodJobSweep` already refused honestly when the pool credential was missing or unreadable
(`ran:false, reason:credential_unavailable`), but both early returns exited before the only tick
log line, and the scheduled caller discarded the return value. From outside the Worker a correctly
gated no-op and a silently broken sweep were identical: no log, no metric, no throw.

Every exit path now emits `runpod_sweep.tick` (including `ran:false`), at error level when the
sweep refused or left work unresolved. Matches the meter half of the same scheduled tick, which
already announced its own refusals.
### test(runpod-proxy): pin plane-refusal header wire name (cf#403)

`PLANE_REFUSAL_HEADER` is the same string literal in this repo and vivijure-cf with no shared
package. Both sides now pin `"x-vivijure-plane-refusal"` in
`tests/plane-refusal-header-contract.test.ts` so a one-sided rename fails CI before it restores the
forever-pend cf#398 / cp#288 closed. Docs: `docs/deploy.md`.
### feat(provision): bind AI + GATEWAY_ID on the tenant studio (cf#98)

Hosted planner / chat / enhance need `env.AI` and a resolvable `GATEWAY_ID` on the **studio** worker,
not only on plan-enhance modules. New provisions bind `AI` always (Workers AI local path when no
gateway is configured), and bind `GATEWAY_ID` + `CF_AIG_TOKEN` (both-or-neither) when
`TENANT_AI_GATEWAY_ID` is set. The studio Run token is a **separate** grant from the module token
(`…-aig-studio` vs `…-aig`) so compromise of one surface does not expose the other; teardown revokes
both by name.
### fix(admin): project lifecycle so suspended != deleted (cp#281)

`tenantView` projected suspension into a single `status` field, so a deleted tenant with a suspend
flag looked restorable on the admin list. Keep `status` as the existing suspended-or-lifecycle
projection for the API contract, and add **`lifecycle`** carrying the stored column verbatim so a
caller can answer "is this restorable?" without performing a state change.
### fix(ci): gate commit messages against issue-linking auto-close keywords (cp#265)

The PR-body guard (#263) covers the surface a human reads. On squash merge the squash body is the
**commit message**, not the PR body, and that is what GitHub auto-closes from. Enumerate every
commit on the PR and run the same matcher (`scripts/pr-body-guard.py`) over each message. Zero
commits in range is exit 2, never a vacuous pass. Self-test pins the caller.
### fix(provision): backend plan label no longer promises cast LoRA training (cp#303)

`PROVISION_PLAN`'s backend entry was labelled "Render (keyframes, video, cast LoRA training)".
Training does not run on that endpoint and cannot fall back to it: cast LoRA training is
fail-closed on its own satellite (`vivijure-wan-train` / `RUNPOD_WAN_TRAIN_ENDPOINT_ID`). The
label is tenant-visible (onboarding renders from the plan), so the clause was a product lie and
invited the inference that the shared pool already covers training because it covers `backend`.

Dropped the training clause on the plan label, the onboarding representative plan purpose strings,
and the hosted-tier docs table. A unit test pins the backend label so the promise cannot return.
### fix(provision): tell the truth when re-provision DESTROYS (cp#304)

A provision interrupted before the studio upload used to say *"start provisioning again to
continue"*. The retry works, but the word **continue** was a lie: the same slug hits the reclaim
path (`claim -> teardown(deleteData) -> blank -> new job`), which **destroys** the partial
environment and starts over. A promise that succeeds while doing something else is worse than one
that fails.

- Refusal messages (dedicated key-A, pre-mode rows, missing release pin, unrecognised mode, and the
  past-boundary corruption guards) now say this cannot be continued, name `POST /api/tenant/provision`,
  and state that re-provisioning the same name destroys and starts from scratch.
- `reclaim_teardown_failed` (the genuinely stuck population) no longer says "try again"; it says
  contact us, because there is no self-serve move while resource columns still name undeleted pieces.
- Onboarding copy that told the tenant to "pick up where this left off" now matches the destroy.

Destroy/reclaim behaviour is unchanged; only the contract text is fixed.
### feat(platform): `/api/platform/version` surfaces build identity, not only release (cp#289)

The route answered `{ control_plane_version }` only -- which release, not which build. Two deploys
at one tag (measured at v1.20.0) read identically, and the route was blind to whether a merge
between those deploys was live. Bound `CF_VERSION_METADATA` (Worker version id + upload timestamp)
and return it as `build.{id,timestamp,tag}` alongside the release. Null when unbound so tests and
older local configs stay honest. Comments and docs no longer claim the release field alone is
deploy identity.

### Fixed

- `.gitattributes`: corrected the comment's claim that the committed `CHANGELOG.md
  merge=union` attribute drains the legacy PR queue. It does not. Git reads a file's merge
  attribute from the pre-merge working tree, which during a drain is the PR branch, and
  every legacy PR predates the attribute -- so it is absent at the moment it would apply.
  Documented the recipe that does work (`git -c core.attributesFile=...`, which mutates no
  shared state), the structural checks a dumb union driver still requires, and why draining
  locally is preferable to `gh pr update-branch`. Verified bidirectionally on cp#336.
  Refs cp#358.

### Fixed

- Tenant module uploads now refuse a `RUNPOD_WORKERS_MAX` binding (cf#361). The cap is
  intentional on operator-hosted modules; on a tenant module it would let a tenant's own
  spec raise its worker ceiling. The refusal is asserted immediately before the upload,
  and a source-level pin keeps the call site from being deleted silently.

### Added

- `POST /api/admin/tenants/provision` creates an account for a named email address and
  provisions a studio for it on the shared tier (cp#376). This is what the launch gate's
  "a studio I provision" step needed: provisioning gates on session plus accepted AUP, so
  it needs an account, and account creation is the only thing `signups_enabled` gates, so
  until now the only way to reach a first tenant was to open public registration, which
  the ruling puts last.
- New operator scope `tenants:provision`, deliberately not folded into `tenants:write` or
  `studio:operate`. It is the only capability that brings an account holder into existence,
  and account creation is exactly what `platform:settings` gates through `signups_enabled`;
  a capability that routes around another scope's control must not be implied by a third.

The route accepts no `runpod_api_key` and refuses a body carrying one, so an
operator-provisioned tenant always lands on the shared pool and never receives a RunPod key
on our account. It records no AUP acceptance and asserts none on the owner's behalf: the
tenant stops at `awaiting_invoke_key` and can only be promoted through the owner's own
AUP-gated request. Every use writes two `admin_audit` rows naming the authenticated
operator, and the request row is written before anything is created, so a failed audit
write fails the operation.

### Fixed

- The module readiness route reports `telemetry.job_log` again (cp#378). Modules have emitted a
  tri-state string (`"ok" | "unavailable" | "unknown"`) since vivijure-cf 815c9ff0 on 2026-08-01;
  this plane accepted only a boolean, so every one of the 14 recording modules coerced to `null`
  for twelve days and `GET /api/admin/tenants/:id/module-readiness` could not prove any module
  would record. The plane now learns the string rather than the modules reverting to a boolean,
  which would undo cf#284 and re-create the conflation between "a binding is attached" and "it can
  actually record".

  `job_log` carries FOUR states rather than being mapped onto `boolean | null`. `"unknown"` (the
  worker probed and could not tell) and `null` (the image predates cf#279 and has no such field)
  are one collapse apart and have different remedies -- look at the tenant database, versus move
  `modules_release` forward. Merging them would leave one `null` carrying both, which is exactly
  how this route's own comment sent a reader to a stale release pin while this bug was the cause.

  Legacy booleans are still accepted: `true` reads as `"ok"`, `false` as `"unavailable"`.
  vivijure-cf v1.13.0 was a published studio release emitting `Boolean(env.TELEMETRY_DB)` in five
  recording modules, and a tenant pinned there records perfectly well. Dropping it to `null` would
  report a working binding as unprovable.

- The comment on the readiness route named the wrong cause. It said a `job_log` absent everywhere
  is a stale release pin more often than a missing binding; null-everywhere is the exact symptom
  the parser defect produced, and the pin was independently stale, so checking it returned a
  confirmed-looking wrong answer. It now names this failure mode and orders the readings by which
  cause to check first: a parse problem is uniform across every tenant, a pin problem varies with
  the pin.

- The pre-deploy smoke parsed `job_log` with its own copy of the predicate, in two places, while
  its header said the tested logic is the shipped logic rather than a copy of it. That was true of
  the settle criterion and false of the parse, and the parse is the half that broke: the gate
  agreed with the plane by construction and could not observe the plane and the modules
  disagreeing. It now imports the shipped parser.

  Its negative control waited for boolean `false` and could never converge against a string. It
  now waits for `"unavailable"`, which preserves the asymmetry argument exactly: the version being
  replaced HAD the binding and could never say it, so seeing it proves the new bytes are served,
  while the positive value stays ambiguous between a stale isolate and a broken module and still
  never terminates the wait. An unconverged read remains a FAILURE, never a value.

### Added

- A rename tripwire on the cross-repo contract. `JobLogReadiness` is defined in vivijure-cf and
  nothing in this repo can notice it being renamed, so a value the shipped parser refuses is
  reported by the smoke as UNRECOGNISED rather than as `null`, and asserted before every other
  verdict -- if the vocabulary has moved, every reading below it is being interpreted through the
  wrong dictionary. The parser also surfaces the raw value in the observation's `detail`, so an
  absent field and an unrecognised one are never indistinguishable.

## v1.22.0 -- 2026-08-03

### chore(release): v1.22.0 -- what this tag actually deploys

**This is not a routine cut. Production today cannot provision a tenant at all**, and that is what
this tag fixes. Everything below has been on `main` and NONE of it has been live: the repo is
tag-gated, so a merge runs CI and nothing else.

- **THE LAUNCH BLOCKER (#323).** At any `STUDIO_RELEASE` >= vivijure-cf v1.14.0, `installInvokeKey`
  threw and the route answered 503 `modules_not_ready`, so **no tenant could complete an invoke-key
  install in any mode** -- shared, dedicated or BYO. Module readiness probed the whole catalog while
  `plan-enhance`, which reaches no RunPod, answers an AI-gateway-shaped `/ready` that classifies
  `misconfigured` (non-retryable). It armed the moment the pin left v1.13.0, measurably the last cf
  tag without the arming commit, and stayed invisible because the only live tenant sits at
  `modules_release=v1.6.0` and never re-runs the path. **Until this tag, production still has it.**
- **The module-side RunPod key is retired on proxied tenants: 16 copies per tenant becomes 1.**
  Conrad's ruling of 2026-08-03 is that the hosted tier holds no RunPod key it could extract. The
  fifteen module scripts now carry only the plane proxy token, which is inert against RunPod.
- **`shared` IMPLIES `proxied` by construction.** The shared pool requires three parts or none --
  endpoints, invoke key, proxy config -- so a plane that cannot mint proxy tokens refuses the tier
  outright rather than provisioning a tenant it cannot serve within the ruling.
- **The removal-site predicate is kept as well, and it is load-bearing rather than belt-and-braces
  by assertion:** with the tier gate in place, weakening it to the mode alone still turns 8 tests
  red. The gate holds at provision time; a tenant row stays `shared` for life, so the predicate is
  what covers a plane whose proxy config is removed later.

- **The `reachesRunpod` population rule is now stated in the code**, at the predicate's own
  definition (Conrad's direction). Not a list of its three uses -- the point is that each was FIRST
  attempted with a proxy for it, and each of those failed differently: `if (endpoint)` would have
  failed SILENTLY with the direct key on a shared tenant, `runpod_mode` alone fails LOUD with every
  render dead, and the whole catalog failed AT PROVISION and was green in test. Written once, with
  the two other sites pointing at it rather than restating it.

**Still open after this tag, deliberately:** the tenant STUDIO keeps its single copy of the key
(cp#321). It genuinely submits RunPod work -- cast LoRA training -- and `vivijure-core` has no proxy
branch, so removing it before core learns the proxy would break that path rather than close the
hole. Conrad's ruling is **not** fully satisfied until that core -> cf -> plane chain lands.


### feat(provision): a plane that cannot mint proxy tokens no longer offers the shared tier

Conrad ruled 2026-08-03 that the hosted tier holds no RunPod key it could extract. A shared tenant
reaches RunPod through the plane proxy or not at all, so a plane with no `CONTROL_PLANE_HOST` or no
`RUNPOD_PROXY_SIGNING_KEY` cannot serve one without handing it the direct key. The shared pool now
requires **three parts or none** -- endpoints, invoke key, and proxy config -- on the same argument
`deps.ts` already made for the first two. The provision route answers `runpod_key_required`, which is
a tenant who cannot provision (loud) rather than one we would have to violate the ruling to serve.

- The refusal is logged and **names the proxy specifically**, distinguishably from the other two, so
  an operator who has set both pool vars is not handed a message about the vars they already set.
- **This does NOT replace `installInvokeKey`'s own predicate.** The gate makes `shared` imply
  `proxied` at the moment `runpod_mode` is written; the row then stays `shared` for ever, so an
  operator who later removes the signing key leaves existing shared tenants whose next key install
  would find no proxy. The gate narrows that window and `tenantModuleProxyBinding` closes it.
  Mutation-proved: with this gate in place, weakening the removal-site predicate to the mode alone
  still turns 8 tests red.


### feat(provision): the module-side RunPod key is retired on proxied tenants

Conrad ruled 2026-08-03 that the hosted tier holds no RunPod key it could extract, in any fashion.
A proxied tenant's fifteen module scripts no longer receive the pool RunPod invoke key: they reach
RunPod through the plane on their `RUNPOD_PROXY_TOKEN`, which is inert against RunPod and worthless
anywhere except our own routes. **16 copies per tenant becomes 1.**

- **The predicate is the change, not the deletion.** Binding the proxy pair and installing the key
  are two halves of one decision, and as two expressions they can disagree into exactly one state:
  neither pair nor key, a module with no route to RunPod at all. `tenantModuleProxyBinding` is now
  the single expression both `uploadTenantModules` and `installInvokeKey` read.
- **Not keyed on `runpod_mode` alone.** Shared is necessary and not sufficient -- a shared tenant on
  a plane with no `CONTROL_PLANE_HOST` or no `RUNPOD_PROXY_SIGNING_KEY` gets no proxy, and keying on
  the mode would retire the key for tenants that never received one.
- **Dedicated, BYO and self-host are untouched** and keep the direct key. That unbound path is the
  self-host door and is permanently supported.
- **The STUDIO copy stays, as a known remaining gap rather than an oversight.** The studio itself
  submits RunPod work (cast LoRA training) and `vivijure-core` carries no proxy branch, so removing
  it before core learns the proxy would break that path rather than close the hole. Tracked
  separately; Conrad's ruling is not fully satisfied until it lands.

### fix(provision): module readiness probed the whole catalog and blocked every provision

**LAUNCH BLOCKER.** At any `STUDIO_RELEASE` >= vivijure-cf v1.14.0 -- which includes the current pin
v1.20.0 and the previous v1.19.3 -- no tenant could complete an invoke-key install, in any mode. It
had been live and unnoticed because the only live tenant sits at `modules_release=v1.6.0` and never
re-runs the path.

`awaitTenantModulesReady` probed every catalog module and `classifyReadyResponse` requires boolean
`runpod_api_key` / `runpod_endpoint_id`. `plan-enhance` reaches Anthropic through the AI Gateway,
submits no RunPod job, and answers with `gateway_id` / `cf_aig_token` -- so it classified
`misconfigured`, which is non-retryable and throws, and the route answered 503 `modules_not_ready`.

It was armed by an improvement: vivijure-cf#308 extended `GET /ready` from 6 modules to 26. Before
it, `plan-enhance` had no `/ready`, answered 404, and classified `unverifiable` -- benign. Each half
is correct on its own, which is why neither repo's suite could see it.

- The readiness population is now `reachesRunpod`, 14 of 15, matching what the contract is about.
- `ModuleReadiness` gains `notProbed`, so the exclusion is reported rather than silent and the four
  counts reconstruct the catalog.
- An empty probed population REFUSES instead of returning a clean readiness for a tenant nothing was
  asked about.

## v1.21.0 -- 2026-08-03

### chore(release): v1.21.0 -- what this tag actually deploys

Everything below has been on `main` and NONE of it has been live: this repo is tag-gated, so a merge
runs CI and nothing else. This is the first tag since **34 commits** landed, and it is a substantial
one. What the deploy carries:

- **The tenant module catalog goes 7 -> 15.** The eight GPUless cost-door modules (`alibaba-wan`,
  `alibaba-wan-lora`, `google-veo`, `kling`, `minimax-hailuo`, `narration-gen`, `seedance`,
  `vidu-q3`) become part of what a hosted tenant is provisioned with, alongside `finish-rife`.
- **Tenant renders land in the TENANT's bucket.** Those eight modules get an `r2_bucket` binding
  pointing `R2_RENDERS` at the tenant bucket. Without it their self-host default is the OPERATOR
  bucket, so this is the difference between a tenant's renders being theirs and being ours.
- **The RunPod proxy pair is re-keyed to `reachesRunpod`.** It was bound on endpoint-backed modules
  only; the cost door reaches RunPod at a public vendor slug with no endpoint of ours, so under the
  old predicate all eight would have run on the direct RunPod key on a shared tenant.
- **Module bundles are fetched at the release the WORK is on**, not the plane's current pin, so a
  resumed provision can no longer pair a studio from one release with modules from another.
- **The pooled shared tier**, its pre-upload resumability, the RunPod proxy ingress, the submit/
  terminal meter, the reconciler sweep on a 5-minute cron, and the teardown job-index harvest.

**`STUDIO_RELEASE` now points at the studio's `v1.20.0`**, so this deploy provisions tenants against
that studio release and the sixteen module bundles it publishes.

**TWO DIFFERENT THINGS ARE CALLED v1.20.0 AND THIS RELEASE IS WHERE THEY STOP COLLIDING.** The
CONTROL PLANE's own previous tag was `v1.20.0`; the STUDIO release this plane pins is ALSO `v1.20.0`,
and they are unrelated objects on separate cadences in separate repositories (see "Tag semantics" in
`docs/deploy.md`). Until now `v1.20.0` in a sentence about this system was genuinely ambiguous.
Moving the plane to `v1.21.0` disambiguates them by construction. When reading anything written
before 2026-08-03, check which repo a bare `v1.20.0` refers to.

### feat(provision): the GPUless cost door for hosted tenants, with their renders in their own bucket (cp#284, cp#270, cf#394)

A hosted tenant had no cost door at all: the eight cloud i2v/audio modules were published as tenant
bundles by every release this plane pins and uploaded by nothing. Conrad ruled them in scope on
2026-08-02 ("I want the cloud-i2v modules on the hosted door, it's literally one of the selling
points"). This adds the eight catalog rows AND the `r2_bucket` binding that makes them safe, in one
change, because either alone is worse than neither.

**Rows without the binding would send tenant renders into the OPERATOR bucket.** Each of these
modules declares `bucket_name = "vivijure"` in its self-host `wrangler.toml`, so a module uploaded
without `R2_RENDERS` does not fail -- it writes a paying tenant's finished renders into ours and
reports success. That is why this is one PR and not two.

**Every catalog fact was measured from the module sources, with controls, not inferred:**

| fact | how it was established |
|---|---|
| no `endpointKey` | none of the eight declares `RUNPOD_ENDPOINT_ID` in its `Env`; all submit to public vendor slugs |
| `recordsRunpodJobs: true` | each imports `runpod-job-log` and reads `TELEMETRY_DB` exactly as `keyframe` (a known recorder) does, while `plan-enhance` (a known non-recorder) does neither |
| `writesTenantRenders: true` | across the fifteen catalog modules the `R2_RENDERS` split is exact and has zero overlap with `endpointKey`: the eight declare it, the other seven declare it nowhere |
| `publicEndpoint` slug | read off each module and asserted against `PUBLIC_ENDPOINT_ALLOWLIST`, the list the plane proxy will actually admit |

**THE DEFECT THIS FOUND, and it is the reason the change is larger than eight rows.** The cp#288
RunPod proxy pair was bound inside `if (endpoint)`. That was correct only while every RunPod-reaching
module was endpoint-backed, and the cost door breaks the assumption: these eight reach RunPod at a
PUBLIC slug with no endpoint of ours. Under the old predicate all eight would have been uploaded to a
SHARED tenant with **no proxy pair**, taken the unbound branch of `modules/_shared/runpod-route.ts`,
and reached RunPod on the direct `RUNPOD_API_KEY` -- a consumer holding a RunPod credential on our
account, which CLAUDE.md forbids outright. The predicate, not the population, was the defect, so the
binding now keys on `reachesRunpod(spec)`. `plan-enhance` is still the only non-RunPod module and
still the negative control, so the discipline that comment describes is unchanged and still has a
real subject.

**Why the binding and not the cp#270 envelope.** cp#270 chose bounded residency to stop a standing
CREDENTIAL going stale (cf#83). An `r2_bucket` binding is a CAPABILITY: no secret at rest, nothing to
roll, so that reasoning does not reach this case. Measured rather than asserted: there is one bucket
per tenant, created by `createR2Bucket` with no lifecycle, CORS or policy configuration, and
`provisioner.ts` already binds that same bucket on the tenant STUDIO as `R2_RENDERS`. This grants the
module scripts the reach the studio already holds, over the same object, so there is no per-binding
permission surface on which a module could differ from the studio.

**It also REMOVES a collision.** `clipKey()` is `renders/<project>/clips/<shot>_<vendor>.mp4`, which
carries no tenant component. In a single operator bucket two tenants sharing a project and shot id
would silently overwrite each other; per-tenant buckets make that unrepresentable.

`uploadTenantModules` REFUSES when a writer's tenant has no bucket recorded, rather than uploading a
writer with nowhere safe to write. The parameter is required and nullable, the same shape
`telemetryD1Id` uses and the same compile-time property cp#315 established for `release`.

### fix(provision): thread the release into the module upload, and delete the field that let it drift (cp#315, cp#301)

`runProvisionJob` was the only `uploadTenantModules` call site that did not thread the release. On
the shared-tier pre-upload resume that cp#301 item 3 opened, the studio came from the job's recorded
`to_release` while the MODULES were fetched at `deps.release` -- the plane-wide `STUDIO_RELEASE`,
read fresh at the moment of driving. A resume taken after an operator advances the pin therefore
gave a tenant a studio from release A and modules from release B, and recorded the new pin in
`tenants.modules_release`. It returned `ok: true`.

That is exactly the pair `module-bundle-r2.ts` states can never happen: *"Modules ship WITH the
studio release they were built and conformance-proven against (one tag, one artifact), so a tenant's
studio and its modules can never be a mismatched pair."*

**Driven, not reasoned about.** With `job.to_release=v1.0.0` and `deps.release=v2.0.0`, the studio
was fetched at `v1.0.0` and all seven module bundles at `v2.0.0`, with `modules_release` recorded as
`v2.0.0`. The negative control -- the identical fixture with the pin NOT moved -- fetched everything
at `v1.0.0`, so the divergence came from `deps.release` and nowhere else. Both values are
NON-DEFAULT on purpose: cp#301's own suite could not see this because its fixture set the plane pin
and the tenant release to the same string, and on a default the threaded and unthreaded reads are
byte-identical.

**The fix deletes `release` from `TenantModuleDeps` rather than only adding an argument, and that is
the load-bearing half.** Every other call site already threaded the release correctly -- the upgrade
path, `prefetchModuleBundles`, reprovision -- so "remember to pass it" was already the condition that
produced this bug, and adding one more caller obligation would leave that condition in place. With no
`release` on the deps object there is nothing to forget: omitting it does not compile. This is the
reasoning `tenant-modules.ts` already gives for `tenantSlug` and `runpodMode` being required rather
than optional, applied to the field that was actually drifting.

**The compiler then found the rest, which is the property paying for itself immediately.** Deleting
the field surfaced the upgrade call site plus two `{ ...deps, release }` spreads (in `provisioner.ts`
and `tenant-runpod-reprovision.ts`) that existed ONLY to satisfy the deleted field:
`prefetchModuleBundles` has always taken the release as an argument and always used the argument, so
those spreads were a second source of truth that agreed with the first by luck. They are gone, and 33
test call sites now state the release explicitly.

**Not live today, and the sequencing matters.** The path is shared-tier only and the shared pool is
unwired (`SHARED_RUNPOD_ENDPOINTS` is absent from the repo variables), so no shared provision can be
in flight and this cannot currently bite. It becomes live the moment cp#285 Option A wires the pool,
which is why it is fixed before that rather than after.

Two legitimate readers of the plane pin remain and are unchanged: `provisioner.ts` resolving the
release for a FRESH provision, and `deps.currentRelease()` reporting the pin a new job records.

### feat(provision): catalogue `finish-rife`, closing the upstream recording set (cp#284, cf#394)

Six module workers record RunPod jobs upstream and five were provisioned. `finish-rife` was built
and PUBLISHED as a tenant bundle by every release this plane pins, and uploaded by nothing, so on
the hosted door its jobs did not go unrecorded, they did not exist. It needed a catalog row and
nothing else.

**Verified against the artifacts rather than the description**, because the audit column that made
this look trivial says "operator-only bindings **read**" and its wrangler.toml declares an
`R2_RENDERS` bucket. Those reconcile: the binding is declared for the SELF-HOST deploy and read
nowhere, and it is absent from the module's `Env` interface entirely. So this is not the cp#270
tenant-R2 envelope lane. Its Env is the two RunPod credentials, the cp#288 proxy pair and
`TELEMETRY_DB`; its endpoint comes from the store secret `BACKEND_RUNPOD_ENDPOINT_ID`, so the row
rides the same shared backend endpoint as `keyframe` and `own-gpu`.

**The premise that actually gates a catalog row is bundle availability, and it is checked here
against the real release.** `scripts/check-release-modules.py` against the live `v1.19.3` artifact
goes from 6 to 7 modules and stays rc 0, with a nonexistent-module control returning rc 1 so the
pass discriminates. A row whose bundle a release does not publish makes `moduleBundle.fetch` throw
at `modules_upload` and fails EVERY provision, which is the ordering hazard the `plan-enhance` entry
already documents.

**Eight guards fired and every one of them was working.** Hand-maintained counts and name lists in
`provisioner.test.ts`, `module-upgrade.test.ts` and `module-telemetry-binding.test.ts` exist so a
catalog change cannot land unnoticed, and one says so in its own comment. They are updated, never
derived from `TENANT_MODULE_CATALOG.length`: a derived expectation agrees with whatever the catalog
happens to say, which is the assertion inverted. A ninth site was a COVERAGE gap rather than a
failure -- `tenant-aig-token.test.ts` loops a hardcoded list of endpoint-backed modules and simply
never looked at the new one, which is the shape every catalog addition opens.

**One substantive consequence, flagged rather than resolved.** `finish-rife` serves the `finish`
hook, measured at vivijure-cf `origin/main` alongside `finish-upscale` and `finish-lipsync`, so the
partial-upgrade compatibility argument in `provisioner.ts` and `docs/control-plane.md` -- written
for "the one coupled PAIR ... which CHAIN" -- now describes a chain of THREE. Whether a mixed state
across three links can express an incompatibility the two-link argument does not cover is an open
question. Both sites now say so instead of silently generalising.

### test(provision): gate the shared-pool refusal the RunPod-proxy reprovision proof rests on (cp#288, cf#394)

Follow-up to the proxy binding. `tenant-runpod-reprovision.ts` is the third production call site of
the new `runpodMode` parameter, and it needed the mode sourced correctly rather than plausibly.

The comment shipped alongside the binding hedged that the value there is `'dedicated'` "in
practice". It is stronger than that, and structurally so: `reprovisionTenantRunPod` cannot be
entered without a `ReprovisionContext`, the only producer of one is `preflightRunPodReprovision`
AFTER its `tenant_on_shared_pool` refusal, and the preflight returns a discriminated union so the
context is unreachable on the refusal branch. Note the two are in DIFFERENT functions, so the guard
dominates nothing syntactically; the proof is the type, not the line order.

One residual survives and is now stated at the code: `tenant` is passed separately from `context`,
so nothing forces the tenant the preflight examined to be the tenant handed to the call. The row is
therefore still read rather than hardcoded to `'dedicated'`, which stays correct under both futures.

**The defect this found: that refusal had no test coverage at all.** `tenant_on_shared_pool`
appeared nowhere in the suite, so the guard a comment now leans on could have been removed by
someone tidying with everything still green, and the proxy pair would then be bound on a pooled
tenant. Added as one row in the existing table-driven preflight cases, and proved by mutation:
deleting the refusal turns that row red, naming itself.

### fix(control-plane): advance the backend satellite pin to match production (cp#297)

Production's `vivijure-backend` RunPod endpoint (`t9wcvlxh8rc5la`) had moved to image `1.0.13`
while `src/satellite-pins.ts` still pinned `1.0.11`; a tenant provisioned in that window would have
been created against a version production no longer runs. Re-measured against RunPod's
`list-endpoints` (5 of 5 endpoints returned, not truncated): only `backend` had drifted, `upscale`,
`lipsync` and `audio-upscale` still match their pins exactly. `backend.tag` moves to `1.0.13` and
its `mirrors.readAt` mirror to the date it was actually re-measured; the other three pins, including
their `readAt` stamps, are untouched -- they were re-verified against production, not re-derived.

### feat(provision): point a tenant module at the plane-side RunPod proxy (cp#288, cf#394)

The proxy was fully built, merged and completely unreachable. `PROXY_UPSTREAM_PREFIX` had no caller
outside the proxy's own files, `RUNPOD_PROXY_BASE` existed only inside a comment, and
`mintTenantProxyToken` was called by nothing but its own tests. A module worker was uploaded with
seven bindings and not one of them told it a proxy existed, so every tenant render went straight to
RunPod with a RunPod-capable credential in the tenant namespace, which is the thing the proxy was
built to remove.

`uploadTenantModules` now binds two more vars on every endpoint-backed module: `RUNPOD_PROXY_BASE`
(plain_text, the plane origin plus the proxy's own declared prefix) and `RUNPOD_PROXY_TOKEN`
(secret_text, the per-tenant MAC from `mintTenantProxyToken`). Both names are declared once, in
`runpod-proxy-auth.ts`, because the plane writes them and the module reads them and a name restated
in two repositories is a fork waiting to happen. The base is derived in one exported function
(`tenantModuleProxy`, env.ts) next to `publicOrigin`, so it cannot disagree with the routes the
router actually matches.

**SHARED TENANTS ONLY.** The cross-repo contract (`vivijure-cf@67302960`
`modules/_shared/runpod-route.ts:45`) binds the base for `runpod_mode = 'shared'` and nothing else,
and the reason is not tidiness. cf branches on the base being BOUND and states that this is **not a
failover**: bound means proxied, and a proxied module that cannot authenticate refuses honestly
rather than finding another way to RunPod. Our own submit path answers 403 `not_shared_mode` for
anything that is not shared. So a base bound on a dedicated tenant does not degrade that tenant, it
breaks every render on it with the direct path deliberately unavailable, and
`tenants.runpod_mode` is `NOT NULL DEFAULT 'dedicated'`, so that is the majority population.

`uploadTenantModules` and `ModuleStepsArgs` therefore take a required `runpodMode`, typed as the
narrowed `RunPodMode` union rather than the raw column, so a caller cannot pass a database value
without going through `readRunPodMode` and cannot omit it without failing to compile. That narrowing
maps anything unrecognised to `dedicated`, which is the correct failure direction here: dedicated
binds nothing, the module stays on the direct path, and the direct path works. The fresh provision
carries the mode the endpoints step DECIDES rather than re-reading the tenant row, because the row
is updated while the in-memory object is not, and reading it after the write would report the
pre-write default on exactly the tenants the shared tier is for.

**BOTH OR NEITHER, and that is the whole design constraint.** A module with neither binding keeps
using its direct key, which is the pre-proxy path and works. A module with a base and no verifiable
token does not degrade: it switches to the proxy and is refused on every call, with nothing on the
plane reporting why. So `tenantModuleProxy` returns null unless a host and a signing key are BOTH
configured (empty counts as absent, the cp#218 shape), and the upload binds the pair only when the
mint actually produced a token. Modules that talk to no RunPod endpoint, which today is
`plan-enhance`, get neither half; a proxy credential on a module that submits no job is reach it
never uses.

**Nothing is removed, and the ordering is the reason.** `RUNPOD_API_KEY` is still installed on every
module script by `installInvokeKey`, untouched. vivijure-cf has to teach its modules to prefer the
base and FALL BACK to the direct key first; only after that has shipped and been verified may the
plane stop installing the key. Binding the pair early costs two unread vars on a module that has not
learned to read them. Removing the key early strands every render on that tenant. A test asserts the
key still lands on every module script through the REAL wiring, so the survival of the old path is
a gate rather than an intention.

Nine mutations were run against the new suite -- pair dropped, half the pair bound, empty host
accepted, pair bound on a non-RunPod module, base pointed back at RunPod, direct-key fan-out
removed, the shared-mode gate removed, the shared-mode gate inverted, and the base reduced to the
bare origin -- and each went red naming the assertion that should have caught it, against a green
unmutated control. The gate is mutated in BOTH directions deliberately: a gate that only fails one
way is a constant.

The suffix is proved end to end rather than by inspection. The test takes the base actually bound,
builds the URL the way cf builds it (`base + "/" + endpointId` plus a verb), and feeds the path to
this plane's own shipped `matchProxyRoute`, with a control asserting the matcher rejects both wrong
shapes a plausible implementation would have produced: the bare origin, and the prefix without
RunPod's own `/v2`.

### feat(provision): a pooled provision that was interrupted before the studio upload can now be resumed (cp#301)

A shared-tier provision that yielded before `wfp_upload` could never be finished: the resumability
boundary refused everything short of that step, on the grounds that the RunPod key needed to finish
is never stored. True for a tenant that brought its own RunPod account, and false for a pooled one,
which has no key at all. Yielding is designed behaviour, so the shared tier's normal recovery
mechanism was the broken one, and it fired on the first pooled provision ever attempted.

Those states are now resumable. The steps live in one function: the resume hands the job back to
`runProvisionJob` with the progress it already recorded, rather than a second copy of the
provisioning sequence that would drift on the path nobody exercises until something has gone wrong.

**The bucket credential is re-minted, and the ORDER of the mint and the revoke has been inverted.**
The value is never stored, so no continuation can reconstruct it. The revoke used to run BEFORE the
mint, which is safe on a fresh provision because nothing is bound yet, and is not safe on a resume:
`wfp_upload` is not atomic, so a driver that died after the worker upload but before its step was
marked leaves a LIVE tenant Worker holding the old secret, and the tenant row cannot detect it
(`script_name` is written after the upload, so NULL is produced identically by "no Worker" and
"Worker exists and is bound"). The order is now mint, rebind, then revoke. The two failure directions
are not symmetric and that is the whole reason: dying after the mint leaves two live grants, which is
loud, logged and revocable by id and by name; dying after an early revoke leaves a studio that
provisions green and cannot read or write its own bucket.

`r2_token` is also yield-unsafe on a resume, for the same reason `runpod_endpoints` always is: the
only thing that binds the new secret is `wfp_upload`, so the mint and its rebind must be carried
through in one invocation.

**The dedicated path is unchanged and still refuses, permanently and as an explicit assertion.** Key
A lives in the request that carried it.

The release comes from the job row recorded at creation, never the plane pin at poll time, and a job
with no recorded release refuses rather than falling back. The two directions of the
progress-versus-row disagreement about the database are now separate refusals: progress claiming
`d1_create` on a row with no id is corruption and refuses permanently, while a row carrying an id the
progress does not claim is what a driver dying between the write and the mark leaves, and `createD1`
is adopt-on-exists, so it is adopted and logged rather than refused.

### fix(provision): each resume guard checks what it needs, and every refusal names its own cause (cp#301)

`continueProvisionJob`'s preamble was four guards in sequence, and only the first was independently
correct. Guards on `endpoints_json`, `studio_token_enc` and `studio_release`, plus a fifth that was
never written as a guard at all (the `telemetryD1Id` field, whose refusal lives one module away in
`uploadTenantModules`), were correct ONLY because the boundary had already refused everything that
could reach them in a partial state. Nothing in the code said so, so relaxing the boundary would have
silently invalidated four checks nobody edited, each then refusing with a message naming the wrong
cause.

The preamble now states each precondition where it is consumed, and the pre-upload region has FOUR
named refusals instead of one: no recorded mode (a job predating migration `0022`), dedicated (key A
is unrecoverable, message unchanged and permanent), shared (the capability is not built yet), and an
unrecognised mode. None of them is a fall-through; a refusal reached by falling off the end of a
chain is one a later edit removes by accident. The mode is read from the JOB row, deliberately NOT
through `readRunPodMode`, which narrows anything unrecognised to `dedicated` and would erase the NULL
that migration `0022` exists to preserve.

Two integrity checks now run before any decision: job progress must be a contiguous prefix of
`PROVISION_STEPS` (`inferStep` maps `done.length` to a step BY INDEX, so a hole yields a plausible
wrong step name rather than an error), and the progress record must agree with the tenant row about
the database.

Past the boundary, an absent value is data corruption rather than an unfinished phase, and the
messages now say which. They previously read "re-provision to continue", which sent a reader looking
for a step that had not run.

NO STATE BECOMES RESUMABLE. This changes the reason a resume is refused, never the answer, and the
suite asserts that in both directions across every entry state. Admitting the pre-upload region
requires re-minting the bucket credential and re-running the studio upload in full, which is a
separate change.

### feat(provision): record the RunPod mode and the release pin on the job row (cp#301)

A provision that yields before `wfp_upload` is resumed by a POLL, which holds neither the RunPod key
nor any way to learn which shape or which release the attempt was for. Nothing persisted could tell
it. `tenants.runpod_mode` is written INSIDE the `runpod_endpoints` step and is `NOT NULL DEFAULT
'dedicated'`, so for the whole region before that step every tenant row reads `dedicated` whether or
not it is one; a resume gate keyed on it would refuse every real pooled tenant and fix nothing, while
passing any test whose fixture hand-writes `shared` onto a pre-endpoints row. `tenants.studio_release`
is written inside `wfp_upload`, so it is NULL across the same region.

Both facts are now recorded on the JOB row at creation, in one INSERT, before any step runs.
Migration `0022` adds `provision_jobs.runpod_mode`; `to_release` already existed from `0006` and
provisions simply never wrote it.

THE MODE COMES FROM THE KEY, never from whether the plane offers a pool. A plane with a pool armed
still serves BYO dedicated tenants, so "a pool exists" would put a tenant who brought their own
RunPod account onto ours. The route reads the key ONCE and uses that single value for both the
recorded mode and the argument handed to the driver, so the row cannot assert a shape the provisioner
did not take.

NULL IS LOAD-BEARING and the column has no default: NULL means the job predates migration `0022` and
nothing else. A default of `dedicated` would make an unrecorded job indistinguishable from a recorded
one, and would hand a future resume a confident wrong answer instead of a refusal.

`createProvisionJob` now takes those facts as a REQUIRED argument, so a call site cannot omit the
mode and produce a silently unresumable job.

CONTRACT CHANGE: a provision job's `to_release` is no longer NULL, and `GET /api/tenant/:id/job`
reports it. `from_release` stays NULL on provisions, which do not move a tenant from anything.

NOTHING IS RESUMABLE YET. This changes no guard and no provisioning behaviour: the driver still
fetches `deps.release`, so `to_release` on a provision is the intent recorded at creation rather than
a description of what was built. Making the pre-`wfp_upload` region resumable, and reading this pin,
is the next item on cp#301.

### fix(provisioner): a resume uses the TENANT studio release, not the plane current pin (cp#301)

`continueProvisionJob` passed `deps.release` to the module steps and wrote it to `modules_release`.
`deps.release` is the PLANE-WIDE `STUDIO_RELEASE`, read fresh on every invocation, while the studio
worker was uploaded from the pin as it stood at `wfp_upload` and recorded in `tenants.studio_release`.
So a resume driven after an operator advanced the pin handed the tenant a studio from one release and
MODULES FROM ANOTHER -- precisely the pair `module-bundle-r2.ts` states cannot exist ("Modules ship
WITH the studio release they were built and conformance-proven against (one tag, one artifact), so a
tenant's studio and its modules can never be a mismatched pair").

LIVE, not theoretical. `STUDIO_RELEASE` moved v1.13.0 -> v1.19.3 in a single day on 2026-08-03; a
tenant straddling that would have been nine releases mismatched between its D1 schema and its studio
bytes.

The resume now resolves the release from `tenants.studio_release` and REFUSES when it is absent
rather than falling back to the pin -- a fallback would turn "I cannot tell which release this tenant
is on" into a confident wrong answer, which is the mismatch the change exists to prevent. That
refusal is unreachable today (the resumability boundary proves `wfp_upload` completed, and
`setTenantScript` writes `script_name` and `studio_release` together in that step), so it is a
structural assertion that must STAY a refusal when the pre-`wfp_upload` region is later made
resumable, where the pin has to come from the job row instead.

WHY THE SUITE COULD NOT SEE IT, worth recording because it is a class rather than an instance: the
fixture seeded `studio_release` as `v1.0.0` and the deps fixture set `release: "v1.0.0"` -- the same
value -- so every assertion passed identically whether the code read the tenant or the plane. The
instrument was fully capable and the two inputs had never been allowed to differ. Making them differ
is the whole change to the tests; the assertions already existed. A capable instrument aimed at a
safe input is indistinguishable from a working test.

Both new tests were watched failing against the unpatched code with the right red rather than merely
red ("expected 'v2.0.0' to be 'v1.0.0'", and the refusal case silently succeeding), and all 35
pre-existing tests in that file pass with and without the fix.

Found while censusing which values steps 1-6 mint and which later steps consume, for separate
resume work -- not by looking for it. The release bundle is the one crosser that is neither persisted
nor a credential, which is why reading the diagnosis had not surfaced it.

### feat(runpod-sweep): the reconciler backstop, and the cron moves to every 5 minutes (cp#290)

Every failure path in the proxy ended "the reconciler picks it up" while
`RECONCILER_ADOPT_AFTER_MS` was a declared constant with no consumer, so each was PERMANENT rather
than transient: the raced callback, a failed index write at submit, and a callback that never
arrived -- including the unmeasured case that RunPod may not fire the webhook on COMPLETED at all.
All three probe jobs terminated FAILED or CANCELLED, so firing-on-success is inferred; if it does
not, every successful job stayed open forever and nothing would have noticed.

ONLY TWO WAYS A ROW EVER CLOSES: we read a terminal status ourselves, or TWO independent conditions
agree it can never be answered (RunPod 404s AND the row is past retention). Everything else -- 401,
429, 5xx, an unreadable body, a thrown request, a 404 inside the horizon -- leaves the row OPEN and
counts as an error. An open row says "nobody knows" out loud; a fabricated close asserts something
nobody observed. `unknown` is a new terminal that is never billable, structurally, since `isBillable`
answers on `completed` alone.

THE CRON MOVES TO 5 MINUTES, and the config's own prose used to argue against it. That reasoning was
correct when the meter was the only consumer and its cost was bookkeeping rows (288/day against 96).
The sweep made the interval a CORRECTNESS parameter: a row is resolvable only in [t+5min, t+30min],
so at 15 minutes a worst-case row gets ONE non-retryable attempt and at 5 minutes it gets four. One
attempt is not a backstop for a mechanism that has already failed once. Both consumers' reasoning is
now in the config rather than a number contradicting the paragraph above it.

Retention is sourced rather than folklore: RunPod's own docs give 30 minutes for `/run` in two
places. It is still never used as a gate on ASKING, only as the second corroborating condition
before writing `unknown`, so a wrong figure leaves rows open rather than fabricating terminals.

The scheduled tick now isolates its halves. It was one bare `await`; a throw in either would have
silently skipped the rest, and the symptom is an absence, which is what a healthy idle plane looks
like.

NOT NAMED `reconcile-*`: `reconcile-runpod.ts` is the endpoint inventory reconciler over a TENANT's
account, and its "a poller needs a credential we refuse to hold" is correct there and poison one
file over. The distinction is written into both files.


### feat(runpod-proxy): wire the ingress -- submit, poll and callback routes (cp#290)

cp#291 landed the primitives and said plainly that they had no caller, so every ruling on cp#290
guarded nothing in production. This is the caller. `POST <base>/<endpoint>/run`, the three poll
verbs, and `POST /api/runpod/webhook/<token>` are mounted ABOVE the session gate, because the caller
is a tenant module worker holding a bearer token and no cookie.

THE VERB SURFACE IS THE POINT. `purge-queue` -- which takes no job id, wipes an endpoint's queue for
every tenant on it, and which RunPod's three-value per-endpoint enum can never refuse while
permitting `run` -- is now refused by a matcher rather than bounded by a key. An unmatched path
under the prefix answers 404 and is never forwarded. `runsync` is absent because nothing uses it and
a verb the meter has never seen is a verb it cannot price.

THE CALLBACK IS AN UNTRUSTED TRIGGER, MADE STRUCTURAL. `handleProxyWebhook` is not handed the
Request at all, so there is no body in scope to be believed; terminal facts come from a
`GET /status/{id}` we issue with our own credential, at the endpoint from our own row. Proved by
injecting the real defect (a handler that trusts the inbound body) and watching four tests go red,
including the forged-token case, then reverting. A test asserts that a callback whose body ERRORS on
read still closes the row, with the same poisoned body on the submit route as its control.

THE TENANT CREDENTIAL IS A KEYED MAC, NOT A STORED TOKEN, and that is a deliberate trade. The poll
half must hold no store -- that is what makes a poll structurally incapable of metering, and the
intended deployment is a poll Worker with no D1 binding at all. A token requiring a table lookup
cannot be verified on a Worker without a database, so choosing one would have quietly foreclosed
that split. The cost is that revocation is not per-row: per-tenant refusal is enforced on the SUBMIT
path (live, unsuspended, `runpod_mode = 'shared'`), which is the only path that spends, while poll
and cancel stay reachable for jobs already in flight because cancel is the spend-leak guard.

Also: migration 0021 (`webhook_token_sha256` plus a partial UNIQUE index) because RunPod takes the
callback URL in the /run body, so the token must exist before the job id does and cannot be derived
from it. Three store methods proved against real SQLite through the shipped `D1Store`, including the
`WHERE terminal_at IS NULL` guard that stands between one job and a triple charge. New secret
`RUNPOD_PROXY_SIGNING_KEY` (docs/deploy.md); absent means the proxy refuses everything, which is the
correct direction. Ten live probes against `wrangler dev` on workerd, which is how the callback path
was caught answering a generic 500 instead of a named refusal on a store failure.

NOT DONE, and stated rather than left to be noticed: no tenant module calls any of this yet. The
module-side base-URL swap and the provisioning change that stops installing the RunPod key are
separate, and until both land the shared tier still reaches RunPod directly.


### feat(runpod-proxy): submit interception, job-id -> tenant push, meter at submit and terminal (cp#288)

The plane-side RunPod proxy foundation. On the shared tier no tenant-namespace script may hold a
RunPod credential, and RunPod's per-endpoint control has no operation axis, so no scoping can ever
permit `run` while refusing `purge-queue`. Proxying deletes that question instead of bounding it.
The second reason is now the larger one: the plane sees every submission, so the (job id -> tenant)
map is produced AT SOURCE rather than reconstructed by a fan-out scan of every tenant database.

METER AT SUBMIT AND TERMINAL, NEVER ON POLL, AND ENFORCED STRUCTURALLY. The poll half is a separate
module that imports nothing from the metering half and holds no store, so a poll has no handle to
write through. The guard was proved by INJECTING the real defect (a store import plus a store field)
and watching both separation assertions go red while the import-extractor control stayed green, then
reverting. A guard nobody has seen fail is not a guard. Quantitatively: the orchestrator is
client-driven at an 8s cadence and the finish phase polls once per pending shot per tick, so a job is
polled `ceil(job_seconds / 8)` times; D1 processes queries sequentially, so metering on poll makes the
plane's database a fleet-wide serialization point at `shots x ticks` writes per render against ~2 per
job.

MEASURED AGAINST LIVE RunPod 2026-08-02, and three results contradict the vendor documentation:

- **The terminal webhook carries NO authentication of any kind** -- the entire header set is
  `user-agent: Go-http-client/2.0` plus Cloudflare's own `cf-*`. So the callback is an UNTRUSTED
  TRIGGER and never evidence: an opaque 256-bit per-job token is verified before any write, and the
  authoritative terminal state comes from a `GET /status/{id}` WE initiate. Without that, a forged
  `{"id":..,"status":"COMPLETED"}` bills a tenant (cp#290).
- **Retry timing is not the documented "2 more times with a 10-second delay"** -- observed
  `+0 / +5.009s / +15.007s`, so the count is right and the delays are not. Recorded as a named
  constant carrying its own provenance, and labelled one measurement of one job so it cannot harden
  into a contract.
- **The payload shape varies by terminal state** -- a CANCELLED job reports no `executionTime` and no
  `delayTime` at all. Absent therefore stores as NULL, never 0, in one choke point so no caller can
  reintroduce it: a zero reads as a real measurement of a job that took no time and would under-count
  the ledger silently. NaN lands on NULL for the same reason.

The three retry deliveries carried BYTE-IDENTICAL bodies, so the first-write-wins idempotency guard
is load-bearing under ordinary conditions (a merely slow receiver), not only against an attacker.

ALLOW-LIST IS EIGHT PUBLIC ENDPOINTS, NOT SIX. Conrad ruled the cloud-i2v modules in scope for the
hosted door. Measured at `vivijure-cf@b295309`, statement-level, against a denominator of 26 modules
carrying a `src/index.ts`: 14 reference `api.runpod.ai/v2/`, of which 8 hard-code a public slug and 6
read `RUNPOD_ENDPOINT_ID`. `narration-gen` builds its URL by concatenation, so a line-level matcher
returns 7 and misses it. A test asserts the count so a dropped entry fails loudly rather than shipping
a cost door with two doors missing.

MIGRATION `0020` adds `endpoint_id`, deliberately reversing `0019`'s exclusion and saying why: `0019`
omitted it because on a pooled endpoint it attributes nothing, which is true of the four GPU endpoints
and FALSE of the cost door, where eight distinct model slugs at different prices make the endpoint the
only thing that says what a job cost.

`0019`'s HARVESTED-NOT-PUSHED ruling is NOT overturned. The harvester stays as the backstop for
pre-proxy jobs, dedicated-mode tenants and anything that bypassed the proxy, and the ordered
harvest-before-reap teardown step is untouched -- a push only knows about jobs the plane saw. The
premise change is argued on cp#274 and pointed at from cp#280.

The `policy.executionTimeout` clamp ships as a SEAM WITH NO VALUE. The number comes from phase-1
measurement (observed max +30%, per endpoint, execution time only); implementing it from RunPod's
documented 600000ms default would kill tenant jobs the way that default already killed ours.

Reconciliation must query BOTH billing scopes; noted in code, not built. A reconciler on the
serverless scope alone omits the entire cost door and READS AS BALANCED, because a missing scope
returns no rows rather than an error.

SCOPE, stated so nobody reads more into it: this is primitives plus a documented contract, NOT a
guarded path. Route wiring and the reconciler sweep are not here, so **cp#290's rulings are not
ENFORCED until the handler lands**. And `COMPLETED` was never observed in the probe (all three probe
jobs terminated FAILED or CANCELLED), so ledger coverage is measured and BILLING coverage is not --
confirming the COMPLETED payload on the first real job the proxy handles is an explicit step.
### feat(teardown): harvest the RunPod job to tenant index before reaping a tenant D1 (cp#270, for vivijure-cf#225)

On the dedicated shape the endpoint NAME carried attribution for free (`vivijure-<slug>-<key>`).
Pooling removes that: a pooled endpoint's jobs are a mixture, and the only remaining map from a
RunPod job id back to a tenant is a fan-out scan of every tenant database. That degrades vivijure-cf#225,
the report-driven CSAM enforcement path, where reaching the specific job IS the procedure.

HARVESTED, NOT PUSHED. The obvious shape is for the submitting module worker to write the mapping
at submit. Rejected: the facility is used a handful of times a year, so a synchronous hot-path
write on every render pays a continuous cost for an occasional need, and it has to arrive either
as a new authenticated ingress on the render path (silent lost attribution when it fails) or as a
D1 binding to control-plane storage on every tenant module worker. The control plane already holds
every `d1_database_id` because it created them, so it READS. Nothing on the render path, no new
binding on any tenant worker, nothing to fail silently mid-render.

THE ORDERED TEARDOWN STEP is what makes it correct rather than merely cheap. A tenant database
dies at teardown, which is exactly when the index becomes the only surviving record, so a periodic
sweep alone would permanently lose every job between the last sweep and the deletion. The harvest
is a mandatory step ordered AHEAD of the D1 delete, and **a harvest that cannot be proven complete
blocks the delete and fails the teardown**. That is the uncomfortable direction on purpose: an
un-run teardown is recoverable by running it again, a deleted mapping is not.

Three harvest states are kept distinguishable, because collapsing any two is how an index ends up
silently short of a source that no longer exists: complete-with-rows; complete-with-no-table (a
provision that died before its migrations ran, which must stay reapable); and incomplete (the row
ceiling was hit, so the read is refused rather than truncated). Table existence is asked of
`sqlite_master` BY DATA, never inferred from a vendor error string.

Content is unchanged from the ids-and-labels telemetry posture: job id, module name, an outcome
from a closed set, two timestamps, plus the tenant id and the slug as it was at harvest time. The
RunPod endpoint id is deliberately not copied (migration 0014 omits it, and on a pooled endpoint it
is the same value for every tenant, so it attributes nothing).

Coverage is NOT retrospective: tenants already deleted are unrecoverable and nothing here pretends
otherwise.

### docs(provisioner): the finishing tier is label-selected, and it is three nodes now (cp#270)

Comment only, no behaviour change. `provisioner.ts` said the video-finish tier is
"(descendents + badbrains)". Conrad added jello; verified against the live swarm rather than taken
on trust (`tier=finishing` on three nodes, all five vivijure-media services replicated 3/3 max 1
per node, `vivijure-media_video-finish` constrained to `node.labels.tier == finishing` with a
task on jello since its 2026-07-31 rebuild).

Wording matches what #275 landed in `docs/cost-basis.md` and `docs/control-plane.md`, so one grep
now finds all three, and the node list is written as a measured-on-date observation rather than a
definition. Naming nodes is what made the comment stale in the first place; placement is
label-driven and picks up whatever carries the label.

Worth more than the correction, and now stated in the comment: that tier absorbed a wiped, rebuilt
and re-labelled node with **no per-tenant change anywhere**, because the workers hold no credential
to re-issue and are selected by label. That is the cp#270 shared-tier thesis already running in
production, and this comment is the precedent the pooled RunPod design is built on.

### feat(provisioner): pooled SHARED tier that creates zero net-new RunPod endpoints (cp#270)

Conrad ruled 2026-08-01 that the hosted SHARED tier never provisions dedicated per-tenant RunPod
endpoints. The capability did not exist, so the ruling could not be satisfied by configuration.
A shared-tier tenant now rides the endpoints that already exist and creates none.

The ceiling this lifts: the RunPod worker quota is ACCOUNT-WIDE, `PROVISION_PLAN` needs 5 net-new
workers per tenant, and teardown structurally cannot reap RunPod endpoints, so the dedicated shape
capped the hosted business at roughly ten tenants that had EVER existed. Provisioning one test
tenant took the account from 47/50 to 50/50.

Which shape a tenant gets is derived from a fact the caller already carries rather than from a new
toggle: a RunPod key present means DEDICATED (the BYO power-user path, correct and unchanged), a key
absent with a pool configured means SHARED. The resolved shape is RECORDED on `tenants.runpod_mode`
(migration 0018) rather than inferred from `endpoints_json`, whose meaning would otherwise change
from "endpoints this tenant OWNS" to "endpoints this tenant USES" under five readers that all treat
it as ownership.

Most of the change is guards, because the dangerous failure mode is that nothing breaks:

- the mode is written BEFORE the endpoint list, so a crash between the two leaves an inert row
  rather than pool endpoint ids under the default mode `dedicated` -- the single combination that
  makes reconciliation attribute production endpoints to a tenant and call them its debris;
- `reconcile-runpod` excludes the pool and shared rows. Without it, `claimedEndpointIds` (keyed by
  endpoint id) collapses N shared tenants to ONE claimant, so a single DELETED shared tenant emits a
  live production endpoint as `orphan_endpoint` at confidence "proven";
- the reprovision route refuses a shared tenant instead of aiming a per-tenant rebuild at the
  plane's production pool;
- a partial or malformed pool is REFUSED, never partially resolved, and the plane falls back to
  offering no shared tier.

Key B custody inverts for this tier (the key is ours, not the tenant's), and the install path is
deliberately not duplicated: the pool key travels to the existing `performInvokeKeyInstall`, so the
graphql-capable refusal still runs against it. Revoking it affects every shared tenant at once.

Both reconcile guards were proved by reintroducing the defect and watching the suite go red, which
is how the per-tenant row skip was found to be untested by the original fixtures.

NOT proven: that a shared tenant renders. That needs a live provision against the real pool. The R2
half (moving job-I/O R2 config out of the RunPod template and into the per-job payload) is a
separate change in `vivijure-backend`, and the pooled template must carry no job-I/O R2 credential
at all -- with a fallback, a job whose payload field is missing writes into the shared bucket and
succeeds. Per-tenant fairness on a shared queue is filed as cp#273, not built.

With both `SHARED_RUNPOD_ENDPOINTS` and `SHARED_RUNPOD_INVOKE_KEY` unset, this deploy behaves
exactly as it does today for every existing tenant.

### fix(provisioner): a freshly provisioned tenant now RECORDS its module release (cp#248)

`setTenantModulesRelease` was called only by the module-UPGRADE path, so `tenants.modules_release`
stayed NULL forever on any tenant that had never been upgraded, while its resident module scripts
were plainly at the pinned release. Found on a real provisioned tenant (`hosted-phase1`,
2026-08-01): `studio_release v1.13.0`, `modules_release NULL`, and its modules demonstrably at
v1.13.0 because all five recording ones answered `telemetry.job_log = true`. Confirmed at the raw
column rather than the admin projection, which renders the two differently.

Not cosmetic. `smoke-render.ts` opens every smoke render with `tenant.modules_release` under the
stated invariant "the pixels came from the module bytes recorded in `modules_release`", so on a
freshly provisioned tenant a smoke could not name the bytes that produced its pixels -- the exact
provenance gap the cf#278 phase-1 evidence depends on.

The write lands after `modules_install` (not after `modules_upload`), so a provision that dies
between the two claims no release for modules that were never installed, and it is restated in
`continueProvisionJob` because a provision that yielded and resumed reaches completion through that
function and never runs the tail of `runProvisionJob`. It is deliberately NOT folded into the shared
`runModuleSteps`: the upgrade path owns its own NULL-then-set window on this column and moving the
write inside would make that deliberate sequence read as dead code.

Three tests, and the two positives were made to FAIL first with the fix reverted. The third (a
provision that yields before `modules_install` claims no release) passes with or without the fix and
is therefore not discriminating on its own -- it exists to prove the fix does not over-apply, and it
is labelled as such rather than counted as evidence the fix works.


## v1.20.0 -- 2026-08-01

### fix(ci): the changelog-immutability waiver moves OUT of the changelog (cp#245)

`changelog-released-immutable.py` waived immutability for any released section whose body CONTAINED
the correction marker, as a substring, anywhere. The v1.19.0 section contains an entry that
documents the mechanism and quotes the marker inside backticks, so that section waived the check for
itself: the guard found drift and then permitted it. Its own positive control is what noticed, which
is the design working -- a check that plants a violation and expects a refusal sees it stop
refusing, and a pure assertion never would.

It was latent until the tag existed. The last CI run on `main` started 52 seconds BEFORE the
`v1.19.0` tag was created, so it measured v1.18.0 and passed; every run after it measured v1.19.0
and failed. `main` was green by timing rather than by health, and this blocked every PR.

- **The waiver is now `scripts/changelog-corrections.txt`,** outside the file being checked.
  Anchoring the substring would only have narrowed the shape of prose that trips it; nothing a
  changelog entry can say puts a version in that file.
- **Both halves required.** The allowlist row is the waiver; a line BEGINNING at column 0 with
  `**CORRECTED AFTER PUBLICATION` is what tells a READER the text moved. Listed-but-undeclared is a
  silent correction and is refused; declared-but-unlisted is the cp#245 defect and is refused. The
  two refusals say different things, because they send a person to different places.
- **A missing allowlist file is an empty allowlist,** so that direction fails closed and the refusal
  names the file. The opposite default would let deleting one file unlock every released section.
- **Four controls, each made to fail on purpose** before being trusted: prose that mentions the
  marker is still checked; a declaration alone does not waive; an allowlisted section that does not
  say it was corrected is refused; and, the positive control, an allowlisted+declared correction is
  still PERMITTED, because a guard that refused everything would have passed all three negatives
  while making a legitimate in-place correction impossible.

### feat(modules): bind the tenant studio D1 as `TELEMETRY_DB` on every recording module (cp#248)

vivijure-cf#279 made six module workers write a durable row per RunPod job. Module release bundles
carry no bindings -- this plane attaches them at Workers-for-Platforms upload -- so until now a
HOSTED tenant recorded nothing. The five recording modules in `TENANT_MODULE_CATALOG` now carry
`{ type: "d1", name: "TELEMETRY_DB", id: <tenant d1 uuid> }` beside their endpoint id.

- **The tenant STUDIO database, not a second one.** `runpod_job_log` is created by vivijure-cf
  migration `0014`, which rides the studio release into that database. A separate telemetry database
  would be a table nothing migrates.
- **Only the modules that record.** `plan-enhance` submits no RunPod job, so it gets nothing; a
  database it never reads would be reach for no gain. Carried as `recordsRunpodJobs` DATA on the
  catalog row, not a name check.
- **Every re-upload restates it.** A WfP upload REPLACES a script binding set, so provision, resume,
  module upgrade and RunPod reprovision all pass it or a live tenant would lose it silently.
- **A tenant with no recorded database is REFUSED at `modules_upload`**, before the namespace is
  touched, rather than getting modules that record nothing. Same posture as self-host, where the
  module `wrangler.toml` carries a placeholder `database_id` and wrangler hard-fails on it.
- **Not all six.** `finish-rife` records upstream and is published as a tenant bundle, and nothing in
  this plane provisions it, so on the hosted door its jobs do not exist rather than go unrecorded.
  Left as the product question it is; documented in the catalog and in `docs/control-plane.md`.

### feat(admin): `GET /api/admin/tenants/:id/module-readiness` (cp#248)

The binding is invisible from the outside: `telemetry.job_log` is deliberately NOT part of a module
`ok` flag (telemetry must never gate a render), so a module recording nothing reports healthy
forever, nothing waits on it, and no route reported it. A fact that gates nothing and is reported
nowhere cannot be checked, which is the same shape as not having it.

One `/ready` per catalog module, one pass, no retry, no spend, no GPU, no tenant credential.
`tenants:read`, audited as a tenant read. `job_log` is `true` / `false` / `null`, where `null` means
the worker reported no such field (an image predating the change) and is NOT a negative;
`records_unproven` carries both the explicit no and the silent unknown, because they have the same
consequence.

**Ordering.** The binding is inert until a studio release carrying vivijure-cf#279 is published and
a tenant is moved onto it: at an older pin the module bytes have no job log and no
`telemetry.job_log`, so the field reads `null` fleet-wide and the rows are not written.


## v1.19.0 -- 2026-07-31

### feat(quota): bind `R2_STORAGE_QUOTA_MODE` onto tenant studios, and give it a disposition (cp#195)

Step 2 of the storage-mode train. vivijure-core v1.4.0 reads `deny` (hard cap, the default) or
`meter` (included quota, overage billed). This binds the mode per tenant from
`TENANT_R2_STORAGE_QUOTA_MODE` on provision, studio upgrade, and the converge route.

- **Only `meter` is bound.** `deny` is core default, so binding it would spend a var slot to change
  nothing and would leave a studio on a plane that never asked for metering non-identical to one
  that never had the var. An explicitly configured `deny` is valid and binds nothing.
- **Set-but-unrecognised is REFUSED, not normalised.** core falls back to `deny` and warns, which is
  right for a studio and wrong for the plane: it would make "typed `metre`" and "wants a hard cap"
  the same outcome on a tenant the operator believes is metered.
- **The mode binds independently of the ceiling.** `meter` with no ceiling is coherent (nothing
  included, everything overage).
- **`withStorageQuota` re-derives the mode** so a plane that stops metering drops the var from a
  live tenant instead of carrying a mode nobody configures any more.

This lands before the cf release that declares the var in `ORCHESTRATOR_VAR_KEYS`, because
`assertDispositionCoversContract` throws at provision and upgrade for any manifest var with no
disposition entry.

### refactor(schema): rename `r2_storage_quota_mode` to `r2_storage_quota_override` (cp#195)

The column records whether a tenant OVERRIDES the plane storage ceiling (`NULL` inherit, `set` use
this tenant own bytes, `none` deliberately uncapped). That is an override DISPOSITION, not a mode of
anything, so the name was wrong on its own merits before any collision existed.

vivijure-core v1.4.0 then introduced a studio var genuinely called `R2_STORAGE_QUOTA_MODE`, carrying
`deny` / `meter`. Rollins put the distinction better than the original framing did, so it is his
wording in the record: **the COLUMN selects which SOURCE a tenant ceiling comes from; the VAR selects
what the studio DOES at that ceiling.** Orthogonal facts behind three shared words, one a D1 column
and one a Worker binding, and the one that actually is a mode did not own the word.

- **The sharp edge is not readability.** cp#195 implies a future PER-TENANT enforcement mode (prepaid
  metered, BYOK capped) and its obvious column name was occupied by something unrelated. Exactly one
  migration depended on the old name and the data was a day old, so this is the cheapest it will ever
  be.
- Migration `0017`. `ALTER TABLE ... RENAME COLUMN` is available on D1 and rewrites nothing: no table
  copy, no data movement, no window where a row is missing. Values untouched, name only.
- **`0014` is ANNOTATED, not rewritten.** A migration records what it DID rather than what the schema
  later became, so the old name stays where it shipped with a pointer to `0017` beside it. Rewriting
  a migration is how a ledger stops matching the database it built.
- 19 references renamed across `src/`, `tests/` and `docs/`; zero occurrences of the old name remain
  outside the migration history.

**A hole in the immutability guard, found by its own control while resolving this PR.** A merge
produced TWO `## v1.18.0` headings, and `sections()` keys by version, so the dict kept the LAST
occurrence: the guard compared that one, found it matched its tag, and reported ok while the FIRST
heading carried entries belonging to no release at all. Right about the section it looked at, blind
to the one that was wrong. Duplicate version headings are a refusal now, with a control that plants
a second heading and requires the refusal to say so.

### docs(meter): the allowance parser contract and the storage-mode name collision, recorded at the vars (cp#195)

Comment-only in `src/env.ts`. No behaviour change; recorded because both facts existed only in crew
messages and both will be needed by whoever wires the R2 overage half.

- **The allowance parser agrees with vivijure-core on everything except exponent notation, and this
  side does NOT loosen.** Verified against the shipped `parseMicroUsd` rather than read off the
  source: `"0"` -> `0`, `"1000"` -> `1000`, and `"1.5"` / `"-1"` / `"5USD"` / empty / unset all ->
  `null`, matching core. `Number()` accepts exponent notation, so core's first cut read `"1e3"` as
  `1000` while this side's `^[0-9]+$` refuses it. Ruled 2026-07-28: `1e3` in a money config is an
  accident of `Number()` rather than an intent anybody holds, so the core knob gets its own strict
  parser when it lands (vivijure-core#107) instead of the plane relaxing. That knob is NOT in core
  v1.4.0, which shipped storage-mode only.
- **`tenants.r2_storage_quota_mode` is NOT `TENANT_R2_STORAGE_QUOTA_MODE`.** The D1 column
  (migration 0014) selects which SOURCE a tenant ceiling comes from (`NULL` inherit / `'set'` /
  `'none'`); the var selects what the studio DOES at the ceiling (`deny` / `meter`). Three shared
  words, orthogonal facts, one a column and one a binding. Wiring one to the other would silently
  turn "no ceiling configured" into "bill the overage", or the reverse. Flagged rather than fixed;
  a naming ruling is pending, and the bite lands when a per-tenant ENFORCEMENT override is wanted
  and finds its obvious column name already taken.

### feat(admin): the operator console, a page in front of /api/admin/* (cp#89)

There was no admin UI at all: `public/` was the tenant front door and nothing else, and every operator
action was a bearer-token curl. This is the page, vanilla JS/HTML/CSS with no framework and no build
step, at `/admin.html`.

- **The console is a PROJECTION, and not one scope id is written down in the frontend.**
  `GET /api/admin/whoami` now serves the caller's scopes, the whole scope catalogue, AND the gate's
  own authorization table (`ADMIN_REQUIREMENTS`), so the page decides whether to offer a button by
  asking the SAME rows the gate enforces. A copy would drift the day a requirement changed
  server-side, leaving the console offering an action that now refuses or hiding one that now works.
  A scope added to `src/operator-auth.ts` appears in this UI, in the mint form and in the identity
  panel, with zero frontend change.
- **Browser credential custody: MEMORY ONLY.** The credential lives in a closure variable, is sent as
  a bearer header, and dies with the tab. Never storage, never a cookie, never a URL, never the DOM
  after submit. Reloading asks again, which is correct for a surface meant to be opened on a report.
  A consequence worth stating: there is NO ambient credential, so there is no CSRF surface at all --
  a cross-site request carries no cookie and cannot set an Authorization header, which makes every
  state-changing route here unreachable from another origin by construction. An idle lock zeroes the
  credential after 15 minutes, so the exposure window is "while an operator is working" rather than
  "while a tab is open". Rejected alternatives and the residual risk are recorded at the top of
  `public/admin.js`.
- **The document is served with a strict CSP** (`default-src 'none'; script-src 'self'; connect-src
  'self'; frame-ancestors 'none'`), plus `no-store`, `DENY`, `nosniff`, `no-referrer`. That bounds the
  residual risk: an injected inline script does not execute and an injected fetch cannot reach a
  third-party origin. A test asserts the page carries no inline script, style or handler, so the day
  someone adds one it fails rather than the policy being widened to accommodate it.
- **The audit trail is legible rather than raw**: rows an operator made against one tenant are marked
  `read`, and rows made with the shared root credential are marked `unattributed`, because "an event
  happened" and "a person did this" are different kinds of evidence and the whole point of cp#219 is
  the difference between them. A row whose detail will not parse is SHOWN raw, never dropped.

- **The console REFUSES to drive routine work with the break-glass credential**, offering credential
  management and nothing else, and it does not load the panels it declines to show, so it cannot
  write an access it refused to display. The merged privacy text says routine support access is made
  with a named credential and that the shared credential is "not used for routine support"; the
  console is the routine path, so this turns that sentence into a property of the tool rather than a
  claim about our habits. The API stays open to the root credential deliberately: disarming
  break-glass in the gate would remove it at the moment it exists for.

Sections render only when the credential can use them, including the credentials section, which the
backend makes root-only: a console that offered that button to a scoped credential would teach
operators that refusals are noise.

New: `public/admin.html`, `public/admin.js`, `public/admin-checks.js` (+ `.d.ts`), `public/admin.css`,
`tests/admin-console.test.ts`.

### feat(admin): scoped operator credentials, authenticated attribution, and a readable audit trail (cp#219)

The shared admin bearer is no longer the only way in. `/api/admin/*` now resolves a PRINCIPAL: a
named credential carrying an explicit scope list and an authenticated operator identity, or the
shared root token, which survives as break-glass. Nothing about the existing token changed for
existing callers; every route it reached before, it reaches now.

**Full contract, written to be reproducible without the code: `docs/operator-access.md`.**

- **Named credentials.** A random 256-bit token; the plane stores only its SHA-256 hex, so a dump of
  `operator_credentials` yields nothing replayable, and the plaintext exists exactly once, in the
  mint response. Optional expiry, enforced on presentation rather than by a sweep. Soft revocation
  that takes effect on the very next request and kills exactly one credential, so one member's
  credential can die without rotating everyone.
- **Seven scopes, one per hazard class rather than one per route**: `tenants:read`, `tenants:write`,
  `tenants:destroy` (irreversible, never folded into write), `studio:operate`, `credits:write`,
  `platform:settings`, `keys:rotate`. An unknown scope at mint is REFUSED, never dropped: a
  credential quietly minted without the scope its holder asked for surfaces later as a confusing 403
  during whatever incident prompted it.
- **Authorization is a TABLE consulted before dispatch, and the default is DENY.** A path with no
  entry is refused to everyone including root. A per-handler check is correct exactly as long as
  every future handler remembers to write one, and the failure mode of forgetting is an ungated admin
  route that no test notices because it works; here, forgetting makes the route unreachable. A test
  walks the router's own path patterns and fails if one is gated by nothing.
- **Credential lifecycle is ROOT-ONLY**, enforced by that table. A scoped credential able to mint an
  unscoped one would hold every scope in two requests. Same constraint Cloudflare puts on its own API
  tokens, surfaced at design time rather than at mint time.
- **cp#193's `operator_claimed` is closed.** An authenticated principal records
  `operator_authenticated` in both the ledger note and the audit detail. A body naming somebody else
  is REFUSED (`operator_mismatch`), not ignored: silently dropping it would let a UI display a name
  that is not the one recorded, which is the same false-attribution failure in a different coat. The
  root token keeps the old contract exactly, claim and all, because it still cannot prove who holds
  it.
- **Reads that reach into ONE tenant are now audited** (`tenant.read.*`), including the smoke-render
  artifact route, which returns rendered tenant content and is recorded BEFORE the fetch so a failed
  fetch is not a retry loophole. Fleet-level reads (the census, our own R2 bill, RunPod
  reconciliation, the trail itself) are deliberately NOT audited: they read our inventory, not any
  one tenant's material, and auditing them would bury the rows that matter.
- **The trail is readable**: `GET /api/admin/audit`, newest first, filterable by tenant. It has been
  append-only with no reader since migration 0001, which is durable and not reviewable, and the
  ruling on operator access asks for both.
- **`GET /api/admin/whoami`** serves the caller's identity, scopes, and the whole scope catalogue, so
  the operator console renders from what the backend declares rather than from a list baked into the
  page.

**The merged privacy text is now tested, not assumed.** `PRIVACY-DELTA.md` Section 2.3 and AUP
Section 5 promise that any access reaching into a specific tenant records who (authenticated by the
credential), what, which tenant, and when. Every tenant-scoped route in `ADMIN_REQUIREMENTS` must be
CLASSIFIED as audited or the suite fails, the four fields are asserted on a real row written through
the real router, and the root credential is proven NOT exempt (it writes the same row, attributed to
the credential rather than a person, exactly as the text discloses).

**The fail-closed default proved itself TWICE during this sprint, on two different lanes.** cp#185's
two new admin routes (`POST /api/admin/llm-meter/run`, `GET /api/admin/llm-spend`) landed on main
while this branch was open, carried no requirement, and therefore went unreachable the moment the
table arrived, with seven tests going red. They are now gated: the tick gets its own `meter:operate` scope (it mints no
money and is not a switch; it moves the cursor a billing period is built from), and the per-tenant
spend read is gated as a tenant read and audited as one, because leaving it out would make "reaching
into a specific tenant leaves a record" quietly false. It happened again on the rebase onto cp#195:
`POST /api/admin/meter-settle` landed ungated and went unreachable, and it is now `meter:operate`
alongside the ingest tick. Deliberately NOT `credits:write`: that scope mints money from nothing on
the manual rail, while settlement turns already-measured usage into the ledger rows it implies.
Different acts, different blast radius, different people should be able to hold them.

Migration `0016_operator_credentials.sql`. New: `src/operator-auth.ts`,
`tests/operator-scopes.test.ts` (44 tests, every scope boundary watched refusing WITH a positive
control beside it; the gate was sabotaged six ways and each sabotage was watched turning exactly the
right tests red, including planting a fake tenant-scoped route to prove the classification check
names it).

### fix(changelog): move three post-tag entries out of v1.18.0, and guard the heading

`CHANGELOG.md` asserted that **v1.18.0 shipped three things the tag does not contain**: cp#219
(#228), cp#223 (#230) and the cp#195 settlement trigger (#236). Verified rather than inferred:
`git merge-base --is-ancestor` reports each of the three commits NOT an ancestor of `v1.18.0`.

Root cause is the release process, not any of those PRs. #235 promoted `## Unreleased` to
`## v1.18.0` without leaving a fresh empty `## Unreleased`, the tag was cut, and the next three
merges had nowhere for their entries to land but under a released heading.

- The three sections move to a fresh `## Unreleased`. v1.18.0 keeps only what `git log v1.18.0`
  contains.
- **`scripts/changelog-released-immutable.py`** refuses it recurring. For every `## vX.Y.Z` heading
  with a matching git tag, the section body must be byte-identical to the same section in
  `CHANGELOG.md` AT THAT TAG. A property of the TREE rather than of a diff: no base ref, and it
  catches an entry ADDED under a released heading, which no line-based "did you update the
  changelog" check would notice.
- **One declared exception**, because the strict rule would have forbidden the honest thing this
  repo already did: a released section may be corrected in place when the original note was WRONG
  about what shipped (v1.17.0 said two PRs when the tag carries four), marked with a line beginning
  `**CORRECTED AFTER PUBLICATION`. Declared, never inferred, same shape as the env-census
  exemptions. An unmarked edit is refused.
- A CONTROL plants an entry under the latest released heading and requires a refusal that NAMES the
  version, since the script also exits 1 for a missing `## Unreleased` and a control accepting any
  failure would keep passing after the immutability check was gone. Watched to fail: with the
  comparison removed, the control goes red.
- The promotion rule is written into `docs/deploy.md` beside the release steps, so the next person
  cutting a tag reads it where they are already looking.
- **And the `changelog` job itself was passing VACUOUSLY.** It compared `git diff BASE HEAD`,
  two-dot, against a base that MOVES, so once another PR merged to main its files appeared in this
  PR changed list. #242 touched three files under `src/` with no entry of its own and the check went
  green, because somebody else merged PR had touched `CHANGELOG.md`: **another PR entry satisfied
  this PR requirement.** Now three-dot (`BASE...HEAD`, from the merge base), with the logic moved
  into `scripts/changelog-entry-required.py` so it can be tested at all.
- `tests/changelog-entry-required.test.py` builds a synthetic repository shaped exactly like that
  situation and asserts BOTH directions on it: two-dot passes (reproducing the bug) and three-dot
  refuses (the fix). If the fixture could not reproduce the false pass the fix would be unproven.
  A PR carrying its own entry still passes, so the fix is not merely "always refuse".
- **And the immutability guard itself was passing VACUOUSLY in CI**, caught by its own control. A
  bare `actions/checkout` is shallow and carries **no git tags**, and the guard resolves released
  sections by matching `## vX.Y.Z` headings against tags. With none present it found zero released
  sections, compared nothing, and printed ok. The planted-entry control refused to, reporting an
  empty version name, which is what surfaced it. Two fixes, because the control catching it was
  luck-adjacent: `fetch-depth: 0` on the `ci` checkout so the tags exist, AND the script now
  **REFUSES an empty comparison** rather than reporting a pass it did not earn. "Nothing to check"
  and "everything checks out" must not be the same output, which is the same lesson as a roll-up
  treating `rows_ingested: 0` as proof and a meter reporting `complete` on a reading it never made.
  A third control pins the tagless refusal so the silence cannot return if the guard moves to
  another job.

### fix(smoke-render): a deliberate studio refusal is 422, not 502 (cp#223)

The operator smoke-render route answered `502 studio_refused` whenever the tenant studio would not
build or accept the render, including when the studio refused correctly on a ceiling the operator
themselves configured. 502 means bad gateway: the upstream is broken or unreachable. Here the
upstream answered promptly and correctly, and an operator reading 502 in a log reasonably concludes
the tenant studio is unhealthy and starts looking for an infrastructure fault that does not exist.
Since cp#183 that refusal is routine rather than exotic: any tenant at their storage ceiling
produces it, and any operator testing a quota produces it deliberately.

- **A studio that ANSWERED 4xx or 5xx made a decision, so the route now answers `422`.** `502` is
  kept strictly for transport failures: the studio could not be reached, or answered something this
  plane could not parse (a 2xx carrying no bundle key or job id).
- **The studio status rides in the body as `studio_status`,** rather than being propagated outward.
  Answering `507` would claim THIS plane is out of storage, which is a lie about who ran out, and it
  would widen the statuses this route can emit to whatever a tenant studio happens to return.
- The `studio_refused` code, the message and both real numbers are unchanged. Nothing was hidden
  before; this is the outer status only.
- Callers branching on `502` from this route see `422` for the refusal case now. Every consumer
  today is an operator reading JSON.

### feat(credits): the settlement trigger, operator-runnable, on a derived period key (cp#195)

The periodic overage settlement. Wires nothing onto tenant studios yet: the plane uses the allowance
for its OWN settlement, and the tenant binding follows strummer's core train.

- **`src/meter-period.ts`** -- `billingPeriodContaining`, `lastClosedBillingPeriod`,
  `parseBillingPeriodKey`. UTC calendar month, half-open, and **derived rather than stored**: the key
  becomes the ledger's idempotency reference, so a stored key a retry could not find would mint a
  new one and charge twice.
- **`lastClosedBillingPeriod` is the default**, never the current month. Settling a month still
  accumulating computes the debit from a partial window and, being idempotent on the key, the later
  correct figure can never replace it: one early settlement permanently under-bills that month.
- **`src/meter-settle-run.ts`** -- the sweep. Sequential (matching the R2 usage sweep), skips deleted
  tenants deliberately, records a throwing tenant as unbillable and CONTINUES, and carries
  `censusComplete`. A truncated tenant census is missing MONEY rather than a wrong number: unsettled
  tenants look exactly like tenants who owed nothing.
- **`POST /api/admin/meter-settle`** -- operator-runnable, so a settlement can be forced and its
  actual result read rather than inferred from a cron log. Audited, unlike the read-only admin
  surfaces, because it moves money.
- **A MALFORMED allowance refuses the whole run** (400) rather than sweeping and reporting every
  tenant unbillable. The house rule `TENANT_R2_STORAGE_QUOTA_BYTES` already states: "typed it wrong"
  and "chose none" must not be the same outcome. An unset knob still runs and reports honestly; a
  configured `"0"` is a real decision and bills from the first micro-USD.
- **New vars, names approved by mackaye 2026-07-28**: `TENANT_LLM_SPEND_ALLOWANCE_MICRO_USD` and
  `TENANT_R2_STORAGE_QUOTA_MODE`. Declared ahead of their bindings and NOT yet bound onto tenant
  studios, because the studio-core knobs they mirror do not exist until the core train lands, and
  binding a var the consuming code cannot answer is the shape that took provisioning down on
  2026-07-27.

Verification: typecheck clean, 1359 tests green, and **10 planted defects each watched turning the
suite red**. Two of them escaped on the first pass and both were defects in MY TESTS, which is the
point of running it: the period round-trip check had no input that could distinguish it (every other
bad key was caught by the regex), and the audit assertion used `toContain`, which a renamed
`meter.settle_llm_noop` satisfies as a substring. Both tests were strengthened and both mutations
then caught.

Writing the control for the round-trip check also found a real inconsistency in this module:
`Date.UTC` maps a year of 0..99 to 1900+year, so `"0026-07"` would have produced a window for 1926,
and separately the key generator emitted an unpadded year the parser's `\d{4}` would refuse. The
year is now padded and both directions round-trip.

## v1.18.0 -- 2026-07-28

### fix(census): census `src/env.ts` against the deploy lists, and declare five vars that reached nothing (cp#218)

`scripts/var-census.py` anchored on the placeholders in `wrangler.toml.example` and asserted the
other three lists agreed. That catches "declared in some lists, missing from others" and is
structurally blind to "declared in NO list, read in code anyway": the four lists agree, by all
omitting it. `CREDITS_ENFORCING` shipped in v1.17.0 that way and never reached the Worker. Census
green, deploy green, tests green, feature dead.

- **The census now reads `src/env.ts`.** Every field of `ControlPlaneEnv` (following `extends`)
  must resolve to exactly one of: a declared var (a key in the `[vars]` table), a declared-exempt
  secret, or a declared-exempt binding. A field in none of the three FAILS, because silence is the
  bug.
- **Classification is DECLARED INTENT, not a guess from the type.** `ENV_SECRETS` and
  `ENV_BINDINGS` in `env.ts`, each `satisfies readonly (keyof ControlPlaneEnv)[]` so `tsc` rejects
  an entry that is not a field and a renamed field cannot leave a stale exemption looking like
  coverage. Flagging a secret as a missing var would have invited somebody to "fix" the census by
  writing a credential name into a tracked deploy list; flagging bindings would have put noise on
  every deploy, and a noisy guard is one people learn to ignore.
- The census refuses that wrong fix explicitly: a declared secret appearing in `[vars]`, in a
  placeholder, or in the render allowlist is named as such.
- Classification is by DELIVERY MECHANISM rather than sensitivity, which is why
  `VIDEO_FINISH_VPC_SERVICE_ID`, not a credential, is a declared secret: that is how it is
  installed, read back from the live Worker settings as `secret_text`. It and
  `CF_WORKER_UPLOAD_TOKEN` were both live on the Worker and missing from the documented secret list.
- **Five live instances of the gap, all now declared in all four lists**, all empty by default so
  behaviour is unchanged: `TENANT_SPEND_DAILY_CEILING`, `STUDIO_TOKEN_KEK_ENCRYPT_SLOT`,
  `SMOKE_RENDER_COOLDOWN_SECONDS`, `SMOKE_RENDER_DAILY_CAP`, `SMOKE_RENDER_INFLIGHT_SECONDS`.
  Every one was typed, read in production code, and unreachable by any deploy: the operator knobs
  documented as tunable could not be tuned, and the KEK rotation runbook step "set the slot and
  deploy" was not performable without editing the template first.
- **`deps.ts` now treats an empty spend ceiling as absent.** Declaring an ALLOW_EMPTY var makes it
  arrive as `""`, not `undefined`, so `env.TENANT_SPEND_DAILY_CEILING ?? "25"` would have
  provisioned every tenant with an empty ceiling. `boundFrom()` and `kekRing()` already had this
  rule; this is the third site.
- **Two new positive controls**, watched to fail with the check removed: a var typed in `env.ts` and
  declared nowhere is refused (and the refusal must NAME it, so a census failing for an unrelated
  reason cannot keep the control green), and a declared secret added to a deploy list is refused.
  The pre-existing control now copies `src/env.ts` into its tree; without it the census would have
  died on a missing file, still exiting non-zero, and that control would have gone on printing `ok`
  while proving nothing.
### feat(credits): the shared unbillable vocabulary and the overage decision core (cp#195)

The half of cp#195's LLM bundled allowance that does not depend on where the allowance knob lives.
NOT YET WIRED: nothing calls it until the `TENANT_LLM_SPEND_ALLOWANCE_MICRO_USD` name is settled
with strummer's core train.

- **`src/meter-window.ts`** -- `MeterWindow` (`window_start`, `window_end`, `complete`, `reason`)
  EXTRACTED rather than duplicated, on mackaye's ruling: the storage meter and the LLM meter speak
  one vocabulary, so a consumer writes ONE unbillable check that works for every metered class.
  `LlmSpendWindow` now extends it; the agreed cp#195 five fields are unchanged.
- **`isUnbillable()`** reads the flag as an assertion: billable ONLY on an explicit `true`, so a
  window from an older shape or a hand-built fixture cannot read as a free pass.
- **`src/meter-debit.ts`** -- `decideOverageDebit()`, pure, with the allowance INJECTED.

**Three outcomes, not two, and this is the whole design.** `debit` writes the overage. `within`
writes NO ledger row and is a complete, correct, finished answer (cp#195: usage inside the allowance
produces no ledger row). `unbillable` writes nothing because we could not establish what the usage
was. `within` and `unbillable` both write nothing, which is exactly why they must not share a name:
one says "we looked, nothing is owed", the other says "we could not look". Collapsing them turns
every gap in the meter into a silent free ride.

**Completeness is checked FIRST**, before the allowance and before any arithmetic. Checking the
allowance first would let an incomplete window whose PARTIAL total happens to sit under the
allowance report `within` -- a confident "nothing is owed" derived from data we never had, and the
most dangerous shape available here because it looks exactly like the healthy case.

**An unset allowance is UNBILLABLE, not an allowance of zero.** Same posture as
`R2_STORAGE_QUOTA_BYTES` (no default in code, because the number is a policy this repo does not get
to invent), and the direction matters: treating unset as zero would bill a tenant for every
micro-USD of something nobody configured, the one failure in this lane that costs the TENANT rather
than us. A configured zero IS a decision and still bills from the first micro-USD.

`overageIdemRef(meter, periodKey)` is deterministic and separates meter classes, since one tenant can
owe an LLM overage and a storage overage in the same period and those are two rows.

- **`src/meter-settle.ts`** -- `settleMeterOverage()`, the ONLY path from a decision to a money row.
  There is no override, no force flag and no second entry point, so an incomplete window cannot be
  billed by any path through the module. A debit writes a NEGATIVE delta (matching `captureHold`) and
  carries `cost_micro_usd` = the FULL window usage rather than the charged overage, so the allowance
  we absorbed stays visible instead of the ratio reporting full cost recovery.
- **`already_settled` is distinct from `debited`.** The ledger is idempotent on
  (`tenant_id`, `idem_ref`) and a replay is a success, but collapsing the two would make a settlement
  run report N fresh charges when it re-ran over N existing ones, which cannot answer "did this month
  settle twice".
- A refusal DEFERS billing, it does not forfeit it: a period refused on an incomplete window settles
  normally once the meter catches up. Tested.

Verification: typecheck clean, 1323 unit tests green, and 7 planted defects each watched turning the
suite red (allowance checked before completeness, unset allowance treated as zero, the total billed
instead of the difference, the allowance boundary flipped, the meter class dropped from the
idempotency key, `isUnbillable` reading `=== false`, and the malformed-usage refusal removed).

### feat(meter): the LLM meter read path -- live gateway reader, cron trigger, windowed read (cp#185)

Part two, and the part that makes part one do anything. The meter now RUNS: a concrete
`GatewayLogReader` over the AI Gateway logs API, a 15-minute cron, D1 persistence, and the windowed
read cp#195 bills from.

- **`src/ai-gateway-logs.ts`** -- the shipping reader, and the one place a real gateway is reached.
  Has its own live regression suite (`tests/ai-gateway-logs.live.test.ts`, 8 assertions, run green
  against `vivijure-hosted` on 2026-07-28) because every fact it rests on is vendor behaviour.
- **`src/llm-spend-ingest.ts`** -- one run, persisted in an order chosen for crash safety: open the
  period (unfinished), write events, close it with the TRUE count, then advance the watermark. Die
  anywhere and the record is honestly WORSE than the truth rather than better.
- **`src/llm-spend-window.ts`** -- the cp#195 contract:
  `{ cost_micro_usd, requests, window_start, window_end, complete }`, integer micro-USD.
- **`LlmSpendD1`** in `store-d1.ts`; **`scheduled()`** in `index.ts`; admin
  `POST /api/admin/llm-meter/run` and `GET /api/admin/llm-spend`.
- **New worker secret `AI_GATEWAY_READ_TOKEN`** (AI Gateway Read + Metadata Read). Absent = the
  meter does not run and writes NO period rows. See `docs/deploy.md`.

**Three vendor facts established live, correcting or refining what part one recorded:**

- **The metadata filter is NOT pair-matched.** cp#221 recorded this as unprovable; it is provable,
  and the answer is the dangerous one. `metadata.key eq "tenant_id"` AND
  `metadata.value eq "rollins-e2e"` returns the row whose `tenant_id` is `ten_de43...` -- because
  `rollins-e2e` is the value of `slug`. The dimensions are ANDed independently, so a per-tenant
  filter CAN return another tenant's row. The shipping reader therefore sends **no metadata filter
  at all** and attributes off the row. cp#221's defensive posture was right and is now load-bearing
  rather than precautionary.
- **`order_by_direction=asc` is supported**, which part one did not know. It matters: the default
  order is descending, so a row arriving mid-walk shifts older rows a position later and a paged
  walk re-reads one row while SKIPPING another. The walk is ascending.
- **`created_at gt` compares at whole-SECOND granularity**, not the millisecond the timestamps are
  rendered in (`gt ...20.999Z` returns the row at `...20.710Z`; `gt ...21.000Z` does not). So a
  watermark never skips a row, at the cost of re-reading one second per run -- free, since writes
  are `INSERT OR IGNORE` on the gateway's row id. The safe direction, now documented so nobody
  "fixes" the duplicate read into a silent skip.

**`complete: false` is reachable six distinct ways and each one is tested**: no run assigned to the
window (the shape a dead cron produces, and the one that must never bill as a zero), an unfinished
run, a run that did not paginate to exhaustion, a FAILED positive control, a retention gap, an
unpriced row, and a truncated period census. A clean window still reports `complete: true`, so the
suite cannot pass by refusing everything.

**`skyphusion-llm` is refused by name at construction.** Every other wrong gateway id lands on
Cloudflare's `200 / success:true / total_count:0` answer and the positive control catches it. prism's
gateway holds ~99,000 rows, so the control would PASS while attributing another product's spend to
vivijure tenants: the one misconfiguration the control cannot see.

Verification: `npm run typecheck` clean, 1308 unit tests green, 8 live tests green against the real
gateway, and **16 planted defects each watched turning the suite red** (half-open window assignment
flipped to overlap, `OR IGNORE` to `OR REPLACE`, the watermark's `MAX()` to a plain overwrite,
summation by `occurred_at` instead of `period_id`, the prism refusal removed, and so on).

### feat(meter): LLM spend roll-up schema and decision core (cp#185)

Part one of the per-tenant Opus meter: the schema, the pure decision core, and the injected gateway
seam. **Inert until part two** (the concrete reader, the trigger, and the windowed read the credit
ledger consumes) lands; nothing calls it yet.

- `llm_spend_events` (usage rows, owned by this lane) and `llm_rollup_periods` (the completeness
  record), plus the ingestion watermark. Integer micro-USD throughout, matching `credit_ledger`,
  converted ONCE at ingest.
- **`cost_micro_usd` is NULLABLE.** `NOT NULL` would force a row the gateway did not price to be
  written as `0`, which downstream reads as "this request was free" rather than "we do not know".
  A cached response plausibly has a real 0, an errored request may carry no cost field, and once
  summed they are indistinguishable -- undercounting, therefore undercharging, while the
  price-to-cost ratio reports cost recovery. Only two live gateway rows have been observed, so it
  is NOT established that every shape carries a cost, and the schema does not foreclose the
  distinction before that evidence exists.
- **A positive control runs on EVERY roll-up, not at build time only.** The AI Gateway logs
  endpoint answers `200 / success=true / total_count=0` for a gateway id that does not exist, so an
  empty read is indistinguishable from wrong-gateway, wrong-account, no-permission and
  rows-aged-out. `control_passed` is a SEPARATE column from `status`, because a run can paginate to
  exhaustion and still have proven nothing. A period is billable only when `status=complete AND
  control_passed=1`; absent or incomplete is UNBILLABLE, which is a different fact from zero.
- **Retention-gap detection.** Gateway retention is 10,000,000 rows `DELETE_OLDEST` with no time
  window, so "have not finished reading" and "the rows are gone" are different failures: one is
  resumable, the other is not. `gap_detected` is set when the oldest surviving row is newer than the
  watermark, and it forces the period out of `complete`.
- **Attribution is read off the row**, never inferred from a server-side filter having returned it.
  The metadata filter takes key and value as separate dimensions and the pair-versus-independent
  semantics could not be proven; if independent, a filter could attribute one tenant spend to
  another. The filter is a narrowing optimisation only.
- **Unattributed spend is kept** (`tenant_id NULL`), never dropped and never spread across tenants.
  A rising unattributed count is how a regression in the emitter becomes visible.
- Billing keys on `period_id`, never `occurred_at`, so a row arriving after settlement cannot
  retroactively reprice a period already billed. `period_id` is assigned at insert and never
  changes, since writes are `INSERT OR IGNORE` on `(source, source_id)`.


### feat(credits): payment rail seam, ManualRail, and the provisioning list (cp#193)

- **No payment processor is contained, referenced, or created here.** No Stripe client, no API key,
  no test-mode credential, no account. The ledger gets a `PaymentRail` interface and one rail that
  needs no processor, which is enough to prove the whole purchase path today.
- `ManualRail` is a REAL rail, not a stub: comping an account, correcting an incident and honouring a
  refund are permanent operator needs that outlive any processor. It is also what lets counting mode
  graduate to enforcing before a processor exists. It has no checkout surface and no webhook, so both
  interface methods REFUSE rather than returning a plausible URL to a door that goes nowhere.
- `applySettlement` is the only path that creates credit, and idempotency is anchored on the RAIL's
  own reference, namespaced by rail id so two processors cannot collide on a shared reference format.
  A replayed webhook, a retried operator click and a double-submitted form all resolve to one row.
- New `POST /api/admin/tenants/:id/credits/manual`. It mints money from nothing, so it carries more
  constraints than any other admin route: `operator`, `reason` and a caller-chosen unique `reference`
  are all REQUIRED; every attempt is audited INCLUDING replays; a replay answers 200 with
  `applied:false`, never 409, because a caller retrying after a timeout must be able to reach a
  success and stop.
- **The operator field is ASSERTED, NOT AUTHENTICATED, and is recorded as `operator_claimed`.** This
  plane has one shared admin token, so the bearer proves somebody holds the operator credential and
  can never prove which human. Recording a claimed name as a verified identity would put a false
  attribution in a money audit, which is worse than none. Real per-operator identity needs the admin
  console (cp#89).
- New var `MANUAL_CREDIT_CEILING_MICRO_USD` (default USD 100). A typo catcher, not a policy: it
  exists so a stray keystroke cannot turn USD 10.00 into USD 10,000.00. Refusing above it names the
  knob, so a genuinely large credit is a deliberate config change rather than a slip.
- `MANUAL_CREDIT_CEILING_MICRO_USD` is declared in all four deploy lists (template, render
  allowlist, and BOTH deploy render blocks), not only typed in `env.ts`. A knob declared nowhere
  reaches the Worker as empty and cannot be turned, which is the cf#56 drift class; the sibling fix
  for `CREDITS_ENFORCING` (which shipped with exactly that defect in v1.17.0) is a separate PR.
- `docs/payment-rail.md` is the deliverable for Conrad: exactly what to create, what each secret is
  named, how it travels (dashboard straight to `wrangler secret put`, never a tracked file), and what
  to verify afterwards. Includes the refunds/expiry/account-closure decision that is his and Ernst's,
  and the tax-at-purchase step that blocks launch rather than following it.

### feat(credits): the tenant-facing credit surface (cp#194)

- New `public/credits-checks.js` (pure, no DOM, `node --check` plus a unit suite) and a credit panel
  on the live-studio route of `public/index.html`, wired in `public/front-door.js`. Vanilla JS, no
  framework, no build step.
- **The surface ships DARK, deliberately.** It renders only when the plane says `credits_apply`, and
  that is false for every tenant today because the tenant class which would make it true
  (`tenants.compute_mode`) is designed in `docs/managed-compute.md` and lands with cp#191. The
  alternative was showing every existing BYOK tenant a USD 0.00 balance, which would invent a billing
  relationship they never entered into on a product whose current pitch is that there is no paid tier.
- **Applicability is never inferred from the numbers.** A BYOK tenant and a prepaid tenant who has not
  topped up both read zero; guessing from the shape of the payload is how the first gets told they owe
  us money. The API states it (`credits_apply`, `topup_available`, both always present even when
  false) and the surface renders from the statement.
- An unreadable balance shows an honest sentence and NO figure, because this is the number a tenant
  uses to decide whether they can start work. Counting mode is stated on the panel rather than left to
  be inferred from nothing being refused. Held is shown only when something is held.
- The top-up control has THREE states (hidden / not-open-yet / available), so an unprovisioned rail
  renders as a sentence and never as a control that invites a click.
- Failed jobs appear as explicit no-charge lines carrying their reason, and a zero-delta line shows no
  money at all rather than "USD 0.00" (which reads as a charge that happened to be free, a different
  claim from "we did not charge you").

### fix(deploy): declare CREDITS_ENFORCING, which shipped in v1.17.0 as a knob that could not be turned

- `CREDITS_ENFORCING` (cp#192, released in v1.17.0) was typed in `env.ts` and read by both credit
  routes, but declared in **none** of `wrangler.toml.example`, `scripts/render-wrangler.sh`, or
  either `deploy.yml` render block. It therefore never reached the Worker. The DEFAULT behaviour was
  still correct, because absent reads as counting mode and that is the ruled default, so nothing was
  broken in production. **What was broken is the ability to change it**: setting the repo variable
  would have done nothing, and every surface would have kept reporting `enforcing: false` while an
  operator believed they had switched enforcement on.
- That matters beyond tidiness: flipping this knob is a named acceptance criterion of cp#193, and its
  closing evidence is a live read showing `enforcing: true`. A knob that cannot be turned makes that
  criterion unmeetable, and the failure would have surfaced at the worst moment, next to a live
  purchase door.
- Now declared in all four lists as `ALLOW_EMPTY`, on merit: empty is not merely tolerated here, it
  is the ruled default.

**The census did not catch this, and the reason is worth recording.** `scripts/var-census.py` starts
from the placeholders in `wrangler.toml.example` and asserts the other three lists agree with it. A
var that appears in NONE of the four is invisible to it: the lists agree by all omitting it. So the
census closes the drift class where a var is declared in some places and not others, and cannot see
the class where a var is declared nowhere and read anyway, which is the original cf#56 shape. Closing
that would mean censusing `src/env.ts` against the deploy lists, which needs a vars-vs-secrets-vs-
bindings distinction the current script does not make. Filed rather than bolted on here.
### feat(hosted): bind TENANT_ID and TENANT_SLUG for per-tenant Opus attribution (cp#185)

The plane side of the per-tenant Opus meter. vivijure-cf#271 made `plan-enhance` EMIT
`cf-aig-metadata` when these two vars are bound; nothing bound them, so that half shipped inert.

Why a second mechanism exists at all: the AI Gateway records `authentication` as a BOOLEAN. It logs
THAT a request was authenticated, never WHICH token did it, so the per-tenant `CF_AIG_TOKEN` is an
access and revocation boundary carrying ZERO attribution. `cf-aig-metadata` is the entire
attribution mechanism, and Cloudflare computes `cost` natively so we never price Opus ourselves.

- Bound as `plain_text` (neither value is a secret) and scoped to `needsAiGateway` catalog specs.
- Bound UNCONDITIONALLY for such a module, NOT gated on the token pair: with the trio unconfigured
  the module runs on the free local provider and never makes a gateway call, so the vars are simply
  unread. Gating them on the token would couple two unrelated things.
- The slug is threaded through `uploadTenantModules` as a REQUIRED parameter. Attribution keys on
  the tenant id, so a missing slug is not a correctness bug, which is exactly why an optional
  parameter would rot: the compiler catches an omission instead of a human finding a blank label
  months later.

PARITY: a self-hosted install gets neither var, sends no header, and emits byte-identical requests
to before. A self-hoster bills their own account and has nothing to attribute.

ORDERING: metadata only flows once BOTH this and a studio release carrying the vivijure-cf#271
plan-enhance bundle are pinned. Each half alone is inert but harmless, so they can land in either
order.


## v1.17.0 -- 2026-07-27

MINOR: the per-tenant cost-bound lane. The prepaid credit ledger primitive (inert by design) and the
per-tenant R2 storage ceiling, which also RESTORES provisioning: the pinned vivijure-cf v1.12.0
manifest declares `R2_STORAGE_QUOTA_BYTES`, this plane had no disposition for it, and
`assertDispositionCoversContract` was therefore refusing EVERY provision and EVERY studio upgrade
against that pin.

**Carries TWO migrations, and both reach the live plane on this deploy** (verified against
`migrations/`, `git diff v1.16.0..HEAD`, not assumed from any one PR): `0013_credit_ledger.sql`
(new `credit_ledger` + `credit_holds` tables) and `0014_tenant_storage_quota.sql` (two new nullable
columns on `tenants`). Both are purely additive -- no table or column is dropped, altered or
backfilled -- so an older Worker keeps running against the newer schema, which is what makes the
migrate-before-deploy ordering safe here. Stated explicitly rather than discovered, given the cf#80
history recorded in `deploy.yml`.

**CORRECTED AFTER PUBLICATION (2026-07-27).** This section originally read "Contains two merged
PRs: #198, #199". That was wrong: `git log v1.16.0..v1.17.0` carries **four** merged PRs, and the
omitted one shipped code. The scope was cut by the release author and the error is recorded here
rather than silently rewritten, on the same principle as the SUPERSEDED markers in
`docs/managed-compute.md` -- a release note is a claim about a diff, and a false one is worth
correcting in place so the correction is legible.

Contains four merged PRs: #196, #198, #199, **#206**.

### feat(credits): balance and usage read API (cp#192, #206) -- omitted from the original notes

Shipped in this release and undocumented by it:

- **Two new HTTP routes.** `GET /api/tenant/:id/credits` (owner session) and
  `GET /api/admin/tenants/:id/credits` (admin bearer), served by one reader so a tenant and an
  operator can never be looking at different balances.
- **One new var, `CREDITS_ENFORCING`** -- which shipped **INERT**, because it was typed in `env.ts`
  and read by both routes while being declared in none of `wrangler.toml.example`,
  `scripts/render-wrangler.sh`, or either `deploy.yml` render block. Behaviour was still correct
  (absent reads as counting mode, the ruled default), but the knob could not be turned. Fixed
  separately; see the Unreleased section.

Neither route can refuse anything: nothing consults a balance until the dispatch proxy (cp#191).

`#196` is docs-only (the `docs/managed-compute.md` supersession markers) and was also absent from
the original list.

### feat(credits): balance and usage read API (cp#192)

- `GET /api/tenant/:id/credits` (owner session) and `GET /api/admin/tenants/:id/credits` (admin
  bearer). Both are served by ONE reader and differ only in what is projected, so an operator can
  never be looking at a different balance from the one a tenant was refused against.
- **Holds are projected beside ledger rows.** Under completed-only billing a failed job leaves a
  released hold and NO ledger row, so a statement built from money rows alone would show a tenant
  nothing where their failed render should be. Released and expired carry DIFFERENT reasons: "your
  job did not complete" and "your job never reported back" are different facts.
- Money crosses the wire as integer micro-USD and is formatted only at the edge. An unreadable
  balance is **503**, never 200 with zeros; an unwired credit store is **503 credits_unconfigured**,
  mirroring the existing `provisioner` precedent.
- The admin projection adds the cost side. `price_to_cost` is **NULL** when cost is unknown or zero,
  never a fabricated 1.0, and price is summed only over rows whose cost is KNOWN; unmeasured rows are
  counted (`charges_missing_cost`), not hidden. The tenant view never carries the cost side.
- `complete` (about the aggregates) and `activity_truncated` (about the feed) are separate flags, so
  `complete` does not go false on every active tenant and get ignored.
- New var `CREDITS_ENFORCING`. Enforcement mode is reported on every response.
- Fixed in passing: `MemoryStore.recordAupAcceptance` declared 4 parameters against the interface's
  5. TypeScript permits the narrower implementation, so it compiled while dropping `userAgent` and
  made a correct 5-argument call a type error. Caught by `npm run typecheck`, NOT by the suite, since
  vitest never typechecks.

### feat(credits): the prepaid credit ledger primitive (cp#189, under cp#173)

- **Schema change.** New migration `0013_credit_ledger.sql` adds `credit_holds` and `credit_ledger`.
  Nothing reads or writes them yet: no route consults a balance until the dispatch proxy lands
  (cp#191), so this ships inert by design.
- **Unit is integer micro-USD (1e-6 USD)** throughout, never a float and never cents. Conrad ruled in
  USD (USD 10 minimum top-up, USD 3-5 per film), and the measured cost basis carries USD 0.001765
  line items (`docs/cost-basis.md`), which cents cannot represent without rounding away every
  reconciliation.
- **Two tables, deliberately.** `credit_ledger` is money that MOVED: append-only, never updated, a
  correction is a new row. `credit_holds` is a RESERVATION whose lifecycle is genuinely mutable, so it
  is one keyed row updated by conditional UPDATE. Balance is a SUM over rows and never a stored
  running total.
- **Holds exist because billing is COMPLETED-ONLY** (Conrad, 2026-07-27): a failed render costs the
  tenant nothing and we eat the GPU. A charge that lands only at completion cannot refuse anything at
  submit on its own, so a tenant with USD 0.50 available could otherwise start a USD 4 film.
- **The guarantees are the database's, not the caller's:** one debit per hold ever (`idem_ref` IS the
  hold id, under a unique index); a released hold can never become a debit (the capture INSERT
  requires `status='captured'`, so completed-only billing is a WHERE clause); one capturer wins
  (conditional UPDATE on `meta.changes`); a debit cannot carry a positive sign (CHECK constraint);
  settle and charge cannot come apart (one D1 batch).
- `cost_micro_usd` sits beside the price and is **NULL when unmeasured, never 0**, so the
  cost-recovery claim is auditable per tenant rather than asserted.
- **Counting mode is the default** (`CREDITS_ENFORCING` unset = record everything, refuse nothing).
  Deliberately not fail-closed: no purchase door exists yet, so no tenant can hold a positive balance
  and enforcing by default would refuse every submission the instant the migration lands. Flipping
  enforcement on is a named acceptance criterion of the payment rail (cp#193).
- Testing: the pure decisions run with no store at all, and everything that is a property of the SQL
  runs against a real engine built from the real migrations (the node:sqlite harness gains `batch()`
  as a real transaction). There is deliberately **no fake ledger**. Every guard was watched FAILING
  under mutation before being trusted.

### feat(quota): bind R2_STORAGE_QUOTA_BYTES per tenant, at provision and at converge (cp#183)

- **Restores a broken capability, not merely a new knob.** vivijure-cf v1.12.0 declares
  `R2_STORAGE_QUOTA_BYTES` in its release manifest; this plane had no disposition for it; so
  `assertDispositionCoversContract` threw on **every provision** (`provisioner.ts`) and **every
  studio upgrade** (`tenant-studio-upgrade.ts`) against the pinned release. Found by pulling
  `studio-releases/v1.12.0/manifest.json` out of R2 (the object the deployed plane fetches), not
  from memory. The guard was right; nothing on this side answered it.
- vivijure-core v1.3.0 shipped the per-tenant storage ceiling (core#52) and vivijure-cf v1.11.0
  wired the reader, and **this plane wrote the var nowhere** (repo-wide grep: zero hits), so hosted
  shipped the enforcement bound to nobody. `SPEND_DAILY_CEILING` caps what a tenant spends in a day;
  nothing capped what a tenant ACCUMULATES, which is the bill that keeps arriving after the
  rendering stops and the one we inherit when a tenant leaves.
- **Three write paths**, because one door leaves the estate split: the provision upload, the studio
  upgrade (re-derived, never inherited, so a raised or lifted ceiling actually moves), and
  `POST /api/admin/tenants/:id/storage-quota` for tenants already live.
- **PER-TENANT overridable, including unset** (cp#173, found by joan against live core source before
  this shipped). The core knob is a submit-time DENY, so it is a hard cap: right for BYOK and
  self-host, who pay us nothing for GPU while their R2 sits on our bill, and wrong for a PREPAID
  tenant bounded by their credit balance, who would be denied at exactly the byte where charged
  overage begins. `migrations/0013` therefore keeps THREE states -- inherit / `set` / `none` -- because
  "no per-tenant value" and "deliberately uncapped" bind the same thing today and diverge the day a
  default is set. One resolution seam (`resolveStorageQuota`) serves all three write paths.
- **No default in code**, on either host: unset = no ceiling, the same posture as
  `R2_USAGE_ALERT_BYTES`. The number prices what an operator is willing to carry per tenant, which
  is policy this repo does not get to invent. It lives in the deploy variable
  `TENANT_R2_STORAGE_QUOTA_BYTES` (var census honored: template, render allowlist, BOTH deploy env
  blocks; `var-census.py` watched to FAIL with one block missing).
- **A set-but-malformed value REFUSES rather than rounding down to off.** core parses `100GB` and
  `""` identically (quota off), which makes "typed it wrong" and "wants no ceiling" the same outcome
  while an operator believes tenants are capped. It blocks a tenant who would INHERIT the value and
  deliberately does not block one who overrode it.
- **The reader floor is a PRE-write probe**, unlike cp#164: a studio carrying the core#52 reader
  serves `GET /api/storage/usage` whether or not a quota is set, so a 404 proves the reader is
  absent and the converge refuses before writing a ceiling nothing would enforce. Measured against a
  real running studio (200, `quota_bytes: null` with the quota off), not assumed.
- **Green means the STUDIO said so**: bounded-retry readback of the enforced number, 200 enforced /
  202 bound-but-not-yet-observed / 409 strand, with `ok` and `enforced` both false on the 202.
  `quota_source` and `record_written` travel in the response and the audit row.
- Carries a schema change: `migrations/0014_tenant_storage_quota.sql`.

## v1.16.0 -- 2026-07-27

MINOR: the cf#56 hosted-glue lane. Per-tenant AI Gateway credential on plan-enhance, the admin R2
usage surface, and the deploy-var activation that makes both of them actually reach the Worker.
Carries **NO schema change** (verified against `migrations/`: the v1.15.1..v1.16.0 range touches no
migration file, not assumed from the absence of a migration in any one PR).

Contains four merged PRs: #181, #182, #184, #186.

### docs: measured per-job-class compute cost basis (cp#180)

- Adds `docs/cost-basis.md` (237 lines, docs only, no code path touched). A MEASUREMENT of
  per-job-class compute cost, not a pricing design; every number carries a provenance tag
  (MEASURED / CITED RATE / DERIVED) and an untagged number is defined as a bug in the document.
  Feeds the prepaid credit design (cp#173) and the per-tenant meter (vivijure-cf#56).

### fix(deploy): activate TENANT_AI_GATEWAY_ID and R2_USAGE_ALERT_BYTES, and census the var lists (cf#56)

- Both vars were typed in `env.ts` and read in `deps.ts` but declared in **no** deploy config, so
  they rendered EMPTY and shipped their features **INERT** while every test and every deploy stayed
  green. `TENANT_AI_GATEWAY_ID` unset meant the per-tenant AI Gateway token was never bound (the
  both-or-neither guard correctly turned it into a safe no-op); `R2_USAGE_ALERT_BYTES` unset meant
  the admin usage surface could never alert. Now declared in `wrangler.toml.example`, allowlisted in
  `render-wrangler.sh`, and supplied in **both** deploy.yml render env blocks.
- Both are `ALLOW_EMPTY` on merit, not to quiet a deploy: empty gateway = `plan-enhance` runs on the
  free local Workers AI provider (a coherent working state, since the provisioner binds neither
  `GATEWAY_ID` nor `CF_AIG_TOKEN` when either is missing); empty threshold = `no_threshold`, because
  an operator who has not chosen a number has not asked to be alerted.
- **`scripts/var-census.py` closes the drift class that caused this.** A `[vars]` entry only reaches
  the Worker if it appears in the template, in a render allowlist, AND in BOTH deploy env blocks;
  nothing connected those four lists. The census asserts they agree, runs inside
  `tests/render-wrangler.test.sh` (already wired into CI), and ships with a control proving it can
  fail. Mutation-verified in both directions: dropping a var from one deploy block, and adding an
  unlisted placeholder, are each caught.

**ACTIVATION IS NOT COMPLETE AT MERGE.** Two repository VARIABLES must be set, and one of them is a
release decision, not a config nit:

- `STUDIO_RELEASE` is **v1.9.0**, and **v1.9.0 does not contain plan-enhance** (verified against the
  release tarballs: v1.9.0 ships 6 modules without it, v1.12.0 ships 7 with it). Deploying the
  plan-enhance catalog entry against a v1.9.0 pin fails **every** provision at `modules_upload`.
  It must move to **v1.12.0 or later** BEFORE the control plane carrying that entry is deployed.
- `TENANT_AI_GATEWAY_ID` must be set to `vivijure-hosted`, or the feature stays inert.

### feat(hosted): per-tenant AI Gateway token on plan-enhance (cf#56)

- `plan-enhance` joins `TENANT_MODULE_CATALOG`, so hosted tenants get the Opus director pass on OUR
  unified billing through the DEDICATED `vivijure-hosted` gateway, with a per-tenant `CF_AIG_TOKEN`
  making that spend attributable and revocable one tenant at a time.
- **`TenantModuleSpec.endpointKey` is now optional.** plan-enhance is not RunPod-backed, and an absent
  key is the honest encoding rather than a sentinel endpoint existing only to satisfy a type. A spec
  that DOES declare an endpointKey the tenant lacks still fails loudly, unchanged and tested.
- **Bindings are BOTH or NEITHER.** `pickProvider` returns `opus` only when `GATEWAY_ID` and
  `CF_AIG_TOKEN` are both present, so a half-bound module is a silent permanent fallback to the free
  local provider, not a partial feature. `AI` is bound unconditionally because the local fallback
  needs it too. The unconfigured case logs `module.ai_gateway_unconfigured`.
- **Revocation is wired on every path:** revoke-then-mint at provision AND at upgrade/converge (an
  existing tenant GAINS the module on converge, and a module shipped without its credential is one
  that quietly runs on the wrong provider), plus revoke at teardown. By deterministic NAME, so no
  migration and no new column: unlike the R2 credential, whose id doubles as the S3 access key id,
  this token id is only ever needed in order to revoke.
- **`TENANT_AI_GATEWAY_ID`** names the gateway. Unset = no gateway, and plan-enhance degrades to the
  free local Workers AI provider, which is a genuine working fallback. Never point it at
  `skyphusion-llm`; that is prism gateway and sharing it would defeat per-tenant attribution.
- Fixed while adding the catalog entry: the module-upgrade preflight derived its required-endpoint
  set from the whole catalog, so an endpoint-less spec would have refused EVERY upgrade with
  "missing the endpoint(s) needed by: plan-enhance". Now only endpoint-backed specs are checked.
- **Live-proven, not assumed:** an `ai` binding attaches to a Workers-for-Platforms user worker
  (uploaded into a throwaway namespace, read BACK off the API as `AI [ai]`, torn down); the
  provisioner credential mints an `AI Gateway Run` token (group id read off the API, never guessed);
  `vivijure-hosted` ENFORCES it (valid token 200, bogus token 401 at the gateway, no header 401);
  and revocation genuinely stops access, with a **~8-16s propagation lag**.
- **KILL-SWITCH RUNBOOK FACT:** revoking a tenant token is real but NOT instant (~8-16s). An operator
  pulling it during an incident must not read the first success as failure; re-check, bounded. Same
  family as the cf#114 edge-propagation lesson.

**DEPLOY ORDERING (this is load-bearing):** the catalog entry is only safe once a studio release
actually PUBLISHES the plan-enhance bundle (vivijure-cf#56, PR #270). `moduleBundle.fetch` throws on
an older release, and while that failure is loud rather than silent, it would fail EVERY provision.
Merge vivijure-cf#270, cut a studio release, and only then deploy this pinned at that tag or later.

### feat(admin): aggregate per-tenant R2 usage with an honest alert verdict (cf#56)

- `GET /api/admin/r2-usage` returns per-tenant bucket usage, an aggregate, and an alert verdict
  against an operator-set threshold (`R2_USAGE_ALERT_BYTES`). **Reads only**, and records no audit
  row for the same reason `/api/admin/reconcile/runpod` records none: nothing changes, and a write
  would let the pass alter what it measures.
- **Hosted-only and correctly so:** it measures OUR bill and cannot reach a tenant studio. The
  per-tenant storage QUOTA stays a studio-core operator knob (vivijure-core#52) so self-host gets the
  identical feature rather than a hosted-only enforcement path.
- **A number we could not read is `null`, never `0`.** A failed bucket read and an empty bucket are
  different facts; collapsing them makes the total under-report and the alert under-fire.
- **An under-threshold verdict requires a COMPLETE total.** `listTenants` pages at
  `TENANT_PAGE_LIMIT`, so a truncated census or any failed read makes the total a FLOOR. The verdict
  is three-state: `over` is sound from a floor, `under` requires completeness, `indeterminate` is the
  honest answer in between. `parseThresholdBytes` refuses `0` (a permanent alert is ignored).
- **Live-verified, not stubbed:** Cloudflare returns these counters as STRINGS, so a client assuming
  numbers would feed `NaN` into the aggregate. Asserted against the real API with a negative control
  proving a nonexistent bucket throws rather than reporting zero usage.
- Fix-forward: the `CANNOT mint an R2 token` live negative control mints with a BOGUS permission-group
  id, so it is refused under any credential and passed vacuously under the full token. Now skipped
  under `CF_PROVISIONER_FULL`, active under the reduced token where its premise holds.
- Fix-forward: `SPEND_DAILY_CEILING` was documented as bound only when an operator configures a
  ceiling; `productionDeps` supplies a `25` fallback, so it is bound on every provision here.
  Confirmed live on the testbed tenant studio (cf#56 item 4, no code needed).

## v1.15.1 -- 2026-07-27

PATCH: the cp#164 converge route reported a SUCCESSFUL converge as a failure, because its readback raced edge propagation. Found by running the cp#164 acceptance against the live testbed, hours after v1.15.0 shipped it. Carries NO schema change (verified against `migrations/`, not assumed).

### fix(hosted): the abuse-report-url readback raced edge propagation (cp#164)

- **Found by running the cp#164 acceptance, not by reading code.** The first live converge on the
  testbed bound the var cleanly (19 bindings to 20, nothing stranded, all four secrets intact) and
  the studio served no `host.abuse_report_url`, so the route answered **409 and told the operator to
  move the studio bytes**. Sixty seconds later the same call returned `reader_live: true` with the
  URL, twice in a row. Nothing about the studio had changed: the settings PATCH had not reached the
  isolate answering the next dispatch.
- That is the cf#114 lesson arriving from a new direction ("the secrets PUT returning 200 does NOT
  mean the edge serves the key yet"), and the first cut of this route did not apply it to its own
  readback. The cost ran the wrong way: an operator following that 409 would move a live tenant onto
  a new release to fix a problem that did not exist.
- The confirm is now **bounded-retried** (`READBACK_PROBE_MS` 2500 / `READBACK_BUDGET_MS` 15000), the
  first read still happens immediately so a current studio stays instant, and the response carries
  `readback_attempts` and `readback_elapsed_ms` as numbers rather than as a sentence.
- **Three outcomes now:** 200 bound and observed; **202** bound, nothing stranded, not yet observed;
  409 a genuine strand only. The 202 names both possible causes (the edge has not caught up, or the
  bundle predates the vivijure-cf v1.10.0 reader) because from the plane they are indistinguishable,
  and says re-run first since the route is idempotent. `ok` and `reader_live` stay false there, so
  nothing machine-readable claims an unobserved success. 202 is the shape the invoke-key route
  already uses for "stored, not yet proven".
- `docs/open-the-doors-checklist.md`: the hosted tenant-studio abuse-link row flips to **DONE**,
  riding three artifacts and carrying no residual: the converge readback (`reader_live: true`), the
  tenant serving `host.abuse_report_url` back on its own `GET /api/modules`, and the rendered panel
  eyeballed by the account owner on the testbed studio (2026-07-27). That last one is owner-side by
  construction rather than a gap: the panel is `AUTH_MODE=token` with a dispatcher-injected owner
  credential, so nobody else has a clean door to it.
- Carries NO schema change.

## v1.15.0 -- 2026-07-27

MINOR: the two ends of a hosted tenant that a human has to reach. A tenant studio can finally show a reporter where to go (cp#164), and an operator repair can finally be finished rather than stranding at a route only the account owner can call (cp#169). Two new admin routes, two new owner-facing surfaces, and new tenant-visible behaviour, hence MINOR.

**CARRIES A SCHEMA CHANGE:** migration `0012_invoke_key_handoff.sql` (new table `invoke_key_handoffs`). Additive `CREATE TABLE`, so the deploy workflow's migrate-then-deploy order is safe, but this tag DOES apply a migration on deploy.

### feat(hosted): operator-initiated, owner-completed invoke-key handoff (cp#169)

- **The strand.** A cp#137 reprovision rebuilds a tenant's four RunPod endpoints; new endpoints get
  new ids, so the stored key B is scoped to ids that no longer exist and every repair ends at
  "install a fresh invoke key" -- on a SESSION-gated route. The operator who performed the repair
  could not finish it, and the tenant sat at `awaiting_invoke_key` until the account owner signed
  in. Observed live during the cp#137 remediation.
- **Conrad's ruling: PATH 3.** The INITIATIVE moves to the operator, the CREDENTIAL DECISION stays
  with the owner. An admin-gated install (option 2) was declined deliberately: it would let an
  operator credential place a RunPod key on a customer studio.
- A successful reprovision now mints a one-time link in the same response that reports the repair,
  bound to the endpoints THAT run created; `POST /api/admin/tenants/:id/invoke-key-handoff` mints one
  on demand for a tenant stranded before this existed. The owner opens `/install-key?t=...`, reads
  what happened and which four endpoints to scope, and pastes their own key. No email integration in
  this pass (parked); the operator hands the link over through their support channel.
- **The verification is unrelaxed and unduplicated.** `verifyInvokeKeyScope` runs exactly as on the
  session route because there is now exactly ONE install implementation and both routes call it. A
  key that can reach graphql is still refused, and all four endpoint ids are still probed.
- **What a leaked link can do is bounded by RunPod, not by our clock:** the key offered must reach
  the tenant's own endpoints, which live on the TENANT's RunPod account, so the link alone installs
  nothing.
- Storage is hash-only (`invoke_key_handoffs`, migration 0012), the rule `login_tokens` and
  `sessions` already follow. Issuance AND consumption are audited, correlated by a handoff id that
  is not part of the secret; neither row carries the token or the key.
- **Single use burns on a COMPLETED install only.** A rejected key must not burn the link (a typo
  would re-strand the customer), and neither must the 202 path, whose own message says to retry.
- A handoff made STALE by a later reprovision is refused rather than honoured: installing a key
  scoped to dead endpoints would re-enter the state the handoff exists to repair.
- A link that cannot be minted does not undo a repair that already happened: the refusal is reported
  on the response and the standalone mint route is the retry.
- Schema: migration 0012 adds `invoke_key_handoffs`. Additive (`CREATE TABLE`), safe under the
  workflow's migrate-then-deploy order.

### feat(hosted): the plane sets ABUSE_REPORT_URL on tenant studios, on both doors (cp#164)

- **The reader shipped and had nothing to read.** vivijure-cf v1.10.0 validates `ABUSE_REPORT_URL`
  and projects `host.abuse_report_url` onto `GET /api/modules`, which `public/abuse-link.js` renders
  from as its sole signal. This plane wrote that var nowhere (repo-wide grep: zero hits), so no
  hosted tenant studio could show a reporter where to go -- on the surface where hosted content is
  actually seen, under an enforcement model that is report-driven by ruling and therefore has intake
  as its entire detection surface.
- **The value is DERIVED, never configured.** The intake page is served by this Worker out of
  `public/report-abuse.html` at `CONTROL_PLANE_HOST`, so the URL is a fact of the deploy: it comes
  through `publicOrigin()` like `PUBLIC_ORIGIN` and the tenant domain suffix. A second env var beside
  it could disagree with the page we actually serve. Canonical path `/report-abuse`, verified live
  (200 direct; `/report-abuse.html` 307s to it), not read off the markup.
- **HOSTED-ONLY, structurally rather than by policy.** The value is computed from control-plane env,
  inside the control plane, and the studio bytes uploaded to a tenant are the published release
  unmodified, so nothing on this path can reach the bundle a self-hoster installs. Their unset var
  renders nothing, which is correct because we are not their provider and cannot act on their
  content -- and it stays correct mid-rollout for a hosted tenant not yet converged.
- **THREE write paths, because one door leaves the estate split** (the cp#112 / cp#136 lesson): the
  provision upload reaches new tenants, `upgradeTenantStudio` reaches any tenant whose bytes move,
  and the new `POST /api/admin/tenants/:id/abuse-report-url` reaches a tenant already LIVE without
  moving bytes. A binding patch, not a re-upload: no bytes, no release, no status, everything else
  carried as `inherit` so no secret value is handled. Re-derived at every write rather than
  inherited, so a studio carrying a URL from a plane that no longer publishes that page is converged
  rather than left advertising a dead one.
- **The reader floor is a READBACK, not a version compare.** Setting the var on a studio whose
  bundle predates v1.10.0 is a silent no-op, the cf#98 / cp#112 failure family. cp#136's PRE-write
  capability probe is unavailable here: the panel emits `host.abuse_report_url` only when the var is
  already set, so its absence beforehand proves nothing. The route therefore writes, then asks the
  studio what it serves; `reader_live: false` answers 409, and the fix is to move the studio bytes,
  not to set the var again.
- `ABUSE_REPORT_URL` is `conditional` rather than `provisioned` in `src/tenant-studio-env.ts`,
  deliberately: `provisioned` joins `REQUIRED_TENANT_STUDIO_VARS`, which the MODULE upgrade
  re-checks in a verify census on a path that never touches studio bindings, so requiring it would
  fail an unrelated module upgrade on every tenant not yet converged. A studio without the var is
  fully functional.
- Carries NO schema change.

## v1.14.0 -- 2026-07-27

MINOR: two corrections that came out of running the cp#137 remediation end to end on the live testbed. The rebuild route now names WHO installs the invoke key (the account owner, not the operator, whose admin token that route refuses); and the cp#45 smoke render fixture no longer names a project the studio never assigned, which is what stopped the only renderability proof we have from passing against a backend that enforces bundle-key tenancy. Carries NO schema change.

### fix(hosted): the smoke render fixture named a project the studio never assigned (cp#137, cp#45)

- **The cp#45 smoke render could not pass against a current-pinned backend, and nobody knew.** The
  canonical storyboard shipped `title: "Control Plane Smoke Render"` with
  `projectName: "control-plane-smoke"`. The studio does not accept a caller-supplied projectName at
  all: `validateStoryboard` DERIVES it from the title and discards the field, then names the bundle
  `bundles/<projectName>-<contenthash>.tar.gz`. The render submit separately named
  `project: "control-plane-smoke"`, and backend >= 1.0.11 validates that the bundle key BELONGS to
  the submitted project (`check_bundle_key_for_project`). Bundle under the TITLE, submit under the
  PROJECT, refused before any GPU work.
- **It was masked by a stale image, not by luck.** Backend 1.0.2 had no tenancy check, and the
  standing testbed was still running 1.0.2, so this fixture has never once been exercised against a
  backend that enforces the rule. It surfaced the moment cp#137 moved that tenant onto the pin the
  plane actually holds -- which is the converge step doing exactly its job.
- Title and project are now the SAME string, chosen to be NORMALIZATION-STABLE (no whitespace, no
  `/`) so it is a fixed point of the studio's transform. Deliberately not a re-derivation: mirroring
  another repo's normalization in shipping code is only correct until they change it, whereas a value
  their transform leaves unchanged needs no mirror. The test asserts the fixed-point property and
  carries a control proving the previous title was NOT one.
- **No product exposure.** The real panel submits the projectName the studio itself returned from
  validation, so live renders were always self-consistent. This was a fixture-only defect.

### fix(hosted): the reprovision next_step names WHO installs the invoke key (cp#137, cp#169)

- The rebuild route ended by telling its caller to "POST it to `/api/tenant/<id>/invoke-key`". That
  route is OWNER-authenticated (the admin bearer is honoured only under `/api/admin/`; every other
  `/api/` path resolves a session), so the operator who just ran the repair gets a 401 there. Observed
  live during the cp#137 remediation. The text now names the ACCOUNT OWNER and says plainly that an
  operator holding the admin token cannot complete the step -- an instruction the system will not
  honour is the same defect class cp#137 exists to end.
- Wording only: no behaviour, no route, no custody change. Whether an operator SHOULD be able to
  finish a repair they started is a real custody question and is filed as cp#169, to be ruled with
  Conrad rather than patched in flight.


## v1.13.0 -- 2026-07-27

MINOR: the remediation half of cp#137. A live tenant's four RunPod endpoints can now be rebuilt through a plane mechanism rather than a hand-edit of D1, and the tenant's satellite templates are walked onto the pins this plane holds before anything is rebuilt on them. Carries NO schema change. The new route is admin-gated and takes the tenant's own RunPod key A as a transient parameter; the plane still stores no RunPod credential, so the custody boundary is unchanged.

### feat(hosted): rebuild a tenant RunPod endpoints through a plane mechanism (cp#137)

- **A live tenant can now have its four RunPod endpoints rebuilt without a hand-edit of D1.**
  `POST /api/admin/tenants/:id/reprovision-runpod` (admin-gated, `confirm_slug` required) converges
  the tenant's templates onto the pins the plane holds, revoke-then-mints a fresh bucket credential,
  rebuilds the endpoints idempotently by name, re-points the studio bindings and the module scripts
  at the new ids, and writes `awaiting_invoke_key`. Key A is a parameter: never stored, never logged,
  never on a response. This is the remediation half of cp#137, whose detection half shipped in
  v1.11.0 and proved the standing testbed reads `live` while all four endpoints it names are 404.
- **The status write comes FIRST, deliberately.** From the moment the pass begins, the studio's
  wiring is being replaced and the stored key B is scoped to endpoints about to be superseded;
  leaving `live` in place would be exactly the record-presenting-a-capability defect cp#137 exists to
  end. A failure at any step therefore leaves an honest status rather than one somebody must repair.
  `failed` is never written: the studio still exists, still serves, and its data is untouched.
- **A fresh R2 credential is forced, not chosen.** The satellite templates carry the tenant's R2
  credential in their env, and the plane stored only the token id -- the S3 secret is the SHA-256 of
  a value deliberately never kept. There is no path by which the old credential reaches new
  templates, so the mint is part of the repair and the studio secrets are re-stated in the same pass.
- **`convergeTenantTemplateImages` (new, `src/runpod.ts`): adopt-by-name kept a STALE IMAGE.**
  `createTenantEndpoints` adopts a template by name and rewrites its `env`, never its `imageName`.
  Invisible on a fresh provision; on a long-lived tenant it is cp#126 rot -- the testbed's templates
  were still on backend 1.0.2 / upscale 0.2.7 / musetalk 0.1.0 / audio-upscale 0.1.0 against pins of
  1.0.11 / 1.0.4 / 1.0.5 / 1.0.7. The new call moves them and READS BACK what RunPod holds; a pin
  that did not move throws. Scoped to the rebuild path, not to the shared customer provision path.
- **Every message leaving the module is scrubbed** (`redactSecrets`) before it reaches a caller, an
  audit row, or a log line: RunPod error text is passed through verbatim by design, and an upstream
  is quite capable of quoting the request back at us.


### fix(provisioner): honest leases at both ends -- yield hand-back, upgrade heartbeat, no claim before the first driver (cp#158, cp#132)

- **The yield left a lease nobody was holding (cp#158).** A driver that yields is out of invocation
  budget with work left, and its last `mark()` had just re-armed `lease_until` for a full 60s, so the
  job was un-drivable for up to a minute in which nothing was driving it. `releaseJobLease` lets the
  driver that knows it is leaving clear its own lease, and the next poll claims immediately. It
  leaves `updated_at` alone (a yield is not progress) and refuses a terminal job, exactly as the
  cp#148 heartbeat does. The heartbeat is stopped BEFORE the release, or a queued beat re-arms what
  was just cleared.
- **The studio-upgrade driver now heartbeats too (cp#158).** It marked only at step boundaries and
  its steps are unbounded remote work (a migration set, an asset upload session, the script PUT), so
  a slow leg made a live upgrade read as driverless. Nothing poll-driven claims that job kind, so no
  job is stolen; what breaks is the ONE-WRITER guard, since the route refuses a second upgrade on
  `jobHasLiveDriver`. A lapsed lease there admits a second driver PUTting different bytes into the
  same LIVE studio script. It takes the same exported `startLeaseHeartbeat`, not a second copy.
- **A poll may not claim a job no driver has taken yet (cp#132, the server half of cp#124).** Every
  job is INSERTed `queued` with a NULL lease and its driver is dispatched under `waitUntil` in the
  same request; the cp#148 heartbeat cannot cover that window because it opens before the first beat.
  An early poller -- a second tab, a script, an operator rehearsal -- won `claimJob` outright and ran
  `continueProvisionJob`, whose pre-`wfp_upload` refusal writes `finishJob(failed)` +
  `setTenantStatus(failed)` + a rollback that DELETES the D1, bucket and token the real driver is
  still creating. The claim also made the driver own `setJobRunning` miss its predicate, so the row
  never recorded that a driver arrived. `driveJobIfNeeded` now declines a `queued` job: report it,
  drive nothing, write nothing. A `running` job with a lapsed lease is still claimed, because since
  cp#148 that state honestly means the driver is gone.
- **The cost, named:** a job whose driver never arrives is now ended by the existing 10-minute
  lost-driver rule rather than by a poll racing it. A slow honest refusal costs a wait; a fast wrong
  one costs a customer their half-built studio.
- Docs: `docs/control-plane.md` (the provision job lease section carries all three).

## v1.12.0 -- 2026-07-26

MINOR: the operator action that was missing under cp#136 -- a studio could be TOLD the video-finish tier is unreachable, but no writer in this plane could make one tier-absent, so the state could not be displayed on a live tenant. Carries NO schema change; migration 0011 shipped with v1.11.0.

### feat(hosted): detach and reattach the video-finish tier binding (cp#136, criterion 3)

- **The gap, found by running the drill rather than by reading the code.** cp#136 made the
  `unprovisionable` state writable, but no studio could DISPLAY it: every binding writer in this
  plane either attaches the tier or preserves it (provision attaches when the service id is set,
  `refresh-studio-bindings` always appends, the studio upgrade inherits). A tenant that HAS the tier
  could never be returned to the tier-absent state the sentence describes, so the acceptance
  criterion (a human READS it on a live studio) had no honest path. The testbed proved it: the mark
  refused with `studio_reader_absent` because the studio serves `{}`, tier bound and observed
  available, correctly.
- **`POST /api/admin/tenants/:id/video-finish-binding`** with `{"attached": false|true}`,
  admin-gated, inline, one tenant per call. No bytes, no release, no status write.
- **Not a hand patch, and that is the whole point.** A settings PATCH omitting a binding DROPS it,
  which is the failure the attach path exists to prevent, so the detach runs through the SAME
  census-then-inherit-everything machinery with the same readback through the other credential. The
  only difference from attach is which single binding is left out.
- **Attach IS the cp#112 call**, not a second implementation, which makes "reattach restores exactly
  what a refresh produces" true by identity rather than by imitation.
- **Detach deliberately requires no `VIDEO_FINISH_VPC_SERVICE_ID`:** it names no service id, so a
  plane that has lost its tier configuration can still take the tier off a tenant. That is the
  direction you want to move in when something is wrong.
- **One truth at a time.** Both directions refuse `video_finish_declared` (409) while a cp#136
  declaration stands. The ATTACH guard is the load-bearing one (attaching would make the record false
  the moment it succeeded, and the panel would never surface it because an observation beats a
  label), and it lives in the SHARED preflight so `refresh-studio-bindings` inherits it too. The
  detach guard is symmetry rather than rescue: the reader floor already makes declaring a bound
  studio impossible.
- Tests: the discriminating one asserts a sent payload that omits exactly one binding and carries
  every other, which no pre-existing writer in this plane could produce; plus the custody claim on
  this path, convergence on an already-absent tier, a short-readback failure, the var re-derived
  rather than inherited, and both guards with positive controls. Two test bugs were caught by the
  fakes themselves (the shared census helper defaults to the ATTACH outcome; the memory store
  enforces the real UNIQUE(slug) constraint), which is the stubs doing their job.
- Docs: `docs/control-plane.md`, "Taking the tier OFF a studio (cp#136, criterion 3)".

## v1.11.0 -- 2026-07-26

MINOR: three operator capabilities that were each missing a half -- a record that could not be compared to reality (cp#137), a lease that expired under a driver still working (cp#148), and a panel state nothing could write (cp#136). Carries a schema change: migration 0011, additive.

### feat(hosted): reconcile a tenant record against live RunPod state, read-only (cp#137)

- **The defect:** the plane records tenant endpoints in `tenants.endpoints_json` and nothing ever
  compared that record to RunPod. The standing testbed read `status=live` while all four endpoints it
  names returned 404. `status` means "provisioning completed once", never "renders today".
- **`POST /api/admin/reconcile/runpod`**, admin-gated, DETECTION ONLY. It writes nothing, not even an
  audit row: a pass that can alter what it measures is not a measurement. Remediation is separate,
  lead-approved work.
- **The operator brings the RunPod half**, gathered with their own key via
  `scripts/reconcile-runpod.mjs`. The plane holds no credential that can read the RunPod account of a
  tenant (key A used once and never stored, key B invoke-only), so it cannot poll RunPod and a
  background reconciler is not buildable without breaking that custody boundary on purpose.
- **Both debris layers, always.** Deleting an endpoint does not delete the template underneath it
  (cp#117), so records are compared against the endpoint list AND the template list; an
  endpoint-only sweep removes half the debris while reading as complete.
- **An unprovable check never reads as a clean one.** The snapshot must state `complete` explicitly,
  the plane marks its own census incomplete on a full `listTenants` page, and any finding resting on
  a census that was not proven whole is reported `unproven` rather than asserted.

### fix(provisioner): the job lease means A DRIVER IS ALIVE, not A STEP BOUNDARY HAPPENED RECENTLY (cp#148)

- **The defect:** `provision_jobs.lease_until` was written only by `setJobRunning` and by each step
  `mark()`, so ANY unmarked stretch longer than the 60s lease expired it under a healthy driver. Two
  stretches are long enough in practice: `runpod_endpoints` (one uninterrupted call, four endpoints)
  and the stretch from that mark to `wfp_upload` (studio assets plus the worker script). A poll then
  won the now-free claim and ran `continueProvisionJob`, which refuses anything short of
  `wfp_upload`, and that refusal wrote `finishJob(failed)` plus `setTenantStatus(failed)` plus a
  destructive rollback. The invocation never "ended at `runpod_endpoints`"; the job was taken from a
  driver that was still working.
- **Confirmed against prod D1**, not just against the constants: the cp#117 rehearsal job
  (`job_1cc93d7e8d7cf62a78d79441`) has `steps_done` running THROUGH `runpod_endpoints` with
  `error_step` = `wfp_upload`, which is `inferStep` over those five steps. So the driver survived the
  ~87s RunPod call and recorded it, and the poll that killed the job arrived during the STUDIO UPLOAD
  that followed. The fatal window was the second long stretch, which is why the fix is a general
  heartbeat rather than anything specific to `runpod_endpoints`.
- **The fix:** a live driver heartbeats its own lease every 20s for as long as its invocation lives
  (`renewJobLease`), so an expired lease means a dead driver and nothing else. The `wfp_upload`
  boundary is now reachable at ANY prefix duration instead of only a fast one.
- The heartbeat renews `lease_until` and NOT `updated_at`: liveness and progress are different facts,
  and bumping both would make a live-but-wedged driver immortal against the lost-driver rule.
- `updateJobProgress` and `renewJobLease` now both refuse a TERMINAL job. A driver that lost its job
  runs on to the end of its invocation, and its late mark used to overwrite the terminal step and
  re-arm the lease on a failed row.
- Repaired for free, same column: `claimReclaim`, `beginTeardown` and `jobHasLiveDriver` were reading
  that lease to refuse acting under a live provision driver, and during a slow `runpod_endpoints` a
  reclaim could have blanked the tenant resource columns underneath it.
- The first-poll constant is deliberately NOT touched: a later poll changes discovery time, not
  outcome, and an earlier one would have made the old race MORE likely.
- Docs: `docs/control-plane.md`, "The provision job lease, and why a driver heartbeats it".
### feat(hosted): the plane WRITES the finish-tier state the panel reads (cp#136)

- **The gap:** `vivijure-cf` resolves three states for the video-finish tier and reads the third off
  the studio var `VIDEO_FINISH_TIER_STATE`. Nothing in this plane ever wrote it, so
  `unprovisionable` could not occur in production and the sentence written for it (cf#243) shipped
  into a state no studio could enter. This is the writer, and it unblocks `vivijure-cf` PR #244.
- **It is a DECLARATION, not a derivation, and that was the decision the issue asked for.** No
  plane-side condition computes unreachability: with `VIDEO_FINISH_VPC_SERVICE_ID` set the studio
  resolves `available` by observation, and with it unset an operator can still reach the studio
  through `refresh-studio-bindings`, so every derived writer writes `provisionable` forever. The
  tempting nearby wiring is worse: the tier being DOWN is transient and the panel sentence ("cannot
  be turned on for it") is permanent, so an outage-driven writer would tell every tenant the tier can
  never be turned on and keep saying it afterwards.
- **One writer, one source of truth.** `tenants.video_finish_unreachable` (migration 0011, with its
  mandatory reason and timestamp) is the record; the studio var is a PROJECTION re-derived at every
  write to the studio: the provision upload, the studio-upgrade re-upload, and the new route.
  Re-derived rather than carried, because `inherit` PRESERVES a var: without this a cleared
  declaration would survive the next bytes move and keep displaying a sentence the plane no longer
  believes. Omitting a non-secret binding DROPS it, so omission is how a clear reaches the studio.
- **What clears it, stated because a label that cannot be removed becomes a lie:** the route
  explicitly, and the binding arriving implicitly (the panel lets a bound tier beat any var).
- **`POST /api/admin/tenants/:id/video-finish-tier-state`**, admin-gated, inline (the answer IS the
  evidence), one tenant per call. Changes no bytes, no release, no status; the tenant keeps serving.
  A reason is mandatory to declare and meaningless to clear.
- **THE READER FLOOR IS A REFUSAL.** Setting the var on a studio whose bundle predates the reader
  (`vivijure-cf` `ba61789`, first tagged v1.9.0) is a silent no-op, which is the cf#98 / cf#118 /
  cp#112 failure family. The route asks the STUDIO what it serves and refuses unless
  `capability:video-finish` is present in `host.hooks_unavailable`; a served field is the tenant
  assertion about itself, where a release number is only our claim about it. The floor gates
  DECLARING only: un-saying something is always allowed.
- **The readback carries the reader half:** `served_reason_before` / `served_reason_after` /
  `served_reason_changed`, verbatim and never compared against a local copy of the panel copy. The
  plane can prove it bound a var; only the studio can prove the panel projection changed. A readback
  that disagrees with the intent answers 409, not 200.
- Tests: the discriminating one asserts what was PASSED to the write call (recording proxy) and was
  watched FAILING against the never-written behaviour, with a positive control proving the proxy
  records; the reader-floor refusal was watched failing with a positive control that the same path
  accepts a reader-capable studio; the upgrade drop-guard covers both directions and was watched
  failing without the reconcile; plus a real-SQLite round trip over migration 0011.
- **Not done, and tracked rather than implied:** no live studio is in the state yet, and cp#136
  stays open for that leg. The bundle half of the precondition is already met (the live tenant is at
  v1.9.0 since cf#248), so what remains is a studio with the tier UNBOUND plus the sentence read by a
  human. A studio that HAS the binding cannot display the sentence by construction, because the panel
  lets an observation beat a label, and this route refuses to declare on one rather than writing an
  inert var.
- Docs: `docs/control-plane.md`, "Declaring a studio UNREACHABLE for the video-finish tier".

## v1.10.0 -- 2026-07-26

MINOR: the studio bytes-move capability (cp#139) -- the operation that was missing between `refresh-studio-bindings` (bindings, never bytes) and `upgrade-modules` (module bytes, never the studio).

### feat(hosted): `studio_upgrade` -- move a LIVE tenant onto a newer studio release (cp#139)

- **The gap:** no operation in this plane moved a live tenant's studio bytes. `runProvisionJob`
  uploads once at creation, `continueProvisionJob` refuses anything short of `wfp_upload`,
  `upgradeTenantModules` deliberately never touches the studio, `refreshStudioBindings` (cp#112)
  changes bindings and explicitly not bytes, and teardown deletes. A tenant could therefore be handed
  the BINDING for a feature and never the CODE that projects it.
- **The custody objection was measured away, not argued away.** cp#112 refused a re-upload because a
  live studio carries secrets the plane cannot reproduce. Probes settled three facts: `inherit` works
  on the UPLOAD endpoint (new bytes land, `secret_text` survives, the caller never holds the value); a
  non-secret binding OMITTED from an upload is DROPPED while a `secret_text` one survives; and new
  assets coexist with `inherit` bindings on the same PUT. Hence census-then-inherit-everything, which
  is correctness rather than caution.
- **`POST /api/admin/tenants/:id/upgrade-studio`**, admin-gated, one tenant per call, explicit
  required release with NO default to the plane pin (the same refusal the module upgrade makes, for
  the same reason). New `studio_upgrade` job kind on the existing release-pair columns.
- **Migrations run BEFORE the bytes**, tracked per-migration and idempotent. Not theoretical: the
  v1.6.0 -> v1.8.0 move adds `0012_wan_lora_keys.sql`, so bytes-without-schema would have been a
  defect on the first real upgrade.
- **NEVER writes `tenants.status`,** on any path. A live tenant stays live and keeps serving; progress
  and failure live on the job row. `studio_release` is CLEARED before the first write and set only on
  full success, so a partial move cannot leave a tag standing that claims it finished.
- **The result is a readback, not a success flag:** bindings/secrets before and after, anything
  missing, the required-vars re-check, the sha256 of the bytes shipped, and the served `/api/modules`
  host keys before and after. A short readback FAILS the job even though every call returned 200.
- In place only, no automatic rollback (rollback is a re-run at `from_release`), and a same-release
  convergence run is allowed and honestly reports `served_shape_changed: false`.
- Docs: `docs/control-plane.md`, "Moving a LIVE tenant onto a newer STUDIO release".

## v1.9.0 -- 2026-07-25

MINOR: the KEK rotation capability (cp#95), and the studio release pin advanced off a release that
predates the hooks channel (cf#243 Lane S).

### feat(hosted): KEK rotation capability with a dual-read window (cp#95)

- **The gap:** `tenants.studio_token_enc` is the only customer credential this plane stores as a
  usable value, and the key protecting it could not be changed at all. Rotation was an incident
  rather than maintenance, a lost key had no migration path, and the absence distorted a real
  decision during the 2026-07-25 recovery: re-key looked expensive because the capability did not
  exist.
- **A two-key RING.** Reads try BOTH installed keys, always, so a row opens whether it was written
  before, during, or after a rotation and dispatcher-injected auth keeps serving through the window.
  Writes use exactly ONE key, named by `STUDIO_TOKEN_KEK_ENCRYPT_SLOT`.
- **The write slot is config, not runtime state**, for two load-bearing reasons: the sweep and the
  live provision path must write under the same key or the sweep is outrun by provisions forever;
  and flipping the write direction of every stored customer credential should be a reviewable deploy
  rather than a toggle. A slot naming `next` with no next key installed REFUSES to encrypt; it never
  falls back to the primary, because that would write live credentials under a key the operator
  believes is retired.
- **Two admin routes:** `GET /api/admin/kek/status` (census) and `POST /api/admin/kek/reencrypt`
  (sweep; idempotent, resumable, compare-and-set so a mid-sweep re-mint wins and is reported as
  `raced`). The sweep answers 200 only when a FRESH census says the outgoing key can be dropped.
- **The census is three buckets** because AES-GCM cannot distinguish a wrong key from a corrupt one:
  `on_target` / `needs_rotation` / `unreadable`, and an unreadable row holds `safe_to_promote` false
  rather than being retried forever as if it were work.
- **Operationally inert on this deploy.** With no `STUDIO_TOKEN_KEK_NEXT` installed the ring is a
  ring of one and the write slot is `primary`, which is byte-for-byte the previous behaviour.
  Nothing rotates until an operator starts a rotation.
- Escrow companion shipped in `crew-secrets` (#222): escrow the new key BEFORE installing it.
  Procedure: `docs/deploy.md`, "Rotating `STUDIO_TOKEN_KEK`".

### chore(hosted): STUDIO_RELEASE advanced v1.6.0 -> v1.9.0

- **The defect this closes:** the plane shipped studio **v1.6.0** to every tenant it provisioned.
  The hooks channel (`hooks_unavailable`) first appears in vivijure-cf **v1.8.0**, so every tenant
  was born unable to report which hooks it cannot serve, permanently, and no copy change could
  reach them. Found during the cf#243 live-tenant parity work: the one live tenant carries the
  `VIDEO_FINISH_VPC` binding but emits no hooks channel at all.
- **Why it mattered beyond one tenant:** with signups closed the estate is a single testbed, so this
  read as a per-tenant curiosity. It is not. Every FUTURE tenant would have arrived the same way,
  which breaks the three-population reach model at the source rather than at the edges.
- The target bundle was read back from the `vivijure-studio-releases` mirror before the pin moved
  (worker.js 530770 bytes, manifest, 48 assets, 6 modules including `finish-rife`, which v1.6.0
  lacks entirely). A pin pointing at an absent or partial bundle fails every future provision at
  `wfp_upload`, so the read-back is a prerequisite and not a formality.
- **NOTE, two version lines:** this is control-plane v1.9.0 pinning vivijure-cf v1.9.0. The
  coincidence is not a relationship; the repos version independently and the numbers will diverge
  again.

### feat(abuse): a public report-abuse page on the hosted front door (cp#130)

- **The gap:** enforcement here is report-driven by ruling, so intake is the ENTIRE detection
  surface -- and it had no placement a stranger could reach. It lived in
  `docs/legal/hosted/REPORT-ABUSE.md` (a file in a repo) and in the AUP served behind the signup
  gate. The person most likely to report is someone who came across a hosted render and has no
  account; they can read neither.
- `/report-abuse.html` on the front door, unauthenticated by construction (only `/api/*` is gated;
  pages fall through to `ASSETS`), plus a persistent footer link on both front-door pages.
- **Deliberately static:** no script tag, no form, no analytics, no third-party asset. A reporter
  should not have to run our JavaScript, or be counted, to tell us something is wrong.
- **The only outbound links are the NCMEC CyberTipline (`report.cybertip.org`) and INHOPE
  (`www.inhope.org`)**, asserted as the complete external set.
- **Promises ordering, not latency** (Ernst's cp#115-consistent wording): the page commits to what
  happens and in what order, not to a response time we have no staffed clock behind.
- **Ships with this worker deploy** because its `public/` assets ride the bundle. Documented here
  rather than left to be discovered after the tag.

### docs

- `docs/legal/hosted/PRESERVATION-PATH.md` acceptance criterion 7 quote closed (cp#117).
- Abuse intake latency promise corrected (cp#130).
- Served-surface census done by enumeration rather than by grep (cp#130).

## v1.8.1 -- 2026-07-25

PATCH: the tenant satellite pins and the mechanism that keeps them honest (cp#126), plus the
onboarding poll-boundary fix (cp#124) -- its `public/` assets ship with this worker deploy, so
it is documented here rather than left under Unreleased while the tag deploys it.

### fix(hosted): tenant satellite pins have ONE source of truth (cp#126)

- **The defect:** the provisioner pinned backend 1.0.2 / upscale 0.2.7 / musetalk 0.1.0 /
  audio-upscale 0.1.0 while production rendered on 1.0.11 / 1.0.4 / 1.0.5 / 1.0.7, so every hosted
  tenant was provisioned onto images several release lines behind anything the estate verifies.
  Nobody was careless: "pin BOTH panels on a release" never grew a third leg for the plane, and
  there was no place a wrong pin could be SEEN. Found live during the vivijure-cf#240 verify render.
- **The pins now mirror production, not the newest tag.** All four move to what the production
  endpoints actually run (read off `t9wcvlxh8rc5la`, `4q8idwbk6tyqbq`, `zw6pt4lymf69pk`,
  `sj0btgpjdtswa7` on 2026-07-25), and each pin records the endpoint it mirrors and the date it was
  read. Deliberately NOT the newest published tags: production had not adopted them, and musetalk
  1.0.6 carries an HTTP serve path production has never run. A paying tenant is not where that gets
  discovered.
- `src/satellite-pins.ts` is the one place a version lives; `src/runpod.ts` decides layout, labels,
  GPU class and worker counts, and a test keeps image literals out of it.
- **Drift is loud now.** `npm run check:pins` (creds-free GHCR resolution by image name) runs in CI
  on every PR, so a pin at a tag nobody pushed cannot merge. `npm run check:pins:prod` compares the
  pins to the live production endpoints and is the third leg of a satellite release. Exit 2 (check
  could not be performed) is never treated as a pass.
- Docs: the release rule, and what a pin change does NOT reach -- a live tenant keeps the pins it
  was provisioned with, because the plane holds no key that could repin it (KEY A is used once and
  never stored). Plus the cycle-the-workers requirement after any repin.

No behavior change for existing tenants; this changes what a NEW tenant is provisioned onto.

### fix(onboarding): the build screen waits out the provision poll boundary (cp#124)

- **The defect:** the page started polling the job immediately after `POST /api/tenant/provision`.
  A poll before the plane records `wfp_upload` cannot drive the provision (the RunPod setup key is
  never stored, so the keyless continuation refuses by design, cp#18); the only thing it can do is
  win the job lease and write that refusal, which marks a HEALTHY in-flight provision `failed` and
  rolls the half-built tenant back, leaving a customer to reclaim out of it. Seen live on
  2026-07-25 (vivijure-cf#240): attempt 1 polled immediately and declared the failure, attempt 2
  waited about 90 seconds past the boundary and completed 9/9.
- **The fix, in two halves.** The first poll waits `PROVISION_FIRST_POLL_MS` (90s, the cadence
  proven live) behind a counting-down wait row that says why the screen is quiet; the wait is the
  page own clock and is labelled as such, never a claim that a step is done. After that the cadence
  comes from the JOB, not from a timer: slow (15s) while `steps_done` has not recorded the boundary
  step, fast (2.5s) once the poll genuinely is the engine. A clock says what we hoped happened,
  `steps_done` says what did.
- **Also fixed, same screen:** the build rows matched on `d1`, `r2`, `runpod`, `studio`, `verify`,
  and a real job reports `d1_create, d1_migrate, r2_bucket, r2_token, runpod_endpoints, wfp_upload,
  modules_upload, modules_install, verify`. Only the last one ever matched, so a live provision
  rendered as five untouched rows and then a tick. Rows now map onto the real step names, and the
  test pins that set against `PROVISION_STEPS` imported from `src/provisioner.ts`, so a renamed or
  added step fails CI instead of quietly rendering as a row that never lights up. The preview mock
  reported the same invented vocabulary and now carries the real payload shape.
- **A failure the screen cannot place is no longer dropped:** an error on a PRECONDITION step
  (`bundle_fetch`, which is exactly what a bad release pin produces) gets its own row.
- Server-side behaviour is UNCHANGED: this is the client half. The plane can still be walked into
  the same refusal by any other caller that polls early (recorded on cp#124).

## v1.8.0 -- 2026-07-25

MINOR: two feature-class changes (cp#112, cp#118).

### feat(hosted): an operator can give an EXISTING tenant a studio binding (cp#112)

- `POST /api/admin/tenants/:id/refresh-studio-bindings`: admin-gated, per-tenant, inline, and
  idempotent by convergence. Closes the gap where cf#118 could reach only tenants provisioned after
  the knob was set, because the studio upload happens in exactly one place (`runProvisionJob`).
- **Bindings only, on purpose.** It sends a settings PATCH carrying `{ "type": "inherit", "name" }`
  for everything it keeps, so it handles no binding VALUE at all. A re-upload cannot: two of a
  tenant studio four secrets (`R2_S3_SECRET_ACCESS_KEY`, `RUNPOD_API_KEY`) are unreproducible by
  this plane by design, and restating the binding set without them would stop the tenant rendering.
  Studio bytes, `studio_release` and `tenants.status` are untouched; a live tenant serves throughout.
- **Refuses before it writes:** `not_provisioned`, `video_finish_unconfigured` (cp#109 honest
  refusal), `job_in_progress` (no racing a provision that owns the binding set), and a named
  `vpc_binding_unauthorized` that points at `CF_WORKER_UPLOAD_TOKEN` rather than at the tenant.
- **Answers with a READBACK, not a success flag,** taken through a different credential than the one
  that wrote; a binding or secret missing afterwards answers 409 with the names.
- **The CF contract is measured, and measuring it caught a defect.** Live probe against a throwaway
  script: the endpoint takes multipart (a JSON body is refused `10001`), so the first implementation
  would have failed on every call; `inherit` does preserve a `secret_text` binding; and a binding
  omitted from the patch is DROPPED, which is undocumented and is why the full desired set is sent
  every time. The wire shape now has its own regression test.
### feat(abuse): interlock teardown against an open preservation hold (#118)

- **New `preservation_holds` table (migration 0010) + three admin routes**, and teardown refuses the
  whole pass while any hold on the tenant is open. Before this, nothing in the code stopped an
  irreversible teardown of a tenant under an open abuse report; the control was an operator
  remembering ABUSE-RESPONSE-RUNBOOK.md Section 5.2. Suspend stays the lever for an open incident.
- **A table, not a column, because two statutory clocks can run at once on one tenant:**
  `ncmec_2258a_h` (1 year, 18 U.S.C. 2258A(h)(1) as amended by Pub. L. 118-59) and `le_2703_f`
  (90 days, renewable, 2703(f)); 2258A(h)(4) says they do not limit each other. `internal` covers a
  report that has not started either clock.
- **An elapsed clock does NOT release a hold.** The interlock keys on `released_at IS NULL` alone:
  `expires_at` is the floor of the duty (2258A(h)(5) permits longer, 2258B(c) puts destruction on a
  law-enforcement request). Releasing is an explicit, single-use, audited human act with a mandatory
  reason.
- The refusal uses the referential-guard vocabulary, so the teardown route reports it under
  `refused` rather than `failed` -- the interlock working, with nothing to retry. If the store
  cannot answer whether a hold is open, teardown fails closed.

## v1.7.1 -- 2026-07-25

PATCH: fix/deploy class, no feature surface.

### fix(teardown): a 404 worker delete is success-equivalent, so the column blanks (#110)

- A delete that answers *not found* reached its goal earlier, by something else. Teardown now blanks
  that column exactly as it would on a delete it performed, so the row can reach provably-reaped and
  a re-run can clear a stale entry. Previously the two already-gone rows a guarded sweep met kept a
  `teardown_failures` entry no re-run could ever clear, over a worker that does not exist.
- **Narrow by construction:** the classifier requires HTTP 404 **and** CF code 10007 together, and
  that shape was live-probed against both dispatch namespaces rather than read off a docs page. A
  403, a 500, or a 404 with no code stays a failure (a missing namespace is a config fault, not an
  absent script). CF prose is never matched.
- **Recorded, not swallowed:** a new `absent` list on the teardown outcome, surfaced in the
  `POST /api/admin/tenants/{id}/teardown` body and in the admin-action audit row, plus
  `teardown.worker_absent` / `teardown.module_absent` log lines. `reaped` is still read back off the
  row and cannot carry the distinction, which is why absence is reported beside it.
- Same treatment on the module-script sweep, where it is a list-then-delete race rather than the
  common case; the census remains the witness that nothing is left resident.

## v1.7.0 -- 2026-07-25

MINOR: the cf#118 tenant-side binding (#109) is feature-class.

### feat(hosted): tenant studios carry the video-finish binding (vivijure-cf#118)

- `VIDEO_FINISH_VPC_SERVICE_ID` set -> every tenant studio is provisioned with the `vpc_service`
  binding, so assemble and mux work for tenants instead of degrading to per-shot clips. Unset ->
  no binding and the honest degrade, exactly as before.
- **Second credential, by constraint not preference:** `CF_WORKER_UPLOAD_TOKEN` owns tenant script
  upload (the call that attaches bindings), because CF will not let an API-created token mint one
  carrying Connectivity Directory scope. Optional; absent it falls back to the provisioner
  credential and nothing changes. The asset-upload session runs on the same credential as the
  script PUT that redeems its JWT.
- **Refuses honestly:** a configured tier that cannot be attached FAILS the provision at
  `wfp_upload` with a message naming the plane's credential. It never drops the binding and
  continues -- that would ship a tenant silently missing a tier the operator configured.
- Isolation on the shared tier documented as what it is: the container never receives a credential
  (per-object presigned URLs), so it is by construction, not by policy.

## v1.6.0 -- 2026-07-25

MINOR: the teardown production caller (#103) is feature-class. Entry moved OUT of the
v1.5.0 section it was mistakenly filed under -- the v1.5.0 tag predates the #103 merge, and a
changelog claiming a feature its tag does not contain is the trap this cut corrects.

### feat(teardown): the production caller, and empty-then-delete wired in (#23, cf#72)

- `POST /api/admin/tenants/{id}/teardown` -- admin-gated, audited, runs INLINE because the response
  IS the evidence: `reaped` (read back off the row, not from the return value), `refused` (the
  referential guard working) and `failed` (calls to retry) are three separate lists.
- `confirm_slug` required; `delete_data` defaults to FALSE (worker + module scripts + credential go,
  the data stays). `deleted` is written ONLY on a clean pass that was allowed to take the data, so
  the status keeps meaning "provably reaped".
- `beginTeardown` / `finishTeardown`: ONE destructive lease per row, shared with the reclaim path
  (overlapping teardowns issue the SAME slug-derived deletes). A tombstone being re-swept stays a
  tombstone; `deleted_at` is preserved, never rewritten.
- Teardown now EMPTIES a tenant bucket before deleting it: it mints its own bucket-scoped credential
  and revokes it before returning on every path, and the referential guard runs BEFORE the mint --
  emptying is the irreversible half, so a bucket another row references is never opened at all.
  A bucket too large for one budget reports an honest re-run-to-continue instead of failing.
- `ProvisionDeps` gains `now` / `sleep` / `fetch` (the emptying loop is budgeted); production wires
  the real three in `productionDeps`, unit tests script S3 and THROW on any other fetch.

## v1.5.0 -- 2026-07-25

### feat(hosted): tenant programmatic API token endpoints (vivijure-cf#94)

- `GET/POST/DELETE /api/tenant/{id}/api-token`. Separate credential from the dispatcher-injected
  `STUDIO_API_TOKEN` (ruled): revoking it can never sign the owner out of their browser session.
- **The plane stores no part of it.** The token is a row in the TENANT's studio DB holding only a
  SHA-256 hash, so reveal-once is true by construction. `GET` therefore carries no masked `display`
  field -- masking implies keeping a copy.
- Refuses `not_provisioned` when the studio has no `STUDIO_API_TOKEN`, because the studio's gate 403s
  before consulting named tokens and the minted credential would fail on arrival.
- `CfApi.queryD1` gains real parameter binding; migration 0009 adds `tenants.api_token_rotated_at`.
- Contract + the custody pin documented in `docs/control-plane.md`.


### feat(r2): bounded empty-then-delete cycle (vivijure-cf#72)

- `src/r2-empty.ts`: ListObjectsV2 + batched DeleteObjects over the S3 API, so a tenant bucket that
  has been rendered into can finally be removed. R2 refuses to delete a non-empty bucket and its REST
  API has no object list/delete at all, which is why de-provision could not complete.
- **Invariant, stated in the file: MINT -> WORK -> REVOKE -> YIELD.** Each cycle mints its own
  credential, does bounded work, and revokes before returning. No credential outlives its invocation
  and none is persisted; a large bucket empties across N cycles instead of failing terminally.
- `emptied` is only ever claimed from an **observed empty listing**, never inferred from "we deleted
  everything we saw".
- Live-proven against real R2, including the positive control that the old `deleteR2Bucket` still
  fails on a non-empty bucket, so the fix cannot pass for the boring reason.


### feat(r2): SigV4 header signing, proven against the official AWS vectors (cf#72)

- `src/sigv4.ts`: AWS Signature Version 4 header-based signing (arbitrary method, headers, body), the
  capability the R2 empty-then-delete leg needs. The existing presign helper is query-based, GET/PUT
  only, and test-side by contract, so it could not sign a ListObjectsV2 or a DeleteObjects POST.
- **S3 flavour stated explicitly:** the canonical URI is used AS GIVEN, no path normalization, because
  S3 is the documented exception and an object key legitimately contains `.`/`..`/`//`. The suite's
  `normalize-path` cases are deliberately NOT vendored: they encode non-S3 behaviour and passing them
  would mean the signer was wrong for its only caller.
- Proven against the **official AWS SigV4 conformance vectors**, vendored byte-for-byte from a pinned
  `boto/botocore` commit with AWS's LICENSE and NOTICE. All three stages asserted (canonical request,
  string to sign, Authorization) so a failure names the stage that diverged.


### fix(teardown): referential guard, column blanking, and a recorded outcome (#23)

- **Referential guard, fail-closed.** `teardownTenant` now asks whether any OTHER tenant row still
  references a resource before reaping it, and refuses (recording who, and whether they are live) if
  one does. A census of the live plane found ONE D1 referenced by NINE tenant rows -- eight
  tombstones and the live tenant -- because resource names derive from the SLUG and freeing a slug
  RENAMES the old row. Tearing down any tombstone would have deleted the live tenant's database,
  bucket and worker. If the guard cannot run, nothing is deleted.
- **Columns blank only on that resource's successful deletion**, so a row can no longer read as
  reaped while a customer's bucket is still there.
- **The outcome is recorded** (`teardown_at`, `teardown_failures`, migration 0008), keeping
  "attempted and clean" distinguishable from "never attempted".
- `docs/control-plane.md` documents slug-reuse-is-resource-reuse as a structural fact, including why
  the reclaim path is NOT exposed to it (`TIER_A_STATUSES` excludes `deleted`).


### test(reclaim): the reclaim SEQUENCE runs against real infrastructure (#38)

- `claimReclaim -> teardown -> reclaimSlug` now runs as ONE pass with a real store (real migration
  ledger) on one side and real Cloudflare resources on the other. Both halves were separately
  live-proven; the join between them had never run.
- Covers what was mock-only: the ordering, the exclusivity write refusing a second claim under a
  live lease, the lease-token check refusing a blank without it, the row actually blanking, and a
  follow-on provision job starting on the reclaimed row.
- The node:sqlite D1 shim + migrated-db helper move to `tests/sqlite-d1.ts` so the sequence
  rehearsal drives the SAME store harness as the store-half proofs rather than a second one.


### fix(test): live provision e2e drives the step machine the way production does (#4)

- The suite generates its own **ephemeral KEK**; `STUDIO_TOKEN_KEK` is off the required-env list.
  It round-trips in-process over a `MemoryStore` tenant, so the live worker KEK was never needed and
  admitting it would only widen that credential's custody into CI. This was #4's recorded blocker
  and it was a premise error.
- The suite now **resumes on a budget yield** (`runProvisionJob` -> `continueProvisionJob`), matching
  the `deps.ts` start/resume wiring the tenant job poll drives. A real provision yields after
  `wfp_upload` at ~23s under the 15s invocation budget, so the previous single-invocation assertion
  could never pass against real infrastructure.
- `docs/deploy.md` records the KEK recovery search as **exhausted** and the value as unrecoverable
  (worker secrets are write-only), plus the escrow gap and the re-key cost that follow from it.
- **Dispatch door for the suite.** There is no out-of-worker HTTP path into a WfP dispatch namespace
  (`*.workers.dev` TLS covers one label; WfP user Workers are not published there at all), so the
  suite deploys an ephemeral `e2e-harness-dispatcher-<run>` in `beforeAll` and deletes it in
  `afterAll`, verified from the account. It carries a per-run bearer AND a tenant scope baked into
  the deployed artifact, because both namespaces are shared with production tenants. A leftover
  harness fails the run loudly.
- The e2e tenant **id** now carries the run token. Module script names derive from the tenant id, so
  the old fixed `ten_e2e` put every run's module workers at identical names inside a shared
  namespace, and `ten-e2e` could collide with a real hex tenant id beginning `ten_e2e...`.


### fix(hosted): module-upgrade jobs claim a lease and self-heal (#44)

- `setJobRunning` runs synchronously on accept and again at upgrade entry, matching provision.
- The upgrade-route 409 guard keys off a **live lease**, not bare `queued`/`running` status, so a
  dead driver no longer wedges every future upgrade for that tenant.
- `jobHasLiveDriver` exported from `store.ts` (same expired-or-absent lease reads as free).

## v1.4.3 -- 2026-07-23

PATCH. K3 stale-job clock fix (#79).

- **fix(security):** use `deps.now()` for stale-job detection instead of `Date.now()` (K3 verify)

## v1.4.2 -- 2026-07-22

PATCH. SSO redirect harden + audit CI.

- **fix(security):** reject SSO `redirect_to` backslash / protocol-relative open redirect (#76)
- **docs:** clarify studio PIN is studio-only; module bundles are self-anchored (cf#147)
- **ci:** adversarial security audit workflow

## v1.4.1 -- 2026-07-22

PATCH. Provisioner rollback on failed provision (cf#91).

### fix(provisioner) -- auto-teardown on failed provision (cf#91)

- Failed provisions auto-unwind created resources (re-fetch tenant row, then `teardownTenant`).
- R2 token revoke falls back to deterministic name (`vivijure-tenant-<slug>-r2`) via a
  result_info-checked token census when the id was never persisted.
- Persist `r2_token_id` immediately after mint (before hashing the secret value).

## v1.4.0 -- 2026-07-19

MINOR. The demo-hardening batch: everything merged after the v1.3.1 outage fix, shipped together
because control-plane deploy is tag-only. This is the release that makes tonight's work LIVE -- until
it deploys, the site still serves the pre-batch behavior (the cold-401 intro and the live-tenant 503
below).

### Availability: the tenant job poll drives PROVISION jobs only (#56)

A tenant polling its own job page during an admin module upgrade could win the job claim and be driven
through `continueProvisionJob`, whose success path writes `awaiting_invoke_key` -- taking a LIVE tenant
non-routable (503) on the branch where the upgrade SUCCEEDS. The poll now refuses to drive any job kind
it does not own; it still reports the job. Guard placed before the stale-job branch, which also closed
a second `setTenantStatus("failed")` instance of the same class.

### Onboarding: the signed-out intro renders without a 401 (#67)

The intro eagerly fetched the session-gated `/api/tenant/provision-plan`, so every unauthenticated
visitor -- i.e. everyone on a cold visit, and everyone while signups are closed -- saw a red "Could not
load the setup plan: unauthorized" and a spinner that never resolved. That is exactly the first screen
an outside evaluator sees. The intro now renders a clearly-labelled representative example with no
network call; the real numbers are fetched behind the sign-in for the Review step.

### Operator + client surfaces

- `modules_release` and the job row are readable (#43, #57): the release pair projects on the tenant
  view and `GET /api/tenant/:id/job` reports `kind`, `from_release`, `to_release`, `finished_at`. The
  answer to "what version is this tenant on?" now exists over the API instead of only in prod D1.
- The invoke-key 202 emits structured facts, not just prose (#27, #59): a `readiness` object a client
  can compose from, with the four load-bearing claims (installed, stored, retry, do-not-re-paste) as
  assertable fields rather than substring greps. `message` retained for one release.

### The onboarding transport seam is testable (#31, #58)

`onboarding.js` no longer owns any transport; the request-building code lives once in
`onboarding-api.js` behind one seam, replacing a mirror that asserted a copy of the code rather than the
code. A tripwire fails if `onboarding.js` ever regrows a fetch.

### Deploy safety (both first exercised by THIS release)

- Post-deploy human-surface smoke check (#63, #64): the release run now asserts the human-visited front
  door actually renders (200 AND text/html AND a real front-door body), turning the v1.3.1 outage class
  into a red run in seconds instead of days of green silence.
- Tag-deploy ancestry guard (#62, fc#859): the release job refuses to deploy a commit that is not on
  `main`, closing the `git tag v9.9.9 <unmerged-commit>` bypass around branch protection.

## v1.3.1 -- 2026-07-19

PATCH, and an outage fix. **The hosted control plane had served no human-visitable page since
v1.3.0.** `/` and every HTML, CSS and JS path returned 500 while every JSON route returned 200, so
the plane looked healthy to every check anyone was running.

### The ASSETS binding was never created (#60)

`assets` is a **bare TOML key**, so it binds to whatever table header precedes it. The
`[observability]` table added in v1.3.0 landed above it, and the line was silently parsed as
`observability.assets`. The top-level ASSETS binding therefore did not exist, and
`env.ASSETS.fetch(request)` at the end of `src/index.ts` threw on undefined for every asset path.

wrangler's only protest was a warning that is easy to scroll past:

```
Unexpected fields found in observability field: "assets"
```

The fix is a **move**: bare top-level keys go above the first table header. The comment now records
that the position is load-bearing, because the line reads as equally correct in either place, which
is precisely why it shipped.

### The gap that let it ship is closed too

Every render guard asked *"did the render succeed?"*. None asked *"is the result the config we
meant?"* -- and a render can succeed while binding nothing. `tests/render-wrangler.test.sh` now
parses the rendered TOML and asserts a top-level `assets` key, `binding == "ASSETS"`,
`run_worker_first`, and the absence of a stray key under `[observability]`.

The guard was watched **red** before being trusted: a negative control regenerates the exact broken
shape and requires the assertion to fail against it. Its output is captured rather than printed,
because a deliberate `FAIL` line in CI teaches people to ignore real ones.

This is the second config-shape defect on this file the unit suite could not see; `run_worker_first`
was the first, on 2026-07-17. The suite never loads the asset layer.

**Still open:** nothing verifies at deploy time that a human-visited path returns 200. `/ready` does
not cover it. That check is what would have caught this in minutes instead of days.

## v1.3.0 -- 2026-07-19

MINOR: an operator can finally watch a hosted tenant actually render, the plane gets a diagnostic
surface, and a provision records where its time goes (cp#45, cp#18, cp#43).

### Operator verification route (cp#45)

Until now the release standard -- **nothing is verified until someone has looked at the actual output**
-- was not performable for a hosted tenant by anyone without the control-plane KEK. The tenant studio
serves its root publicly but gates every API path, and the only credential that can drive it is
encrypted in D1 and decryptable only inside the worker. Every hosted module release to date rested on
install-and-probe evidence, never on observed output.

- **Three admin routes**: open a canonical smoke render, drive it, and **stream the artifact bytes back
  through the plane** so an operator can actually look at them. The third one is the point; returning an
  R2 key to someone who by construction cannot reach the tenant would be `phase=done` wearing a hat.
- **No credential leaves the worker.** The studio token is decrypted per call, used, and dropped. It
  never crosses the interface, never reaches the store, never reaches a response. The client is **four
  typed calls with constant paths**, deliberately NOT a generic "dispatch this path to that tenant"
  helper, which would have been a permanent operator proxy into every customer studio.
- **Spend guard is part of the build, not a follow-up**, because this route costs GPU by definition.
  The payload is canonical (tenant id and nothing else, so it cannot be turned into a film), plus a
  per-tenant cooldown, a platform-wide daily cap, and one render in flight per tenant. Guards live in
  the `WHERE` of a single conditional INSERT: the WRITE authorizes, the read only explains.
- **What it does NOT bound, stated plainly**: dollars (it bounds invocations, and a cold GPU costs more
  than a warm one), a tenant's own rendering, a job already handed to RunPod, or an operator who simply
  waits out the cooldown.
- Rendering through a non-tenant door remains rejected. It would produce a satisfying artifact that
  answers a different question.

### Per-step provision timing (cp#18)

- Every `mark()` now logs `provision.step` with **`stepMs` (that step alone)**, cumulative `elapsedMs`,
  and the driver phase. Previously timing was recorded ONLY on yield, so a provision that SUCCEEDED
  produced no timing anywhere, and D1 never held it either (`steps_done` carries step names, and
  `updated_at` is overwritten on every write).
- **Additive only**: the budget logic and yield boundary are untouched, and the instrument deliberately
  does not perturb what it measures. It reuses the timestamp the log line already read rather than
  calling the clock twice, and the log lands BEFORE the budget throw so the step that triggers a yield
  is not the one measurement that goes missing.
- `stepMs` is mark-to-mark and therefore includes the previous step's progress write, because the
  invocation budget is consumed by everything on the wall clock. The first step additionally carries
  unmarked precondition work; read it as "everything up to and including this step".

### Observability

- **Workers Logs enabled on the control plane**, which had no observability surface at all.
- Tenant telemetry design recorded in `docs/tenant-telemetry.md`: operational fields only, with the
  content-carrying fields excluded and a written per-field disposition. Design only; nothing is wired.

### Docs

- Backfilled the missing v1.2.0 and v1.2.1 entries, including the fact that v1.2.0's headline route
  shipped non-functional.

## v1.2.1 -- 2026-07-19

PATCH: the module-upgrade route could not insert its job, so the feature v1.2.0 had just shipped could
not succeed for any input at all (cf#103).

- **`createModuleUpgradeJob` wrote bare words where it needed string literals**:
  `VALUES (?1, ?2, module_upgrade, queued, ?3, ?4)`. SQLite parses a bare word in `VALUES` as a COLUMN
  REFERENCE, so every call threw `SQLITE_ERROR` and the route answered `500` for every tenant and every
  release. Fixed by quoting them. The correct pattern (`?3` bound, `'queued'` quoted) sat 17 lines above
  in `createProvisionJob`.
- **468 green tests could not have caught it.** Every test in the repo builds a hand-written
  `MemoryStore`, so no test ever handed a `store-d1.ts` SQL string to a SQL engine. Every literal, column
  name, and clause in that file was unverified by construction.
- **`tests/store-d1-sql.test.ts` (new)** drives the REAL `D1Store` against real SQLite built from the
  real `migrations/`, and reads results back through SQL rather than trusting `RETURNING`. Two controls
  (`createProvisionJob`, `getTenantBySlug`) prove the harness discriminates.
- Found by a live rehearsal on the first real call, after unit tests, code review, and a production
  deploy all passed. Standing consequence recorded: **a store or SQL layer exercised only through a fake
  is UNTESTED**, and only a live run against real infrastructure says otherwise.

## v1.2.0 -- 2026-07-18

MINOR: module upgrade for live tenants, and the slug-reclaim lane (cf#103, control-plane#18).

**Correction, recorded rather than quietly fixed:** the module-upgrade route below shipped
NON-FUNCTIONAL in this version and could not succeed for any input. See v1.2.1. The slug-reclaim work in
this release was unaffected and did work as described.

### Module upgrade

- **Ship a new module release to a LIVE tenant without taking it down.** The tenant keeps serving
  throughout; the upgrade runs as a job with progress recorded per step.

### Slug reclaim

- **Tier A slug reclaim executes**, so a slug held by a tenant that never went live can be freed and
  re-provisioned by its owner without operator SQL.
- **Slug lease tiers with the WRITE as the enforcement point, not the check.** The check is never the
  gate; a conditional write is. This is the pattern the rest of the lifecycle now follows.
- **Reclaim is serialized on a lease** so two concurrent attempts cannot destroy each other, and a
  reclaim is REFUSED while a provision driver holds the lease. A lease expires, so a dead reclaim
  self-heals rather than stranding the row.
- **Teardown reaps the STORED script name**, not one recomputed from the slug.
- Live teardown rehearsal run against real Cloudflare rather than against fakes.

### Fixes

- Onboarding names the unproven modules instead of rendering `[object Object]` to the customer.
- The invoke-key contract is read as the route actually serves it, and the summary `ok` field is dropped
  from both invoke-key outcomes (cp#20).
- One slug rule shared by the preview and provision paths, so the two cannot disagree.

## v1.1.1 -- 2026-07-18

PATCH: the readiness probe stops failing customers for a benign propagation delay, and its diagnostic
actually reaches them (control-plane#17). Both defects were found by the cf#114 live verification.

- **A deadline with every module still `not_visible_yet` is now a SOFT outcome**, not a failure. The
  key is installed and the condition self-resolves, so the route answers `202` naming
  `modules_unconfirmed` and telling the caller to retry without re-pasting the key. The tenant is
  **not** promoted, so an unconfirmed module can never be rendered against. Measured cause: a
  first-ever key write to five fresh module scripts exceeded the 10s deadline and passed a minute
  later. The deadline was validated only against a virtual clock, which cannot measure the edge.
- **Every `misconfigured` verdict still fails HARD and immediately** (absent endpoint id, non-200,
  malformed envelope, echo mismatch). The soft path is deliberately narrow; widening it would be the
  laundering this design refuses. Mutation-tested in both directions.
- **`TenantModuleError` now surfaces as `503 modules_not_ready` carrying the real message** (module,
  script, retryability, attempts, elapsed) instead of falling into the top-level catch and reaching
  the caller as a bare `500 internal_error`. cf#114 exists because a misleading error fired at the
  worst possible moment; it shipped with an opaque one at that same moment.
- **Route-level tests asserting what the CALLER receives on every outcome.** This is the actual fix:
  every prior test asserted what the probe threw or returned, and none asserted the response, which
  is exactly how the opaque 500 shipped green.
- No invented lifecycle value: the unconfirmed response reports the tenant's TRUE stored status
  rather than a label no store ever holds.

## v1.1.0 -- 2026-07-18

MINOR: the plane stops promoting a tenant to live on a credential whose propagation nothing has
observed, and finally answers "what is running" (cf#114; vivijure-control-plane#13).

### Module readiness probe

`installInvokeKey` writes key B to the studio and all five module scripts. A `200` from that PUT
means the secret is STORED; it does not mean the version the edge serves can read it. A tenant that
had just reported `live` failed its first render citing a credential that was demonstrably present,
and the identical payload succeeded 45s later (cf#99 finale, run 5).

- **New `TENANT_MODULE_DISPATCH` binding** so the plane can reach tenant module scripts, which carry
  no public route. Typed OPTIONAL: a deploy predating it reports UNVERIFIED, never a false pass.
  **Deploy prerequisite:** the namespace must exist before deploying with the binding present (it is
  created lazily by the provisioner, so a fresh account may not have it yet).
- **`awaitTenantModulesReady`** probes `GET /ready` on all five module scripts after the key-B
  fan-out and BEFORE the tenant flips live. Retryable ONLY on the not-visible-yet shape (endpoint id
  present, key absent); a missing endpoint id, a malformed envelope, or any other status fails
  immediately. A genuinely absent credential fails LOUDLY at the deadline with attempts and elapsed,
  which is what stops the retry from laundering a real misconfiguration into a success. A throw
  leaves the tenant at `awaiting_invoke_key`.
- **Budget-aware (cf#112 / cf#113):** one 10s deadline across ALL FIVE modules, probed concurrently
  per round, because this runs in a route a customer is waiting on. Not five sequential deadlines.
- **A 404 is reported `unverifiable`, not failed and not passed, and the cause is NOT guessed.**
  Hard-failing would mean a tenant on an older pin could no longer install a key at all. But a 404
  means "nothing answered here", which is a stale module image OR a missing script, and those are
  indistinguishable from the control plane; the detail states both rather than asserting the
  flattering one. The invoke-key response carries `modules_ready` / `modules_verified` /
  `modules_unverified`, per module with its script, never collapsed into one summary.
- **The `module` echo is checked** against the module being probed. Script names are tenant-prefixed
  and derived, so without it a naming bug lets a healthy NEIGHBOUR answer and be read as proof about
  the wrong module. A mismatch is a hard failure.

### `GET /api/platform/version`

`CONTROL_PLANE_VERSION` was referenced by nothing at runtime, so confirming which release was live
meant reading a patched line off a fetched asset. Now a one-line answer, from the same constant the
lockstep gate pins to `package.json`. Its own route, not a field on `/api/platform/config`: that one
is a policy projection with a UI contract, and deploy identity does not belong in it.

## v1.0.1 -- 2026-07-18

**Security PATCH.** Closes a polynomial ReDoS (CodeQL `js/polynomial-redos`, high) in the email
sanity check on the login door. Ships minutes behind v1.0.0 because the defect was live in the plane
before the extraction too; v1.0.0 neither introduced nor worsened it.

### The defect

`looksLikeEmail` ran on **unauthenticated** input at the login-start door, and it ran **before** the
rate limiter, so anything quadratic in it was reachable by anyone with no throttle in front of it.
It came across from `vivijure-cf` with the extraction; the extraction is simply what first put a
scanner on it.

Measured rather than assumed. The blow-up needs a FAILING match: a trailing `@` the segment class
cannot consume, which forces backtracking across every split of the repeated run.

| input | before | after |
| --- | --- | --- |
| `"a@" + "b.".repeat(10000) + "@"` | ~90ms | ~1ms |
| `"a@" + "b.".repeat(40000) + "@"` | ~1371ms | ~1ms |
| `"a@" + "b.".repeat(80000) + "@"` | ~5517ms | ~1ms |

Clean quadratic. 5.5 seconds of CPU from one request body is a denial of service on a Worker with a
CPU budget.

### Two fixes, redundant on purpose

- **Ordering.** The 254-character cap was checked AFTER the regex (`RE.test(e) && e.length <= 254`).
  `&&` short-circuits left to right, so the regex ran on UNBOUNDED input and the cap protected
  nothing. Length is checked first now, bounding the work whatever the pattern does. This was a real
  defect on its own, not just scanner appeasement.
- **Ambiguity.** The domain part was `[^\s@]+\.[^\s@]+`, where `[^\s@]` also matches a dot. That
  overlap between the segment class and the separator IS the backtracking. The segment classes now
  exclude the dot, so every character has exactly one role and the match is linear.

### Behaviour change, stated rather than slipped in

The stricter domain rejects consecutive dots (`a@b..c`), which the old pattern accepted. That
address is not deliverable, so rejecting it is correct, and the endpoint answers 202 for every
outcome regardless (it must not become an account-enumeration oracle), so nothing user-visible
moves. Pinned by a test.

### Tests

18 added; there were none. The file records what they can and cannot prove: the regex fix IS
isolated (exercised against `EMAIL_RE` directly, on input the length cap would otherwise reject), but
the ordering fix is NOT independently observable, because with a linear pattern the ordering makes no
difference and the end-to-end timing test only fails if BOTH regress. Said plainly in the test rather
than left to imply a guarantee that does not exist.

### Same class, second site: the AUP tag matcher (#11)

Found by Joan checking her own files after the first finding rather than assuming the scanner had
covered them -- it had passed her earlier PRs without flagging this.

`TAG_RE` in `public/onboarding-checks.js` had a `\d+` followed by a class that also matches digits,
so a long digit run could be split many ways and a failing match cost O(n^2). Measured on
`"v1.1." + "1".repeat(n) + "!"`: doubling n quadrupled the time (2000 -> 1.60ms, 16000 -> 99.55ms).
Fixed by forbidding the tail to start with a digit, which makes the digit run maximal and removes the
ambiguity. Differential-tested over 400k randomized strings: zero behaviour change.

**Severity LOW, and not dressed up.** That input is the ref parsed out of `AUP_URL`, which is
operator-set deploy config, not user input -- nobody reaches it without already controlling the
deploy. It rides this patch because it is the same defect class and the fix is cheap and proven, not
because it is urgent. `SHA_RE` and the slug matcher in the same file measured flat and are untouched.

### The AUP_URL moving-ref guard accepted four branch refs (#12)

Joan drove the REAL render script with a 16-case corpus instead of reading the glob, and found the
guard accepting `/raw/develop/`, `/blob/trunk/`, `/blob/head/` (HEAD was covered, lowercase was not)
and `/blob/Main/` (the glob was case-sensitive). It refused `/main/` and `/master/` correctly, which
is exactly why it read as working.

Each one is a branch ref, and a branch ref as `AUP_URL` means the policy text an account accepted can
change afterwards while the recorded `sha256` still claims to describe it -- the precise failure the
guard exists to prevent. Each case was reproduced as accepted BEFORE the patch, then watched flip to
refused.

This has to ride a tagged release rather than sit on main: `deploy.yml` checks out the TAG, so the
guard only takes effect once tagged.

### CI: the CodeQL language pin never applied (#10)

Not a runtime change, recorded because it explains why two ReDoS defects sat unflagged. The workflow
passed `language` (singular) to `codeql-action/init`, which takes `languages`. Actions does not fail
on an unknown input, so the pin was silently ignored and auto-detection ran instead. It happened to
find MORE than the pin claimed, so there was no coverage gap, no failing check, and nothing to
notice. Now stated correctly, with `actions` and `python` declared alongside
`javascript-typescript` rather than narrowed away.

## v1.0.0 -- 2026-07-18

The hosted control plane becomes its own product, in its own repository, serving from its own
tagged release.

Before this, the control plane lived inside `vivijure-cf` and was deployed by hand. That meant
anyone who wanted to self-host Vivijure Studio carried the machinery for running a hosted service
they had no intention of offering, and it meant the live plane ran an untagged working state rather
than a release. Both are fixed here.

### The extraction

- Extracted from `vivijure-cf` at commit `59b3fb38` (vivijure-cf#85). Pre-extraction history stays
  in `vivijure-cf`; no history was rewritten in either repository. See `NOTICE`.
- `vivijure-cf` remains a complete, self-hostable Studio with no requirement to operate a hosted
  service. Nothing in this repository is needed to run Studio yourself.
- The two repositories are coupled ONLY through the published Studio release artifact -- the
  versioned bundle contract, pinned by `{tag, manifest_sha256}`. There are no source-level imports
  across the boundary, and there must never be.
- Studio release pin floor: **v1.3.1**.

### Tag semantics, split

Each repository now versions and deploys its own product. The shared-tag double duty is gone:

| tag | deploys |
| --- | --- |
| `v*` here | the control plane |
| `v*` in `vivijure-cf` | the Studio panel |

### Migrations apply on deploy (vivijure-cf#80)

Schema now reaches the live control-plane D1 through the deploy pipeline or not at all. No
hand-applied schema, ever.

This closes a defect that produced two live provisioning failures in a single evening. The live
database had been built by hand: `0001` applied raw, `0002` skipped entirely, `0003` applied after
the fact, and no `d1_migrations` ledger to notice any of it. The symptoms were an AUP acceptance
returning 500 on a missing `aup_sha256` column, and a provision dying at `r2_token` on
`no such column: r2_token_id`.

- migrations are applied **before** the worker deploys, so new code never runs against old schema
- a separate verify step re-lists migrations afterwards and fails the deploy if any remain pending,
  because `apply` exiting 0 proves only that it did not error
- migrations must be additive; a destructive or narrowing change needs expand/contract across two
  releases (`CONTRIBUTING.md`)

### Deploy pipeline

- `v*` tag only, never a push to `main` -- an ordinary merge must not redeploy the live plane
- the tag must match the declared version, so a build cannot ship reporting a version it is not
- config is rendered from `wrangler.toml.example` at deploy time and fails closed: every injected
  value is required unless explicitly allowlisted, the D1 id is checked by shape rather than mere
  presence, and `AUP_URL` is refused if it points at a moving ref
- a `workflow_dispatch` dry run validates configuration and reports pending migrations without
  writing anything; the writes live in a separate job so a dry run skips them by construction

### Also here

- `zone-security/` -- the vivijure.com zone WAF as code, moved from `vivijure-cf`, in log mode.
  The flip to enforce is a separate launch gate.
- Born at the full aviation-grade standard: `main` requires PRs, blocks force-push and deletion,
  and gates on `ci` / `coverage` / `CodeQL`.
