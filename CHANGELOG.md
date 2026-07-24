# Changelog

All notable changes to the Vivijure control plane. Versions are SemVer; a `v*` tag on this
repository deploys the control plane (a `v*` tag in `vivijure-cf` deploys the Studio panel, which
is a separate product on a separate cadence).

## Unreleased

### fix(test): live provision e2e drives the step machine the way production does (#4)

- The suite generates its own **ephemeral KEK**; `STUDIO_TOKEN_KEK` is off the required-env list.
  It round-trips in-process over a `MemoryStore` tenant, so the live worker KEK was never needed and
  admitting it would only widen that credential's custody into CI. This was #4's recorded blocker
  and it was a premise error.
- The suite now **resumes on a budget yield** (`runProvisionJob` -> `continueProvisionJob`), matching
  the `deps.ts` start/resume wiring the tenant job poll drives. A real provision yields after
  `wfp_upload` at ~23s under the 15s invocation budget, so the previous single-invocation assertion
  could never pass against real infrastructure.
- `docs/deploy.md` records the KEK recovery search as **exhausted** and the value as unrecoverable
  (worker secrets are write-only), plus the escrow gap and the re-key cost that follow from it.
- **Dispatch door for the suite.** There is no out-of-worker HTTP path into a WfP dispatch namespace
  (`*.workers.dev` TLS covers one label; WfP user Workers are not published there at all), so the
  suite deploys an ephemeral `e2e-harness-dispatcher-<run>` in `beforeAll` and deletes it in
  `afterAll`, verified from the account. It carries a per-run bearer AND a tenant scope baked into
  the deployed artifact, because both namespaces are shared with production tenants. A leftover
  harness fails the run loudly.
- The e2e tenant **id** now carries the run token. Module script names derive from the tenant id, so
  the old fixed `ten_e2e` put every run's module workers at identical names inside a shared
  namespace, and `ten-e2e` could collide with a real hex tenant id beginning `ten_e2e...`.


### fix(hosted): module-upgrade jobs claim a lease and self-heal (#44)

- `setJobRunning` runs synchronously on accept and again at upgrade entry, matching provision.
- The upgrade-route 409 guard keys off a **live lease**, not bare `queued`/`running` status, so a
  dead driver no longer wedges every future upgrade for that tenant.
- `jobHasLiveDriver` exported from `store.ts` (same expired-or-absent lease reads as free).

## v1.4.3 -- 2026-07-23

