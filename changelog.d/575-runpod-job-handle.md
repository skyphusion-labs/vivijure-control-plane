### fix(runpod-proxy): status and cancel take a job handle bound to the tenant (cp#575)

A proxied submit now answers with `id` set to a job handle, `vjh1_<runpod job id>_<mac>`: a keyed
MAC over (tenant, endpoint, job) with `RUNPOD_PROXY_SIGNING_KEY`, the key that already signs the
tenant token. Status and cancel accept only a handle that verifies for the calling tenant and the
endpoint in the path, and answer `404` (`x-vivijure-plane-refusal: unknown_job`) for anything else.
The poll path still holds no store: the handle verifies with no lookup. Every other field of
RunPod's submit answer passes through unchanged, and modules need no change, since they store the
`id` they are given and send it back. The tenant job-log harvest reads the RunPod id out of a
logged handle, so the job index keys on RunPod's id as before.

**Deploy note.** A job submitted before this deploy carries a bare RunPod id, and after the deploy
its status and cancel are refused. Deploy between renders. Rotating the signing key does the same to
every job in flight (docs/deploy.md).
