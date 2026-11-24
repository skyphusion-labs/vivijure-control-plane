# Vivijure Control Plane

This file is the guide for any coding agent and any contributor. Follow it.

## What this project is

This repo is a reference multi-tenant control plane for hosting Vivijure Studio. It is maintained. It is not operated as the Skyphusion studio.

The Worker owns accounts, sign-in, the AUP gate, tenant records, provisioning, and admin switches. It installs a published studio release into a per-tenant Worker. It is not the studio UI. It owns no film data. Projects, cast, and renders stay in the tenant studio.

Hosted sells convenience. It does not sell a private capability. The product matches self-host. Releases ship at the same time.

See root `package.json`, the latest `v*` tag, and [CHANGELOG.md](CHANGELOG.md). Do not freeze a number here.

## Relation

| Repo | Role |
|------|------|
| This repo | Reference control plane (provision and front door) |
| `vivijure-cf` | Studio panel Worker (the bytes a tenant runs) |
| `vivijure-core` | Shared orchestration and the module contract |
| `vivijure-local` | Self-host Node panel |
| `vivijure-backend` and the upscale satellite | GPU render path |
| `vivijure-mcp` | Agent MCP door against a studio `STUDIO_URL` |
| Hub `vivijure` | Docs and legal history; not a deployable studio |

## Pins

`STUDIO_RELEASE` is the studio `v*` tag that a new tenant gets. Advancing it does not move an existing tenant. An upgrade is an explicit job. See [docs/control-plane.md](docs/control-plane.md).

`MANIFEST_PIN_FLOOR` in `src/bundle-r2.ts` is the oldest studio release this plane accepts. The manifest must carry `migrations` and `required_vars`. The live floor is the constant in code. Do not copy that number into this file.

`STUDIO_RELEASES` (R2) mirrors release artifacts. An unpublished pin fails provision. The failure stays honest.

Satellite image pins are operator-set. `npm run check:pins` and `npm run check:pins:prod` check them. Do not freeze an endpoint id in this file.

## Docs

- [docs/control-plane.md](docs/control-plane.md) -- what the plane owns
- [docs/deploy.md](docs/deploy.md), [docs/deploy-runbook.md](docs/deploy-runbook.md), [docs/deploy-config-injection.md](docs/deploy-config-injection.md) -- tag deploy
- [docs/hosted-tier.md](docs/hosted-tier.md), [docs/hosted-routing.md](docs/hosted-routing.md) -- hosted surface
- [docs/managed-compute.md](docs/managed-compute.md) -- prepaid credits; the shared pool is the product
- [docs/operator-access.md](docs/operator-access.md), [docs/payment-rail.md](docs/payment-rail.md), [docs/cost-basis.md](docs/cost-basis.md)
- [docs/tenant-telemetry.md](docs/tenant-telemetry.md) and [docs/legal/](docs/legal/)
- [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md)

## Commands

```bash
npm run typecheck
npm test
npm run coverage
npm run dev
npm run deploy
npm run guard:resolve
npm run check:pins
npm run check:pins:prod
npm run guards:config
npm run smoke:predeploy
```

`npm run typecheck` is the CI gate. Run it before you push. `smoke:predeploy` needs credentials. Do not put those credentials in a tracked file.

## Release

`.github/workflows/deploy.yml` deploys on a pushed `v*` tag. It also runs on `workflow_dispatch`. `dry_run` defaults to true and stops before migrate and deploy. `dry_run` false deploys too. That path refuses a commit that is not on `main`. A merge to `main` does not redeploy.

A version moves only in a release pull request. Bump the version, then update the changelog. A feature pull request does not bump. A fix pull request does not bump.

The version of record is `package.json`, `src/version.ts` (`CONTROL_PLANE_VERSION`), and the lockfile. Those version fields must match. The tag shape is `v*`.

Before a release pull request, check tags. If the current manifest version already has a tag, the cycle is closed, so the release pull request bumps. If it has no tag, stop. Read why before you bump again.

1. Release pull request: bump `package.json` and `CONTROL_PLANE_VERSION`. Move `## Unreleased` to `## vX.Y.Z`. Leave a fresh empty Unreleased section.
2. An org admin tags that pull request merge commit.

```bash
sha="$(gh pr view <release-pr> --json mergeCommit -q .mergeCommit.oid)"
git tag -a vX.Y.Z -m "control plane vX.Y.Z" "$sha"
git push origin vX.Y.Z
```

3. Verify the live Worker (`modified_on` or behavior). Do not stop at a green check.

A `v*` tag here deploys this plane. A `v*` tag in `vivijure-cf` deploys the studio panel. Do not mix them.

## Docs language and safety

Write Simplified Technical English. Use short sentences. Put one idea in each sentence. Use the active present tense. Use plain words. Use the same word every time.

Do not use an em dash (U+2014). Do not use an en dash (U+2013). Use a comma, a semicolon, parentheses, or two hyphens (`--`).

State the limit next to the capability. Do not turn a measured result into a promise.

The CSAM ban includes synthetic images (18 U.S.C. 1466A and 2252A). Do not weaken that check.

GPU engines stay clean-room. Do not bring in wavevryn code. Do not add credit that hides that fact.

Do not put a secret in a tracked file. Presence-check with `${var:+SET}` only.

Hosted and self-host stay at parity. There is no community edition. There is no pay gate on a studio capability.

Use a Conventional Commit. The body says why.
