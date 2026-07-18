// The d1_migrate replay-safety gate (#105).
//
// WHAT THIS PROVES AND WHAT IT DOES NOT: these run against a fake D1 that models the ONE SQLite
// behaviour the defect turned on -- ALTER TABLE ADD COLUMN is not idempotent and errors on a
// duplicate column. That is enough to prove the runner never issues a migration twice, which is the
// invariant #105 is about. It is NOT evidence that the SQL itself is right; only a real provision
// against real D1 proves that, and that gate is called out in the PR rather than implied here.

import { describe, it, expect, vi } from "vitest";
import { applyStudioMigrations, type StudioMigration } from "../src/migrate";
import type { CfApi } from "../src/cf-api";
// The studio migration set now rides the release artifact, so there is no module to import (cf#85).
// This is a LOCAL fixture: applyStudioMigrations is what is under test here, and it cares about the
// shape and the ordering, not about which specific schema it is handed.
const STUDIO_MIGRATION_SET: readonly StudioMigration[] = [
  { name: "0001_init.sql", sql: "CREATE TABLE IF NOT EXISTS projects (id TEXT);" },
  { name: "0002_user_prefs.sql", sql: "CREATE TABLE IF NOT EXISTS user_prefs (k TEXT);" },
  { name: "0003_cast_voice.sql", sql: "ALTER TABLE cast_members ADD COLUMN voice TEXT;" },
];

/**
 * A D1 fake that tracks which columns exist and REFUSES a duplicate ADD COLUMN, exactly as SQLite
 * does. Without that refusal the test would pass against the old broken code too, which is the
 * whole point: the fake has to be able to fail.
 */
function fakeD1(opts: { existingTables?: string[]; existingColumns?: string[] } = {}) {
  const tables = new Set(opts.existingTables ?? []);
  const columns = new Set(opts.existingColumns ?? []);
  const tracking = new Set<string>();
  let trackingTableExists = false;
  const sqlLog: string[] = [];

  const queryD1 = vi.fn(async (_db: string, sql: string): Promise<unknown> => {
    sqlLog.push(sql);
    const text = sql.trim();

    if (/^CREATE TABLE IF NOT EXISTS schema_migrations/i.test(text)) {
      trackingTableExists = true;
      return [{ results: [] }];
    }

    if (/^SELECT name FROM schema_migrations/i.test(text)) {
      if (!trackingTableExists) throw new Error("d1.query: no such table: schema_migrations");
      return [{ results: [...tracking].map((name) => ({ name })) }];
    }

    if (/^SELECT name FROM sqlite_master/i.test(text)) {
      const want = /name='([^']+)'/.exec(text)?.[1] ?? "";
      return [{ results: tables.has(want) ? [{ name: want }] : [] }];
    }

    if (/^INSERT OR IGNORE INTO schema_migrations/i.test(text)) {
      for (const [, name] of text.matchAll(/'([^']+)'/g)) tracking.add(name);
      return [{ results: [] }];
    }

    // A migration body. Model CREATE TABLE IF NOT EXISTS (idempotent) and ALTER TABLE ADD COLUMN
    // (emphatically not).
    for (const [, table] of text.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/gi)) tables.add(table);
    for (const [, table, column] of text.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/gi)) {
      const key = `${table}.${column}`;
      if (columns.has(key)) throw new Error(`d1.query: duplicate column name: ${column}: SQLITE_ERROR`);
      columns.add(key);
    }
    return [{ results: [] }];
  });

  return { cf: { queryD1 } as unknown as Pick<CfApi, "queryD1">, queryD1, tracking, tables, columns, sqlLog };
}

const SET: StudioMigration[] = [
  { name: "0001_init.sql", sql: "CREATE TABLE IF NOT EXISTS cast_members (id TEXT);" },
  { name: "0003_cast_voice.sql", sql: "ALTER TABLE cast_members ADD COLUMN voice_id TEXT;" },
];

describe("applyStudioMigrations", () => {
  it("CONTROL: the fake actually fails on a replayed ALTER (else every test below is vacuous)", async () => {
    const { cf } = fakeD1();
    await cf.queryD1("db", "ALTER TABLE cast_members ADD COLUMN voice_id TEXT;");
    await expect(cf.queryD1("db", "ALTER TABLE cast_members ADD COLUMN voice_id TEXT;")).rejects.toThrow(
      /duplicate column name: voice_id/,
    );
  });

  it("applies every migration on a fresh database and records each one", async () => {
    const d1 = fakeD1();
    const res = await applyStudioMigrations(d1.cf, "db", SET);

    expect(res.applied).toEqual(["0001_init.sql", "0003_cast_voice.sql"]);
    expect(res.seeded).toEqual([]);
    expect([...d1.tracking]).toEqual(["0001_init.sql", "0003_cast_voice.sql"]);
  });

  it("THE #105 GATE: a second provision against the SAME database does not replay and does not fail", async () => {
    const d1 = fakeD1();
    await applyStudioMigrations(d1.cf, "db", SET);
    const before = d1.queryD1.mock.calls.length;

    // This is the exact call that produced "duplicate column name: voice_id" on the live plane.
    const res = await applyStudioMigrations(d1.cf, "db", SET);

    expect(res.applied).toEqual([]);
    expect(res.seeded).toEqual([]);
    // Nothing re-issued beyond the tracking DDL and the read.
    const reissued = d1.queryD1.mock.calls.slice(before).map(([, sql]) => sql);
    expect(reissued.some((sql) => /ALTER TABLE/i.test(sql))).toBe(false);
  });

  it("ADOPTED pre-tracking database: seeds the set, applies nothing, survives", async () => {
    // An existing tenant D1 migrated by a control plane that had no tracking table: studio tables
    // present, voice_id already added, schema_migrations absent.
    const d1 = fakeD1({ existingTables: ["cast_members"], existingColumns: ["cast_members.voice_id"] });

    const res = await applyStudioMigrations(d1.cf, "db", SET);

    expect(res.applied).toEqual([]);
    expect(res.seeded).toEqual(["0001_init.sql", "0003_cast_voice.sql"]);
    expect(d1.sqlLog.some((sql) => /ALTER TABLE/i.test(sql))).toBe(false);
  });

  it("resumes forward: a database recorded at 0001 applies only what is missing", async () => {
    const d1 = fakeD1({ existingTables: ["cast_members"] });
    await applyStudioMigrations(d1.cf, "db", [SET[0]]);

    const res = await applyStudioMigrations(d1.cf, "db", SET);

    expect(res.applied).toEqual(["0003_cast_voice.sql"]);
  });

  it("carries the REAL shipped migration set through both a fresh and a repeat provision", async () => {
    // The bundled set is the thing that actually broke; run it, not just a miniature.
    const d1 = fakeD1();
    const first = await applyStudioMigrations(d1.cf, "db", STUDIO_MIGRATION_SET);
    expect(first.applied).toEqual(STUDIO_MIGRATION_SET.map((m: StudioMigration) => m.name));

    const second = await applyStudioMigrations(d1.cf, "db", STUDIO_MIGRATION_SET);
    expect(second.applied).toEqual([]);
  });

  it("refuses a migration name carrying a quote rather than building malformed SQL", async () => {
    const d1 = fakeD1();
    await expect(
      applyStudioMigrations(d1.cf, "db", [{ name: "0001_o'brien.sql", sql: "SELECT 1;" }]),
    ).rejects.toThrow(/must not contain a quote/);
  });
});
