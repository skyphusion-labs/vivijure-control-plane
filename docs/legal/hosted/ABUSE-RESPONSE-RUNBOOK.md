# Abuse response runbook: the operator procedure

> **Status: DRAFT, not in force.** Takes effect when the hosted studio opens to signups.

> **Not legal advice.** Written by Ernst, who is named after a lawyer and is not one. The statutory
> readings are research done against primary sources and cited so they can be checked. Counsel must
> confirm the provider analysis before launch (`COUNSEL-REVIEW-CHECKLIST.md`, T1-8).

`ABUSE-AND-NCMEC.md` is the **posture**: why we do it this way. This document is the **procedure**:
what an operator actually runs, in order, when a report arrives. It exists because that document
said, correctly, that Section 3 "should be a real runbook before launch, not a paragraph."

---

## 0. The one-page version

| Step | Action | Where |
|---|---|---|
| 1 | Log arrival. The timestamp is the actual-knowledge clock and it is evidence. | S2 |
| 2 | Triage. CSAM and imminent harm jump every queue. | S3 |
| 3 | **Suspend the tenant.** Reversible, instant, destroys nothing. | S5.1 |
| 4 | Bounded look, minimum necessary, then **stop looking**. | S4 |
| 5 | **Preserve. Never delete.** | S5.2, S5.3 |
| 6 | Report to NCMEC CyberTipline as soon as reasonably possible. | S6 |
| 7 | Cooperate with law enforcement. | S7 |
| 8 | Terminate, after preservation is secured. | S8 |
| 9 | Write the incident record. | S10 |

**If you remember only one thing: suspend, do not delete.** Deletion destroys exactly what
18 U.S.C. 2258A(h) obliges us to preserve, and a well-meant cleanup here is a crime-adjacent
mistake.

---

## 1. The trigger: report-driven, never proactive

**Ruled by Conrad, 2026-07-25.** We run no classifier, no scanner, no hash-matching, and no
automated review of prompts or outputs. That absence is **policy, not a gap**, and this runbook does
not propose closing it.

The privacy position says we do not monitor tenant content (`PRIVACY-DELTA.md` Section 2.2). The
CSAM bright line's "one exception to the no-surveillance ethos" means **surveillance ON CAUSE**: a
credible report is the sole trigger, and the bounded investigation in Section 4 is the only
sanctioned deviation from the privacy policy.

This is consistent with the statute rather than in tension with it:

> **18 U.S.C. 2258A(f)** -- "Nothing in this section shall be construed to require a provider to
> (1) monitor any user, subscriber, or customer...; (2) monitor the content of any communication...;
> or (3) affirmatively search, screen, or scan for facts or circumstances[.]"

The duty attaches to **knowledge**, not to screening: 2258A(a)(1) requires action "as soon as
reasonably possible after obtaining **actual knowledge** of any facts or circumstances described in
paragraph (2)(A)."

**What (a)(2) describes**, so a responder knows what is in scope:
- **(a)(2)(A)** -- facts or circumstances from which there is an **apparent violation** of
  18 U.S.C. 2251, 2251A, 2252, 2252A, 2252B, or 2260 involving child pornography, of 1591 where the
  violation involves a minor, or of 2422(b).
- **(a)(2)(B)** -- facts or circumstances indicating such a violation **may be planned or imminent**.

**Trigger sources, all equal:**

| Source | Notes |
|---|---|
| A report to `abuse@skyphusion.org` | The primary intake. See `REPORT-ABUSE.md` for the public-facing side. |
| A report to `legal@skyphusion.org` | Misrouted reports are still reports. Do not bounce them. |
| A provider notice (Cloudflare, RunPod) | Treat as credible on arrival. |
| A law enforcement contact | Section 7. |
| Something a crew member sees incidentally | Incidental sight during ordinary operations is actual knowledge. It does not become "not knowledge" because we were not looking for it. |

