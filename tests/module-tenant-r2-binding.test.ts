// The TENANT R2 bucket binding, and the catalog facts it rests on (cp#284 / cf#394 wave 1).
//
// WHY THIS FILE EXISTS. A catalog row for a cost-door module without an R2_RENDERS binding does not
// fail. Each of those modules declares `bucket_name = "vivijure"` -- the OPERATOR bucket -- in its
// self-host wrangler.toml, so an unbound upload is not a module that cannot write, it is a module
// that writes a paying tenant's renders into ours and reports success. The rows and the binding are
// therefore one change, and this file is the half that proves the binding.
//
// EVERY BUCKET VALUE HERE IS NON-DEFAULT AND DISTINCT FROM "vivijure". On the operator's own name a
// correct binding and a binding that silently fell back are byte-identical.
import { describe, it, expect, vi } from "vitest";
import {
  uploadTenantModules,
  TENANT_MODULE_CATALOG,
  reachesRunpod,
  type TenantModuleDeps,
} from "../src/tenant-modules";
import { PUBLIC_ENDPOINT_ALLOWLIST } from "../src/runpod-proxy";

const TENANT = "ten_1";
const TENANT_D1 = "d1-uuid-acme";
const TENANT_BUCKET = "vivijure-tenant-acme-films";
const OPERATOR_BUCKET = "vivijure"; // what a module's self-host wrangler.toml names
const ENDPOINTS = [
  { key: "backend", label: "Render", id: "ep1", name: "n1", endpointVar: "RUNPOD_ENDPOINT_ID" },
  { key: "upscale", label: "Upscale", id: "ep2", name: "n2", endpointVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { key: "lipsync", label: "Lipsync", id: "ep3", name: "n3", endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID" },
  { key: "audio-upscale", label: "Audio", id: "ep4", name: "n4", endpointVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
];

type Upload = { scriptName: string; bindings: { type: string; name: string; bucket_name?: string }[] };

function deps(over: Partial<TenantModuleDeps> = {}) {
  const uploads: Upload[] = [];
  const d = {
    cf: {
      createDispatchNamespace: vi.fn(async () => {}),
      // ONE object argument, mirrored from the shipped call site rather than invented -- a fake with
      // the wrong arity records nothing and every binding assertion below reads "undefined".
      uploadUserWorker: vi.fn(async (a: Upload) => void uploads.push(a)),
    },
    moduleNamespace: "vivijure-tenant-modules",
    aiGatewayId: null,
    runpodProxy: { base: "https://plane.example/api/runpod/v2", signingKey: "k" },
    moduleBundle: { fetch: vi.fn(async () => ({ mainModule: "i.js", moduleText: "export default {}", compatibilityDate: "2026-06-01" })) },
    callTenantModule: vi.fn(async () => ({ status: 200, text: "{}" })),
    callTenantStudio: vi.fn(async () => ({ status: 200, text: "{}" })),
    vpcDoors: {
      upscale: { serviceId: "svc-finish-upscale", token: "door-token-test" },
      "audio-upscale": { serviceId: "svc-speech-upscale", token: "door-token-test" },
    },
    log: () => undefined,
    ...over,
  } as unknown as TenantModuleDeps;
  return { d, uploads };
}

const forModule = (uploads: Upload[], m: string) => uploads.find((u) => u.scriptName.endsWith("-" + m))!;
const named = (u: Upload, n: string) => u.bindings.find((b) => b.name === n);

const WRITERS = TENANT_MODULE_CATALOG.filter((s) => s.writesTenantRenders).map((s) => s.module);
const NON_WRITERS = TENANT_MODULE_CATALOG.filter((s) => !s.writesTenantRenders).map((s) => s.module);

describe("CONTROL: the binding finder can return both answers", () => {
  it("finds a binding that is there and misses one that is not", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared");
    const u = forModule(uploads, "kling");
    expect(named(u, "R2_RENDERS")).toBeDefined();
    expect(named(u, "DEFINITELY_NOT_A_BINDING")).toBeUndefined();
  });
});

describe("R2_RENDERS points at the TENANT bucket", () => {
  it("binds every writer to the tenant bucket, and NEVER to the operator bucket", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared");
    expect(WRITERS.length).toBeGreaterThan(0); // denominator: an empty catalog cannot pass this
    for (const m of WRITERS) {
      const b = named(forModule(uploads, m), "R2_RENDERS");
      expect(b, m).toBeDefined();
      expect(b!.type, m).toBe("r2_bucket");
      // The claim is WHICH bucket. Asserting only that a binding exists would pass on the operator
      // bucket, which is the entire failure this change exists to prevent.
      expect(b!.bucket_name, m).toBe(TENANT_BUCKET);
      expect(b!.bucket_name, m).not.toBe(OPERATOR_BUCKET);
    }
  });

  it("binds it on NO other module, so the grant is not widened past the writers", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared");
    expect(NON_WRITERS.length).toBeGreaterThan(0);
    for (const m of NON_WRITERS) {
      expect(named(forModule(uploads, m), "R2_RENDERS"), m).toBeUndefined();
    }
  });

  it("REFUSES, writing nothing, when a writer's tenant has no bucket recorded", async () => {
    // The failure direction that matters: uploading here would send tenant renders to the operator
    // bucket and report success. A refusal is the only safe answer, and it must write NOTHING.
    const { d, uploads } = deps();
    await expect(
      uploadTenantModules(d, "v1.0.0", TENANT, "acme", ENDPOINTS, TENANT_D1, null, "shared"),
    ).rejects.toThrow(/no R2 bucket recorded/);
    expect(uploads.filter((u) => WRITERS.some((m) => u.scriptName.endsWith("-" + m)))).toHaveLength(0);
  });
});

describe("the cost door reaches RunPod, so it takes the proxy pair (cp#288)", () => {
  it("binds the pair on a PUBLIC-slug module that has no endpoint id of ours", async () => {
    // THE SECURITY ASSERTION OF THIS CHANGE. These modules were nearly left out of the proxy because
    // the binding condition keyed on endpointKey, which they do not have. Unproxied on a shared
    // tenant they would reach RunPod on the direct RUNPOD_API_KEY -- a consumer holding a RunPod
    // credential on our account, which CLAUDE.md forbids outright.
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "shared");
    const u = forModule(uploads, "kling");
    expect(named(u, "RUNPOD_ENDPOINT_ID")).toBeUndefined(); // no endpoint of ours, by design
    expect(named(u, "RUNPOD_PROXY_BASE")).toBeDefined();
    expect(named(u, "RUNPOD_PROXY_TOKEN")).toBeDefined();
  });
});

describe("the catalog's public slugs match what the proxy will admit", () => {
  it("every publicEndpoint is in PUBLIC_ENDPOINT_ALLOWLIST", () => {
    // Two hand-maintained lists in two files that must agree. Asserting the relationship is what
    // stops them drifting; without it a renamed slug is a module that provisions green and is
    // refused by our own proxy on its first render.
    const slugs = TENANT_MODULE_CATALOG.map((s) => s.publicEndpoint).filter(Boolean) as string[];
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) expect(PUBLIC_ENDPOINT_ALLOWLIST, slug).toContain(slug);
  });

  it("a public slug is exactly what makes those modules RunPod-reaching without an endpointKey", () => {
    for (const spec of TENANT_MODULE_CATALOG.filter((s) => s.publicEndpoint)) {
      expect(spec.endpointKey, spec.module).toBeUndefined();
      expect(reachesRunpod(spec), spec.module).toBe(true);
    }
  });
});
