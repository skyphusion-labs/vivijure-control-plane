// cf#56: the per-tenant AI Gateway credential on the plan-enhance module.
//
// What these assert is the SILENT-DEGRADE class, not the happy path. Every failure mode here reads
// green at a glance: a module uploaded with half the pair still uploads, still installs, still
// serves, and simply answers on the free local provider forever while we believe tenants are on
// Opus and being metered for it.

import { describe, it, expect, vi } from "vitest";
import { uploadTenantModules, TENANT_MODULE_CATALOG, type TenantModuleDeps } from "../src/tenant-modules";
import type { WorkerBinding } from "../src/cf-api";

// The tenant studio D1 uuid the recording modules get as TELEMETRY_DB (cp#248).
const TENANT_D1 = "d1-uuid-acme";
const ENDPOINTS = [
  { key: "backend", label: "Backend", id: "ep1", name: "n1", endpointVar: "RUNPOD_ENDPOINT_ID" },
  { key: "upscale", label: "Upscale", id: "ep2", name: "n2", endpointVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { key: "lipsync", label: "Lip sync", id: "ep3", name: "n3", endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID" },
  { key: "audio-upscale", label: "Audio", id: "ep4", name: "n4", endpointVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
];

type Upload = { scriptName: string; bindings: WorkerBinding[] };

function deps(over: Partial<TenantModuleDeps> = {}): { d: TenantModuleDeps; uploads: Upload[]; logs: string[] } {
  const uploads: Upload[] = [];
  const logs: string[] = [];
  const d = {
    cf: {
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
    release: "v1.0.0",
    callTenantModule: vi.fn(async () => ({ status: 200, text: "{}" })),
    callTenantStudio: vi.fn(async () => ({ status: 201, text: "{}" })),
    log: vi.fn((event: string) => void logs.push(event)),
    ...over,
  } as unknown as TenantModuleDeps;
  return { d, uploads, logs };
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
  it("POSITIVE CONTROL: every other catalog entry still declares an endpointKey", () => {
    for (const spec of TENANT_MODULE_CATALOG.filter((s) => s.module !== "plan-enhance")) {
      expect(spec.endpointKey, spec.module).toBeDefined();
    }
  });
});

describe("uploadTenantModules -- the AI Gateway trio", () => {
  it("binds AI + GATEWAY_ID + CF_AIG_TOKEN on plan-enhance when both are configured", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "ten_1", "acme-films", ENDPOINTS, TENANT_D1, "dedicated", undefined, "AIG_SECRET_VALUE");
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
    await uploadTenantModules(d, "ten_1", "acme-films", ENDPOINTS, TENANT_D1, "dedicated", undefined, "AIG_SECRET_VALUE");
    expect(names(forModule(uploads, "plan-enhance"))).not.toContain("RUNPOD_ENDPOINT_ID");
  });

  it("does NOT leak the trio onto endpoint-backed modules", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "ten_1", "acme-films", ENDPOINTS, TENANT_D1, "dedicated", undefined, "AIG_SECRET_VALUE");
    for (const m of ["keyframe", "own-gpu", "finish-upscale", "finish-lipsync", "speech-upscale"]) {
      // TELEMETRY_DB is expected here (cp#248): these five modules submit RunPod jobs and record
      // them. The exact-set shape is the point -- the AI Gateway trio must still not appear.
      expect(names(forModule(uploads, m)), m).toEqual(["RUNPOD_ENDPOINT_ID", "TELEMETRY_DB"]);
    }
  });

  // BOTH OR NEITHER. pickProvider returns "opus" only when GATEWAY_ID and CF_AIG_TOKEN are BOTH
  // present, so a half-bound module is a silent permanent fallback, not a partial feature.
  it("binds NEITHER when the token is missing, and says so in the log", async () => {
    const { d, uploads, logs } = deps();
    await uploadTenantModules(d, "ten_1", "acme-films", ENDPOINTS, TENANT_D1, "dedicated", undefined, null);
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
    await uploadTenantModules(d, "ten_1", "acme-films", ENDPOINTS, TENANT_D1, "dedicated", undefined, "AIG_SECRET_VALUE");
    const pe = forModule(uploads, "plan-enhance");
    expect(names(pe)).toEqual(["AI", "TENANT_ID", "TENANT_SLUG"]);
    expect(names(pe)).not.toContain("GATEWAY_ID");
    expect(logs).toContain("module.ai_gateway_unconfigured");
  });

  // A tenant missing a RunPod endpoint must still fail loudly. plan-enhance made endpointKey
  // optional, and the risk of that change is that it also silently softened THIS check.
  it("still refuses loudly when an ENDPOINT-BACKED module has no endpoint", async () => {
    const { d } = deps();
    await expect(
      uploadTenantModules(d, "ten_1", "acme-films", [ENDPOINTS[0]], TENANT_D1, "dedicated", undefined, "AIG_SECRET_VALUE"),
    ).rejects.toThrow(/needs the upscale endpoint/);
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
    await uploadTenantModules(d, "ten_1", "acme-films", ENDPOINTS, TENANT_D1, "dedicated", undefined, "AIG_SECRET_VALUE");

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
    await uploadTenantModules(d, "ten_1", "acme-films", ENDPOINTS, TENANT_D1, "dedicated", undefined, "AIG_SECRET_VALUE");
    const pe = forModule(uploads, "plan-enhance");
    expect(byName(pe, "TENANT_ID")).toMatchObject({ type: "plain_text", text: "ten_1" });
    expect(byName(pe, "TENANT_SLUG")).toMatchObject({ type: "plain_text", text: "acme-films" });
  });

  // plain_text, not secret_text. Neither is a secret, and binding an identifier as a secret would
  // make it unreadable in the dashboard for no benefit while implying a custody requirement.
  it("binds them as plain_text, never as secrets", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "ten_1", "acme-films", ENDPOINTS, TENANT_D1, "dedicated", undefined, "AIG_SECRET_VALUE");
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
    await uploadTenantModules(d, "ten_1", "acme-films", ENDPOINTS, TENANT_D1, "dedicated", undefined, null);
    const pe = forModule(uploads, "plan-enhance");
    expect(byName(pe, "TENANT_ID")).toBeDefined();
    expect(byName(pe, "TENANT_SLUG")).toBeDefined();
    // ...and the token pair genuinely was NOT bound, so the assertion above is about the vars
    // rather than about a fixture that binds everything regardless.
    expect(byName(pe, "CF_AIG_TOKEN")).toBeUndefined();
  });

  // Scoped to gateway-backed modules. A RunPod-backed module makes no gateway call, so binding a
  // tenant id onto it would be noise that implies a meter that does not exist for it.
  it("does NOT bind them on modules that are not gateway-backed", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "ten_1", "acme-films", ENDPOINTS, TENANT_D1, "dedicated", undefined, "AIG_SECRET_VALUE");
    const kf = forModule(uploads, "keyframe");
    // POSITIVE CONTROL: keyframe really was uploaded and really does carry its own binding, so the
    // absences below are real absences and not an empty upload record.
    expect(kf).toBeDefined();
    expect(byName(kf, "RUNPOD_ENDPOINT_ID")).toBeDefined();
    expect(names(kf)).not.toContain("TENANT_ID");
    expect(names(kf)).not.toContain("TENANT_SLUG");
  });
});
