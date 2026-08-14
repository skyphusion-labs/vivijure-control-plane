// cp#379: THE PRE-DEPLOY SMOKE'S THROWAWAY D1 MUST CARRY THE STUDIO SCHEMA, AND THIS IS THE
// UNIT-LEVEL RED/GREEN FOR THAT STEP.
//
// THE DEFECT THIS EXISTS FOR. tests/pre-deploy-smoke.live.test.ts created a throwaway D1 and
// uploaded tenant modules bound to it with NOTHING in between. The shipped module answers
// `telemetry.job_log` from `probeRunpodJobLog`, quoted verbatim out of the v1.20.0 release
// artifact:
//
//     if (!db) return "unavailable";
//     ... db.prepare(JOB_LOG_TABLE_PROBE).bind("table", "runpod_job_log").first().then(
//           (row) => row && typeof row.name === "string" ? "ok" : "unavailable",
//           () => "unknown")
//
// so "unavailable" is returned by TWO different situations: no binding at all, and a binding that
// resolves perfectly well onto a database with no `runpod_job_log` table. The smoke built the
// second state and its POSITIVE assertion read it as the first. The harness never built the state
// its assertion presumes, so the gate could not measure its own subject in either direction: the
// positive and the negative control both settled on "unavailable", for different reasons, and
// nothing in the run could tell them apart.
//
// WHAT THIS FILE PROVES, AND IT IS DELIBERATELY NARROW. That the step the smoke now performs --
// read the migrations out of the pinned release artifact through the same `localStudioBundleSource`
// the provision e2e uses, then hand them to the SHIPPED `applyStudioMigrations` the provisioner
// runs as `d1_migrate` -- takes a database from "no runpod_job_log" to "runpod_job_log", against a
// REAL SQL engine. Red before, green after, both measured here rather than argued.
//
// WHAT IT DOES NOT PROVE. It does not prove the live smoke passes; the live legs need credentials
// and are the lead's to run. It does not prove the cf-side module is correct; that is the live
// suite's whole job and cannot be reached from a unit test. And it deliberately does NOT
// re-implement the module's `job_log` vocabulary -- the one thing borrowed from the module is the
// probe SQL string itself, because transcribing the union here would be a suite defining its own
// half of a cross-repo contract, which is the defect cp#378 was filed for.
//
// THE FIXTURE IS SYNTHETIC AND SAYS SO. It stands in for vivijure-cf's
// `migrations/0014_runpod_job_log.sql`. Its COLUMNS are not a copy of that file and must not become
// one: the shipped probe reads `sqlite_master.name` only, so the table's EXISTENCE is the entire
// load-bearing property and a column list here would be a hand-maintained duplicate that drifts the
// day cf adds a column. The fixture is assembled through the real artifact layout, with real
// sha256s, so `localStudioBundleSource` verifies it exactly as it verifies a published release.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyStudioMigrations } from "../src/migrate";
import { localStudioBundleSource } from "./studio-bundle-local";

/**
 * The table probe the SHIPPED module runs, character for character out of the v1.20.0 module
 * bundle (`JOB_LOG_TABLE_PROBE` in modules/keyframe/worker.js). Running the module's own query
 * rather than one of our own is what makes "the table is there" mean the same thing here as it
 * means in the running worker.
 */
const JOB_LOG_TABLE_PROBE = "SELECT name FROM sqlite_master WHERE type = ?1 AND name = ?2";

const FIXTURE_TAG = "v0.0.0-fixture";

/** Read the probe as the module reads it: a row, or nothing. Never a verdict string. */
function probeTable(db: DatabaseSync, name: string): boolean {
  const row = db.prepare(JOB_LOG_TABLE_PROBE).get("table", name) as { name?: unknown } | undefined;
  return typeof row?.name === "string";
}

/**
 * A `queryD1` over a REAL SQLite engine. Thin on purpose: its job is to be a pipe, so a migration
 * that SQLite would refuse is refused here too. `exec` is used for statement bodies because a
 * migration file carries more than one statement (0014 is CREATE TABLE + CREATE INDEX) and D1's
 * /query accepts exactly that.
 */
