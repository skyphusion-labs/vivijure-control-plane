import { TEST_VPC_DOORS } from "./door-fixture";
// cf#56: the per-tenant AI Gateway credential on the plan-enhance module.
//
// What these assert is the SILENT-DEGRADE class, not the happy path. Every failure mode here reads
// green at a glance: a module uploaded with half the pair still uploads, still installs, still
// serves, and simply answers on the free local provider forever while we believe tenants are on
// Opus and being metered for it.

import { describe, it, expect, vi } from "vitest";
import { uploadTenantModules, TENANT_MODULE_CATALOG, reachesRunpod, type TenantModuleDeps } from "../src/tenant-modules";
import { endpointBackedPlan } from "../src/runpod";
import { CfApiError, classifyVpcBindingFailure, type WorkerBinding } from "../src/cf-api";

// The tenant studio D1 uuid the recording modules get as TELEMETRY_DB (cp#248).
const TENANT_D1 = "d1-uuid-acme";
// cp#284: the TENANT bucket. A distinctive value, not "vivijure", so a binding that
// silently carried the OPERATOR bucket would be visible rather than plausible.
const TENANT_BUCKET = "vivijure-tenant-acme-films";
// DERIVED from the plan, not hand-listed (cp#396). A four-entry literal here was a fixture claiming
// a shape the code can no longer produce: only ENDPOINT-BACKED capabilities yield endpoints now.
const ENDPOINTS = endpointBackedPlan().map((spec, i) => ({
  key: spec.key,
  label: spec.label,
  id: `ep${i + 1}`,
  name: `n${i + 1}`,
  endpointVar: spec.endpointVar,
}));

// POPULATION derived from the catalog (cp#314). A hardcoded list is the silent-gap shape: when
// finish-rife joined the catalog this guard stayed green and simply never looked. The proxy suite
// already derives ENDPOINT_BACKED the same way. Derive the set of modules to INSPECT, never the
// EXPECTATION of what their bindings should be (that would invert the assertion into a tautology).
// cp#396: endpoint-backed means the plan gives this capability a RunPod ENDPOINT, which is now a
// strict subset of "has an endpointKey" -- vpc-backed capabilities have a key and a door instead.
const ENDPOINT_BACKED = TENANT_MODULE_CATALOG.filter((s) => Boolean(s.endpointKey) && endpointBackedPlan().some((c) => c.key === s.endpointKey)).map((s) => s.module);
const NOT_GATEWAY_BACKED = TENANT_MODULE_CATALOG.filter((s) => !s.needsAiGateway).map((s) => s.module);
// The credential-boundary names that must never land on a non-gateway module.
const AIG_CREDENTIAL_NAMES = ["AI", "GATEWAY_ID", "CF_AIG_TOKEN"] as const;
const AIG_ATTRIBUTION_NAMES = ["TENANT_ID", "TENANT_SLUG"] as const;

type Upload = { scriptName: string; bindings: WorkerBinding[] };