PATCH. K3 stale-job clock fix (#79).

- **fix(security):** use `deps.now()` for stale-job detection instead of `Date.now()` (K3 verify)

## v1.4.2 -- 2026-07-22

PATCH. SSO redirect harden + audit CI.

- **fix(security):** reject SSO `redirect_to` backslash / protocol-relative open redirect (#76)
- **docs:** clarify studio PIN is studio-only; module bundles are self-anchored (cf#147)
- **ci:** adversarial security audit workflow

## v1.4.1 -- 2026-07-22

PATCH. Provisioner rollback on failed provision (cf#91).

### fix(provisioner) -- auto-teardown on failed provision (cf#91)

- Failed provisions auto-unwind created resources (re-fetch tenant row, then `teardownTenant`).
- R2 token revoke falls back to deterministic name (`vivijure-tenant-<slug>-r2`) via a
  result_info-checked token census when the id was never persisted.
- Persist `r2_token_id` immediately after mint (before hashing the secret value).

## v1.4.0 -- 2026-07-19

MINOR. The demo-hardening batch: everything merged after the v1.3.1 outage fix, shipped together
because control-plane deploy is tag-only. This is the release that makes tonight's work LIVE -- until
it deploys, the site still serves the pre-batch behavior (the cold-401 intro and the live-tenant 503
below).

### Availability: the tenant job poll drives PROVISION jobs only (#56)

A tenant polling its own job page during an admin module upgrade could win the job claim and be driven
through `continueProvisionJob`, whose success path writes `awaiting_invoke_key` -- taking a LIVE tenant
non-routable (503) on the branch where the upgrade SUCCEEDS. The poll now refuses to drive any job kind
it does not own; it still reports the job. Guard placed before the stale-job branch, which also closed
a second `setTenantStatus("failed")` instance of the same class.

### Onboarding: the signed-out intro renders without a 401 (#67)

The intro eagerly fetched the session-gated `/api/tenant/provision-plan`, so every unauthenticated
visitor -- i.e. everyone on a cold visit, and everyone while signups are closed -- saw a red "Could not
load the setup plan: unauthorized" and a spinner that never resolved. That is exactly the first screen
an outside evaluator sees. The intro now renders a clearly-labelled representative example with no
network call; the real numbers are fetched behind the sign-in for the Review step.

### Operator + client surfaces

- `modules_release` and the job row are readable (#43, #57): the release pair projects on the tenant
  view and `GET /api/tenant/:id/job` reports `kind`, `from_release`, `to_release`, `finished_at`. The
  answer to "what version is this tenant on?" now exists over the API instead of only in prod D1.
- The invoke-key 202 emits structured facts, not just prose (#27, #59): a `readiness` object a client
  can compose from, with the four load-bearing claims (installed, stored, retry, do-not-re-paste) as
  assertable fields rather than substring greps. `message` retained for one release.

### The onboarding transport seam is testable (#31, #58)

`onboarding.js` no longer owns any transport; the request-building code lives once in
`onboarding-api.js` behind one seam, replacing a mirror that asserted a copy of the code rather than the
code. A tripwire fails if `onboarding.js` ever regrows a fetch.

### Deploy safety (both first exercised by THIS release)

- Post-deploy human-surface smoke check (#63, #64): the release run now asserts the human-visited front
  door actually renders (200 AND text/html AND a real front-door body), turning the v1.3.1 outage class
  into a red run in seconds instead of days of green silence.
- Tag-deploy ancestry guard (#62, fc#859): the release job refuses to deploy a commit that is not on
  `main`, closing the `git tag v9.9.9 <unmerged-commit>` bypass around branch protection.

## v1.3.1 -- 2026-07-19

PATCH, and an outage fix. **The hosted control plane had served no human-visitable page since
v1.3.0.** `/` and every HTML, CSS and JS path returned 500 while every JSON route returned 200, so
the plane looked healthy to every check anyone was running.

### The ASSETS binding was never created (#60)

`assets` is a **bare TOML key**, so it binds to whatever table header precedes it. The
`[observability]` table added in v1.3.0 landed above it, and the line was silently parsed as
`observability.assets`. The top-level ASSETS binding therefore did not exist, and
`env.ASSETS.fetch(request)` at the end of `src/index.ts` threw on undefined for every asset path.

wrangler's only protest was a warning that is easy to scroll past:

```
Unexpected fields found in observability field: "assets"
```

The fix is a **move**: bare top-level keys go above the first table header. The comment now records
that the position is load-bearing, because the line reads as equally correct in either place, which
is precisely why it shipped.

### The gap that let it ship is closed too

Every render guard asked *"did the render succeed?"*. None asked *"is the result the config we
meant?"* -- and a render can succeed while binding nothing. `tests/render-wrangler.test.sh` now
parses the rendered TOML and asserts a top-level `assets` key, `binding == "ASSETS"`,
`run_worker_first`, and the absence of a stray key under `[observability]`.

The guard was watched **red** before being trusted: a negative control regenerates the exact broken
shape and requires the assertion to fail against it. Its output is captured rather than printed,
because a deliberate `FAIL` line in CI teaches people to ignore real ones.

This is the second config-shape defect on this file the unit suite could not see; `run_worker_first`
was the first, on 2026-07-17. The suite never loads the asset layer.

**Still open:** nothing verifies at deploy time that a human-visited path returns 200. `/ready` does
not cover it. That check is what would have caught this in minutes instead of days.

## v1.3.0 -- 2026-07-19

MINOR: an operator can finally watch a hosted tenant actually render, the plane gets a diagnostic
surface, and a provision records where its time goes (cp#45, cp#18, cp#43).

### Operator verification route (cp#45)

Until now the release standard -- **nothing is verified until someone has looked at the actual output**
-- was not performable for a hosted tenant by anyone without the control-plane KEK. The tenant studio
serves its root publicly but gates every API path, and the only credential that can drive it is
encrypted in D1 and decryptable only inside the worker. Every hosted module release to date rested on
install-and-probe evidence, never on observed output.

- **Three admin routes**: open a canonical smoke render, drive it, and **stream the artifact bytes back
  through the plane** so an operator can actually look at them. The third one is the point; returning an
  R2 key to someone who by construction cannot reach the tenant would be `phase=done` wearing a hat.
- **No credential leaves the worker.** The studio token is decrypted per call, used, and dropped. It
  never crosses the interface, never reaches the store, never reaches a response. The client is **four
  typed calls with constant paths**, deliberately NOT a generic "dispatch this path to that tenant"
  helper, which would have been a permanent operator proxy into every customer studio.
- **Spend guard is part of the build, not a follow-up**, because this route costs GPU by definition.
  The payload is canonical (tenant id and nothing else, so it cannot be turned into a film), plus a
  per-tenant cooldown, a platform-wide daily cap, and one render in flight per tenant. Guards live in
  the `WHERE` of a single conditional INSERT: the WRITE authorizes, the read only explains.
- **What it does NOT bound, stated plainly**: dollars (it bounds invocations, and a cold GPU costs more
  than a warm one), a tenant's own rendering, a job already handed to RunPod, or an operator who simply
  waits out the cooldown.
- Rendering through a non-tenant door remains rejected. It would produce a satisfying artifact that
  answers a different question.

### Per-step provision timing (cp#18)

- Every `mark()` now logs `provision.step` with **`stepMs` (that step alone)**, cumulative `elapsedMs`,
  and the driver phase. Previously timing was recorded ONLY on yield, so a provision that SUCCEEDED
  produced no timing anywhere, and D1 never held it either (`steps_done` carries step names, and
  `updated_at` is overwritten on every write).
- **Additive only**: the budget logic and yield boundary are untouched, and the instrument deliberately
  does not perturb what it measures. It reuses the timestamp the log line already read rather than
  calling the clock twice, and the log lands BEFORE the budget throw so the step that triggers a yield
  is not the one measurement that goes missing.
- `stepMs` is mark-to-mark and therefore includes the previous step's progress write, because the
  invocation budget is consumed by everything on the wall clock. The first step additionally carries
  unmarked precondition work; read it as "everything up to and including this step".

### Observability

- **Workers Logs enabled on the control plane**, which had no observability surface at all.
- Tenant telemetry design recorded in `docs/tenant-telemetry.md`: operational fields only, with the
  content-carrying fields excluded and a written per-field disposition. Design only; nothing is wired.

### Docs

- Backfilled the missing v1.2.0 and v1.2.1 entries, including the fact that v1.2.0's headline route
  shipped non-functional.

## v1.2.1 -- 2026-07-19

PATCH: the module-upgrade route could not insert its job, so the feature v1.2.0 had just shipped could
not succeed for any input at all (cf#103).

- **`createModuleUpgradeJob` wrote bare words where it needed string literals**:
  `VALUES (?1, ?2, module_upgrade, queued, ?3, ?4)`. SQLite parses a bare word in `VALUES` as a COLUMN
  REFERENCE, so every call threw `SQLITE_ERROR` and the route answered `500` for every tenant and every
  release. Fixed by quoting them. The correct pattern (`?3` bound, `'queued'` quoted) sat 17 lines above
  in `createProvisionJob`.
- **468 green tests could not have caught it.** Every test in the repo builds a hand-written
  `MemoryStore`, so no test ever handed a `store-d1.ts` SQL string to a SQL engine. Every literal, column
  name, and clause in that file was unverified by construction.
- **`tests/store-d1-sql.test.ts` (new)** drives the REAL `D1Store` against real SQLite built from the
  real `migrations/`, and reads results back through SQL rather than trusting `RETURNING`. Two controls
  (`createProvisionJob`, `getTenantBySlug`) prove the harness discriminates.
- Found by a live rehearsal on the first real call, after unit tests, code review, and a production
  deploy all passed. Standing consequence recorded: **a store or SQL layer exercised only through a fake
  is UNTESTED**, and only a live run against real infrastructure says otherwise.

## v1.2.0 -- 2026-07-18

MINOR: module upgrade for live tenants, and the slug-reclaim lane (cf#103, control-plane#18).

**Correction, recorded rather than quietly fixed:** the module-upgrade route below shipped
NON-FUNCTIONAL in this version and could not succeed for any input. See v1.2.1. The slug-reclaim work in
this release was unaffected and did work as described.

### Module upgrade

- **Ship a new module release to a LIVE tenant without taking it down.** The tenant keeps serving
  throughout; the upgrade runs as a job with progress recorded per step.

### Slug reclaim

- **Tier A slug reclaim executes**, so a slug held by a tenant that never went live can be freed and
  re-provisioned by its owner without operator SQL.
- **Slug lease tiers with the WRITE as the enforcement point, not the check.** The check is never the
  gate; a conditional write is. This is the pattern the rest of the lifecycle now follows.
- **Reclaim is serialized on a lease** so two concurrent attempts cannot destroy each other, and a
  reclaim is REFUSED while a provision driver holds the lease. A lease expires, so a dead reclaim
  self-heals rather than stranding the row.
- **Teardown reaps the STORED script name**, not one recomputed from the slug.
- Live teardown rehearsal run against real Cloudflare rather than against fakes.

### Fixes

- Onboarding names the unproven modules instead of rendering `[object Object]` to the customer.
- The invoke-key contract is read as the route actually serves it, and the summary `ok` field is dropped
  from both invoke-key outcomes (cp#20).
- One slug rule shared by the preview and provision paths, so the two cannot disagree.

## v1.1.1 -- 2026-07-18

PATCH: the readiness probe stops failing customers for a benign propagation delay, and its diagnostic
actually reaches them (control-plane#17). Both defects were found by the cf#114 live verification.

- **A deadline with every module still `not_visible_yet` is now a SOFT outcome**, not a failure. The
  key is installed and the condition self-resolves, so the route answers `202` naming
  `modules_unconfirmed` and telling the caller to retry without re-pasting the key. The tenant is
  **not** promoted, so an unconfirmed module can never be rendered against. Measured cause: a
  first-ever key write to five fresh module scripts exceeded the 10s deadline and passed a minute
  later. The deadline was validated only against a virtual clock, which cannot measure the edge.
- **Every `misconfigured` verdict still fails HARD and immediately** (absent endpoint id, non-200,
  malformed envelope, echo mismatch). The soft path is deliberately narrow; widening it would be the
  laundering this design refuses. Mutation-tested in both directions.
- **`TenantModuleError` now surfaces as `503 modules_not_ready` carrying the real message** (module,
  script, retryability, attempts, elapsed) instead of falling into the top-level catch and reaching
  the caller as a bare `500 internal_error`. cf#114 exists because a misleading error fired at the
  worst possible moment; it shipped with an opaque one at that same moment.
- **Route-level tests asserting what the CALLER receives on every outcome.** This is the actual fix:
  every prior test asserted what the probe threw or returned, and none asserted the response, which
  is exactly how the opaque 500 shipped green.
- No invented lifecycle value: the unconfirmed response reports the tenant's TRUE stored status
  rather than a label no store ever holds.

## v1.1.0 -- 2026-07-18

MINOR: the plane stops promoting a tenant to live on a credential whose propagation nothing has
observed, and finally answers "what is running" (cf#114; vivijure-control-plane#13).

### Module readiness probe

`installInvokeKey` writes key B to the studio and all five module scripts. A `200` from that PUT
means the secret is STORED; it does not mean the version the edge serves can read it. A tenant that
had just reported `live` failed its first render citing a credential that was demonstrably present,
and the identical payload succeeded 45s later (cf#99 finale, run 5).

- **New `TENANT_MODULE_DISPATCH` binding** so the plane can reach tenant module scripts, which carry
  no public route. Typed OPTIONAL: a deploy predating it reports UNVERIFIED, never a false pass.
  **Deploy prerequisite:** the namespace must exist before deploying with the binding present (it is
  created lazily by the provisioner, so a fresh account may not have it yet).
- **`awaitTenantModulesReady`** probes `GET /ready` on all five module scripts after the key-B
  fan-out and BEFORE the tenant flips live. Retryable ONLY on the not-visible-yet shape (endpoint id
  present, key absent); a missing endpoint id, a malformed envelope, or any other status fails
  immediately. A genuinely absent credential fails LOUDLY at the deadline with attempts and elapsed,
  which is what stops the retry from laundering a real misconfiguration into a success. A throw
  leaves the tenant at `awaiting_invoke_key`.
- **Budget-aware (cf#112 / cf#113):** one 10s deadline across ALL FIVE modules, probed concurrently
  per round, because this runs in a route a customer is waiting on. Not five sequential deadlines.
- **A 404 is reported `unverifiable`, not failed and not passed, and the cause is NOT guessed.**
  Hard-failing would mean a tenant on an older pin could no longer install a key at all. But a 404
  means "nothing answered here", which is a stale module image OR a missing script, and those are
  indistinguishable from the control plane; the detail states both rather than asserting the
  flattering one. The invoke-key response carries `modules_ready` / `modules_verified` /
  `modules_unverified`, per module with its script, never collapsed into one summary.
- **The `module` echo is checked** against the module being probed. Script names are tenant-prefixed
  and derived, so without it a naming bug lets a healthy NEIGHBOUR answer and be read as proof about
  the wrong module. A mismatch is a hard failure.

### `GET /api/platform/version`

`CONTROL_PLANE_VERSION` was referenced by nothing at runtime, so confirming which release was live
meant reading a patched line off a fetched asset. Now a one-line answer, from the same constant the
lockstep gate pins to `package.json`. Its own route, not a field on `/api/platform/config`: that one
is a policy projection with a UI contract, and deploy identity does not belong in it.

## v1.0.1 -- 2026-07-18

**Security PATCH.** Closes a polynomial ReDoS (CodeQL `js/polynomial-redos`, high) in the email
sanity check on the login door. Ships minutes behind v1.0.0 because the defect was live in the plane
before the extraction too; v1.0.0 neither introduced nor worsened it.

### The defect

`looksLikeEmail` ran on **unauthenticated** input at the login-start door, and it ran **before** the
rate limiter, so anything quadratic in it was reachable by anyone with no throttle in front of it.
It came across from `vivijure-cf` with the extraction; the extraction is simply what first put a
scanner on it.

Measured rather than assumed. The blow-up needs a FAILING match: a trailing `@` the segment class
cannot consume, which forces backtracking across every split of the repeated run.

| input | before | after |
| --- | --- | --- |
| `"a@" + "b.".repeat(10000) + "@"` | ~90ms | ~1ms |
| `"a@" + "b.".repeat(40000) + "@"` | ~1371ms | ~1ms |
| `"a@" + "b.".repeat(80000) + "@"` | ~5517ms | ~1ms |

Clean quadratic. 5.5 seconds of CPU from one request body is a denial of service on a Worker with a
CPU budget.

### Two fixes, redundant on purpose

- **Ordering.** The 254-character cap was checked AFTER the regex (`RE.test(e) && e.length <= 254`).
  `&&` short-circuits left to right, so the regex ran on UNBOUNDED input and the cap protected
  nothing. Length is checked first now, bounding the work whatever the pattern does. This was a real
  defect on its own, not just scanner appeasement.
- **Ambiguity.** The domain part was `[^\s@]+\.[^\s@]+`, where `[^\s@]` also matches a dot. That
  overlap between the segment class and the separator IS the backtracking. The segment classes now
  exclude the dot, so every character has exactly one role and the match is linear.

### Behaviour change, stated rather than slipped in

The stricter domain rejects consecutive dots (`a@b..c`), which the old pattern accepted. That
address is not deliverable, so rejecting it is correct, and the endpoint answers 202 for every
outcome regardless (it must not become an account-enumeration oracle), so nothing user-visible
moves. Pinned by a test.

### Tests

18 added; there were none. The file records what they can and cannot prove: the regex fix IS
isolated (exercised against `EMAIL_RE` directly, on input the length cap would otherwise reject), but
the ordering fix is NOT independently observable, because with a linear pattern the ordering makes no
difference and the end-to-end timing test only fails if BOTH regress. Said plainly in the test rather
than left to imply a guarantee that does not exist.

### Same class, second site: the AUP tag matcher (#11)

Found by Joan checking her own files after the first finding rather than assuming the scanner had
covered them -- it had passed her earlier PRs without flagging this.

`TAG_RE` in `public/onboarding-checks.js` had a `\d+` followed by a class that also matches digits,
so a long digit run could be split many ways and a failing match cost O(n^2). Measured on
`"v1.1." + "1".repeat(n) + "!"`: doubling n quadrupled the time (2000 -> 1.60ms, 16000 -> 99.55ms).
Fixed by forbidding the tail to start with a digit, which makes the digit run maximal and removes the
ambiguity. Differential-tested over 400k randomized strings: zero behaviour change.

**Severity LOW, and not dressed up.** That input is the ref parsed out of `AUP_URL`, which is
operator-set deploy config, not user input -- nobody reaches it without already controlling the
deploy. It rides this patch because it is the same defect class and the fix is cheap and proven, not
because it is urgent. `SHA_RE` and the slug matcher in the same file measured flat and are untouched.

### The AUP_URL moving-ref guard accepted four branch refs (#12)

Joan drove the REAL render script with a 16-case corpus instead of reading the glob, and found the
guard accepting `/raw/develop/`, `/blob/trunk/`, `/blob/head/` (HEAD was covered, lowercase was not)
and `/blob/Main/` (the glob was case-sensitive). It refused `/main/` and `/master/` correctly, which
is exactly why it read as working.

Each one is a branch ref, and a branch ref as `AUP_URL` means the policy text an account accepted can
change afterwards while the recorded `sha256` still claims to describe it -- the precise failure the
guard exists to prevent. Each case was reproduced as accepted BEFORE the patch, then watched flip to
refused.

This has to ride a tagged release rather than sit on main: `deploy.yml` checks out the TAG, so the
guard only takes effect once tagged.

### CI: the CodeQL language pin never applied (#10)

Not a runtime change, recorded because it explains why two ReDoS defects sat unflagged. The workflow
passed `language` (singular) to `codeql-action/init`, which takes `languages`. Actions does not fail
on an unknown input, so the pin was silently ignored and auto-detection ran instead. It happened to
find MORE than the pin claimed, so there was no coverage gap, no failing check, and nothing to
notice. Now stated correctly, with `actions` and `python` declared alongside
`javascript-typescript` rather than narrowed away.

## v1.0.0 -- 2026-07-18

The hosted control plane becomes its own product, in its own repository, serving from its own
tagged release.

Before this, the control plane lived inside `vivijure-cf` and was deployed by hand. That meant
anyone who wanted to self-host Vivijure Studio carried the machinery for running a hosted service
they had no intention of offering, and it meant the live plane ran an untagged working state rather
than a release. Both are fixed here.

### The extraction

- Extracted from `vivijure-cf` at commit `59b3fb38` (vivijure-cf#85). Pre-extraction history stays
  in `vivijure-cf`; no history was rewritten in either repository. See `NOTICE`.
- `vivijure-cf` remains a complete, self-hostable Studio with no requirement to operate a hosted
  service. Nothing in this repository is needed to run Studio yourself.
- The two repositories are coupled ONLY through the published Studio release artifact -- the
  versioned bundle contract, pinned by `{tag, manifest_sha256}`. There are no source-level imports
  across the boundary, and there must never be.
- Studio release pin floor: **v1.3.1**.

### Tag semantics, split

Each repository now versions and deploys its own product. The shared-tag double duty is gone:

| tag | deploys |
| --- | --- |
| `v*` here | the control plane |
| `v*` in `vivijure-cf` | the Studio panel |

### Migrations apply on deploy (vivijure-cf#80)

Schema now reaches the live control-plane D1 through the deploy pipeline or not at all. No
hand-applied schema, ever.

This closes a defect that produced two live provisioning failures in a single evening. The live
database had been built by hand: `0001` applied raw, `0002` skipped entirely, `0003` applied after
the fact, and no `d1_migrations` ledger to notice any of it. The symptoms were an AUP acceptance
returning 500 on a missing `aup_sha256` column, and a provision dying at `r2_token` on
`no such column: r2_token_id`.

- migrations are applied **before** the worker deploys, so new code never runs against old schema
- a separate verify step re-lists migrations afterwards and fails the deploy if any remain pending,
  because `apply` exiting 0 proves only that it did not error
- migrations must be additive; a destructive or narrowing change needs expand/contract across two
  releases (`CONTRIBUTING.md`)

### Deploy pipeline

- `v*` tag only, never a push to `main` -- an ordinary merge must not redeploy the live plane
- the tag must match the declared version, so a build cannot ship reporting a version it is not
- config is rendered from `wrangler.toml.example` at deploy time and fails closed: every injected
  value is required unless explicitly allowlisted, the D1 id is checked by shape rather than mere
  presence, and `AUP_URL` is refused if it points at a moving ref
- a `workflow_dispatch` dry run validates configuration and reports pending migrations without
  writing anything; the writes live in a separate job so a dry run skips them by construction

### Also here

- `zone-security/` -- the vivijure.com zone WAF as code, moved from `vivijure-cf`, in log mode.
  The flip to enforce is a separate launch gate.
- Born at the full aviation-grade standard: `main` requires PRs, blocks force-push and deletion,
  and gates on `ci` / `coverage` / `CodeQL`.
