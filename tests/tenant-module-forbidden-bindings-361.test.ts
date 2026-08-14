import { describe, it, expect } from "vitest";
import {
  TENANT_MODULE_FORBIDDEN_BINDINGS,
  assertNoTenantModuleForbiddenBindings,
  TENANT_MODULE_CATALOG,
} from "../src/tenant-modules";

// cf#361: tenant modules are one binding away from the RunPod MANAGEMENT API when
// RUNPOD_WORKERS_MAX is present. Safe by design (refuse) not by omission.

describe("cf#361 tenant module forbidden bindings", () => {
  it("forbids RUNPOD_WORKERS_MAX by name", () => {
    expect(TENANT_MODULE_FORBIDDEN_BINDINGS).toContain("RUNPOD_WORKERS_MAX");
  });

  it("assertNoTenantModuleForbiddenBindings throws when the name is present", () => {
    expect(() =>
      assertNoTenantModuleForbiddenBindings("keyframe", [
        { name: "RUNPOD_ENDPOINT_ID" },
        { name: "RUNPOD_WORKERS_MAX" },
      ]),
    ).toThrow(/RUNPOD_WORKERS_MAX|cf#361/);
  });

  it("assertNoTenantModuleForbiddenBindings is a no-op on the normal tenant shape", () => {
    expect(() =>
      assertNoTenantModuleForbiddenBindings("keyframe", [
        { name: "RUNPOD_ENDPOINT_ID" },
        { name: "TELEMETRY_DB" },
        { name: "R2_RENDERS" },
      ]),
    ).not.toThrow();
  });

  it("catalog source never names the forbidden binding (pin against a future row)", () => {
    // The builder is the gate; this pin catches a catalog comment/spec field that would invite
    // someone to bind workers max "for capacity".
    const blob = JSON.stringify(TENANT_MODULE_CATALOG);
    expect(blob).not.toContain("RUNPOD_WORKERS_MAX");
    expect(blob).not.toContain("workers_max");
  });
});
