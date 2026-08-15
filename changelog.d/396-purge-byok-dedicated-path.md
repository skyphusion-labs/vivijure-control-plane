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
this change has exactly two callers and BOTH are the session route. So a shared tenant reaches live
without traversing the handoff, which is what made removing an unauthenticated surface safe. A row
that is not recorded shared -- the 13 legacy ones, all dead -- is refused BY NAME
(`tenant_not_on_shared_tier`) rather than dropping through to a 404-shaped silence.

The caller comment on that route named the handoff as one of its two callers. Left alone it would
have been a false statement about the security argument the route rests on, which is the same
defect class as the teardown comment above.
