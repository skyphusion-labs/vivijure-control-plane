// The tenant D1 schema migration runner (#105).
//
// WHY THIS FILE EXISTS: d1_create is adopt-on-exists, so the migration step must be safe to run
// against a database that is ALREADY migrated. It previously replayed the whole bundled set on
// every provision, on the stated assumption that the migrations are "CREATE TABLE IF NOT EXISTS,
// so re-applying is a no-op". That assumption was false: four of the bundled migrations are
// ALTER TABLE ... ADD COLUMN, which SQLite has no IF NOT EXISTS form for. Adopting a populated D1
// therefore failed hard ("duplicate column name: voice_id"), which is what #105 records.
//
// The fix is a tracking table, not idempotent-by-guard statements. Guarding today's four ALTERs
// would be a smaller diff that leaves the hole open and re-arms on the next ALTER anyone writes;
// tracking makes every future migration safe by construction.

import type { CfApi } from "./cf-api";

/** One bundled migration: the filename we track it by, and its SQL. */
export interface StudioMigration {
  name: string;
  sql: string;
}

/**
 * The tracking table. CREATE TABLE IF NOT EXISTS is genuinely idempotent (no ALTER involved), so
 * issuing this on every provision is safe, and it is what makes the rest of the logic possible.
 */
const TRACKING_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;

/**
 * The structural probe for "this database was migrated by an older control plane that had no
 * tracking table". cast_members is created in 0001_init.sql, so any database that ever received a
 * migration carries it, and a genuinely fresh database does not.
 */
const ADOPTED_PROBE_TABLE = "cast_members";

/**
 * CF returns one entry per statement, each carrying its own rows. Flattened because every read here
 * issues a single statement. A shape we do not recognise yields no rows rather than throwing, and
 * every caller treats "no rows" as the conservative answer (fresh database, apply forward).
 */
function rowsOf(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of raw) {
    const results = (entry as { results?: unknown } | null)?.results;
    if (Array.isArray(results)) out.push(...(results as Record<string, unknown>[]));
  }
  return out;
}

/**
 * Migration names are our own compile-time constants, never user input. The quote check is not
 * defence against an attacker, it is a loud failure instead of silently malformed SQL if someone
 * ever adds a filename containing a quote.
 */
function sqlString(value: string): string {
  if (value.includes("'")) throw new Error(`migration name must not contain a quote: ${value}`);
  return `'${value}'`;
}

/**
 * Remove SQL comments from a migration before it goes to the D1 query endpoint.
 *
 * WHY: the endpoint refuses one statement followed by any comment, with 400 and code 7500, "SQL code
 * did not contain a statement", and applies nothing. Measured on a real database, 2026-10-31:
 *   refused  `ALTER ...; -- c`, the same with a newline, with the comment on the next line, `/* c *\/`
 *   accepted `ALTER ...;`, `-- c` then `ALTER ...;`, and two or more statements with the same comments
 * So a file can apply or fail depending only on how many statements it has. 0003_cast_voice.sql has
 * one statement and a trailing comment, and it stopped every fresh tenant at d1_migrate.
 *
 * THE FIX IS HERE AND NOT IN THE FILE. Shipped migrations are immutable, and a future file can have
 * the same shape. The file's hash and its recorded name do not change; only the text sent does.
 *
 * Quoted text is copied unchanged, so a `--` inside a string or an identifier stays. A line comment
 * keeps its newline. An UNTERMINATED string or block comment returns the input UNCHANGED, so D1
 * reports the malformed file rather than this function guessing what it meant.
 */
export function stripSqlComments(sql: string): string {
  const closers: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    const closer = closers[ch];
    if (closer !== undefined) {
      const end = sql.indexOf(closer, i + 1);
      if (end === -1) return sql;
      // A doubled quote reads as two adjacent quoted runs, which copies the same characters.
      out += sql.slice(i, end + 1);
      i = end + 1;
    } else if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      if (end === -1) break;
      i = end;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return sql;
      out += " ";
      i = end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out.trim();
}

/**
 * Apply only the migrations this database has not already had, recording each one.
 *
 * Returns what actually happened so the provisioner can log it: `applied` are migrations run now,
 * `seeded` are migrations recorded as already-present on an adopted pre-tracking database.
 *
 * ADOPTION RECONCILE, with its known limitation stated rather than hidden: if the tracking table is
 * absent or empty but the database already carries studio tables, it was migrated by an older
 * control plane. We seed the full bundled set as applied and run nothing. A database sitting at an
 * OLDER migration level than the current release would therefore be mis-seeded as current. That is
 * acceptable today because every adoptable database is at the current level, and it is self-healing
 * for all future migrations because tracking exists from this point on. Tracked on #105 / #84.
 */
export async function applyStudioMigrations(
  cf: Pick<CfApi, "queryD1">,
  databaseId: string,
  migrations: readonly StudioMigration[],
): Promise<{ applied: string[]; seeded: string[] }> {
  await cf.queryD1(databaseId, TRACKING_DDL);

  const recorded = rowsOf(await cf.queryD1(databaseId, "SELECT name FROM schema_migrations;"));
  const already = new Set(recorded.map((row) => String(row.name)));

  if (already.size === 0 && migrations.length > 0) {
    const probe = rowsOf(
      await cf.queryD1(
        databaseId,
        `SELECT name FROM sqlite_master WHERE type='table' AND name=${sqlString(ADOPTED_PROBE_TABLE)};`,
      ),
    );
    if (probe.length > 0) {
      const values = migrations.map((m) => `(${sqlString(m.name)})`).join(", ");
      await cf.queryD1(databaseId, `INSERT OR IGNORE INTO schema_migrations (name) VALUES ${values};`);
      return { applied: [], seeded: migrations.map((m) => m.name) };
    }
  }

  // One statement per call, and the record written immediately after its own migration: a failure
  // half-way leaves everything before it recorded, so a retry resumes instead of replaying.
  const applied: string[] = [];
  for (const migration of migrations) {
    if (already.has(migration.name)) continue;
    // A comment-only file has nothing to run, and D1 refuses an empty query. It is still recorded.
    const statements = stripSqlComments(migration.sql);
    if (statements) await cf.queryD1(databaseId, statements);
    await cf.queryD1(
      databaseId,
      `INSERT OR IGNORE INTO schema_migrations (name) VALUES (${sqlString(migration.name)});`,
    );
    applied.push(migration.name);
  }
  return { applied, seeded: [] };
}
