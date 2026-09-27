### fix(ci): the live release gate could not reach any of its own steps (cp#536)

`live-release-gate.yml` opened its live job with `npx vitest run tests/runpod.live.test.ts`. That
file was deleted on 2026-08-15 by `fe756cf` with the BYOK / dedicated RunPod path (#430). Steps run
under `shell: bash -e`, so the job died on the missing file and every step after it -- the entire
real-Cloudflare leg this gate exists for -- never ran.

Nothing reported it, because the last dispatch before today was 2026-07-25, three weeks before the
deletion. A dispatch-only workflow with a dead reference is indistinguishable from a healthy one
until somebody dispatches it, which is the shape of a gate that cannot go red.

Measured on dispatch `36343359720`: `No test files found, exiting with code 1 / filter:
tests/runpod.live.test.ts`, at the first step.

The step is RETIRED rather than repointed, because its subject went with the purge that deleted it:
it created a per-tenant RunPod template and endpoint for the dedicated path #430 removed. The job's
`RUNPOD_API_KEY` env and its preflight line go with it -- a preflight demanding a credential no
remaining step uses can only fail the gate for a reason that is not about the gate.
`package.json`'s `test:live:scratch` named the same dead file and is corrected the same way.

Not fixed here, and tracked on cp#536: eight of the ten live suites in this repo are run by no
workflow at all.