**"Credible" is a low bar, deliberately.** A report is credible unless it is facially absurd or
self-evidently a prank. We do not require the reporter to prove their case; requiring proof would
make us the investigator, which is the opposite of this posture. When in doubt, treat it as
credible and proceed.

---

## 2. Intake

1. **Log the arrival**: report id, channel, arrival timestamp (UTC), reporter contact if given, and
   the verbatim report. The arrival timestamp starts the actual-knowledge clock and is the single
   most important field in the record.
2. **Acknowledge to the reporter** if they gave a contact address, without confirming or denying any
   fact about a tenant. Do not tell a reporter what we found, what we did, or whether an account
   exists.
3. **Do not open attachments a reporter sends.** If a reporter attaches suspected material, do not
   view, copy, or forward it. Preserve the message intact on the preservation path (Section 5.3) and
   proceed from the report's description. Section 4's rules apply to reporter attachments exactly as
   they apply to tenant content.
4. **Route to the responder.** For a P0 (Section 3), escalate by phone or direct message, not by
   waiting for someone to read a mailbox.

**Standing requirement:** `abuse@skyphusion.org` must be **monitored by a human on a short clock**.
An unread abuse mailbox is precisely how "actual knowledge" turns into "knowing and willful failure
to report" under 2258A(e). See Section 11.

---

## 3. Triage

| Priority | What | Clock |
|---|---|---|
| **P0** | CSAM (including synthetic or AI-generated), or any imminent risk of physical harm to a person. | Immediate. Jumps every queue, any hour. |
| **P1** | NCII, non-consensual deepfake of a real person, targeted harassment. | Same business day. |
| **P2** | Copyright/DMCA, quota evasion, platform abuse, everything else. | `ABUSE-AND-NCMEC.md` Section 5. |

**The bright line is absolute and includes synthetic and AI-generated material** (18 U.S.C. 1466A,
2252A). There is no "it is not a real child" carve-out, and no responder has discretion to apply
one. A P0 is a P0.

A P0 goes to Sections 4, 5, and 6 in that order and does not wait for a second opinion.

---

## 4. The bounded investigation: the ONE sanctioned privacy deviation

This is the only circumstance in which anyone at Skyphusion Labs looks at hosted tenant content.
Every constraint below is load-bearing.

### 4.1 The authority it rests on, quoted

`PRIVACY-DELTA.md` Section 2.2 commits us to:

> "Access only to run or repair the service, at the tenant's request, where the law compels us, or
> **when acting on an abuse report** (`ABUSE-AND-NCMEC.md`)."

**That clause is the entire authority for this section.** This runbook is the procedure that clause
points at.

> **DRIFT LOCK.** The scope of access permitted here and the scope promised in `PRIVACY-DELTA.md`
> Section 2.2 must remain identical. If either is edited, the other is edited in the **same pull
> request**, or the privacy policy becomes a false statement about our behavior. A change that
> widens this section without widening the privacy text is not a documentation defect; it is the
> policy quietly ceasing to be true.

### 4.2 Who may look

- A **named authorized responder** only. Realistically this is Conrad, plus at most one named
  backup. The list is written down (Section 11), not assumed.
- **Nobody else on the crew looks, ever**, including people with technical access. Technical
  capability is not authorization.
- The number of people is kept minimal **as a statutory matter, not just a preference**:
  18 U.S.C. 2258B(c) requires a provider to minimize the number of employees with access to reported
  material.

### 4.3 What may be looked at

- **Only the specific artifact(s) the report identifies.** A report naming one render names one
  render.
- **NOT** the tenant's library, their other projects, their cast, their chat history, or their
  account activity. A report is not a warrant for a tenant's whole studio.
- **NOT** other tenants. Ever. There is no such thing as a comparative look.

### 4.4 How far to look: the stop rule

**Look only as far as is necessary to form actual knowledge, then stop.**

> **The stop rule, stated hard: the moment it is what it looks like, STOP LOOKING.**

