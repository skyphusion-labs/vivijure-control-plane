# The platform control plane

The hosted door for vivijure studio (epic #40, skeleton #52). A **separate Worker** from the studio
that deploys independently, exactly like the MCP Worker: `npm run deploy:control-plane`.

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
and never here. `tests/control-plane/schema-guard.test.ts` fails the build if a studio table ever
appears in `migrations-control-plane/`, so the boundary is a test rather than a sentence.

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
  `tests/control-plane/routes.test.ts` (both halves: new signup refused, existing account served).

## Config

Bindings live in `wrangler.control-plane.toml.example` and are mirrored by hand in
`src/control-plane/env.ts` (the standing rule). `account_id` is never hardcoded. The rendered
`wrangler.control-plane.toml` is gitignored, like every other rendered config in this repo.

**Provisioner wiring** (`src/control-plane/deps.ts` `provisionerWiring()`): the provision and
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
   endpoint id (`RUNPOD_ENDPOINT_ID`, plain_text). The catalog (`src/control-plane/tenant-modules.ts`,
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

Naming: **"control-plane", never "platform"**. `src/platform/` is already the host-neutral Platform
ICD, and colliding with it would be a trap for the next reader.

## Verifying changes

```bash
npm run typecheck                 # the CI gate
npm test                          # includes tests/control-plane
npm run dev:control-plane         # live, against a real local D1
```

The in-memory store in `tests/control-plane/memory-store.ts` proves **decision paths only**. It is
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
