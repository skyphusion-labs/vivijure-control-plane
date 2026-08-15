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
