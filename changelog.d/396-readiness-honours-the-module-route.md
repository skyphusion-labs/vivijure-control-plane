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
