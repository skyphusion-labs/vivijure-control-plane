# The platform control plane

The hosted door for vivijure studio (epic #40, skeleton #52). A **separate Worker** from the studio
that deploys independently, exactly like the MCP Worker: `npm run deploy`.

It owns accounts, auth, the AUP gate, tenant records, and the admin switches. It owns **no tenant
studio data**.

## Parity, stated up front

This control plane ships **AGPL in this repo like everything else**. Anyone may run a competing
hosted vivijure from exactly this source, with our blessing.

The hosted tier sells convenience (no install, no infra), never capability. There is no community
edition and no pay-gated feature, ever. That is not a promise bolted onto the architecture; it is a
property of it: the control plane provisions **the published studio release, unmodified**, so there
is no hosted fork of the studio that could drift away from self-host.

## Why studio-instance-per-tenant

Every tenant gets their own complete studio: their own Worker (a user Worker in a Workers for
Platforms dispatch namespace), their own D1, their own R2 bucket, their own secrets.

The alternative (adding `tenant_id` to every studio table) was rejected. The studio is
**single-operator by design** (the #292 identity strip); "no per-user scoping" is a load-bearing
simplification across renders-db, cast-db, the spend counter, and module config. Reversing it would
fork hosted behavior away from self-host inside the core and touch every query in the render spine.

Instance-per-tenant makes every single-operator assumption stay true, because **each tenant IS the
operator of their own studio**.

## Data boundary (enforced, not just documented)

The control-plane D1 holds `accounts`, `account_identities`, `login_tokens`, `sessions`,
`oauth_states`, `tenants`, `aup_acceptances`, `provision_jobs`, `platform_settings`, `admin_audit`.

Tenant studio data (projects, storyboards, renders, cast, spend) lives in the **tenant's own D1**
and never here. `tests/schema-guard.test.ts` fails the build if a studio table ever
appears in `migrations/`, so the boundary is a test rather than a sentence.

**Every stored credential is a SHA-256 hash**, never a plaintext (the `api_tokens` rule, #445): a
dump of this database yields no usable credential. The schema guard also fails on any
credential-shaped column that is not a `*_hash`.

## Key custody (the whole security story)

Two keys, and the split is the point:

| | Key A: provisioning | Key B: stored |
|---|---|---|
| Shape | Restricted, `api.runpod.io/graphql` = Read/Write, invoke = None | Restricted, invoke scoped to the tenant's 4 endpoints |
| Lifetime | **Transient.** Used once, never stored anywhere | Stored as a secret on the tenant's own studio |
| Blast radius | The whole RunPod account (RunPod's own stated risk) | Invoke those 4 endpoints, 403 elsewhere |

**Onboarding is two-phase, and it has to be.** RunPod API keys are console-minted only (no API
creates them), and a key cannot be scoped to endpoints that do not exist yet. So key B is
physically impossible to create until key A has already provisioned the endpoints:

```
paste key A -> provision the 4 endpoints -> status awaiting_invoke_key
            -> tenant mints key B in the RunPod console, scoped to those 4
            -> paste key B -> verified, installed as a studio secret -> live
```

Key B is **verified before it is ever stored** (`runpod-invoke-key.ts`): if it can reach GraphQL it
is a provisioning-capable key and is refused outright, because storing it would throw away the
entire custody win. The tenant is told exactly why. The probe semantics are the empirically
resolved #60 matrix, not documentation.

A consequence worth stating plainly: because key A is never stored, a provision job that fails **in
the RunPod steps** cannot resume itself. `/retry` answers `409 runpod_key_required` and the tenant
re-pastes. CF-side steps (D1, R2, WfP upload) resume with no key at all. That is the honest cost of
never holding the powerful key.

## The AUP gate

Versioned, blocking, logged, and in front of provisioning from day one, so no tenant studio can
exist without a recorded acceptance by a known account. The CSAM bright line is absolute; the GPUs
are the tenant's, the surface is ours.

The gate is a **lookup for the current version**, never a boolean on the account. Bumping
`AUP_VERSION` re-gates everyone on their next request, by construction, with no migration and no
backfill. A boolean would silently grandfather every existing account through changed text.

Acceptance records hash the IP rather than storing it raw: the record must prove who accepted what
and when, which a hash does, without turning the log into a location dataset.

## Auth

| Method | Status |
|---|---|
| Magic link | postern `POST /api/send`; the sender identity is BOUND to our token by postern's registry, so we never pass a `From` |
| Google | OIDC, hand-rolled, PKCE |
| GitHub | OAuth, hand-rolled |
| Apple | **Seam only.** Appears the day Team ID + Services ID + .p8 are staged; no code change |

`GET /api/platform/config` projects `auth_methods` from **what is actually configured** (id AND
secret both present). The front door renders buttons from that array and hardcodes nothing: the same
registry-projection rule the studio UI follows. A half-configured provider is absent, not broken.

**The one security invariant:** a provider identity may only reach an account when the provider
asserts the email as **verified** (Google's `email_verified`; GitHub's primary+verified address from
`/user/emails`, never the profile field). Without this rule, anyone who can set an unverified email
at any provider inherits the matching vivijure account. `upsertAccountForVerifiedEmail` is the one
place accounts are linked, so every provider obeys it.

Sessions are `__Host-` cookies (HttpOnly, Secure, SameSite=Lax). `__Host-` matters specifically
because tenant studios are sibling subdomains; `Lax` is required because the magic-link click and
the SSO callback are top-level cross-site GETs that `Strict` would drop.

## Tenants

`slug` is **both** a DNS label (`<slug>.studio.vivijure.com`) and the WfP script name, so it is
validated once against the intersection of both alphabets, plus a reserved list so a tenant cannot
mint a hostname that impersonates a platform surface.

**Suspension is orthogonal to lifecycle.** `status` is the lifecycle
(`pending | provisioning | awaiting_invoke_key | live | failed | deleting | deleted`); `suspended_at`
is a separate flag that the API projects over the top as `status: "suspended"`.

This is not stylistic. Storing suspension *in* the status column destroys the lifecycle state it
overwrites, so resume has to guess where to return to, and guessing "live" silently promoted a
never-provisioned tenant to live with a URL to a studio that did not exist. Two independent facts
need two independent columns. (Caught on a real D1 during the #52 live verify; the unit suite had
only ever suspended an already-live tenant. Regression test: `routes.test.ts`.)

## Admin switches

Bearer token (`CONTROL_PLANE_ADMIN_TOKEN`), constant-time compared, reusing the studio's proven
gate. **Unset means no admin surface, not an open one.** Every action is audited; a suspend without
a reason is refused, because the kill switch must stay attributable.

- Per-tenant suspend/resume: pulls the tenant's routing instantly, independent of their own studio.
- Global `signups_enabled`: DB-backed, not a var, so it flips **without a deploy**. There is no
  tenant cap by ruling (R2 spend is the governing meter); this switch doubles as the waitlist gate.
  It closes the door to NEW accounts only and never locks out people who already have one.
  **Provisioning is exempt by product ruling (2026-07-17): the toggle aims at the front door, not at
  people already inside it.** An existing, AUP-accepted account mid-onboarding provisions normally
  with signups off; provisioning gates on session + accepted AUP only. Pinned in
  `tests/routes.test.ts` (both halves: new signup refused, existing account served).

## Config

Bindings live in `wrangler.toml.example` and are mirrored by hand in
`src/env.ts` (the standing rule). `account_id` is never hardcoded. The rendered
`wrangler.toml` is gitignored, like every other rendered config in this repo.

**Provisioner wiring** (`src/deps.ts` `provisionerWiring()`): the provision and
invoke-key routes are OFFERED only when every piece below is configured, and refuse with
`503 provisioner_unconfigured` otherwise -- the same absence-fails-closed rule as the admin gate,
because a tenant parked on a job nothing will ever run is a lie with a status page.

| Piece | What it is |
|---|---|
| `CF_PROVISIONER_TOKEN` (secret) | The DASHBOARD-created credential: mints tenant D1/R2/WfP uploads AND the per-tenant bucket tokens (an API-created token cannot mint; `token-minter.ts`) |
| `CF_ACCOUNT_ID` (var) | Account id for `CfApi` paths and the tenant R2 S3 endpoint |
| `DISPATCH_NAMESPACE` (var) | The WfP namespace NAME for uploads; must agree with the `TENANT_DISPATCH` binding |
| `TENANT_MODULE_NAMESPACE` (var) | The shared WfP namespace tenant MODULE workers upload into (cf#99); provisioner-created if missing, but required |
| `STUDIO_RELEASE` (var) | The pinned release tag every new tenant gets (the golden-checkpoint pin) |
| `STUDIO_RELEASES` (R2 binding) | The release-artifact mirror `studio-release.yml` publishes |

Deploy prereqs, same class as the dangling-namespace hazard: the mirror bucket must exist and the
pinned tag's artifact must have been PUBLISHED into it (run the studio-release workflow) before a
provision can succeed. An unpublished pin fails a provision honestly at `wfp_upload`.

## Tenant render modules (the studio-to-endpoint bridge, cf#99)

A fully-provisioned tenant is live, serving, authenticated, and spend-limited, with four GPU
endpoints -- and, until this bridge, ZERO render modules: `/api/modules/installed` was `[]` and a
render 503'd honestly. The endpoints exist and their ids are set, but those ids are read by
**module workers**, and nothing created them. This is the piece the original spec built around
but not through.

The provisioner closes it the SAME way self-host does (Phase-3 dynamic dispatch), per tenant:

1. **Module scripts.** Tenant-configured copies of the module workers (`keyframe`, `own-gpu`,
   `finish-upscale`, `finish-lipsync`, `speech-upscale`) upload into ONE shared dispatch namespace
   (`TENANT_MODULE_NAMESPACE`, e.g. `vivijure-tenant-modules`), script names prefixed with the
   TENANT ID (stable across renames; teardown is a prefix sweep). Each carries only its own
   endpoint id (`RUNPOD_ENDPOINT_ID`, plain_text). The catalog (`src/tenant-modules.ts`,
   `TENANT_MODULE_CATALOG`) maps module -> endpoint as DATA; extending the tier is a row there plus
   the matching endpoint in `runpod.ts` (bare-skeleton doctrine).
2. **`MODULE_DISPATCH` on the studio.** The tenant studio's WfP upload carries a
   `dispatch_namespace` binding -> the modules namespace. This is UPLOAD METADATA, not studio code,
   so the studio bundle stays byte-identical to self-host (parity). That a WfP user worker can
   carry a dispatch binding was live-proven before any code (cf#99 step-1 probe: accepted,
   censused, and a runtime `.get().fetch()` reached the namespace).
3. **Install via the studio's own route.** The provisioner drives the tenant studio's
   `POST /api/modules/install` over `TENANT_DISPATCH` (the studio bearer passes its own
   `AUTH_MODE=token` gate). The studio runs the REAL conformance gate against the resident script
   through its `MODULE_DISPATCH` and seeds `installed_modules` in the tenant D1. No install logic
   is duplicated in the control plane.

**Key-B ordering.** Modules upload + install DURING provisioning, before key B exists. That is
safe because module conformance is envelope+degrade only (async GPU modules return pending/degrade;
the gate never triggers real GPU work), and every module answers the conformance probe with a
well-formed `{ ok:false }` envelope before it reads any RunPod credential (live-verified across all
five modules with no key B bound). Key B lands on the studio AND every module script in
`installInvokeKey`, in place (a secret PUT, no re-upload) -- the module can then render.

**Bundles.** Module workers cannot be built at provision time (the control plane is a Worker), the
same constraint the studio bundle has. They ship in the SAME release artifact under
`studio-releases/<tag>/modules/<name>/` (one tag, one artifact: a tenant's studio and its modules
are never a mismatched pair), fetched + sha256-integrity-checked by `r2ModuleBundleSource`, built
by `scripts/build-module-release.ts` in the release workflow.

**Verify + teardown.** A tenant is not verified until `/api/modules/installed` is non-empty (the
in-job gate); a render past discovery + moving pixels needs key B and is the out-of-band release
gate. Teardown pulls the studio worker first (discovery goes dark), then prefix-sweeps the tenant's
module scripts and censuses that zero remain; the `installed_modules` rows die with the tenant D1.

Naming: **"control-plane", never "platform"**. The Studio's
[`vivijure-cf src/platform/`](https://github.com/skyphusion-labs/vivijure-cf/blob/main/src/platform/) is already the host-neutral Platform ICD.
There is no `src/platform/` in THIS repo, and there should not be: reusing the name across the two
repositories would be a trap for the next reader moving between them.

## Upgrading the modules of a LIVE tenant (cf#103)

A tenant provisioned last month runs the module bytes that were published then. Shipping a new
module release used to have no route to reach it: the only code path that uploads module scripts
lived inside a provision job, so an existing tenant could receive new modules only by being
re-provisioned, which it cannot be.

`POST /api/admin/tenants/:id/upgrade-modules` is that route. It is operator-only, one tenant per
call, and deliberately narrow: it re-runs the three MODULE steps (`modules_upload`,
`modules_install`, `verify`) against a tenant that already completed them.

### What it does NOT do, and why

It does not touch the studio. The tenant keeps running the studio bytes it was provisioned with, and
`studio_release` is not written. Moving a tenant to a new STUDIO pin means re-uploading the studio
worker, which means re-declaring its full binding set including `R2_S3_SECRET_ACCESS_KEY` -- a value
this system deliberately never stores (see "Key custody"). That is a different job with a different
custody shape, and it is not this route.

It does not write `tenants.status`. Not on entry, not on success, not on failure. This is the whole
safety story rather than an implementation detail: `routingStatusFor` maps any non-`live` status to
something `tenantRefusal` answers with a 503, so a tenant put into a "provisioning-shaped" state
during an upgrade would serve `503 This studio is still being set up` to its own paying users for
the duration. A live tenant stays live throughout; progress lives on the job row.

It does not roll back automatically. Rolling back means issuing more writes against a tenant that
just failed a write, on the path that is already failing. Instead the failure is recorded in full
and the tenant keeps serving. **Rollback is re-running this same route at the previous release**,
which the job row preserves as `from_release`.

### The release is explicit and required

The request body is `{ "release": "<tag>" }`. There is no default, and a missing or blank release is
`400 release_required`.

This is deliberate and worth not "fixing" later. The defect that motivated this route is that module
bundles were always fetched at `deps.release`, i.e. the PLANE-WIDE `STUDIO_RELEASE` env var, while
`tenants.studio_release` was a column nothing ever read. Defaulting the release here would restore
exactly that: module bytes shipped at whatever the plane happened to be pinned to, with nobody
having said so and nothing recording it.

### Ordering: everything that can refuse, refuses before anything is written

1. **Preflight (all reads, no writes).** Tenant exists and is not deleted; not suspended; status is
   `live`; `script_name` present; `endpoints_json` covers every endpoint the module catalog needs;
   `studio_token_enc` present and decryptable; the studio answers a non-5xx root probe.
2. **Fetch EVERY module bundle for the target release**, still before any upload. A release missing
   one bundle must refuse before the first upload rather than after the third -- otherwise a bad
   release pin swaps three modules and leaves a live tenant on mixed bytes.
3. Only then is the job row created and the work started (202 + `job_id`).

A refusal at 1 or 2 has created no job, cleared no release, and uploaded no module.

### The release ledger, and what NULL means

`tenants.modules_release` records the release whose module bytes the tenant runs **when that is
uniformly true**. The upgrade NULLs it before its first upload and writes the target only on full
success. So:

| `modules_release` | meaning |
|---|---|
| a tag | every module script is at that release |
| `NULL` | not known to be uniformly at any one release; consult the latest `module_upgrade` job |

A partial failure therefore reads NULL rather than leaving the OLD tag standing, which would assert
a uniformity the resident scripts do not have. The previous release is not lost: the job row carries
`from_release` and `to_release`, which is what keeps a failed upgrade rollback-able.

### What a user sees during an upgrade

The studio never stops serving. It is not touched, its status is not changed, and routing keeps
dispatching to the same `script_name`.

Stated honestly rather than as "seamless": module scripts are replaced by in-place PUT and Workers
for Platforms has no atomic multi-script swap, so a module invocation inside the swap window may
execute old or new bytes. Both are conformance-gated, so neither is broken.

### Mixed module state, and the one coupled pair

A partial failure can leave some modules at the new release and some at the old. Whether that is
safe is a question about the CATALOG, not about the conformance gate (which is per-module and says
nothing about pairs):

- The five catalog modules serve four hooks: `keyframe` (keyframe), `own-gpu` (motion.backend),
  `speech-upscale` (speech), and `finish-upscale` + `finish-lipsync` (both `finish`).
- Modules on **different** hooks never see each other output, so a mixed state across those is not
  expressible as an incompatibility.
- The one coupled pair is the two `finish` modules, which **chain**: each takes
  `FinishInput{shot_id, clip_key}` and returns `FinishOutput{clip_key}`, so the second consumes the
  output key of the first. A mixed finish chain is two vendored copies of that contract meeting on
  one clip.

That pair is bounded by the `api: "vivijure-module/2"` version the contract carries: an incompatible
change to the finish payload requires bumping it, and the studio install gate rejects an api it does
not accept, so an incompatible mixed chain fails at INSTALL, leaving the old module resident and the
tenant serving.

**Known limit:** a semantic redefinition of an existing field WITHOUT an api bump is not detectable
here. That is a release-discipline defect which would break a full re-provision just as badly.

### Refusals

| code | status | when |
|---|---|---|
| `release_required` | 400 | no release in the body, or blank |
| `not_found` | 404 | no such tenant |
| `tenant_deleted` | 404 | the tenant row is deleted |
| `tenant_suspended` | 409 | suspended; an upgrade must not route around the kill switch |
| `tenant_not_live` | 409 | not `live`. An unfinished provision is resumed through its provision job, not upgraded |
| `tenant_has_no_studio` | 409 | no `script_name` recorded |
| `job_in_progress` | 409 | a job for this tenant is queued or running |
| `tenant_endpoints_incomplete` | 422 | the tenant lacks an endpoint some catalog module needs |
| `tenant_studio_token_missing` / `tenant_studio_token_unreadable` | 422 | no usable studio token |
| `tenant_studio_not_serving` | 422 | the studio was already 5xx BEFORE the upgrade |
| `module_bundle_unavailable` | 422 | the release is missing a module bundle |
| `provisioner_unconfigured` | 503 | the deploy lacks the provisioner env |

## Verifying changes

```bash
npm run typecheck                 # the CI gate
npm test                          # the whole suite
npm run dev         # live, against a real local D1
```

The in-memory store in `tests/memory-store.ts` proves **decision paths only**. It is
not evidence about the shipped artifact: it encodes assumptions about our own SQL and would happily
agree with a bug in it. `store-d1.ts` is the one un-stubbable seam and is verified against a **real
D1** via `wrangler dev`. Both halves are required; the live pass is what caught the suspend defect
above.

## Scope

The provision route now LAUNCHES the #53/#54 runner in-Worker (`ctx.waitUntil`): a 202 means the
job is genuinely running, progress lands on the job row (`GET /api/tenant/:id/job`), and the
tenant parks at `awaiting_invoke_key` or fails with the real step error. The invoke-key route
verifies key B and INSTALLS it as the tenant studio's secret (the per-script secrets PUT), then
promotes the tenant to `live`. The transient key A rides the request into the runner call and is
held nowhere else; an isolate eviction mid-job leaves an honest `running`/`failed` job row, never a
fake success, and re-provisioning is idempotent-by-name.

(Historical note, kept because it burned us: until 2026-07-17 the runner existed but was wired to
NOTHING in the deployed Worker -- provision parked every tenant on a forever-`queued` job, and the
invoke-key route answered an honest 501. The in-process live e2e proved the step machine while the
shipped surface could not run it; the first over-HTTP run caught it, which is exactly what that
run exists for.)

Still elsewhere: routing/domains #55, quotas #56, AUP text #57, onboarding UX #58.

## Module readiness, and what `/api/platform/version` is for (cf#114)

### The window this closes

`installInvokeKey` writes key B to the tenant studio and to all five tenant module scripts, then the
route flips the tenant to `live`. A `200` from the secrets PUT means the secret is stored; it does
NOT mean the version the edge is serving can read it. In the cf#99 finale a tenant that had just
reported `live` failed its first render citing a credential that was demonstrably present, and the
identical payload succeeded 45 seconds later.

Nothing outside the module can observe that. `getScriptSecretNames` reports the secret NAME exists,
which was TRUE during the failure, and it cannot say which version the edge serves. So the probe has
to be a module endpoint, which is what `GET /ready` (vivijure-cf#114) is.

### The probe

`awaitTenantModulesReady` (`src/tenant-modules.ts`) runs after the key-B fan-out and BEFORE
`setTenantStatus(..., "live")`. It probes `GET /ready` on all five tenant module scripts over the
`TENANT_MODULE_DISPATCH` binding, unauthenticated (the endpoint carries booleans, never values, and
the plane must be able to ask before the tenant has a working credential to authenticate with).

`classifyReadyResponse` is where the line between a wait and a cover-up lives, so it is a pure,
separately tested function:

| answer | verdict | behaviour |
| --- | --- | --- |
| `200`, both credentials `true` | `ready` | done |
| `200`, endpoint `true`, key `false` | `not_visible_yet` | **the only retryable shape** |
| `200`, endpoint `false` | `misconfigured` | fails IMMEDIATELY -- the endpoint id is bound at upload, so waiting cannot fix it |
| `200`, not the contract envelope | `misconfigured` | fails immediately; a malformed body is not evidence of anything |
| `200`, `module` echo does not match | `misconfigured` | fails immediately: we are talking to the WRONG script |
| `404` | `unverifiable` | nothing answered: reported UNVERIFIABLE, never retried, never counted as ready |
| anything else | `misconfigured` | fails immediately |

**The `module` echo is the wrong-script defence.** Script names are tenant-prefixed and derived, so a
naming bug would otherwise let a healthy NEIGHBOUR module answer and be read as proof about the
module we meant to probe. The echo must match the expected module name or the answer is refused.

**Budget (cf#112 / cf#113).** This runs in the invoke-key ROUTE, which a customer is waiting on.
`MODULE_READY_PROBE_DEADLINE_MS` is 10s across ALL FIVE modules, not per module: each round probes
the still-pending scripts concurrently, and a module that goes ready drops out of the loop. Five
sequential deadlines would be a 50s route, which is a hang wearing a fix. It fits the budget or fails
honestly; it never sleeps past it.

**At the deadline with everything still `not_visible_yet`, the probe answers SOFTLY** (control-plane#17).
This is not a weakening: a key that is not visible yet is INDISTINGUISHABLE from one that was never
written -- both answer endpoint-present/key-absent -- so calling it a failure would be asserting more
than we know. Measured live on 2026-07-18: a first-ever key write to five fresh module scripts
exceeded the 10s deadline and passed about a minute later.

The route therefore returns **`202`** with the modules named in `modules_unconfirmed` and a message
saying the key IS stored and the caller should retry (never re-paste the key). The tenant is **NOT**
promoted, so an unconfirmed module can never be rendered against -- which is the safety property, and
it is what stops a never-written key from reaching a customer even though it is answered softly.

**Every `misconfigured` verdict still fails HARD and immediately**, before any waiting: absent
endpoint id, non-200, malformed envelope, echo mismatch. That line is what keeps the soft path from
becoming laundering, and it is mutation-tested in both directions.

### A 404: `unverifiable`, never a false pass, and never a guess at the cause

A module published before `/ready` existed cannot answer. Hard-failing would mean a tenant pinned to
an older release can no longer install a key at all, which is worse than the defect being fixed; and
waiting cannot make the endpoint appear. So it is neither retried nor fatal.

**But we do not get to name the cause.** A 404 means "nothing answered `GET /ready` at this script
name". That is a module image predating the endpoint, OR no module present under that name at all (a
wrong-name or failed-upload bug). Those are INDISTINGUISHABLE from here: the `module` echo that would
disambiguate exists only on an answering response. So the verdict is `unverifiable` rather than
`no_ready_route`, and the reported detail states both readings instead of asserting the flattering
one. Calling it "predates /ready" would be a confident guess dressed as a diagnosis, and a missing
script is the more dangerous of the two to mislabel.

The install succeeded and is reported as such; what could not be done is PROVING propagation:

```json
{ "ok": true, "status": "live", "verified_endpoints": 4,
  "modules_ready": false,
  "modules_verified": ["keyframe", "own-gpu"],
  "modules_unverified": [
    { "module": "finish-upscale", "reason": "unverifiable",
      "script": "ten-abc123-finish-upscale", "detail": "..." },
    { "module": "speech-upscale", "reason": "unverifiable",
      "script": "ten-abc123-speech-upscale", "detail": "..." }
  ] }
```

**Per module, never collapsed.** A mixed fleet (some modules answering, some not) names EVERY
unproven module with its own script and its own detail, because an operator has to act per module.
`modules_verified` is a list of plain names and `modules_unverified` a list of objects, so the two
are structurally distinguishable and a consumer cannot conflate them by truthiness or by shape; an
unverified module can never appear in the verified list. `modules_unverified` is OMITTED entirely
when everything was proven, so an empty array is never ambiguous.

`modules_ready` is `false` whenever anything went unverified, so an operator reading the top-level
field alone cannot mistake "could not check" for "checked and fine".

### What the CALLER receives, per outcome

The table below is the contract, and it is asserted at the ROUTE level in `tests/routes.test.ts`.
That assertion class exists because its absence shipped control-plane#17: every test asserted what
the probe threw or returned, none asserted what a customer got, and a `TenantModuleError` carrying
module, script, attempts and elapsed was reaching the caller as a bare `{"error":"internal_error"}`.

| outcome | status | body | tenant |
|---|---|---|---|
| all verified | `200` | `modules_ready: true`, `modules_verified` | promoted to `live` |
| some unverifiable (404) | `200` | `modules_ready: false`, `modules_unverified` with per-module detail | promoted to `live` |
| unconfirmed at deadline | `202` | `modules_ready: false`, `modules_unconfirmed`, retry message | NOT promoted |
| misconfigured | `503` `modules_not_ready` | the real diagnostic: module, script, retryability, attempts, elapsed | NOT promoted |
| non-module failure | `500` `internal_error` | opaque by design; it is not a readiness problem | NOT promoted | This path is transitional: it
disappears once the pinned release carries `/ready` on every module. The same reporting covers an
unbound `TENANT_MODULE_DISPATCH` (a deploy predating the binding), which degrades to unverified
rather than to a false all-clear.

### Verifying a deploy that carries the binding

The `TENANT_MODULE_DISPATCH` dangling-binding hazard is checked, not assumed. After a CP deploy:

1. `GET /api/platform/version` -> must report the version just cut. If the deploy failed on the
   binding, there is nothing serving to answer this, so it fails visibly rather than silently.
2. Exercise one `/ready` probe path (install a key on a tenant provisioned against a release that
   carries `/ready`) and confirm the response comes back `modules_ready: true` with every module in
   `modules_verified`. An unbound namespace degrades to `unverifiable` for all five, which is exactly
   what distinguishes "binding missing" from "working".

Step 2 is the one that proves the binding is real: step 1 alone passes on a plane whose module
dispatch is not wired at all.

### `GET /api/platform/version`

Returns `{ "control_plane_version": "<semver>" }` from `src/version.ts`, which the existing lockstep
test keeps equal to `package.json`. Before this, `CONTROL_PLANE_VERSION` was referenced by nothing at
runtime: confirming which release the plane served meant fetching a changed asset and reading the
patched line off the wire. That works, but it is archaeology, not observability.

It is its OWN route rather than a field on `/api/platform/config` deliberately. That route is a
policy projection the front door renders from -- it has a UI contract and a UI audience. Deploy
identity is an operator/CI fact with a different audience and different cache semantics, and folding
it in is how a config endpoint turns into a junk drawer. Unauthenticated, like the config route: the
version of an AGPL codebase whose tags are public is not a secret, and a version you need a
credential to read is useless to the monitoring that needs it most.