We are not building a case, corroborating a suspicion, assessing severity, counting instances, or
determining the age of a depicted person. NCMEC and law enforcement are equipped, trained, and
legally positioned to do that. We are not, and continuing to look past the point of knowledge serves
no lawful purpose of ours.

### 4.5 What a responder must NOT do

- **Do not download, copy, screenshot, re-encode, print, or forward the material** anywhere except
  the preservation path in Section 5.3. Knowing possession and transport are themselves offenses
  under 18 U.S.C. 2252A; the 2258B liability shield covers **reporting and preservation**, and
  2258B(b) strips it for acts done "for a purpose unrelated to the performance of any
  responsibility" under these sections. Curiosity is an unrelated purpose.
- **Do not send the material over chat, email, or any crew channel**, including to another
  responder. Reference it by artifact identifier.
- **Do not put it in an issue, a PR, a log, a ticket, or a runlog.** Incident records carry
  identifiers and findings, never payload (Section 10).
- **Do not tip off the tenant** about a pending NCMEC report or law enforcement interest
  (Section 6.5).

### 4.6 What must be logged

Every access under this section is recorded: **report id, responder identity, UTC timestamp, the
exact artifact identifiers accessed, and the conclusion reached.**

> **GAP (filed, not fixed here).** The control plane records admin **actions**
> (`recordAdminAction`, e.g. `tenant.suspend`), but there is **no content-access log**: nothing
> records that a human read a tenant artifact. Until that exists, this log is kept manually in the
> incident record, and the manual log is the control. See Section 11.

---

## 5. Freeze and preserve

### 5.1 The freeze lever that actually exists today

**Verified against the code on `main` at the time of writing** (`vivijure-control-plane`), not
assumed:

| Behavior | Where |
|---|---|
| `POST /api/admin/tenants/{ten_id}/suspend` -- admin-gated, **reason is mandatory** (a suspend without a reason is refused, because an un-auditable kill switch is not a control) | `src/index.ts` (admin routes) |
| The suspension is written to an audit row: `recordAdminAction(actor, "tenant.suspend", tenant.id, reason)` | `src/index.ts` |
| **Routing checks suspension FIRST**, ahead of lifecycle, and refuses with `403 "This studio is suspended. Contact support."` | `src/routing.ts` |
| Render is refused on a suspended tenant: `409 tenant_suspended` | `src/index.ts` |
| Module upgrade is refused on a suspended tenant (shipping code into a suspended tenant would be working around the kill switch) | `src/provisioner.ts` |
| `POST /api/admin/tenants/{ten_id}/resume` restores; `409 not_suspended` if it was not suspended | `src/index.ts` |
| `suspended_at` is **orthogonal** to the lifecycle `status` column, so resume restores the real prior state instead of guessing "live" | `src/store.ts`, `migrations/0001_init.sql` |
| Accounts have their own `suspended_at`; a suspended account resolves to no session | `src/auth.ts` |

**This is a real lever and it is the right one:** instant, reversible, audited, and it destroys
nothing. Suspend first, ask second.

### 5.2 Suspend is NOT teardown, and teardown is forbidden here

**These are different operations and confusing them is the worst mistake available in this runbook.**

| | Suspend | Teardown |
|---|---|---|
| Effect | Routing refuses; data intact | Data destroyed (`delete_data=true` empties R2 and drops the tenant D1) |
| Reversible | Yes, via resume | **No** |
| Permitted on an open report | **Yes, required** | **Never** |

**Never run teardown on a tenant with an open abuse report or an active preservation obligation.**
Doing so destroys evidence we are statutorily required to preserve.

> **GAP (filed, not fixed here), and the sharpest one in this document.** There is **no interlock**
> in the code preventing teardown of a tenant under an open preservation hold. Today the only thing
> standing between an open CSAM incident and irreversible evidence destruction is an operator
> remembering this paragraph. That is a procedural control where a technical one belongs. See
> Section 11.

