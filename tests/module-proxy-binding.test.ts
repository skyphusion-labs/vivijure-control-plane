// cp#288 / cf#394 item 1: the pair that makes the plane-side RunPod proxy REACHABLE from a tenant
// module worker, and the pre-proxy credential that must survive alongside it.
//
// WHY THIS CLASS OF TEST, and it is the same shape as module-telemetry-binding.test.ts. Before this
// change the proxy served and nothing pointed at it: PROXY_UPSTREAM_PREFIX had zero callers outside
// the proxy's own files and RUNPOD_PROXY_BASE existed only in a comment. A module uploaded without
// the pair uploads fine, installs fine, renders fine -- it just goes straight to RunPod with the
// credential the proxy exists to remove from the tenant namespace. Nothing anywhere reports that.
//
// The assertions below are therefore about the SILENT shapes: the pair absent, HALF the pair
// present (the one state that breaks a render rather than leaving it on the old path), a base that
// is a literal instead of a derivation, a token that authenticates a DIFFERENT tenant, and the
// direct RUNPOD_API_KEY quietly disappearing because the upload replaced the bindings.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  uploadTenantModules,
  TENANT_MODULE_CATALOG,
  tenantModuleScriptName,
  type TenantModuleDeps,
} from "../src/tenant-modules";
import {
  MODULE_PROXY_BASE_BINDING,
  MODULE_PROXY_TOKEN_BINDING,
  verifyTenantProxyToken,
} from "../src/runpod-proxy-auth";
import { PROXY_UPSTREAM_PREFIX } from "../src/runpod-proxy-route-match";
import { tenantModuleProxy, publicOrigin, type ControlPlaneEnv } from "../src/env";
import { provisionerWiring } from "../src/deps";
import { CfApi, type WorkerBinding } from "../src/cf-api";
import type { ControlPlaneStore, Tenant } from "../src/store";

// NON-DEFAULT VALUES THROUGHOUT (the probe-with-a-non-default rule). On `studio.vivijure.com` a
// derived base and a hardcoded one are byte-identical, so a host nobody would ever hardcode is what
// makes "derived" a claim this file can actually test.
const HOST = "plane.nondefault-cp288.test";
const SIGNING_KEY = "cp288-signing-key-not-the-default";
const TENANT = "ten_1";
const OTHER_TENANT = "ten_2";
const TENANT_D1 = "d1-uuid-acme";

