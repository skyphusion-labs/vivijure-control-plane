### feat(cf-api): a `workflow` binding variant, and the live probe that proves it (cp#526, cp#524)

`WorkerBinding` carried ten variants and no workflow variant, so the plane could not emit the one
binding four catalogued motion doors (`cf-seedance`, `cf-grok-video`, `cf-flux-3-video`,
`cf-hh1-r2v`) and both `dialogue` providers declare. That is the single thing standing between a
hosted signup and a talking film: `chatterbox` and `dialogue-gen` are unpublished AND
unprovisionable, and the second half is this.

The shape is read off the schema of the endpoint this client actually PUTs to (the Workers for
Platforms dispatch-namespace script update), not inferred from a sibling variant: `name`, `type`
and `workflow_name` required, `class_name` and `script_name` optional. The general
multipart-upload-metadata page does NOT list this variant, and that silence is not evidence -- the
same page also omits `dispatch_namespace`, `ratelimit`, `vpc_service` and `inherit`, all four of
which this plane already emits.

`tests/wfp-workflow-binding.live.test.ts` is the proof, on the live-release-gate: the upload is
accepted AND the binding is read back off the API as `type: workflow`, with a negative control on a
sibling script proving the readback can say no. Typecheck cannot produce that reading, and an
upload response echoes no bindings, so `success: true` is only the writing client's opinion of its
own work. It additionally MEASURES two things nothing in this estate had ever run: whether a script
exporting a `WorkflowEntrypoint` uploads with no workflow binding at all (cp#526's open A-vs-B, and
the state the four `cf-*` rows are in today), and what the API does when a second script claims the
same account-scoped `workflow_name`.

The hedge comment at the `cf-*` catalog rows ("Workflows are still a FLAG if WfP cannot bind them")
is corrected rather than left standing: WfP can bind them, the missing piece is our emitter, and a
hedge like that is what makes a fixable gap read as a platform wait.

NOTHING EMITS THE VARIANT YET, deliberately. A catalogued door whose binding the plane emits wrong
fails EVERY provision at `modules_upload` and typecheck cannot see it, so the emitter waits on what
the live run reads: whether the upload provisions the account-scoped Workflow, and whether
`workflow_name` must be tenant-prefixed the way the script name already is.