### 5.3 The preservation duty, precisely

> **The number is 1 YEAR, not 90 days.** 18 U.S.C. 2258A(h)(1): a completed CyberTipline submission
> "shall be treated as a request to preserve the contents provided in the report **for 1 year** after
> the submission to the CyberTipline."
>
> **This changed in 2024.** Pub. L. 118-59 (the REPORT Act) amended 2258A(h)(1) to substitute
> "1 year" for "90 days". Any source, checklist, or memory still saying 90 days is quoting repealed
> text.

**Where the 90-day figure legitimately comes from, so the two are never conflated again:**

| | 18 U.S.C. 2258A(h)(1) | 18 U.S.C. 2703(f) |
|---|---|---|
| Trigger | **Our** submission of a CyberTipline report | A **governmental entity's** preservation request |
| Period | **1 year** from submission | **90 days**, extended a further 90 days on a renewed request |
| Who starts it | Us, automatically, by reporting | Law enforcement, by asking |

**Both can be running at once on the same incident**, on different clocks, and 2258A(h)(4) provides
that the preservation subsection does not limit authority under 2703. Track them separately.

**The rest of the preservation duty:**
- **2258A(h)(2)** -- preserve not only the reported material but reasonably accessible data and
  digital files providing **context** for the reported material.
- **2258A(h)(3)** -- preserved material is stored **securely with access limited to the minimum
  number of employees necessary**. The preservation path is segregated for this reason; it is not
  merely tidy.
- **2258A(h)(5)** -- a provider may voluntarily preserve **longer**. Retaining past a year is
  permitted; deleting early is not.
- **2258A(h)(6)** -- the statute contemplates the provider adopting NIST Cybersecurity Framework
  standards for that storage. Flagged for counsel and infra rather than asserted as satisfied.
- **2258B(c)** -- permanently destroy the depictions **upon request by law enforcement**. Destruction
  happens on their instruction, never on ours.

**Preservation overrides everything else**: a tenant's deletion request, an export, the retention
schedule, and any "right to be forgotten" claim (`PRIVACY-DELTA.md` Section 5). The privacy policy
already says deletion has a limit; this is that limit.

> **GAP (filed, not fixed here).** The **segregated preservation path does not exist yet**: there is
> no defined location for preserved material, no access control on it, and no mechanism tracking the
> 1-year clock. It must exist before it is needed, which means before signups. See Section 11.

---

## 6. Reporting to NCMEC

### 6.1 Prerequisites (these must be done BEFORE an incident, not during one)

- **Register with NCMEC as an Electronic Service Provider.** NCMEC directs prospective ESPs to
  `espteam@ncmec.org`; over 1,400 companies are registered. Registration is what gets us CyberTipline
  submission credentials.
- **Designate the individual point of contact** required by 2258A(a)(1)(B)(i). The statute requires
  the provider to supply its **mailing address, telephone number, facsimile number, electronic mail
  address, and an individual point of contact**. That is a named, reachable human, written down.

**Doing either of these after the first incident is the wrong order**, and the first incident is
exactly when there is no time.

### 6.2 Timing

"As soon as reasonably possible after obtaining actual knowledge" (2258A(a)(1)). The clock runs from
the arrival timestamp logged in Section 2, not from when someone got around to it. Suspension
(Section 5.1) is not a substitute for reporting and does not pause this clock.

### 6.3 Contents

**2258A(b) makes the contents discretionary**, and this is worth stating precisely because it is
routinely misunderstood: the report "may, at the sole discretion of the provider, include"
information identifying the user (including email, IP address, and payment data), historical
reference such as timestamps, geographic location, the visual depictions themselves, and the
complete communication containing them.

**The duty to report is mandatory; the richness of the report is ours to decide.** Our default:
report promptly with the identifying and technical information we already hold, and include or
withhold the depiction itself per NCMEC's submission guidance and law enforcement direction. We do
not go collect more in order to file a fuller report -- that would be reopening Section 4 after the
stop rule fired.

