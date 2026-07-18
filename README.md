# vivijure-control-plane

Hosted control plane for Vivijure Studio: tenancy, onboarding, provisioning.

This is the machinery that runs the **hosted** Vivijure offering. If you want to run
Vivijure Studio yourself, you do not need anything in this repository -- go to
[vivijure-cf](https://github.com/skyphusion-labs/vivijure-cf), which is a complete,
self-hostable Studio on its own.

## What lives here

- Accounts, auth, and onboarding for the hosted front door
- Tenancy: tenant records, hosted routing, entitlements, quota, admin controls
- The tenant provisioner (and its RunPod port)
- Control-plane D1 migrations and config
- Hosted legal policy (AUP and friends) and hosted deploy docs
- `zone-security/`: the vivijure.com zone WAF as code

## What does NOT live here

The Studio itself, and the Studio release artifact builder (`studio-release.yml` +
`scripts/build-studio-release.ts`). Those are Studio deliverables and stay in
`vivijure-cf`. This repository consumes the Studio only as a **published release
artifact**, pinned by `{tag, manifest_sha256}`. No source-level imports across the
boundary, ever.

## Release and deploy

Tag semantics are independent per repository:

- a `v*` tag **here** deploys the control plane
- a `v*` tag in `vivijure-cf` deploys the Studio panel

A `v*` tag on this repository deploys the control-plane Worker **and** applies
control-plane D1 migrations via `wrangler d1 migrations apply` against the live
control-plane D1. Schema is never applied by hand.

## Status

Extracted from `vivijure-cf` per issue #85. See `NOTICE` for provenance.

## License

AGPL-3.0-only. See `LICENSE`.
