# Open-the-doors checklist (hosted signups readiness)

Status: LIVING CHECKLIST, sprint vivijure-cf#224 Lane O deliverable. **The OPEN decision is
Conrad's lever alone; this document only proves readiness, it never pulls the lever.**

Every row is either DONE with an evidence link, or PENDING with a named owner and what "done"
means. A row without evidence is not done, whatever anyone remembers.

## Provisioning + custody

| Item | Status | Evidence |
|---|---|---|
| Provision e2e green on LIVE (the yield/resume loop included) | DONE | cp#4 closed via PR #88 (`ef6813d`); restored 2026-07-25 |
| KEK recovered, verified by use, ESCROWED | DONE | crew-secrets #214 (escrow blob + manifest) + #215 (recovery runbook); deploy.md row closed via cp#98 |
| Tenant RunPod key custody: parameter, never a field | DONE | `src/provisioner.ts` custody pin; `runpod_key_required` 409 on keyless retry |
| Tenant programmatic API tokens (reveal-once, hash-only) | DONE | cp#97 / #87 / #90; ships in v1.5.0 |

## Teardown (a tenant must be able to LEAVE cleanly)

| Item | Status | Evidence |
|---|---|---|
| Referential guard: refuse before emptying (slug-reuse aliasing) | DONE | cp#92 (`e4a9ba7`); aliasing documented in docs/control-plane.md |
| R2 empty-then-delete cycle (mint -> work -> revoke -> yield) | DONE | cp#96, live-proven with positive control |
| cp#23 caller wired into teardownTenant + live rehearsal | PENDING | Rollins, Lane A2 this sprint |
| Orphan sweep (25 known) reaped or refused, recorded | PENDING | Rollins, Lane A2 this sprint |
| R2 token-revoke leg live | PENDING | Rollins, Lane A2; credential landed (gate 5) |

## Observability + monitoring

| Item | Status | Evidence |
|---|---|---|
| Aggregate-only hosted-studios checker + public Gatus tile | DONE | fleet#1083 merged + activated; tile `vivijure/hosted-studios` green; no per-tenant data public |
| Workers observability flip (stage 2) | PENDING | Gated on Conrad's ruling AFTER the Lane P residual-dataset statement. Nobody flips early. |
| Version observable on the wire | DONE | `GET /api/platform/version` (cf#114), lockstep-gated |

## Abuse + safety (bright-line)

| Item | Status | Evidence |
|---|---|---|
| CSAM bright-line: report-driven enforcement machinery exists | PENDING (rescoped 2026-07-25) | Conrad's ruling: NO proactive scanning -- the privacy policy deliberately does not monitor tenant content; the bright-line's "one exception to the no-surveillance ethos" is surveillance-ON-CAUSE, triggered only by a credible report. What must exist before signups (vivijure-cf#225): credible-report intake path, bounded investigation procedure (the one sanctioned privacy-policy deviation), evidence preserve + tenant freeze (haltable teardown), NCMEC CyberTipline + LE runbook. Refusal already lives monitoring-free in model-side LLM refusals, the curated demo path, and the AUP gate. **Signups do not open before cf#225 ships.** |
| AUP acceptance gate live, blocking, fail-closed, version-pinned | PENDING | Precondition in LAUNCH-GATE-PROCEDURE.md; verify at flip |
| Abuse/support intake path (a human can reach us; we can act) | PENDING | studio@ From-identity fix slotted 2026-07-26 (Conrad); intake route + response runbook to be named here |

## Billing + cost posture

| Item | Status | Evidence |
|---|---|---|
| Compute model ruled: byok \| managed, prepaid credits only | DONE | cf#224 comments (Conrad's rulings, 2026-07-25); design cp#100 |
| byok path (tenant pays RunPod directly) works end to end | DONE | The proven hosted e2e (`film-53d5b50d`) IS the byok path |
| managed path (proxy + meter + credits) | NOT REQUIRED TO OPEN | Doors can open byok-only; managed mode ships when B2 is built. Stated honestly on the pricing surface. |
| Our GPU bill bounded (RunPod = GPU work only; workersMax pinned) | DONE | 5 prod EPs exactly, quota 22/30, caps pinned per EP |

## Legal (the flip itself)

| Item | Status | Evidence |
|---|---|---|
| Launch-gate procedure written, owners named | DONE | docs/legal/hosted/LAUNCH-GATE-PROCEDURE.md |
| Flip PRs drafted across all three repos, held unmerged | PENDING | Ernst drafts; Conrad merges; sequenced by Mackaye per the procedure |

## The lever

When every PENDING row above is DONE-with-evidence, this checklist gets a dated sign-off section
listing each row's final evidence link, and goes to Conrad. He opens the doors or he doesn't;
nothing in this repository does it for him.
