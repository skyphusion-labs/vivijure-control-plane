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
