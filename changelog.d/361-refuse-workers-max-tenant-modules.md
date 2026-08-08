### Fixed

- Tenant module uploads now refuse a `RUNPOD_WORKERS_MAX` binding (cf#361). The cap is
  intentional on operator-hosted modules; on a tenant module it would let a tenant's own
  spec raise its worker ceiling. The refusal is asserted immediately before the upload,
  and a source-level pin keeps the call site from being deleted silently.
