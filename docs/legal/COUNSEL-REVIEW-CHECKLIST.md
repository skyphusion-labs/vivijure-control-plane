# Counsel review checklist: hosted vivijure

> **Not legal advice.** Written by Ernst, who is named after a lawyer and is not one. This is the
> whole point of the document: **these are the questions a real, practicing lawyer has to answer.**
> Everything here is research and issue-spotting to make that engagement short and cheap, not a
> substitute for it. Where this checklist states a legal rule, it is cited so counsel can check it
> rather than take my word.

**How to use this:** hand it to counsel as the agenda. Each item states the question, why it is
live, what we already know, and what a usable answer looks like. Items are ordered by band, not by
importance.

---

## Scope correction, stated up front

The #57 dispatch framed the counsel review as "questions before **tier 2** (our-GPUs, payments)
ever opens." **Research says several of these block tier 1, not tier 2.** The moment we host
strangers' content on our own account we become a hosting provider and (on the analysis in
`ABUSE-AND-NCMEC.md`) a 2258A provider, and the EU AI Act has a date that does not care which tier
we are on.

So this checklist is in two bands:

- **Band T1: must be answered before hosted signups open at all.**
- **Band T2: must be answered before our-GPUs + payments.**

**This reordering is a judgment call and it is flagged, not smuggled.** If Conrad or counsel thinks
a T1 item is really a T2 item, that is a fine outcome; the cost of moving it back is one line. The
cost of discovering a T1 item at launch is not.

---

## Band T1: before hosted signups open

### T1-1. EU AI Act Article 50, and it has a live date
**Question:** Does the AI Act's Article 50 transparency obligation apply to vivijure (hosted, and
possibly self-host), and if so, what must we ship and by when?

**Why this is first:** the date is **2 August 2026** (Art 113), which is roughly two weeks from the
date on this document.

