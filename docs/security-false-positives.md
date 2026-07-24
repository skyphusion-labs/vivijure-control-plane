# Security audit false positives

Documented dismissals for adversarial-audit (K2.7/K3) findings that are not actionable bugs in this repo's threat model.

## Cloudflare-only edge

The control plane Worker is deployed behind Cloudflare. `cf-connecting-ip` for AUP consent is trusted because the Worker is not reachable off-Cloudflare in prod.

## Operator-gated live CI (scratch release gate)

`live-release-gate.yml` is **workflow_dispatch only** with `live` defaulting to `false`. The live job runs on **ubuntu-latest** (public repo; fork-safe) and never on PR CI. Scratch RunPod/CF creds are repo Actions secrets visible only to maintainers who can dispatch. Findings that assume unauthenticated fork PRs or self-hosted runner secret exposure do not apply.

Preflight uses `${SECRET:+SET}` presence checks only; secret values are never echoed. `@v7` action pins match org aviation-grade CI convention (same as `ci.yml` / adversarial-audit).

## Live provision e2e harness (tests/)

`provision-e2e.live.test.ts` and helpers under `tests/` are **operator-only** live gates (`PROVISION_E2E=1`). They never run on PR CI (`describe.skipIf(!LIVE)`). Scratch CF/RunPod creds are supplied from the operator shell or maintainer Actions secrets at dispatch time, same trust boundary as `live-release-gate.yml`. The suite's KEK is **not** one of them: it is generated per process in `provision-e2e-env.ts`, so the live worker's `STUDIO_TOKEN_KEK` never enters the harness or CI.

`localStudioBundleSource` / `localModuleBundleSource` read manifests from a **locally built** studio release dir (`build-studio-release.ts`), not from untrusted HTTP. `worker.path` joins under that dir with sha256 verification before use; same pattern as the studio bundle harness.

`wfpDispatchFetch` mirrors production `deps.ts` (`cf#114`): module `/ready` probes are unauthenticated by design; dispatch namespace binding is the boundary. `workersDevSubdomain` is operator env, not tenant input.

## Record

| Date | Audit | Finding | Rationale |
| --- | --- | --- | --- |
| 2026-07-23 | K3 verify ~18:04 | Email-start rate limit keyed only by recipient | **Fixed** per-IP throttle added in verify closeout |
| 2026-07-23 | K3 verify ~18:04 | Prior magic links stay valid on re-request | Accepted: short TTL + operator mail volume; not session fixation |
| 2026-07-23 | K3 verify ~18:04 | AUP IP from cf-connecting-ip | CF-only Worker edge; not reachable off-Cloudflare |
| 2026-07-24 | K2.7 PR #81 | Preflight secret echo risk | `${var:+SET}` presence-only; values never printed |
| 2026-07-24 | K2.7 PR #81 | Floating actions/checkout@v7 | Org convention; matches existing workflows in repo |
| 2026-07-24 | K2.7 PR #81 | No GH environment approval gate | Operator workflow_dispatch; `live` defaults false; scratch creds maintainer-only |
| 2026-07-24 | K2.7 PR #81 | No spend cap in workflow | `timeout-minutes: 30`; suites create prefixed resources only, zero GPU invoke (cf#90) |
| 2026-07-24 | K2.7 PR #81 | RUNPOD_LIVE local bypass | Public ubuntu-latest only; live job not on PR CI; maintainer dispatch trust boundary |
| 2026-07-24 | K2.7 PR #81 | Global concurrency group | Intentional: one scratch live gate at a time |
| 2026-07-24 | K2.7 PR #81 | Missing rotation runbook | Scratch keys rotated via crew-secrets; follow-up once secrets land on repo |
| 2026-07-24 | K2.7 PR #82 | KEK/tokens in process env (provision-e2e-env) | Operator-only live harness; never on PR CI; env is how scratch creds are supplied |
| 2026-07-24 | K2.7 PR #82 | Path traversal in localModuleBundleSource | Operator-built release dir; sha256 integrity gate; same as studio-bundle-local |
| 2026-07-24 | K2.7 PR #82 | workersDevSubdomain hostname injection | Operator env `PROVISION_E2E_WORKERS_DEV_SUBDOMAIN`; maintainer live gate only |
| 2026-07-24 | K2.7 PR #82 | callTenantModule lacks auth | Mirrors prod `deps.ts` cf#114: `/ready` unauthenticated; dispatch namespace is boundary |
