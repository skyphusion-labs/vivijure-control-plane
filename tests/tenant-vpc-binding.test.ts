// cf#118: the tenant studio carries the video-finish binding, or the provision REFUSES.
//
// Three properties, and the third is the one that matters most:
//   1. configured  -> the binding is in the upload metadata, with the configured service id;
//   2. unconfigured -> NO binding, and provisioning is otherwise identical (the honest degrade a
//      tenant gets today, and what self-host gets without the container);
//   3. configured but the credential cannot attach it -> the provision FAILS with a named error.
//      Never a catch-and-continue. Dropping the binding would hand the operator a tenant that looks
//      fully provisioned while silently lacking a tier the plane is CONFIGURED to provide, and the
//      render would then blame an unbound binding -- true, useless, and the exact silent-degrade
//      class #245/#249 forbids.
//
// The split credential is asserted too (uploads go through scriptUploadCf, everything else through
// cf), because "it probably uses the right client" is how a second credential quietly does nothing.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { kekRing } from "../src/token-crypto";
import { runProvisionJob, type ProvisionDeps } from "../src/provisioner";
import { CfApiError, type CfApi, type WorkerBinding } from "../src/cf-api";
import { MemoryStore, TEST_PROVISION_FACTS } from "./memory-store";
import { VIDEO_FINISH_TIER_STATE_VAR, VIDEO_FINISH_UNPROVISIONABLE } from "../src/video-finish-tier-state";
import type { Tenant } from "../src/store";

