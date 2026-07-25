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

### The served surfaces are ENUMERATED, not grepped

**A phrase list is always one phrasing behind whoever writes the next page** (Joan's point on
cp#130, and she is right). The greps above hunt for sentences somebody already thought of; the next
true-sounding sentence nobody enumerated passes clean. A served page that says "has not opened to
signups yet" is caught only because that phrase is now listed, which is luck dressed as process.

**So served surfaces are censused by WALKING THE LIST, not by matching text.** The set is bounded
and knowable, which is exactly what the phrase families are not:

1. **List every served page** in each repository (`public/*.html` in the control plane and in
   `vivijure-cf`, plus anything else the front door or a tenant studio serves).
2. **Read each one, in full, at launch.** Not grep it. Read it.
3. **Each page is then either (a) edited, or (b) deliberately retained with a recorded reason.**
   Same disposition rule as a doc hit, and the same failure condition: a page that is neither is a
   false public statement.
4. **A page added since the last census is a census failure until it has been read**, whatever it
   says. New surfaces are how this gate gets bypassed without anyone deciding to bypass it.

**A served page is a public statement in exactly the way a policy file is**, and it is the one a
stranger actually reads. A census that reads only the repository docs has not read what we published.

#### The directory IS the served set: VERIFIED 2026-07-25, not assumed

Step 1 says "list every served page", which is written as a **directory** walk while the thing that
matters is the **served** set. Those are equal only if nothing is reachable that is not a file, and
that was an assumption until Joan checked it against the routing (cp#130 review). Re-derived here
before recording, because it is about to be relied on:

| Fact | Where |
|---|---|
| Both workers end their router in `env.ASSETS.fetch(request)`, after the `/api/*` gate | control plane `src/index.ts`, vivijure-cf `src/index.ts` |
| Both bind `assets = { directory = "./public", ... }` | both `wrangler.toml.example` |
| Neither worker synthesises an HTML body (content-type checks only, no HTML responses) | grep, both repos |

**So every file under `public/` is reachable unauthenticated at its literal path, and nothing
outside `public/` is served as a page.** Recorded as a dated equivalence rather than a standing
truth: **re-verify it whenever either router's tail or either `assets` binding changes.**

#### There are TWO bundles and they are different sets

| Bundle | What it is | Size at 2026-07-25 |
|---|---|---|
| control plane `public/` | the hosted front door | 19 files, 3 HTML (`index`, `onboarding`, `report-abuse`) |
| vivijure-cf `public/` | the studio, which also ships to every self-hoster | 51 files, 4 HTML (`planner`, `cast`, `modules`, `settings`) |

**A census that says "the served pages" without naming the worker will silently cover one and miss
the other**, and the studio is the larger surface. Walk both, name both in the output.

#### If a census step checks a URL, it goes through the MAP, never a guess

The two bundles handle pretty URLs **differently and deliberately**:

- **vivijure-cf pins `html_handling = "none"`** (exact paths only, to avoid a redirect loop) and maps
  pretty URLs itself in `STUDIO_PAGE_ASSETS`: **ten URLs onto four files.** Note `/` and
  `/index.html` both serve `modules.html`, and **in DEMO mode `/` remaps to `planner.html`**, so the
  same URL serves a different page by config.
- **the control plane leaves `html_handling` at the default** on purpose, so it gets platform
  pretty-URL behaviour on top of its file set.

**Census by FILE, which is what step 1 says, is the right unit and none of this affects it.** But a
step that verifies a URL must resolve it through `STUDIO_PAGE_ASSETS` (and the demo remap), because
checking `/planner` proves nothing about `/planner/` and checking `/` proves nothing about what `/`
serves in the other mode.

#### Two things we serve that are NOT files in either bundle

The inverse of the hole above: a walk of both directories will never see these, and "we read every
served page" reads as covering them.

**1. The AUP text, and it is the most legally load-bearing text we serve.** `AUP_URL` is an
**external** pinned repository permalink; the onboarding page fetches it and renders it into the
signup gate. The words a user actually accepts live in **neither bundle**. **CLAIMED by this
census**, with a concrete step rather than a reminder to be careful:

- `AUP_URL` resolves to an **immutable ref** (a tag or commit SHA, never a branch). A branch means
  the text a tenant reads changes whenever the branch does while the recorded version label does
  not, and nothing detects the drift.
- The version it serves matches the pinned `AUP_VERSION`.
- **Record the SHA-256 of the served bytes.** The plane already computes it (`fetchAupSha256`), so
  this is a value to read and record, not a thing to build.

**2. `/welcome` on the studio, which 301s to `https://vivijure.com/`.** Our surface actively sends
people to a **fourth property**, in a different repository, on a different deploy, that this
procedure's scope line ("all three repositories") does not reach.

> **EXPLICITLY DISCLAIMED, and named rather than quietly omitted.** This census does **not** cover
> the `vivijure.com` storefront. That is a scope statement, not a finding that it is fine: a
> marketing site is exactly where pre-launch claims live ("coming soon", "not yet available"), and
> ours is one 301 away from a page we do census. **Whether the storefront joins this procedure is
> the launch owner's call**, and it should be made deliberately before launch rather than discovered
> after. Flagged for Conrad and the lead.

Known surfaces at the time of writing, listed as a starting point and **not as the whole set** (the
walk in step 1 is authoritative, because this table ages):

| Surface | What to check |
|---|---|
| `public/report-abuse.html` (control plane) | Says signups have not opened; makes process commitments; states the 2258A reporting position. Must stay identical in substance to `REPORT-ABUSE.md`, its source of truth. It also carries a **literal tenant hostname** (`*.studio.vivijure.com`) that the plane reads from config, deliberately, so a reader recognises the shape: a suffix change makes this page wrong and this row is what catches it. |
| `public/index.html`, `public/onboarding.html` footers | Carry the intake link; a dead link here is worse than no link. |
| The tenant studio panel intake link (vivijure-cf) | Hosted-only by construction. Verify it renders on a hosted tenant and **does not** render in a self-hosted install, because a self-hoster advertising our abuse address is a false statement about who can act. **This row is a NEGATIVE check**; passing it means seeing nothing, which is easy to score backwards under time pressure. **An absent link has TWO causes and they look identical:** (a) the var is unset, which is the pass; (b) the studio bundle is too old to read the var at all, which is a **silent no-op** and is worse than a failure, because a hosted tenant is then showing no intake path while the census records green. **On a self-host install (a) is the only possible cause, so that check is unambiguous. On a hosted tenant it is not**, and the row needs a positive discriminator: proof that this bundle can read the var (the same bundle rendering the link when the var IS set, or the field's presence in the panel's own projection). Joan identified `GET /api/modules` as a way to discriminate without a render; **confirm the exact request and the two expected shapes against the shipped panel at census time rather than trusting this sentence.** |

**Parked, deliberately, and not built here:** a machine-checkable status declaration on every
user-facing page (a meta tag or data attribute the census asserts on) would beat both the phrase
list and the human walk. It is the right long-term answer and it is a build, not a doc edit. Filed
rather than smuggled into a documentation change.

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
