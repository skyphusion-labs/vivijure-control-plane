// The disk-parity guard for src/control-plane/studio-migrations.ts: the Worker cannot read a
// directory, so the migration set is spelled out as explicit imports, and THIS test is what makes
// that safe. Add migrations/00NN_x.sql without adding the import and this fails, instead of new
// tenants silently provisioning with a stale schema.

import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { STUDIO_MIGRATION_FILES, STUDIO_MIGRATIONS } from "../src/studio-migrations";

describe("studio migrations bundle", () => {
  it("matches the top-level migrations/*.sql on disk exactly, in order", () => {
    // Top-level only, deliberately: migrations/manual/ is operator-run and migrations/demo/ is
    // demo seed data. Same scope the live e2e proved.
    const onDisk = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
    expect([...STUDIO_MIGRATION_FILES]).toEqual(onDisk);
  });

  it("bundles real SQL, not empty imports", () => {
    // A broken Text-module setup imports undefined/empty; catch it here, not at a tenant provision.
    expect(STUDIO_MIGRATIONS).toContain("CREATE TABLE");
    expect(STUDIO_MIGRATIONS.length).toBeGreaterThan(1000);
  });
});
