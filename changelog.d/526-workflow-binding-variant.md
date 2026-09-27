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
own work. First green run: dispatch `36343598466`, 2026-09-27T19:14Z.

That run also settled three things nothing in this estate had ever asked the API, now PINNED as
assertions so the day any of them changes is a day this goes red:

1. **cp#526's open A-vs-B is A.** A script exporting a `WorkflowEntrypoint` uploads fine with NO
   workflow binding. The four catalogued `cf-*` doors therefore provision, look installed, pass
   `/ready` and throw at the first invoke, after the keyframe pass is already spent. Nothing refuses
   them at `modules_upload`.
2. **The upload does not create the Workflow.** `GET /accounts/{id}/workflows/{name}` answers 404
   `10200 workflows.api.error.workflow.not_found` after a successful bound upload. Emitting the
   binding is not the whole job; the Workflow is a separate provisioning step.
3. **A second script may claim the same `workflow_name`**, with a different class, and the API
   accepts it. Nothing outside this plane will warn about a cross-tenant collision, so
   tenant-prefixing the Workflow name is on us exactly as it is for the script name.

The hedge comment at the `cf-*` catalog rows ("Workflows are still a FLAG if WfP cannot bind them")
is corrected rather than left standing: WfP can bind them, the missing piece is our emitter, and a
hedge like that is what makes a fixable gap read as a platform wait.

NOTHING EMITS THE VARIANT YET, deliberately. A catalogued door whose binding the plane emits wrong
fails EVERY provision at `modules_upload` and typecheck cannot see it, and the live run above says
an emitter owes three things rather than one: the binding, a provisioned Workflow, and a
tenant-prefixed name.
