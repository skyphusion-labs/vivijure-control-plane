### Fixed

- The module readiness route reports `telemetry.job_log` again (cp#378). Modules have emitted a
  tri-state string (`"ok" | "unavailable" | "unknown"`) since vivijure-cf 815c9ff0 on 2026-08-01;
  this plane accepted only a boolean, so every one of the 14 recording modules coerced to `null`
  for twelve days and `GET /api/admin/tenants/:id/module-readiness` could not prove any module
  would record. The plane now learns the string rather than the modules reverting to a boolean,
  which would undo cf#284 and re-create the conflation between "a binding is attached" and "it can
  actually record".

  `job_log` carries FOUR states rather than being mapped onto `boolean | null`. `"unknown"` (the
  worker probed and could not tell) and `null` (the image predates cf#279 and has no such field)
  are one collapse apart and have different remedies -- look at the tenant database, versus move
  `modules_release` forward. Merging them would leave one `null` carrying both, which is exactly
  how this route's own comment sent a reader to a stale release pin while this bug was the cause.

  Legacy booleans are still accepted: `true` reads as `"ok"`, `false` as `"unavailable"`.
  vivijure-cf v1.13.0 was a published studio release emitting `Boolean(env.TELEMETRY_DB)` in five
  recording modules, and a tenant pinned there records perfectly well. Dropping it to `null` would
  report a working binding as unprovable.

- The comment on the readiness route named the wrong cause. It said a `job_log` absent everywhere
  is a stale release pin more often than a missing binding; null-everywhere is the exact symptom
  the parser defect produced, and the pin was independently stale, so checking it returned a
  confirmed-looking wrong answer. It now names this failure mode and orders the readings by which
  cause to check first: a parse problem is uniform across every tenant, a pin problem varies with
  the pin.

- The pre-deploy smoke parsed `job_log` with its own copy of the predicate, in two places, while
  its header said the tested logic is the shipped logic rather than a copy of it. That was true of
  the settle criterion and false of the parse, and the parse is the half that broke: the gate
  agreed with the plane by construction and could not observe the plane and the modules
  disagreeing. It now imports the shipped parser.

  Its negative control waited for boolean `false` and could never converge against a string. It
  now waits for `"unavailable"`, which preserves the asymmetry argument exactly: the version being
  replaced HAD the binding and could never say it, so seeing it proves the new bytes are served,
  while the positive value stays ambiguous between a stale isolate and a broken module and still
  never terminates the wait. An unconverged read remains a FAILURE, never a value.

### Added

- A rename tripwire on the cross-repo contract. `JobLogReadiness` is defined in vivijure-cf and
  nothing in this repo can notice it being renamed, so a value the shipped parser refuses is
  reported by the smoke as UNRECOGNISED rather than as `null`, and asserted before every other
  verdict -- if the vocabulary has moved, every reading below it is being interpreted through the
  wrong dictionary. The parser also surfaces the raw value in the observation's `detail`, so an
  absent field and an unrecognised one are never indistinguishable.
