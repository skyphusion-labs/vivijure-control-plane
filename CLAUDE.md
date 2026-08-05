# CLAUDE.md

Guidance for Claude Code (and the crew) working in this repo.

## What this is

**Vivijure Control Plane: the multi-tenant hosted provisioner.** A Cloudflare Worker that owns
accounts, sign-in, AUP gate, tenant records, provisioning, and admin switches. It installs the
**published studio release** into per-tenant Workers (dispatch namespaces). It is **not** the studio
UI and owns **no film data** (projects, cast, renders stay in the tenant studio).

Hosted sells convenience, never capability: same product as self-host, same-time releases.

Version: see root `package.json` / latest `v*` tag / `CHANGELOG.md`.

## Relation to the constellation

| Repo | Role |
|------|------|
| **This repo** | Hosted multi-tenant plane (provision + front door) |
| `vivijure-cf` | Studio panel Worker (the bytes tenants run) |
| `vivijure-core` | Shared orchestration / module contract (studio dep, not this plane) |
| `vivijure-local` | Self-host Node panel (parity peer of cf) |
| `vivijure-backend` + finish/train satellites | GPU render path tenants wire via their own RunPod |
| `vivijure-mcp` | Agent MCP door against a studio `STUDIO_URL` |
| Hub `vivijure` | Docs / legal history only; not deployable studio |

## Pins (load-bearing)

- **`STUDIO_RELEASE`** (env var): studio `v*` tag **new tenants** get at provision. Advancing it does
  **not** move existing tenants; upgrades are explicit jobs. See `docs/control-plane.md`.
- **`MANIFEST_PIN_FLOOR`** (`src/bundle-r2.ts`): oldest studio release the plane will accept
  (manifest must carry `migrations` + `required_vars`). Live floor is the constant in code; do not
  restate a number here as eternal truth.
- **`STUDIO_RELEASES`** (R2): release-artifact mirror. An unpublished pin fails provision honestly.
- Satellite image pins are operator-set and checked by `npm run check:pins` / `check:pins:prod`.
  **Never freeze open sprint boards or specific RunPod endpoint IDs in this file.**

## Documentation map

- `docs/control-plane.md` -- what the plane owns, provision model, pins
- `docs/deploy.md` + `docs/deploy-runbook.md` + `docs/deploy-config-injection.md` -- tag deploy path
- `docs/hosted-tier.md` + `docs/hosted-routing.md` -- hosted product surface
- `docs/managed-compute.md` -- BYOK / compute doors
- `docs/operator-access.md` + `docs/payment-rail.md` + `docs/cost-basis.md`
- `docs/tenant-telemetry.md` + `docs/legal/`
- README -- orientation for operators and competitors running their own plane

## Commands

```bash
npm run typecheck       # tsc --noEmit (+ tests tsconfig) -- CI gate; run before push
npm test                # vitest run
npm run coverage        # vitest --coverage
npm run dev             # wrangler dev
npm run deploy          # wrangler deploy (prefer tag path in CI)
npm run guard:resolve
npm run check:pins      # satellite pin resolution (anonymous GHCR)
npm run check:pins:prod
npm run guards:config   # render-wrangler shell guards
npm run smoke:predeploy # live pre-deploy smoke (needs secrets)
```

## Release / tagging

**TAG-GATED deploy.** `.github/workflows/deploy.yml` runs on a pushed `v*` tag only. Merge to `main`
is CI only; it does **not** redeploy the live plane.

1. Release PR: bump `package.json` **and** `src/version.ts` `CONTROL_PLANE_VERSION` (gated equal),
   promote `CHANGELOG.md` (`## Unreleased` -> `## vX.Y.Z`, leave a fresh empty Unreleased).
2. Tag matching `package.json`:

```bash
git fetch origin main && git checkout main && git pull --ff-only
git tag -a vX.Y.Z -m "control plane vX.Y.Z"
git push origin vX.Y.Z
```

3. Verify the live Worker artifact (`modified_on` / behavior), not only a green pipeline check.

`v*` here deploys the control plane. `v*` in `vivijure-cf` deploys the studio panel. Do not conflate.

## Hard rules

- **CSAM bright-line (NON-NEGOTIABLE):** zero tolerance including synthetic (18 U.S.C. 1466A / 2252A).
- **Clean room** for GPU engines: no `wavevryn` code paths; no named third-party credit laundry.
- **Typecheck is the CI gate** for TS; run `npm run typecheck` before push.
- **Verify the artifact**, not the pipeline's opinion of it.
- **Ignore Cursor `AGENTS.md`** if present; this file is the agent contract.
- **No em-dashes (U+2014) or en-dashes (U+2013).** Use commas, semicolons, parentheses, or `--`.
- **Never a plaintext secret in a tracked file.** Presence-check with `${var:+SET}` only.
- Hosted and self-host parity: no community edition, no pay-gated studio capability.

## Crew + identity

Crew: `sudo -u <member> bash -lc '...'`; commits under `skyphusion-<member>`. Conrad on laptop only
as `Conrad Rockenhaus <conrad@skyphusion.org>`. Conventional Commits (`feat(scope):`, `fix(scope):`,
`docs:`).
