// The studio migrations the provisioner applies to a tenant D1 (#53 step d1_migrate).
//
// EXPLICIT imports, not a glob: a Worker cannot read a directory, so the set is spelled out and a
// guard test (tests/control-plane/studio-migrations.test.ts) compares this list to the files on
// disk. Adding migrations/00NN_x.sql without adding it here fails CI instead of silently
// provisioning new tenants with a stale schema, which is the drift this file would otherwise invent.
//
// SCOPE mirrors the live-verified e2e chain exactly: top-level migrations/*.sql only.
// migrations/manual/ is operator-run by design and migrations/demo/ is demo-studio seed data;
// neither belongs in a tenant D1.
//
// NAME + SQL PER MIGRATION, not one joined blob (#105): the runner records each migration by
// filename in the tenant's schema_migrations table and applies only what is missing. The joined
// form is what made the old unconditional replay possible, and replay is exactly what broke on an
// adopted, already-migrated D1.
//
// VERSIONING CAVEAT, stated rather than hidden: these ride the CONTROL PLANE's deploy commit, while
// the studio bundle is the pinned release. Additive-only migrations make that safe in practice, but
// the honest end state is the release manifest carrying its own migrations; tracked in the
// provisioner follow-up issue rather than silently assumed away.

import type { StudioMigration } from "./migrate";

import m0001 from "../../migrations/0001_init.sql";
import m0002 from "../../migrations/0002_user_prefs.sql";
import m0003 from "../../migrations/0003_cast_voice.sql";
import m0005 from "../../migrations/0005_operator_module_config.sql";
import m0006 from "../../migrations/0006_installed_modules.sql";
import m0007 from "../../migrations/0007_film_advance_lease.sql";
import m0008 from "../../migrations/0008_spend_counter.sql";
import m0009 from "../../migrations/0009_api_tokens.sql";
import m0010 from "../../migrations/0010_public_ids.sql";
import m0011 from "../../migrations/0011_advance_lease_token.sql";

/** The bundled set, in apply order. The name is the tracking key, so it must stay the filename. */
export const STUDIO_MIGRATION_SET: readonly StudioMigration[] = [
  { name: "0001_init.sql", sql: m0001 },
  { name: "0002_user_prefs.sql", sql: m0002 },
  { name: "0003_cast_voice.sql", sql: m0003 },
  { name: "0005_operator_module_config.sql", sql: m0005 },
  { name: "0006_installed_modules.sql", sql: m0006 },
  { name: "0007_film_advance_lease.sql", sql: m0007 },
  { name: "0008_spend_counter.sql", sql: m0008 },
  { name: "0009_api_tokens.sql", sql: m0009 },
  { name: "0010_public_ids.sql", sql: m0010 },
  { name: "0011_advance_lease_token.sql", sql: m0011 },
];

/** Filenames, for the disk-parity guard test. Order is the apply order. */
export const STUDIO_MIGRATION_FILES = STUDIO_MIGRATION_SET.map((m) => m.name);

/** The concatenated SQL. Retained for the bundle-integrity guard test, NOT for applying. */
export const STUDIO_MIGRATIONS = STUDIO_MIGRATION_SET.map((m) => m.sql).join("\n");
