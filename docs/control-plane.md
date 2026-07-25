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
A failed provision auto-tears down created resources (cf#91): re-fetch the tenant row, revoke the
R2 token by persisted id or by deterministic name (`vivijure-tenant-<slug>-r2`, result_info-checked
census), then delete D1/bucket. Slug reuse for never-live failed rows stays on the Tier A reclaim
path.

Naming: **"control-plane", never "platform"**. The Studio's
[`vivijure-cf src/platform/`](https://github.com/skyphusion-labs/vivijure-cf/blob/main/src/platform/) is already the host-neutral Platform ICD.
There is no `src/platform/` in THIS repo, and there should not be: reusing the name across the two
repositories would be a trap for the next reader moving between them.

## Giving a LIVE tenant a studio BINDING (cp#112)

`VIDEO_FINISH_VPC` (cf#118) is attached in the studio-script upload, and that upload happens in
exactly one place: `runProvisionJob`. `continueProvisionJob` refuses anything short of `wfp_upload`,
the module upgrade deliberately never touches the studio, and teardown deletes. So the video-finish
tier reached tenants provisioned AFTER the knob was set and **nobody else**, permanently, with no
operator action in the plane that changed it.

`POST /api/admin/tenants/:id/refresh-studio-bindings` closes that. Operator-only, one tenant per
call, runs inline (the answer IS the evidence), and it changes **bindings only**.

```
POST /api/admin/tenants/ten_abc123/refresh-studio-bindings
Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN
```

### Why it is a binding PATCH and not a re-upload

The section above already states the constraint for the module lane: re-uploading the studio worker
means re-declaring its full binding set including `R2_S3_SECRET_ACCESS_KEY`, a value this system
deliberately never stores. The same is true of `RUNPOD_API_KEY` (key B, transient by ruling). A live
tenant studio carries four secrets and the plane can reconstruct two of them, so a re-upload cannot
put the other two back: the tenant would stop rendering (presign throws without the R2 secret,
dispatch dies without key B) and recovery would need the tenant to re-paste key B plus an R2 token
re-mint with a matching RunPod template rewrite.

So this route sends `PATCH .../scripts/<script>/settings` with the full desired binding set, where
everything being kept travels as `{ "type": "inherit", "name": ... }`. No binding VALUE is handled
at any point, which is what makes it safe on a tenant whose secrets the plane cannot reproduce. It
also means the studio BYTES and `studio_release` are untouched: moving a tenant to a new studio pin
stays a separate operation with its own custody shape, exactly as documented above.

### Refusals, all before anything is written

| Refusal | When |
| --- | --- |
| `provisioner_unconfigured` (503) | no provisioner wiring on this deploy |
| `not_found` (404) | unknown tenant |
| `job_in_progress` (409) | a provision or upgrade holds a LIVE lease on the row; a binding patch must not race an upload that owns the binding set |
| `not_provisioned` (409) | the tenant has no studio script recorded; it needs a provision, not this |
| `video_finish_unconfigured` (409) | `VIDEO_FINISH_VPC_SERVICE_ID` is unset, so the plane has no tier to deliver (cp#109 honest refusal) |
| `vpc_binding_unauthorized` (409) | the plane SCRIPT UPLOAD credential lacks Connectivity Directory access. Names `CF_WORKER_UPLOAD_TOKEN` so the operator does not go looking at the tenant |

### What comes back

The response is a READBACK, taken through a different credential than the one that wrote (the PATCH
echoes no bindings, and `success: true` is the writing client opinion of its own work):
`bindings_before` / `bindings_after`, `secrets_before` / `secrets_after`, `missing_bindings` /
`missing_secrets`, `already_present`, and `ok`.

**A short readback answers 409, not 200.** A 200 carrying `ok: false` reads as success to anything
that checks status codes, and a tenant that lost a binding or a secret is the one outcome this route
exists to make impossible to miss.

It is idempotent by CONVERGENCE, not by skipping: a tenant that already carries the binding is
patched anyway with the currently configured service id. The CF bindings endpoint does return
`service_id` for a `vpc_service` binding (verified live 2026-07-25), but the `getScriptBindings`
wrapper surfaces type and name only, so the deciding code cannot see the id and "already present"
cannot mean "already correct".

### The unverified seam (read before the first live run)

The settings-PATCH body shape and `inherit` over a `secret_text` binding are read off the Cloudflare
API reference. **No test in this repo hands that request to Cloudflare**, and by the standing rule a
layer exercised only through a fake is untested. One live probe against a THROWAWAY script in the
tenants namespace (upload with a secret, PATCH with `inherit` plus a new binding, census, delete)
settles it; the readback above is the runtime guard for the same doubt.

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
| `job_in_progress` | 409 | a job for this tenant holds a live driver lease |
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

## Watching a hosted tenant actually render (cp#45)

Our release standard is that nothing is verified until someone has looked at the actual output. For
a hosted tenant that standard was **not performable by anyone**, and that gap is the reason this
route exists.

The tenant studio serves its root publicly but 403s every API path. The control plane reaches it
over `env.TENANT_DISPATCH` -- a Workers for Platforms dispatch binding, not the public internet --
with `authorization: Bearer <studioApiToken>`, and that token is `tenants.studio_token_enc`,
decryptable only with the worker KEK. An operator with full D1 read access holds the ciphertext and
nothing usable. So every hosted module release to date rested on install-and-probe evidence (the
module ANSWERED) and never once on observed pixels.

Conrad ruled **option (b)**: the plane submits the render itself. **No credential leaves the
worker.** Option (a), issuing an operator-usable tenant credential, was rejected -- it would create
a standing credential class able to drive a customer studio, to be custodied forever, for something
we do a few times per release.

### The three routes

| Route | What it does |
| --- | --- |
| `POST /api/admin/tenants/:id/smoke-render` | Opens a smoke render, builds the canonical bundle and submits it. `202` with the row, or `429` when a spend bound refuses. |
| `GET /api/admin/tenants/:id/smoke-render/:smk` | Drives it. This is the call that FETCHES the artifact and decides whether anything is verified. |
| `GET /api/admin/tenants/:id/smoke-render/:smk/artifact` | Streams the bytes back through the plane, so an operator can LOOK at them. |

All three are behind the existing admin bearer. Note that `adminRoutes` checks the bearer BEFORE
matching a path, so **every** `/api/admin/*` string returns 401 unauthenticated, including routes
that do not exist: a 401 here is never evidence that a route is wired.

### phase=done is not a pass

The poll does not believe a status field. It reads the studio's `COMPLETED`, takes the keyframe key
out of the output, **fetches those bytes back through this worker**, and records their size, mime
and sha256. A `COMPLETED` job that names no keyframe, whose key will not fetch, or whose body is
zero bytes is recorded **FAILED**. `verified` in the response is derived from the presence of that
fetched evidence, not from the status string, so there is no path that reports `verified: true` for
bytes nobody pulled. The artifact route re-hashes on every serve and answers `409 artifact_changed`
if the object no longer matches what was verified.

### The spend guard

This route costs GPU by definition. Four things bound it, and the first is the strongest:

1. **The payload is canonical.** The route takes a tenant id and nothing else. One scene, one shot,
   `keyframesOnly`, so the studio skips motion, finish, assemble and mux entirely. There is no
   scene count, duration, tier or model knob an operator could turn into a film's worth of GPU.
2. **Per-tenant cooldown** (`SMOKE_RENDER_COOLDOWN_SECONDS`, default 1800).
3. **Platform-wide daily cap** across all tenants (`SMOKE_RENDER_DAILY_CAP`, default 20).
4. **One in flight per tenant** (`SMOKE_RENDER_INFLIGHT_SECONDS`, default 1200), bounded rather than
   infinite so a smoke render whose poll never returned cannot wedge the route forever.

Bounds 2 to 4 live in the `WHERE` clause of **one conditional INSERT**, so the WRITE authorizes and
two concurrent operator submits cannot both pass. The read that produces the human-readable refusal
is advisory only. A blank env var is treated as ABSENT, never as a deliberate zero.

**What the guard does NOT bound, stated plainly:** it bounds INVOCATIONS, not dollars -- it has no
idea what a keyframe costs, and a cold GPU costs more than a warm one. It does not bound a tenant's
own rendering, which is theirs to spend. It cannot cancel a job already handed to RunPod. And it
does not stop an operator who deliberately waits out the cooldown; it makes repeat renders a
decision rather than a reflex, which is what a guard on an authenticated operator route can do.

### What a green smoke render proves, and what it does not

Returned in `coverage` on every response, because a green tick that does not state its own limits is
exactly how "the modules answered" became "the modules render".

**Proves:** this tenant's own studio accepted an authenticated submit over its dispatch binding;
this tenant's own keyframe module ran on RunPod under this tenant's own invoke key; the bytes were
fetched back, sized and hashed; and they came from the module bytes recorded in `modules_release`
on the row.

**Does not prove:** that any OTHER module renders (this exercises the keyframe hook only); the
motion, dialogue, speech, finish, assemble, master or mux stages; anything about image quality (the
artifact is measured, never judged); or that a tenant's own end-to-end film submit works.

Rendering through a **non-tenant door stays rejected**. It would produce a satisfying artifact that
answers a different question -- that the modules render somewhere, not that THIS tenant's upgraded
modules render. An honest hole beats a number that looks like proof.

## Slug reuse is resource reuse (read before touching any delete path)

Every tenant resource name derives from the **slug**, not from the tenant row:
`vivijure-tenant-<slug>` for the D1 and the bucket, `tenant-<slug>-studio` for the worker,
`vivijure-tenant-<slug>` for the R2 token. And the house pattern frees a slug by **renaming the old
row**, not by deleting it (`getTenantBySlug` has no status filter, so a freed slug means a renamed
row).

Put those two together and you get the fact this section exists for:

> A tenant row's resource ids are **not private to that row**. The old row keeps the ids it was
> provisioned with; the next tenant to take that slug provisions onto the same *names*, and
> therefore onto the same *objects*. Several rows end up pointing at one physical resource.

This is not hypothetical. A census of the live plane on 2026-07-25 found **one** D1 database
referenced by **nine** successive tenant rows -- eight tombstones and the live tenant -- with six of
them also sharing the live tenant's bucket and studio worker.

### What follows from it

- **"This id is on the row I am tearing down" does NOT mean "this object is mine to delete."** Only
  a query across the other rows answers that. `teardownTenant` runs that query (the referential
  guard, #23) and refuses, fail-closed, any resource another row still references. If the guard
  cannot run, nothing is deleted: an un-run teardown is recoverable, a wrong delete is not.
- **A resource shared only with tombstones is still refused.** Deciding which of several tombstones
  "owns" a shared object is a rule nobody has written, and inventing a silent tiebreak in a delete
  path is the wrong place to be clever. The refusal message names the referrers and their statuses
  so an operator can tell a live blocker from a historical one.
- **Fresh-slug testing cannot see any of this.** A test that provisions a brand new slug never
  produces the aliasing, which is why it went unnoticed until a census looked at the real rows.
- The reclaim path is **not** exposed to it, and the reason is worth knowing rather than assuming:
  `claimReclaim` requires `live_at IS NULL` **and** a status in `TIER_A_STATUSES`
  (`pending`/`provisioning`/`awaiting_invoke_key`/`failed`). `deleted` is not in that set, so a
  tombstone cannot be reclaimed. The status filter is what holds that line -- four of the eight
  tombstones are never-live and would have passed the liveness test on its own.

### If you are adding a delete path

There is one, and it is `POST /api/admin/tenants/{id}/teardown` (below). Do not reach for the
resource ids on the row. Go through `teardownTenant`, which asks the guard
first, blanks each column only on that resource's successful deletion, and records the outcome
(`teardown_at`, `teardown_failures`) so a partial teardown is visible in the data rather than only
in a caller's return value.

## Video finishing for tenants, and why a shared tier is safe (cf#118)

A tenant studio with no `VIDEO_FINISH_VPC` degrades honestly: assemble delivers per-shot clips and
says so. That is correct behaviour and it is also a capability gap against self-host, which parity
does not permit as a permanent state. Set `VIDEO_FINISH_VPC_SERVICE_ID` and every tenant studio is
provisioned with the binding, so assemble and mux work for them.

### The tier is SHARED, and the isolation is by construction, not by policy

Tenants render against the same always-on finishing containers (descendents + badbrains). That is
safe for a reason worth stating precisely, because "shared compute with per-tenant credentials"
usually means a policy someone can misconfigure:

> **The container never receives a credential.** The studio presigns per-object R2 GET/PUT URLs
> (1800s) with its OWN bucket-scoped credential and passes URLs in the payload
> (`presignR2Get` / `presignR2Put` in the core's film-orchestrator, render-mux and
> scatter-orchestrator).

So a shared worker cannot enumerate a tenant's bucket, cannot outlive the URLs it was handed, and
holds nothing to leak if it is compromised. There is no policy to get wrong because there is no
credential in the blast radius. Per-tenant finishing stacks remain available as a future premium
decision; they would not make this boundary stronger.

### Two Cloudflare credentials, and why the function is split

| Credential | Owns |
| --- | --- |
| `CF_PROVISIONER_TOKEN` | D1, R2, token mint, teardown |
| `CF_WORKER_UPLOAD_TOKEN` | tenant SCRIPT upload (the call that attaches bindings) |

Not a preference. Attaching a Workers VPC binding needs Connectivity Directory access, and
**Cloudflare will not let an API-created token mint a token carrying that scope**, so the capability
could not be added to the provisioner credential the way the R2 mint was. Splitting the function was
the only shape available, and it happens to be the better one: the upload credential is narrow and
holds no data-plane rights.

`CF_WORKER_UPLOAD_TOKEN` is OPTIONAL. Absent, script upload falls back to the provisioner credential
and the plane behaves exactly as it did before the split. It is REQUIRED only when
`VIDEO_FINISH_VPC_SERVICE_ID` is set, because that is the binding it exists to attach.

### The refusal, and why it is not a catch-and-continue

If the service id is configured and the binding cannot be attached, **the provision fails** with a
named error at `wfp_upload`. It does not drop the binding and continue. Continuing would hand the
operator a tenant that looks fully provisioned while silently lacking a tier the plane is configured
to provide; the tenant's first film would then degrade with a reason blaming an unbound binding,
which is true and useless to the person who set the service id and believes it is there. That is the
silent-degrade class (#245 / #249), and a delete-path-grade mistake in a provisioning path.

The message names the PLANE's credential rather than repeating Cloudflare's, which is accurate and
points at the wrong owner ("your credentials are not authorized for the requested VPC resource"
tells a reader nothing about which of the plane's two tokens is short a scope).

### How the binding was proven, and what still is not

A controlled probe, because "WfP supports this binding" was an assumption nobody had tested:

1. identical upload WITHOUT the binding on the provisioner credential -> success (positive control);
2. identical upload WITH it, same credential -> `10196`, credentials not authorized;
3. same upload on the upload credential -> success;
4. **read back through a DIFFERENT credential than the one that wrote it** -> the binding is on the
   script. The upload response echoes no bindings, so `success: true` is the writing client's
   opinion of its own work.

What that does NOT prove is that a tenant studio can REACH the container at render time. Attach and
reachability are different facts; the second needs a real render through a tenant carrying the
binding, and that is the gate before the tier is considered live for tenants.

## Tearing a tenant down (`POST /api/admin/tenants/{id}/teardown`)

The production caller `teardownTenant` spent its whole life without (#23). Admin-token gated,
audited, and it runs **inline**: the response IS the evidence.

```
POST /api/admin/tenants/ten_abc123/teardown
Authorization: Bearer <CONTROL_PLANE_ADMIN_TOKEN>
{ "confirm_slug": "hero", "delete_data": true }
```

| field | meaning |
| --- | --- |
| `confirm_slug` | **required**, must equal the tenant slug. Ids are opaque and adjacent in a listing; the slug is what an operator recognises. |
| `delete_data` | **defaults to false.** False pulls the studio worker, the module scripts and the R2 credential (unreachable, cannot write) and KEEPS the D1 and the bucket. True also reaps the data. |

The 200 body:

| field | meaning |
| --- | --- |
| `reaped` | the columns that went from set to NULL, read back off the row. Not the teardown return value: columns blank only on their own resource successful deletion, so this is the plane record of the reap rather than an opinion about it. |
| `refused` | what the referential guard would not touch, each naming the referring row and its status. **A refusal is the guard working, not a failure.** |
| `failed` | calls that did not work. Opposite follow-up from a refusal: retry these, investigate those. |
| `absent` | resources that were **already gone** when we went to delete them (cp#110). Not a failure and not a reap: nothing to retry, but this plane is not what removed them. |
| `status` | where the row IS now, read back after the write. |

### ALREADY GONE is success-equivalent (cp#110)

A delete that answers *not found* reached its goal, earlier, by something else. Teardown blanks that
column exactly as it would on a delete it performed, so the row can reach provably-reaped and a
re-run can clear a stale entry. Before this, a guarded sweep that met two rows whose studio script
had already been removed recorded each as a retryable failure: the column kept claiming a worker
that does not exist, `teardown_failures` kept an entry no re-run could ever clear, and the row could
never reach the state the record exists to make reachable.

What makes this narrow rather than "swallow everything":

- The classifier requires **HTTP 404 AND CF code 10007** together (`isScriptAbsent`, `cf-api.ts`),
  live-probed on 2026-07-25 against both dispatch namespaces rather than read off a docs page. A
  403, a 500, or a 404 carrying no code at all is still a failure, because a namespace that does not
  exist is a config fault, not an absent script. CF prose is never matched: the numeric code is the
  invariant worth parsing.
- Absence is **recorded, never swallowed** -- `absent` in the response, `absent` in the admin-action
  audit row, and a `teardown.worker_absent` / `teardown.module_absent` log line. "We deleted it" and
  "it was not there when we looked" are different facts, and the second usually means something
  removed a script out of band, which an operator may want to know about.
- `reaped` cannot carry the distinction on its own, and that is by design: it is a column diff, and
  an already-gone resource blanks its column too. That is precisely why absence is reported beside
  it rather than folded into it.

### "deleted" means "provably reaped", and nothing else

The row is promoted to `status='deleted'` (+ `deleted_at`) **only** when the pass was clean AND
`delete_data` was true. Every other outcome leaves the status where it was, with `teardown_at` and
`teardown_failures` carrying what refused or failed. A row that said `deleted` while the customer
films sat in a live bucket is the exact defect #23 exists to close, and it is what forced the cf#103
Tier B slug refusal.

A tombstone being re-swept **stays** a tombstone: `beginTeardown` never downgrades `deleted` to
`deleting`, and `deleted_at` is preserved rather than rewritten.

### One destructive pass at a time

`beginTeardown` takes the same lease the reclaim path uses (`reclaim_lease_until` /
`reclaim_lease_token`, 300s). There is ONE destructive lease per row on purpose: two independent
leases would not exclude each other, and resource names derive from the slug, so overlapping
teardowns issue the same deletes and the loser can land its deletes on whatever was rebuilt under
those names. A live provision or upgrade job also blocks the claim. An expired lease is free, so a
teardown whose driver died self-heals.

### Emptying the bucket, and why it is a CYCLE (cf#72)

R2 refuses to delete a non-empty bucket, and the R2 REST API has no object list or delete at all;
emptying only goes through the S3 API. So teardown mints its **own** bucket-scoped credential
(`vivijure-tenant-<slug>-teardown`, deliberately a different name from the tenant long-lived token),
empties within a bounded budget, and **revokes that credential before returning, on every path**. No
credential outlives the cycle that made it.

A bucket too large for one budget does not fail terminally: the response says
`bucket not emptied this cycle ... re-run teardown to continue`, the column stays claimed, and the
next call continues. **The guard runs BEFORE the mint**: emptying is the irreversible half (an
emptied bucket is gone whether or not the delete that follows succeeds), so a bucket another row
still references is never opened at all.

## Tenant programmatic API token (`/api/tenant/{id}/api-token`)

The token a tenant uses from their own MCP client, scripts or CI. **A separate credential from the
dispatcher-injected `STUDIO_API_TOKEN`**, ruled 2026-07-24: revoking or rotating this must never sign
the owner out of their browser session, and the two lifetimes stay independent.

| Verb | Response |
| --- | --- |
| `GET` | `200 { configured, name, created_at, last_rotated_at }` |
| `POST` | `201 { token, name, created_at }` -- mint AND rotate, one verb |
| `DELETE` | `200 { configured: false }` |

Refusals: `not_found` (404, also covers someone else's tenant -- an authorization error that confirms
existence is an enumeration oracle), `tenant_not_live` (409), `not_provisioned` (409),
`tenant_unreachable` (503), `provisioner_unconfigured` (503).

### The plane stores no part of the credential

The token is a row in the **tenant's own studio database** (`api_tokens`, studio migration 0009),
holding only its SHA-256 hash. Reveal-once is therefore true **by construction, not by discipline**:
there is no copy anywhere to reveal.

That is why `GET` carries **no masked `display` field**. Masking a value implies keeping one, so a
mask here would assert a custody property we deliberately do not have. The visible absence is the
honest signal, and the panel says so in words: *your studio stores only a one-way hash of it, so
nobody, including us, can show it to you again.*

The one thing the plane keeps is a fact the studio has nowhere to put: `tenants.api_token_rotated_at`
(migration 0009 here). Rotation replaces the studio row, so the studio's `created_at` can only ever
mean "when the current token was issued".

### CONTRACT PIN: custody is not on the wire, and changing that is a wire change

`GET` deliberately does **not** carry a `custody` field. The custody is settled (`separate`), not a
runtime variable, and the panel's default rotate warning states the accurate separate-custody
consequence: *your browser session is not affected.*

**If custody ever changes, the change MUST emit `custody: "shared"` on the `GET` wire in the same
commit.** The panel keeps a `shared` branch specifically as a tripwire that makes its warning harsher
on its own; without the emission that tripwire never fires and the UI keeps telling users their
session is safe when it no longer is. Adding the field is not optional cleanup, it is the mechanism.

### Additive, not a replacement (the coupling that would ship a broken button)

The studio's token gate returns 403 when `STUDIO_API_TOKEN` is unset, **before** it consults the
named-token table. A programmatic token is strictly additive to the operator secret. So minting one
on a studio without that secret hands the tenant a credential that 403s on arrival, and the mint path
refuses with `not_provisioned` rather than issuing it.