### 6.4 The liability position

**18 U.S.C. 2258B(a)** bars civil claims and criminal charges against a provider arising from its
performance of the reporting and preservation responsibilities. **2258B(b)** removes that protection
where the provider engaged in **intentional misconduct**, or acted with **actual malice**, with
**reckless disregard to a substantial risk of causing physical injury without legal justification**,
or **for a purpose unrelated** to performing those responsibilities.

**The practical reading:** reporting in good faith is protected. Rummaging is not. This is the same
boundary Section 4 draws, arriving from the other direction.

### 6.5 Do not tip off

Do not tell the tenant that a NCMEC report was filed or that law enforcement is involved, unless and
until law enforcement says it is fine. A suspension notice may say the account is suspended for an
acceptable-use violation. It does not narrate the investigation.

Note also **2258A(g)**, which restricts onward disclosure of CyberTipline report contents. Our
report is not material for a blog post, a transparency report line item, or a crew channel.

---

## 7. Law enforcement

- **Cooperate.** This is settled policy, not a judgment call per incident.
- If law enforcement sends a **2703(f) preservation request**, preserve for **90 days**, extendable
  by a further 90 on a renewed request, and track it **separately** from the 2258A(h) one-year clock
  (Section 5.3).
- Legal process (subpoena, court order, warrant) goes to Conrad. Do not respond to legal process ad
  hoc, and do not hand over tenant data on an informal request without process, other than the
  CyberTipline report itself and what 2258A contemplates.
- **What we can provide:** account records, AUP acceptance records, tenant metadata, provisioning
  records, and preserved artifacts.
- **What we cannot provide:** anything on the tenant's own RunPod account, and anything at all about
  a self-hosted instance (Section 9).

---

## 8. Termination

After preservation is secured, terminate permanently per the hosted AUP Section 4.

**Order matters: preserve, then terminate.** Termination must not be implemented as, or degrade
into, a data deletion that empties the preservation obligation.

---

## 9. The limits, stated plainly

An enforcement posture that overstates its reach is worse than a modest one:

- **We cannot reach a tenant's RunPod account** -- not the endpoints, not the templates, not the
  balance. Terminating the hosted studio does not stop a determined person from using their own
  RunPod endpoints with their own key. Law enforcement can approach RunPod directly, and RunPod's
  terms bind that account.
- **We cannot reach a self-hosted instance.** That is by design and does not change.
- **We do not know what is in a tenant's studio** unless we are told or we look, and we do not look.

Our lever is the surface we operate, applied fast. It is real, and it is not omniscience.

---

## 10. The incident record

One record per report, retained with the preservation set:

| Field | Notes |
|---|---|
| Report id, channel, arrival timestamp (UTC) | The actual-knowledge clock |
| The report, verbatim | |
| Triage priority and who set it | |
| Suspension: timestamp, actor, reason string | Cross-check against the `admin_actions` row |
| Every access under Section 4 | Responder, timestamp, artifact identifiers, conclusion |
| What was preserved, and where | |
| CyberTipline report: submission timestamp, report id | **Starts the 1-year clock** |
| Any 2703(f) request | Separate 90-day clock, and any renewal |
| Law enforcement contact | Who, when, what was provided |
| Termination timestamp | |
| Clock expiry dates | 2258A(h) and any 2703(f), tracked explicitly |

**The record carries identifiers and findings. It never carries payload.**

---

## 11. Pre-launch gaps

Per the sprint contract, gaps are **named with owners and filed as intake**, never fixed ad hoc in
this document.

**Blocking (signups do not open until these are done):**