function deps(over: Partial<TenantModuleDeps> = {}): { d: TenantModuleDeps; uploads: Upload[]; logs: string[]; wrongCredential: Upload[] } {
  const uploads: Upload[] = [];
  // cp#464: anything landing here means the module upload used the GENERAL credential. It must stay
  // empty; that is the assertion the credential split exists for.
  const wrongCredential: Upload[] = [];
  const logs: string[] = [];
  const d = {
    cf: {
      createDispatchNamespace: vi.fn(async () => undefined),
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
    log: vi.fn((event: string) => void logs.push(event)),
    ...over,
  } as unknown as TenantModuleDeps;
  return { d, uploads, logs, wrongCredential };
}

const forModule = (uploads: Upload[], name: string): Upload =>
  uploads.find((u) => u.scriptName.endsWith(name))!;
const names = (u: Upload): string[] => u.bindings.map((b) => b.name).sort();
const byName = (u: Upload, n: string) => u.bindings.find((b) => b.name === n);

describe("plan-enhance is in the catalog and is NOT endpoint-backed", () => {
  it("is present, and declares no endpointKey", () => {
    const spec = TENANT_MODULE_CATALOG.find((s) => s.module === "plan-enhance");
    expect(spec).toBeDefined();
    expect(spec!.endpointKey).toBeUndefined();
    expect(spec!.needsAiGateway).toBe(true);
  });

  // POSITIVE CONTROL for the assertion above: the other entries DO declare one, so
  // "endpointKey is undefined" is a real property of this spec and not of the fixture.
  it("POSITIVE CONTROL: every other catalog entry reaches RunPod, by one route or the other", () => {
    // cp#284 WIDENED this rather than weakening it. It used to assert an endpointKey on every
    // non-plan-enhance entry, which stopped being true when the cost door arrived: those eight
    // reach RunPod at a PUBLIC slug with no endpoint of ours. The property that actually makes
    // "plan-enhance is not RunPod-backed" a real fact about that spec is reachesRunpod, which is
    // also the predicate the proxy pair branches on -- so this control now guards the same thing
    // the upload does, instead of a proxy for it that the catalog outgrew.
    for (const spec of TENANT_MODULE_CATALOG.filter((s) => !s.needsAiGateway)) {
      expect(reachesRunpod(spec), spec.module).toBe(true);
    }
  });
});

describe("uploadTenantModules -- the AI Gateway trio", () => {
  it("binds AI + GATEWAY_ID + CF_AIG_TOKEN on plan-enhance when both are configured", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", "ten_1", "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "dedicated", undefined, "AIG_SECRET_VALUE");
    const pe = forModule(uploads, "plan-enhance");
    // EXACT set, deliberately: an unexpected extra binding must fail here rather than be
    // waved through by a toContain. TENANT_ID/TENANT_SLUG are the cp#185 attribution vars.
    expect(names(pe)).toEqual(["AI", "CF_AIG_TOKEN", "GATEWAY_ID", "TENANT_ID", "TENANT_SLUG"]);
    expect(byName(pe, "AI")!.type).toBe("ai");
    // The gateway id is an identifier, so it rides as plain_text; the token is a secret.
    expect(byName(pe, "GATEWAY_ID")).toMatchObject({ type: "plain_text", text: "vivijure-hosted" });
    expect(byName(pe, "CF_AIG_TOKEN")!.type).toBe("secret_text");
  });

  it("gives plan-enhance NO RUNPOD_ENDPOINT_ID (it is not endpoint-backed)", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", "ten_1", "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "dedicated", undefined, "AIG_SECRET_VALUE");
    expect(names(forModule(uploads, "plan-enhance"))).not.toContain("RUNPOD_ENDPOINT_ID");
  });

  it("does NOT leak the AI Gateway credential names onto any non-gateway module", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", "ten_1", "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "dedicated", undefined, "AIG_SECRET_VALUE");
    // Denominator: an empty filter (catalog of only gateway modules, or a filter bug) must not
    // pass. Same shape as module-proxy-binding.test.ts's ENDPOINT_BACKED.length guard.
    expect(NOT_GATEWAY_BACKED.length).toBeGreaterThan(0);
    for (const m of NOT_GATEWAY_BACKED) {
      const n = names(forModule(uploads, m));
      // POSITIVE CONTROL first: the module was uploaded and carries at least one of its own
      // bindings, so the absences below are real absences and not an empty upload record.
      expect(forModule(uploads, m), m).toBeDefined();
      expect(n.length, m).toBeGreaterThan(0);
      for (const name of AIG_CREDENTIAL_NAMES) {
        expect(n, `${m} must not carry ${name}`).not.toContain(name);
      }
    }
    // Endpoint-backed subset still gets RUNPOD_ENDPOINT_ID (positive control that these are the
    // modules that used to be hand-listed). Not an exact-set: cost-door rows and future writers
    // carry different extras, and that is not this guard's claim.
    expect(ENDPOINT_BACKED.length).toBeGreaterThan(0);
    for (const m of ENDPOINT_BACKED) {
      expect(names(forModule(uploads, m)), m).toContain("RUNPOD_ENDPOINT_ID");
    }
  });

  // BOTH OR NEITHER. pickProvider returns "opus" only when GATEWAY_ID and CF_AIG_TOKEN are BOTH
  // present, so a half-bound module is a silent permanent fallback, not a partial feature.
  it("binds NEITHER when the token is missing, and says so in the log", async () => {
    const { d, uploads, logs } = deps();
    await uploadTenantModules(d, "v1.0.0", "ten_1", "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "dedicated", undefined, null);
    const pe = forModule(uploads, "plan-enhance");
    // AI still bound (the local fallback needs it); TENANT_ID/TENANT_SLUG still bound because
    // attribution is deliberately NOT gated on the token (cp#185). The trio itself is absent.
    expect(names(pe)).toEqual(["AI", "TENANT_ID", "TENANT_SLUG"]);
    expect(names(pe)).not.toContain("GATEWAY_ID");
    expect(names(pe)).not.toContain("CF_AIG_TOKEN");
    expect(logs).toContain("module.ai_gateway_unconfigured");
  });

  it("binds NEITHER when the plane names no gateway, and still uploads a working module", async () => {
    const { d, uploads, logs } = deps({ aiGatewayId: null } as Partial<TenantModuleDeps>);
    await uploadTenantModules(d, "v1.0.0", "ten_1", "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "dedicated", undefined, "AIG_SECRET_VALUE");
    const pe = forModule(uploads, "plan-enhance");
    expect(names(pe)).toEqual(["AI", "TENANT_ID", "TENANT_SLUG"]);
    expect(names(pe)).not.toContain("GATEWAY_ID");
    expect(logs).toContain("module.ai_gateway_unconfigured");
  });
  // A tenant missing a RunPod endpoint must still fail loudly. plan-enhance made endpointKey
  // optional, and cp#396 made it possible for a key to exist with NO endpoint by design -- the risk
  // of both changes is that they silently soften THIS check.
  //
  // The missing capability is DERIVED, not named. It used to read /needs the upscale endpoint/, and
  // upscale is now vpc-backed, so that literal would have made this test assert a refusal that can
  // no longer happen. Taking the second endpoint-backed key keeps the claim true whatever the plan
  // holds: provisioning only the FIRST endpoint must still be refused, by name.
  it("still refuses loudly when an ENDPOINT-BACKED module has no endpoint", async () => {
    const { d } = deps();
    const backed = endpointBackedPlan();
    expect(backed.length, "need at least two endpoint-backed capabilities to withhold one").toBeGreaterThan(1);
    const withheld = backed[1].key;
    await expect(
      uploadTenantModules(d, "v1.0.0", "ten_1", "acme-films", [ENDPOINTS[0]], TENANT_D1, TENANT_BUCKET, "dedicated", undefined, "AIG_SECRET_VALUE"),
    ).rejects.toThrow(new RegExp(`needs the ${withheld} endpoint`));
  });

  // BAKED LESSON: a negative-about-secrets test that reads FINAL state is worthless. Assert the
  // value was never PASSED to anything that persists, with a control proving the recorder works.
  it("never passes the token VALUE to anything but the secret_text binding", async () => {
    const persisted: unknown[] = [];
    const { d, uploads } = deps({
      log: vi.fn((event: string, fields: Record<string, unknown>) => {
        persisted.push(event, JSON.stringify(fields));
      }),
    } as Partial<TenantModuleDeps>);
    await uploadTenantModules(d, "v1.0.0", "ten_1", "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "dedicated", undefined, "AIG_SECRET_VALUE");

    // CONTROL: the recorder really does capture what it is given.
    persisted.push("CONTROL_CANARY");
    expect(persisted).toContain("CONTROL_CANARY");

    expect(JSON.stringify(persisted)).not.toContain("AIG_SECRET_VALUE");
    // ...and it DID reach the one place it belongs, so the assertion above is not vacuous.
    const pe = forModule(uploads, "plan-enhance");
    expect(byName(pe, "CF_AIG_TOKEN")).toMatchObject({ type: "secret_text", text: "AIG_SECRET_VALUE" });
  });
});

// cp#185: the per-tenant attribution vars.
//
// The gateway records `authentication` as a BOOLEAN -- it logs THAT a request was authenticated,
// never WHICH token -- so the per-tenant CF_AIG_TOKEN provides access control and revocation and
// ZERO attribution. `cf-aig-metadata`, which the module builds from these two vars, is the entire
// attribution mechanism. If they stop being bound the meter does not break loudly: it silently
// attributes nothing, and unattributed spend is money WE eat rather than the tenant.
describe("uploadTenantModules -- per-tenant attribution vars (cp#185)", () => {
  it("binds TENANT_ID and TENANT_SLUG on the gateway-backed module", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", "ten_1", "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "dedicated", undefined, "AIG_SECRET_VALUE");
    const pe = forModule(uploads, "plan-enhance");
    expect(byName(pe, "TENANT_ID")).toMatchObject({ type: "plain_text", text: "ten_1" });
    expect(byName(pe, "TENANT_SLUG")).toMatchObject({ type: "plain_text", text: "acme-films" });
  });

  // plain_text, not secret_text. Neither is a secret, and binding an identifier as a secret would
  // make it unreadable in the dashboard for no benefit while implying a custody requirement.
  it("binds them as plain_text, never as secrets", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", "ten_1", "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "dedicated", undefined, "AIG_SECRET_VALUE");
    const pe = forModule(uploads, "plan-enhance");
    for (const n of ["TENANT_ID", "TENANT_SLUG"]) {
      expect(byName(pe, n)!.type, n).toBe("plain_text");
      expect(byName(pe, n)!.type, n).not.toBe("secret_text");
    }
  });

  // DELIBERATE: not gated on the token. With the trio unconfigured the module runs on the free
  // local provider and never makes a gateway call, so these are simply unread. Gating them on the
  // token would couple two unrelated things and invite the belief that attribution is optional
  // when the gateway IS configured.
  it("binds them even when NO gateway token was minted", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", "ten_1", "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "dedicated", undefined, null);
    const pe = forModule(uploads, "plan-enhance");
    expect(byName(pe, "TENANT_ID")).toBeDefined();
    expect(byName(pe, "TENANT_SLUG")).toBeDefined();
    // ...and the token pair genuinely was NOT bound, so the assertion above is about the vars
    // rather than about a fixture that binds everything regardless.
    expect(byName(pe, "CF_AIG_TOKEN")).toBeUndefined();
  });

  // Scoped to gateway-backed modules. A RunPod-backed module makes no gateway call, so binding a
  // tenant id onto it would be noise that implies a meter that does not exist for it.
  //
  // POPULATION FROM THE CATALOG (cp#314). This used to inspect only `keyframe`. A single named
  // sample is the same silent-gap shape as the hardcoded endpoint-backed list: a new non-gateway
  // row that accidentally picked up TENANT_ID would not turn this red.
  it("does NOT bind them on modules that are not gateway-backed", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", "ten_1", "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "dedicated", undefined, "AIG_SECRET_VALUE");
    expect(NOT_GATEWAY_BACKED.length).toBeGreaterThan(0);
    for (const m of NOT_GATEWAY_BACKED) {
      const u = forModule(uploads, m);
      expect(u, m).toBeDefined();
      // POSITIVE CONTROL: something of this module's own is present so the absences are real.
      expect(names(u).length, m).toBeGreaterThan(0);
      for (const name of AIG_ATTRIBUTION_NAMES) {
        expect(names(u), `${m} must not carry ${name}`).not.toContain(name);
      }
    }
  });
});

