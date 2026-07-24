# Security audit false positives

Documented dismissals for adversarial-audit (K2.7/K3) findings that are not actionable bugs in this repo's threat model.

## Cloudflare-only edge

The control plane Worker is deployed behind Cloudflare. `cf-connecting-ip` for AUP consent is trusted because the Worker is not reachable off-Cloudflare in prod.

## Operator-gated live CI (scratch release gate)

`live-release-gate.yml` is **workflow_dispatch only** with `live` defaulting to `false`. The live job runs on **ubuntu-latest** (public repo; fork-safe) and never on PR CI. Scratch RunPod/CF creds are repo Actions secrets visible only to maintainers who can dispatch. Findings that assume unauthenticated fork PRs or self-hosted runner secret exposure do not apply.

Preflight uses `${SECRET:+SET}` presence checks only; secret values are never echoed. `@v7` action pins match org aviation-grade CI convention (same as `ci.yml` / adversarial-audit).

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
