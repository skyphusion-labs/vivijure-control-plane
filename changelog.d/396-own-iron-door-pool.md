### feat(runpod): a vpc-backed capability carries a DOOR POOL, one per GPU box (cp#396)

`vivijure-cf` at the pinned v1.28.0 does not read ONE door per capability. Both `finish-upscale`
and `speech-upscale` build `doorPool([...])` from a candidate per box and round-robin with
`pickDoor`: `FINISH_UPSCALE_VPC` + `FINISH_DOOR_TOKEN` for fatmike, and
`FINISH_UPSCALE_VPC_PROPAGANDHI` + `FINISH_DOOR_TOKEN_PROPAGANDHI` for propagandhi. **Four bindings
per capability, not two.**

The first cut of the transport split bound only the legacy door. Not wrong -- `pickDoor` is
`n % pool.length`, so a pool of one is a working pool -- but it would have **concentrated every
tenant render on fatmike while propagandhi idled**, diverging from the operator studio that already
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
