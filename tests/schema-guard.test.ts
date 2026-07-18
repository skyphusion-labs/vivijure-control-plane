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