| # | Gap | Owner | Issue |
|---|---|---|---|
| 1 | **`abuse@skyphusion.org` is not verified as deliverable or monitored.** It is already published in the **in-force** hub AUP and the hosted AUP `1.0.0`. We are advertising an intake address nobody has proven receives mail. | Infra (Strummer), with Conrad on the monitoring commitment | [#115](https://github.com/skyphusion-labs/vivijure-control-plane/issues/115) |
| 2 | **NCMEC ESP registration not started**, and the 2258A(a)(1)(B)(i) individual point of contact not designated. | Conrad (human step; cannot be delegated to code) | [#116](https://github.com/skyphusion-labs/vivijure-control-plane/issues/116) |
| 3 | **No segregated preservation path.** No defined location, no access control, no 1-year clock tracking. | Conrad + Infra | [#117](https://github.com/skyphusion-labs/vivijure-control-plane/issues/117) |
| 4 | **No teardown interlock on a preservation hold.** Irreversible evidence destruction is currently prevented only by an operator's memory. | Control-plane owner | [#118](https://github.com/skyphusion-labs/vivijure-control-plane/issues/118) |
| 5 | **Named authorized responder list does not exist.** Section 4.2 requires it; 2258B(c) makes minimizing access a statutory matter. | Conrad | [#119](https://github.com/skyphusion-labs/vivijure-control-plane/issues/119) |

**Non-blocking (should follow soon), all three tracked on
[#120](https://github.com/skyphusion-labs/vivijure-control-plane/issues/120):**

| # | Gap | Owner |
|---|---|---|
| 6 | **No content-access log.** Admin actions are audited; a human reading tenant content is not. | Control-plane owner |
| 7 | **Suspend lever never watched fire end to end** against a real tenant studio, with a positive control proving a healthy tenant still works. Per the project's verification doctrine, a lever nobody has watched fire is not a lever. | Control-plane owner |
| 8 | 2258A(h)(6) NIST CSF posture for the preservation store: unassessed. | Infra, with counsel |

---

## Appendix: primary sources

Verified against the current statute text (Cornell LII, which reflects the Pub. L. 118-59
amendments). `uscode.house.gov` was unreachable at the time of writing, so a second-source check
against the official House text is worth doing before this leaves draft; the **2023 print edition
predates the 2024 amendment and will show the repealed 90-day figure**, so do not use it as the
check.

| Cite | Holds |
|---|---|
| 18 U.S.C. 2258A(a)(1) | Report as soon as reasonably possible after **actual knowledge** |
| 18 U.S.C. 2258A(a)(1)(B)(i) | Mailing address, telephone, facsimile, email, **individual point of contact** |
| 18 U.S.C. 2258A(a)(2)(A), (B) | The apparent-violation and planned-or-imminent triggers |
| 18 U.S.C. 2258A(b) | Report contents, **at the sole discretion of the provider** |
| 18 U.S.C. 2258A(e) | Penalties: for a provider with **fewer than 100,000,000 MAU**, **$600,000** first, **$850,000** subsequent (Pub. L. 118-59; the older $150k/$300k figures are repealed) |
| 18 U.S.C. 2258A(f) | **No duty** to monitor or affirmatively search, screen, or scan |
| 18 U.S.C. 2258A(g) | Restrictions on disclosure of report contents |
| 18 U.S.C. 2258A(h)(1) | **1 year** preservation from submission (Pub. L. 118-59 substituted "1 year" for "90 days") |
| 18 U.S.C. 2258A(h)(2), (3), (5), (6) | Context data; secure storage with minimal access; voluntary longer retention; NIST CSF |
| 18 U.S.C. 2258A(h)(4) | Does not limit 2703 authority |
| 18 U.S.C. 2258B(a), (b) | Liability shield and its exceptions |
| 18 U.S.C. 2258B(c) | Minimize employees with access; destroy on law enforcement request |
| 18 U.S.C. 2703(f) | **90 days** on a governmental preservation request, plus 90 on renewal |
| 18 U.S.C. 1466A, 2252A | The bright line covers synthetic and AI-generated material; possession and transport offenses |
