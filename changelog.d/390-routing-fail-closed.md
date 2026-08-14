### fix(routing): `tenantRefusal` fails CLOSED on an unmodelled tenant status (cp#390)

`tenantRefusal` (`src/routing.ts:148`) switched on `tenant.status` with no `default` arm. In this
function `null` does not mean "no opinion" -- it MEANS dispatch, and a fall-through returned
`undefined`, which is falsy at its single call site's `if (refused)`. So a tenant whose status the
switch does not model was served the studio rather than refused: the most successful-looking
outcome available, with no error and no log line. That silence is why it survived; from the outside
an unmodelled status and a healthy `live` tenant behaved identically.

`TenantLifecycle` is a COMPILE-TIME claim about a string D1 hands back, so the type system does not
close this. typecheck catches someone adding a state (TS2366 fires on this function), but not a
value arriving at RUNTIME: `tenants.status` is `TEXT NOT NULL` with **no CHECK constraint**, unlike
`credit_holds.status` and `llm_spend_rollup.status` which both carry one. A hand-run migration, a
manual UPDATE, or version skew between a deploy that knows a new state and one that does not all
reach the switch with a value outside the union.

The switch now has an explicit `default` that emits a structured `routing.lifecycle_unmodelled`
event carrying the tenant id and the unrecognised value, then refuses with a 404 -- loud in the log,
generic on the wire. This matches the direction `routingStatusFor()` in `tenant-resolver.ts` already
documents for the same column; two projections of one column falling opposite ways was the defect.