**What we know (verified against the regulation's text):**
- **Art 50(2)** requires providers of AI systems generating synthetic audio, image, video, or text
  to ensure outputs are "marked in a machine-readable format and detectable as artificially
  generated or manipulated." Vivijure generates synthetic video. That is the whole product.
- **Art 2(12), the open-source carve-out, does NOT rescue us.** Its exact text: the Regulation does
  not apply to AI systems released under free and open-source licences "**unless** they are placed
  on the market or put into service as high-risk AI systems or as an AI system that **falls under
  Article 5 or 50**." Article 50 is expressly carved OUT of the FOSS exemption. Being AGPL does not
  answer this question, which is counterintuitive and worth counsel confirming.
- **Art 2(1)** reaches providers placing AI systems on the Union market "irrespective of whether
  those providers are established or located within the Union or in a third country." Being in
  Texas does not answer it either.
- **We do not mark outputs at all today.** Verified: the codebase has no C2PA, no watermarking, no
  SynthID, no content credentials. ("Provenance" in this codebase means internal render-lineage
  sidecars for clip adoption, which is an unrelated mechanism.)
- **Possible grace period, unconfirmed:** reporting on the AI Omnibus provisional agreement (May
  2026) indicates generative systems already on the market before 2 Aug 2026 may have until **2
  December 2026** to meet the Art 50(2) marking requirement. Vivijure v1.0 shipped 2026-07-13/16,
  i.e. before that date, so this may apply. **This is secondary reporting, not primary text; counsel
  confirms it before anyone relies on it.**
- Art 50 has exemptions worth exploring, including one for **artistic and creative works**, where
  transparency is limited to disclosing the existence of generated content "without hampering the
  display or enjoyment of the work." Vivijure is a film studio. This exemption is plausibly load
  bearing for us and is worth real analysis rather than a guess.

**A usable answer:** (a) are we an Art 50 "provider"; (b) does offering hosted signups to EU users
place the system on the Union market; (c) does the creative-works exemption apply and how far;
(d) if marking is required, what satisfies it (C2PA Content Credentials?) and by 2 Aug or 2 Dec
2026; (e) **does this bite self-host too**, since Art 2(12) does not exempt Art 50 systems, which
would make this a constellation-wide engineering item and not a hosted-tier item at all.

**Note for the crew:** if the answer is "mark the outputs," that is an engineering change to the
render spine (an output-marking step in assemble), it is parity-bound (`PARITY-COMMITMENT.md`), and
it is not in any current sub-issue. **It would be new scope for the epic, and it has a deadline.**

### T1-2. DMCA: we become a hosting provider and we have no agent
**Question:** Do we need a registered DMCA agent and a repeat-infringer policy before launch?

**Why it is live:** `../TERMS.md` Section 10 currently says "the project is not an online hosting
provider and there is no provider takedown role here." At launch we store content at the direction
of users, which is exactly what 17 U.S.C. 512(c) addresses. Safe harbor under 512(c) is conditioned
on, among other things, **designating an agent with the Copyright Office**, publishing the agent's
contact details, adopting and reasonably implementing a **repeat-infringer termination policy**, and
expeditious takedown on notice. **We have none of these.** Registration is cheap and the fee is
nominal; the reason to do it is that the safe harbor is not available retroactively.

**A usable answer:** (a) register an agent now, yes or no; (b) the repeat-infringer policy text and
what "reasonably implemented" means for a service of this size; (c) the notice-and-takedown wording
for the hosted terms; (d) whether tier 1's private-by-default studios (no public sharing) change the
analysis.

### T1-3. Controller vs processor, and where RunPod actually sits
**Question:** Confirm or correct the boundary table in `PRIVACY-DELTA.md` Section 2.1.

**Why it is live:** the whole privacy delta is built on it. Our position: **controller** for account
and AUP-acceptance data, **processor** for tenant creative content, and **RunPod is the tenant's own
provider, not our sub-processor**, because the endpoints are on the tenant's account under the
tenant's contract. The wrinkle worth real attention: during a render, tenant content **moves from
our R2 to their RunPod endpoints** using credentials our provisioner placed on their templates. We
say that is a transfer on the tenant's instruction to infrastructure they own. **Counsel should
pressure-test that**, because it is the least standard part of the design and the most load-bearing.

### T1-4. Cloudflare DPA and sub-processor terms
**Question:** For hosted tenants, Cloudflare processes their data on our account and instruction. Do
we need an executed DPA with Cloudflare, and does our tenant-facing text need a sub-processor list
and change-notice commitment? Same question for the AI providers reached through **our** AI Gateway
on unified billing, which are our sub-processors for hosted (`PRIVACY-DELTA.md` Section 4.2).

### T1-5. Retention period for AUP acceptance records
**Question:** How long do we keep an acceptance record after an account is deleted, and how long do
we keep the IP and user-agent attached to it?

**Why it is live:** the record is evidence of what was agreed, so it must outlive the account, but
"forever" is not a defensible retention policy and the IP/user-agent are the privacy-sensitive part.
**A usable answer is a number**, tied to the relevant limitations period, plus a shorter number for
the IP/user-agent fields.

### T1-6. The hosted service terms themselves
**Question:** `../TERMS.md` opens by saying it is expressly **not** a hosted-service agreement. At
launch it has to be one. Does the hosted studio get its own terms, or does TERMS.md get rewritten to
cover both shapes?

**Recommendation for counsel to react to:** a separate hosted terms document, leaving the software
and project terms as they are. The two audiences are different (an operator versus a tenant), and
merging them is how both end up muddy. The needed additions: service description, acceptable use by
reference to the versioned hosted AUP, suspension/termination, disclaimers, liability, indemnity,
data/export, and the honest statement that GPU compute is the tenant's own RunPod relationship.

### T1-7. Clickwrap enforceability
**Question:** Does our signup acceptance flow produce an enforceable agreement?

**What we are building** (`README.md`, "The AUP versioning + acceptance contract"): an affirmative,
unticked "I have read and accept" action; a blocking, fail-closed gate; and an acceptance record
carrying the AUP version **and a SHA-256 of the exact served bytes**, so we can prove what was
agreed to rather than assert it. **Counsel's questions:** is the flow sufficient; is the record
sufficient; and does re-acceptance on a material change work the way we describe it?

### T1-8. Are we a 2258A "provider"? (confirm the analysis)
**Question:** Confirm that hosting tenant studios makes Skyphusion Labs a provider with a mandatory
CyberTipline reporting duty, per `ABUSE-AND-NCMEC.md` Section 1.

**Why it is live:** it flips CSAM reporting from a moral commitment to a **federal statutory duty**
with penalties of **$600,000** (first offense, under 100 million MAU) and **$850,000** (subsequent),
plus a **1-year** preservation obligation running from CyberTipline submission (2258A(e), (h)). We
are building to "yes" regardless, because it is what we would do anyway and the conservative posture
is free. **We still want it confirmed**, and we want the NCMEC ESP registration and named point of
contact done before launch rather than during an incident.

### T1-9. The decision not to scan
**Question:** Is "no proactive scanning" defensible for a hosted generative surface, and is the
reasoning in `ABUSE-AND-NCMEC.md` Section 2.1 the right reasoning?

**Our position:** 2258A(f) expressly imposes no duty to "monitor" or to "affirmatively search,
screen, or scan." Hash-matching (PhotoDNA, Cloudflare's CSAM tool) matches **known** material and is
close to useless against **novel synthetic** output, which is this surface's actual risk. Catching
novel material requires a classifier over everything every tenant generates, which is the
surveillance the project refuses and which carries a false-positive cost borne by innocent users.
**Counsel should pressure-test this**, because it is a decision we may one day have to defend, and
it should be defended with an argument rather than a shrug.

### T1-10. What entity is taking this risk?
**Question:** Is "Skyphusion Labs" a registered legal entity with liability separation, and if not,
is Conrad personally on the hook for a hosted service with public signups?

**Why this is in Band T1 and why it may be the most important item here:** every other item is about
managing a risk. This one is about **who absorbs it if management fails.** The documents say
"Skyphusion Labs and Conrad" throughout, which reads like it may not be a distinct entity. Taking
strangers' content onto our infrastructure, with statutory reporting duties attached, is a
materially different personal exposure than publishing free software.

Conrad's own stated bar for this whole tier is revenue enough to "pay the bills and pay some real
lawyer to protect my ass" (`vivijure-hosted-parity-absolute`). **This item is that protection**, and
it is a question for a lawyer plus possibly an accountant, before signups, not after. Related:
whether insurance (tech E&O / media liability) is warranted once strangers generate on our surface.

### T1-11. Age verification, given we permit adult content on a hosted surface
**Question:** Does the hosted studio trigger state age-verification laws, and does permitting adult
content (AUP Section 2.5) survive contact with them?

**Why it is live:** our governing law is **Texas** (`../TERMS.md` Section 13) and Conrad is in Texas.
Texas HB 1181 imposes age-verification duties on sites with a threshold proportion of sexual
material harmful to minors, and the Supreme Court upheld it against a First Amendment challenge in
*Free Speech Coalition v. Paxton* (2025). Louisiana, Utah, and a growing list have comparable
statutes. **Whether a generative studio meets the statutory threshold is genuinely unclear** (the
tests are written for websites publishing material, not tools generating it privately for one user),
which is exactly why counsel and not Ernst should answer it. Note the interaction: today the AUP
just asserts "you are an adult" (AUP Section 3), which is not verification of anything.

**A usable answer:** (a) do these statutes reach us; (b) if so, does permitting adult content stay
worth it at tier 1; (c) if we keep it, what verification is actually required.

---

## Band T2: before our-GPUs and payments

### T2-1. Deepfake and NCII exposure, once we own the GPUs
**Question:** How does our exposure change when generation happens on **our** infrastructure?

**Why the tier boundary is real and well-placed:** at tier 1 the model runs on the **tenant's** RunPod
account, on compute they own and pay for, under their own contract with RunPod. At tier 2 **we**
generate the content on our own GPUs. That is not a cost difference dressed up as a legal one; it is
a genuine change in who made the thing. Counsel should assess: NCII and non-consensual-deepfake
statutes (federal and the fast-moving state patchwork, including criminal exposure and the
notice-and-removal regimes), right-of-publicity claims, and what duty of care attaches to a service
that generates on request. **This is also the moment to ask whether the tier-1 structure should be
preserved deliberately** because of this, rather than treated as a stepping stone to be outgrown.

### T2-2. Section 230 probably does not cover generated output
**Question:** Does Section 230 immunity apply to content our own service generates?

**Why it is live:** 230 protects a provider from liability for information "provided by **another**
information content provider." When our GPUs generate the video, the argument that the content came
from someone else gets much weaker, and courts have begun to say so. At tier 1 there is at least a
clean story (the tenant's model, on the tenant's compute, from the tenant's prompt). At tier 2 that
story is gone. This should inform whether tier 2 happens at all, which is a strategy question and
therefore Conrad's, once counsel has told him the shape of it.

### T2-3. Liability cap, once money changes hands
**Question:** `../TERMS.md` Section 8 caps aggregate liability at **$0**, reasoned explicitly from
"the amount you paid for the software, which is zero." Tier 1 is free, so the reasoning survives.
**Tier 2 is not free and the reasoning collapses.** What is the right cap, and does it hold in the
consumer jurisdictions where users will actually be?

### T2-4. Payments, money, and tax
**Question:** Prepaid credits for GPU seconds: what does that make us? Stored value and
money-transmission analysis, refund and chargeback policy, sales/use tax on SaaS across states,
consumer-protection rules for prepaid balances, and what happens to unspent credits (escheatment).
"Prepaid credits" is a specific regulatory shape, not just a Stripe integration.

### T2-5. Adult content meets payment processors
**Question:** Does permitting adult content (AUP 2.5) survive tier 2? Card networks and processors
impose their own rules on adult content, and they enforce them commercially, without caring about
our reasoning. This is a business-viability question wearing a legal costume, and it is better
answered before the Stripe integration than after.

### T2-6. Our GPUs make scanning a live question again
**Question:** Does T1-9's "no scanning" answer change when we own the compute and the output is ours
in a way it was not at tier 1?

---

## Items deliberately NOT on this list

- **AGPL and the hosted control plane.** Not a question. Shipping the control plane AGPL is settled
  (`PARITY-COMMITMENT.md`) and creates no exposure that needs a lawyer.
- **Whether self-hosters need our permission for anything.** No. The AGPL is the whole answer.
- **Conrad's private litigation.** Out of scope, walled off, and not this crew's lane.
