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

### The Cloudflare contract, as MEASURED (probe 2026-07-25)

Probed against a throwaway `rehearsal-`prefixed script in the tenants namespace, not read off a docs
page. Three findings, and the first one was a defect caught before it reached a tenant:

1. **The endpoint takes multipart/form-data with a `settings` part, NOT JSON.** A JSON body is
   refused with `10001 Content-Type must be one of: multipart/form-data`. The first implementation
   sent JSON and would have failed on every call; `tests/cf-api-settings-patch.test.ts` is that
   probe turned into a regression test.
2. **`inherit` preserves a `secret_text` binding.** The probe secret was still bound and still listed
   after two patches, which is what makes this route safe on a tenant whose secrets the plane cannot
   reproduce.
3. **A binding omitted from the patch is DROPPED.** Undocumented, and the reason the route censuses
   first and sends the full desired set every time.

The throwaway script was deleted and the namespace re-censused through a DIFFERENT credential
afterwards: zero `rehearsal-` prefixed residents.

## Rotating the studio-token KEK (cp#95)

`tenants.studio_token_enc` is the one credential this plane stores as a usable value rather than a
hash (see "Key custody"), and until cp#95 the key protecting it could not be changed at all. That
made rotation an incident rather than maintenance: any reason to rotate meant an unplanned project
under time pressure, and there was no migration path either, so a lost key meant re-minting every
tenant's studio token by hand.

The capability is deliberately shaped as **a ring plus two operator routes**, not a script.

### The ring

`STUDIO_TOKEN_KEK` (in force) and, only during a window, `STUDIO_TOKEN_KEK_NEXT` (incoming). The two
directions are separated:

- **Reads try BOTH keys, always.** A row opens whether it was written before, during, or after a
  rotation, so dispatcher-injected auth keeps working throughout the window instead of becoming its
  blast radius.
- **Writes use exactly ONE key**, named by the `STUDIO_TOKEN_KEK_ENCRYPT_SLOT` var.

The write slot is CONFIG rather than runtime state for two reasons. First, convergence: the sweep and
the live provision path must write under the same key, or a sweep can be outrun by provisions forever.
Second, change control: flipping the write direction of every stored customer credential is a
reviewable deploy, not an unlogged toggle.

A slot naming `next` with no next key installed **refuses to encrypt**. It does not fall back. A
silent fallback would write live customer credentials under a key the operator believes is retired,
and that failure stays invisible until somebody deletes the wrong binding.

### The routes

```
GET  /api/admin/kek/status      -> census (read-only, safe any time)
POST /api/admin/kek/reencrypt   -> sweep; body { "limit": <n> } optional
```

| Refusal | When |
| --- | --- |
| `unauthorized` (401) | not the admin token. This is an operator surface |
| `kek_unconfigured` (503) | no `STUDIO_TOKEN_KEK` on this deploy. Answering a census here would report every row unreadable and read like a catastrophe instead of a missing binding |
| `rotation_window_closed` (409) | the sweep was called with no `STUDIO_TOKEN_KEK_NEXT` installed. There is nothing to rotate toward, and re-encrypting every row under the key it already carries is not harmless |

### The census is three buckets, and the third one is an alarm

AES-GCM cannot distinguish "wrong key" from "tampered ciphertext"; both are an auth-tag failure. A
two-bucket census would therefore file a CORRUPT row under "still needs rotating", the sweep would
retry it forever, and a shrinking backlog would read as progress while one row never converged.

| Bucket | Meaning |
| --- | --- |
| `on_target` | opens under the write-slot key. Nothing to do |
| `needs_rotation` | opens under the OTHER installed key. The sweep's work list |
| `unreadable` | opens under NEITHER. Never touched by the sweep, and it holds `safe_to_promote` false |

`total` is always reported alongside, so an empty estate answers `safe_to_promote: true` **with the
count that makes it true**. An empty answer must never be readable as a passing answer.

### What the sweep guarantees

- **Idempotent.** The work list is derived from the data on every run, so a second run is a no-op.
- **Resumable.** `limit` bounds a run; re-running finishes the job. No cursor to persist or go stale.
- **Non-destructive under a race.** The write is a compare-and-set on the ciphertext that was read.
  A provision that re-minted a token mid-sweep wins; the sweep reports `raced` and moves on. Without
  that, a blind write would leave the tenant authenticating with a token its own studio rejects.
- **Never overwrites what it could not read.** An unreadable row is left byte-identical, because the
  value may still be recoverable from an escrowed key nobody has tried yet.

The sweep response carries BOTH `sweep` and a fresh `census`, and only the census decides
`safe_to_promote`. The sweep report is the writer describing its own work; the census is a re-read of
what is actually stored. Same rule the cp#112 readback follows. **A run that leaves work behind
answers 409**, so an incomplete rotation cannot read as a finished one.

