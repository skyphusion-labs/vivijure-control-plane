// cp#210: migration numeric prefixes must be unique.
//
// FOUND THE HARD WAY (2026-07-27). cp#189 landed `0013_credit_ledger.sql` while the cp#183 branch
// carried `0013_tenant_storage_quota.sql`. Two migrations, one number. Git merged BOTH silently:
// different filenames means there is no conflict for it to raise. Nothing went red.
//
// WHY EVERY OTHER MECHANISM IS BLIND TO IT, which is what makes it worth a dedicated check:
//   - git cannot flag it: no textual conflict exists between two differently-named files.
//   - the suite cannot flag it: tests/sqlite-d1.ts `freshMigratedDb` sorts by FILENAME and applies
//     whatever it finds, so a collision replays cleanly and every test stays green.
//   - review usually cannot flag it: each PR is individually correct; the collision only exists
//     after the merge, and by then nobody is looking at migration numbers.
//
// It was harmless that time purely because the two touched different tables. Two crew lanes each
// adding a migration inside one sprint is now routine here rather than exceptional, and the day two
// same-numbered migrations touch the SAME table it surfaces as live schema divergence rather than a
// red build.
//
// Runs in the ordinary suite, so it fires on every PR. That placement is the point: MERGE is where
// the collision becomes invisible, so the check has to sit before it. A deploy-time check would be
// too late -- both files are on main by then.

import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Numeric prefixes appearing more than once, with the files that share them. Pure, so the real
 *  directory and a reconstructed collision go through the SAME code path. */
export function duplicatePrefixes(names: string[]): Array<{ prefix: string; files: string[] }> {
  const byPrefix = new Map<string, string[]>();
  for (const n of names) {
    const m = NAME.exec(n);
    if (!m) continue;
    const list = byPrefix.get(m[1]) ?? [];
    list.push(n);
    byPrefix.set(m[1], list);
  }
  return [...byPrefix.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([prefix, files]) => ({ prefix, files: files.sort() }));
}

const onDisk = (): string[] => readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort();

describe("migration numbering (cp#210)", () => {
  it("finds migrations to check at all", () => {
    // Guard against the whole suite passing vacuously because the glob broke or the directory
    // moved. Every assertion below is meaningless against an empty list.
    expect(onDisk().length).toBeGreaterThan(0);
  });

  it("every migration filename is <4 digits>_<snake_name>.sql", () => {
    const bad = onDisk().filter((n) => !NAME.test(n));
    expect(bad, `these do not match ${NAME}`).toEqual([]);
  });

  it("no two migrations share a numeric prefix", () => {
    const dupes = duplicatePrefixes(onDisk());
    expect(
      dupes,
      dupes.length
        ? `duplicate migration numbers: ${dupes
            .map((d) => `${d.prefix} -> ${d.files.join(" and ")}`)
            .join("; ")}. Renumber the one that landed second. Git will not flag this and neither ` +
          `will the rest of the suite, which is why this check exists.`
        : "",
    ).toEqual([]);
  });

  // POSITIVE CONTROL, and not a hypothetical one: this is the ACTUAL collision that occurred on
  // 2026-07-27, reconstructed. A uniqueness assertion that has only ever been run against a clean
  // directory proves nothing about whether it can detect a collision -- it would pass identically
  // if duplicatePrefixes always returned []. This is the assertion that makes the one above mean
  // something.
  it("CONTROL: detects the real 2026-07-27 collision", () => {
    const collided = [
      "0012_invoke_key_handoff.sql",
      "0013_credit_ledger.sql",
      "0013_tenant_storage_quota.sql", // as it existed before rollins renumbered it to 0014
      "0014_tenant_storage_quota.sql",
    ];
    const dupes = duplicatePrefixes(collided);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].prefix).toBe("0013");
    expect(dupes[0].files).toEqual(["0013_credit_ledger.sql", "0013_tenant_storage_quota.sql"]);
  });

  it("CONTROL: a clean list produces no finding", () => {
    // The other half of the control: the detector is not simply always positive.
    expect(duplicatePrefixes(["0001_a.sql", "0002_b.sql", "0003_c.sql"])).toEqual([]);
  });

  it("CONTROL: ignores files it cannot parse rather than reporting them as duplicates", () => {
    expect(duplicatePrefixes(["README.md", "notes.txt", "0001_a.sql"])).toEqual([]);
  });
});