describe("module uploads run on the SCRIPT UPLOAD credential (cp#464)", () => {
  // WHY THIS TEST EXISTS. The door pool attaches vpc_service bindings to MODULE workers, and those
  // uploads used the GENERAL provisioner credential while the studio upload used the dedicated
  // script-upload one. Only the second had ever been granted Connectivity Directory, so a door
  // binding was uploaded by a credential that could not attach it. Nothing stated the two had to
  // match and nothing detected that they had diverged; the first symptom was a dead provision.
  //
  // The assertion is a PAIR, and the second half is the one that can fail. Asserting only that the
  // upload credential was used would also pass if BOTH were called -- which is exactly the state
  // where a stray deps.cf upload still slips a door binding onto the wrong token.
  it("uploads through scriptUploadCf, and NEVER through the general client", async () => {
    const { d, uploads, wrongCredential } = deps();

    await uploadTenantModules(d, "v1.0.0", "ten_1", "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "dedicated", undefined, "AIG_SECRET_VALUE");

    // It really uploaded, so the emptiness below is not vacuous.
    expect(uploads.length).toBeGreaterThan(0);
    // The general credential was not used for a single script.
    expect(wrongCredential).toEqual([]);
  });
});

describe("leftover VPC upload errors are still classified (cp#462)", () => {
  it("classifyVpcBindingFailure names a leftover 10196 when vpc_service was attached", () => {
    const e = new CfApiError("wfp.upload", 403, [
      { code: 10196, message: "Workers VPC binding configuration failed because your credentials are not authorized" },
    ]);
    expect(classifyVpcBindingFailure(e, true)).toEqual({ kind: "refused" });
    expect(classifyVpcBindingFailure(e, false)).toEqual({ kind: "unrelated" });
  });

  it("reports unmatched when the known code does NOT match", () => {
    const e = new CfApiError("wfp.upload", 400, [{ code: 99999, message: "VPC binding configuration failed" }]);
    expect(classifyVpcBindingFailure(e, true)).toEqual({
      kind: "unmatched",
      codes: [99999],
      messages: ["VPC binding configuration failed"],
    });
  });
});
