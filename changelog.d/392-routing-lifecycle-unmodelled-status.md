### fix(routing): `routing.lifecycle_unmodelled` no longer renders an absent status as `"undefined"` (cp#392)

The `default` arm added in cp#390 emitted the unrecognised status via
`String((tenant as { status: unknown }).status)`. When `tenant.status` is absent,
`String(undefined)` yields the literal string `"undefined"`, a normal-looking JSON value
indistinguishable from a status column that genuinely holds those six characters. The event exists
to be the only signal on this fail-closed path, so an absence rendered as a plausible value defeats
the point of logging it.

The `status` key is now included only when the field is actually a string; an absent status omits
the key entirely, the same honesty `JSON.stringify` already gives the `tenant` key when
`tenant.id` is absent. An unmodelled-but-present status (e.g. `"archived"`) is still logged
verbatim, unchanged.
