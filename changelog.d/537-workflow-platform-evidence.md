### test(workflow): the live evidence that the hosted Workflow door is blocked on the platform (cp#537)

Two live suites on the release gate, and between them they close the question the emitter was
waiting on. No `src/` change: the emitter is deliberately NOT written, because what these measured
is that it cannot be finished yet.

**`wfp-workflow-binding.live.test.ts`** -- the Workflows API cannot address a script inside a
dispatch namespace. Same credential, same body shape: **200** for an account-level script, **400**
`10002` for a malformed body, **500** `10001 internal_server` for a dispatch-namespace script, for a
script that does not exist, and for both qualified `script_name` shapes. The 400 is the
discriminator that makes the 500 mean something. Not a scope problem: the same credential lists all
13 Workflows on the account and creates one.

**`workflow-runtime-binding.live.test.ts`** -- and the resource is REQUIRED. Against a positive
control that created a real instance on the same worker seconds earlier, a binding naming a Workflow
that does not exist resolves as an object (`bound: true`) and throws on first use
(`workflow.not_found`), leaving the account unchanged, so it is not lazily provisioned either.

So the plane can attach the binding and cannot create what it points at, and pointing at nothing is
not survivable. The `dialogue` and four `cf-*` doors are blocked on Cloudflare, not on code.

Both runs state their own limit: the runtime case is account-level, which isolates the runtime
question from the addressing one, so it is strong evidence and not proof for the namespace case.

Two instrument defects were found by these runs rather than by review, and both are fixed here. A
400-character body cap made a 13-row list parse as zero and briefly produced a false finding about
credential scope -- the correction is committed with the mechanism, because a reader that turns a
parse failure into an empty collection reports absence as confidently as a real zero. And the
probe cases carried vitest's 5s default while performing a bounded 30s wait, so one failed on the
clock directly beneath a finding; they have a named 90s budget now.
