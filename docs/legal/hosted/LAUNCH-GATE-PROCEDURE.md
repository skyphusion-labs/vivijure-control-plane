# Launch-gate procedure: flipping the in-force legal documents

> **Status: PROCEDURE, not in force.** This document describes how the in-force legal documents get
> flipped on the day the hosted studio opens to signups. It is written before the flip so the flip is
> mechanical rather than a rewrite under time pressure.

> **Not legal advice.** Written by Ernst (Conrad's legal-affairs helper, who is named after a lawyer
> and is not one). Counsel review of the underlying documents is tracked separately in
> `COUNSEL-REVIEW-CHECKLIST.md`; this document is sequencing, not substance.

## Why this exists

Vivijure's in-force legal documents state, correctly and repeatedly, that Skyphusion Labs does not
run a hosted multi-tenant service and holds no user data. **The moment the hosted studio accepts its
first signup, those statements become false.** They also must not be edited before that moment, because
editing them early makes the in-force policy false in the other direction, which is the same defect.

So the flip is a narrow window, not a migration. This document owns that window.

After the cf#85 extraction the documents that must change live in **three** repositories, not two. That
is the whole reason this procedure needs a written owner: before extraction it was one repo and one
person's afternoon; after extraction nobody owns it by default.

## The three repositories

| Repo | Documents that change at the flip | Why |
|---|---|---|
| `skyphusion-labs/vivijure-cf` (studio) | `docs/legal/PRIVACY.md`, `docs/legal/TERMS.md`, `docs/legal/ACCEPTABLE-USE.md` (pointer stub), `docs/legal/README.md` | These are the in-force documents. The exact required edits are enumerated in `PRIVACY-DELTA.md` Section 7. |
| `skyphusion-labs/vivijure` (hub) | `docs/legal/ACCEPTABLE-USE.md` (the canonical constellation AUP); `docs/legal/PRIVACY-COMMITMENT.md` Section 4.2 and the hosted-tier row in Section 4 | The AUP BLUF says Vivijure is "not a service Skyphusion Labs operates for the public" and "there is no central platform here." Both become false at launch, in a repository nobody working the hosted tier has open. This is the easiest item in the whole procedure to miss. **Separately**, `PRIVACY-COMMITMENT.md` Section 4.2 states in the present tense that the hosted tier "has not launched, has no tenants, and no telemetry collection is wired." That sentence goes false the day signups open; Section 7 of the commitment names this procedure as the flip owner, and the commitment was not listed here until #49. |
| `skyphusion-labs/vivijure-control-plane` (this repo) | `docs/legal/hosted/README.md` status banner, `docs/legal/hosted/aup/1.0.0.md` draft banner, this document | The hosted scaffolding stops being DRAFT and becomes the operative instrument set. |

## Owners

| Role | Who | What they own |
|---|---|---|
| **Accountable owner** | **Conrad** | The decision to flip, and the merges. These documents are representations made by Skyphusion Labs to the public; only Conrad can make them. No one else merges a flip PR. |
| Author / maintainer | Ernst | Keeping this procedure and the `PRIVACY-DELTA.md` Section 7 edit list true as the documents change. Drafting the flip PR texts ahead of the window. |
| Execution | Mackaye (lead) | Sequencing the window, holding the PRs, running the verification census, calling the rollback. |

If the hosted tier changes hands, the accountable owner moves with it and this table gets edited in
the same PR. An unowned launch gate is the failure mode this table exists to prevent.

## Preconditions (all true before the window opens)

- [ ] Counsel review: the T1 items in `COUNSEL-REVIEW-CHECKLIST.md` are answered, or Conrad has
      explicitly accepted the residual risk on the record. (Conrad's standing ruling is that launch
      does not gate on legal review; this checkbox records the decision, it does not block on it.)
- [ ] The AUP acceptance gate is live, blocking, fail-closed, and pinned to an explicit version.
- [ ] `aup/1.0.0.md` is frozen. From first serve it is immutable; a correction after that point is a
      new version file, never an edit.
- [ ] The DMCA agent question (T1-2) has an answer, because `TERMS.md` Section 10 currently says we
      are not a hosting provider and that is one of the sentences being deleted.
