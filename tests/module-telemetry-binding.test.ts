// cp#248: the D1 binding that lets a HOSTED tenant module record the RunPod jobs it submits, and the
// read that lets somebody see whether it can.
//
// WHY THIS CLASS OF TEST. Every failure here reads green at a glance. A module uploaded WITHOUT
// TELEMETRY_DB uploads fine, installs fine, renders fine, and answers ok:true on /ready, because the
// job log is deliberately not part of ok -- telemetry must never gate a render. It simply records
// nothing, and RunPod cannot enumerate jobs, so what it failed to write at submit is unreachable the
// moment the job ends. There is no backfill. So the assertions below are about the SILENT shapes:
// a binding under the wrong name, a binding on the wrong modules, a refusal that half-ran, and an
// absent report being read as a negative report.

import { describe, it, expect, vi } from "vitest";
import {
  uploadTenantModules,
  probeTenantModuleReadiness,
  TENANT_MODULE_CATALOG,
  TenantModuleError,
  tenantModuleScriptName,
  type TenantModuleDeps,
} from "../src/tenant-modules";
import type { WorkerBinding } from "../src/cf-api";

const TENANT = "ten_1";
const TENANT_D1 = "d1-uuid-acme";
// cp#284: the TENANT bucket. A distinctive value, not "vivijure", so a binding that
// silently carried the OPERATOR bucket would be visible rather than plausible.
const TENANT_BUCKET = "vivijure-tenant-acme-films";
const ENDPOINTS = [
  { key: "backend", label: "Backend", id: "ep1", name: "n1", endpointVar: "RUNPOD_ENDPOINT_ID" },
  { key: "upscale", label: "Upscale", id: "ep2", name: "n2", endpointVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { key: "lipsync", label: "Lip sync", id: "ep3", name: "n3", endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID" },
  { key: "audio-upscale", label: "Audio", id: "ep4", name: "n4", endpointVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
];

type Upload = { scriptName: string; bindings: WorkerBinding[] };

function deps(over: Partial<TenantModuleDeps> = {}): {
  d: TenantModuleDeps;
  uploads: Upload[];
  namespaceCreates: number;
} {
  const uploads: Upload[] = [];
  const counters = { namespaceCreates: 0 };
  const d = {
    cf: {
      createDispatchNamespace: vi.fn(async () => void (counters.namespaceCreates += 1)),
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
    log: vi.fn(),
    ...over,
  } as unknown as TenantModuleDeps;
  return { d, uploads, get namespaceCreates() { return counters.namespaceCreates; } };
}

const forModule = (uploads: Upload[], name: string): Upload => uploads.find((u) => u.scriptName.endsWith(name))!;
const telemetry = (u: Upload) => u.bindings.find((b) => b.name === "TELEMETRY_DB");

/** The modules that record, straight off the catalog rather than re-listed here: a list copied into
 *  a test proves the copy, not the catalog. */
const RECORDING = TENANT_MODULE_CATALOG.filter((s) => s.recordsRunpodJobs).map((s) => s.module);
const NOT_RECORDING = TENANT_MODULE_CATALOG.filter((s) => !s.recordsRunpodJobs).map((s) => s.module);

describe("the catalog says WHICH modules record", () => {
  it("six modules record, and plan-enhance does not", () => {
    // A LIST, deliberately, and still hand-maintained: if a seventh becomes recording, this fails
    // and somebody re-reads the upstream module set instead of assuming the catalog kept up. It is
    // not derived from the catalog on purpose -- a derived expectation agrees with whatever the
    // catalog happens to say, which is this assertion inverted.
    //
    // cp#284 moved this from five to six: finish-rife was the sixth upstream recorder and was
    // published as a tenant bundle by every release this plane pins while being uploaded by
    // nothing. This test is what fired when the row landed.
    // cp#284 moved this from six to FOURTEEN: the eight cost-door modules each import
    // runpod-job-log and read TELEMETRY_DB exactly as keyframe does. Established BY EFFECT
    // against two controls (keyframe records, plan-enhance does not), never from the row.
    expect(RECORDING.sort()).toEqual(
      [
        "alibaba-wan", "alibaba-wan-lora", "finish-lipsync", "finish-rife", "finish-upscale",
        "google-veo", "keyframe", "kling", "minimax-hailuo", "narration-gen", "own-gpu",
        "seedance", "speech-upscale", "vidu-q3",
      ],
    );
    expect(NOT_RECORDING).toEqual(["plan-enhance"]);
  });

  it("finish-rife is catalogued AND recording, so the upstream set is fully covered (cp#284)", () => {
    // The inverse of what this assertion said until cp#284, and kept rather than deleted because
    // the hazard it was written for is still live: the day somebody adds a module they must set
    // recordsRunpodJobs too, or it uploads fine, renders fine, and records nothing.
    //
    // Two halves, and the second is the one that would have been missed: PRESENT in the catalog,
    // and present WITH the recording flag. A row added without the flag satisfies the first and
    // silently drops every job row for that module.
    const rife = TENANT_MODULE_CATALOG.find((s) => s.module === "finish-rife");
    expect(rife, "finish-rife must be catalogued").toBeDefined();
    expect(rife!.recordsRunpodJobs, "finish-rife records RunPod jobs upstream").toBe(true);
    expect(rife!.endpointKey, "it rides the shared backend endpoint, per its own wrangler.toml").toBe("backend");
  });
});

describe("uploadTenantModules attaches TELEMETRY_DB", () => {
  it("binds the TENANT studio D1, by uuid, on every recording module", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "dedicated", undefined, "AIG");
    for (const m of RECORDING) {
      // The NAME is what the module helper reads (env.TELEMETRY_DB). A binding under any other name
      // is an absent binding: the write warns, no-ops, and the module still reports healthy.
      expect(telemetry(forModule(uploads, m)), m).toEqual({ type: "d1", name: "TELEMETRY_DB", id: TENANT_D1 });
    }
  });

  it("does NOT bind it on a module that submits no RunPod job", async () => {
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, TENANT_D1, TENANT_BUCKET, "dedicated", undefined, "AIG");
    for (const m of NOT_RECORDING) expect(telemetry(forModule(uploads, m)), m).toBeUndefined();
  });

  it("binds the SAME database the studio gets, never a second one", async () => {
    // The table is created by the studio release migration 0014 in the tenant studio database. A
    // different uuid here would be a table nothing migrates, and every write would fail at runtime
    // while every upload still looked correct.
    const { d, uploads } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, "d1-studio-uuid", TENANT_BUCKET, "dedicated", undefined, "AIG");
    const ids = new Set(RECORDING.map((m) => (telemetry(forModule(uploads, m)) as { id: string }).id));
    expect([...ids]).toEqual(["d1-studio-uuid"]);
  });

  it("REFUSES on a missing tenant D1, and has changed nothing when it does", async () => {
    // The negative half. Without this, a tenant record with no database silently gets five modules
    // that record nothing, which is precisely the state cp#248 exists to make impossible.
    const { d, uploads, namespaceCreates } = deps();
    await expect(uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, null, TENANT_BUCKET, "dedicated", undefined, "AIG")).rejects.toThrow(
      TenantModuleError,
    );
    expect(uploads).toEqual([]);
    expect(namespaceCreates).toBe(0);
  });

  it("names the step so the job row attributes the refusal correctly", async () => {
    const { d } = deps();
    await uploadTenantModules(d, "v1.0.0", TENANT, "acme-films", ENDPOINTS, "", TENANT_BUCKET, "dedicated", undefined, "AIG").then(
      () => expect.fail("an empty D1 id must refuse, not upload"),
      (e: TenantModuleError) => {
        expect(e.step).toBe("modules_upload");
        expect(e.message).toContain("TELEMETRY_DB");
      },
    );
  });
});

