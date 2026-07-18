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

// cf#114: the fan-out landing a 200 from the secrets PUT does NOT mean the edge serves the key. The
// production seam must PROVE it on the modules before the caller can promote the tenant. These run
// against the real provisionerWiring, so they cover the wiring, not a re-description of it.
describe("installInvokeKey probes module readiness (cf#114)", () => {
  const tenant = { id: "ten_abc123", slug: "hero", script_name: "tenant-hero-studio" } as Tenant;

  const dispatch = (handler: (script: string, path: string) => Response) =>
    ({
      get: (script: string) => ({
        fetch: async (req: Request) => handler(script, new URL(req.url).pathname),
      }),
    }) as unknown as DispatchNamespace;

  it("returns every module VERIFIED when each one serves the key", async () => {
    vi.spyOn(CfApi.prototype, "putScriptSecret").mockImplementation(async () => {});
    const probed: string[] = [];
    const w = provisionerWiring(
      fullEnv({
        TENANT_MODULE_DISPATCH: dispatch((script, path) => {
          probed.push(`${script}${path}`);
          return new Response(
            JSON.stringify({ ok: true, credentials: { runpod_api_key: true, runpod_endpoint_id: true } }),
            { status: 200 },
          );
        }),
      }),
      store,
    )!;

    const readiness = await w.installInvokeKey(tenant, "rpa_keyB_SECRET");

    // Control: the probe actually ran (a silent no-op would make the assertion below vacuous).
    expect(probed).toHaveLength(TENANT_MODULE_CATALOG.length);
    expect(probed.every((p) => p.endsWith("/ready"))).toBe(true);
    expect(readiness.verified.sort()).toEqual(TENANT_MODULE_CATALOG.map((s) => s.module).sort());
    expect(readiness.unverified).toEqual([]);
  });

  it("THROWS on a bad module answer, so the caller cannot promote the tenant to live", async () => {
    // The IMMEDIATE-failure shape (endpoint id missing = a provisioning defect, never a race). The
    // production seam runs on the real clock, so the DEADLINE path is asserted against a virtual
    // clock in module-ready-probe.test.ts rather than burning 10s of wall time here. What this test
    // adds is that the real wiring propagates the throw at all.
    vi.spyOn(CfApi.prototype, "putScriptSecret").mockImplementation(async () => {});
    const w = provisionerWiring(
      fullEnv({
        TENANT_MODULE_DISPATCH: dispatch(() =>
          new Response(
            JSON.stringify({ ok: false, credentials: { runpod_api_key: false, runpod_endpoint_id: false } }),
            { status: 200 },
          ),
        ),
      }),
      store,
    )!;
    await expect(w.installInvokeKey(tenant, "rpa_keyB_SECRET")).rejects.toThrow(/not retryable/);
  });

  it("an UNBOUND TENANT_MODULE_DISPATCH reports unverified -- it never reports a false pass", async () => {
    // A deploy predating the binding must degrade to "could not verify", never to "verified".
    vi.spyOn(CfApi.prototype, "putScriptSecret").mockImplementation(async () => {});
    const w = provisionerWiring(fullEnv({ TENANT_MODULE_DISPATCH: undefined }), store)!;
    const readiness = await w.installInvokeKey(tenant, "rpa_keyB_SECRET");
    expect(readiness.verified).toEqual([]);
    expect(readiness.unverified).toHaveLength(TENANT_MODULE_CATALOG.length);
  });
});
