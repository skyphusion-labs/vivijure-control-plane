### fix(runpod): retire the musetalk lipsync endpoint from the provision plan and the pins

MuseTalk is ruled out permanently as a lip-sync provider and its endpoint
`zw6pt4lymf69pk` no longer exists, so the plane was pinning
`vivijure-musetalk:1.0.5` against nothing and provisioning a dedicated endpoint
that could not serve. Dropped the `lipsync` plan entry, the pin, and the
`SATELLITE_GPUS` class it was the last consumer of; the plan is now 4
capabilities, 2 endpoint-backed, and hands back 1 of the account-wide worker
quota. No tenant is bound `MUSETALK_RUNPOD_ENDPOINT_ID` any more.

Lip-sync is NOT retired as a capability: `infinitetalk` serves it as an
audio-driven `motion.backend` door, which this plane never provisioned an
endpoint for. Hosted tenants were already excluded from `finish-lipsync`, so no
hosted behaviour changes.

`requiredPoolKeys()` and `parseSharedPool` derive from `endpointBackedPlan()`, so
a pool no longer needs a `lipsync` key with no code change, and a stale one left
in a deployed `SHARED_RUNPOD_ENDPOINTS` is ignored rather than refused.

Also corrected the documented `SHARED_RUNPOD_ENDPOINTS` example in `src/env.ts`,
`src/runpod-pool.ts`, `wrangler.toml.example` and `docs/deploy.md`: all four named
`upscale` and `audio-upscale`, which `parseSharedPool` refuses outright as
own-iron (cp#396), so the example would have been rejected on paste.

Added `RETIRED_ENDPOINT_KEYS`, read only by `reconcile-runpod.ts`, so a
torn-down tenant's surviving `vivijure-<slug>-lipsync` endpoint and template are
still attributed to that tenant instead of dropping to "unattributed". A retired
capability's debris outlives the capability, and the slug is what an operator
acts on.