const ENDPOINTS = [
  { key: "backend", label: "Backend", id: "ep1", name: "n1", endpointVar: "RUNPOD_ENDPOINT_ID" },
  { key: "upscale", label: "Upscale", id: "ep2", name: "n2", endpointVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { key: "lipsync", label: "Lip sync", id: "ep3", name: "n3", endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID" },
  { key: "audio-upscale", label: "Audio", id: "ep4", name: "n4", endpointVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
];

type Upload = { scriptName: string; bindings: WorkerBinding[] };

function deps(over: Partial<TenantModuleDeps> = {}): { d: TenantModuleDeps; uploads: Upload[]; logs: unknown[][] } {
  const uploads: Upload[] = [];
  const logs: unknown[][] = [];
  const d = {
    cf: {
      createDispatchNamespace: vi.fn(async () => {}),
      uploadUserWorker: vi.fn(async (a: Upload) => void uploads.push(a)),
    },
    moduleNamespace: "vivijure-tenant-modules",
    aiGatewayId: "vivijure-hosted",
    runpodProxy: { base: `https://${HOST}${PROXY_UPSTREAM_PREFIX}`, signingKey: SIGNING_KEY },
    moduleBundle: {
      fetch: vi.fn(async () => ({
        mainModule: "worker.js",
        moduleText: "export default {}",
        compatibilityDate: "2026-06-01",
      })),
    },
    release: "v1.0.0",
    callTenantModule: vi.fn(async () => ({ status: 200, text: "{}" })),
    callTenantStudio: vi.fn(async () => ({ status: 201, text: "{}" })),
    log: vi.fn((...a: unknown[]) => void logs.push(a)),
    ...over,
  } as unknown as TenantModuleDeps;
  return { d, uploads, logs };
}

const forModule = (uploads: Upload[], name: string): Upload => uploads.find((u) => u.scriptName.endsWith(name))!;
const named = (u: Upload, name: string) => u.bindings.find((b) => b.name === name);
const text = (b: WorkerBinding | undefined) => (b as { text?: string } | undefined)?.text;

/** Straight off the catalog rather than re-listed: a list copied into a test proves the copy. The
 *  predicate is the SAME one the upload branches on -- endpoint-backed, i.e. talks to RunPod. */
const ENDPOINT_BACKED = TENANT_MODULE_CATALOG.filter((s) => s.endpointKey).map((s) => s.module);
const NOT_ENDPOINT_BACKED = TENANT_MODULE_CATALOG.filter((s) => !s.endpointKey).map((s) => s.module);

// ---- 0. THE CONTROL, RUN BEFORE ANY CLAIM ------------------------------------------------------
// N81: at the moment of confirming a change landed, the incentive has inverted and the matcher that
// agrees with you is the one nobody checks. `named()` returning undefined is the value every
// negative assertion below rests on, so it is proved capable of BOTH answers first.

describe("CONTROL: the binding finder can return both answers", () => {
  it("finds a binding that is definitely there, and misses one that is definitely not", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, TENANT, "acme-films", ENDPOINTS, TENANT_D1, undefined, "AIG");
    const keyframe = forModule(uploads, "keyframe");
    // POSITIVE: a binding the pre-existing code has always pushed.
    expect(named(keyframe, "RUNPOD_ENDPOINT_ID")).toBeDefined();
    // NEGATIVE: a name nothing binds. Without this, every `toBeUndefined()` below would pass on a
    // finder that had silently stopped matching anything at all.
    expect(named(keyframe, "NO_SUCH_BINDING_CP288")).toBeUndefined();
  });
});

// ---- 1. the pair lands, on the right modules, with the right values -----------------------------

describe("uploadTenantModules binds the RunPod proxy pair", () => {
  it("binds base + token on every endpoint-backed module", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, TENANT, "acme-films", ENDPOINTS, TENANT_D1, undefined, "AIG");
    expect(ENDPOINT_BACKED.length).toBeGreaterThan(0); // denominator, so an empty catalog cannot pass
    for (const m of ENDPOINT_BACKED) {
      const u = forModule(uploads, m);
      expect(named(u, MODULE_PROXY_BASE_BINDING), m).toEqual({
        type: "plain_text",
        name: MODULE_PROXY_BASE_BINDING,
        text: `https://${HOST}${PROXY_UPSTREAM_PREFIX}`,
      });
      // secret_text, not plain_text: it is inert against RunPod but it still authenticates this
      // tenant to our own routes, and a plain_text binding is readable from the dashboard.
      expect(named(u, MODULE_PROXY_TOKEN_BINDING)?.type, m).toBe("secret_text");
    }
  });

  it("binds a token that VERIFIES, and verifies as THIS tenant", async () => {
    // The shape that would otherwise ship silently: a well-formed token minted for the wrong tenant,
    // or under the wrong key. Both bind fine, both look fine, and both 401 at the first submit.
    const { d, uploads } = deps();
    await uploadTenantModules(d, TENANT, "acme-films", ENDPOINTS, TENANT_D1, undefined, "AIG");
    const token = text(named(forModule(uploads, "keyframe"), MODULE_PROXY_TOKEN_BINDING));
    expect(await verifyTenantProxyToken(SIGNING_KEY, token)).toBe(TENANT);
    // Control on the verifier itself: it must be capable of returning null here, or the line above
    // is satisfied by a function that says yes to everything.
    expect(await verifyTenantProxyToken("a-different-signing-key", token)).toBeNull();
  });

  it("gives two tenants two different tokens", async () => {
    const a = deps();
    const b = deps();
    await uploadTenantModules(a.d, TENANT, "acme-films", ENDPOINTS, TENANT_D1, undefined, "AIG");
    await uploadTenantModules(b.d, OTHER_TENANT, "beta-films", ENDPOINTS, TENANT_D1, undefined, "AIG");
    const ta = text(named(forModule(a.uploads, "keyframe"), MODULE_PROXY_TOKEN_BINDING));
    const tb = text(named(forModule(b.uploads, "keyframe"), MODULE_PROXY_TOKEN_BINDING));
    expect(ta).not.toEqual(tb);
    expect(await verifyTenantProxyToken(SIGNING_KEY, tb)).toBe(OTHER_TENANT);
  });

  it("re-deriving is idempotent -- a re-provision does not issue a second live credential", async () => {
    const first = deps();
    const second = deps();
    await uploadTenantModules(first.d, TENANT, "acme-films", ENDPOINTS, TENANT_D1, undefined, "AIG");
    await uploadTenantModules(second.d, TENANT, "acme-films", ENDPOINTS, TENANT_D1, undefined, "AIG");
    expect(text(named(forModule(first.uploads, "keyframe"), MODULE_PROXY_TOKEN_BINDING))).toEqual(
      text(named(forModule(second.uploads, "keyframe"), MODULE_PROXY_TOKEN_BINDING)),
    );
  });

  it("does NOT bind either half on a module that talks to no endpoint", async () => {
    // plan-enhance reaches Anthropic through the AI Gateway and submits no RunPod job, so a proxy
    // credential there is reach it never uses. Same discipline as TELEMETRY_DB.
    const { d, uploads } = deps();
    await uploadTenantModules(d, TENANT, "acme-films", ENDPOINTS, TENANT_D1, undefined, "AIG");
    expect(NOT_ENDPOINT_BACKED.length).toBeGreaterThan(0);
    for (const m of NOT_ENDPOINT_BACKED) {
      const u = forModule(uploads, m);
      expect(named(u, MODULE_PROXY_BASE_BINDING), m).toBeUndefined();
      expect(named(u, MODULE_PROXY_TOKEN_BINDING), m).toBeUndefined();
    }
  });
});

