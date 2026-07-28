# Privacy delta: what changes when we host

> **Status: DRAFT, not in force.** Takes effect when the hosted studio opens. The in-force policy is
> [`vivijure-cf docs/legal/PRIVACY.md`](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/legal/PRIVACY.md), which is correct today.

> **Not legal advice.** Written by Ernst, who is named after a lawyer and is not one. The
> controller/processor characterization below is a reasoned starting position, not a legal
> conclusion, and it is exactly the kind of thing that needs counsel sign-off (see
> `COUNSEL-REVIEW-CHECKLIST.md`, T1-3).

---

## BLUF

[`vivijure-cf docs/legal/PRIVACY.md`](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/legal/PRIVACY.md) currently rests on a single load-bearing fact: **there is no hosted service, so
there is nothing for us to hold.** The hosted tier makes that false. It does not soften it or
qualify it; it inverts it.

After launch, for hosted tenants:

- **We hold accounts.** Email, auth identifiers, and AUP acceptance logs, in a control-plane
  database that is ours.
- **We hold tenant studio data.** Every tenant's database and file storage lives on **our**
  Cloudflare account. Isolation between tenants is real (own Worker, own D1, own R2 bucket, own
  secrets), but isolation from **us** is not: we administer the account they sit in.
- **We can technically read tenant content.** This is the honesty line that matters most, and the
  policy has to say it in those words.
- **GPU rendering stays the tenant's.** It runs on their RunPod account under RunPod's terms,
  billed to them. That boundary is real and worth stating precisely, because it is unusual.

The self-host story is unchanged and stays literally true: self-hosted instances never talk to us.
The delta below applies to hosted tenants only, and the policy must never blur the two.

---

## 1. The data we hold, exactly

### 1.1 Control-plane data (Skyphusion Labs is the CONTROLLER)

We decide why and how this exists. It is ours, in the control-plane D1 (spec section 2).

| Data | Fields | Why it exists |
|---|---|---|
| **Accounts** | email address; auth identifiers (a Google/GitHub/Apple subject identifier for SSO signups, or a magic-link token for email signups) | To have an account at all, and to let you back into it. |
| **Tenants** | tenant name/slug, the subdomain, provisioning state, quota + suspend state | To route `<tenant>.studio.vivijure.com` to your studio and to enforce quotas. |
| **AUP acceptances** | account id, AUP version, timestamp, **a hash of your IP address (never the raw IP)**, user agent | To prove what you agreed to and when. This is evidence; it is retained for as long as the account exists plus a limitations-period tail (see Section 5). Corrected 2026-07-17 to match the shipped gate: an earlier draft of this table claimed a raw IP and a content hash of the accepted text. The code stores neither. **A privacy document that overstates what we collect is still a false privacy document**, so the table now describes `aup_acceptances` as built. |
| **Provision jobs** | job state, step results, error text | So a failed provision fails honestly and is resumable. May contain your tenant name and RunPod endpoint IDs. **Never contains a RunPod key** (Section 3). |

**Tenant-facing studio data never lives in the control plane.** That is an architectural rule from
the spec, and it is the reason a control-plane breach does not spill anyone's creative work.

### 1.2 Tenant studio data (yours; we are the CUSTODIAN, and see Section 2)

Each tenant studio holds exactly what a self-hosted studio holds ([`vivijure-cf docs/legal/PRIVACY.md`](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/legal/PRIVACY.md) Section 3 is the
complete list and stays accurate): storyboards and projects, cast and character bibles, portraits
and reference images, trained LoRA models, uploads, render job state, generated outputs, the
`api_tokens` name+hash table, and the studio's secrets.

The difference is only **where it sits**: on our Cloudflare account instead of yours.

---

## 2. Controller, processor, and the honest access statement

### 2.1 The boundary

| Data | Our role | Their role |
|---|---|---|
| Account + AUP acceptance + tenant metadata | **Controller.** We decide it exists and why. | Data subject. |
| Tenant creative content (D1 + R2) | **Processor**, acting on the tenant's instructions. We do not decide what it is for. | **Controller** of their own content. |
| Planner / chat AI calls | **Controller of the integration**; the AI providers we route to are **our sub-processors** (Section 4.2). | Their prompts, their content. |
| GPU rendering on RunPod | **Not in the relationship.** | **Theirs.** Their account, their key, their contract with RunPod (Section 4.3). |

