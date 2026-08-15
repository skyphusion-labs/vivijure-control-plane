# Hosted studio -- legal scaffolding

> **Status: DRAFT. Nothing in this directory is in force.** These documents take effect when the
> hosted studio opens to signups. Until then the in-force documents are the ones in the parent
> directory ([`vivijure-cf docs/legal/PRIVACY.md`](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/legal/PRIVACY.md), [`vivijure-cf docs/legal/TERMS.md`](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/legal/TERMS.md), [`vivijure docs/legal/ACCEPTABLE-USE.md`](https://github.com/skyphusion-labs/vivijure/blob/main/docs/legal/ACCEPTABLE-USE.md)), and they are correct as
> written, because today there is no hosted service.

> **Not legal advice.** Written by Ernst (Conrad's legal-affairs helper, who is named after a lawyer
> and is not one). This is structure and research, not legal advice, and it does not create an
> attorney-client relationship. **Counsel review is required before the hosted studio opens.** The
> specific questions are in `COUNSEL-REVIEW-CHECKLIST.md`.

This directory holds the legal scaffolding for the hosted BYO-RunPod-key tier (epic #40, this issue
#57). It exists as a separate directory, rather than as edits to the in-force documents, for one
reason: **the in-force documents are true today and must stay true until launch.** See
"Launch-gate: flipping the in-force documents" below.

## The documents

| File | What it is |
|---|---|
| [`aup/1.0.0.md`](aup/1.0.0.md) | **The AUP text the signup gate serves.** Versioned, immutable, self-contained. This is the exact text a tenant accepts. |
| [`PRIVACY-DELTA.md`](PRIVACY-DELTA.md) | What changes about privacy when we hold accounts and tenant studio data. Draws the controller/processor boundary, including where RunPod sits. Specifies the edits the in-force [`vivijure-cf docs/legal/PRIVACY.md`](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/legal/PRIVACY.md) needs at launch. |
| [`ABUSE-AND-NCMEC.md`](ABUSE-AND-NCMEC.md) | Abuse-handling posture for a hosted generative surface: who reports, what is preserved, what we scan for (and do not), and the operational runbook. |
| [`ABUSE-RESPONSE-RUNBOOK.md`](ABUSE-RESPONSE-RUNBOOK.md) | **The operator procedure** that `ABUSE-AND-NCMEC.md` called for: intake, triage, the bounded investigation and its hard limits, freeze/preserve as actually built, the NCMEC + law enforcement path, the incident record, and the pre-launch gap list with owners. |
| [`PRESERVATION-PATH.md`](PRESERVATION-PATH.md) | **DESIGN, not built.** Where preserved material lives, who may reach it, how it gets there, and how it ever leaves. Freeze in place by default; a segregated store only on a 2258A or law enforcement trigger. Carries the acceptance criteria and implementation checklist for cp#117. |
| [`REPORT-ABUSE.md`](REPORT-ABUSE.md) | **Public-facing.** How a member of the public reports abuse, what to include, what we do with it, and what we can and cannot reach. The reader-facing half of the intake channel. |
| [`COUNSEL-REVIEW-CHECKLIST.md`](COUNSEL-REVIEW-CHECKLIST.md) | The specific questions a real, practicing lawyer must answer. Split into what blocks tier 1 and what blocks tier 2. |
| [`PARITY-COMMITMENT.md`](PARITY-COMMITMENT.md) | **A pointer, not the text.** The parity commitment is constellation-wide and canonical at the hub ([`vivijure docs/legal/PARITY-COMMITMENT.md`](https://github.com/skyphusion-labs/vivijure/blob/main/docs/legal/PARITY-COMMITMENT.md)); this file exists so the two cannot drift. |
| [`PRIVACY-COMMITMENT.md`](PRIVACY-COMMITMENT.md) | **A pointer, not the text, and the one item here that is IN FORCE now.** The privacy commitment covers every product Skyphusion Labs ships and is canonical at the hub ([`vivijure docs/legal/PRIVACY-COMMITMENT.md`](https://github.com/skyphusion-labs/vivijure/blob/main/docs/legal/PRIVACY-COMMITMENT.md)). Section 4.1 is the part that binds this repo: we monitor the machine, never the work. This file exists so the two cannot drift. |
| [`LAUNCH-GATE-PROCEDURE.md`](LAUNCH-GATE-PROCEDURE.md) | **How the in-force documents get flipped on launch day**, across all THREE repositories. Owner, preconditions, the window and its ordering, parity preservation, the verification census, and rollback. |
| [`ART-50-SCOPING.md`](ART-50-SCOPING.md) | **SCOPING ONLY, not scheduled.** What EU AI Act Art 50 output-marking would require if counsel (T1-1) ever says it applies. Parked so a "yes" starts an epic instead of starting research. |

## The AUP versioning + acceptance contract (build to this)

This is the part the control plane (#52) implements. It is small and it is strict, because an
acceptance record is worthless if you cannot prove what was accepted.

**1. Version files are immutable FROM FIRST SERVE.** The moment a version is served to any user
(equivalently, the moment `AUP_VERSION` pins it on a live gate), `aup/<semver>.md` freezes. A
correction after that point, however small, is a NEW file. If a served version file ever changes,
every acceptance record pointing at it silently starts referring to text nobody agreed to.

**Before first serve, a draft is a draft** and may be edited in place, because there is no
acceptance record to protect. This carve-out is stated explicitly because the rule was originally
written as absolute-from-creation, which would have forced a phantom `1.0.1` for a draft nobody had
ever been served: that implies a served history that never happened, which is its own kind of lie.
The line is first serve, and it is sharp.

**2. The gate serves a pinned version.** The control plane pins the current version explicitly in
config (e.g. `AUP_VERSION=1.0.0`). It does not resolve "latest" at runtime, so a merged file cannot
silently change what new users are agreeing to.

**3. Acceptance is blocking.** No account is provisioned and no tenant studio is created without a
recorded acceptance. The gate fails closed: no acceptance record, no provisioning. This is a
precondition of the provisioner (#53), not a checkbox the UI can skip.

**4. Acceptance is logged, with enough to prove it.** The `aup_acceptances` record (control-plane
D1, per spec section 2) should carry at minimum:

| Field | Why |
|---|---|
| `account_id` | Who accepted. |
| `aup_version` | Which version (e.g. `1.0.0`). |
| `accepted_at` | When (UTC). |
| `ip_hash` | From where, **hashed, never raw**. Proves who accepted what and when without turning the acceptance log into a location dataset. |
| `user_agent` | Context for the same. |

**As built (#52), verified against `migrations/0001_init.sql` and
`src/aup.ts`:** the gate pins `AUP_VERSION` in config (never resolves "latest"),
rejects a stale submitted version rather than honoring it, is blocking and fail-closed in front of
provisioning, and **hashes the IP rather than storing it raw. That last one is better than this
document originally specified**, and the spec has been corrected to match the code rather than the
other way round.

**Open recommendation, NOT a launch blocker (Conrad's ruling: launch does not gate on legal
review).** The record stores the version *label* but no **content hash**, and `/api/aup/current`
serves `{version, url}`, so the bytes the user actually reads come from `AUP_URL` rather than from
the Worker. Two cheap hardenings, offered for whenever #52 is next open:

1. **Record a `aup_sha256`** of the served bytes alongside the version. A label proves what we
   *called* the text; a hash proves what it *said*. Immutability-from-first-serve is a discipline,
   and the hash is what makes that discipline *verifiable* instead of merely promised.
2. **Point `AUP_URL` at an immutable ref** (a tag or commit SHA, not a branch). If it resolves to a
   moving branch, the text a tenant reads changes whenever the branch does, while the recorded
   version label stays `1.0.0`, and nothing detects the drift.

This is not hypothetical: the voice change in `1.0.0` (section below) edited a version file in
place. That was legitimate, because it was a draft nobody had been served. But it is exactly the
manoeuvre the hash exists to make impossible once serving starts.

**5. Acceptance is affirmative.** A specific, unticked action ("I have read and accept the
Acceptable Use Policy"), not a pre-ticked box and not "by continuing you agree." This is a
clickwrap-vs-browsewrap enforceability point and it is cheap to get right; see
`COUNSEL-REVIEW-CHECKLIST.md` (T1-7).

**6. A new version requires re-acceptance.** On a material change, existing tenants are gated into
accepting the new version before they keep using the studio. Old acceptance records are retained,
never overwritten: they are the evidence of what that tenant agreed to at that time.

**7. Old versions stay served and readable.** A tenant whose record says `1.0.0` must be able to
read `1.0.0`. Version files are never deleted.

## Version changelog

| Version | Date | Status | Change |
|---|---|---|---|
| `1.0.0` | served from 2026-07-17 | **SERVED AND ACCEPTED -- FROZEN** | Initial hosted AUP. **CORRECTED 2026-08-15 (cp#396): the two entries this row used to carry, both claiming amendment was legitimate because it was pre-serve with zero acceptance records, were wrong on the facts.** A count against the live control-plane D1 (`CP_DB`, table `aup_acceptances`) found **4 acceptances of 1.0.0**, every one recording sha256 `1072c782`. The rows, so the arithmetic below can be checked rather than taken: `2026-07-17 15:10:40`, `2026-07-25 13:37:05`, `2026-07-25 17:07:50`, `2026-08-01 14:51:15` (UTC). So the 2026-07-28 amendment (PR #224) landed after **THREE** acceptances and the 2026-08-14 amendment (PR #394) after all four. Both were post-serve edits to a frozen version. The claim was never checked when it was written, and it read as true because nobody had asked the database. **This row itself first said TWO** (caught by ernst, 2026-08-15): the dates were printed correctly right beside it and nobody added them up, which is the same failure one layer down. The timestamps are now listed so the count is checkable from the row rather than trusted, and the corrected figure was re-read from the D1 rows, not from this prose. |
| `1.1.0` | (not yet served) | **NOT YET SERVED** (force status is Conrad to state) | **The cp#394 shared-tier scoping correction, shipped as a NEW version rather than an edit, because 1.0.0 is frozen.** 1.0.0 states of ALL tenants that the hosted studio renders on GPU endpoints running on their own RunPod account, which is false for a pooled tenant (`provisioner.ts:202`: a pooled tenant has no RunPod account). MINOR, not PATCH: it changes what a person is agreeing to, and a patch number would understate that to the four accounts being re-prompted. **Also drops the `Status: DRAFT, not in force` line that 1.0.0 carries.** A gate that hard-blocks live accounts until they accept a document cannot ask them to accept one that disclaims its own force: either it binds and the label is false, or it does not and the gate is theatre. Carrying the line into a new version would have reasserted it deliberately rather than by inheritance. Whether the AUP is in force is Conrad to state; this removes a claim that the gate contradicts, it does not make the opposite claim. Bumping `AUP_VERSION` IS the re-prompt (blocking gate, `src/index.ts:435`), and moving it is the lead. |


### 1.0.0 in this repository was RESTORED to the bytes that were served

Recorded because the correction is more interesting than the state it fixed, and because the
reasoning generalises.

Until 2026-08-15, aup/1.0.0.md here was NOT the document anyone accepted. Four accounts accepted
bytes hashing to 1072c782; no revision of this file had ever hashed to that value, across all
three of its commits (ca9bf69a, 20fd5105, d0533987). The served document existed only in
vivijure-cf at commit 8a5d96b4, orphaned from that repository main. Two of those three commits
were in-place edits made AFTER serving had begun.

The file has been restored from that commit and verified to hash to 1072c782.

**Why restoring a frozen version file is not a violation of the freeze.** The rule binds the
bytes that were SERVED, not a file that never served them. AUP_URL still points at the cf commit,
so nothing a tenant can reach changed; this corrects the RECORD to match the artifact. Leaving it
alone would have been the worse outcome: a repository that owns the AUP, holding a file labelled
1.0.0 that misrepresents 1.0.0, while the accepted text had no home here at all.

**What stops it drifting again.** scripts/check-aup-files-immutable.sh hashes every version file
in this directory against SHA256SUMS on every CI run. It is the check that would have caught all
three in-place edits, and it is deliberately the cheapest possible one: no network, no deploy,
hash and compare. The reason the edits survived is not that they were subtle, it is that nothing
had an opinion about them.
## Drift: this AUP vs the canonical constellation AUP

The **canonical constellation AUP** lives at the project hub
(`skyphusion-labs/vivijure`, `docs/legal/ACCEPTABLE-USE.md`) and is the policy for the software and
for self-hosting. The hosted AUP here is a **separate, self-contained instrument** for the hosted
service.

It is deliberately self-contained rather than incorporating the hub AUP by reference, because a
signup instrument cannot bind a user to text in another repository that can change after they
accepted it. The cost of that choice is drift risk: the two documents state the same prohibitions
and can diverge.

**The sync duty:** a change to the prohibitions in either document is a prompt to review the other.
The CSAM red line (Section 1) and the NCII/deepfake sections must never diverge in substance. When
this list grows a third member, replace this note with a real drift check.

## The AUP voice: RULED (Conrad, 2026-07-17)

**Conrad ruled that the hub AUP's existing language carries into the hosted instrument.** His voice
stays. It is incorporated at the top of `aup/1.0.0.md`, ahead of everything else, which is where the
hub puts it.

**Carried verbatim** (byte-checked against the hub copy):
- "Skyphusion Labs stands with victims."
- "You do not use our products to create CSAM or nonconsensual intimate images."
- "because people who victimize people in such a harmful way, especially children, are the *ONE*
  exception to a blanket privacy policy, you sick fuck."
- "That is the line, in plain words. Section 1 makes the prohibition..."

**One clause deviates, and only one, because carrying it verbatim would have made the document
false.** The hub reads "Even though we have no way of obtaining data from your self-hosted
instances, we will cooperate if we find out..." That is TRUE of self-hosting and **false of a studio
we host**, where we can see tenant data and where reporting is a statutory duty rather than
cooperation we volunteer. Pasting it into a hosted instrument would have re-introduced the exact lie
this whole directory exists to prevent (`PRIVACY-DELTA.md` section 2.2).

The replacement clause is **harder than the original, not softer**: "On a studio we host for you we
are not blind the way we are with a self-hosted instance, and reporting you is not a favor we choose
to do, it is the law." The stance is unchanged; only the fact underneath it is corrected to the
hosted truth. **If Conrad wants a different formulation of that clause, it is his to write, and this
note is the record that it was changed deliberately and why.**

**The enforceability trade-off, on the record as instructed.** This is a click-through instrument
whose enforceability is a live counsel question (T1-7). The register is unusual for one, and a court
reading it will notice. Ernst's read, offered as research and not advice:

- **The profanity does not go to enforceability.** What courts examine in a clickwrap dispute is
  whether assent was affirmative, whether the terms were reasonably conspicuous, and whether the
  user had a real chance to read them. Tone is not a factor in that test, and our gate is built for
  it (affirmative unticked action, blocking, fail-closed, versioned record).
- **The prohibition it decorates is unambiguous**, which is what actually matters: Section 1 states
  the rule, the scope, the statutory basis, and the consequence with no hedge and no exception.
  Vagueness would be an enforceability problem. Vulgarity is not vagueness.
- **The residual risk is presentational, not legal:** an adjudicator, a payment processor, or a
  journalist may read the register as unserious. Against that, the line reads as exactly what it is,
  which is a person meaning it, and that is Conrad's call to make and he has made it.

Counsel should still see it (T1-7). If counsel says it genuinely costs us enforceability, that is
new information and Conrad decides again with it. Until then: his voice, his instrument, on the
record as deliberate.

## Launch-gate: flipping the in-force documents

The in-force documents in the other two repositories state, correctly and repeatedly, that
Skyphusion Labs does **not** run a hosted multi-tenant service and holds no user data. **The day the
hosted studio opens, those statements become false.** They must not be edited before that day
either, because that makes the in-force policy false in the other direction, which is the same
defect.

So the flip is a narrow window, not a migration, and after the cf#85 extraction it spans **three**
repositories rather than one. That is exactly why it now has a written procedure with a named owner
instead of a warning paragraph:

**See [`LAUNCH-GATE-PROCEDURE.md`](LAUNCH-GATE-PROCEDURE.md).** It owns the ordering, the
preconditions, the verification census, and the rollback. The accountable owner is Conrad; nobody
else merges a flip PR.

The exact document edits remain specified in [`PRIVACY-DELTA.md`](PRIVACY-DELTA.md), Section 7.
