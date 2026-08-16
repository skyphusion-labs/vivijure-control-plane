### fix(onboarding): burn the tenant invoke-key ritual

The tenant never pastes a RunPod key. `awaiting_invoke_key` was the BYOK parking
name; writes are now `awaiting_go_live`. The go-live route is
`POST /api/tenant/:id/go-live` (old `invoke-key` path still works). Front door
copy no longer asks for "one more key." hosted-tier.md no longer tells anyone
to mint two RunPod tokens. The plane's own `SHARED_RUNPOD_INVOKE_KEY` stays
what it is: our job credential, not a customer step.
