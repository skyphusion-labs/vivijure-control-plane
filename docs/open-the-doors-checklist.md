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
| CSAM bright-line: report-driven enforcement machinery exists | **READY, one blocking gap (cp#116)** | Conrad's ruling: NO proactive scanning -- the privacy policy deliberately does not monitor tenant content; the bright-line's "one exception to the no-surveillance ethos" is surveillance-ON-CAUSE, triggered only by a credible report. What must exist before signups (vivijure-cf#225): credible-report intake path, bounded investigation procedure (the one sanctioned privacy-policy deviation), evidence preserve + tenant freeze (haltable teardown), NCMEC CyberTipline + LE runbook. Refusal already lives monitoring-free in model-side LLM refusals, the curated demo path, and the AUP gate. **Signups do not open before cf#225 ships.** Written machinery landed 2026-07-25 (`ABUSE-RESPONSE-RUNBOOK.md` + `REPORT-ABUSE.md`). Of the five operational gaps that followed it, **four are closed** (cp#115, cp#117, cp#118, cp#119) and **one remains: cp#116, NCMEC ESP registration**. Rows below carry each disposition. |
| AUP acceptance gate live, blocking, fail-closed, version-pinned | PENDING | Precondition in LAUNCH-GATE-PROCEDURE.md; verify at flip |
| Abuse/support intake path: **procedure written** | DONE | `docs/legal/hosted/ABUSE-RESPONSE-RUNBOOK.md` (operator) + `docs/legal/hosted/REPORT-ABUSE.md` (public), cf#225 |
| Abuse/support intake path: **`abuse@skyphusion.org` proven deliverable + monitored** | DONE | cp#115 CLOSED. Delivery proven with an external third-party message (SPF/DKIM/DMARC all pass), role-address visibility fixed at the delivery layer (`FILE_ALSO_UNDER`), six cases including worst-case CC ordering, Conrad final-witnessed from his own client; postern v1.0.6 + crew-secrets#221. Monitoring answered by the operator himself (he receives and actively monitors it). **That is a person, not a mechanism** -- no alerting, no rota, no out-of-hours path -- which is a legitimate control for a one-person operation and is exactly what the public page promises: ORDERING (serious reports jump the queue), explicitly NOT latency, with urgent reporters told to contact the CyberTipline and law enforcement in parallel. If the operator ever stops being the sole reader, the page wording is revisited in the same pass. |
| Abuse intake reachable from a USER-FACING surface (front door) | DONE | cp#130. Live and unauthenticated: `https://studio.vivijure.com/report-abuse.html` (307 to `/report-abuse`, HTTP 200) carries `abuse@skyphusion.org`, the do-NOT-attach warning, the CyberTipline number, and the "do not wait for us" line; footer link present on `index.html` and `onboarding.html`. |
| Abuse intake link on hosted TENANT STUDIO surfaces | PENDING | **Pre-lever, NOT a cf#225 blocker.** cp#164. vivijure-cf v1.10.0 ships the reader (`src/abuse-contact.ts`; projects `host.abuse_report_url`), but the plane sets the var nowhere (repo-wide `abuse_report_url` grep: zero hits), so no tenant studio can render the link. The tenant studio is the surface where hosted content is actually seen, and intake is our entire detection surface under 2258A(f). Hosted-only by design: a self-hosted studio must never advertise our abuse address. |
| NCMEC ESP registration + 2258A(a)(1)(B)(i) point of contact | PENDING | **BLOCKING, and the ONLY remaining blocker on cf#225.** Human step, cannot be delegated to code. Application **SUBMITTED 2026-07-26** (NCMEC confirmation screen received); **submitted is not registered**. Closes when NCMEC responds confirming ESP access AND the named individual point of contact is on record with them. Owner: Conrad. cp#116. |
| Segregated preservation path exists (location, access control, 1-year clock) | DONE (11 of 12) | cp#117 CLOSED. 2258A(h)(1) is **1 year** from CyberTipline submission (Pub. L. 118-59; NOT the repealed 90 days, which is 2703(f) on a governmental request). Store built and rehearsed end to end on a synthetic benign tenant; bucket lock exercised BOTH directions and independently re-run; responder credential scope PROVEN by positive control plus a negative **by inventory** (68 account tokens walked with pagination checked, exactly one scoped to the bucket). Design: `docs/legal/hosted/PRESERVATION-PATH.md`. |
| Preservation criterion 10: protocol artifact on the FIRST REAL tier-2 copy | **STANDING OPEN (by design, never closes pre-launch)** | Not a gate and cannot be one: it can only be satisfied the first time we preserve real reported material, where possession is a 2252A question rather than a hygiene preference. Requires capturing the protocol artifact (S3 `CopyObject` with `x-amz-copy-source` and its `CopyObjectResult`), **not** a byte counter -- a counter shows only that one run moved no bytes, whereas the protocol artifact establishes the mechanism. The drill evidence was ruled sufficient for synthetic material that was ours and explicitly NOT generalisable. Recorded here because its tracking issue (cp#117) is closed and a live obligation must not live only in a closed thread. `PRESERVATION-PATH.md` Section 5. |
| Teardown interlock on a preservation hold | DONE | cp#118 CLOSED, control-plane v1.8.0 (PR #125). `preservation_holds` TABLE (two statutory clocks run at once), admin open/release routes, teardown checks the hold FIRST and refuses the whole pass, elapsed clocks NEVER auto-release, fails closed on an unanswerable store. `migrations/0010_preservation_holds.sql`, `tests/preservation-hold.test.ts`. Live-fired during the cp#117 rehearsal: byte-identical calls 7 minutes apart, only the hold state differing -- refused 17:50:05Z with `reaped/failed/absent` all empty and the row unchanged, permitted 17:57:46Z after an audited human release with no clock involved. |
| Named authorized responder list (who may look, under 2258B(c)) | DONE | cp#119 CLOSED by ruling (Conrad, 2026-07-25): **the list is one name, Conrad**, the sole employee. Access minimisation under 2258A(h)(3) / 2258B(c) is satisfied on the human axis by arithmetic. Automated agents acting under his direction hold credentials; whether that counts as "agents or employees of the service" is a real question and it is **counsel's** (COUNSEL-REVIEW-CHECKLIST T1-13), not ours to declare. Responder credential escrowed to his age tier and the lead's (crew-secrets#225); design text corrected to match actual custody in cp#151. |
| Suspend lever watched fire end to end, with positive control | DONE | Live-fired during the cp#117 rehearsal (the teardown-refusal leg above is the same drill). cp#120 stays OPEN for the rest of its scope. |
| Non-blocking abuse follow-ups: content-access log, 2258A(h)(6) NIST CSF | PENDING | cp#120. Admin actions are audited; **a human reading tenant content is not**, so the custody log in the preservation design is **a discipline, not a mechanism**, and is described that way rather than dressed up. The 2258A(h)(6) NIST CSF phase-in **has EXPIRED** (1 year from 2024-05-07 enactment, so 2025-05-07); no grace period remains and the duty attaches the first time we preserve, which is the first time we report. Neither is a signups gate (signups are not preservation). |

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
