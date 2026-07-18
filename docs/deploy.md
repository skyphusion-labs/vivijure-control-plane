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
- `STUDIO_RELEASES_BUCKET`, `STUDIO_RELEASE`
- `AUP_VERSION`, `AUP_URL`, `POSTERN_SEND_URL`
- `GOOGLE_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_ID`
- `APPLE_TEAM_ID`, `APPLE_SERVICES_ID` (empty = Apple SSO is not offered)

Worker **secrets** (`wrangler secret put`, never in Actions): `POSTERN_SEND_TOKEN`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_CLIENT_SECRET`, `APPLE_PRIVATE_KEY`,
`CONTROL_PLANE_ADMIN_TOKEN`, `CF_PROVISIONER_TOKEN`.

The render step **fails closed** on any of the Actions values being missing or empty. The D1 id is
checked by *shape* (a uuid), not merely non-emptiness, because a wrong-but-present id would migrate
somebody else database. Those guards are negative-tested in `tests/render-wrangler.test.sh` and run
on every PR.

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

## Zone security

`zone-security/` holds the vivijure.com WAF as code. It is **not** part of this deploy job; it is
applied deliberately with `zone-security/apply-waf.sh`. WAF is in log mode; the flip to enforce is
a separate launch gate (vivijure-cf#40).
