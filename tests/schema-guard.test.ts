// The boundary test (#52): "tenant studio data NEVER lives in the control plane" is a load-bearing
// architectural rule, and until now it was a sentence in a spec. This makes it a failing test the
// day someone drifts.
//
// The control plane holds accounts and what we provisioned. The moment a projects/renders/cast
// table appears here, the studio-instance-per-tenant architecture has quietly become the
// tenant-in-schema shape Conrad REJECTED, and same-time parity stops being structural.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../migrations");

function controlPlaneSql(): string {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(DIR, f), "utf8"))
    .join("\n");
}

function tablesDefined(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
}

// Named individually rather than pattern-matched: a substring rule would false-positive on
// legitimate names and, worse, silently miss a table that means the same thing under another name.
const STUDIO_TABLES = [
  "projects",
  "storyboards",
  "storyboard_projects",
  "renders",
  "render_jobs",
  "films",
  "cast_members",
  "cast_loras",
  "shots",
  "clips",
  "spend_counter",
  "api_tokens",
  "user_prefs",
  "operator_module_config",
  "installed_modules",
];

describe("control-plane schema boundary", () => {
  it("defines only platform tables", () => {
    const defined = tablesDefined(controlPlaneSql());
    expect(defined).toEqual(
      expect.arrayContaining(["accounts", "tenants", "aup_acceptances", "provision_jobs"]),
    );
  });

  it("defines NO studio table (tenant studio data lives in the tenant's own D1)", () => {
    const defined = new Set(tablesDefined(controlPlaneSql()));
    const leaked = STUDIO_TABLES.filter((t) => defined.has(t));
    expect(leaked).toEqual([]);
  });

  it("stores no plaintext credential column", () => {
    const sql = controlPlaneSql();
    // Every credential in this schema is a hash. A `runpod_api_key`/`secret`/`token` column would
    // mean a live credential got stored in the control plane, which the custody design (and the
    // RunPod two-key ruling in particular) forbids outright.
    //
    // The pattern is deliberately NOT a bare /key/: platform_settings.key is a settings key NAME,
    // not a credential, and a looser rule flagged it. Matching a name is not reading a meaning, so
    // this matches credential-SHAPED names only and lets *_hash through by construction.
    const cols = [...sql.matchAll(/^\s{2}([a-z_]+)\s+TEXT/gim)].map((m) => m[1].toLowerCase());
    const suspicious = cols.filter(
      (c) => (/(^|_)(token|secret|password)$/.test(c) || /_key$/.test(c) || c === "api_key") && !c.endsWith("_hash"),
    );
    expect(suspicious).toEqual([]);
  });

  it("the credential-column guard actually catches a planted credential (control)", () => {
    // A guard I have not watched FIRE is not a guard. Prove the rule above rejects the exact drift
    // it exists to stop, rather than passing because it matches nothing at all.
    const planted = "CREATE TABLE t (\n  runpod_api_key TEXT,\n  session_token TEXT,\n  token_hash TEXT\n);";
    const cols = [...planted.matchAll(/^\s{2}([a-z_]+)\s+TEXT/gim)].map((m) => m[1].toLowerCase());
    const suspicious = cols.filter(
      (c) => (/(^|_)(token|secret|password)$/.test(c) || /_key$/.test(c) || c === "api_key") && !c.endsWith("_hash"),
    );
    expect(suspicious).toEqual(["runpod_api_key", "session_token"]);
  });
});

// ---- The Tier B tombstone control (cf#103) ----
//
// Tier B says a slug that was ever LIVE stays bound to its account forever, so a stranger can never
// claim a hostname that used to serve someone else's studio. That rule holds for exactly one
// reason: tenant deletion is SOFT, so the row -- and with it the slug's account binding -- survives.
//
// Nothing enforced that. It was true only because no one had written a hard delete yet, and an
// accident is not a control. A `DELETE FROM tenants` anywhere would silently free every tombstoned
// hostname for re-registration, and no test in this repo would have noticed. This is that test.

const SRC = join(__dirname, "../src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("the tenants row is never hard-deleted", () => {
  it("no DELETE FROM tenants in src/", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      if (/DELETE\s+FROM\s+tenants\b/i.test(text)) offenders.push(file);
    }
    expect(
      offenders,
      "a hard delete of a tenant row frees its slug for re-registration and breaks the Tier B " +
        "tombstone (cf#103). Soft-delete instead: set status='deleted' and deleted_at.",
    ).toEqual([]);
  });

  it("no destructive statement against tenants in migrations/", () => {
    const sql = controlPlaneSql();
    expect(/DELETE\s+FROM\s+tenants\b/i.test(sql), "migration hard-deletes tenant rows").toBe(false);
    expect(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?tenants\b/i.test(sql), "migration drops tenants").toBe(false);
  });

  it("POSITIVE CONTROL: the detector actually fires on the thing it forbids", () => {
    // Without this, the two assertions above are satisfied by a regex that matches nothing --
    // which is exactly how a guard test passes forever while guarding nothing.
    expect(/DELETE\s+FROM\s+tenants\b/i.test("await db.prepare('DELETE FROM tenants WHERE id = ?1')")).toBe(true);
    expect(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?tenants\b/i.test("DROP TABLE IF EXISTS tenants;")).toBe(true);
  });
});
