# The segregated preservation path

> **Status: DESIGN, not built.** This is the design and the acceptance criteria for cp#117. The
> hold table and the teardown interlock (cp#118) shipped in control-plane **v1.8.0** and are real;
> everything in Section 3 and Section 4 below is specified here and does not exist yet. Nothing in
> this document is in force: the hosted studio has no signups.

> **Not legal advice.** Written by Ernst, who is named after a lawyer and is not one. The statutory
> readings are research done against primary sources and cited so they can be checked. Counsel must
> confirm the provider analysis before launch (`COUNSEL-REVIEW-CHECKLIST.md`, T1-8).

`ABUSE-RESPONSE-RUNBOOK.md` Section 5.3 states the preservation **duty**. This document is the
**path**: where preserved material physically lives, who can reach it, how it gets there, what is
recorded, and how it ever leaves. It exists because the runbook could only say the path did not
exist yet.

**This document does not widen anyone access to anything.** The set of people who may look at tenant
content, and the circumstances, are fixed by `ABUSE-RESPONSE-RUNBOOK.md` Section 4 and by
`PRIVACY-DELTA.md` Section 2.2, and the DRIFT LOCK on Section 4.1 governs both. Preservation is
about **not destroying** material, which is a different act from looking at it.

---

## 0. The one-page version

| | |
|---|---|
| **Default posture** | **Freeze in place.** Suspend the tenant (blocks the tenant deleting anything) plus an open preservation hold (blocks us tearing anything down). No bytes move. |
| **Copy out** | **Only on a 2258A or law enforcement trigger** (Section 3.1), and then as a server-side R2-to-R2 copy so no responder machine ever holds the material. |
| **Where the copy lands** | A dedicated R2 bucket, `vivijure-preservation`, outside the tenant bucket namespace, with no Worker binding anywhere and a bucket lock. |
| **Who can reach it** | Only the named authorized responders (cp#119), through a credential the crew does not hold. |
| **What tracks the clocks** | The `preservation_holds` table, already shipped. Expiry is the **floor** of the duty, never a release. |
| **How it ever empties** | A law enforcement destruction request under 2258B(c), executed by a named responder, recorded. Never a timer, never a cleanup. |

**The single most important property of this design: preserving must not require anyone to make a
new copy of the material.** The default path moves nothing.

---

## 1. What must be preserved

| Cite | Requires |
|---|---|
| **2258A(h)(1)** | The contents provided in a CyberTipline report, **1 year** from submission. Pub. L. 118-59 (REPORT Act, enacted 2024-05-07) struck "90 days" and inserted "1 year". |
| **2258A(h)(2)** | Also the **context**: visual depictions, data, and digital files that are reasonably accessible and may provide context or additional information about the reported material or person. |
| **2258A(h)(3)** | Storage **in a secure location**, with steps taken to limit access by agents or employees to that access necessary to comply. |
| **2258A(h)(5)** | Preserving **longer** is permitted, and is expressly for reducing proliferation and preventing exploitation. Deleting early is not permitted. |
| **2258A(h)(6)** | Preservation **consistent with the most recent version of the NIST Cybersecurity Framework**. See Section 7; the phase-in deadline has already passed. |
| **2703(f)** | On a **governmental entity request**: 90 days, extended a further 90 on a renewed request. A different trigger and a different clock; 2258A(h)(4) says (h) does not limit 2703. |
| **2258B(c)** | Permanently destroy the depictions **on law enforcement request**. Their instruction, never ours. |

"Context" in (h)(2) is why a preservation hold freezes the **tenant**, not a file. The prompt, the
project, the cast, the render job record and the storyboard are all context for a reported render,
and all of them are reasonably accessible to us.

---

## 2. Tier 1: freeze in place (the default, and what fires first)

**Nothing is copied. Two existing levers, both verified against the code on `main`, make the
tenant a frozen store.**

| Lever | Stops | Verified |
|---|---|---|
| **Suspend** (`POST /api/admin/tenants/{id}/suspend`, reason mandatory, audited) | **The tenant deleting their own material.** `routing.ts` checks `suspended_at` FIRST, ahead of lifecycle, and refuses with 403. Routing is by hostname, so this covers the browser session AND the programmatic studio API token: both reach the studio only through that host. | `src/routing.ts` `tenantRefusal`, `src/index.ts` suspend route |
| **Preservation hold** (`POST /api/admin/tenants/{id}/preservation-holds`) | **Us destroying it.** `teardownTenant` checks for an open hold FIRST, before the referential guard and before any delete, and refuses the whole pass. An unanswerable store fails closed. | `migrations/0010_preservation_holds.sql`, `src/provisioner.ts`, `tests/preservation-hold.test.ts` |

**Both are needed and neither substitutes for the other.** A hold does not stop a tenant deleting
their own renders; only suspension does. Suspension does not stop an operator running teardown; only
the hold does. The runbook order (suspend at step 3, before the bounded look at step 4) is
load-bearing for exactly this reason.

**Reclaim inherits the interlock** rather than bypassing it: the slug reclaim path runs
`claimReclaim -> teardown -> reclaimSlug`, so the same refusal fires. Verified in `src/index.ts`.

**There is no tenant-facing delete route on the plane.** The only tenant-scoped `DELETE` is
`/api/tenant/{id}/api-token` (revokes the studio API token). Verified by reading every route matcher
in `src/index.ts`.

**No R2 lifecycle rule exists on any tenant bucket.** The plane never configures one: there is no
lifecycle call anywhere in `src/`. Verified by grep, and recorded here because a lifecycle rule
added later would silently delete preserved material on a timer.

### 2.1 What tier 1 does NOT reach

Stated plainly, because a preservation path that overstates its reach is worse than none:

- **The tenant own RunPod account.** RunPod is the tenant provider, not our sub-processor
  (`PRIVACY-DELTA.md` Section 4.3). Anything on their endpoints, workers, or network volumes is
  beyond our custody entirely.
- **Copies the tenant already downloaded**, or published elsewhere.
- **Anything already deleted before the hold opened.** A hold is not a time machine.
- **Material outside the studio**, for example content described in a report but never rendered on
  our infrastructure.

A CyberTipline report says what we hold and preserved. It does not claim to be the complete set of
material in existence, and the incident record must not imply that it is.

---

## 3. Tier 2: the segregated preservation store

### 3.1 When a copy is made at all

Tier 2 fires **only** on one of these, and a responder records which:

1. We have submitted, or are about to submit, a **CyberTipline report** under 2258A(a)(1). The
   report contents are the thing 2258A(h)(1) obliges us to preserve, and they must survive anything
   that later happens to the tenant.
2. A **governmental entity preservation request** under 2703(f), or any legal process, names
   specific material.
3. Tier 1 **cannot hold**: an infrastructure event, an account-level action, or a lawful obligation
   that requires the tenant resources to be released.

**Tier 2 never fires for ordinary abuse** (spam, ToS complaints, billing disputes, DMCA). Those are
handled by suspension and the incident record. Copying a tenant creative work into a locked store
because somebody complained about it would be a privacy defect wearing an evidence badge.

### 3.2 The store

| Property | Value | Why |
|---|---|---|
| **Kind** | A single dedicated R2 bucket, `vivijure-preservation` | One place, named, findable under stress. |
| **Namespace** | Deliberately **outside** the `vivijure-tenant-<slug>` prefix that `tenantBucketName()` produces | Teardown only ever names `tenant.r2_bucket_name` read from the tenant row (`src/provisioner.ts`), so no teardown pass can name this bucket even by accident. |
| **Worker bindings** | **None. Anywhere.** Not in the plane, not in the dispatcher, not in a tenant studio | A bucket no Worker is bound to has no runtime path into it. This is the cheapest verifiable control in the design: the test is a grep. |
| **Lifecycle rules** | **None, ever. The list is empty and stays empty**, including R2's auto-created default (see below) | A lifecycle rule here deletes evidence on a timer. The invariant is `rules == []`, checkable by looking rather than by argument. |
| **Bucket lock** | A lock rule over the `incidents/` prefix, retention **1 year minimum** | R2 bucket locks prevent deletion and overwriting for the retention period. One year matches the longest ordinary clock, 2258A(h)(1). |
| **Account** | The same Cloudflare account as the tenant buckets | So the copy in Section 3.4 can be **server-side**. A separate account would isolate better but would force the bytes through a human machine, and avoiding possession outweighs account isolation. The residual is stated in Section 4.3. |

**On the bucket lock, honestly:** R2 bucket locks are removable by anyone holding a credential that
can configure them, and R2 documents no governance/compliance mode distinction. **This is now
measured, not predicted:** a crew-held token removed and restored the lock on the live bucket on
2026-07-25 (Section 4.3). So the lock is a
control against **accident and haste**, not against a determined administrator. That is the correct
strength here anyway: 2258B(c) requires us to be **able** to destroy material on a law enforcement
request, and a lock nobody can lift would put us in breach of that duty instead of in compliance
with (h). Re-verify the mode question at implementation time; if R2 has since added an
unremovable/compliance mode, **do not use it**, for the reason just given.

### 3.2.1 R2's default lifecycle rule: removed, and this is RULED so nobody re-litigates it

**A new R2 bucket is not created empty of lifecycle rules.** R2 adds a **Default Multipart Abort
Rule** (aborts incomplete multipart uploads after 7 days). Strummer found this building the bucket,
established what it actually does, and removed it so that `rules == []` holds. **That is the right
call and it is now the rule.**

The tempting alternative was to keep the default and reword criterion 4 to "no rule capable of
deleting a completed object", which is **technically accurate**: the abort rule cannot touch a
completed object, so it was never a threat to preserved material. It is still the weaker choice, for
four reasons:

1. **An invariant that requires an argument is weaker than one that requires a look.** "No lifecycle
   rules" is a fact anyone can check in one API call. "No rule *capable of* deleting a completed
   object" requires the checker to reason about R2 lifecycle semantics, correctly, possibly during
   an incident, possibly without knowing R2 well.
2. **A carve-out is a foothold.** Once one benign rule is permitted by argument, the next rule
   arrives with the same argument attached. "None, ever" has no argument surface. This bucket holds
   material we are statutorily forbidden to destroy early; that is exactly where a bright line beats
   a correct-but-nuanced position.
3. **It would make our invariant depend on continuously-true vendor semantics.** "Cannot delete a
   completed object" is a vendor behavior claim, true today, re-verifiable only by reading vendor
   docs we do not control. A preservation guarantee should not rest on a vendor not changing the
   meaning of a rule we chose to keep.
4. **The failure modes are asymmetric.** Removing the rule risks orphaned multipart parts billing
   indefinitely: **visible on an invoice, reversible at any time**. Keeping it risks a
   deletion-capable rule surviving a semantics change: **silent, in the data, discovered too late.**
   Prefer the failure that shows up on a bill.

**The cost is real and is handled procedurally rather than ignored.** With no abort rule, a stalled
multipart copy leaves parts that accumulate and bill. Two compensating steps, both in Section 3.4:
the copy procedure explicitly lists and aborts stale uploads, and the source is never released until
the destination is verified complete. **On this bucket, deletion of anything should be a deliberate,
recorded human act rather than a background rule.** Removing the default did not lose a safety
feature; it moved a piece of housekeeping into the open, which is where everything on this bucket
belongs.

### 3.3 Layout

```
vivijure-preservation/
  incidents/<incident_id>/
    RECORD.md          incident record: identifiers and findings, NEVER payload
    manifest.json      every preserved object: source bucket, key, size, checksum, copied_at, copied_by
    custody.log        append-only chain of custody, one line per touch (Section 5)
    ncmec/             submission id, receipt, correspondence metadata
    le/                law enforcement requests, the 2703(f) request itself, correspondence
    payload/           ONLY if Section 3.1 fired: the server-side copies
  rehearsals/<YYYYMMDD>-<seq>/
                     drills. OUTSIDE incidents/, so the lock does not bind them and they stay
                     cleanly deletable. No drill ever takes an incident id.
  incidents/_locktest/
                     one small benign object, written ONCE, to prove the lock (Section 3.3.1)
```

`<incident_id>` is `inc_<YYYYMMDD>_<6 hex>`, allocated when the incident opens, and it is the join
key across the whole system: the preservation hold, the incident record, the NCMEC submission, and
any LE correspondence all carry it.

#### 3.3.1 Where a rehearsal writes, and the one thing it must write under the lock

**Drills write to `rehearsals/<YYYYMMDD>-<seq>/`, never to an incident id.** Two reasons, and the
second is the one that matters: a fake `inc_...` entry would sit in the evidence namespace, locked
and undeletable for a year, for a responder to distinguish from a real incident under stress. **An
evidence store whose only contents for its first year are fabrications is a hazard**, not a
rehearsal artifact. Outside `incidents/` the drill is unlocked and cleanly deletable, and the
rehearsal record is worth keeping as the cp#117 acceptance evidence.

**But a drill that never writes under `incidents/` has not tested the lock, it has tested a bucket.**
The lock is part of what is being rehearsed: that it **permits** the write and **refuses** the
delete. That cannot be proven from outside the prefix it binds.

So exactly one object goes under the lock: **`incidents/_locktest/`**, a small benign file, written
once. The name is deliberate, since incident ids are `inc_<YYYYMMDD>_<6 hex>`; a leading underscore
sorts apart and can never be mistaken for one. **It will persist for the retention period, and that
is the point rather than a side effect.** The proof required is both directions: the write succeeds,
and a delete attempt is **refused** and watched failing, per the project's verification doctrine.
Record the deviation and its reason in the rehearsal's custody log.

**Templates for the three record files are committed** at
[`preservation-templates/`](preservation-templates/), so an incident starts from a form rather than
from a blank page at the worst possible moment. The custody template is checked in as
`custody.log.template` because `*.log` is gitignored in this repository; the live file inside an
incident prefix is `custody.log`.

### 3.4 How material gets there

**Server-side copy, never a download.** The copy is an S3 `CopyObject` from the tenant bucket to
`vivijure-preservation` within the same account, so the bytes never reach a workstation, a browser,
or a crew channel. This is not a preference: `ABUSE-RESPONSE-RUNBOOK.md` Section 4.5 forbids a
responder downloading, copying, or forwarding the material anywhere except this path, and 2252A
makes knowing possession and transport offences in their own right. The 2258B(a) shield covers
reporting and preservation; it is not a licence to handle material any way that is convenient.

**The copy credential is minted per incident and revoked when the copy completes**, mirroring the
mint-and-revoke discipline teardown already uses for its bucket credential. It is scoped to exactly
two buckets: the one tenant bucket named in the incident, and `vivijure-preservation`.

> **Verify at implementation, do not assume:** an R2 API token scoped to a **named set** of two
> buckets, with read on the source and write on the destination, must actually be mintable and must
> actually satisfy `CopyObject`. If the live API refuses that shape, the fallback is a token minted
> and revoked inside the same operation with a wider scope, with the wider scope and its lifetime
> recorded in `custody.log`. Minting is done with the privileged Cloudflare credential, which is
> Conrad, not the crew.

**Checksums are recorded at copy time** (the object checksum reported by R2, plus size and source
key) into `manifest.json`. A preserved object nobody can prove is the object that was reported is a
weaker artifact than one they can.

**Two steps that exist because there is no automatic multipart cleanup** (Section 3.2.1):

1. **The source is NEVER released until the destination object is complete and its checksum is
   recorded.** An incomplete multipart upload is not a readable object: if a copy stalls and the
   source is released on the assumption it was copied, the material is simply gone. This is the real
   safety property, and it is more important than any lifecycle setting.
2. **The copy procedure ends by listing in-progress multipart uploads and aborting any left behind**,
   with the abort recorded in `custody.log`. This is the housekeeping the removed default rule used
   to do silently, moved into the open where every other deletion on this bucket already lives.

---

## 4. Access control

### 4.1 Who

**The named authorized responders, and nobody else** (`ABUSE-RESPONSE-RUNBOOK.md` Section 4.2; the
list itself is cp#119). 2258A(h)(3) makes minimising access to preserved material a statutory
requirement, and 2258B(c) makes minimising the number of employees with access to reported material
one as well. This is not a preference we could relax for convenience.

**Technical capability is not authorization.** Crew members with Cloudflare access, sudo, or
production credentials are still not permitted to open this bucket. The control that makes that
statement true rather than aspirational is the credential custody rule below.

### 4.2 The credential

| Rule | |
|---|---|
| A **dedicated** R2 credential scoped to `vivijure-preservation` alone | Not the shared crew `CLOUDFLARE_API_TOKEN`, not the plane provisioning credential. |
| **Custody: the named responders only** | It does **not** go into the shared crew secret tier. If crew members can decrypt it, the access-minimisation statement is false. |
| **Escrowed** so a single lost laptop does not strand a statutory duty | An escrow the responders can open, not one the crew can. |
| **Every use recorded** in the incident `custody.log` | Section 5. |

### 4.3 The residual: what is MEASURED, what is UNPROVEN, and what we disclose

**RULED (Conrad, 2026-07-25): disclosure, not technical pretense.** We state plainly what the
platform operator is technically capable of reaching and why the capability exists, rather than
implying a technical impossibility we have not established. The stance is the same one
`PRIVACY-DELTA.md` Section 2.2 already takes about tenant studio data, applied to the preservation
store.

**Two different questions live here, and collapsing them is both scarier and less accurate:**

| Question | Statute it answers | Status |
|---|---|---|
| Can someone who is not a named responder **READ preserved material**? | 2258A(h)(3) "limit access... to that access necessary"; 2258B(c) minimise employees with access | **UNPROVEN.** Not "no". See below. |
| Can someone who is not a named responder **REMOVE THE PROTECTION** on the store? | 2258A(h)(1) and (h)(5) (preserve; do not delete early); 2258B(c) (destruction on law enforcement request) | **YES, MEASURED.** Demonstrated 2026-07-25. |

#### The access half: DESIGN-INTENDED and PARTLY VERIFIED, with the decisive test still unrun

**Two things are already verified and they are not nothing**, so this half must not be written as
uniformly unknown. Being pessimistic beyond the evidence damages the same credibility as being
optimistic beyond it:

| Verified | How | What it means |
|---|---|---|
| **No Worker binding to this bucket anywhere** | grep across configuration and `src/` in the plane, the dispatcher and the studio (criterion 2, confirmed again during cp#117 item 1) | **The RUNNING SERVICE has no path to preserved material at all.** Not a rule about it, an absence of the mechanism. |
| **No code path names any bucket except `tenant.r2_bucket_name`** | reading the teardown and provision paths | Nothing automated can name this bucket even by accident |

**So the open question is narrower than "can we see it".** It is specifically: **can a HUMAN holding
an account-scoped credential read preserved objects?** The service cannot; a person with the right
credential is the question.

And the honest answer there is **yes in principle**: an account-scoped Cloudflare credential with R2
admin rights **can** reach this bucket, because the provisioner needs account-wide R2 rights to create
per-tenant buckets on demand and R2 token scoping cannot express "everything except this one bucket."

Whether a credential the **crew** holds can read preserved objects is **still open**. The first
evidence offered for it (a crew R2 key refused HTTP 401 on the preservation bucket) was **retracted
by Strummer on cp#117**, because the control showed the same key was refused on **every** bucket
including one it is entitled to reach: a dead credential refuses everything, so the refusal said
nothing about this bucket's access control. **Criterion 7 is UNPROVEN in both halves**, not
half-measured.

**Treat the answer as unknown rather than as fine**, and do not close this section on the strength of
a credential refusal, least of all a retracted one. **Criterion 7 is what converts the written rule
into a measurement**, and it needs two things that do not exist yet: Conrad's durable responder
credential (the positive control) and a **working** crew credential (the negative half, which the
retraction showed we do not currently have, since the key tested was dead).

#### The durability half: MEASURED, and it cuts against the comfortable reading

**A crew-held Cloudflare API token fully controls this bucket's configuration.** Under cp#117 item 1,
on 2026-07-25, one created the bucket, removed R2's default lifecycle rule, applied the lock,
**removed the lock**, and restored it. That removability was demonstrated deliberately, as a
measurement.

**This directly weakens a compensating control this document previously claimed.** The original three
were: (a) no code path names any bucket except `tenant.r2_bucket_name`, verified by reading the
teardown and provision paths; (b) **the bucket lock stops casual deletion**; (c) the privileged
minting credential is Conrad rather than the crew. **(b) is worth less than it reads.** The lock
stops an accident and a hasty command; it does not stop the credential class this section is about,
and we have proven that on the live bucket rather than reasoning about it. Section 3.2 already said
locks are removable by anyone who can configure them; it is now measured rather than predicted.

**What actually protects preserved material from deletion today is a written rule, an audit trail,
and a small number of people. Not a technical barrier.** That is a legitimate control and it is the
one most organisations rely on. It is not the thing a reader would assume from the word "locked",
which is why we say it out loud.

#### What we disclose, and where

Because the stance is disclosure, this is stated to the people it affects rather than only to
ourselves: `PRIVACY-DELTA.md` Section 2.2 (the honest access statement) and Section 7 (the specified
edit to the **in-force** privacy policy at launch, which is the only one of the three a signed-up
human ever reads). **A disclosure that never reaches a user is documentation, not notification.**

#### The alternative, stated as a first-class option rather than a footnote

**Self-host and we are not in your custody chain at all.** Your hardware, your storage, no platform
operator with administrative reach over anything. That sentence is credible only because the parity
commitment is structural rather than promised: the studio **and** the hosted control plane are
AGPL-3.0-only, the control plane is not needed to self-host, and a local-GPU path exists. There is no
feature behind the hosted door.

**Precisely scoped, because overclaiming here would be the exact failure this document exists to
avoid:** self-hosting removes **us**. It does not make a self-hoster free of third parties. Anyone
who wires a GPU provider, a cloud AI endpoint, or third-party storage has those parties in their
chain, by their own choice and under their own contracts.

#### Still the weakest joint, and still a counsel question

If counsel or infra want true isolation, the option is a separate Cloudflare account, and the cost is
that the copy in Section 3.4 stops being server-side, which reintroduces human possession. That trade
is a decision, not a detail. Counsel item: **T1-13** in
[`COUNSEL-REVIEW-CHECKLIST.md`](COUNSEL-REVIEW-CHECKLIST.md), now split into a measurable access half
and a durability half that disclosure alone must carry.

---

## 5. Chain of custody

**One append-only line per touch**, in `incidents/<incident_id>/custody.log`, written by the
responder at the time of the touch:

```
<UTC timestamp> | <responder> | <action> | <object or scope> | <detail>
```

`<action>` is one of: `open`, `copy`, `access`, `submit-ncmec`, `le-request`, `le-response`,
`hold-open`, `hold-release`, `destroy`, `close`.

**What every entry must satisfy:**

- **Identifiers and findings, never payload.** The same rule the incident record follows
  (`ABUSE-RESPONSE-RUNBOOK.md` Section 10). A custody log that quotes or embeds the material
  reproduces the problem it exists to document.
- **An access entry names the exact artifact** looked at, not "the tenant material."
- **Entries are appended, never edited.** A correction is a new line stating what it corrects.

> **GAP, inherited and unchanged by this design:** the plane records admin **actions**
> (`recordAdminAction`) but there is **no content-access log**: nothing records that a human read a
> tenant artifact. Until that exists (cp#120), `custody.log` is a **manual** control kept by the
> responder, and the honest description of it is "a discipline, not a mechanism." It is listed here
> so nobody reads this section as describing automation that is not there.

**The hold row is the clock of record; the custody log is the evidence of handling.** They point at
each other through `<incident_id>`, and neither is derivable from the other.

---

## 6. The clocks, and how a hold ends

The `preservation_holds` table (shipped, cp#118) is the tracking mechanism cp#117 asked for. It is a
table rather than a column because two clocks can run on one tenant at once and 2258A(h)(4) says
they do not limit each other.

| kind | clock | starts | ends |
|---|---|---|---|
| `ncmec_2258a_h` | **1 year** | our CyberTipline submission | never automatically; see below |
| `le_2703_f` | **90 days**, renewable a further 90 | a governmental entity request | never automatically; see below |
| `internal` | none yet | a report arriving, before triage | never automatically; see below |

**An elapsed clock does not release a hold, and this design does not add a mechanism that would let
it.** `expires_at` is the **floor** of the duty: 2258A(h)(5) permits preserving longer, and 2258B(c)
puts destruction on a law enforcement request rather than on a calendar of ours. Release is an
explicit, audited, human act with a mandatory reason.

**Destruction is narrower still.** Emptying `incidents/<incident_id>/payload/` happens **only** on a
law enforcement destruction request under 2258B(c), executed by a named responder, with the request
itself filed at `le/` and a `destroy` line in `custody.log` naming the request. There is no other
path out of the store, and in particular there is no cleanup task, no retention sweep, and no
"the year is up" job. **If somebody ever proposes writing one, this sentence is the answer.**

---

## 7. NIST CSF: the deadline has already passed

**2258A(h)(6) is not a future-facing nicety.** It requires a provider preserving material under this
subsection to do so "in a manner that is consistent with the most recent version of the
Cybersecurity Framework developed by [NIST]", and it gave providers **one year from enactment** to
get there. Enactment was **2024-05-07**, so that phase-in expired **2025-05-07**. There is no grace
period left to rely on: the duty attaches the first time we preserve, which is the first time we
report.

The current version is **NIST CSF 2.0** (February 2024). The statute says "most recent version", so
re-check this at implementation rather than trusting this sentence.

**What that means concretely here, and it is not a compliance programme:** the controls this
document already specifies are the CSF-relevant ones, and they should be stated as such rather than
left implicit.

| CSF 2.0 area | The control in this design |
|---|---|
| **GV** (govern) | Named accountable responders (cp#119); a written procedure with an owner; this document. |
| **ID** (identify) | The manifest and the incident record: we know exactly what we hold. |
| **PR** (protect) | Segregated bucket, no Worker binding, dedicated credential outside crew custody, bucket lock, encryption at rest (R2 default). |
| **DE** (detect) | **Weakest area, and it should be recorded as such**: no content-access log (cp#120). Cloudflare audit logs cover credential use at the account level. |
| **RS** (respond) | `ABUSE-RESPONSE-RUNBOOK.md` in full. |
| **RC** (recover) | Not applicable in the usual sense: the recovery objective here is that the material is **not** lost, which the lock and the interlock serve. |

**This is an Ernst reading of a statutory cross-reference, and it should be checked by counsel and
by infra** rather than treated as an assessment. It is now a named counsel item: **T1-12** in
[`COUNSEL-REVIEW-CHECKLIST.md`](COUNSEL-REVIEW-CHECKLIST.md), in Band T1 because the phase-in has
expired rather than because signups depend on it. The honest position today: **we have not assessed our CSF
posture and we should not claim consistency we have not tested.**

---

## 8. Acceptance criteria

cp#117 is done when every one of these is demonstrably true. Each is stated so it can fail.

**Existence and isolation**

1. The bucket `vivijure-preservation` exists, and its name does not match the
   `vivijure-tenant-<slug>` pattern.
2. `grep -ri preservation` across the plane, dispatcher, and studio configuration finds **no R2
   binding** to it. The negative test is the artifact.
3. A bucket lock rule over `incidents/` with retention of at least 1 year is configured, read back
   from the API rather than from the dashboard. **The lock is proven in both directions on the
   prefix it binds** (Section 3.3.1): a write to `incidents/_locktest/` succeeds, and a delete of it
   is **refused and watched failing**. A lock read back but never exercised is a configuration, not
   a control.
4. **`rules == []`.** No lifecycle rule exists on the bucket, read back the same way, **including
   R2's auto-created Default Multipart Abort Rule, which is removed rather than tolerated**
   (RULED, Section 3.2.1). The criterion is deliberately the empty list and not "no rule capable of
   deleting a completed object": the second version is accurate and requires an argument, and an
   invariant that requires an argument is one somebody eventually loses.

**Access**

5. A dedicated R2 credential scoped to that bucket exists, and its custody is recorded in the
   responder list (cp#119).
6. The credential is **not** present in the shared crew secret tier. Presence-checked by name only,
   never by value.
7. **Negative test with a positive control:** a crew credential that is not the responder credential
   is refused on the bucket, AND the responder credential succeeds on the same operation. A refusal
   test alone proves nothing, because a dead capability refuses everything. **This criterion is also
   the evidence for counsel item T1-13** (Section 4.3): it is the only thing that converts "the crew
   is not authorized" into "the crew cannot reach it."

**Mechanism**

8. A rehearsal, on a **synthetic tenant with benign content**, of the full tier 2 path: open hold ->
   server-side copy -> manifest written with checksums -> custody log line -> stale multipart
   uploads listed and aborted. Written to `rehearsals/<YYYYMMDD>-<seq>/`, **never under an incident
   id** (Section 3.3.1). Never rehearsed on real material and never on real reported material.
9. In the same rehearsal, teardown of the held tenant is attempted and **refused** (the cp#118
   interlock firing against a live tenant rather than in unit tests), and a positive control tenant
   with no hold tears down normally.
10. The copy is demonstrated to be server-side: the responder machine never holds the object. Egress
    or request logs support the claim.

**Record**

11. `RECORD.md`, `manifest.json`, and `custody.log` exist for the rehearsal and carry no payload.
    The custody log records the two deliberate deviations: that this was a drill, and that
    `incidents/_locktest/` was written under the lock on purpose and will persist.
12. This document, the runbook, and `PRIVACY-DELTA.md` Section 5 agree on the retention statement,
    with no third place stating a fourth thing.

---

## 9. Implementation checklist

Owner-tagged. **Ernst writes none of the plane code**; the plane items pair with infra.

| # | Item | Owner |
|---|---|---|
| 1 | Create `vivijure-preservation` with no binding, no lifecycle rule, bucket lock over `incidents/` at >= 1 year; read every setting back from the API | Infra (Strummer) |
| 2 | Mint the dedicated responder credential; custody per Section 4.2; escrow outside crew reach | Conrad (privileged credential is his) |
| 3 | Verify the two-bucket-scoped copy token shape actually works, or record the fallback | Infra (Strummer) |
| 4 | Rehearse the tier 2 path end to end on a synthetic benign tenant (criteria 8, 9, 10) | Infra (Strummer), witnessed |
| 5 | Name the authorized responders; without it Section 4.1 has no subject | Conrad (cp#119) |
| 6 | ~~RECORD.md / manifest.json / custody.log templates~~ **DONE**, in [`preservation-templates/`](preservation-templates/) alongside this document | Ernst |
| 7 | **Optional hardening:** an `incident_ref` column on `preservation_holds` so the hold and the store join on a field rather than a convention. Until then, the hold `reason` **must begin with the incident id** | Control-plane owner |
| 8 | Counsel: CSF consistency (Section 7) and the residual in Section 4.3 | Conrad, via counsel |

---

## Appendix: primary sources

Verified 2026-07-25 against the **official** text this time, not only a mirror:

| Source | Used for | Note |
|---|---|---|
| **govinfo, PLAW-118publ59** | The amendment itself: SEC. 3 strikes "90 days" and inserts "1 year" in 2258A(h)(1); enacted **2024-05-07** | Official Public Law text. This is the strongest available second source and it settles the 1-year figure. |
| **Cornell LII, 18 U.S.C. 2258A** | Current text of (f) and (h)(1) through (h)(6), quoted in Sections 1 and 7 | Reflects the Pub. L. 118-59 amendments. |
| **uscode.house.gov** | Attempted, **unreachable again** (connection refused, same as the previous sprint) | Recorded as a fact, not worked around. The govinfo Public Law text is a better source for the amendment anyway, so this is no longer an open verification item. |
| **Cloudflare R2 bucket lock documentation** | Section 3.2: locks prevent deletion and overwrite, take precedence over lifecycle rules, are removable, and R2 documents no governance/compliance mode distinction | Re-verify at implementation; vendor docs age. |
| **NIST CSF 2.0** | Section 7 | Published February 2024; "most recent version" must be re-checked at implementation. |

**Do not use the 2023 print edition of the U.S. Code as a check.** It predates the 2024 amendment
and will show the repealed 90-day figure, so it would appear to confirm the error.
