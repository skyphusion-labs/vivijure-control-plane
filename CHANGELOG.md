# Changelog

All notable changes to the Vivijure control plane. Versions are SemVer; a `v*` tag on this
repository deploys the control plane (a `v*` tag in `vivijure-cf` deploys the Studio panel, which
is a separate product on a separate cadence).

## v1.0.0 -- 2026-07-18

The hosted control plane becomes its own product, in its own repository, serving from its own
tagged release.

Before this, the control plane lived inside `vivijure-cf` and was deployed by hand. That meant
anyone who wanted to self-host Vivijure Studio carried the machinery for running a hosted service
they had no intention of offering, and it meant the live plane ran an untagged working state rather
than a release. Both are fixed here.

### The extraction

- Extracted from `vivijure-cf` at commit `59b3fb38` (vivijure-cf#85). Pre-extraction history stays
  in `vivijure-cf`; no history was rewritten in either repository. See `NOTICE`.
- `vivijure-cf` remains a complete, self-hostable Studio with no requirement to operate a hosted
  service. Nothing in this repository is needed to run Studio yourself.
- The two repositories are coupled ONLY through the published Studio release artifact -- the
  versioned bundle contract, pinned by `{tag, manifest_sha256}`. There are no source-level imports
  across the boundary, and there must never be.
- Studio release pin floor: **v1.3.1**.

### Tag semantics, split

Each repository now versions and deploys its own product. The shared-tag double duty is gone:

| tag | deploys |
| --- | --- |
| `v*` here | the control plane |
| `v*` in `vivijure-cf` | the Studio panel |

### Migrations apply on deploy (vivijure-cf#80)

Schema now reaches the live control-plane D1 through the deploy pipeline or not at all. No
hand-applied schema, ever.

This closes a defect that produced two live provisioning failures in a single evening. The live
database had been built by hand: `0001` applied raw, `0002` skipped entirely, `0003` applied after
the fact, and no `d1_migrations` ledger to notice any of it. The symptoms were an AUP acceptance
returning 500 on a missing `aup_sha256` column, and a provision dying at `r2_token` on
`no such column: r2_token_id`.

- migrations are applied **before** the worker deploys, so new code never runs against old schema
- a separate verify step re-lists migrations afterwards and fails the deploy if any remain pending,
  because `apply` exiting 0 proves only that it did not error
- migrations must be additive; a destructive or narrowing change needs expand/contract across two
  releases (`CONTRIBUTING.md`)

### Deploy pipeline

- `v*` tag only, never a push to `main` -- an ordinary merge must not redeploy the live plane
- the tag must match the declared version, so a build cannot ship reporting a version it is not
- config is rendered from `wrangler.toml.example` at deploy time and fails closed: every injected
  value is required unless explicitly allowlisted, the D1 id is checked by shape rather than mere
  presence, and `AUP_URL` is refused if it points at a moving ref
- a `workflow_dispatch` dry run validates configuration and reports pending migrations without
  writing anything; the writes live in a separate job so a dry run skips them by construction

### Also here

- `zone-security/` -- the vivijure.com zone WAF as code, moved from `vivijure-cf`, in log mode.
  The flip to enforce is a separate launch gate.
- Born at the full aviation-grade standard: `main` requires PRs, blocks force-push and deletion,
  and gates on `ci` / `coverage` / `CodeQL`.
