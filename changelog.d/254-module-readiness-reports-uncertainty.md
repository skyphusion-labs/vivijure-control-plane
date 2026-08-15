### fix(admin): module-readiness reports the uncertainty instead of settling it (cp#254)

`GET /api/admin/tenants/:id/module-readiness` sampled `/ready` twice, 250ms apart, returned the
second sample and discarded the first (PR #349, `bf35182be2`). cp#254 had ruled against settling
inside the route and for reporting the uncertainty, and the merged change did neither: it settled,
badly, and reported nothing about it.

Badly, because of the measured numbers. The convergence window on the replace path is 40 to 50
seconds (reproduced live twice: `TFTFFF` and `FTFFF`), so two samples 250ms apart are two reads of
one transient. On `FTFFF` the second read is `true`, and the worker it described was a `keyframe`
re-uploaded with `TELEMETRY_DB` REMOVED -- the negative control, answered wrong, and now wearing the
appearance of a second opinion. A caller could not tell a mid-convergence answer from a settled one,
which is the defect cp#254 was filed for.

Both samples are now kept. Each module carries `readings` (what every sample said, in order),
`reads` (the denominator) and `settled` (every sample agreed). `job_log` is still the last reading,
and is documented as a reading rather than a conclusion. `records_unproven` no longer counts an
unsettled `"ok"` as proof, and a new `unsettled` array names the modules whose reads disagreed, so
an operator re-asks instead of re-provisioning. `settled: true` is deliberately weak (nothing in
this probe contradicted the value, across a gap far shorter than the window); `settled: false` is
the strong direction and is positive proof the reading is still moving.

A read that never reached the module is kept apart from a module that answered without the field:
both are `job_log: null`, and only the per-sample state (`unreachable` versus `absent`) separates a
control plane that cannot dispatch from a tenant image too old to say.

The pre-deploy smoke now CALLS the shipped summary function instead of restating the route predicate
"character for character" with a comment asking future readers not to let the two diverge.