const SERVICE_ID = "019ecbe6-9fc1-70a0-9946-14bbec0f51bc";
/** The full set a provision needs; a short one fails later at modules_upload for unrelated reasons. */
const ENDPOINTS = [
  { key: "backend", label: "Render", id: "ep1", name: "n1", endpointVar: "RUNPOD_ENDPOINT_ID" },
  { key: "upscale", label: "Upscale", id: "ep2", name: "n2", endpointVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { key: "lipsync", label: "Lip sync", id: "ep3", name: "n3", endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID" },
  { key: "audio-upscale", label: "Audio upscale", id: "ep4", name: "n4", endpointVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
];

let store: MemoryStore;
let uploaded: { via: "cf" | "scriptUpload"; bindings: WorkerBinding[] }[];

function fakeCf(via: "cf" | "scriptUpload", over: Partial<CfApi> = {}): CfApi {
  return {
    createD1: vi.fn(async () => ({ uuid: "db-1" })),
    applyD1Migrations: vi.fn(async () => undefined),
    createR2Bucket: vi.fn(async () => undefined),
    createDispatchNamespace: vi.fn(async () => undefined),
    listNamespaceScripts: vi.fn(async () => []),
    createAssetsUploadSession: vi.fn(async () => ({ jwt: "jwt-1", buckets: [] })),
    uploadAssetBucket: vi.fn(async () => ({ jwt: "jwt-2" })),
    uploadUserWorker: vi.fn(async (args: { bindings: WorkerBinding[] }) => {
      uploaded.push({ via, bindings: args.bindings });
    }),
    queryD1: vi.fn(async () => ({ results: [] })),
    ...over,
  } as unknown as CfApi;
}

function deps(over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  const cf = fakeCf("cf");
  return {
    store,
    cf,
    scriptUploadCf: fakeCf("scriptUpload"),
    videoFinishServiceId: null,
    runpod: { createEndpoints: vi.fn(async () => ENDPOINTS), convergeTemplateImages: vi.fn(async () => []) },
    tokenMinter: {
      mintBucketToken: vi.fn(async () => ({ id: "tok-1", value: "SECRET" })),
      revoke: vi.fn(async () => undefined),
      revokeByName: vi.fn(async () => false),
    },
    bundle: {
      fetch: vi.fn(async () => ({
        mainModule: "i.js",
        moduleText: "export default {}",
        compatibilityDate: "2026-06-01",
        migrations: [],
        requiredVars: [],
      })),
    },
    moduleBundle: {
      fetch: vi.fn(async () => ({ mainModule: "i.js", moduleText: "export default {}", compatibilityDate: "2026-06-01" })),
    },
    r2Endpoint: "https://acct.r2.cloudflarestorage.com",
    namespace: "vivijure-tenants",
    moduleNamespace: "vivijure-tenant-modules",
    release: "v1.0.0",
    tenantScriptName: (slug: string) => `tenant-${slug}-studio`,
    kek: kekRing(btoa("0123456789abcdef0123456789abcdef")),
    spendDailyCeiling: null,
    // cp#183: the fixture plane configures a per-tenant storage ceiling, because a plane that caps
    // nothing is the state that lane exists to end. Tests covering unset or malformed override it.
    storageQuota: { bytes: "107374182400", invalid: null },
    now: () => 1_000_000,
    sleep: async () => {},
    fetch: (async () => {
      throw new Error("unit test made a real fetch");
    }) as unknown as typeof fetch,
    callTenantStudio: vi.fn(async (_s: string, init: { path: string }) => {
      if (init.path === "/api/modules/installed") {
        return { status: 200, text: JSON.stringify({ modules: [{ name: "keyframe" }] }) };
      }
      // 201, which is what the studio's install route actually answers; a 200 here fails the
      // provision at modules_install for a reason that has nothing to do with this file.
      if (init.path === "/api/modules/install") return { status: 201, text: "{}" };
      return { status: 200, text: "{}" };
    }),
    callTenantModule: vi.fn(async () => ({ status: 200, text: "{}" })),
    log: () => undefined,
    ...over,
  } as unknown as ProvisionDeps;
}

async function provision(d: ProvisionDeps): Promise<{ ok: boolean; step?: string; message?: string }> {
  const t: Tenant = await store.createTenant("ten_1", "hero", "acct_1", "pending");
  const job = await store.createProvisionJob("job_1", t.id, "provision", TEST_PROVISION_FACTS);
  return (await runProvisionJob(d, job.id, t, "rpa_keyA")) as { ok: boolean; step?: string; message?: string };
}

/** The studio script upload, identified by its ASSETS binding (module uploads carry none). */
const studioUpload = () => uploaded.find((u) => u.bindings.some((b) => b.type === "assets"));

beforeEach(async () => {
  store = new MemoryStore();
  uploaded = [];
  await store.createAccount("acct_1", "a@b.com");
});

describe("the video-finish binding on a tenant studio (cf#118)", () => {
  it("attaches it, with the CONFIGURED service id, when the plane offers the tier", async () => {
    await provision(deps({ videoFinishServiceId: SERVICE_ID }));
    const vpc = studioUpload()!.bindings.find((b) => b.type === "vpc_service");
    expect(vpc, `no vpc_service binding in ${JSON.stringify(studioUpload()?.bindings.map((b) => b.type))}`).toBeDefined();
    expect(vpc).toEqual({ type: "vpc_service", name: "VIDEO_FINISH_VPC", service_id: SERVICE_ID });
  });

  it("attaches NOTHING when the plane does not offer it, and that absence stops nothing", async () => {
    const res = await provision(deps({ videoFinishServiceId: null }));
    expect(studioUpload(), "the studio was uploaded").toBeDefined();
    expect(studioUpload()!.bindings.some((b) => b.type === "vpc_service")).toBe(false);
    // Asserted as "did not fail AT THE STEP THAT OWNS THE BINDING" rather than "provisioned to
    // live". A full-success assertion here would quietly turn this file into a provisioning test
    // that happens to mention the binding, and every unrelated gap in these fakes would land on
    // it -- which is exactly what happened while writing it (modules_upload, then modules_install,
    // then verify, none of them about cf#118). The full path is covered by provisioner.test.ts and
    // the live e2e; this file owns one binding.
    expect(res.step).not.toBe("wfp_upload");
  });

  it("treats a whitespace-only service id as ABSENT, not as an id CF cannot resolve", async () => {
    // Reached through the same normalization production uses (deps.ts trims and empty-means-null),
    // so a config typo degrades honestly instead of attaching a binding that cannot bind.
    await provision(deps({ videoFinishServiceId: "   ".trim() || null }));
    expect(studioUpload()!.bindings.some((b) => b.type === "vpc_service")).toBe(false);
  });

  it("uploads the studio through scriptUploadCf, NOT the provisioner client", async () => {
    // The whole point of the second credential. If the upload went through `cf`, the split would be
    // configuration theatre: present, documented, and doing nothing.
    await provision(deps({ videoFinishServiceId: SERVICE_ID }));
    expect(studioUpload()!.via).toBe("scriptUpload");
  });

  it("REFUSES the provision, with a NAMED error, when the credential cannot attach the binding", async () => {
    // The live 10196 shape, from the real probe: same upload, credential not authorized for VPC.
    const refusing = fakeCf("scriptUpload", {
      uploadUserWorker: vi.fn(async () => {
        throw new CfApiError("wfp.upload", 403, [
          { code: 10196, message: "Workers VPC binding configuration failed because your credentials are not authorized" },
        ]);
      }) as unknown as CfApi["uploadUserWorker"],
    });
    const res = await provision(deps({ videoFinishServiceId: SERVICE_ID, scriptUploadCf: refusing }));

    expect(res.ok).toBe(false);
    expect(res.step).toBe("wfp_upload");
    // The message must point at the PLANE's credential. CF's own words are accurate and blame the
    // wrong owner; an operator reading a failed provision needs to know it is not about the tenant.
    expect(res.message).toMatch(/SCRIPT UPLOAD credential/);
    expect(res.message).toMatch(/CF_WORKER_UPLOAD_TOKEN/);
    expect(res.message).toMatch(/VIDEO_FINISH_VPC_SERVICE_ID/);
    // NOT provisioned-anyway: the tenant must not be left looking complete without the tier.
    expect((await store.getTenantById("ten_1"))!.status).not.toBe("live");
  });

  it("does NOT swallow an unrelated upload failure into the video-finish message", async () => {
    // A refusal message that explains the wrong thing is worse than a generic one: it sends the
    // operator to check a credential scope that was never the problem.
    const broken = fakeCf("scriptUpload", {
      uploadUserWorker: vi.fn(async () => {
        throw new CfApiError("wfp.upload", 500, [{ code: 10021, message: "Uncaught Error: No such module" }]);
      }) as unknown as CfApi["uploadUserWorker"],
    });
    const res = await provision(deps({ videoFinishServiceId: SERVICE_ID, scriptUploadCf: broken }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/No such module/);
    expect(res.message).not.toMatch(/SCRIPT UPLOAD credential/);
  });
});

// cp#136: the finish-tier STATE var on the provision upload.
//
// The provision path is the case that looks unnecessary and is not. A tenant being provisioned now
// is reachable by definition, so the normal answer is "bind nothing". But a re-provision or a
// resumed provision of a tenant that was DECLARED unreachable re-states the whole binding set, and a
// non-secret binding omitted from an upload is DROPPED -- so without this the studio would quietly
// go back to promising "not yet provisioned" to a tenant nobody can reach.
describe("the finish-tier state var on a provision upload (cp#136)", () => {
  it("binds NOTHING for an ordinary tenant: absent IS the reachable state", async () => {
    await provision(deps({ videoFinishServiceId: SERVICE_ID }));
    const bindings = studioUpload()!.bindings;
    // CONTROL: a real payload was recorded, so the absence below is an omission and not an
    // upload that never happened.
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings.find((b) => b.name === VIDEO_FINISH_TIER_STATE_VAR)).toBeUndefined();
  });

  it("re-states it for a tenant the plane has DECLARED unreachable", async () => {
    const t = await store.createTenant("ten_1", "hero", "acct_1", "pending");
    await store.setTenantVideoFinishUnreachable(t.id, {
      reason: "the CF account holding this studio is gone",
      at: "2026-07-26T12:00:00.000Z",
    });
    const row = (await store.getTenantById(t.id))!;
    const job = await store.createProvisionJob("job_1", row.id, "provision", TEST_PROVISION_FACTS);
    await runProvisionJob(deps({ videoFinishServiceId: SERVICE_ID }), job.id, row, "rpa_keyA");

    expect(studioUpload()!.bindings.find((b) => b.name === VIDEO_FINISH_TIER_STATE_VAR)).toEqual({
      type: "plain_text",
      name: VIDEO_FINISH_TIER_STATE_VAR,
      text: VIDEO_FINISH_UNPROVISIONABLE,
    });
  });
});
