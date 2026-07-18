# Hosted studio -- legal scaffolding

> **Status: DRAFT. Nothing in this directory is in force.** These documents take effect when the
> hosted studio opens to signups. Until then the in-force documents are the ones in the parent
> directory (`../PRIVACY.md`, `../TERMS.md`, `../ACCEPTABLE-USE.md`), and they are correct as
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
| [`PRIVACY-DELTA.md`](PRIVACY-DELTA.md) | What changes about privacy when we hold accounts and tenant studio data. Draws the controller/processor boundary, including where RunPod sits. Specifies the edits the in-force `../PRIVACY.md` needs at launch. |
| [`ABUSE-AND-NCMEC.md`](ABUSE-AND-NCMEC.md) | Abuse-handling posture for a hosted generative surface: who reports, what is preserved, what we scan for (and do not), and the operational runbook. |
| [`COUNSEL-REVIEW-CHECKLIST.md`](COUNSEL-REVIEW-CHECKLIST.md) | The specific questions a real, practicing lawyer must answer. Split into what blocks tier 1 and what blocks tier 2. |
| [`PARITY-COMMITMENT.md`](PARITY-COMMITMENT.md) | The anti-rug-pull parity wording for the public docs, plus the over-promise review of it. |
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

**As built (#52), verified against `migrations-control-plane/0001_init.sql` and
`src/control-plane/aup.ts`:** the gate pins `AUP_VERSION` in config (never resolves "latest"),
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
| `1.0.0` | (unreleased) | DRAFT | Initial hosted AUP. Not in force; awaiting counsel review and launch. **Amended in place 2026-07-17 (pre-serve, zero acceptance records): Conrad's ruling incorporated the hub's opening language.** Legitimate under the first-serve rule above; would NOT be legitimate after serving starts. |

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

The in-force `../PRIVACY.md`, `../TERMS.md`, `../ACCEPTABLE-USE.md`, and `../README.md` all state,
correctly and repeatedly, that Skyphusion Labs does **not** run a hosted multi-tenant service and
holds no user data. **The day the hosted studio opens, those statements become false.**

They must not be edited before launch (that would make the in-force policy false in the other
direction, which is the same defect). The exact required edits are specified in
`PRIVACY-DELTA.md`, Section 7. **Flipping them is a launch-gate item, not a follow-up**, and it
belongs on the launch checklist next to the golden-checkpoint release pin.
