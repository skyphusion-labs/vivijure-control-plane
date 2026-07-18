# SCOPING: EU AI Act Article 50 output marking

> # NOT IN FORCE. NOT SCHEDULED. NOT A COMMITMENT.
>
> **This is a scoping document, parked for safekeeping.** Nobody has decided that vivijure will mark
> its outputs. It exists so that IF counsel ever answers "yes, Article 50 applies to you," we open a
> scoped epic that same day instead of starting the research from zero under a deadline. Read it as
> a map of the problem, not a plan.
>
> **Explicitly out of scope here:** designing the implementation. This names the architectural seam;
> it does not design what goes in it. That is Rollins' and Strummer's call if the day comes.

> **Not legal advice.** Written by Ernst, who is named after a lawyer and is not one. The regulatory
> reading is research against primary text and the Commission's own published Code, cited so counsel
> can check it. The trigger question is T1-1 in `COUNSEL-REVIEW-CHECKLIST.md` and it is **counsel's
> to answer, not ours.**

---

## 1. The trigger question (what would have to be true)

Marking becomes real only if **all** of these land:

1. **We are a "provider" of an AI system** generating synthetic content under Art 50(2), rather than
   only a deployer of other people's models. Genuinely unobvious: vivijure orchestrates models it
   did not train (SDXL, Wan, CogVideoX, plus cloud i2v). Counsel decides.
