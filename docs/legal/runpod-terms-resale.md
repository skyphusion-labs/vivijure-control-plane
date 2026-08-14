# RunPod terms: metered resale / intermediary posture (cp#287)

**Not legal advice.** Research by Ernst (`skyphusion-ernst`) 2026-08-02 for structural orientation.
Conrad steers product and legal decisions; a real lawyer must review before relying on any
conclusion below. Source documents are RunPod **public** ToS / Privacy / DPA as of the dates in
the body; terms change -- re-fetch before a launch gate.

**Lead answer (research, not counsel):** our metered platform-on-top model is permitted in
substance. No separate reseller agreement was found. One written-consent tripwire on credit resale;
two documents we should obtain (Compute Supplemental Terms + signed DPA).

---

Research by Ernst (`skyphusion-ernst`) 2026-08-02, on Conrad's steer that *"we're not the only client
that's using workers to provide a metered paid service there."* **Ernst is not a lawyer; this is
structure and sourcing, not legal advice.** Everything quoted below is from RunPod's PUBLIC documents.

**LEAD ANSWER: our model is permitted in substance. No separate reseller agreement exists. Standard
intermediary obligations apply. One written-consent tripwire, and two documents we should obtain.**

Documents read, with dates, because terms change and a stale read is worse than none:
ToS (Last Updated 2026-03-24), Privacy Policy (effective 2025-08-07), DPA (undated, effective on
execution), plus `docs.runpod.io/references/security-and-compliance`. Cited by section HEADING rather
than number -- the rendered numbering was inconsistent across fetch passes.

## 1. Resale: no prohibition on what we do; one clause to clear

The only resale language, in Prohibited Activities: *"Resell any credits purchased through the
Service without the prior written consent of Runpod."*

**That governs RunPod CREDITS.** We never transfer RunPod credits: tenants hold vivijure credits at
our flat rate, and jobs run on our account. **INFERRED, not quoted** -- a hostile economic-substance
reading could stretch "credits" toward metered rebilling. The clause carries its own cure, so one
written confirmation closes it permanently rather than leaving it as a standing ambiguity.

**The platform-on-top model is CONTEMPLATED by the drafting, not merely unprohibited:**
- ToS User Content refers to *"You or any of Your end users"*.
- Privacy Policy: *"This Privacy Policy does not apply to information that we process on behalf of
  our business customers..."*
- DPA data-subject categories expressly include *"the Customer's clients/service recipients"*.

Corroborates Conrad's read in substance. It is still not an express permission grant, which is why
the confirmation is worth one email.

**Our architecture already complies with the single-party licence** (*"a limited license for you and
you alone"*) **by design**, as long as tenants never touch RunPod directly -- no RunPod dashboards,
keys or API surface exposed to tenants, all access mediated by the control plane. That is how we run
today, and it is now a constraint to preserve deliberately rather than an accident.

## 2. Two documents we do not have

**a. The Compute Services Supplemental Terms.** The ToS says compute use *"may be subject to"* them,
and **they are not published anywhere Ernst could find.** An unpublished supplemental set that
controls over the ToS on inconsistency is exactly the thing not to discover after launch. Request a
copy.

**b. The DPA is NOT click-through.** The customer completes a signature block and emails it in:
*"This DPA shall become legally binding only upon completion of all such steps."* **Until signed, the
workload-data protections do not bind us or them.** It should be executed before tenant data flows.

## 3. Intermediary obligations

Everything a tenant pushes through is OUR content as far as RunPod is concerned: *"You are solely
responsible for Your Content, including its legality, reliability and appropriateness."* The
indemnity runs to us and covers tenant-caused claims.

**Structural consequence (Conrad's call): our tenant ToS should carry a back-to-back indemnity.**

**On the CSAM stance -- RunPod imposes NOTHING beyond what we already do.** Their posture is
*"Runpod will not actively monitor Content... although Runpod, at its sole discretion, may elect to
electronically monitor"*, plus a representation that content does not violate law concerning child
pornography. **No proactive-scanning duty flows to us, so the report-driven shape ruled for vivijure
is compatible.** Our bright-line is unchanged and non-negotiable regardless.

Two flags that DO reach our own documents:
- **RunPod reserves the right to monitor at its discretion and to report our end users to law
  enforcement directly.** Our tenant privacy policy must not imply that no infrastructure provider
  can ever look, because that would be a claim we cannot keep.
- **We warrant compliance with export-control and sanctions law**, which flows through to a
  sanctions/jurisdiction screen at tenant signup.

## 4. Acceptable use reaching our tenants

**There is no standalone AUP** (absence, after searching); content rules live in the ToS. Items a
video/audio tenant could trip, with us answerable:

- **Publicity rights** -- *"violates the privacy or publicity rights of any third party"*. **This is
  the sharpest one for us**: it is the deepfake / voice-clone exposure, and we ship cast LoRA training
  and lip-sync.
- *"obscene, lewd, lascivious, filthy, violent, harassing, libelous, slanderous, or otherwise
  objectionable"*. **Error direction, and it matters: read literally this reaches LAWFUL adult
  content.** If tenants can generate NSFW, that is exposure on RunPod's paper irrespective of
  legality. **Product-policy decision for Conrad**, and worth asking RunPod directly.
- IP infringement; *"false, inaccurate, or misleading"* (broad drafting); the child-protection clause.

## 5. Data handling

- RunPod takes a licence to use content *"in an aggregated and anonymized form to update and improve
  the Service"*. **Disclosure item for our tenant privacy policy.**
- Deletion on request; but on termination RunPod *"MAY... DELETE YOUR ACCOUNT AND ANY CONTENT... AT
  ANY TIME, WITHOUT WARNING"*.
- The Privacy Policy explicitly does not cover workload data. **The binding instrument is the signed
  DPA** -- irretrievable deletion on request, breach notice without undue delay, 10-business-day
  subprocessor objection window, annual audit right. All of which is moot until it is signed (see 2b).
- Operationally (docs, not terms): serverless job results retained ~30 minutes, endpoint logs 90 days.
  **So `vivijure-backend#396` remains OUR defect** -- nothing in the terms neutralises a long-lived
  credential sitting in job records.
- **Community Cloud is disclaimed entirely** (*"Runpod is only the venue"*). **Confirm every
  shared-tier endpoint pins Secure Cloud** -- the honest tenant privacy story differs materially
  between the two, and this is a checkable fact rather than a legal question.

## Actions

**For Conrad, five questions to RunPod:** (1) written confirmation that metered rebilling on our own
account is not "reselling credits", or consent under that clause; (2) a copy of the Compute Services
Supplemental Terms; (3) DPA execution; (4) whether lawful adult-content generation violates their
content standards; (5) whether an enterprise agreement is expected at our scale.

**Needs a real lawyer, flagged rather than guessed:** the credits-resale reading, the Site/Service
scope of "commercially exploit", and the back-to-back indemnity drafting.

**For us:** confirm Secure Cloud pinning on shared-tier endpoints; keep the no-direct-tenant-access
constraint deliberate; sanctions screen at signup; privacy-policy wording that does not overclaim
about infrastructure-provider access.

Refs #285, skyphusion-labs/vivijure-backend#396, skyphusion-labs/vivijure#805.

