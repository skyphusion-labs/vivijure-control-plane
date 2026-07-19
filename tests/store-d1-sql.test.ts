// The un-stubbable seam for store-d1.ts (cf#103 follow-up).
//
// WHY THIS FILE EXISTS: every other test in this suite builds MemoryStore, a hand-written fake.
// That proves the DECISION paths and cannot, even in principle, catch a malformed SQL string,
// because no test ever hands the SQL to a SQL engine. v1.2.0 shipped
// VALUES (?1, ?2, module_upgrade, queued, ?3, ?4) -- unquoted literals, which SQLite parses as
// COLUMN REFERENCES -- and 468 green tests plus a live deploy did not catch it. The route returned
// 500 on every valid release in production.
//
// So this drives the REAL D1Store against a REAL SQLite built from the REAL migrations. It is not
// a copy of the statements (a copy drifts and re-encodes the same assumption); it instantiates the
// shipped class and calls the shipped methods. Any bare identifier, mistyped column, or constraint
// violation in ANY store method is now a failing test rather than a production 500.
//
// node:sqlite is built into Node -- no new runtime or dev dependency. It needs
// --experimental-sqlite on Node 22 (what CI pins); the flag is an accepted no-op on Node 24, so
// vitest.config.ts passes it unconditionally.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { D1Store } from "../src/store-d1";

/**
 * The narrowest possible D1Database shim over node:sqlite: prepare/bind/first/run, which is the
 * entire surface store-d1.ts uses. Deliberately thin -- its job is to be a transparent pipe to a
 * real SQL engine, not to emulate D1 semantics. Anything it papered over would be a hole in the
 * seam, so it papers over nothing.
 */
function d1Over(db: DatabaseSync): any {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      const bound: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          bound.length = 0;
          // D1 binds null as null; node:sqlite wants null, not undefined.
          for (const a of args) bound.push(a === undefined ? null : a);
          return api;
        },
        async first<T>(): Promise<T | null> {
          return (stmt.get(...(bound as never[])) as T) ?? null;
        },
        async run() {
          return stmt.run(...(bound as never[]));
        },
      };
      return api;
    },
  };
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const dir = join(import.meta.dirname, "..", "migrations");
  // Applied in ledger order, exactly as prod does. If a migration is unreplayable, that is a
  // finding about the migration, not something to work around here.
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, f), "utf8"));
  }
  return db;
}

describe("store-d1 statements execute against real SQLite", () => {
  let db: DatabaseSync;
  let store: D1Store;

  beforeEach(async () => {
    db = freshDb();
    store = new D1Store(d1Over(db));
    await store.createAccount("acct_1", "a@b.com");
    await store.createTenant("ten_1", "rehearsal", "acct_1", "live");
  });

  // THE REGRESSION. This is the exact call that returned 500 in production.
  it("createModuleUpgradeJob inserts a real row with literal kind and status", async () => {
    const job = await store.createModuleUpgradeJob("job_1", "ten_1", null, "v1.6.0");

    expect(job.kind).toBe("module_upgrade");
    expect(job.status).toBe("queued");
    expect(job.to_release).toBe("v1.6.0");
    // from_release NULL is load-bearing: it is what makes a failed upgrade rollback-able when
    // modules_release has already been cleared.
    expect(job.from_release).toBeNull();

    // Read it back through SQL rather than trusting the RETURNING row, so a driver that fabricated
    // the row without committing would still fail.
    const back = db.prepare("SELECT kind, status FROM provision_jobs WHERE id = ?1").get("job_1") as {
      kind: string;
      status: string;
    };
    expect(back).toEqual({ kind: "module_upgrade", status: "queued" });
  });

  it("createModuleUpgradeJob records both ends of the move", async () => {
    const job = await store.createModuleUpgradeJob("job_2", "ten_1", "v1.5.0", "v1.6.0");
    expect(job.from_release).toBe("v1.5.0");
    expect(job.to_release).toBe("v1.6.0");
  });

  // The CONTROL. This statement was always correct; if it ever fails, the harness is broken rather
  // than the code, and a green regression above would be meaningless.
  it("createProvisionJob still inserts (control)", async () => {
    const job = await store.createProvisionJob("job_3", "ten_1", "provision");
    expect(job.kind).toBe("provision");
    expect(job.status).toBe("queued");
  });

  it("the tenant row the jobs hang off is really there (control)", async () => {
    const t = await store.getTenantBySlug("rehearsal");
    expect(t?.id).toBe("ten_1");
  });
});