Full operator procedure, including the escrow-before-install step: `docs/deploy.md`, "Rotating
`STUDIO_TOKEN_KEK`".

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
`studio_release` is not written. Moving a tenant to a new STUDIO pin is a different job with a
different custody shape, and it is **`POST /api/admin/tenants/:id/upgrade-studio`** (cp#139, below).

The custody objection that once made the studio move look impossible -- re-uploading means
re-declaring the full binding set including `R2_S3_SECRET_ACCESS_KEY`, a value this system
deliberately never stores (see "Key custody") -- was MEASURED AWAY rather than argued away: an
upload can carry a binding forward as `inherit`, without the caller ever holding its value. The
measurements are in the studio-upgrade section.

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


## Moving a LIVE tenant onto a newer STUDIO release (cp#139)

`POST /api/admin/tenants/:id/upgrade-studio` moves a live tenant's STUDIO BYTES in place, preserving
its bindings and its secrets. It is the sibling of the module upgrade above and shares its shape:
admin-gated, one tenant per call, explicit required release, job row carrying `from_release` /
`to_release`, and it NEVER writes `tenants.status`.

### Why this could not exist before, and what changed

`refresh-studio-bindings` (cp#112) changes bindings and deliberately not bytes; the module upgrade
changes module bytes and deliberately not the studio. So a tenant could be given the BINDING for a
feature and never the CODE that projects it, which is exactly the state cp#139 records for the
testbed tenant.

The blocker was secret custody. A live studio carries secrets the plane cannot reproduce
(`R2_S3_SECRET_ACCESS_KEY` is the SHA-256 of an R2 token value that was never stored;
`RUNPOD_API_KEY` is key B, transient by ruling), so a re-upload that re-stated the binding set would
strand the tenant. Three probes against throwaway scripts settled it:

| Probe | Result |
|---|---|
| `inherit` on the UPLOAD endpoint (not just the settings PATCH) | New bytes land, `secret_text` survives, the caller never holds the value |
| Omitting a binding from an upload | `plain_text` (and every non-secret) is **DROPPED**; `secret_text` installed via `PUT /secrets` **SURVIVES** |
| New assets + `inherit` bindings on the same PUT | Coexist; nothing lost |

The omission rule is why the implementation censuses first and carries **every** non-secret binding
forward as `inherit`. That is correctness, not caution: a binding this route forgets to name is a
binding the tenant loses.

### Ordering, and why each position is load-bearing

1. **Preflight (all reads, no writes).** Not deleted; not suspended; status `live`; `script_name`
   present; `d1_database_id` present; `studio_token_enc` present and decryptable; the studio answers
   a non-5xx root probe; the target bundle FETCHES and passes its integrity checks; the release's
   `required_vars` are all covered by this plane's disposition table. It also captures the served
   `/api/modules` host object as the BEFORE marker. A refusal here has written nothing at all.
2. **`studio_release` is NULLed** before the first write (see the ledger below).
3. **Migrations, before bytes.** The release's own migrations are applied to the tenant D1 first,
   tracked per-migration, so new code never meets an old schema. This is not theoretical: the
   v1.6.0 -> v1.8.0 move adds `0012_wan_lora_keys.sql`. A release that adds none applies none.
4. **Assets, then the script PUT** that redeems the completion JWT, both through the upload
   credential (one credential owns both legs).
5. **Readback through the OTHER credential**, plus a re-probe of the studio. `success: true` is the
   writing client's opinion of its own work.

### What the job records, and what decides `ok`

The result is a readback, not a success flag: bindings and secret names before/after, anything
missing, the required-vars re-check on the POST state, the sha256 and size of the bytes shipped, the
migrations applied, the serving status, and the served host-object keys before and after.

`ok` is false -- and the job FAILS -- if any binding or secret went missing, if a required var is
absent from the post-state, or if the studio stops serving. **A short readback fails the job even
though every API call returned 200**, because that is the exact outcome this route exists to make
impossible to miss.

`served_shape_changed` reports whether the served host object actually moved. A same-release
convergence run is ALLOWED (re-shipping is how a half-finished move is finished) and honestly
reports `false` rather than dressing a no-op as a move.

### The release ledger, same discipline as modules

| `tenants.studio_release` | meaning |
|---|---|
| a tag | the studio bytes are that release |
| `NULL` | not known to be at any one release; consult the latest `studio_upgrade` job |

Cleared before the first write, written only on full success, so a partial move cannot leave a tag
standing that claims it completed. Rollback is re-running the route at `from_release`, which the job
row preserves precisely because the column was cleared.

### Operator note: the plane pin is a separate decision

This route takes an explicit release and never defaults to `STUDIO_RELEASE`. Advancing that
plane-wide pin is its own decision: it governs every FUTURE provision, not just one upgrade, and it
should follow the same rule the satellite pins follow (mirror what production has proven, not the
newest tag).

## Tenant satellite image pins (cp#126)

Every tenant endpoint is created from a pinned container image, and all four pins live in exactly one
place: `src/satellite-pins.ts`. `src/runpod.ts` decides layout, labels, GPU class and worker counts,
and never decides a version; a test asserts no image literal can come back into it.

**The authority for a pin is what PRODUCTION runs, not what is newest.** A pin mirrors a specific
production endpoint (recorded on the pin, with the date it was read), so a hosted tenant renders on
the line the estate has actually proven end to end. The newest published tag is not that line: its
only evidence is that CI went green. On 2026-07-25 the newest tags were upscale 1.0.5, musetalk 1.0.6
and audio-upscale 1.0.8, and production ran 1.0.4 / 1.0.5 / 1.0.7 -- musetalk 1.0.6 adds an HTTP
serve path production has never exercised, and a paying tenant is not where that gets discovered.

Why this file exists at all: the pins sat at backend 1.0.2 / upscale 0.2.7 / musetalk 0.1.0 /
audio-upscale 0.1.0 for six weeks while production moved on. Nobody was careless; there was simply no
place where a wrong pin could be SEEN. Two checks now make it visible:

```bash
npm run check:pins        # creds-free. Every pin must resolve at GHCR by image name. Runs in CI on
                          # every PR, so a pin at a tag nobody pushed cannot merge.
RUNPOD_API_KEY=... npm run check:pins:prod   # compares every pin to the LIVE production endpoint
```

Exit 1 is a real mismatch. **Exit 2 means the check could not be performed** (no key, network, API
shape) and is never a pass: an unreadable check is an unverified pin.

### The release rule

A satellite release now has a third leg. Pinning both panels is not enough, because the plane pins
tenants too:

1. release the satellite, 2. pin the production endpoint, 3. **run `check:pins:prod`; when it goes
red, move `src/satellite-pins.ts` to what production now runs and re-read the `mirrors` dates.**

### What a pin change does and does not reach

A pin change applies to endpoints created AFTER it ships. It does **not** retroactively move a live
tenant: their endpoints were built from the pins of the day, and the plane cannot repin them, because
the RunPod key that could (KEY A) is used once at provision and never stored (see key custody above).
Moving a live tenant onto newer images is therefore a tenant-side or operator-side action against
that tenant's own account, not something this plane can do on their behalf.

And when any endpoint IS repinned, the repin is half the job: a template change leaves the old
workers running the old image and squatting the account worker slots (a 50-minute render stall on
2026-07-25). **Cycle the workers** (`workersMax` to 0 and back), then verify the first job's worker
image and `isStale` via `GET /v2/serverless/{id}/workers` before trusting the run.

## The provision job lease, and why a driver heartbeats it (cp#148, cp#158, cp#132)

A provision does not fit in one Worker invocation, so the poll IS the engine: each `GET
/api/tenant/:id/job` drives the job a little further under its own `waitUntil`, and
`provision_jobs.lease_until` is the arbitration that keeps two polls from driving the same job at
once. Three rules make that safe, and the third one had to be added.

1. **Only the poll that WINS `claimJob` drives.** `claimJob` is a conditional UPDATE, so exactly one
   of any number of overlapping polls matches the predicate.
2. **A job with no progress for 10 minutes is declared LOST** and failed honestly, rather than left
   spinning forever.
3. **A live driver renews its own lease every 20 seconds, for as long as its invocation lives.**
4. **A driver that YIELDS hands the lease back** instead of leaving it to expire (cp#158).
5. **A job no driver has taken yet is not claimable by a poll at all** (cp#132).

Rule 3 is what makes `lease_until` mean *a driver is alive*. Before cp#148 the lease was written only
by `setJobRunning` and by each step `mark()`, so it actually meant *a step boundary happened within
the last 60 seconds*, and ANY unmarked stretch longer than the lease expired it underneath a
perfectly healthy driver. Two stretches are long enough to do that in practice: `runpod_endpoints`,
one uninterrupted call that creates four RunPod endpoints, and the stretch from that mark to
`wfp_upload`, which uploads the studio assets and the worker script. Neither marks anything inside
itself.

The cp#117 rehearsal, read back off prod D1 (job `job_1cc93d7e8d7cf62a78d79441`), shows what follows.
Its `steps_done` runs THROUGH `runpod_endpoints`: the driver survived the slow RunPod call (about 87
seconds) and recorded it. Its `error_step` is `wfp_upload`, which is `inferStep` over those five
completed steps, so the poll that killed the job ran AFTER that mark, during the studio upload, with
the lease lapsed a second time. It won the free claim and ran `continueProvisionJob` -- which refuses
anything short of `wfp_upload` -- and that refusal wrote `finishJob(failed)` plus
`setTenantStatus(failed)` plus a destructive rollback, while the driver was in all likelihood still
uploading. The job was not abandoned by its driver; it was taken away from one.

**That the fatal window was the SECOND long stretch and not the first is why the fix is a general
heartbeat** rather than anything specific to `runpod_endpoints`. The vulnerable window is any
unmarked stretch, and a list of which ones are long enough is a thing that stops being true.

### The two columns are different facts, deliberately

| column | question it answers | who writes it |
| --- | --- | --- |
| `lease_until` | is a driver ALIVE right now | `setJobRunning`, `claimJob`, each `mark()`, the heartbeat, and the yield hand-back (which clears it) |
| `updated_at` | when did this job last make PROGRESS | `setJobRunning`, `claimJob`, each `mark()` |

The heartbeat renews `lease_until` and deliberately does NOT touch `updated_at`. Bumping both would
make a driver that is alive but wedged immortal: it would hold the claim forever and never trip the
lost-driver rule. Liveness and progress are separate questions and stay in separate columns.

### Consequences elsewhere, because several guards read the same column

`claimReclaim`, `beginTeardown` and `jobHasLiveDriver` all refuse to act while a provision driver
holds a live lease. They were reading a column that could only say "a step boundary happened
recently", so during a slow `runpod_endpoints` a reclaim could have blanked the tenant resource
columns underneath the running provisioner. Those guards were repaired by the same change, without
being touched.

### A terminal job is a closed record

A driver that lost its job keeps running to the end of its invocation. `updateJobProgress` and
`renewJobLease` therefore both carry `status IN (queued, running)`: a late write cannot overwrite
the terminal step, cannot re-arm the lease on a failed row, and cannot make a finished job read as
live and progressing.

### The yield hand-back (cp#158)

A yield is a driver saying it is out of invocation budget with work left, and it is the normal way a
provision crosses more than one invocation. The driver was leaving its lease behind on the way out:
the last `mark()` had just re-armed it for a full `JOB_LEASE_SECONDS`, so the job sat un-drivable for
up to a minute in which nothing at all was driving it. Pure latency, added to a provision, per yield.

`releaseJobLease` is the cure and it is deliberately small: the driver that knows it is leaving
clears its own lease, and the next poll claims immediately. Two properties are carried over from the
heartbeat verbatim -- it leaves `updated_at` alone (a yield is not progress, and bumping it would push
out the moment an unresumed job is declared lost), and it refuses a terminal job (a closed record is
not writable by a driver that already lost it). The heartbeat is stopped BEFORE the release, or a
beat still queued behind the write re-arms the lease that was just cleared.

One consequence worth naming rather than discovering: `checkSlugAvailability` refuses a reclaim while
a provision lease is live, so during that stale minute an owner re-provisioning their own slug got
"that name is still being set up; try again in a minute" while no driver existed. They now get the
reclaim. That is the column telling the truth, which is the whole point of cp#148.

### The upgrade drivers heartbeat too (cp#158)

`upgradeTenantModules` and `upgradeTenantStudio` run the same `startLeaseHeartbeat`. The studio
upgrade in particular marks only at step boundaries and its steps are unbounded remote work (a
migration set, an asset upload session, the script PUT), so any one of them running past the lease
used to make the row read as driverless. Nothing poll-driven claims those job kinds, so no job gets
stolen; what breaks instead is the ONE-WRITER guard, since the route refuses a second upgrade on
`jobHasLiveDriver`. A lapsed lease there admits a second driver PUTting different bytes into the same
LIVE studio script, which is the one way that route reaches a state nothing recorded.

### A poll may not claim a job no driver has taken yet (cp#132)

Every job kind is INSERTed `queued` with a NULL lease, and its driver is dispatched by the same
request under `waitUntil`. The heartbeat cannot cover the window between those two facts, because the
window opens before the first beat exists. Inside it `claimJob` matches on status and a free lease,
so an early poller -- a second tab, a script, a curl loop, an operator rehearsal -- wins the claim
outright. On a provision that win is destructive: the winner runs `continueProvisionJob`, which
refuses anything short of `wfp_upload` by writing `finishJob(failed)` + `setTenantStatus(failed)` +
a rollback that DELETES the D1, bucket and token the real driver is at that moment creating. The
claim also makes the driver own `setJobRunning` miss its predicate, so the row never records that a
driver arrived at all.

`driveJobIfNeeded` therefore declines a `queued` job: report it, drive nothing, write nothing.
`queued` is the honest test rather than a timing heuristic, because `setJobRunning` is the only
writer of `running` and it is the first store call every driver makes. A `running` job with a lapsed
lease is the other case entirely and is still claimed, since cp#148 made that state mean the driver
is genuinely gone.

The cost is paid on the rare job whose driver never arrives at all: it is now the 10-minute
lost-driver rule that ends it rather than a poll racing it. That is the asymmetry that decides every
lease question here -- a slow honest refusal costs a wait, and a fast wrong one costs a customer
their half-built studio.

### What has NOT changed

The first-poll delay is untouched. A poll that arrives later changes discovery time, not outcome, and
an EARLIER first poll would have made the old race more likely rather than less. The yield BOUNDARIES
are untouched as well: `runpod_endpoints` still suppresses the yield and carries through to
`wfp_upload` in the same invocation, because a job yielded between those two is unresumable by a
keyless poll. cp#158 changed what a yielding driver does with its LEASE, not where it may yield.

## Verifying changes

```bash
npm run typecheck                 # the CI gate
npm test                          # the whole suite
npm run check:pins                # tenant image pins resolve at GHCR
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

## Taking the tier OFF a studio (cp#136, criterion 3)

`POST /api/admin/tenants/:id/video-finish-binding` with `{ "attached": false }` detaches the
video-finish binding; `{ "attached": true }` puts it back.

**Why it exists**, and it was found by running a drill rather than by reading code: every binding
writer in this plane either ATTACHES the tier or PRESERVES it. The provision path attaches it
whenever `VIDEO_FINISH_VPC_SERVICE_ID` is set, `refresh-studio-bindings` always appends it, and the
studio upgrade carries every censused binding forward as `inherit`. So a tenant that HAS the tier
could never be returned to the tier-absent state the panel sentence describes, and the cp#136
acceptance criterion (a human READS that sentence on a live studio) had no honest path at all. The
testbed proved it: the mark refused with `studio_reader_absent` because the studio serves `{}`,
which means the tier is bound and observed available, correctly.

**It is not a hand patch.** A settings PATCH that omits a binding DROPS it, which is exactly the
failure the attach path exists to prevent, so the detach runs through the SAME
census-then-inherit-everything machinery with the same readback through the other credential. The
only difference from the attach path is which single binding is left out.

**The attach direction is the cp#112 call itself**, not a second implementation. That is what makes
"reattach restores exactly what a refresh produces" true by identity rather than by imitation, and
it means the attach side keeps its own refusals.

**Detach deliberately does NOT require `VIDEO_FINISH_VPC_SERVICE_ID`.** It does not name a service
id, so a plane that has lost its tier configuration can still take the tier off a tenant, which is
the direction you want to be able to move in when something is wrong.

### One truth at a time

Both directions refuse with `video_finish_declared` (409) while the tenant carries a cp#136
declaration:

- **Attach** is the one that carries weight. Attaching the tier to a studio the record says nobody
  can reach makes that record false the moment it succeeds. The panel would be fine either way (an
  observed binding beats the label, so no reader is lied to), which is precisely why the plane has
  to catch it: the harm is a record quietly disagreeing with the world, and no reader surfaces that.
  The guard lives in the SHARED preflight, so `refresh-studio-bindings` inherits it too; a guard
  that covered only the newer route is one somebody routes around by using the older one.
- **Detach** refuses for symmetry rather than for rescue. The reader floor on the mark route already
  makes it impossible to DECLARE a studio whose tier is bound, so a declared tenant is normally
  tier-absent already and this refusal is a convergence no-op. It is there so nobody has to
  re-derive that at 3am.

The drill order follows from the guards: **detach, then mark, read, clear, then reattach.**

| Refusal | When |
| --- | --- |
| `provisioner_unconfigured` (503) | no provisioner wiring on this deploy |
| `not_found` (404) / `tenant_deleted` (404) | unknown or deleted tenant |
| `invalid_body` (400) | `attached` is not a boolean |
| `job_in_progress` (409) | a provision or upgrade holds a LIVE lease; this patch must not race an upload |
| `not_provisioned` (409) | no studio script recorded |
| `video_finish_declared` (409) | a cp#136 declaration stands; clear it first |
| `video_finish_unconfigured` (409) | ATTACH only: the plane has no service id to attach |
| `vpc_binding_unauthorized` (409) | the SCRIPT UPLOAD credential lacks Connectivity Directory access |

A readback that disagrees with the intent answers **409, not 200**. No bytes, no release, no status
write; the tenant serves throughout.

## Declaring a studio UNREACHABLE for the video-finish tier (cp#136)

The studio panel resolves three states for the tier (`vivijure-cf/src/video-finish-availability.ts`):

| state | meaning | how the panel decides |
| --- | --- | --- |
| `available` | the tier is bound | it OBSERVES `VIDEO_FINISH_VPC` |
| `provisionable` | absent, but somebody can attach it | the default for any unbound studio |
| `unprovisionable` | absent, and no operator action reaches this studio | the var `VIDEO_FINISH_TIER_STATE` |

Until cp#136 **nothing in this plane ever wrote that var**, so the third state could not occur in
production: every unbound studio read the "not yet provisioned" sentence whether or not that promise
could be kept for it. This is the writer.

### Why it is DECLARED and not derived

There is no plane-side condition that computes unreachability. With `VIDEO_FINISH_VPC_SERVICE_ID`
set the studio gets the binding and resolves `available` by observation; with it unset an operator
can set it and reach the studio through `refresh-studio-bindings` (cp#112), so "not yet" is a
promise that can still be kept. **Every derived writer writes `provisionable` forever**, which is
the original bug with more code in front of it.

The nearby-sounding condition is a trap worth naming: the finish tier being **down** is transient,
and the sentence this state displays ("cannot be turned on for it") is permanent. Wiring an outage
to a permanent claim would tell every tenant the tier can never be turned on, and keep saying it
after the container came back.

### One writer, one source of truth, projected at every write

`tenants.video_finish_unreachable` (migration 0011, with its reason and timestamp) is the RECORD.
`VIDEO_FINISH_TIER_STATE` on the studio is a PROJECTION of that record, re-derived at every write to
the studio: the provision upload, the studio-upgrade re-upload, and this route.

Re-derived rather than carried, and that is the part that is easy to get wrong. The upgrade path
carries every censused binding forward as `inherit`, which PRESERVES a var rather than dropping it,
so a tenant whose declaration was CLEARED would keep displaying the sentence across the next bytes
move. Both write paths therefore strip this var out of the carried set and re-add it from the
record. A non-secret binding omitted from an upload or patch is DROPPED (measured, cp#112), so
omitting IS the clear, and the studio converges in both directions.

### What clears it

1. **This route, explicitly**: `unreachable: false` drops the record and the studio var with it.
2. **The binding arriving, implicitly**: the panel lets a bound tier beat any var (an observation
   beats a label), so a studio that becomes reachable stops displaying the sentence even before
   anyone clears the record.

```
POST /api/admin/tenants/ten_abc123/video-finish-tier-state
Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN

{ "unreachable": true, "reason": "the CF account holding this studio is gone" }
```

A reason is MANDATORY when declaring and meaningless when clearing. A declaration nobody can explain
cannot be reviewed, and this one makes a studio tell its user a capability can never be turned on
for them; the same standard `0010_preservation_holds.sql` sets for a hold.

### The reader floor, which is a refusal and not a warning

Setting the var on a studio whose bundle predates the READER is a silent no-op: the reader landed in
`vivijure-cf` `ba61789`, first tagged **v1.9.0**. That is the cf#98 / cf#118 / cp#112 failure family
(a change that looks applied and reaches nobody) and this route refuses to join it.

**Which studios it bites** (checked against prod D1 on 2026-07-26, not assumed from the issue that
filed this): the live tenant `rollins-e2e` is at v1.9.0, moved in place by cf#248, so the floor does
not fire on it. That does not make it ornamental. It guards any tenant whose bytes lag the plane,
which every provision can be between a release and its rollout, and it is written against the
CAPABILITY rather than against a named tenant so a corrected fact about one studio cannot make it
wrong.

The check is NOT a version-string comparison. It asks the studio what it serves and requires
`capability:video-finish` to be present in `host.hooks_unavailable` on `GET /api/modules` before it
will write. A served field is the tenant assertion about itself; a release number is our claim about
it. The floor applies to DECLARING only: clearing is always allowed, because un-saying something
must not be gated on a probe that has nothing to do with un-saying it.

### Refusals, all before anything is written

| Refusal | When |
| --- | --- |
| `provisioner_unconfigured` (503) | no provisioner wiring on this deploy |
| `not_found` (404) | unknown tenant |
| `invalid_body` (400) | the body does not state an intent (`unreachable` is not a boolean) |
| `reason_required` (400) | declaring without a reason |
| `job_in_progress` (409) | a provision or upgrade holds a LIVE lease; this patch must not race an upload |
| `not_provisioned` (409) | no studio script recorded, so there is nothing to project onto |
| `tenant_deleted` (404) | the tenant no longer exists |
| `tenant_studio_token_missing` / `tenant_studio_token_unreadable` (422) | the studio cannot be asked what it serves |
| `studio_not_serving` (422) | the studio did not answer `/api/modules` with readable JSON |
| `studio_reader_absent` (422) | THE FLOOR: the studio does not serve the capability key, so the var would reach nobody |

### What comes back

A READBACK through a different credential than the one that wrote, plus the reader half:
`var_present_before` / `var_present_after`, `bindings_before` / `bindings_after`, `secrets_before` /
`secrets_after`, `missing_bindings` / `missing_secrets`, and `served_reason_before` /
`served_reason_after` / `served_reason_changed`.

The served fields are what make this more than a binding census: the plane can prove it bound a var,
but only the studio can prove the PANEL projection changed. The plane reports those sentences
verbatim and never compares them against a copy, because the copy belongs to `vivijure-cf` and a
second copy here would be a drift source with no owner.

**A readback that disagrees with the intent answers 409, not 200.** The tenant keeps serving
throughout: no bytes, no release change, no status write.

### What this does NOT do

It does not put a live studio into the state. Two things are needed for that, and only one of them
is now satisfied:

- **A bundle that can observe the var.** Met: the live tenant is at v1.9.0 (cf#248).
- **The tier UNBOUND on that studio.** Still a property of the design rather than a gap: the panel
  lets an observed binding beat any label, so a bound studio cannot display the sentence at all, and
  this route refuses to declare on one instead of writing a var that would sit there inert. The
  testbed IS bound today, which is why the drill needs the detach route documented above; that is now
  a supported operator action rather than a hand patch.

Plus the sentence read by a human. That leg is tracked on cp#136.

## Where a reporter is sent: the tenant-studio abuse link (cp#164)

Enforcement on the hosted tier is **report-driven by ruling**: nothing is scanned, so a report from
a person is the entire detection surface. That makes a findable intake path part of the product, and
the surface where hosted content is actually SEEN is the tenant studio panel.

`vivijure-cf` **v1.10.0** shipped the reader (`src/abuse-contact.ts` validates `ABUSE_REPORT_URL`,
`src/index.ts` projects `host.abuse_report_url` onto `GET /api/modules`, `public/abuse-link.js`
renders from that sole signal). This plane wrote the var **nowhere**, so the reader shipped with
nothing to read.

### The value is DERIVED, not configured

The intake page is served by this Worker, out of `public/report-abuse.html`, at the host this plane
already holds as a single fact (`CONTROL_PLANE_HOST`). So the URL is a fact of the deploy rather
than an operator preference, and it is derived through `publicOrigin()` like `PUBLIC_ORIGIN` and the
tenant domain suffix. A second env var beside it could disagree with the page we actually serve; a
derivation cannot. It is also what keeps this parity-correct: another operator running this plane on
their own host gets THEIR intake page, with no hardcoded hostname anywhere in the code.

The canonical path is `/report-abuse` (verified live 2026-07-27: `GET /report-abuse` is 200 and
`/report-abuse.html` 307s to it). We bind the 200.

### Hosted-only, and it is load-bearing

A self-hosted studio must **never** advertise our abuse address: we are not the provider for a
self-hoster, we cannot see their studio and cannot act on their content, so sending a reporter to us
is worse than sending them nowhere. That property is structural rather than remembered: the value is
computed from control-plane env, inside the control plane, and the studio bytes uploaded to a tenant
are the published release unmodified. Nothing on this path can reach the bundle a self-hoster
installs. Their unset var renders nothing, which stays correct mid-rollout for a hosted tenant we
have not converged yet.

### Three write paths, because one door leaves the estate split

| Path | Reaches |
|---|---|
| `runProvisionJob` studio upload | every NEW tenant |
| `upgradeTenantStudio` (cp#139) | any tenant whose bytes move, as a side effect |
| `POST /api/admin/tenants/:id/abuse-report-url` | a tenant already LIVE, without moving bytes |

The third is the cp#112 / cp#136 lesson applied: a route that only reaches new tenants leaves every
existing tenant permanently unable to display the link.

```
POST /api/admin/tenants/ten_abc123/abuse-report-url
Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN
```

No body: there is nothing to choose. The operator is not setting a value, they are asking a studio
to catch up with the plane. It is a **binding patch, not a re-upload**, for the cp#112 reasons
above (two of the four tenant secrets cannot be reproduced, and a re-upload would smuggle a release
change in as a config fix), so it changes no bytes, no release and no status.

The var is **re-derived** at every write, never inherited: `inherit` preserves what is bound, which
is exactly wrong for a projection, and a studio carrying a URL from a plane that no longer publishes
that page would keep advertising a dead one. Omitting a non-secret binding DROPS it (measured,
cp#112), so the studio converges in both directions.

### The reader floor is a READBACK, not a version compare

Setting the var on a studio whose bundle predates the v1.10.0 reader is a silent no-op. cp#136
guards its var with a PRE-write capability probe; that shape is unavailable here, because the panel
emits `host.abuse_report_url` **only when the var is already set**, so its absence beforehand proves
nothing. The honest check runs the other way: write, then ask the studio what it serves. A studio
that echoes the URL back has proven the reader is live in the bytes it runs.

### The readback RACES edge propagation (measured, 2026-07-27)

The first live converge on `rollins-e2e` bound the var cleanly (19 bindings to 20, nothing stranded,
all four secrets intact) and the studio served no `host.abuse_report_url`. Sixty seconds later the
same call returned `reader_live: true` with the URL, twice in a row. Nothing about the studio
changed: the settings PATCH had simply not reached the isolate answering the next dispatch.

That is the cf#114 lesson from a new direction ("the secrets PUT returning 200 does NOT mean the
edge serves the key yet"), and the first cut of this route did not apply it to its own readback. The
cost was in the wrong direction: it answered 409 and told the operator to move a live tenant's bytes
to fix a problem that did not exist. The confirm is now bounded-retried
(`READBACK_PROBE_MS` / `READBACK_BUDGET_MS`), and the response carries `readback_attempts` and
`readback_elapsed_ms` as numbers.

### Three outcomes

| status | meaning |
|---|---|
| **200** | bound AND the studio serves it |
| **202** | bound, nothing stranded, not yet observed within the confirm budget |
| **409** | a genuine STRAND: a binding or secret present before and absent after |

The 202 names BOTH possible causes, because from the plane they are indistinguishable: the edge has
not picked the binding up yet, or the bundle predates the v1.10.0 reader. It says re-run first (this
route is idempotent, so that costs nothing) and move the studio bytes only if a re-run still reports
it. `ok` and `reader_live` both stay false there, so nothing machine-readable claims a success that
was not observed. 202 is the same shape the invoke-key route already uses for "stored, not yet
proven".

`ABUSE_REPORT_URL` is deliberately `conditional` rather than `provisioned` in
`src/tenant-studio-env.ts`. `provisioned` joins `REQUIRED_TENANT_STUDIO_VARS`, which the MODULE
upgrade re-checks in its verify census, and that path never touches studio bindings, so requiring it
would fail an unrelated module upgrade on every tenant not yet converged. A studio without the var
is fully functional; the panel renders no link, which is the deliberate behaviour and not a degrade.

## Capping what a tenant can store: `R2_STORAGE_QUOTA_BYTES` (cp#183)

`SPEND_DAILY_CEILING` caps what a tenant can spend in a day. It does not cap what a tenant can
ACCUMULATE, and storage is the bill that keeps arriving after the rendering stops (and, for a tenant
who leaves, the one we inherit). vivijure-core v1.3.0 shipped the enforcement (core#52) and
vivijure-cf v1.11.0 wired it; this plane bound the var to nobody, so hosted shipped the feature and
enforced it on no tenant. cp#183 is the plane half.

### What the studio does with it

`R2_STORAGE_QUOTA_BYTES` is a positive integer count of BYTES. The studio accounts every object
write in its own D1 at write time (per object key, so re-writing a key updates its row rather than
double counting) and checks at SUBMIT:

| State | Behaviour |
|---|---|
| unset / empty / `0` / garbage | quota OFF, submits proceed |
| a positive integer, under it | submits proceed |
| a positive integer, at or over it | **507** with both real numbers in the message |
| set, but the check itself cannot run | **503**, fail-CLOSED |

Enforcement is at submit only: a tenant over its ceiling keeps every byte it has, and nothing is
truncated or half-rendered. `GET /api/storage/usage` on the studio reports `used_bytes`, `objects`,
`quota_bytes` and `over`; `POST /api/storage/reconcile` rebuilds the ledger from the bucket (the
one-time backfill for a studio whose accounting started mid-life).

### TWO tenant classes, so the plane number is a DEFAULT rather than the answer (cp#173)

The core knob is a submit-time DENY. That is a hard cap by construction, and which tenants that is
right for is a product question, not a plumbing one:

| Class | Bound by | The knob |
|---|---|---|
| BYOK, self-host | nothing else -- they pay us no GPU while their R2 sits on our bill | the byte ceiling IS the cost-recovery mechanism |
| Prepaid (cp#173) | their CREDIT BALANCE, in the right unit, in the credit ledger | **unset**: a hard cap would deny at exactly the byte where charged overage begins |

Binding a hard ceiling to a prepaid tenant makes overage unreachable code and refuses service to
somebody **holding credits**, by a cap they were told did not exist. So every tenant can override the
plane default, including overriding it to no ceiling at all:

| `tenants.r2_storage_quota_mode` | Effective ceiling |
|---|---|
| NULL | inherit the plane default (the ordinary state) |
| `set` | `r2_storage_quota_bytes`, whatever the plane says |
| `none` | NO ceiling, whatever the plane says |

**`NULL` and `none` are different facts and are stored differently on purpose.** Both bind nothing
while the plane default is unset, and they diverge the moment an operator sets one: the inheriting
tenant gets a hard cap, the deliberately-uncapped one must not. A single nullable number would spell
them identically, which is exactly how a prepaid tenant silently inherits a cap.

The record is the source of truth and the studio var is a projection re-derived at every write, so a
routine studio upgrade cannot re-cap a tenant somebody uncapped. One resolution seam
(`resolveStorageQuota`) is used by all three write paths, so they cannot disagree about the answer.

A malformed plane var blocks a tenant who would have INHERITED it, and deliberately does not block
one who overrode it: that tenant was never going to read the value.

### What a tenant is BORN with, and where an operator changes it

A tenant is born with **whatever `TENANT_R2_STORAGE_QUOTA_BYTES` says on the plane at the moment it
is provisioned** unless its row already records a decision, and with **no ceiling at all when that
var is unset**. There is deliberately no
default in code, on either host: the number prices what an operator is willing to carry per tenant,
which is policy this repository does not get to invent, and a fallback here would be a pricing
decision hidden in a config read. Unset behaves exactly like `R2_USAGE_ALERT_BYTES` unset.

An operator changes it in ONE place, the deploy config:

```
gh variable set TENANT_R2_STORAGE_QUOTA_BYTES --repo skyphusion-labs/vivijure-control-plane --body 107374182400
```

then redeploys. The var must appear in all four lists or it ships INERT (`wrangler.toml.example`,
`scripts/render-wrangler.sh` ALLOW_EMPTY, and BOTH `deploy.yml` render env blocks);
`scripts/var-census.py` asserts the four agree and fails the build otherwise.

Bytes only, no unit suffixes: a mis-parsed unit is an order-of-magnitude error on a bill.
`107374182400` = 100 GiB, `1073741824` = 1 GiB.

**A malformed value REFUSES rather than rounding down to off.** The studio parses `100GB` and `""`
identically (quota off), which is right for a studio and dangerous for the plane, because it makes
"typed it wrong" and "wants no ceiling" the same outcome while the operator believes tenants are
capped. So a non-empty value that is not a positive integer refuses the provision, refuses a studio
upgrade preflight, and refuses the converge route, each naming the raw value.

### Three write paths, because one door leaves the estate split

| Path | Reaches |
|---|---|
| `runProvisionJob` studio upload | every NEW tenant |
| `upgradeTenantStudio` (cp#139) | any tenant whose bytes move, as a side effect |
| `POST /api/admin/tenants/:id/storage-quota` | a tenant already LIVE, without moving bytes |

The var is **re-derived** at every write, never inherited. `inherit` preserves what is bound, which
for a projection of plane config is exactly wrong: a plane that RAISED or LIFTED its quota could
otherwise never move it on a live tenant, and the ceiling would be a one-way door. Omitting a
non-secret binding DROPS it (measured, cp#112), so the studio converges in both directions,
including all the way back to uncapped.

```
POST /api/admin/tenants/ten_abc123/storage-quota
Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN

{}                                  converge only: push the RECORD onto the studio, decide nothing
{"mode":"inherit"}                  clear the override; follow the plane default
{"mode":"set","quota_bytes":"500"}  this tenant enforces 500 bytes
{"mode":"none"}                     this tenant has NO ceiling (the prepaid class)
```

An empty body changes no decision, which is what makes a re-run safe. `inherit` and `none` are
separate words because they are separate facts.

The RECORD is written first, and only after the preflight has proven the studio can receive the
projection. Both halves of that order were chosen: writing before the preflight would leave the
plane remembering a decision it could not deliver (the cp#136 ordering), and writing after the
studio patch would leave a studio enforcing a number the record does not know about, which the next
upgrade would silently revert.

A binding patch, not a re-upload, for the cp#112 reasons (two of the four tenant secrets cannot be
reproduced, and a re-upload would smuggle a release change in as a config fix), so it changes no
bytes, no release and no status.

### The reader floor is a PRE-write probe here, unlike cp#164

A studio carrying the core#52 reader serves `GET /api/storage/usage` whether or not a quota is
configured, so a 404 on that route proves the reader is absent. The preflight therefore REFUSES a
studio whose bundle predates vivijure-cf v1.11.0 (`studio_predates_quota_reader`) BEFORE writing
anything, instead of binding a ceiling nothing enforces and diagnosing it afterwards. That is the
one thing this var can do that `ABUSE_REPORT_URL` could not, and it closes the silent-no-op family
(cf#98 / cf#118 / cp#112) at the front rather than at the back.

### Green means the STUDIO said so

The route answers on the READBACK, not on the binding patch: after the write it asks the studio what
`quota_bytes` it reports and compares that to what was bound.

| Status | Meaning |
|---|---|
| 200 | bound AND the studio reports the ceiling. `enforced: true`. |
| 202 | bound, nothing stranded, studio had not reported it inside the confirm budget. `ok` and `enforced` both FALSE. Re-run; it is idempotent. |
| 409 | a genuine strand (a binding or secret present before and absent after), or a preflight refusal. |

The 202 exists for the same measured reason as cp#164: a settings PATCH returning 200 does not mean
the isolate answering the next dispatch has it yet. Unlike cp#164 it cannot mean "the bundle is too
old", because the preflight already read the reader off this studio.

`quota_source` says WHERE the answer came from (`tenant`, `tenant_none`, `plane`, `plane_unset`) and
`record_written` says whether this call changed the decision or only converged the studio onto it.
"No ceiling" from a deliberate uncapping and "no ceiling" from a plane that configures none are
different states, and a number alone cannot tell them apart.

`over_on_arrival` is reported when the tenant is already past the ceiling it was just given. That is
not an error and not a rollback: the data is untouched and only the next submit denies. An operator
lowering a ceiling under a heavy tenant should see it in the answer rather than in a support ticket.

## Finishing a repair: the owner-completed invoke-key handoff (cp#169)

`POST /api/admin/tenants/:id/reprovision-runpod` (cp#137) rebuilds a live tenant's four RunPod
endpoints. New endpoints get new ids, so the tenant's stored key B is scoped to ids that no longer
exist, and every repair ends at "install a fresh invoke key" -- a SESSION-gated route, because the
admin bearer is honoured only under `/api/admin/`. **The operator who performed the repair could not
finish it.** Observed live during the cp#137 remediation: a correctly-scoped key in the operator's
hand, and the tenant sat at `awaiting_invoke_key` until the account owner signed in.

**Conrad's ruling (cp#169): PATH 3, operator-initiated and owner-completed.** "As convenient as
possible while maintaining operator action." The INITIATIVE moves to the operator; the CREDENTIAL
DECISION stays with the owner. An admin-gated install (option 2) was declined deliberately: it would
let an operator credential place a RunPod key on a customer studio, which is the custody expansion
the two-key design exists to prevent.

### The flow

1. A successful reprovision mints a one-time link **in the same response that reports the repair**,
   bound to the endpoints that run created (the tenant is re-read AFTER the rebuild).
2. `POST /api/admin/tenants/:id/invoke-key-handoff` mints one on demand, for a tenant stranded by a
   repair that predates this, a link that expired in a support queue, or a link made stale by a
   second reprovision. Re-running a repair to obtain a link would rebuild four endpoints to solve a
   paperwork problem.
3. The operator hands the link to the customer through their support channel. **No email
   integration in this pass, deliberately parked.**
4. The owner opens `/install-key?t=<token>`, reads what happened and which four endpoints to scope,
   and pastes their own key. `GET /api/handoff/invoke-key` serves that context and does NOT consume
   the link.
5. `POST /api/handoff/invoke-key` installs it, through the same code the session route runs.

```
POST /api/admin/tenants/ten_abc123/invoke-key-handoff
Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN

-> { "id": "ikh_...", "url": "https://<host>/install-key?t=...", "expires_at": "...", "endpoints": [...] }
```

The `url` is the ONLY time the token exists outside the plane. It is not logged and not audited: a
lost link is re-minted, never recovered.

### What the link can and cannot do

It authorizes ONE install on ONE tenant. The key offered still has to pass `verifyInvokeKeyScope`
**unchanged** -- refused if it can reach graphql, and required to reach all four of that tenant's
endpoints. Those endpoints live in the TENANT's own RunPod account, so **a stranger holding the link
and no credential to that account can install nothing.** The security bound is RunPod's scoping; the
72-hour expiry only stops a link lingering in a support thread. That check is the whole custody
story (cp#169 says so explicitly), so there is exactly ONE implementation of the install
(`performInvokeKeyInstall`) and both routes call it -- identity rather than imitation.

### Storage, audit, and single use

- D1 holds the SHA-256 of the token and nothing else of it (`invoke_key_handoffs`, migration 0012),
  the rule `login_tokens` and `sessions` already follow.
- BOTH ends are audited: `tenant.issue_invoke_key_handoff` and
  `tenant.install_invoke_key_via_handoff`, correlated by the handoff `id`, which is not part of the
  secret. Neither row contains the token or the key.
- **Single use is burned on a COMPLETED install only.** A rejected key must not burn the link (a
  typo would re-strand the customer, which is the failure this issue is about), and neither must the
  202 "modules have not picked it up yet" path, whose own instruction is to RETRY. Consumption goes
  through the store's conditional UPDATE, so two concurrent completions cannot both count.

### Staleness, and why it is refused rather than tolerated

A handoff is bound to the endpoint ids that existed when it was issued. If the tenant is
reprovisioned again before the link is used, those ids are dead, and an install verified against
them would store a key scoped to endpoints that no longer exist -- the exact state the handoff exists
to repair, re-entered through the mechanism meant to fix it. The resolve path refuses with
`handoff_endpoints_changed` and says a new link is needed. The comparison is a SET comparison: the
provisioner emits a fixed order, but depending on the order would refuse a link that is genuinely
fine.

### Deploy ordering

Migration 0012 is a pure `CREATE TABLE`, so it is additive and the workflow's migrate-then-deploy
order is safe: old code tolerates the new table, and the new code refuses honestly against a
database that has not got it yet only if the deploy order were reversed, which the workflow does not
allow (it verifies no migrations remain pending BEFORE it deploys the worker).

## Preservation holds: the interlock on the irreversible lever (cp#118)

`ABUSE-RESPONSE-RUNBOOK.md` Section 5.2 forbids teardown on a tenant with an open report or
preservation duty. Until this existed, the only thing enforcing that was an operator remembering the
paragraph, which is a procedural control where a technical one belongs: destroying material held
under 18 U.S.C. 2258A(h) is crime-adjacent, not merely embarrassing.

**Suspend remains the lever for an open incident** (instant, reversible, audited, destroys nothing).
A hold is what stops the OTHER lever from being pulled by mistake.

| route | does |
| --- | --- |
| `GET /api/admin/tenants/{id}/preservation-holds` | every hold, released ones included -- a closed duty is part of the record |
| `POST /api/admin/tenants/{id}/preservation-holds` | opens one. `reason` **mandatory**, `kind` validated, audited as `tenant.preservation_hold.open` |
| `POST /api/admin/tenants/{id}/preservation-holds/{hold_id}/release` | releases one. `reason` **mandatory**, single-use, audited as `tenant.preservation_hold.release` |

### The kinds, and why this is a table rather than a column

Two statutory clocks can run on the SAME tenant at the SAME time, and 2258A(h)(4) says they do not
limit each other. One column cannot carry two clocks, two reasons and two openers.

| kind | clock | starts |
| --- | --- | --- |
| `ncmec_2258a_h` | **1 year** (2258A(h)(1) as amended by Pub. L. 118-59; 90 days is repealed text for this clock) | our CyberTipline submission |
| `le_2703_f` | **90 days**, renewable for a further 90 (2703(f)) | a governmental preservation request |
| `internal` | none until one attaches | a report arriving, before triage |

`expires_at` defaults from the kind and can be supplied explicitly; an `internal` hold gets none
rather than an invented one.

### An elapsed clock does NOT release the hold

The interlock keys on `released_at IS NULL` alone. `expires_at` is the **floor** of the duty, not an
instruction to delete: 2258A(h)(5) permits preserving longer and 2258B(c) puts destruction on a law
enforcement request rather than on a timer of ours. An elapsed hold still refuses, and the refusal
says so, because a clock that silently unblocked evidence destruction would be the same defect this
interlock closes, wearing a calendar.

### What teardown does while a hold is open

`teardownTenant` checks FIRST, before the referential guard and before any delete, and refuses the
**whole pass** -- not the data legs only. The runbook does not say tear down carefully while a report
is open; it says do not tear down. Pulling the worker while sparing the bucket would also remove the
studio an investigation may still need to reach.

The refusal uses the guard vocabulary (`refused:`), so the teardown route reports it under `refused`
rather than `failed`: it is the interlock working, and there is nothing to retry. The only way past
is a human releasing the hold, with a reason, in an audit row. If the store cannot answer whether a
hold is open, teardown **fails closed** and reaps nothing.

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


## Reconciling a tenant record against RunPod (cp#137)

The plane records the RunPod endpoints of a tenant in `tenants.endpoints_json` and, until this,
nothing ever compared that record to RunPod. cp#137 found the consequence live: the standing testbed
read `status=live` while all four endpoints it names returned 404. A status column says
"provisioning completed once"; it has never said "renders today".

**This is detection, and only detection.** `POST /api/admin/reconcile/runpod` reads two lists and
returns a report. It writes nothing, not even an audit row: a pass that can alter what it measures is
not a measurement. Deleting an orphan or re-provisioning a tenant is separate, lead-approved work.

**Why the operator brings the RunPod half.** The plane holds no credential that can read the RunPod
account of a tenant, deliberately: key A (graphql read/write) is used once at provision and never
stored, key B is invoke-only and transient here. So the plane cannot poll RunPod, a background
reconciler is not buildable without breaking that custody boundary on purpose, and the snapshot
arrives in the request body from an operator who read RunPod with their own key.

```
set -a; . ~/your-runpod.env; set +a          # RUNPOD_API_KEY, never echoed
export CONTROL_PLANE_ADMIN_TOKEN=...          # the plane admin token
node scripts/reconcile-runpod.mjs --plane https://studio.vivijure.com --account-label prod
node scripts/reconcile-runpod.mjs --dry-run   # gather and print the snapshot, post nothing
```

Exit 0 = clean, 1 = real drift, 2 = the check could not be PERFORMED. 2 is never a pass.

### Both debris layers, always

Deleting an endpoint does NOT delete the template it was built from (the cp#117 drill: four
orphaned endpoints were deleted and four orphaned templates appeared underneath them). Any sweep
that enumerates endpoints only removes half the debris while reading as complete, so this compares
records against BOTH lists and labels every finding with the layer it came from.

| finding | layer | what it means |
| --- | --- | --- |
| `record_endpoint_missing` | endpoint | the record names an endpoint RunPod does not have: the tenant cannot render that step (the cp#137 case) |
| `record_endpoint_renamed` | endpoint | the id exists under a different name; provisioning adopts BY NAME, so a re-provision would build a second one |
| `record_template_missing` | template | the template under a live endpoint is gone; a re-provision has nowhere to write the fresh R2 credential and refuses with 409 |
| `orphan_endpoint` | endpoint | RunPod holds an endpoint whose only owner is a torn-down record, or that no record claims |
| `orphan_template` | template | the second layer: a template with no live endpoint record, invisible until the endpoints are cleared |
| `record_unreadable` | record | `endpoints_json` cannot be parsed, so nothing about that tenant can be reconciled |

### An unprovable check never reads as a clean one

Absence is a claim about a census. "That endpoint is gone" is sound only if the endpoint list was
whole; "no record owns this" is sound only if the tenant list was whole. So:

- the snapshot MUST state `complete` explicitly (a body without it is refused with 400, because an
  assumed-complete census turns a truncated page into a false absence);
- the plane marks its own census incomplete when `listTenants` returns a full page
  (`TENANT_PAGE_LIMIT`);
- a finding that depends on a census which was not proven whole is reported as
  `confidence: "unproven"` with the reason, and the whole report reads `verdict: "unproven"`, never
  `clean`.

Resources the pass cannot trace to a slug the plane knows are listed under `unattributed` and are
NEVER called orphans. Claiming ownership of a resource we cannot trace is how a later cleanup step
deletes something that was never ours.

### Verifying it

`tests/reconcile-runpod.test.ts` drives the detector from fixtures (both orphan layers, the
truncation guards, and the positive control that a consistent tenant reports clean).
`tests/reconcile-runpod.live.test.ts` runs the SAME function over the live RunPod account and the
live tenants table through the shipping clients, read-only, zero GPU spend:

```
set -a; . ~/.cf-provisioner-full.env; . ~/your-runpod.env; set +a
CF_ACCOUNT_ID=<id> RECONCILE_LIVE=1 npx vitest run tests/reconcile-runpod.live.test.ts
```

It asserts shape and internal consistency, never `clean`: the live account carries known drift, and
a test demanding clean would be a test demanding the bug be fixed before the detector can be trusted.
