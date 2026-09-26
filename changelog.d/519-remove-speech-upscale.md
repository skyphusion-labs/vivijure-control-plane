### fix(runpod): remove speech-upscale and its audio-upscale plan key

Conrad ruled `speech-upscale` out on 2026-09-26, for four reasons at once: its
RunPod endpoint `sj0btgpjdtswa7` no longer exists (cf#757), so the plane pinned
`vivijure-audio-upscale:1.0.7` against nothing; its only planner trigger was the
`finish-lipsync` checkbox removed in cf#785, so nothing could select it; the
dialogue cleanup it did existed to feed POST-HOC mouth replacement, which
`infinitetalk` now does at motion time taking Cast audio directly; and
resemble-enhance is CUDA, one of the three GPU stages the finishing tier's
destination cannot host (fc#2234).

`speech-upscale` (the vivijure-cf module) and `audio-upscale` (the plan key and
the `vivijure-audio-upscale` image) were two names for one capability, joined by
the `TENANT_MODULE_CATALOG` row, so both leave together. Dropped: the catalog row
(18 modules to 17), the `PROVISION_PLAN` door entry (4 capabilities to 3, 1
own-iron instead of 2), the `SatelliteKey` union member and its pin, the five
`SPEECH_*` fields in `ControlPlaneEnv` with their `ENV_SECRETS` entries, and
`SPEECH_UPSCALE_DOORS` from all four var lists together. The account-wide worker
quota is UNCHANGED at 4: this capability was door-backed and spent none, so no
saving is claimed.

The removal hands back no quota but it does remove a door: `SPEECH_UPSCALE_DOORS`
pointed at `speech-upscale-fatmike` and `-propagandhi`, Traefik hosts on the
retired Hetzner fleet, so the module had been reaching nothing for weeks while the
finish tier booked the degrade as `completed`.

`audio-upscale` is added to `RETIRED_ENDPOINT_KEYS` rather than deleted. Every
dedicated tenant provisioned before cp#396 got a `vivijure-<slug>-audio-upscale`
endpoint and the template under it; dropping the plan key alone makes that
surviving debris report as `unattributed` instead of as that tenant's orphan, and
the slug is what an operator acts on. Proved load-bearing: removing just that one
string turns four assertions red across `reconcile-runpod.test.ts` and
`runpod.test.ts`, including the orphan counts (4 templates to 3, 8 findings to 6).

`TENANT_STUDIO_VAR_DISPOSITION.SPEECH_UPSCALE_DOORS` is KEPT, and that is
deliberate. The pinned `STUDIO_RELEASE` (v1.33.9) still declares the var in its
`required_vars` (measured: one of 28), and `assertDispositionCoversContract`
throws on a declared var with no disposition, which would refuse every provision
and every studio upgrade on the pinned release. That is the v1.12.0 outage shape.
The entry can only leave after a vivijure-cf release drops the var from
`required_vars` and `STUDIO_RELEASE` is bumped to it.

Onboarding copy no longer advertises "Audio upscale" / "Cleaner audio", because a
wizard must not paint a filmmaker-facing capability that cannot execute. The
`docs/cost-basis.md` audio-upscale row is marked retired rather than deleted,
following the cp#517 MuseTalk precedent: those are MEASURED July 2026 dollars and
the production total was computed with them.

`infinitetalk` is untouched. It is the capability that replaced this one.
