// The REAL provisionerWiring (deps.ts) -- the production seam, not a fake. Two guards that a stubbed
// dep set can never prove: (1) the wiring REFUSES when TENANT_MODULE_NAMESPACE is absent (the module
// bridge cannot provision without it), and (2) installInvokeKey lands key B on the studio AND every
// tenant module script. (2) is a POSITIVE CONTROL over a recording proxy on the one un-stubbable call
// (CfApi.putScriptSecret): "we DO configure X" asserted on the write history, per the doctrine that a
// point-in-time read of final state proves nothing.
import { describe, it, expect, vi, afterEach } from "vitest";
import { provisionerWiring } from "../src/deps";
import { CfApi } from "../src/cf-api";
import { tenantModuleScriptName, TENANT_MODULE_CATALOG } from "../src/tenant-modules";
import type { ControlPlaneEnv } from "../src/env";
import type { ControlPlaneStore, Tenant } from "../src/store";

const store = {} as ControlPlaneStore;

function fullEnv(over: Partial<ControlPlaneEnv> = {}): ControlPlaneEnv {
  return {
    CF_PROVISIONER_TOKEN: "cf-token",
    CF_ACCOUNT_ID: "acct",
    DISPATCH_NAMESPACE: "vivijure-tenants",
    TENANT_MODULE_NAMESPACE: "vivijure-tenant-modules",
    STUDIO_RELEASE: "v1.0.0",
    STUDIO_RELEASES: {} as R2Bucket,
    STUDIO_TOKEN_KEK: btoa("0123456789abcdef0123456789abcdef"),
    TENANT_DISPATCH: {} as DispatchNamespace,
    ...over,
  } as ControlPlaneEnv;
}

afterEach(() => vi.restoreAllMocks());

describe("provisionerWiring gate", () => {
  it("REFUSES (undefined) when TENANT_MODULE_NAMESPACE is absent -- the module bridge is not optional", () => {
    const w = provisionerWiring(fullEnv({ TENANT_MODULE_NAMESPACE: undefined }), store);
    expect(w).toBeUndefined();
  });

  it("POSITIVE CONTROL: wires up when every required var (incl. TENANT_MODULE_NAMESPACE) is present", () => {
    const w = provisionerWiring(fullEnv(), store);
    expect(w).toBeDefined();
  });
});

describe("installInvokeKey key-B fan-out", () => {
  const tenant = { id: "ten_abc123", slug: "hero", script_name: "tenant-hero-studio" } as Tenant;

  it("PUTs key B on the studio AND every tenant module script (never leaves a module keyless)", async () => {
    const puts: { namespace: string; script: string; name: string }[] = [];
    vi.spyOn(CfApi.prototype, "putScriptSecret").mockImplementation(
      async (namespace: string, script: string, name: string, _text: string) => {
        puts.push({ namespace, script, name });
      },
    );

    const w = provisionerWiring(fullEnv(), store)!;
    await w.installInvokeKey(tenant, "rpa_keyB_SECRET");

    // Control: the proxy actually recorded (a silent no-op would make every assertion below vacuous).
    expect(puts.length).toBeGreaterThan(0);
    // Studio gets it, in the tenants namespace.
    expect(puts).toContainEqual({ namespace: "vivijure-tenants", script: "tenant-hero-studio", name: "RUNPOD_API_KEY" });
    // And EVERY module script, in the modules namespace, by its tenant-prefixed name.
    for (const spec of TENANT_MODULE_CATALOG) {
      expect(puts).toContainEqual({
        namespace: "vivijure-tenant-modules",
        script: tenantModuleScriptName(tenant.id, spec.module),
        name: "RUNPOD_API_KEY",
      });
    }
    // Exactly studio + the 5 modules, nothing stray.
    expect(puts).toHaveLength(1 + TENANT_MODULE_CATALOG.length);
    expect(puts.every((p) => p.name === "RUNPOD_API_KEY")).toBe(true);
  });

  it("never PUTs the key value into anything but a secret PUT (the value is the 4th arg, never logged)", async () => {
    // Guards the custody shape: putScriptSecret is the ONLY sink. A recording proxy captures the
    // arguments; the KEY VALUE must appear only as the secret text, never as a namespace/script/name.
    const captured: string[] = [];
    vi.spyOn(CfApi.prototype, "putScriptSecret").mockImplementation(
      async (namespace: string, script: string, name: string, _text: string) => {
        captured.push(namespace, script, name);
      },
    );
    const w = provisionerWiring(fullEnv(), store)!;
    await w.installInvokeKey(tenant, "rpa_keyB_SECRET");
    expect(captured.join("|")).not.toContain("rpa_keyB_SECRET");
  });
});
