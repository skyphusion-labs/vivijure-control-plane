### Added

- `POST /api/admin/tenants/provision` creates an account for a named email address and
  provisions a studio for it on the shared tier (cp#376). This is what the launch gate's
  "a studio I provision" step needed: provisioning gates on session plus accepted AUP, so
  it needs an account, and account creation is the only thing `signups_enabled` gates, so
  until now the only way to reach a first tenant was to open public registration, which
  the ruling puts last.
- New operator scope `tenants:provision`, deliberately not folded into `tenants:write` or
  `studio:operate`. It is the only capability that brings an account holder into existence,
  and account creation is exactly what `platform:settings` gates through `signups_enabled`;
  a capability that routes around another scope's control must not be implied by a third.

The route accepts no `runpod_api_key` and refuses a body carrying one, so an
operator-provisioned tenant always lands on the shared pool and never receives a RunPod key
on our account. It records no AUP acceptance and asserts none on the owner's behalf: the
tenant stops at `awaiting_invoke_key` and can only be promoted through the owner's own
AUP-gated request. Every use writes two `admin_audit` rows naming the authenticated
operator, and the request row is written before anything is created, so a failed audit
write fails the operation.
