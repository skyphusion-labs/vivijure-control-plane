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