// ---- 2. BOTH OR NEITHER, which is the whole failure mode ----------------------------------------

describe("an unconfigured plane binds NEITHER half", () => {
  it("uploads modules with no proxy binding at all, and says so", async () => {
    const { d, uploads, logs } = deps({ runpodProxy: null } as Partial<TenantModuleDeps>);
    await uploadTenantModules(d, TENANT, "acme-films", ENDPOINTS, TENANT_D1, undefined, "AIG");
    for (const m of ENDPOINT_BACKED) {
      const u = forModule(uploads, m);
      expect(named(u, MODULE_PROXY_BASE_BINDING), m).toBeUndefined();
      expect(named(u, MODULE_PROXY_TOKEN_BINDING), m).toBeUndefined();
      // NOT a degrade this file invented: the module still has its endpoint id and still gets the
      // direct key later, which is the pre-proxy path exactly as it was.
      expect(named(u, "RUNPOD_ENDPOINT_ID"), m).toBeDefined();
    }
    // A silent skip and a reported one are different things; only one is findable at 3am.
    expect(logs.filter((l) => l[0] === "module.runpod_proxy_unconfigured")).toHaveLength(
      ENDPOINT_BACKED.length,
    );
  });

  it("refuses to bind a base for a tenant id the mint cannot cover", async () => {
    // mintTenantProxyToken returns null on an id carrying the token separator. The pair must go
    // together: binding the base here would point the module at the proxy with nothing to present.
    const { d, uploads } = deps();
    await uploadTenantModules(d, "ten.dotted", "acme-films", ENDPOINTS, TENANT_D1, undefined, "AIG");
    const u = forModule(uploads, "keyframe");
    expect(named(u, MODULE_PROXY_BASE_BINDING)).toBeUndefined();
    expect(named(u, MODULE_PROXY_TOKEN_BINDING)).toBeUndefined();
  });
});

// ---- 3. the base is DERIVED, and it is not RunPod --------------------------------------------