function queryD1Over(db: DatabaseSync) {
  const sqlSeen: string[] = [];
  return {
    sqlSeen,
    async queryD1(_databaseId: string, sql: string): Promise<unknown> {
      sqlSeen.push(sql);
      const text = sql.trim();
      if (/^select/i.test(text)) {
        return [{ results: db.prepare(text).all() as Record<string, unknown>[] }];
      }
      db.exec(text);
      return [{ results: [] }];
    },
  };
}

/**
 * Build a release artifact in the layout `localStudioBundleSource` reads, with honest sha256s so the
 * integrity checks it shares with the shipping `r2StudioBundleSource` actually run against it.
 */
function writeFixtureRelease(migrations: { name: string; sql: string }[]): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rollins-smoke-migrate-fixture-"));
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  const worker = Buffer.from("export default { fetch: () => new Response('fixture') };", "utf8");
  writeFileSync(join(dir, "worker.js"), worker);

  mkdirSync(join(dir, "migrations"), { recursive: true });
  const declared = migrations.map((m) => {
    const bytes = Buffer.from(m.sql, "utf8");
    writeFileSync(join(dir, "migrations", m.name), bytes);
    return { name: m.name, sha256: sha(bytes), size: bytes.byteLength };
  });

  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      tag: FIXTURE_TAG,
      main_module: "worker.js",
      compatibility_date: "2026-06-01",
      worker: { path: "worker.js", sha256: sha(worker), size: worker.byteLength },
      assets_config: {},
      assets: [],
      migrations: declared,
      required_vars: ["FIXTURE_VAR"],
    }),
  );

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// SYNTHETIC, standing in for vivijure-cf migrations/0014_runpod_job_log.sql. See the header: the
// columns are not a copy and must not become one, because only the table's existence is read.
const FIXTURE_MIGRATIONS = [
  { name: "0001_init.sql", sql: "CREATE TABLE IF NOT EXISTS cast_members (id TEXT PRIMARY KEY);" },
  {
    name: "0014_runpod_job_log.sql",
    sql:
      "CREATE TABLE IF NOT EXISTS runpod_job_log (job_id TEXT PRIMARY KEY, module TEXT NOT NULL);\n" +
      "CREATE INDEX IF NOT EXISTS idx_runpod_job_log_module ON runpod_job_log (module);",
  },
];

