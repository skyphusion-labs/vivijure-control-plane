# Abuse handling and NCMEC posture: the hosted generative surface

> **Status: DRAFT, not in force.** Takes effect when the hosted studio opens.

> **Not legal advice.** Written by Ernst, who is named after a lawyer and is not one. The statutory
> reading below is research, done against the primary sources and cited so it can be checked. It is
> not a legal opinion and **counsel must confirm the provider analysis in Section 1 before launch**
> (`COUNSEL-REVIEW-CHECKLIST.md`, T1-8).

---

## 0. What actually changes: the bright line loses its structural guarantee

This is the fact that should drive the whole sprint's abuse thinking.

Today, **every** Vivijure surface Skyphusion Labs operates satisfies the CSAM bright line *by
construction*, without anyone having to police anything:

| Surface | Why the bright line holds today |
|---|---|
| `vivijure.skyphusion.org` (Conrad's private instance) | Not open to strangers. Conrad and the crew, token-gated. The people generating are known. |
| `demo.vivijure.com` (public demo) | **It renders nothing.** Every state-changing request is refused and the AI/GPU integrations are not connected. The catalog is curator-vetted and seeded. The code says so in as many words: the bright line is "satisfied BY CONSTRUCTION" (`src/demo-render.ts`). |
| Self-hosted instances | Not ours. The operator is responsible, and we architecturally cannot see them. |

**The hosted studio is the first surface Skyphusion Labs operates where strangers can generate.**
The structural guarantee is gone, and nothing replaces it automatically. That is not an argument
against the hosted tier; it is the reason this document exists and the reason the posture below has
to be deliberate rather than inherited.

---

## 1. Are we a "provider" with a reporting duty? Assume yes.

**18 U.S.C. 2258A** imposes a reporting duty on an "electronic communication service provider" or
"remote computing service provider" (2258E, referring to 18 U.S.C. 2510(15) and 2711(2)). A
"remote computing service" is the provision to the public of computer storage or processing
services by means of an electronic communications system.

**The hosted studio provides, to the public, computer storage and processing services.** We host
tenant databases and tenant file storage on our own Cloudflare account and we run the compute in
front of them. The operating assumption is therefore that **Skyphusion Labs becomes a provider
under 2258A the day hosted signups open**, and this document is written to that assumption.

**This is a change in kind, not degree.** Today the project reports CSAM because it is the right
thing to do; the canonical AUP says so as a moral commitment. After launch, on the hosted surface,
**reporting is a federal statutory obligation with real penalties.** Counsel confirms the analysis
(T1-8), but the conservative posture costs us nothing and is what we would do anyway, so we build
to it now rather than wait.

### What the statute actually requires (verified against the primary text)

| Obligation | The rule | Source |
|---|---|---|
| **Report** | Report to the NCMEC CyberTipline "as soon as reasonably possible after obtaining **actual knowledge** of any facts or circumstances" indicating an apparent violation (the child-exploitation offenses listed in the statute). | 2258A(a)(1) |
| **No duty to monitor** | "Nothing in this section shall be construed to require a provider to (1) monitor any user, subscriber, or customer; (2) monitor the content of any communication; or (3) **affirmatively search, screen, or scan** for facts or circumstances." | 2258A(f) |
| **Preserve** | A completed CyberTipline report "shall be treated as a request to preserve the contents provided in the report for **1 year** after the submission." (This was **extended from 90 days** by the 2024 amendment. Anyone working from the old 90-day number is wrong.) | 2258A(h) |
| **Point of contact** | The provider must supply mailing address, telephone, and an individual point of contact to the CyberTipline. | 2258A(a)(1)(B)(i) |
| **Penalties for knowing and willful failure to report** | For a provider with **fewer than 100 million monthly active users**: **$600,000** first offense, **$850,000** for a second or subsequent offense. (Increased effective 2024; the older $150k/$300k figures are stale.) | 2258A(e) |

**The two halves that matter, together:** we are **not required to go looking**, and we **are
required to report what we actually know**. That combination is, by luck or by justice, exactly the
posture the project already wanted: no surveillance, no looking away.

---

## 2. The posture

**We do not scan. We do not monitor. We report what we learn.**

- **No proactive scanning of tenant content.** Verified as of this writing: the codebase contains no
  moderation, classifier, hash-matching, or content-scanning path of any kind. The AUP and the
  privacy text say we do not scan, and that is currently a true statement about the artifact, not an
  aspiration.
- **No automated review of prompts or outputs.**
- **On actual knowledge, we act** (Section 3): preserve, report, suspend, terminate.
- **We are honest that we can see it if we look** (`PRIVACY-DELTA.md` Section 2.2). "We do not
  scan" is a commitment about behavior, not a claim about capability, and it must never be dressed
  up as the latter.

### 2.1 Why hash-matching would not save us anyway (the sharp technical point)

The obvious "just scan for CSAM" answer does not fit a generative surface, and it is worth writing
down before someone proposes it as an easy win:

- **Hash-matching (PhotoDNA, and Cloudflare's CSAM Scanning Tool) matches KNOWN material** against a
  database of hashes of previously-identified CSAM. It is genuinely effective for a service where
  users **upload** files that have circulated before.
- **A generative studio's risk is NOVEL material.** Something a model just synthesized has never
  been seen, is in no hash database, and will not match. Hash-matching is close to useless against
  the actual risk here, while still costing us the "we scan your content" statement.
- **Catching novel synthetic CSAM requires a classifier**, which means running an automated
  judgment over **everything every tenant generates**. That is precisely the surveillance the
  project refuses, it has a false-positive rate that lands on innocent users' work, and it is not
  required by 2258A(f).

**The honest conclusion:** the effective levers on a generative surface are the **AUP gate**
(Section 1 of the AUP, stated absolutely, accepted before provisioning), **input-side refusal** if
we ever add it, **abuse reports**, and **fast, decisive enforcement when we learn something**. Not
scanning is a defensible position, and this is the reasoning it rests on. **Counsel should
pressure-test it (T1-9)**, because "we chose not to scan" is a decision we may have to defend, and
it should be defended with this argument rather than a shrug.

---

## 3. The runbook: what happens when a report arrives

This is the operational path. It should be a real runbook before launch, not a paragraph.

**Trigger:** a report to `abuse@skyphusion.org`, a provider notice (Cloudflare/RunPod), a law
enforcement contact, or something a human on the crew sees incidentally.

1. **Triage, most serious first.** CSAM and imminent-harm reports jump every queue. Everything else
   is Section 5.
2. **Suspend first, ask second (CSAM and imminent harm only).** Control-plane suspend flips routing
   to the tenant studio off instantly and is reversible (spec section 6). It is the fastest lever we
   hold and it stops the surface without destroying evidence. **Suspend, do not delete:** deletion
   destroys exactly what 2258A(h) requires us to preserve, and a well-meant cleanup here is a
   crime-adjacent mistake.
3. **Do not "verify" by browsing.** Confirm only to the minimum needed to form actual knowledge.
   Nobody on the crew goes looking through a tenant's library to build a case. If it is what it
   looks like, it goes to NCMEC and law enforcement; they are the ones equipped to look.
4. **Preserve**, on a segregated path, for **1 year** from CyberTipline submission (2258A(h)).
   Preservation overrides the tenant's deletion rights and any retention policy
   (`PRIVACY-DELTA.md` Section 5).
5. **Report to NCMEC** via the CyberTipline, as soon as reasonably possible, with the report
   contents the statute contemplates (2258A(b)), and cooperate with law enforcement.
6. **Terminate**, permanently, per the AUP Section 4.
7. **Tell them what we cannot reach:** their RunPod endpoints are on their account. We cannot delete
   them. Law enforcement can approach RunPod directly, and RunPod's own terms bind that account.
8. **Record it.** What was reported, when, what was preserved, what was sent, by whom.

### 3.1 The pre-launch actions this implies

These are concrete, small, and **must not slip past launch**:

- [ ] **Register with NCMEC as an ESP** and designate the individual point of contact required by
      2258A(a)(1)(B)(i). This is a form and an identified human. Doing it after the first incident
      is the wrong order.
- [ ] **Name the human.** Reporting duties attach to a person who is reachable. Realistically this
      is Conrad. It should be written down, not assumed.
- [ ] **Stand up the segregated preservation path** (where preserved material goes, who can reach
      it, how the 1-year clock is tracked). It must exist before it is needed.
- [ ] **Verify `abuse@skyphusion.org` is monitored** and routes to a human quickly. An unread abuse
      mailbox is how "actual knowledge" turns into "knowing and willful failure to report."
- [ ] **Confirm the suspend lever actually works end to end** before launch, against a real tenant
      studio. Per the project's own verification doctrine, a lever nobody has watched fire is not a
      lever. Watch it refuse, and watch a healthy tenant still work (the positive control).

---

## 4. Sexual content generally (and why the bright line is unaffected)

The hosted AUP permits adult sexual content between consenting adults (AUP Section 2.5), matching
the operator's discretion the canonical AUP already grants. Sections 1 (CSAM), 2.1 (NCII), and 2.2
(non-consensual deepfakes) stay absolute regardless, and none of this document softens them.

**Flagged for counsel and for Conrad, honestly:** permitting adult content on a **hosted** surface
that we operate is a materially different risk posture than permitting it on Conrad's private
instance, and it interacts with age-verification law (T1-11), the NCII/deepfake exposure (T2-1), and payment processors at
tier 2, who have their own rules about adult content and will not care about our reasoning. This is
a real decision, and tier 1 is the cheap moment to make it deliberately rather than inherit it.

---

## 5. Non-CSAM abuse

| Category | Lever | Notes |
|---|---|---|
| NCII / non-consensual deepfake of a real person | Suspend, remove, terminate. Report where required or warranted. | Fast-moving law, varies by state and country. T2-1. |
| Targeted harassment | Suspend or terminate, proportionate. | |
| Copyright / DMCA notice | Takedown of the specific content; repeat-infringer policy. | **We have no DMCA agent and no repeat-infringer policy today**, and `../TERMS.md` Section 10 currently says we are not a hosting provider. That stops being true at launch. T1-2. |
| Platform abuse (quota evasion, attacking the control plane, cross-tenant probing) | Suspend, terminate. | Cross-tenant access attempts are a security event, not just an AUP matter. |
| RunPod-side abuse | **Not our lever.** Their account, their terms. | We can terminate their hosted studio; we cannot touch their endpoints. |

---

## 6. What we cannot do, stated plainly

An enforcement posture that overstates its reach is worse than a modest one:

- **We cannot reach a tenant's RunPod account.** Not the endpoints, not the templates, not the
  balance. Termination of the hosted studio does not stop a determined tenant from using their own
  RunPod endpoints directly with their own key.
- **We cannot reach a self-hosted instance.** That is by design and it does not change.
- **We do not know what is in a tenant's studio** unless we are told or we look, and we do not look.

The honest summary: our lever is **the surface we operate**, and it is a real lever, applied fast.
It is not omniscience and the policy should never imply that it is.
