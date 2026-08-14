### fix(routing): `tenantRefusal` fails CLOSED on an unmodelled lifecycle (cp#390)

`resolveTenantRoute`'s lifecycle switch had no `default` arm, so a tenant in a lifecycle state the
switch does not model fell through and returned `null`. In this function `null` does not mean
"no opinion" -- it MEANS dispatch, so an unrecognised lifecycle silently routed the request to the
studio instead of refusing it. A state nobody had modelled got the most permissive outcome
available, and it did so without a log line, which is why it survived: from the outside an
unmodelled lifecycle and a healthy active tenant produced identical behaviour.

The switch now has an explicit `default` that emits a structured `routing.lifecycle_unmodelled`
event naming the tenant and the unrecognised value, then refuses with a 404. Adding a lifecycle
state and forgetting to route it is now loud and closed rather than quiet and open.
