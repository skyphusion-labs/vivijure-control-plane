// A real SQL engine behind the D1 interface, seeded from the real migrations (#32).
//
// Extracted from store-d1-sql.test.ts so the reclaim SEQUENCE rehearsal (#38) drives the SAME store
// harness the store-half proofs use. Two rehearsals inventing two different "real enough" stores is
// how the seam between them stays untested, which is the entire complaint #38 files.
//
// node:sqlite is built into Node -- no new runtime or dev dependency. It needs --experimental-sqlite
// on Node 22 (what CI pins); the flag is an accepted no-op on Node 24, so vitest.config.ts passes it
// unconditionally.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/**
 * The narrowest possible D1Database shim over node:sqlite: prepare/bind/first/run, which is the
 * entire surface store-d1.ts uses. Deliberately thin -- its job is to be a transparent pipe to a
 * real SQL engine, not to emulate D1 semantics. Anything it papered over would be a hole in the
 * seam, so it papers over nothing.
 */
export function d1Over(db: DatabaseSync): any {
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
          // D1 answers { success, meta: { changes, last_row_id, ... } }; node:sqlite answers
          // { changes, lastInsertRowid }. The COUNT is projected into D1's shape rather than left in
          // node's, because a statement whose correctness IS its row count (the cp#95 compare-and-set)
          // cannot otherwise be proven against a real engine at all. Still a pipe: the number is the
          // engine's, only the envelope is translated.
          const res = stmt.run(...(bound as never[]));
          return {
            success: true,
            meta: { changes: Number(res.changes ?? 0), last_row_id: Number(res.lastInsertRowid ?? 0) },
          };
        },
        // Added when the #23 referential guard needed a multi-row read. D1's all() answers
        // { results }, so the shim answers the same shape -- the point of this thing is to be a pipe,
        // and a differently-shaped return would be exactly the kind of paper-over that hides a seam.
        async all<T>(): Promise<{ results: T[] }> {
          return { results: stmt.all(...(bound as never[])) as T[] };
        },
      };
      return api;
    },
    // Added for the cp#189 credit capture, which needs the hold-settle and the debit-append to be
    // ONE transaction. D1 documents batch() as an implicit transaction, so the shim uses a REAL
    // SQLite transaction rather than looping the statements bare -- looping them would silently make
    // the test pass for a store method whose entire correctness claim is atomicity, which is the
    // paper-over this harness exists not to do.
    async batch(statements: any[]) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

/** An in-memory database with the REAL migration ledger applied in order, exactly as prod does. */
export function freshMigratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const dir = join(import.meta.dirname, "..", "migrations");
  // If a migration is unreplayable, that is a finding about the migration, not something to work
  // around here.
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, f), "utf8"));
  }
  return db;
}