- [ ] **Privacy commitment (`PRIVACY-COMMITMENT.md`, hub):** the Section 4.2 rewrite and the hosted-tier
      row in the Section 4 inventory table are drafted and held in the hub flip PR. Section 4.2 must stop
      claiming "has not launched / no tenants / no telemetry collection is wired" and must instead describe
      what is actually collected post-launch.
- [ ] **Privacy commitment (hub):** the per-field telemetry dispositions and the service-level monitoring
      disclosure owed at launch (Section 4.1 and Section 4.2) are written, linked from the commitment,
      and held in the hub flip PR. Launch without them is a falsification of Section 7.
- [ ] All flip PRs are open, green, reviewed, and **held unmerged**.

## The window

**One sitting. One operator. Minutes, not days.** The PRs are staged in advance precisely so that the
window is merges and a config flag, with no authoring in it.

1. **Merge the studio repo PR** (`vivijure-cf`): PRIVACY, TERMS, ACCEPTABLE-USE stub, README.
2. **Merge the hub PR** (`vivijure`): the canonical AUP BLUF; `PRIVACY-COMMITMENT.md` Section 4.2 and
   Section 4 hosted-tier row flip to post-launch facts; per-field telemetry dispositions and
   service-level monitoring disclosure linked from the commitment.
3. **Merge the control-plane PR** (this repo): hosted docs flip from DRAFT to IN FORCE.
4. **Enable signups.** This is the last step, and it is deliberately last.
5. **Run the verification census** (below) before announcing anything.

### Why docs first and signups last

There is no ordering in which every sentence is true at every instant, so the ordering is chosen by
which falsehood is cheaper.

- **Docs last** means a real user can sign up and hand us real data while the live Privacy Policy says
  we hold none. That is a false representation to a person who relied on it, made at the exact moment
  it mattered most.
- **Docs first** means that for the few minutes between step 1 and step 4, the documents describe a
  hosted service that is not yet accepting signups. Nobody is relying on it, no data exists, and the
  statement becomes true shortly.

The second is strictly cheaper, so docs go first. Keep the gap short anyway; it is a tolerance, not a
license to leave the docs ahead of reality for a week.

## Parity preservation

The permanent hosted/self-host parity ruling (canonical: `PARITY-COMMITMENT.md` at the hub) is not
changed by this flip, and the flip must not quietly erode it. Two checks, both inside the flip PRs:

1. **No edit may introduce language implying the hosted tier has capability the self-host tier does
   not.** The hosted tier sells convenience, never capability. Any sentence that reads otherwise is a
   defect in the PR, not a thing to fix later.
2. **The self-host promises stay intact and clearly separated,** not deleted. The documents are
   growing a second mode, not replacing the first. `PRIVACY-DELTA.md` Section 7 says "keep the
   self-host promise intact and clearly separated" for exactly this reason.

## Verification census (the acceptance test)

The flip is not done because the PRs merged. It is done when the census is clean.

Across **all three repositories on `main`**, grep for the claim family being retired: "does not host",
"not a service", "no central platform", "no hosted", "not a hosted-service agreement", "exactly two
Vivijure instances", "not an online hosting provider".

Also grep the hub `PRIVACY-COMMITMENT.md` on `main` for the Section 4.2 pre-launch claim family:
"has not launched", "no tenants", "no telemetry collection is wired", "Not yet. Pre-launch", "owed at
launch and do not exist yet". Every hit must be edited or deliberately retained with a reason. A
Section 4.2 sentence that still describes pre-launch facts after signups are open is a launch defect.

Every hit must be either (a) edited, or (b) deliberately retained with a reason (some are true of
self-hosting and stay true). **A hit that is neither is a false public statement, and the launch is
not complete while one exists.** Record the census output, including the deliberate retentions and
why, in the launch checklist. A census with no recorded retentions is a census that was not actually
read.

## Rollback

If signups do not come up in the window, or come up and are pulled back, **revert the doc merges
too.** A Privacy Policy describing a hosted service that is not accepting users is false in the same
way the un-flipped version would have been; it is simply less harmful. Do not leave the documents
ahead of reality on the theory that launch is coming soon.

Rollback is a revert of the three PRs in reverse order, then a re-run of the census against the
pre-flip expectation.

## Cross-references

Every document referenced here is canonical in exactly one place and linked, never copied. See the
legal index at the hub (`skyphusion-labs/vivijure`, `docs/legal/README.md`) for which repo owns which
document.