2. **We place it on the Union market** (Art 2(1) reaches third-country providers "irrespective of
   whether those providers are established... in a third country"). Opening hosted signups to EU
   users is the plausible trigger. **Geo-blocking the EU removes this limb**, which is why the
   `PRIVACY-DELTA.md` section 6 fork is the cheaper lever and should be decided first.
3. **The creative-works exemption does not save us.** Art 50 limits transparency for "evidently
   artistic, creative, satirical, fictional or analogous work" to disclosing the existence of
   generated content "in an appropriate manner that does not hamper the display or enjoyment of the
   work." **Vivijure is a film studio: this exemption is plausibly load-bearing and deserves real
   analysis rather than a guess.** Note it appears to soften the *deployer* disclosure duty (50(4))
   more clearly than the *provider* marking duty (50(2)); do not assume it erases 50(2).

**What does NOT save us, verified against the text:** being open source. Art 2(12) exempts FOSS AI
systems "**unless** they are placed on the market or put into service as high-risk AI systems or as
an AI system that **falls under Article 5 or 50**." Article 50 is expressly carved out of the FOSS
exemption. The AGPL is not an answer here, which is counterintuitive enough that it is the single
most likely thing for us to get wrong.

---

## 1a. The cheaper answer, and the false binary to avoid

**Art 50 is not "accept the risk or do not launch." It has a removal lever, and the lever is cheap.**

Limb 2 of the trigger question above is the soft one. The obligation attaches because we would be
**placing the system on the Union market**. That is not a fact about the world, it is a consequence
of a product decision we have not made yet:

| Posture | What it does to the obligation | Cost |
|---|---|---|
| **A. Geo-block the EU at launch** | **REMOVES** the limb. No EU placement, no Art 50(2) marking duty on the hosted door. Not risk accepted; risk absent. | Real, and it is a product cost, not a legal one: EU users cannot sign up for the hosted studio. Reversible any time we decide otherwise. |
| **B. Take the Art 50 posture on** | Accepts the obligation and does the work in this document (two-layer marking, the whole epic). | The engineering in sections 3 through 6, on the clock in section 7. |

**Why this framing matters:** if the Band-B call reaches Conrad as "accept Art 50 exposure or delay
the launch," that is a **false binary**, and he would be choosing between two options when a third,
cheaper one exists. The real question is narrower and much easier to answer: **block the EU at
launch, or take the posture on.** Decide that first. If the answer is block, most of this document
is moot and the epic may never need to exist.

**Decide it FIRST**, before any of the engineering scoping below, for exactly that reason.

### The honest caveat: the geo-block does NOT remove all of it

**A geo-block on hosted signups removes the HOSTED limb only.** It does not obviously touch the
other half, and anyone who treats it as a complete answer is making a mistake:

**We also distribute AGPL software to the world, EU included.** Art 2(12)'s free-and-open-source
exemption **expressly does not cover Article 50 systems** (section 1). So the open question is
whether *distributing* vivijure to EU users is itself "placing on the market" for Art 50 purposes.
If it is, **geo-blocking the hosted door does nothing about it**, and the whole thing is a
constellation-wide question about the software rather than a hosted-tier question about the service.

That limb turns on whether free distribution of open-source software counts as making available "in
the course of a commercial activity," which is genuinely unsettled as applied to a project like this
one and is **exactly a counsel question, not an Ernst question** (T1-1).

**So the honest statement of the lever is:** the geo-block is a cheap, reversible, complete answer
for the **hosted door**, and possibly no answer at all for the **software**. It is still worth doing
first, because it is cheap and it shrinks the problem to its hard half instead of leaving us to
solve both at once.

---

## 2. What Art 50(2) actually requires

> Providers shall ensure the outputs of AI systems generating synthetic audio, image, video or text
> are "marked in a machine-readable format and detectable as artificially generated or manipulated,"
> with technical solutions that are "effective, interoperable, robust and reliable **as far as this
> is technically feasible**."

Two things worth holding onto:

- **"Machine-readable" is the operative phrase.** A visible "made with AI" caption does not satisfy
  50(2). This is a provenance obligation aimed at detection tooling, not a disclosure aimed at
  viewers. (Viewer-facing disclosure is 50(4), a *deployer* duty, and a different problem.)
- **"As far as technically feasible" is a real qualifier**, not decoration. It is the hook any
  proportionality argument would hang on.

---

## 3. What satisfies it (the standards picture, as of 2026-07-17)

The Commission published the **final Code of Practice on marking and labelling of AI-generated
content on 2026-06-10**. It is voluntary, but it is the Commission's own statement of what good
looks like, so it is the de-facto spec.

**The Code's core mechanism is a two-layer approach. Assume "pick one standard" is the wrong shape
of answer:**

| Layer | What it is | Why the Code wants it |
|---|---|---|
| **Secured metadata** | Cryptographically signed provenance attached to the file. **C2PA Content Credentials** is the named industry reference and is listed as an example satisfying all four criteria. | Rich, verifiable, interoperable. **Fragile:** stripped by re-encode, screenshot, or an uploader that discards metadata. |
| **Imperceptible watermarking** | A signal embedded in the content itself (e.g. SynthID as a complementary signal). | **Survives transformations metadata cannot** (screenshot, format conversion, re-encode). This is precisely why one layer is not enough. |
| Fingerprinting / logging | Optional under the Code. | Detection and verification support. |

Reported requirement: **at least two machine-readable layers**, C2PA as the reference. Counsel and
the actual Code text confirm the exact obligation; the takeaway for scoping is that **the work is
plausibly "metadata AND watermark," not "add some EXIF."**

**IPTC** is worth naming only to dismiss it as a standalone answer: its "Digital Source Type"
vocabulary (`trainedAlgorithmicMedia`) is a useful *field*, and C2PA can carry it, but IPTC metadata
alone is neither signed nor robust and would not carry a 50(2) claim on its own.

---

## 4. Which vivijure surfaces this touches

Art 50(2) names **audio, image, video, and text**. Vivijure emits all four. Ranked by how clearly
they are "outputs":

| Surface | Produced by | In scope? |
|---|---|---|
| **Assembled film (MP4)** | backend assemble | **Yes, at minimum.** This is the product. If anything is marked, this is. |
| **Raw clips (i2v)** | i2v modules / local doors | Likely, if delivered as artifacts. Intermediate today, but user-retrievable. |
| **Keyframes (images)** | keyframe / cloud-keyframe | Likely. They are user-visible artifacts, not just internals. |
| **Cast portraits** | cast-image | Same as keyframes. |
| **Generated audio** (narration TTS, music beds) | narration-gen, music-gen, audio-master | **Audio is named in 50(2) and is easy to forget.** Do not scope video-only. |
| **Planner / storyboard text** | AI Gateway planner | **Open question.** It is AI-generated text, but it is working material shown to one user, not content placed on a market. Flag; do not assume. |
| **Trained LoRA models** | backend LoRA training | Probably out: a model is not "synthetic audio/image/video/text output." Different regime (GPAI). Flag, do not assume. |

**The wrinkle nobody will think of: mixed provenance in one film.** A single vivijure film can
compose clips from a cloud provider that **already marks its own output** (Google Veo ships SynthID)
with clips from a local door (CogVideoX, unmarked). The assembled artifact is a composite of marked
and unmarked material. Whether the composite needs its own mark, whether ours would conflict with or
destroy an upstream provider's, and who is the "provider" of the composite, are questions this doc
raises and does not answer.

---

## 5. Where it would land architecturally (naming the seam, not designing it)

**The seam is `src/vivijure_backend/assemble.py` in `vivijure-backend`.** That is where the final
artifact is produced. `vivijure-cf` only orchestrates and observes it (`src/index.ts` reads
`u?.at === "assemble"`); the core is the wrong place for this.

**The one engineering constraint worth capturing now, because it dictates the shape:**

**The finish chain re-encodes.** `finish.py` pipes rawvideo through ffmpeg for upscale, RIFE, and
lipsync. **Any metadata applied to a keyframe or an early clip is destroyed by the time the film
ships.** So:

- **Metadata marking belongs after the last mutation of the artifact**, i.e. at or after assemble.
  This is the same discipline as verifying the artifact that ships at the moment it ships: mark the
  thing that leaves, not an ancestor of it.
- **A watermark layer has the opposite constraint:** to be in the pixels it must go in at or before
  encode, and it must then **survive** upscale/RIFE/lipsync re-encoding. Whether it does is an
  empirical question and would need a real test against our own finish chain, not a vendor claim.

That tension (metadata late, watermark early-and-durable) is the actual engineering problem. **This
document does not solve it. It names it so the epic starts with it instead of discovering it in week
three.**

**Also in the blast radius, and easy to miss:** the local-GPU doors (`vivijure-local-12gb`,
`vivijure-local-16gb`) assemble their own outputs and would need the same treatment. This is a
**constellation-wide** item, not a `vivijure-cf` one.

**Dependency reality check:** C2PA signing needs a signing library and a certificate; watermarking
needs a model or library. Both land against the project's minimal-runtime-deps rule and both need
justifying. Not a blocker, just not free.

---

## 6. The parity implication (and a genuinely hard wrinkle)

**Marking is parity-bound.** It ships to hosted and self-host in the same release or it does not
ship (`PARITY-COMMITMENT.md`). A "hosted marks outputs, self-host gets it later" outcome would be
the first violation of the parity commitment, and a compliance deadline would be the thing that
caused it. That is exactly the pressure the parity tripwires exist to catch, so it is named here in
advance.

**The wrinkle: C2PA signing requires an identity, and identity does not fork cleanly.**

- The hosted studio could sign as Skyphusion Labs, using our certificate.
- **A self-hoster cannot use our certificate.** They would need their own, or would emit unsigned or
  locally-attested claims.

So the same code shipped to both produces marks with **different trust anchors**. Is that parity?
**Ernst's read: yes, and the distinction matters.** Parity is about *capability*, never about us
lending our identity. Self-host gets the same feature, the same code, the same release; what it does
not get is our signing key, and it should not, because a signing key that anyone can run is not a
signing key. But this deserves an explicit ruling from Conrad rather than a quiet assumption,
because it is the first case where "the same release" does not mean "the same result."

---

## 7. Deadlines and grace (what the clock actually says)

| Date | What |
|---|---|
| **2026-06-10** | Final Code of Practice on marking and labelling published. The de-facto spec exists. |
| **2026-08-02** | **Article 50 applies** (Art 113). New generative AI systems comply from day one. |
| **2026-12-02** | **Reported grace:** generative systems already on the market before 2026-08-02 have until this date to bring Art 50(2) marking and detection into conformity. |

**The grace probably applies to us, and that is exactly why it must be checked rather than assumed.**
Vivijure v1.0 shipped 2026-07-13/16, i.e. **before** 2026-08-02, so it is plausibly an
already-on-the-market system with until December rather than August.

**Do not lean on that without counsel.** The date is widely reported (traced to the AI Omnibus
provisional agreement, May 2026) but I have **not** verified it against primary legislative text,
and the difference between "we have three weeks" and "we have five months" is the entire difference
between a panic and a sprint. **It is the first thing to confirm if T1-1 comes back yes.**

---

## 8. If the answer comes back "yes," the epic starts here

Not a plan, a starting shape:

1. **Confirm the clock** (August vs December) against primary text. Everything else is paced by it.
2. **Decide the EU posture first** (section 1a, and `PRIVACY-DELTA.md` section 6): block the EU at
   launch, or take the posture on. If we block, the hosted limb evaporates and the epic may not need
   to exist at all. **Remember the caveat:** the block answers the hosted door, not necessarily the
   AGPL distribution limb.
3. **Scope the surfaces** (section 4): film certainly; clips, keyframes, audio probably; text and
   models are open questions.
4. **Resolve metadata-late vs watermark-durable** against our real finish chain (section 5),
   empirically, not from vendor claims.
5. **Ruling from Conrad on the signing-identity parity wrinkle** (section 6).
6. **Constellation scope**: the local doors, not just the hosted path.
7. **Parity-bound release**, per the commitment.

---

## 9. Provenance of this document

Researched 2026-07-17 against: the AI Act text (Art 2(1), 2(12), 50, 113), the Commission's
published Code of Practice on marking and labelling (final, 2026-06-10), and this codebase (verified
directly: **no C2PA, no watermarking, no SynthID, no content credentials anywhere in the tree**;
"provenance" in vivijure means internal render-lineage sidecars for clip adoption, an unrelated
mechanism).

**Shelf life:** the standards picture is moving. If this document is more than a few months old when
you read it, re-check the Code of Practice and the grace date before relying on section 3 or 7.
A stale confident headline mis-anchors whoever reads it next, and this document is exactly the kind
that would.
