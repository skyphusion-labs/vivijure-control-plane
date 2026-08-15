### fix(onboarding): classify a provision failure on the CODE, and say what the plane said (cp#448, cp#447)

`handleProvisionError` read `err.status === 409` and called every one of them a key problem. The
provision route serves at least four distinct 409s and only one was ever about a key, so
`tenant_exists`, `slug_taken`, `slug_reclaim_in_progress` and `reclaim_teardown_failed` all rendered
as **Setup needs your key again**.

Two things made that worse than a wrong headline.

**The plane's own sentence was dropped.** The transport sets `err.message` to `body.error` -- the
CODE -- and the screen rendered that. So the owner of a genuinely stuck teardown saw the bare string
`reclaim_teardown_failed` and never the words telling them to stop retrying and contact us.

**And the advice attached to it pointed at a teardown.** Because it believed a key was needed, the
screen told them to provision the same name again, which is the cp#435 destroy path. The one
paragraph in the product that describes the destruction appeared as INSTRUCTIONS in cases where
destruction is not the answer.

Now: classified on the code, and **the plane's message wins whenever it sent one** -- it is written
for the owner, it knows which refusal this is, and nothing the client can infer beats it. The code
is a last resort and is labelled as one rather than dressed up as an explanation. **No path advises
re-provisioning**: under cp#427 there is no key to re-paste, and the destroy route belongs behind the
cp#435 acknowledgement, never in a failure hint.

**`runpod_key_required` is read with its NARROWED meaning.** cp#427 kept the code and changed what
it means -- this deploy has no shared render capacity -- so a client still reading it as *bring a
key* would send somebody after a key that no longer exists anywhere in the product.

**cp#447 went with it**, because it lived in the same handler. A `data-next` button relabelled *Back
to the key step* advanced BY INDEX into the render-key step: forward, past its own gate, on a page
holding none of the state that step needs. The step it named no longer exists either. **A failure
screen that cannot offer a correct action now offers none.**

**Watched red first:** 7 against merged main for the classifier, 3 for the wiring, controls green.
One of the wiring assertions had to be rewritten mid-flight -- it forbade the PHRASE *Back to the key
step*, which caught the comment explaining why the control was removed. It now asserts on the
assignment instead, because a test that made me delete the explanation to stay green would have been
the test dictating the wrong thing.
