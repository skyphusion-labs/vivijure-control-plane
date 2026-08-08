# Contributing

## Migrations must be additive

**Read this before writing anything in `migrations/`.**

The deploy pipeline applies migrations **before** it deploys the worker
(`.github/workflows/deploy.yml`). That ordering is deliberate and it is safe **only because
migrations are additive**:

- old worker code tolerates a column it does not know about
- new worker code cannot tolerate a column that is missing

Deploy-then-migrate would leave a window where new code runs against old schema. That window is not
hypothetical -- it is vivijure-cf#80, which produced two live provisioning failures in a single
evening: an AUP accept returning 500 on a missing `aup_sha256` column, and a provision dying at
`r2_token` on `no such column: r2_token_id`.

### So: additive only

Safe in a single migration:

- `CREATE TABLE`
- `ALTER TABLE ... ADD COLUMN` (nullable, or with a default)
- `CREATE INDEX`

**Not** safe in a single migration -- these break the ordering guarantee:

- `DROP TABLE` / `DROP COLUMN`
- renaming a table or column
- narrowing a type, adding `NOT NULL` to an existing column, adding a constraint existing rows
  might violate

A destructive or narrowing change needs **expand/contract across two releases**:

1. **expand** -- add the new shape, write to both, ship it, let it bake
2. **contract** -- once nothing reads the old shape, remove it in a later release

If you find yourself wanting to reorder the deploy steps so your migration fits, the migration is
wrong, not the pipeline.

### Never hand-apply schema

Schema reaches the live control-plane D1 through the deploy job or not at all. No `d1 execute`
against production, no dashboard SQL, not even "just this once to unblock".

This is the lesson of cf#80 and it was learned twice in one night. The live database was built by
hand, so `0001` went in raw, `0002` was skipped entirely, `0003` was applied after the fact, and
there was no `d1_migrations` ledger to notice any of it. Every hand-applied statement is a silent
divergence between what the repo believes and what production actually is.

The repo schema-guard test cannot save you here: it compares code against `migrations/`, never
against the *deployed* database.

### Sanity checks

- migrations are applied in filename order; keep the `NNNN_description.sql` convention
- never edit a migration that has already shipped -- the ledger records it as applied and your edit
  will never run. Write a new one.
- `wrangler d1 migrations list CP_DB --remote` shows what production is actually missing

## Changelog entries: fragment files, not `## Unreleased` directly (cp#358)

**Preferred: add a file under `changelog.d/`, not an edit to `CHANGELOG.md`.** Every entry used
to land at the same `## Unreleased` heading, so the moment ANY PR merged, main's `## Unreleased`
moved and re-conflicted every other open PR touching it -- measured 2026-08-07: 20 mechanical
conflicts resolved, one PR merged, and the queue was back to 5 DIRTY with 16 more recomputing
within seconds. Two PRs adding two DIFFERENT fragment files never touch the same file, so the
conflict class disappears rather than being made cheaper.

**Filename:** `<issue>-<short-slug>.md` (e.g. `321-proxy-branch.md`), issue number first so a
directory listing sorts by issue. No issue number: `pr<N>-<slug>.md`.

**Content:** exactly the `### ...` block that would have gone under `## Unreleased` today. No new
syntax, no front matter, no type taxonomy -- move the same prose to a different file.

**`scripts/changelog-entry-required.py` accepts EITHER form during the migration window**: a
`changelog.d/` fragment or a direct `CHANGELOG.md` edit. Fragments are preferred for every new PR;
a direct edit still passes the guard so this does not break PRs already open when the fragment
convention landed. Tightening to fragment-only once the queue drains is a deliberate follow-up
(cp#358), not the current state.

At release time `scripts/changelog-assemble.py <version> <date>` reads every fragment (plus
whatever is still sitting under `## Unreleased` from a direct-edit PR), writes the `##
<version> -- <date>` section, and deletes the consumed fragments. See docs/deploy.md.

## Deploy configuration

Adding a value to `wrangler.toml.example` means adding it to `REQUIRED_VARS` in
`scripts/render-wrangler.sh`, or to `ALLOW_EMPTY` if empty is genuinely a meaningful value for it
(today: only the four SSO ids, where an unconfigured provider is *absent* rather than broken). The
render fails closed on an unsubstituted placeholder, so a template edit without the matching script
edit fails the deploy loudly rather than shipping a broken binding.

Both directions are tested in `tests/render-wrangler.test.sh`, and that suite runs in CI on every
PR. If you add a value, add its cases.

## The gate

`npm run typecheck` is the gate; `tsc` is not part of the vitest run, so type errors pass tests
silently. CI job ids (`ci`, `coverage`, `CodeQL`) are required status checks named by the org
ruleset -- renaming one makes every PR in this repo permanently unmergeable.