**The processor characterization of tenant content is a position, not a settled fact.** It is the
standard hosted-SaaS framing and we think it is right: the tenant determines the purposes of their
creative content and we only act on their instructions. But we determine the means (the
architecture), and we run the service on our own account, which is the kind of nuance counsel gets
paid to resolve. **Do not treat this table as decided until counsel signs it off** (T1-3).

### 2.2 The access statement (this must survive editing)

The single most important sentence in the hosted privacy story:

> **Your studio data lives on our Cloudflare account, which means we are technically capable of
> reading your projects, prompts, cast images, and finished films. We do not look, and we run no
> scanning of what you generate.**

The existing policy's strongest claim, that we "architecturally cannot monitor, see, or surveil what
anyone generates," is TRUE for self-hosting and **FALSE for hosted tenants**. Repeating it after
launch would be a lie, and it is exactly the kind of lie that turns a good privacy story into a
scandal when someone reads the architecture. Say the true thing instead. It is still a good story:

- No proactive monitoring, no content scanning, no automated review.
- No training on tenant content. No profiling. No sale of anything.
- Access only to run or repair the service, at the tenant's request, where the law compels us, or
  when acting on an abuse report (`ABUSE-AND-NCMEC.md`). Access that reaches into a specific tenant is recorded
  (Section 2.3).
- The one exception is CSAM, and it is stated as an exception rather than hidden.
- **And if you want a studio we genuinely cannot see, self-host it.** That option is free, fully
  featured, and we point at it rather than bury it. The hosted tier sells convenience, not secrecy.

**The same honesty, applied to material we are legally required to preserve.** If we ever have to
preserve content under a legal obligation (`ABUSE-AND-NCMEC.md`, `PRESERVATION-PATH.md`), it goes to
a separate store that no part of the running service can reach. We are still technically capable of
**administering** that store: the credentials that let us build and operate the platform also let us
change its configuration, including removing the protection that prevents preserved material being
deleted. **We have demonstrated that capability to ourselves deliberately, so this sentence is a
measurement rather than a guess.** What limits it is a written rule, an audit trail, and a small
named set of people, not a technical impossibility, and we would rather say so than let the word
"locked" do work it cannot do.

**What IS settled: no part of the running service can reach that store.** There is no binding from
any of our code to it, which is an absent mechanism rather than a promise about one.

**What is NOT settled: whether a person holding an operator credential could read preserved
material.** We have not proven the comfortable answer. The first test we ran was invalid and **we
retracted it rather than counting it.** Until it is settled, assume the capability exists.

**Why the capability exists at all**, since a disclosure without a reason is just a warning: running
a multi-tenant platform means holding credentials that can create and administer per-tenant storage
on demand, and preservation duties under 18 U.S.C. 2258A require us to keep material that a tenant
cannot be allowed to delete. Those two facts together are the whole of it.

**And the exit is the same one:** self-host, and no platform operator is in your custody chain at
all. That is not us being generous; it is the AGPL and the parity commitment making the alternative
real. (It removes **us**. Anyone wiring their own GPU provider, cloud AI endpoint, or third-party
storage still has those parties in their own chain, under their own contracts.)

### 2.3 Operator support access: held, used on a report, recorded (RULED 2026-07-27)

Support is part of a hosted product. Tenants will expect us to fix things, and fixing things
sometimes requires an operator to reach into a tenant studio. That capability is inherent to
hosting, not a defect in it, so this section discloses it rather than minimizing it.

- **What an operator can reach.** An operator credential reaches what the platform holds: the
  control-plane records of Section 1.1 (account, tenant, quota, and billing/credit rows) and a
  tenant studio's data plane of Section 1.2 (its database and its file storage). It does not
  reach the tenant's own RunPod account (Section 4.3), and it can never reach a self-hosted
  instance.
- **When it is used.** Only on the triggers already stated in Section 2.2: to run or repair the
  service, at the tenant's request, where the law compels us, or acting on an abuse report.
  Operator access is not routine, and nobody browses. This is the same shape as the CSAM
  enforcement posture (`ABUSE-AND-NCMEC.md` Section 2): capability held, exercised on a report,
  never proactively.