// ---- the READ: what a running worker says about itself ----------------------------------------

const readyBody = (module: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ok: true,
    module,
    credentials: { runpod_api_key: true, runpod_endpoint_id: true },
    ...over,
  });

/** Answer /ready per module, keyed by the module name embedded in the tenant-prefixed script. */
function readyDeps(answer: (module: string) => { status: number; text: string }) {
  return deps({
    callTenantModule: vi.fn(async (scriptName: string) => {
      const spec = TENANT_MODULE_CATALOG.find((s) => scriptName === tenantModuleScriptName(TENANT, s.module));
      return spec ? answer(spec.module) : { status: 404, text: "no such script" };
    }),
  } as Partial<TenantModuleDeps>);
}

describe("probeTenantModuleReadiness", () => {
  it("reports job_log TRUE when the worker resolved the binding", async () => {
    const { d } = readyDeps((m) => ({ status: 200, text: readyBody(m, { telemetry: { job_log: true } }) }));
    const obs = await probeTenantModuleReadiness(d, TENANT);
    for (const o of obs.filter((x) => x.records_runpod_jobs)) expect(o.job_log, o.module).toBe(true);
  });

  it("reports job_log FALSE when the worker answered that it cannot record", async () => {
    // THE CASE THAT MATTERS: ok is still true, credentials are still true, the module still renders.
    // Only this field distinguishes a tenant whose jobs are being recorded from one whose are not.
    const { d } = readyDeps((m) => ({ status: 200, text: readyBody(m, { telemetry: { job_log: false } }) }));
    const obs = await probeTenantModuleReadiness(d, TENANT);
    const keyframe = obs.find((o) => o.module === "keyframe")!;
    expect(keyframe.ok).toBe(true);
    expect(keyframe.credentials).toEqual({ runpod_api_key: true, runpod_endpoint_id: true });
    expect(keyframe.job_log).toBe(false);
  });

  it("reports NULL, not false, when the worker never mentioned the field", async () => {
    // A module image predating the upstream change reports no telemetry at all. Reading that as
    // false would say the binding is missing when what is missing is the report, and would send
    // somebody to re-provision a tenant whose real problem is a stale release pin.
    const { d } = readyDeps((m) => ({ status: 200, text: readyBody(m) }));
    const obs = await probeTenantModuleReadiness(d, TENANT);
    for (const o of obs) expect(o.job_log, o.module).toBeNull();
  });

  it("reports NULL and the raw response when nothing answered", async () => {
    const { d } = readyDeps(() => ({ status: 404, text: "TENANT_MODULE_DISPATCH not bound" }));
    const obs = await probeTenantModuleReadiness(d, TENANT);
    for (const o of obs) {
      expect(o.status, o.module).toBe(404);
      expect(o.job_log, o.module).toBeNull();
      expect(o.ok, o.module).toBeNull();
      expect(o.detail, o.module).toContain("TENANT_MODULE_DISPATCH");
    }
  });

  it("refuses to read a WRONG-SCRIPT answer as this module answering", async () => {
    // Script names are tenant-prefixed and derived. A neighbouring module answering healthily must
    // never be recorded as proof about this one.
    const { d } = readyDeps(() => ({ status: 200, text: readyBody("some-other-module", { telemetry: { job_log: true } }) }));
    const obs = await probeTenantModuleReadiness(d, TENANT);
    for (const o of obs) {
      expect(o.job_log, o.module).toBeNull();
      expect(o.credentials, o.module).toBeNull();
    }
  });

  it("marks plan-enhance as a module that is NOT expected to record", async () => {
    const { d } = readyDeps((m) => ({ status: 200, text: readyBody(m, { telemetry: { job_log: true } }) }));
    const obs = await probeTenantModuleReadiness(d, TENANT);
    expect(obs.find((o) => o.module === "plan-enhance")!.records_runpod_jobs).toBe(false);
    for (const m of RECORDING) expect(obs.find((o) => o.module === m)!.records_runpod_jobs, m).toBe(true);
  });

  it("probes the tenant-prefixed script name for every catalog module, once each", async () => {
    const seen: string[] = [];
    const { d } = deps({
      callTenantModule: vi.fn(async (scriptName: string, path: string) => {
        seen.push(scriptName + " " + path);
        return { status: 200, text: "{}" };
      }),
    } as Partial<TenantModuleDeps>);
    await probeTenantModuleReadiness(d, TENANT);
    expect(seen.sort()).toEqual(
      TENANT_MODULE_CATALOG.map((s) => tenantModuleScriptName(TENANT, s.module) + " /ready").sort(),
    );
  });
});
