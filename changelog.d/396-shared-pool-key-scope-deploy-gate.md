### ci(deploy): refuse a deploy whose shared pool names an endpoint the invoke key cannot reach (cp#396, cp#389)

`SHARED_RUNPOD_ENDPOINTS` is a repository VARIABLE and `SHARED_RUNPOD_INVOKE_KEY` is a SECRET.
They are set independently, by hand, at different times, and nothing compared them. There is no
RunPod API that reports a key permission set, so the plane cannot read its own credential scope
from code.

Every existing check passes while the two disagree: the pool parses, `requiredPoolKeys()` is
satisfied, provisioning succeeds and the studio is served. The tenant finds it at their FIRST
RENDER, on whichever capability the key does not cover. It is the same quiet-degrade shape
`runpod-pool.ts` refuses a partial pool for, one layer up: **a pool can be COMPLETE and still be
unreachable.**

`src/shared-pool-scope.ts` closes it on the deploy path, and it composes the existing probe rather
than adding a second one. `verifyInvokeKeyScope` already answers exactly this question at tenant
paste time (#52 / #60): `GET /v2/<id>/health` returns 200 in scope and 403 out of it, per
endpoint, ENFORCED by RunPod rather than asserted by us. Two probes that could disagree about one
key would be worse than none.

**This is not hypothetical, and the gate says so about the CURRENT plan.** A valid pool must name
an endpoint for the `upscale` plan key, that endpoint is `4q8idwbk6tyqbq`
(`vivijure-video-upscale`, live on the account), and the shared invoke key is minted with no
access to it. So arming the shared tier today produces exactly this refusal. That is the gate
working, and it is what should block cp#389 until either the key scope or the plan changes. The
refusal names the endpoint and never the key.

**The gate was watched failing on each of its three refusals, not merely written.** Mutating the
scope branch so it never refuses turns the two refusal tests red and leaves the other seven green,
so they discriminate rather than decorate. `SHARED_POOL_SCOPE_REQUIRED=1` with nothing configured
fails and names both absent vars. Setting one half and not the other fails in EVERY mode, which is
deliberate: gating that check on REQUIRED would have let the misconfiguration nearest this file
skip silently.

**The out-of-scope fixture is a real endpoint, and that is the point.** A made-up id would also
produce a refusal, and it would read identically while meaning something else entirely: nothing
there, rather than there and refused. The live control probes that endpoint on its own, so it
holds whether or not the pool names it, and asserts the reason is `endpoint_out_of_scope` rather
than a dead or over-powerful key.

It arms itself off the variable (`SHARED_RUNPOD_ENDPOINTS` non-empty), because an empty pool is a
legitimate value meaning this plane offers no shared tier. Forcing the gate on would fail a
correct deploy; leaving it optional would let a declared tier go unproven.

Also, two refusal MESSAGES that misattributed their own cause. `verifyInvokeKeyScope` told an
operator to scope a key to "your 4 vivijure endpoints" and "all four" from hardcoded literals;
both now derive from the endpoint list, so a plane whose plan holds a different number stops
printing a figure that is simply wrong. A refusal naming the wrong knob sends the reader to it.
