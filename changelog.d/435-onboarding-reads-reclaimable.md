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
