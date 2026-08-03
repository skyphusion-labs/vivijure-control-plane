// cp#288 / cp#290: the plane stops writing the pool RunPod invoke key onto a PROXIED tenant's
// module scripts. Conrad's ruling, 2026-08-03: the hosted tier holds no RunPod key it could
// extract, in any fashion.
//
// WHAT MAKES THIS TESTABLE AT ALL, and it is the thing to protect: the decision is ONE expression
// (tenantModuleProxyBinding) read by BOTH uploadTenantModules, which binds the proxy pair, and
// installInvokeKey, which installs the key. Written twice they could disagree, and there is exactly
// one state they can disagree into -- neither pair nor key, a module with no route to RunPod at all
// and every render dead. So the assertions below are not "shared tenants skip the key"; they are
// "the key is absent EXACTLY where the pair is present", which is the property that cannot rot.
//
// ABSENCE IS THE MECHANISM HERE, which makes the negative direction the dangerous one. A bug that
// keeps installing the key for a shared tenant is the status quo and is loud in an audit. A bug
// that stops installing it for a DEDICATED, BYO or self-host tenant strands every render on that
// tenant with no signal until the first submit, and that path is the permanently supported unbound
// branch of vivijure-cf modules/_shared/runpod-route.ts. Both directions are asserted, and both
// were driven RED before this file was trusted (see the mutation record in the PR).

import { describe, it, expect, vi, afterEach } from "vitest";
import { TENANT_MODULE_CATALOG, tenantModuleProxyBinding, tenantModuleScriptName } from "../src/tenant-modules";
import { provisionerWiring } from "../src/deps";
import { CfApi } from "../src/cf-api";
import type { ControlPlaneEnv } from "../src/env";
import type { ControlPlaneStore, Tenant } from "../src/store";

// NON-DEFAULT VALUES. On `studio.vivijure.com` a derived base and a hardcoded one are identical, so
// a host nobody would ever hardcode is what makes the derivation claim testable.
const HOST = "plane.nondefault-cp290.test";
const SIGNING_KEY = "cp290-signing-key-not-the-default";
const KEY_B = "rpa_keyB_NOT_A_DEFAULT_VALUE";

const env = (over: Partial<ControlPlaneEnv> = {}): ControlPlaneEnv =>
  ({
    CF_PROVISIONER_TOKEN: "cf-token",
    CF_ACCOUNT_ID: "acct",
    DISPATCH_NAMESPACE: "vivijure-tenants",
    TENANT_MODULE_NAMESPACE: "vivijure-tenant-modules",
    STUDIO_RELEASE: "v1.0.0",
    STUDIO_RELEASES: {} as R2Bucket,
    STUDIO_TOKEN_KEK: btoa("0123456789abcdef0123456789abcdef"),
    TENANT_DISPATCH: {} as DispatchNamespace,
    CONTROL_PLANE_HOST: HOST,
    RUNPOD_PROXY_SIGNING_KEY: SIGNING_KEY,
    ...over,
  }) as ControlPlaneEnv;

const tenantOf = (mode: string | null): Tenant =>
  ({ id: "ten_cp290", slug: "hero", script_name: "tenant-hero-studio", runpod_mode: mode }) as unknown as Tenant;

/** DERIVED FROM THE CATALOG, never re-listed (cp#314): a list copied into a test proves the copy,
 *  and this one grew 6 -> 15 in a single day. */
const ALL_MODULES = TENANT_MODULE_CATALOG.map((s) => s.module);

type Put = { namespace: string; script: string; name: string };

/** Runs installInvokeKey over the REAL provisionerWiring with ONE un-stubbable seam replaced
 *  (CfApi.putScriptSecret), and records what it wrote. The readiness probe afterwards has no
 *  dispatch binding to answer on, so its rejection is caught: the claim is about the WRITES. */
async function recordInstall(e: ControlPlaneEnv, tenant: Tenant): Promise<Put[]> {
  const puts: Put[] = [];
  vi.spyOn(CfApi.prototype, "putScriptSecret").mockImplementation(
    async (namespace: string, script: string, name: string) => void puts.push({ namespace, script, name }),
  );
  const w = provisionerWiring(e, {} as ControlPlaneStore)!;
  await w.installInvokeKey(tenant, KEY_B).catch(() => undefined);
  return puts;
}

const moduleKeyPuts = (puts: Put[]) =>
  puts.filter((p) => p.name === "RUNPOD_API_KEY" && p.script !== "tenant-hero-studio");
const studioKeyPuts = (puts: Put[]) =>
  puts.filter((p) => p.name === "RUNPOD_API_KEY" && p.script === "tenant-hero-studio");

afterEach(() => vi.restoreAllMocks());

// ---- 0. CONTROLS, RUN BEFORE ANY CLAIM ---------------------------------------------------------
// N81/N185: at the moment of confirming a change landed the incentive has inverted, and every
// negative assertion in this file rests on the recorder being able to record. Prove that first, so
// a zero below is a fact about the code rather than about a spy that stopped firing.

