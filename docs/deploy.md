# Deploying the control plane

The control plane deploys from a **SemVer tag on this repository**, and only from a tag.

```
# bump both, they are gated against each other
#   package.json  "version"
#   src/version.ts CONTROL_PLANE_VERSION
git commit -am "chore(release): v1.2.3"
git tag -a v1.2.3 -m "control plane v1.2.3"
git push origin main --follow-tags
```

`.github/workflows/deploy.yml` then runs, in this order:

1. `npm ci`, typecheck, tests, config-render guards
2. **tag/version agreement** -- refuses if the tag does not match `package.json`
3. **render `wrangler.toml`** from `wrangler.toml.example` (`scripts/render-wrangler.sh`)
4. **report pending migrations** (`wrangler d1 migrations list CP_DB --remote`)
5. **apply D1 migrations** (`wrangler d1 migrations apply CP_DB --remote`)
6. **verify nothing is still pending** -- fails the deploy if it is
7. **`wrangler deploy`**

## Tag semantics

Split per repository, deliberately (cf#85):

| tag | deploys |
| --- | --- |
| `v*` here | the control plane |
| `v*` in `vivijure-cf` | the Studio panel |

They used to share one repo and one tag namespace. They do not any more; do not reintroduce it.

### Promoting the changelog at release time (READ THIS BEFORE CUTTING A TAG)

Renaming `## Unreleased` to `## vX.Y.Z` is the promotion. **Leave a fresh, empty `## Unreleased`
above it in the same edit.**

That is not tidiness. v1.18.0 was promoted without one, and the next three PRs merged with their
entries having nowhere to land but under a heading that was already released, so `CHANGELOG.md`
asserted that v1.18.0 shipped cp#219, cp#223 and the cp#195 settlement trigger. `git merge-base
--is-ancestor` says none of the three is in the tag. Every one of those PRs was individually
correct; the release process ate them.

`scripts/changelog-released-immutable.py` now refuses that, and runs in
`tests/render-wrangler.test.sh` on every PR. For each `## vX.Y.Z` heading with a matching git tag it
compares the section body against the same section in `CHANGELOG.md` AT THAT TAG. It is a property
of the tree rather than of a diff, so it needs no base ref and it catches an ADDED entry, which no
"did this PR touch the changelog" check ever would.

**The one declared exception, and it takes TWO steps on purpose (cp#245):** a released section MAY
be corrected in place when the original note was WRONG about what shipped, which this repo has
already done once and was right to (v1.17.0 said two PRs when the tag carries four). To do it:

1. add the version to `scripts/changelog-corrections.txt` -- the waiver, one reviewable line;
2. mark the section with a line BEGINNING at column 0 with `**CORRECTED AFTER PUBLICATION` -- what
   tells a reader of the changelog that the text moved after the tag.

Either alone is refused, with different messages, because they are different mistakes: allowlisted
but undeclared is a silent correction, and declared but unlisted is the defect this shape exists to
end. **The waiver deliberately does not live in the changelog.** It used to, as a substring test,
and a v1.19.0 entry that merely DOCUMENTED the mechanism (marker quoted inside backticks) waived
immutability for its own section: the guard found the drift and then permitted it. An escape hatch
held in the content can always be tripped by content that talks about it. Nothing a changelog entry
can say puts a version in that file.

## Migrations: the doctrine

**No hand-applied schema, ever.** Schema reaches the live control-plane D1 through step 5 or not
at all.

This is not a style preference; it is cf#80, twice-proven in one e2e burn. The live D1 was built by
hand, so `0001` went in raw, `0002` was skipped, `0003` was applied after the fact, and there was
no `d1_migrations` ledger to notice. Two live provision failures came out of that single gap: an
AUP accept returning 500 on a missing `aup_sha256` column, and a provision dying at `r2_token` on
`no such column: r2_token_id`. The ledger was reconciled truthfully on 2026-07-17.

The repo schema-guard test cannot catch this class -- it compares code against `migrations/`, never
against the *deployed* database. Only the deploy job does.

### Migrate BEFORE deploy, and why

Deploy-then-migrate leaves a window where new worker code runs against the old schema. That is
exactly the cf#80 failure. Migrate-first is safe **because control-plane migrations are additive**:
old code tolerates a column it does not know about; new code cannot tolerate a missing one.

If a migration is ever non-additive (a drop, a rename, a narrowing), this ordering is **wrong** and
the change needs a two-tag expand/contract instead. Change the migration, not the ordering.

### The expected no-op

On a release that carries no schema change, steps 4-6 print `No migrations to apply`. That line is
the evidence the ledger and `migrations/` agree. Step 6 exists because `migrations apply` exiting 0
only means it did not error -- it does not prove the ledger now matches. A partial apply must not
reach `wrangler deploy` wearing a green checkmark.

## Required Actions configuration

Repository **secrets** (values never appear in this repo or its logs):

- `CLOUDFLARE_API_TOKEN` -- deploy + D1 migrate on the control-plane account
- `CLOUDFLARE_ACCOUNT_ID`
- `CONTROL_PLANE_D1_ID` -- the live control-plane D1 uuid

Repository **variables**:

- `CONTROL_PLANE_HOST`, `CONTROL_PLANE_ZONE_NAME`
- `TENANT_DISPATCH_NAMESPACE`, `TENANT_MODULE_NAMESPACE`
  - **Both namespaces must EXIST before a deploy that binds them**, or `wrangler deploy`
    fails. `TENANT_MODULE_NAMESPACE` is the sharp one: the control plane binds it as of
    cf#114, which closes the provisioner's lazy-create bootstrap, so on a fresh account it
    must be created out of band FIRST. Procedure (check -> create -> verify -> deploy) and
    the post-deploy binding check are in `deploy-runbook.md`.
- `STUDIO_RELEASES_BUCKET`, `STUDIO_RELEASE`
- `AUP_VERSION`, `AUP_URL`, `POSTERN_SEND_URL`
- `GOOGLE_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_ID`
- `APPLE_TEAM_ID`, `APPLE_SERVICES_ID` (empty = Apple SSO is not offered)
- `TENANT_AI_GATEWAY_ID` (cf#56) -- the AI Gateway that tenant MODULE workers bind as `GATEWAY_ID`.
  Set it to **`vivijure-hosted`**, the dedicated hosted-tenant gateway (authentication ON: a valid
  per-tenant token reaches the provider, a bogus one is refused 401 at the gateway).
  **Never `skyphusion-llm`** -- that is prism's gateway, and sharing it would put every tenant LLM
  call in one analytics namespace, defeating the per-tenant attribution the token exists to provide.
  Empty = no gateway named, so `plan-enhance` runs on the free local Workers AI provider.

- `SHARED_RUNPOD_ENDPOINTS` (cp#270) -- the SHARED RunPod endpoint pool, as JSON keyed by
  `PROVISION_PLAN` key:
  `{"backend":{"id":"...","name":"..."},"upscale":{...},"lipsync":{...},"audio-upscale":{...}}`.
  Empty = this plane offers no shared tier and every tenant must bring its own RunPod key, which is
  the behaviour before pooling existed. See the section below before setting it.

#### The shared tier: `SHARED_RUNPOD_ENDPOINTS` + `SHARED_RUNPOD_INVOKE_KEY` (cp#270)

Conrad ruled 2026-08-01 that the hosted SHARED tier never provisions dedicated per-tenant RunPod
endpoints: shared tenants ride the endpoints that already exist. The reason is a hard ceiling --
the RunPod worker quota is ACCOUNT-WIDE, `PROVISION_PLAN` needs 5 net-new workers per tenant, and
teardown structurally cannot reap RunPod endpoints, so the dedicated shape caps the hosted business
at about ten tenants that have EVER existed.

| what | where | note |
| --- | --- | --- |
| `SHARED_RUNPOD_ENDPOINTS` | Actions variable, rendered into `wrangler.toml` | identifiers only; empty = no shared tier |
| `SHARED_RUNPOD_INVOKE_KEY` | worker secret, `wrangler secret put` | Restricted, invoke-only, scoped to EXACTLY the pool endpoints |

**BOTH OR NEITHER.** The wiring resolves a pool only when both are present; either alone logs
`shared_pool.refused` and the plane offers no shared tier. That is deliberate: half a pool is not a
degraded pool, it is a tenant that cannot render.

#### The proxy credential: `RUNPOD_PROXY_SIGNING_KEY` (cp#290)

| what | where | note |
| --- | --- | --- |
| `RUNPOD_PROXY_SIGNING_KEY` | worker secret, `wrangler secret put` | any high-entropy string; signs the per-tenant proxy token |

**It is NOT the RunPod key and the two are not interchangeable.** `SHARED_RUNPOD_INVOKE_KEY` is what
the plane presents UPSTREAM to RunPod. This is what tenant module workers present DOWNSTREAM to the
plane. Setting one to the other's value would put a RunPod-capable credential back inside a tenant
namespace, which is the exact thing the proxy exists to prevent.

**Absent means the proxy refuses every call**, with `x-vivijure-plane-refusal: unauthorized`. No
token can be minted and none can verify, so a misconfigured plane serves nobody rather than
everybody. If shared-tier submits are 401ing on a plane you believe is configured, check this
secret first.

**Rotating it invalidates every tenant's token at once**, deliberately: a stateless token cannot be
revoked row by row. Per-tenant refusal lives on the SUBMIT path instead, which reads the tenant row
and refuses anything not live, unsuspended and `runpod_mode = 'shared'` -- and submit is the only
path that spends. A refused tenant retains poll and cancel on jobs already in flight, which is
correct: cancel is the spend-leak guard, and removing it would leave a suspended tenant's running
jobs billing us.

**ALL-OR-NOTHING on the endpoints.** A value missing any plan key is refused rather than partially
resolved. A tenant wired for three of four capabilities provisions green, passes verify, and dies at
the first render on the fourth.

**The `name` on each entry is required.** It is what lets `reconcile-runpod` recognise a pool member
in an operator inventory snapshot and refuse to report a PRODUCTION endpoint as orphaned debris.

**Key custody inverts for this tier, and it is worth knowing before you mint the key.** On the
dedicated path key B belongs to the TENANT, is minted in their own RunPod console, and is proven
Restricted and endpoint-scoped by `verifyInvokeKeyScope` at paste time. A pooled tenant has no
RunPod account, so this key is OURS: it must be invoke-only (graphql set to None) and scoped to
exactly the pool endpoints, and **revoking it affects every shared tenant at once**, not one. The
same verification still runs against it, deliberately -- skipping it would remove the
graphql-capable refusal from the one tier whose key is ours.

**Which tenants get which shape** is decided by whether the provision request carried a RunPod key,
not by a separate toggle: a key present means DEDICATED (the BYO power-user path, which is correct
and unchanged), a key absent with a pool configured means SHARED. The resolved shape is recorded on
`tenants.runpod_mode`, and teardown and reconciliation branch on that column rather than on the
contents of `endpoints_json`.


#### `AI_GATEWAY_READ_TOKEN` and the LLM meter (cp#185)

The per-tenant Opus meter pages AI Gateway logs on a cron (`*/15 * * * *`, declared in
`wrangler.toml`) and writes integer micro-USD usage rows the credit ledger bills from. It needs
three things, all of which must be present or it does not run:

| what | where | note |
| --- | --- | --- |
| `CF_ACCOUNT_ID` | Actions secret, rendered into `wrangler.toml` | already set |
| `TENANT_AI_GATEWAY_ID` | Actions variable | must be `vivijure-hosted`; **never `skyphusion-llm`** |
| `AI_GATEWAY_READ_TOKEN` | worker secret, `wrangler secret put` | AI Gateway Read + Metadata Read, nothing else |

All three are in place as of 2026-07-28, verified on the deployed worker: `AI_GATEWAY_READ_TOKEN`
is a live `secret_text` binding, `CF_ACCOUNT_ID` is bound, and `TENANT_AI_GATEWAY_ID` reads
`vivijure-hosted`. **The code that reads them ships on the next SemVer tag**, since this repo is
tag-gated (merge to main is CI only). Until that tag, the deployed worker carries no cron trigger
and the meter does not run; confirm with the schedules endpoint, which answers `[]` when the
deployed bundle predates the trigger.

**A missing piece is an honest OFF, not a degraded mode.** With any of the three absent the meter
writes **no period rows at all**, and the windowed read then reports `complete: false` for every
window ("no roll-up run is assigned to this window"). That is deliberate and it is the single most
important property here: a period row asserts that an observation happened, so emitting empty ones
would manufacture billable-looking windows of zero spend out of a missing secret. A meter that
silently under-counts bills **us**, not the tenant.

Two things that are NOT the meter's problem and should not be read as one:

- **`skyphusion-llm` is refused by name at construction.** Every other wrong gateway id lands on
  Cloudflare's proven `200 / success:true / total_count:0` answer, which the roll-up's positive
  control catches. prism's gateway is not empty, so the control would *pass* while attributing
  another product's spend to vivijure tenants. It is the one misconfiguration the control cannot
  see, so it is refused explicitly rather than trusted to this document.
- **Re-reading rows is normal.** Cloudflare's `created_at gt` filter compares at whole-SECOND
  granularity (measured, not assumed), so each run re-reads the second holding the watermark. Writes
  are `INSERT OR IGNORE` on the gateway's own row id, so a re-read costs nothing. Do not "fix" it:
  the alternative is skipping a row that shares the watermark's millisecond, permanently.

Verify it live after installing the secret:

```
# force a tick and read what it actually did, rather than trusting a green cron
curl -sS -X POST -H "authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
  https://studio.vivijure.com/api/admin/llm-meter/run

# then read a window back; complete:false with a reason is a working meter reporting honestly
curl -sS -H "authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
  "https://studio.vivijure.com/api/admin/llm-spend?tenant=<id>&start=<iso>&end=<iso>"
```

The reader itself has a live regression suite against the real gateway
(`tests/ai-gateway-logs.live.test.ts`), because every vendor fact it depends on is behaviour that
can drift, and a reader built from a recorded sample is only as fresh as the sample.

- `R2_USAGE_ALERT_BYTES` (cf#56) -- alert threshold in BYTES for total R2 across tenant buckets on
  the admin usage surface. Empty = no threshold, and the surface reports a `no_threshold` verdict.
- `TENANT_R2_STORAGE_QUOTA_BYTES` (cp#183) -- the PER-TENANT storage ceiling in BYTES, bound onto
  every tenant studio as `R2_STORAGE_QUOTA_BYTES` and enforced there at submit (507 with both real
  numbers; fail-CLOSED 503 if the quota is set and its check cannot run). Empty = no ceiling, and
  there is deliberately no default: the number prices what an operator is willing to carry per
  tenant. Bytes only, no unit suffixes (`107374182400` = 100 GiB). A non-empty value that is not a
  positive integer REFUSES the provision, the studio-upgrade preflight and the converge route rather
  than being read as "off" -- see `docs/control-plane.md`.
- `TENANT_SPEND_DAILY_CEILING` (cp#218) -- the per-tenant daily spend ceiling in USD, bound onto
  every tenant studio as `SPEND_DAILY_CEILING`. Empty = the plane default of 25, which is what it
  has always sent. Declared as of cp#218: it was typed in `env.ts` and read in `deps.ts` while being
  in no list at all, so the knob documented as operator-tunable could not be tuned.
- `STUDIO_TOKEN_KEK_ENCRYPT_SLOT` (cp#95) -- which installed KEK new ciphertext is written under.
  Empty = `primary`, the only correct value outside a rotation. Declared as of cp#218: the template
  line was commented out, which made the rotation runbook step below unperformable without a repo
  edit first.
- `SMOKE_RENDER_COOLDOWN_SECONDS`, `SMOKE_RENDER_DAILY_CAP`, `SMOKE_RENDER_INFLIGHT_SECONDS`
  (cp#45) -- the operator smoke-render bounds. Empty = the documented defaults (1800s, 20 per
  rolling 24h, 1200s). Declared as of cp#218 for the same reason as the two above: all three were
  typed, read, and undeclared, so every bound was pinned at its default with no way to move it.

### Which AI Gateway is which (cp#203)

Pointing a consumer at the wrong AI Gateway is not a correctness bug, which is exactly why it is
easy to miss: everything works, and the spend lands in another cost picture.

This plane points at exactly two gateway ids and at nothing else:

| Gateway | Auth | Disposition |
| --- | --- | --- |
| `vivijure-hosted` | ON | TENANT traffic only. The per-tenant token is the access boundary and `cf-aig-metadata` carries the tenant id; this is the namespace the meter reads. Dev traffic here would forge tenant numbers. |
| `vivijure-dev` | ON | Crew DEV boxes and local studios. Its own per-function token, `vivijure-dev-aig-run`. |

**A gateway that is not in this table is not a vivijure gateway.** The account carries other
gateways for other products; the full census (every gateway that exists, whether or not vivijure
uses it) is tracked internally, and this plane never widens past the two rows above without that
census being updated first.

**Dev traffic is AUTHENTICATED, deliberately.** The cheap option was to reuse `vivijure-demo`
(`authentication: false`) and skip the token. The standing rationale from cp#185 rules that out: an
unauthenticated gateway has a public, guessable URL, and keyless Unified Billing works THROUGH it,
so an unauthenticated gateway is an open proxy to our credit balance. That argument does not weaken
because the caller is a dev box; the exposed surface is the gateway, not the caller. A dev gateway
is also the one most likely to end up in a pasted snippet.

**Per-function token, not a shared one.** `vivijure-dev-aig-run` carries a single permission
group (`AI Gateway Run`) and reaches one capability on one account, so revoking it stops dev traffic
and touches nothing else. It is NOT a Worker secret and is deliberately absent from the owners table
above, which covers `wrangler secret put` bindings on this Worker. Token id, mint custody, and home
are tracked internally.

Scope limit worth stating rather than implying: `AI Gateway Run` is an ACCOUNT-scoped permission
group, so this token is not confined to `vivijure-dev` at the API layer. The confinement is the URL
the consumer is configured with. That is why the gateway id and the token are rotated together and
recorded together.

Worker **secrets** (`wrangler secret put`, never in Actions): `POSTERN_SEND_TOKEN`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_CLIENT_SECRET`, `APPLE_PRIVATE_KEY`,
`CONTROL_PLANE_ADMIN_TOKEN`, `CF_PROVISIONER_TOKEN`, `CF_WORKER_UPLOAD_TOKEN`,
`VIDEO_FINISH_VPC_SERVICE_ID`, `STUDIO_TOKEN_KEK`, `AI_GATEWAY_READ_TOKEN` (cp#185), and -- only
while a rotation is in progress -- `STUDIO_TOKEN_KEK_NEXT` (cp#95).

`VIDEO_FINISH_VPC_SERVICE_ID` is NOT a credential; it is a Connectivity Directory service id.
It is in this list because that is how it is delivered (read back from the live Worker settings
as a `secret_text` binding), and the var census classifies by delivery mechanism rather than by
sensitivity. Both it and `CF_WORKER_UPLOAD_TOKEN` were live on the Worker and missing from this
list until cp#218.

These are `secret_text` bindings on the worker and they **persist across `wrangler deploy`**, so the
pipeline does not carry them and a deploy does not need them staged in Actions. They are set once,
out of band. A deploy will not clear them; equally, a deploy cannot repair one that was never set.

#### Every worker secret has a named owner and a recorded home

"Set once, out of band" has a failure mode we hit on 2026-07-19: `CONTROL_PLANE_ADMIN_TOKEN` was live
on the worker and nobody could say who had put it there or where the value lived. A production admin
gate whose provenance cannot be accounted for is not a leak, but it is not owned either, and an
unowned credential cannot be rotated, audited, or handed over.

So: **a worker secret is not considered set until this table names its owner and its home.** If you
`wrangler secret put` something, you add the row in the same change.

| Secret | Status |
| --- | --- |
| `CONTROL_PLANE_ADMIN_TOKEN` | set |
| `POSTERN_SEND_TOKEN` | set |
| `CF_PROVISIONER_TOKEN` | set |
| `STUDIO_TOKEN_KEK` | set, escrowed |
| `AI_GATEWAY_READ_TOKEN` | set (cp#185) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | unset (SSO not offered) |
| `GITHUB_OAUTH_CLIENT_SECRET` | unset (SSO not offered) |
| `APPLE_PRIVATE_KEY` | unset (SSO not offered) |
| `STUDIO_TOKEN_KEK_NEXT` | only exists while a rotation window is open (cp#95) |

Owner and home for each row above are tracked internally, on this hosted deployment; that is
operator custody bookkeeping, not deploy-path truth a self-hoster needs. A self-hoster's own
operator is self-evidently the owner of every secret in their own account.

### Rotating `STUDIO_TOKEN_KEK` (cp#95)

`tenants.studio_token_enc` is the only customer credential this plane stores as a usable value, so
the key protecting it has to be changeable on a calm day. The capability is product code
(`src/kek-rotation.ts`, two admin routes), not a script, because the day you need it is the worst
possible day to be writing it.

**The plane never mints its own KEK.** A key generated inside the platform is precisely how the
current one came to exist with no owner and no escrow (the section above). The new key is born on an
operator box and escrowed BEFORE it is installed.

The two routes, both admin-gated:

| Route | Does |
| --- | --- |
| `GET /api/admin/kek/status` | Read-only census. Counts stored tokens by WHICH installed key opens them, and answers `safe_to_promote` |
| `POST /api/admin/kek/reencrypt` | Re-encrypts stale rows under the write slot. Idempotent, resumable, bounded by an optional `limit`. Answers 200 only when a FRESH census says the old key can be dropped, 409 otherwise |

The sweep is safe to re-run: the work list is derived from the data every time (a row is work iff it
does not open under the write slot), so there is no cursor to go stale and a second run is a no-op.

#### The procedure

1. **Generate the new key on an operator box** and write it straight to a `chmod 600` file. Never
   render it.

   ```bash
   umask 077
   head -c 32 /dev/urandom | base64 > ~/.vivijure-studio-token-kek-next
   ```

2. **Escrow it BEFORE installing it**, by whatever mechanism you use to hold a second copy of a
   value this sensitive (this key decrypts live customer credentials, so restrict the escrow to
   the smallest set of people who can recover it). A rotation that produces a key with one copy has
   recreated the original defect. Hosted-plane operators: the internal escrow tier and recovery
   runbook are recorded in fleet-chezmoi.

3. **Install it as the second binding.** Reads now try both keys, so nothing has changed for any
   tenant and the step is reversible by deleting the binding.

   ```bash
   npx wrangler secret put STUDIO_TOKEN_KEK_NEXT   # paste from the chmod 600 file
   ```

   Confirm the window is open and see where you stand:

   ```bash
   curl -sS -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
     https://studio.vivijure.com/api/admin/kek/status
   ```

4. **Flip the write direction**: set the `STUDIO_TOKEN_KEK_ENCRYPT_SLOT` Actions **variable** to
   `next` and deploy. (Before cp#218 the template line was commented out, so this step needed a
   repo edit first; it is a declared, empty-by-default var now.) From here new tokens are
   written under the new key, which is what lets the sweep converge instead of chasing live
   writes.

5. **Sweep**, and re-run until it answers 200:

   ```bash
   curl -sS -X POST -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
     -H 'content-type: application/json' -d '{}' \
     https://studio.vivijure.com/api/admin/kek/reencrypt
   ```

   A 409 means work is left (or a row is unreadable). Read `census`, not `sweep`: the sweep report is
   the writer describing its own work, the census is a fresh read of what is stored.

6. **Promote only on `safe_to_promote: true`.** Move the new value into `STUDIO_TOKEN_KEK`, set the
   slot back to `primary`, deploy, then delete `STUDIO_TOKEN_KEK_NEXT` and update the owners table
   above. Do not reorder these: the slot must stop naming `next` before the next binding goes away,
   or provisioning refuses (by design -- it will not silently write under the primary).

#### What blocks a promotion, and why it is not a bug

`safe_to_promote` is false while ANY row is `unreadable` -- a row no installed key opens. The sweep
never touches those: re-encrypting a row we could not read would destroy the only ciphertext, and the
value may still be recoverable from an escrowed key nobody has tried. Investigate the row before you
drop a key; dropping one with an unreadable row outstanding is how a tenant loses its token for good.

Re-keying an ADMIN TOKEN (not the KEK) is cheap and non-destructive: the admin gate fails closed, no tenant traffic
touches it, and the check is two curls (bearer -> 200, bare -> 401). Re-key on unknown provenance;
do NOT reflexively re-key because a value passed through a trusted boundary such as a transcript.

### Empty is a value, but only where empty MEANS something

`scripts/render-wrangler.sh` treats **everything as required unless it is on an explicit
allowlist**, and the direction matters. `envsubst` turns an unset variable into an empty string, so
"empty", "misspelled the variable name", and "forgot to set it" all render identically and all look
fine. Guarding a hand-picked few leaves every other value silently defaultable to empty.

`ALLOW_EMPTY` in `scripts/render-wrangler.sh` is the authority for the current set; this section
gives the BAR for being on it, deliberately without repeating a count that goes stale (it read
"exactly seven names" while the list held nine).

**The bar: empty must be a coherent working state that somebody could have chosen on purpose.**

- **A feature is simply not offered.** `GOOGLE_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_ID`,
  `APPLE_TEAM_ID`, `APPLE_SERVICES_ID` -- each is half of an SSO pair, and a provider is offered
  only when both halves are present, so an unconfigured provider is *absent* rather than broken.
  These are additionally **absent** as repository variables rather than empty, because the GitHub
  API rejects an empty variable value with a 422.
- **The operator has not chosen a number, and has therefore not asked for the thing.**
  `R2_USAGE_ALERT_BYTES` (no threshold, so no alert verdict), `TENANT_R2_STORAGE_QUOTA_BYTES` (no
  ceiling, and no invented default, because the number prices what an operator is willing to carry).
- **Empty names no target.** `TENANT_AI_GATEWAY_ID` empty means this plane names no gateway, and the
  provisioner binds **neither** `GATEWAY_ID` nor `CF_AIG_TOKEN` (both or neither, since
  `pickProvider` needs both), so empty is coherent rather than half-configured.
- **Empty means the documented default applies.** `CREDITS_ENFORCING` (counting mode),
  `MANUAL_CREDIT_CEILING_MICRO_USD` (USD 100), `TENANT_SPEND_DAILY_CEILING` (25),
  `STUDIO_TOKEN_KEK_ENCRYPT_SLOT` (`primary`), and the three `SMOKE_RENDER_*` bounds.

A non-empty MALFORMED value is a different matter and is refused at the write paths, which is why
these are allowed to be empty but never allowed to be wrong.

**The empty-string trap that comes with membership.** A declared-but-empty var arrives at the Worker
as `""`, not `undefined`, so `??` does not catch it and every `?? "default"` on an ALLOW_EMPTY name
is a bug waiting for the var to be declared. `boundFrom()` in `smoke-render.ts` and `kekRing()` in
`token-crypto.ts` already treat blank as absent; `deps.ts` did not, and putting
`TENANT_SPEND_DAILY_CEILING` on this list without fixing it would have provisioned every tenant with
an empty ceiling (cp#218). Reach for `?.trim() ||`, not `??`, when you add a name here.

### The var census (cf#56, extended by cp#218)

A `[vars]` entry only reaches the Worker if it appears in **wrangler.toml.example**, in one of the
two allowlists in **render-wrangler.sh**, and in **both** render env blocks in **deploy.yml**.
Nothing connected those lists, so a var could be typed in `env.ts`, read in `deps.ts`, and never be
passed: it renders EMPTY, the deploy goes green, and the feature ships **inert**. Both cf#56 vars
hit exactly that, caught by review rather than by the pipeline.

`scripts/var-census.py` checks that all four lists agree, and it runs inside
`tests/render-wrangler.test.sh` with a control proving it can fail. Add a var to one list and the
census names the lists it is missing from.

**cp#218 closed the other half, and it is the half that actually shipped.** Anchoring on the
template placeholders can only compare lists that already mention a var; a field declared in NO list
is invisible, because all four lists agree by all omitting it. `CREDITS_ENFORCING` shipped in
v1.17.0 that way and never reached the Worker. The census now reads `src/env.ts` as well: every
field of `ControlPlaneEnv` must resolve to exactly one of a declared var (a key in the `[vars]`
table), a declared-exempt secret, or a declared-exempt binding. A field in none of the three is a
failure, because silence is the bug.

The exemptions are **declared intent**, `ENV_SECRETS` and `ENV_BINDINGS` in `src/env.ts`, never a
guess from the type. Two reasons, both about what a wrong guess would cost: flagging a secret as a
missing var would invite somebody to "fix" the census by writing a credential name into a tracked
deploy list (the census refuses that too, and says so), and flagging bindings would produce noise on
every deploy, which is how a guard gets ignored. Classification is by DELIVERY MECHANISM rather than
by sensitivity, which is why `VIDEO_FINISH_VPC_SERVICE_ID`, not a credential, is listed as a secret:
that is how it is actually installed, read back from the live Worker settings as `secret_text`.

A `satisfies readonly (keyof ControlPlaneEnv)[]` on both lists makes `tsc` reject an entry that is
not a field, so a renamed field cannot leave a stale exemption sitting there looking like coverage.

Do not extend `ALLOW_EMPTY` to silence a failing deploy. Adding a name to it asserts that empty is
correct for that value, which for everything else here is false.

The D1 id is checked by *shape* (a uuid), not merely non-emptiness, because a wrong-but-present id
would migrate somebody else database -- the one mistake here with no undo. All of it is
negative-tested in `tests/render-wrangler.test.sh` (every required value, unset and empty, plus both
directions of the allowlist) and runs in CI on every PR.

## Prerequisites a deploy cannot create for itself

Typecheck will not catch any of these; only a real deploy will.

- the **tenant dispatch namespace** must already exist, or the `[[dispatch_namespaces]]` binding is
  dangling and `wrangler deploy` fails outright
- the **studio-releases R2 bucket** must exist *and* hold the artifact for the pinned
  `STUDIO_RELEASE` tag, or provisioning later fails at `wfp_upload`
- the **wildcard tenant leg** needs a proxied wildcard DNS record and an ACM pack covering
  `*.<CONTROL_PLANE_HOST>`; see `wrangler.toml.example`, which records that ACM was **not** entitled
  on the zone as of 2026-07-17

## Pre-deploy smoke: run it before every tag

Conrad's standing policy, 2026-08-01: **a full smoke on a secure surface before every prod
deployment, every time, no gate.** "No gate" means no approval gate and no cost gate. It does not
mean no smoke. This is that smoke (cp#255). Run it, read it, then cut the tag.

```
gh workflow run "Pre-deploy smoke" -R skyphusion-labs/vivijure-control-plane
```

Locally, the same suite:

```
CF_PROVISIONER_TOKEN=<token> CF_ACCOUNT_ID=<id> STUDIO_RELEASE=<pinned tag> \
  PRE_DEPLOY_SMOKE_WORKERS_DEV_SUBDOMAIN=<account>.workers.dev \
  PRE_DEPLOY_SMOKE=1 SMOKE_REQUIRED=1 npm run smoke:predeploy
```

### What it asserts

That a tenant module upload performed by **this tree's code** results in `TELEMETRY_DB` actually
RESOLVED in the **running** worker, as reported by the version the edge serves. Not that the API
accepted a binding; that the worker can see it. `tests/module-telemetry-binding.test.ts` already
proves the uploader ASKS for the binding, and it cannot prove the platform honoured the ask: the
first cp#248 upload died on `binding TELEMETRY_DB of type d1 failed to generate` with a request
that was, by every unit test in this repo, perfectly correct.

Three legs, and the last two are why a green means anything:

| leg | what it does | required result |
| --- | --- | --- |
| CONTROL | `uploadTenantModules` with a null database id | REFUSES, writes nothing |
| POSITIVE | the catalog uploaded by this tree | every recording module reports `job_log` true |
| NEGATIVE | one module re-uploaded WITHOUT the database | that module reports `job_log` false |

Without the negative, a green proves only that something answered true, which a hardcoded `true`
in a module bundle would also produce.

### Three values, three verdicts

`telemetry.job_log` has three states and they do not collapse:

- `true` -- the binding resolved in the running worker. The only PASS.
- `false` -- it did not resolve on a module that CAN report. A real defect in the plane.
- `null` -- the module image reports no telemetry field at all, because it predates
  vivijure-cf#279. **This is not a no and not a pass.** It means the gate cannot measure the
  property on this pin, and the run goes red with a message naming the pinned release.

That last case is live today, not hypothetical: on 2026-08-01 the pinned `STUDIO_RELEASE` was
v1.12.0, whose seven module bundles contain zero occurrences of `job_log`, while v1.13.0's five
recording modules contain two each.

### Reads settle, and every read is printed

A `/ready` read taken soon after a version REPLACES another can be answered by an isolate still
serving the previous version (cp#254). The suite polls until the answer stops changing and prints
the whole sequence (`TTT`, `FFF`, `nnn`), so a run that flapped is visible as flapping rather than
hidden behind a final green. **A read that never settles is a failure, never a value.**

### What it costs, and what it can reach

No tenant, no GPU, no RunPod call, no invoke key. One throwaway dispatch namespace, one throwaway
D1, and one ephemeral dispatch door, all named `cpsmoke-<run>` and all deleted, with teardown
verified by LISTING the account rather than by trusting the delete calls. The dispatch door's two
namespace bindings both point at the run's own throwaway namespace, so it cannot reach a production
tenant script even if its per-run bearer leaked.

A run killed halfway leaves `cpsmoke-` debris. The next run REPORTS it loudly and does not delete
it: another session's namespace may belong to a run still in flight. Reap by hand once you know no
smoke is running.

### Why it is not a step in deploy.yml

A capability fact, not a preference. The smoke creates a dispatch namespace, and it has not been
verified that the deploy token can create one. **Putting an unverified permission on the deploy path
converts a smoke into an outage.** Promoting it to a preflight step is a small change once someone
confirms that scope.

### SMOKE_REQUIRED

The suite is part of `npm test` and skips when credentials are absent, which is correct on a PR. The
release gate sets `SMOKE_REQUIRED=1`, which turns a credential-less run into a FAILURE naming every
absent var. Without that, the gate would report the same green whether it ran or not, which is how
the changelog guard once passed by comparing zero released sections and printing ok.

## Dry run

`workflow_dispatch` with `dry_run: true` (the default) renders the config and reports pending
migrations, then stops. Nothing is migrated, nothing is deployed. Use it to confirm the Actions
secrets and variables are correctly populated before cutting a real tag.

## AUP_URL must pin an immutable ref

`AUP_URL` is deploy-injected and **must** point at an immutable ref -- a full commit SHA or a tag,
never `main`, never a moving path. This is Ernst standing rule and it is load-bearing for a legal
reason, not a tidiness one: an account accepts a SPECIFIC text, the plane records the sha256 of what
it served, and that record has to stay checkable. A URL that can change out from under an
acceptance turns the record into a claim nobody can verify.

Verified live on 2026-07-18, at the point of extraction:

```
GET https://studio.vivijure.com/api/aup/current
{"version":"1.0.0",
 "url":"https://raw.githubusercontent.com/skyphusion-labs/vivijure-cf/8a5d96b.../docs/legal/hosted/aup/1.0.0.md",
 "sha256":"1072c78238a141dfcade920ff93de110f282b4b621c72f788ed0a3f51778b4ed"}
```

Full 40-character commit SHA, resolves 200, and the served bytes hash to exactly the advertised
sha256. The rule was already being honoured.

**Which refs count as moving:** `main`, `master`, `head`, `develop`, `trunk`, and any
`refs/heads/` path -- matched case-insensitively, because `/blob/Main/` is the same moving ref as
`/blob/main/`. That list is wider than the obvious two because a 16-case corpus driven through the
real script found `develop`, `trunk`, and every case variant sailing through a glob that looked
correct to two readers (2026-07-18).

**Known, accepted limitation:** a directory literally *named* after a branch, under an otherwise
pinned ref (`.../<sha>/develop/aup.md`), is refused as well. That is a false positive, and it fails
closed and loudly -- the operator sees the error and renames the path. Refusing a safe URL costs
seconds; accepting a moving one silently rewrites what an account agreed to. Distinguishing the two
would need per-forge URL parsing, which is more machinery and more ways to be wrong than the case
it rescues.

**Consequence for the cf#85 extraction:** the pin resolves against vivijure-cf *history*, not its
`main`, so removing the hosted legal set from vivijure-cf in phase 4 does **not** 404 the text any
existing tenant already accepted. No fix is required before phase 4. The one thing that would break
it is vivijure-cf being deleted or made private -- it stays public, so this holds.

**Going forward:** new AUP versions published from THIS repo pin to a commit SHA in THIS repo, by
the same rule. Bumping `AUP_VERSION` re-gates every account on their next request by construction,
so a new version and a new immutable URL travel together.

## Zone security

`zone-security/` holds the vivijure.com WAF as code. It is **not** part of this deploy job; it is
applied deliberately with `zone-security/apply-waf.sh`. WAF is in log mode; the flip to enforce is
a separate launch gate (vivijure-cf#40).
