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

Worker **secrets** (`wrangler secret put`, never in Actions): `POSTERN_SEND_TOKEN`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_CLIENT_SECRET`, `APPLE_PRIVATE_KEY`,
`CONTROL_PLANE_ADMIN_TOKEN`, `CF_PROVISIONER_TOKEN`, `STUDIO_TOKEN_KEK`.

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

| Secret | Owner | Home |
| --- | --- | --- |
| `CONTROL_PLANE_ADMIN_TOKEN` | Mackaye | `~/.vivijure-cp-admin.token` on the primary crew box (`chmod 600`) |
| `POSTERN_SEND_TOKEN` | Strummer | send identity recorded in `crew-secrets/operator/postern/vivijure-control-plane-send-identity.fragment.json` |
| `CF_PROVISIONER_TOKEN` | Rollins (hosted sprint mint, 2026-07-17) | `~/.vivijure-provisioner-full.env` on the primary crew box (dischord, `chmod 600`); mirrored to repo Actions secret `CF_PROVISIONER_TOKEN` for live gates |
| `STUDIO_TOKEN_KEK` | UNCLAIMED -- home not yet confirmed; recovery exhausted 2026-07-25 (see below) | none |
| `GOOGLE_OAUTH_CLIENT_SECRET` | unset (SSO not offered) | n/a |
| `GITHUB_OAUTH_CLIENT_SECRET` | unset (SSO not offered) | n/a |
| `APPLE_PRIVATE_KEY` | unset (SSO not offered) | n/a |

`STUDIO_TOKEN_KEK` remains `UNCLAIMED` (set on the live worker during #93 deploy; no durable home
file found). It is recorded as unknown rather than guessed at, because a plausible-looking owner in
a table is worse than an admitted gap.

**Recovery search, exhausted 2026-07-25 (#4):** absent from the setting member's home and
`~/.secrets`, from every `crew-secrets` tier manifest and doc, from both repos' Actions secrets, from
`fleet-chezmoi`, and from shell history (crew shells are non-interactive, so none is written). The
binding IS live on the worker (`secret_text`), but Cloudflare worker secrets are write-only -- the
API returns names and types only -- so the value cannot come back off the platform. Treat it as
**unrecoverable**, not merely unlocated.

Consequences, stated plainly because this one is not like the others in this table:

- It is **not** cheap to re-key. Unlike the admin gate, this key decrypts `tenants.studio_token_enc`
  for every tenant that has one (7 at time of writing). A new KEK orphans that ciphertext and breaks
  dispatcher-injected auth for those tenants. Re-keying requires an explicit migration that re-mints
  and re-encrypts each tenant's studio token, and it is a ruled decision, not a maintenance chore.
- It has **no escrow**, which is the actual defect: the only copy of a key protecting live customer
  credentials exists in one write-only location, with no recovery path if it is lost.
- The live **provision e2e does not need it** and never did. That suite round-trips a KEK entirely
  in-process over a `MemoryStore` tenant it creates itself, so it generates an ephemeral key
  (`tests/provision-e2e-env.ts`). Admitting the production KEK there would widen its custody into CI
  to buy nothing. The belief that #4 was blocked on recovering this value was the premise error that
  parked that issue.

Re-keying one of these is cheap and non-destructive: the admin gate fails closed, no tenant traffic
touches it, and the check is two curls (bearer -> 200, bare -> 401). Re-key on unknown provenance;
do NOT reflexively re-key because a value passed through a trusted boundary such as a transcript.

### Empty is a value, but only for four of them

`scripts/render-wrangler.sh` treats **everything as required unless it is on an explicit
allowlist**, and the direction matters. `envsubst` turns an unset variable into an empty string, so
"empty", "misspelled the variable name", and "forgot to set it" all render identically and all look
fine. Guarding a hand-picked few leaves every other value silently defaultable to empty.

`ALLOW_EMPTY` is exactly four names:

`GOOGLE_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_SERVICES_ID`

Each is half of an SSO provider pair, and a provider is offered only when both halves are present,
so an unconfigured provider is *absent* rather than broken. Empty is how that is expressed. They are
additionally **absent** as repository variables rather than empty, because the GitHub API rejects an
empty variable value with a 422 -- the workflow cannot set them to the empty string it wants.

Do not extend that list to silence a failing deploy. Adding a name to it asserts that empty is
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
