### fix(cp): teardown d1 once; honest meter-tick audit

`guarded("d1")` evaluated once per teardown (cp#406).
`claimResourceOwnership` comment and MemoryStore test match the
live-owner exception (cp#399). Meter-tick audit carries status /
controlPassed / gapDetected / rowsDropped (cp#369). Finish-chain
docs count four including finish-blender (cp#408). `.gitattributes`
adds abort recovery and two-epoch provenance (cp#370). Smoke has a
structural pin against a local job_log parse (cp#384).
