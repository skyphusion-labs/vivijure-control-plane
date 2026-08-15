### feat(runpod): PROVISION_PLAN capabilities carry a TRANSPORT, so upscale reaches our own iron (cp#396)

`SHARED_RUNPOD_ENDPOINTS` is all-or-nothing across plan keys, and the shared invoke key was minted
with NO access to `vivijure-video-upscale` or `vivijure-audio-upscale` because those two run as
always-on serve containers on propagandhi and fatmike. **So the correct pool config could not be
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