describe("CONTROLS", () => {
  it("the recorder records, and the catalog is not empty", async () => {
    const puts = await recordInstall(env(), tenantOf("dedicated"));
    expect(puts.length).toBeGreaterThan(0);
    expect(ALL_MODULES.length).toBeGreaterThan(0);
    // Denominator printed beside the result (N120), so a matcher that quietly stopped matching is
    // visible rather than inferred.
    console.log(`catalog=${ALL_MODULES.length} moduleKeyPuts=${moduleKeyPuts(puts).length}`);
  });

  it("tenantModuleProxyBinding can return BOTH answers", async () => {
    const proxy = { base: `https://${HOST}/api/runpod/v2`, signingKey: SIGNING_KEY };
    expect(await tenantModuleProxyBinding("shared", proxy, "ten_cp290")).not.toBeNull();
    expect(await tenantModuleProxyBinding("dedicated", proxy, "ten_cp290")).toBeNull();
  });
});

// ---- 1. THE RETIREMENT -------------------------------------------------------------------------

describe("a PROXIED tenant's module scripts get no RunPod key", () => {
  it("installs the key on ZERO module scripts", async () => {
    const puts = await recordInstall(env(), tenantOf("shared"));
    // Not `toHaveLength(0)` on its own: name what was found, so a failure says which module leaked.
    expect(moduleKeyPuts(puts).map((p) => p.script)).toEqual([]);
  });

  it("still installs the key on the STUDIO, which is a known remaining gap and not an oversight", async () => {
    // The studio submits RunPod work of its own (cast LoRA training, via vivijure-core
    // runpod-submit), and core carries no proxy branch, so this copy cannot be removed until core
    // learns the proxy. Asserted rather than left implicit: if someone removes it as "finishing the
    // job", this test tells them what breaks and why it is tracked separately.
    const puts = await recordInstall(env(), tenantOf("shared"));
    expect(studioKeyPuts(puts)).toHaveLength(1);
  });
});

// ---- 2. THE OTHER DIRECTION, WHICH IS THE DANGEROUS ONE ----------------------------------------

describe("an UNPROXIED tenant keeps the key on every module script", () => {
  it("dedicated: every catalog module gets exactly one PUT", async () => {
    const puts = await recordInstall(env(), tenantOf("dedicated"));
    for (const m of ALL_MODULES) {
      const script = tenantModuleScriptName("ten_cp290", m);
      expect(moduleKeyPuts(puts).filter((p) => p.script === script), m).toHaveLength(1);
    }
    expect(moduleKeyPuts(puts)).toHaveLength(ALL_MODULES.length);
    expect(studioKeyPuts(puts)).toHaveLength(1);
  });

  it("an UNRECOGNISED mode is treated as dedicated and keeps the key", async () => {
    // readRunPodMode narrows anything unrecognised to dedicated, and this is the direction that
    // must fail toward INSTALLING. A future mode string nobody taught this path about must not
    // silently lose its credential.
    const puts = await recordInstall(env(), tenantOf("some-future-tier"));
    expect(moduleKeyPuts(puts)).toHaveLength(ALL_MODULES.length);
  });

  it("a NULL mode keeps the key", async () => {
    const puts = await recordInstall(env(), tenantOf(null));
    expect(moduleKeyPuts(puts)).toHaveLength(ALL_MODULES.length);
  });
});

// ---- 3. THE PREDICATE, AND THIS IS THE TEST THAT MODE-ALONE WOULD FAIL -------------------------

describe("shared is NECESSARY and not SUFFICIENT: no proxy configured means the key STAYS", () => {
  it("shared tenant on a plane with no signing key still gets the key on every module", async () => {
    // THE WHOLE REASON THE PREDICATE IS NOT `runpod_mode === "shared"`. With no
    // RUNPOD_PROXY_SIGNING_KEY the plane binds no proxy pair, so a mode-keyed retirement would
    // leave these modules with NEITHER the pair NOR the key -- the one state
    // MODULE_PROXY_BASE_BINDING says must never exist, and every render on that tenant dies.
    const puts = await recordInstall(env({ RUNPOD_PROXY_SIGNING_KEY: undefined }), tenantOf("shared"));
    expect(moduleKeyPuts(puts)).toHaveLength(ALL_MODULES.length);
  });

  it("shared tenant on a plane with no CONTROL_PLANE_HOST still gets the key", async () => {
    const puts = await recordInstall(env({ CONTROL_PLANE_HOST: undefined }), tenantOf("shared"));
    expect(moduleKeyPuts(puts)).toHaveLength(ALL_MODULES.length);
  });

  it("an EMPTY host is absent, not a base of empty string", async () => {
    // ALLOW_EMPTY vars arrive as "" rather than undefined (the cp#218 shape), so this is the form
    // the failure would actually take on a real deploy.
    const puts = await recordInstall(env({ CONTROL_PLANE_HOST: "" }), tenantOf("shared"));
    expect(moduleKeyPuts(puts)).toHaveLength(ALL_MODULES.length);
  });
});
