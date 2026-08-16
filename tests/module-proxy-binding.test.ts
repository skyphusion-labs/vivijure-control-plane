import { TEST_VPC_DOORS } from "./door-fixture";
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
  reachesRunpod,
  tenantModuleScriptName,
  type TenantModuleDeps,
} from "../src/tenant-modules";
import {
  MODULE_PROXY_BASE_BINDING,
  MODULE_PROXY_TOKEN_BINDING,
  verifyTenantProxyToken,
} from "../src/runpod-proxy-auth";
import { PROXY_UPSTREAM_PREFIX, matchProxyRoute } from "../src/runpod-proxy-route-match";
import { endpointBackedPlan, vpcBackedPlan } from "../src/runpod";
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
// cp#284: the TENANT bucket. A distinctive value, not "vivijure", so a binding that
// silently carried the OPERATOR bucket would be visible rather than plausible.
const TENANT_BUCKET = "vivijure-tenant-acme-films";

const ENDPOINTS = [
  { key: "backend", label: "Backend", id: "ep1", name: "n1", endpointVar: "RUNPOD_ENDPOINT_ID" },
  { key: "upscale", label: "Upscale", id: "ep2", name: "n2", endpointVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { key: "lipsync", label: "Lip sync", id: "ep3", name: "n3", endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID" },
  { key: "wan-train", label: "Cast LoRA training (Wan)", id: "ep4", name: "n4", endpointVar: "RUNPOD_WAN_TRAIN_ENDPOINT_ID" },
  { key: "audio-upscale", label: "Audio", id: "ep4", name: "n4", endpointVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
];

type Upload = { scriptName: string; bindings: WorkerBinding[] };

function deps(over: Partial<TenantModuleDeps> = {}): { d: TenantModuleDeps; uploads: Upload[]; logs: unknown[][] } {
  const uploads: Upload[] = [];
  // cp#464: anything landing here means the module upload used the GENERAL credential. It must stay
  // empty; that is the assertion the credential split exists for.
  const wrongCredential: Upload[] = [];
  const logs: unknown[][] = [];
  const d = {
    cf: {
      createDispatchNamespace: vi.fn(async () => {}),
      uploadUserWorker: vi.fn(async (a: Upload) => void wrongCredential.push(a)),
    },
    // cp#464: module uploads run on the SCRIPT UPLOAD credential, not the general one. These are
    // SEPARATE recorders on purpose: pointing both at one array would let every assertion below
    // pass whichever client the source actually used, which is the thing under test.
    scriptUploadCf: {
      createDispatchNamespace: vi.fn(async () => undefined),
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
    callTenantModule: vi.fn(async () => ({ status: 200, text: "{}" })),
    callTenantStudio: vi.fn(async () => ({ status: 201, text: "{}" })),
    vpcDoors: TEST_VPC_DOORS,
    log: vi.fn((...a: unknown[]) => void logs.push(a)),
    ...over,
  } as unknown as TenantModuleDeps;
  return { d, uploads, logs };
}

const forModule = (uploads: Upload[], name: string): Upload => uploads.find((u) => u.scriptName.endsWith(name))!;
const named = (u: Upload, name: string) => u.bindings.find((b) => b.name === name);
const text = (b: WorkerBinding | undefined) => (b as { text?: string } | undefined)?.text;

/** Straight off the catalog rather than re-listed: a list copied into a test proves the copy.
 *
 *  TWO POPULATIONS NOW, AND CONFLATING THEM WAS THE cp#284 DEFECT. `endpointKey` says a module
 *  carries one of OUR endpoint ids; `reachesRunpod` says it talks to RunPod at all. They were the
 *  same set until the cost door arrived, whose eight modules submit to PUBLIC vendor slugs with no
 *  endpoint of ours -- so the proxy pair, which every RunPod-reaching module needs, must key on
 *  reachesRunpod. Keying it on endpointKey would have left those eight on the DIRECT RunPod key on
 *  a shared tenant. Each list below is used for exactly the claim it names. */
// cp#396: endpointKey no longer means "gets a RUNPOD_ENDPOINT_ID binding". It means the module has
// a CAPABILITY in the plan, and the plan now decides the TRANSPORT: endpoint-backed capabilities get
// an endpoint id, vpc-backed ones get a door binding and no endpoint id at all.
//
// Both sets are DERIVED from the plan rather than listed, and both are asserted non-empty below: a
// denominator that silently went to zero is how a loop-based assertion passes by testing nothing.
const endpointKeysOf = (keys: string[]) => TENANT_MODULE_CATALOG.filter((s) => Boolean(s.endpointKey) && keys.includes(String(s.endpointKey))).map((s) => s.module);
const ENDPOINT_BACKED = endpointKeysOf(endpointBackedPlan().map((c) => c.key));
const DOOR_BACKED = endpointKeysOf(vpcBackedPlan().map((c) => c.key));
const REACHES_RUNPOD = TENANT_MODULE_CATALOG.filter(reachesRunpod).map((s) => s.module);
const NOT_REACHING_RUNPOD = TENANT_MODULE_CATALOG.filter((s) => !reachesRunpod(s)).map((s) => s.module);

// ---- 0. THE CONTROL, RUN BEFORE ANY CLAIM ------------------------------------------------------
// N81: at the moment of confirming a change landed, the incentive has inverted and the matcher that
// agrees with you is the one nobody checks. `named()` returning undefined is the value every
// negative assertion below rests on, so it is proved capable of BOTH answers first.

describe("CONTROL: the binding finder can return both answers", () => {
  it("finds a binding that is definitely there, and misses one that is definitely not", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
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
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
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
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
    const token = text(named(forModule(uploads, "keyframe"), MODULE_PROXY_TOKEN_BINDING));
    expect(await verifyTenantProxyToken(SIGNING_KEY, token)).toBe(TENANT);
    // Control on the verifier itself: it must be capable of returning null here, or the line above
    // is satisfied by a function that says yes to everything.
    expect(await verifyTenantProxyToken("a-different-signing-key", token)).toBeNull();
  });

  it("gives two tenants two different tokens", async () => {
    const a = deps();
    const b = deps();
    await uploadTenantModules(a.d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
    await uploadTenantModules(b.d, "v1.0.0", OTHER_TENANT, "beta-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
    const ta = text(named(forModule(a.uploads, "keyframe"), MODULE_PROXY_TOKEN_BINDING));
    const tb = text(named(forModule(b.uploads, "keyframe"), MODULE_PROXY_TOKEN_BINDING));
    expect(ta).not.toEqual(tb);
    expect(await verifyTenantProxyToken(SIGNING_KEY, tb)).toBe(OTHER_TENANT);
  });

  it("re-deriving is idempotent -- a re-provision does not issue a second live credential", async () => {
    const first = deps();
    const second = deps();
    await uploadTenantModules(first.d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
    await uploadTenantModules(second.d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
    expect(text(named(forModule(first.uploads, "keyframe"), MODULE_PROXY_TOKEN_BINDING))).toEqual(
      text(named(forModule(second.uploads, "keyframe"), MODULE_PROXY_TOKEN_BINDING)),
    );
  });

  it("does NOT bind either half on a module that reaches no RunPod", async () => {
    // plan-enhance reaches Anthropic through the AI Gateway and submits no RunPod job, so a proxy
    // credential there is reach it never uses. Same discipline as TELEMETRY_DB.
    //
    // STILL DISCRIMINATING AFTER cp#284, which is the thing to check when a population grows by 8:
    // the eight cost-door modules ARE RunPod-reaching, so they moved OUT of this negative set and
    // into the positive one. The set is not empty (asserted below) and its one member is a genuine
    // non-RunPod module, so this still fails if the pair is ever bound too widely.
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
    expect(NOT_REACHING_RUNPOD.length).toBeGreaterThan(0);
    for (const m of NOT_REACHING_RUNPOD) {
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
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
    for (const m of ENDPOINT_BACKED) {
      const u = forModule(uploads, m);
      expect(named(u, MODULE_PROXY_BASE_BINDING), m).toBeUndefined();
      expect(named(u, MODULE_PROXY_TOKEN_BINDING), m).toBeUndefined();
      // NOT a degrade this file invented: the module still has its endpoint id and still gets the
      // direct key later, which is the pre-proxy path exactly as it was.
      expect(named(u, "RUNPOD_ENDPOINT_ID"), m).toBeDefined();
    }
    // A silent skip and a reported one are different things; only one is findable at 3am.
    expect(logs.filter((l) => l[0] === "module.runpod_proxy_unbound")).toHaveLength(
      REACHES_RUNPOD.length,
    );
  });

  it("refuses to bind a base for a tenant id the mint cannot cover", async () => {
    // mintTenantProxyToken returns null on an id carrying the token separator. The pair must go
    // together: binding the base here would point the module at the proxy with nothing to present.
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", "ten.dotted", "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
    const u = forModule(uploads, "keyframe");
    expect(named(u, MODULE_PROXY_BASE_BINDING)).toBeUndefined();
    expect(named(u, MODULE_PROXY_TOKEN_BINDING)).toBeUndefined();
  });
});

// ---- 2b. SHARED ONLY. the cross-repo contract, and the reason it is not a preference ----------
//
// vivijure-cf@67302960 modules/_shared/runpod-route.ts:45 -- "Bound ONLY for runpod_mode =
// 'shared'". That file branches on the base being BOUND and says in terms that it is NOT a
// failover, so a bound base on a tenant our own submit path refuses (runpod-proxy-routes.ts:73,
// 403 not_shared_mode) is not a degrade: it is every render on that tenant failing, with the
// direct path deliberately unavailable. `tenants.runpod_mode` is NOT NULL DEFAULT 'dedicated', so
// this is the majority population, not an edge case.

describe("the pair is bound for SHARED tenants only", () => {
  it("binds NEITHER half on a dedicated tenant", async () => {
    const { d, uploads, logs } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "dedicated", undefined, "AIG");
    for (const m of ENDPOINT_BACKED) {
      const u = forModule(uploads, m);
      expect(named(u, MODULE_PROXY_BASE_BINDING), m).toBeUndefined();
      expect(named(u, MODULE_PROXY_TOKEN_BINDING), m).toBeUndefined();
      // The dedicated tenant is not degraded, it is UNCHANGED: it keeps its endpoint id and gets
      // its own RunPod key later, exactly as before this feature existed.
      expect(named(u, "RUNPOD_ENDPOINT_ID"), m).toBeDefined();
    }
    // The plane IS configured here -- the deps carry a live proxy. So this proves the MODE is what
    // refused, not a missing configuration, which is the distinction the log line has to make.
    const unbound = logs.filter((l) => l[0] === "module.runpod_proxy_unbound");
    expect(unbound).toHaveLength(REACHES_RUNPOD.length);
    expect((unbound[0][1] as { mode: string; proxy: string }).mode).toBe("dedicated");
    expect((unbound[0][1] as { mode: string; proxy: string }).proxy).toBe("set");
  });

  it("POSITIVE CONTROL: the same deps, same tenant, same everything, shared -> both halves bound", async () => {
    // Without this the test above passes on a build where the pair is never bound at all, which is
    // the state the whole PR exists to leave behind.
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
    for (const m of ENDPOINT_BACKED) {
      expect(named(forModule(uploads, m), MODULE_PROXY_BASE_BINDING), m).toBeDefined();
      expect(named(forModule(uploads, m), MODULE_PROXY_TOKEN_BINDING), m).toBeDefined();
    }
  });

  it("does not MINT for a dedicated tenant, not merely decline to bind", async () => {
    // A token minted and dropped is a live credential nobody asked for. Asserted through the log
    // line rather than by spying the mint, because the log is what an operator would read.
    //
    // cp#290 CHANGED THE EVIDENCE AND MADE IT STRONGER. This used to read `token: "unset"`, which
    // is a value that is ALSO produced by a mint that ran and refused -- one field covering two
    // states, the shape this estate keeps getting caught by. The log now names the REASON, and
    // `not_shared_mode` is only reachable by the branch that returns BEFORE the mint
    // (tenantModuleProxyBinding), so it proves the stronger claim this test's title always made.
    const { d, logs } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "dedicated", undefined, "AIG");
    const unbound = logs.filter((l) => l[0] === "module.runpod_proxy_unbound");
    expect((unbound[0][1] as { reason: string }).reason).toBe("not_shared_mode");
    // CONTROL: the reason field discriminates. A plane with no proxy configured is a DIFFERENT
    // repair and must not collapse into the same string.
    const noProxy = deps({ runpodProxy: null } as Partial<TenantModuleDeps>);
    await uploadTenantModules(noProxy.d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
    const unbound2 = noProxy.logs.filter((l) => l[0] === "module.runpod_proxy_unbound");
    expect((unbound2[0][1] as { reason: string }).reason).toBe("plane_configures_no_proxy");
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
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
    for (const u of uploads) expect(named(u, "RUNPOD_API_KEY"), u.scriptName).toBeUndefined();
  });
});

// ---- 5. END TO END: the base we bind is a path this plane actually serves ----------------------
//
// The suffix is the half nobody checks. cf appends `/<endpointId>` then a RunPod verb to whatever
// we bind; if our base carried the wrong prefix, a trailing slash, or the bare origin, every call
// would 404 and the only symptom would be renders failing after this merged. So rather than
// asserting the string looks right, take the base we ACTUALLY bind, build the URL the way cf
// builds it, and feed the path to this plane's own shipped router.

describe("the bound base round-trips through the plane's own matcher", () => {
  /** cf's construction, mirrored from modules/_shared/runpod-route.ts: trim, strip trailing
   *  slashes, then `base + "/" + endpointId` and a verb suffix. */
  const cfUrl = (base: string, endpointId: string, suffix: string) =>
    base.trim().replace(/\/+$/, "") + "/" + endpointId + suffix;

  const boundBase = async (): Promise<string> => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
    return text(named(forModule(uploads, "keyframe"), MODULE_PROXY_BASE_BINDING))!;
  };

  it("submit, status, cancel and health all resolve to a route this plane serves", async () => {
    const base = await boundBase();
    const path = (suffix: string) => new URL(cfUrl(base, "ep1", suffix)).pathname;

    expect(matchProxyRoute("POST", path("/run"))).toEqual({ kind: "submit", endpointId: "ep1" });
    expect(matchProxyRoute("GET", path("/status/job_1"))).toMatchObject({ kind: "poll", op: "status" });
    expect(matchProxyRoute("POST", path("/cancel/job_1"))).toMatchObject({ kind: "poll", op: "cancel" });
    expect(matchProxyRoute("GET", path("/health"))).toMatchObject({ kind: "poll", op: "health" });
  });

  it("CONTROL: the matcher rejects a base built the WRONG way", async () => {
    // Without this the four assertions above are satisfied by a matcher that says yes to anything.
    // Both wrong shapes are ones a plausible implementation of this PR would have produced: the
    // bare origin, and the prefix without RunPod's own `/v2`.
    const origin = `https://${HOST}`;
    expect(matchProxyRoute("POST", new URL(cfUrl(origin, "ep1", "/run")).pathname)).toBeNull();
    expect(matchProxyRoute("POST", new URL(cfUrl(`${origin}/api/runpod`, "ep1", "/run")).pathname))
      .toEqual({ kind: "unknown" });
  });

  it("a trailing slash would still resolve, because cf strips it -- stated, not relied on", async () => {
    // cf tolerates one (`.replace(/\/+$/, "")`). We emit none. Asserting both keeps a future
    // reader from tightening our side against a tolerance that is really cf's.
    const base = await boundBase();
    expect(base.endsWith("/")).toBe(false);
    expect(matchProxyRoute("POST", new URL(cfUrl(base + "/", "ep1", "/run")).pathname))
      .toEqual({ kind: "submit", endpointId: "ep1" });
  });
});

// ---- cp#396: the OWN-IRON DOOR, on the module worker -------------------------------------------

describe("a vpc-backed capability gets a DOOR instead of an endpoint id", () => {
  it("binds EVERY door in the pool, and NO RUNPOD_ENDPOINT_ID", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
    expect(DOOR_BACKED.length, "denominator is empty; this asserts nothing").toBeGreaterThan(0);
    for (const m of DOOR_BACKED) {
      const u = forModule(uploads, m);
      const capability = vpcBackedPlan().find((c) => TENANT_MODULE_CATALOG.find((s) => s.module === m)?.endpointKey === c.key)!;
      // EVERY door, not just the first. Binding one would halve tenant capacity against an
      // operator studio that pools both, with no signal attached to the difference.
      expect(capability.doors.length, m).toBeGreaterThan(1);
      for (const d2 of capability.doors) {
        const door = named(u, d2.bindingName);
        expect(door, m + " " + d2.bindingName).toBeDefined();
        expect(door!.type, m).toBe("vpc_service");
        const bearer = named(u, d2.doorTokenBinding);
        expect(bearer, m + " " + d2.doorTokenBinding).toBeDefined();
        // secret_text, never plain_text: a bearer readable from the dashboard is a shared secret
        // nobody rotated.
        expect(bearer!.type, m).toBe("secret_text");
      }
      // Each door gets its OWN service id, so a copy-paste that pointed both at one box would
      // fail here rather than silently halving the pool back down again.
      const ids = capability.doors.map((x) => (named(u, x.bindingName) as unknown as { service_id: string }).service_id);
      expect(new Set(ids).size, m + " doors share a service id").toBe(capability.doors.length);
      // THE ABSENCE THAT MATTERS. An empty or stale endpoint id here binds clean and dies at the
      // tenant first render, which is the failure the transport split exists to remove.
      expect(named(u, "RUNPOD_ENDPOINT_ID"), m).toBeUndefined();
    }
  });

  it("REFUSES the upload when a vpc-backed capability has ZERO doors, naming EVERY pair", async () => {
    // A door-bound module with no door has NO transport at all: no endpoint id and no binding.
    // Uploading it would produce a studio that provisions green and dies at the first upscale.
    //
    // ZERO doors, not fewer-than-all: a pool of one is a working pool, so a plane that has wired
    // one box and not the other still provisions. Only the empty pool is a refusal.
    //
    // The refusal must NAME EVERY PAIR. An operator who set only the SECOND door would otherwise be
    // told to set vars they have already set, with nothing pointing at the legacy pair that is
    // actually missing -- a refusal that misattributes its own cause.
    const capability = vpcBackedPlan()[0];
    for (const door of capability.doors) {
      const { d } = deps({ vpcDoors: {} } as Partial<TenantModuleDeps>);
      await expect(
        uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG"),
      ).rejects.toThrow(new RegExp(door.serviceIdVar));
      const { d: d2 } = deps({ vpcDoors: {} } as Partial<TenantModuleDeps>);
      await expect(
        uploadTenantModules(d2, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG"),
      ).rejects.toThrow(new RegExp(door.doorTokenVar));
    }
  });

  it("a pool of ONE door still provisions: a partly-wired plane is not a refusal", async () => {
    // The other side of the rule above, and the reason it is ZERO doors rather than fewer-than-all.
    // vivijure-cf pickDoor is n % pool.length, so one door is always index 0 and serves every job.
    const capability = vpcBackedPlan()[0];
    const onlyLegacy = { [capability.key]: [TEST_VPC_DOORS[capability.key][0]] };
    const { d, uploads } = deps({ vpcDoors: { ...TEST_VPC_DOORS, ...onlyLegacy } } as Partial<TenantModuleDeps>);
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
    const m = DOOR_BACKED.find((x) => TENANT_MODULE_CATALOG.find((s) => s.module === x)?.endpointKey === capability.key)!;
    const u = forModule(uploads, m);
    expect(named(u, capability.doors[0].bindingName), m).toBeDefined();
    // ...and the door that was NOT configured is simply absent, rather than bound empty.
    expect(named(u, capability.doors[1].bindingName), m).toBeUndefined();
  });

  it("CONTROL: endpoint-backed modules still get the endpoint id and NO door", async () => {
    // Without this, the assertions above would also pass on a build that bound doors to everything.
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared", undefined, "AIG");
    expect(ENDPOINT_BACKED.length).toBeGreaterThan(0);
    for (const m of ENDPOINT_BACKED) {
      const u = forModule(uploads, m);
      expect(named(u, "RUNPOD_ENDPOINT_ID"), m).toBeDefined();
      for (const capability of vpcBackedPlan()) {
        for (const door of capability.doors) {
          expect(named(u, door.bindingName), m).toBeUndefined();
          expect(named(u, door.doorTokenBinding), m).toBeUndefined();
        }
      }
    }
  });
});