describe("cp#379: applying the release's studio migrations is what makes job_log measurable", () => {
  it("goes from no runpod_job_log to runpod_job_log, and the probe discriminates in both directions", async () => {
    const fixture = writeFixtureRelease(FIXTURE_MIGRATIONS);
    const db = new DatabaseSync(":memory:");
    try {
      const built = await localStudioBundleSource(fixture.dir).fetch(FIXTURE_TAG);

      // DENOMINATOR, printed beside every claim below: a zero-migration artifact would make every
      // assertion in this test vacuous, and localStudioBundleSource refuses that case, so this is
      // belt and braces on the one input that could hollow the whole file out.
      expect(built.migrations.length, "the fixture artifact declared no migrations").toBe(
        FIXTURE_MIGRATIONS.length,
      );

      // THE CONTROL RUNS FIRST, BEFORE THE CLAIM. This is the state the smoke was measuring in:
      // a database that exists, binds fine, and has no table to write through. The module answers
      // "unavailable" here and it is RIGHT to.
      expect(probeTable(db, "runpod_job_log"), "RED control: the fresh database already had the table").toBe(false);

      const migrated = await applyStudioMigrations(queryD1Over(db), "fixture-db", built.migrations);

      // Every declared migration ran. `seeded` must be empty: seeding is the adopt-a-pre-tracking-
      // database path, and a fresh database taking it would mean the table was recorded as present
      // without being created -- which is this bug wearing a different hat.
      expect(migrated.applied).toEqual(FIXTURE_MIGRATIONS.map((m) => m.name));
      expect(migrated.seeded, "a fresh database must never be SEEDED; that records without creating").toEqual([]);

      // GREEN.
      expect(probeTable(db, "runpod_job_log"), "GREEN: the table the module probes for is absent after migrating").toBe(true);

      // ...and the same instrument still answers NO to something that is genuinely not there, in
      // the same run. Without this the green above is a probe that might match anything.
      expect(probeTable(db, "no_such_table_anywhere"), "the probe matched a table that does not exist").toBe(false);
    } finally {
      db.close();
      fixture.cleanup();
    }
  });

  it("the SQL executed is the artifact's, not the harness's", async () => {
    // The whole point of routing through applyStudioMigrations + the release artifact rather than
    // hand-rolling a CREATE TABLE in the smoke is that the schema comes from the pinned release. If
    // this test ever passes while the harness supplies its own DDL, the gate agrees with itself by
    // construction and proves nothing. So: the bytes the runner executed must be the bytes on disk.
    const fixture = writeFixtureRelease(FIXTURE_MIGRATIONS);
    const db = new DatabaseSync(":memory:");
    try {
      const built = await localStudioBundleSource(fixture.dir).fetch(FIXTURE_TAG);
      const cf = queryD1Over(db);
      await applyStudioMigrations(cf, "fixture-db", built.migrations);

      for (const m of FIXTURE_MIGRATIONS) {
        const onDisk = readFileSync(join(fixture.dir, "migrations", m.name), "utf8");
        expect(cf.sqlSeen, `the runner never executed the bytes of ${m.name}`).toContain(onDisk);
      }
      // Negative control on the same matcher: a statement nobody wrote must NOT be found, or
      // `toContain` above is telling us nothing.
      expect(cf.sqlSeen).not.toContain("CREATE TABLE IF NOT EXISTS a_table_no_migration_declares (x TEXT);");
    } finally {
      db.close();
      fixture.cleanup();
    }
  });
});

describe("cp#379: the pre-deploy smoke is ARMED with the migration step", () => {
  // A SOURCE-TEXT PIN, AND ITS WEAKNESS IS STATED RATHER THAN IMPLIED. The live suite's beforeAll
  // cannot be driven from a unit test -- it needs an account, a dispatch namespace and a real D1 --
  // so nothing behavioural can observe whether the step is still wired. Deleting the two lines that
  // apply the migrations would leave every other test in this repo green, which is exactly the
  // omission-shaped hole this repo already pins elsewhere (tests/tenant-modules-guard-armed.test.ts,
  // tests/runpod-proxy-census.test.ts, same idiom, same admission that it is a weak instrument).
  // REPLACE THIS with a behavioural test the moment the smoke's setup has an injection seam.
  const src = readFileSync(join(import.meta.dirname, "pre-deploy-smoke.live.test.ts"), "utf8");

  it("calls applyStudioMigrations, not a hand-rolled CREATE TABLE", () => {
    expect(src).toContain("applyStudioMigrations(");
    // A hand-rolled schema in the harness would make the gate agree with itself by construction and
    // would drift silently the day a new studio migration lands. Refuse it here.
    expect(src, "the smoke must not carry its own DDL; the schema rides the pinned release").not.toMatch(
      /CREATE\s+TABLE/i,
    );
  });

  it("applies the migrations BEFORE any module is uploaded against that database", () => {
    const migrate = src.indexOf("applyStudioMigrations(");
    const upload = src.indexOf("uploadTenantModules(", migrate);
    expect(migrate, "applyStudioMigrations is not called at all").toBeGreaterThan(-1);
    expect(upload, "no uploadTenantModules call follows the migration").toBeGreaterThan(migrate);
    // The ordering claim is only meaningful if the file really does upload modules; a rename would
    // otherwise make this pass by finding nothing to compare against.
    expect(src.match(/uploadTenantModules\(/g)?.length ?? 0).toBeGreaterThan(0);
  });
});