describe("tenantModuleProxy derives the base", () => {
  const env = (over: Partial<ControlPlaneEnv> = {}): ControlPlaneEnv =>
    ({ CONTROL_PLANE_HOST: HOST, RUNPOD_PROXY_SIGNING_KEY: SIGNING_KEY, ...over }) as ControlPlaneEnv;

  it("is the plane's own origin plus the proxy's own prefix, never a literal", () => {
    const got = tenantModuleProxy(env())!;
    expect(got.base).toBe(`${publicOrigin(env())}${PROXY_UPSTREAM_PREFIX}`);
    // The point of the whole issue: this must NOT be RunPod. A base that still pointed upstream
    // would bind cleanly, render cleanly, meter nothing, and leave the credential where it was.
    expect(got.base).not.toContain("api.runpod.ai");
    expect(got.base).toContain(HOST);
  });

  it("is NULL when either half of the config is absent -- never half a pair", () => {
    expect(tenantModuleProxy(env({ CONTROL_PLANE_HOST: undefined }))).toBeNull();
    expect(tenantModuleProxy(env({ RUNPOD_PROXY_SIGNING_KEY: undefined }))).toBeNull();
    // ALLOW_EMPTY vars arrive as "" rather than undefined (the cp#218 shape). An empty host would
    // otherwise derive `https:///api/runpod/v2`: a base that resolves nowhere and looks configured.
    expect(tenantModuleProxy(env({ CONTROL_PLANE_HOST: "" }))).toBeNull();
    expect(tenantModuleProxy(env({ RUNPOD_PROXY_SIGNING_KEY: "  " }))).toBeNull();
    // POSITIVE CONTROL: the same builder with nothing removed returns a value, so the four nulls
    // above are answers about the inputs rather than about a function that returns null always.
    expect(tenantModuleProxy(env())).not.toBeNull();
  });
});

// ---- 4. the direct key SURVIVES. this is the ordering constraint, asserted --------------------

describe("RUNPOD_API_KEY is still installed alongside the proxy pair (cf#394 ordering)", () => {
  afterEach(() => vi.restoreAllMocks());

  const fullEnv = (): ControlPlaneEnv =>
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
    }) as ControlPlaneEnv;

  it("the REAL wiring, with the proxy configured, still PUTs key B on every module script", async () => {
    // The un-stubbable seam (CfApi.putScriptSecret) over the real provisionerWiring, not a fake:
    // this change must not have removed, reordered or short-circuited the direct-key fan-out. The
    // plane may stop installing this key only AFTER vivijure-cf ships prefer-proxy-with-fallback.
    const puts: { namespace: string; script: string; name: string }[] = [];
    vi.spyOn(CfApi.prototype, "putScriptSecret").mockImplementation(
      async (namespace: string, script: string, name: string) => void puts.push({ namespace, script, name }),
    );
    const tenant = { id: "ten_abc123", slug: "hero", script_name: "tenant-hero-studio" } as Tenant;
    const w = provisionerWiring(fullEnv(), {} as ControlPlaneStore)!;
    // The readiness probe after the PUTs needs no dispatch binding to answer; we assert on the
    // recorded writes, not on its verdict.
    await w.installInvokeKey(tenant, "rpa_keyB_SECRET").catch(() => undefined);

    // Control: a silent no-op recorder would make every assertion below vacuous.
    expect(puts.length).toBeGreaterThan(0);
    for (const spec of TENANT_MODULE_CATALOG) {
      const script = tenantModuleScriptName(tenant.id, spec.module);
      expect(puts.filter((p) => p.script === script && p.name === "RUNPOD_API_KEY"), spec.module).toHaveLength(1);
    }
    expect(puts.filter((p) => p.script === tenant.script_name && p.name === "RUNPOD_API_KEY")).toHaveLength(1);
  });

  it("the upload itself does not bind RUNPOD_API_KEY, which is why the PUT above is load-bearing", async () => {
    // A worker upload REPLACES its bindings, so the key has always arrived afterwards by PUT. Said
    // out loud here because the obvious wrong fix for the test above is to bind the key at upload.
    const { d, uploads } = deps();
    await uploadTenantModules(d, TENANT, "acme-films", ENDPOINTS, TENANT_D1, undefined, "AIG");
    for (const u of uploads) expect(named(u, "RUNPOD_API_KEY"), u.scriptName).toBeUndefined();
  });
});
