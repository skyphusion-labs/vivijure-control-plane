### fix(pool): refuse a SHARED_RUNPOD_ENDPOINTS key that matches no plan key (cp#529)

`parseSharedPool` built its endpoint list by iterating `endpointBackedPlan()` and looking each plan
key up in the pool, so a pool key in NEITHER plan was never read, never probed and never reported.
The file already refused an OWN-IRON key, with a comment stating the reasoning ("Silently dropping
a key an operator deliberately wrote is the quiet-degrade shape this whole file exists to refuse").
A key retired TO something was refused; a key retired to NOTHING was dropped in silence.

Measured, not hypothetical: `SHARED_RUNPOD_ENDPOINTS` carried `lipsync` pointing at endpoint
`zw6pt4lymf69pk` after cp#517 deleted it, and the `Shared pool invoke-key scope` deploy gate passed
every run. The same dead id in that test's negative-CONTROL position failed loud and held a release
for four tags, because a control id is probed directly. The discriminator was never reachability,
only whether `PROVISION_PLAN` still named the key.

An unknown key is now refused, before the loop, naming every offender. Secondary effect worth
having: retiring a plan key breaks the deploy of any plane whose pool still names it, which is the
moment to clean the variable rather than six weeks later.

Three tests, the failing one written first and watched RED against unfixed code: the retired-key
refusal, a control proving a correct pool still resolves (so the refusal is not blanket), and a
control proving the own-iron refusal is still distinguishable (so the new one did not swallow it).