- **What is recorded.** Routine support access is made with a named credential tied to one
  operator. Any access that reaches into a specific tenant, including viewing a tenant's
  rendered output, writes a durable audit record: which operator, authenticated by the
  credential rather than typed in on the honor system; what was done; which tenant; and when.
  Reads of our own fleet-level inventory (a tenant count, our own storage bill, a provider
  reconciliation) do not reach into any one tenant's material and are not individually
  recorded. Credentials are revocable one at a time.
- **The operator must also STATE which of the four triggers the access is made under, and that
  part is asserted rather than verified.** The record carries one of `run_or_repair`,
  `tenant_request`, `legal_compulsion` or `abuse_report`, chosen by the operator at the moment
  of access. It is required: an access with no trigger, or one naming something outside those
  four, is refused rather than recorded with a default, because a defaulted reason is a
  fabricated one on a record whose whole purpose is accountability. The break-glass credential
  is not exempt; a trigger describes the access, not the credential making it, and an emergency
  still has a reason.

  **We can authenticate who; we cannot authenticate why**, and we will not imply otherwise. The
  identity on that record is proven by the credential. The stated reason is the operator's word,
  stored in a column named `trigger_asserted` so that nobody reading this table later mistakes
  it for a verified fact. What makes it worth recording anyway is that it is checkable after the
  event: a stated `abuse_report` can be held against whether a report exists, a pattern of
  `run_or_repair` on a tenant with no incident is visible, and an operator who states a reason
  has put something on the record they can be held to.
- **What scopes do, and what they do not.** Each named credential carries an explicit list of
  scopes and grants nothing outside it. Scopes bound what a credential can DO: a read-only
  credential cannot tear a studio down. They are a blast-radius control, not a privacy
  boundary, and we will not pretend a scope limits what an operator could see; what bounds
  seeing is the behavior commitment above and the record.
- **One break-glass credential exists, and it is the exception to attribution.** A single
  shared root credential survives for emergencies, and it is the only credential that can
  create or revoke operator credentials (a scoped credential that could mint credentials would
  hold every scope at one remove). Its use is recorded like any other access, but it is
  attributed to the credential, not a person. It is not used for routine support, and its
  appearance in the audit trail is an event to review, never noise.
- **Why the record is the point.** "We hold access we do not routinely use" is checkable only if
  use leaves a mark. Expected volume is near zero, which makes the audit trail cheap to keep and
  makes any growth in it a signal to review, not noise to file.
- **The assured alternative is self-hosting.** Total isolation from an operator is not
  achievable on somebody else's infrastructure, under any operator, and we will not pretend
  otherwise for ours. Self-host, at full parity, is where zero-operator-access is real, and we
  point at it rather than bury it.

**This subsection is a constraint on the build, not a description of today** (the same rule as
Section 3). As of this draft the plane holds ONE shared admin token with no scope dimension, and
the money audit records `operator_claimed`: a name asserted, never authenticated. The named,
scoped, individually revocable credentials and authenticated audit rows described above are
cp#219. **This text must not enter force, and hosted signups must not open, before that
capability is live**, or the recording claim above is false on its first day. The break-glass
credential is disclosed above because it survives cp#219 by design; if its role ever widens
beyond emergencies and credential management, this section is false and changes in the same PR.

---

## 3. Key custody, and the claim it puts on the build

The onboarding copy tells tenants that the provisioning key is used once and never stored. That
claim is only true if the code makes it true, so it is written here as a **constraint on the
implementation**, not a description of it.

