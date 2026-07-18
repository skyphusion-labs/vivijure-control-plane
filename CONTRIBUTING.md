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