The design of record (from the #40 spike and the #60 probes) is **two-key custody**:

| Key | Shape | Where it lives |
|---|---|---|
| **Provisioning key** | Restricted key, `api.runpod.io/graphql` = **Read/Write**, `api.runpod.ai` (invoke) = **None**. Fully provisioning-capable, and account-wide powerful (it can create pods; RunPod says so plainly). | **Held transiently, in memory, for the length of the provision job. Never written to control-plane D1, never to a tenant secret, never to a log, never to a provision-job record.** |
| **Stored runtime key** | Restricted key, invoke-scoped to exactly the tenant's 4 endpoints. Verified in the #60 probes: 403 on out-of-scope endpoints, 401 on `PATCH workersMax` even for its own endpoint. | Stored as a secret **on the tenant's own dispatched studio Worker**, the same place a self-host operator puts it. Never in shared storage. |

**What the privacy text is allowed to claim, and nothing more:**

- ALLOWED: "the key you paste to provision is used once, held only in memory for the length of the
  job, and is never stored."
- ALLOWED: "what your studio stores is a restricted key that can only invoke your own four
  endpoints."
- **NOT ALLOWED** unless and until the code does it: any claim that we mint, rotate, or manage keys
  on the tenant's behalf.

**Mechanism: RESOLVED (ruled and built, 2026-07-17).** The custody design below is two-phase, and
it lands in the direction this document was written to assume, so the claims above stand unchanged:

- The **provisioning key is transient and never stored**, as stated.
- The tenant **hand-mints the second key** in the RunPod console after provisioning, invoke-only and
  scoped to exactly their 4 endpoints, and pastes it. The provisioner does not mint it.
- The provisioner **live scope-verifies** that stored key before go-live, rather than trusting the
  paste. A key that is not correctly scoped does not reach a live studio.
- An **account-wide invoke key is rejected outright.** The stored secret is narrow or it is refused.

**Why the second paste exists (the dated finding, preserved).** #60 established that RunPod API keys
are **console-minted only**: no API path to create keys, key mutations undocumented, GraphQL
introspection disabled. The provisioner therefore *cannot* mint the stored endpoint-scoped key
itself. The hand-paste is not friction we failed to remove; it is the price of the custody boundary,
and the honest onboarding copy (#58) says so.

**The standing constraint, which does not expire with this resolution.** The claims in this section
are a constraint on the build, not a description of it. **If the stored key ever becomes the
provisioning key, or an account-wide key is ever accepted, the privacy text above is false and has to
change in the same PR that changes the code.**

---

## 4. Who else touches hosted data

### 4.1 Cloudflare (our sub-processor, for hosted)
Workers, D1, R2, AI Gateway, Rate Limiting. For self-hosting this is the operator's own account and
we are not in it. **For hosted tenants it is our account**, so Cloudflare processes tenant data on
our instruction and is our sub-processor. Counsel item: whether a Cloudflare DPA needs to be in
place and executed before launch (T1-4).

### 4.2 AI providers reached through our AI Gateway (our sub-processors)
Storyboard planning and chat route through **our** Cloudflare AI Gateway on **our** unified billing
(spec section 6), with a per-tenant run token for attribution. Because we hold the provider
relationship, those providers are **our** sub-processors for hosted tenants, and they must be named
in the policy. This is a real change: on self-host, these are the operator's own provider
relationships.

### 4.3 RunPod (the tenant's own provider, NOT our sub-processor)
This is the unusual and good part of tier 1, and the policy should say it plainly:

- The 4 GPU endpoints are created **on the tenant's own RunPod account**, with the tenant's key, at
  the tenant's instruction, and billed to the tenant.
- **The contract is between the tenant and RunPod.** RunPod's terms and acceptable-use policy bind
  the tenant directly. We are not a party to it and cannot act on their account.
- During a render, the tenant's content **moves from our R2 to their RunPod endpoints** (the
  backend pulls the bundle using bucket-scoped credentials placed on their templates). We facilitate
  that transfer **on the tenant's instruction**; the destination is infrastructure the tenant owns
  and controls.
- For modules whose RunPod-side code calls external AI providers (i2v, cast), those calls originate
  from the **tenant's** RunPod account under the tenant's own keys. Those are the tenant's provider
  relationships, not ours.

Counsel item: whether "the tenant's own account, at their instruction" is the right
characterization of that R2-to-RunPod transfer, or whether it makes RunPod our sub-processor
anyway (T1-3).

### 4.4 postern (magic-link email)
Signup magic links are sent through our own mail infrastructure. Email addresses are handled by us,
not a third-party email vendor.

---

## 5. Retention

| Data | Retention |
|---|---|
| Tenant studio content | While the account exists. Deleted on tenant-initiated delete or termination, with an export offer first (D1 `/export` + R2; #58 owns the story). |
| Account record | While the account exists, plus a short tail after deletion. |
| **AUP acceptance records** | **Retained after account deletion.** They are the evidence of what was agreed and are useless if deleted with the account. Retention should be set to a defensible limitations-period tail rather than "forever"; **counsel sets the number** (T1-5). The IP and user-agent fields are the privacy-sensitive part and should age out earlier than the acceptance fact itself. |
| Provision job records | Short. They exist to make a failed provision resumable and debuggable. |
| CSAM-related preservation | **1 year** from CyberTipline submission, per 18 U.S.C. 2258A(h), on a segregated path (`PRESERVATION-PATH.md`; posture in `ABUSE-AND-NCMEC.md`, procedure in `ABUSE-RESPONSE-RUNBOOK.md`). The year is the **floor** of the duty, not an expiry: preserving longer is permitted (2258A(h)(5)) and destruction happens on a law enforcement request (2258B(c)), never on a timer of ours. This overrides deletion requests. |
| Operational logs | As today: render-state, not creative payload, on our own Loki, up to 90 days. |
| **Operator-access audit records** (Section 2.3) | **A record class of its own, retained deliberately.** Each row carries the authenticated operator, what was done, which tenant, when, and the operator's STATED trigger (asserted, never verified). It is NOT an operational log and does not age out on the 90-day operational tier above: it exists to make "we hold access we do not routinely use" checkable after the fact, so it must outlive the dispute, complaint, or access request that would test it, and near-zero volume makes long retention cheap (Section 2.3's own argument). Because each row names an identified operator and an identified tenant, its retention period is itself a privacy commitment: **counsel sets the number** (T1-14), the same precedent as AUP acceptance records (T1-5). |

**Deletion has a limit and the policy must say so:** an AUP acceptance record, and anything under a
legal preservation obligation, survives an account deletion request. Promising unconditional
deletion would be false.

**And deletion reaches only what WE hold, which is a second limit and just as real.** Tearing down a
hosted studio destroys our side: the studio worker, the tenant database, the tenant bucket and its
credential. **It does not touch the tenant's own RunPod account**, where the GPU endpoints we
provisioned, **and the templates underneath them**, both survive. Measured, not assumed (cp#117
rehearsal, 2026-07-25): a clean teardown left four endpoints and four templates standing, because
the plane holds no credential that can delete them by design (key A is used once and never stored,
key B is a restricted invoke key).

> **This must be said to the customer, not just to us.** A user who reads "your studio was deleted"
> and believes that covers everything is wrong about resources sitting in **their own** provider
> account, accruing **their own** costs, under **their own** contract. The honest version tells them
> what survives and what to delete: **endpoints AND templates**, because guidance that says only
> "delete the endpoints" leaves half of it and reads as complete.

---

## 6. The EU question, which is a decision and not a detail

[`vivijure-cf docs/legal/PRIVACY.md`](https://github.com/skyphusion-labs/vivijure-cf/blob/main/docs/legal/PRIVACY.md) currently says Conrad determined GDPR does not apply, because the instance is run
from the United States for himself and the crew and is **not offered to the public**. **Opening
public signups removes the reasoning that sentence rests on.**

If EU residents can sign up, the hosted studio is plausibly "offering services to data subjects in
the Union" (GDPR Art 3(2)), which pulls in controller obligations, lawful basis, data-subject
rights, an Art 27 EU representative, and processor terms. Separately and more urgently, the **EU AI
Act** has a live date (see `COUNSEL-REVIEW-CHECKLIST.md`, T1-1).

**This is a fork in the road, not a paragraph to write:**

- **Option A: geo-block the EU at launch.** Cheap, honest, reversible, and it makes the question go
  away until someone wants it answered. It is a real product cost.
- **Option B: take on EU compliance.** Needs counsel, an Art 27 representative, and the AI Act
  analysis resolved first.

**Conrad decides, informed by counsel. This document does not decide it, and the launch must not
default into Option B by simply not thinking about it.**

---

## 7. The exact edits the in-force documents need AT LAUNCH

Specified here so the launch-gate flip is mechanical rather than a rewrite under time pressure.
**None of these may land before the hosted studio actually opens.**

### `vivijure-cf docs/legal/PRIVACY.md`
| Location | Current text | Required change |
|---|---|---|
| BLUF | "there is no Vivijure service that we operate to hold your content" | Rewrite. Now there is one. Keep the self-host promise intact and clearly separated. |
| BLUF | "Skyphusion Labs does not run a hosted, multi-tenant, sign-up service." | **Delete.** This becomes the opposite of true. |
| BLUF | "Skyphusion Labs runs exactly two Vivijure instances, and only two." | Rewrite: the private instance, the demo, **and the hosted platform**. |
| Section 1 | "Vivijure runs in exactly one shape: somebody self-hosts it." | Rewrite: two shapes, self-host and hosted. Add a hosted row to the mode table. |
| Section 2 | "single-operator by design ... no multi-tenant model" | Keep, but explain the hosted architecture honestly: still single-operator **per tenant studio**; multi-tenancy is instance-per-tenant, not per-user rows. This is a strength and reads as one. |
| Section 4 | token-mode gate framing | Add the control-plane account layer (SSO + magic-link) sitting in front of the per-tenant studio token. |
| Section 5 | processors | Add: for hosted, Cloudflare is **our** sub-processor and the AI Gateway providers are ours; RunPod is the **tenant's** own provider (Section 4.3 here). |
| Section 6 | "the operator (Conrad) has determined that it does not fall under the GDPR ... not offered to the public" | **Must change or the EU must be blocked.** See Section 6 above. |
| Section 7 | retention | Add the hosted table from Section 5 above, including the acceptance-record and preservation carve-outs. **Also add the custody-boundary limit on deletion** (Section 5 above): deleting a hosted studio destroys what we hold and does **not** reach the tenant's own RunPod endpoints or the templates underneath them, which survive on their account under their contract. Say what to delete (**both** classes) rather than leaving a user to discover it on an invoice. |
| Section 9 | children | Add: on the hosted surface, reporting is a statutory duty under 2258A, not only a moral one. |
| Section 2 or 7 (new) | nothing today | **ADD the operator-capability disclosure**, per Conrad's ruling 2026-07-25 (disclosure, not technical pretense). This is the row that **executes** the ruling: Section 2.2 above and `PRESERVATION-PATH.md` Section 4.3 are internal documents, and **a disclosure that never reaches a signed-up human is documentation, not notification.** The customer-facing text must carry, in plain words: (1) preserved material goes to a separate store the running service cannot reach; (2) we remain technically able to **administer** that store, including removing the deletion-protection, and that is **measured**, not theoretical; (3) whether an operator credential can **read** preserved material is unsettled and we are not claiming it cannot; (4) **why** the capability exists (multi-tenant provisioning needs account-scoped storage rights; 2258A requires preserving material a tenant must not be able to delete); (5) what limits it (a written rule, an audit trail, a small named set of people, not a technical barrier); and (6) **self-hosting as a first-class alternative, not a footnote** -- self-host and no platform operator is in your custody chain at all, which is credible because the studio and the control plane are both AGPL and the control plane is not needed to self-host. Scope (6) honestly: it removes **us**, not every third party the self-hoster chooses to wire. |
| Section 2 or 7 (new) | nothing today | **ADD the operator support-access and audit disclosure** (Section 2.3 here): what an operator credential reaches, the four access triggers AND the requirement that the operator STATE which one applies (asserted, never verified), the named per-operator scoped credential, the authenticated audit record written on every access that reaches into a specific tenant, the break-glass exception to attribution, per-credential revocation, and self-hosting as the zero-operator-access alternative. **Blocked on cp#219 being live**: shipping this text ahead of the capability makes it false. |

### `vivijure-cf docs/legal/TERMS.md`
| Location | Current text | Required change |
|---|---|---|
| BLUF | "These Terms are **not a hosted-service agreement**" | **Inverted.** The hosted studio needs actual service terms. Counsel item T1-6. |
| Section 1 | "Skyphusion Labs does not host or manage Vivijure instances for other people and will not get into that business." | **Delete.** We got into that business. |
| Section 8 | liability capped at $0 because the software is free | Revisit. Tier 1 is free, so the reasoning survives tier 1, but it does not survive tier 2 and counsel should look at it now (T2-3). |
| Section 10 | "the project is not an online hosting provider and there is no provider takedown role here" | **False at launch.** We will host content at the direction of users. This is the DMCA agent item (T1-2). |
| Section 11 | termination | Add the hosted levers: suspend, terminate, and the honest limit that we cannot touch their RunPod account. |

### `vivijure docs/legal/ACCEPTABLE-USE.md` (hub-canonical) and `vivijure-cf docs/legal/README.md`
Both state that Skyphusion Labs does not host instances for other people. Update the framing and
index the hosted AUP.

### The canonical hub AUP (`skyphusion-labs/vivijure`, `docs/legal/ACCEPTABLE-USE.md`)
Its BLUF says "Vivijure is self-hosted AGPL software, not a service Skyphusion Labs operates for the
public" and "Skyphusion Labs maintains the software and does not host or manage instances for other
people. There is no central platform here." **Both become false at launch, in a different
repository.** This is a cross-repo launch-gate item and it is easy to miss precisely because it is
not in this repo.
