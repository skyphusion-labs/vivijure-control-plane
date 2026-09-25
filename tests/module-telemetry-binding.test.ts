import { TEST_VPC_DOORS } from "./door-fixture";
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
  type ProbeTiming,
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
  { key: "wan-train", label: "Cast LoRA training (Wan)", id: "ep4", name: "n4", endpointVar: "RUNPOD_WAN_TRAIN_ENDPOINT_ID" },
  { key: "audio-upscale", label: "Audio", id: "ep4", name: "n4", endpointVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
];

type Upload = { scriptName: string; bindings: WorkerBinding[] };

function deps(over: Partial<TenantModuleDeps> = {}): {
  d: TenantModuleDeps;
  uploads: Upload[];
  namespaceCreates: number;
} {
  const uploads: Upload[] = [];
  // cp#464: anything landing here means the module upload used the GENERAL credential. It must stay
  // empty; that is the assertion the credential split exists for.
  const wrongCredential: Upload[] = [];
  const counters = { namespaceCreates: 0 };
  const d = {
    cf: {
      createDispatchNamespace: vi.fn(async () => void (counters.namespaceCreates += 1)),
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
        "alibaba-wan", "alibaba-wan-lora", "finish-rife", "finish-upscale",
        "google-veo", "keyframe", "kling", "minimax-hailuo", "narration-gen", "own-gpu",
        "seedance", "speech-upscale", "vidu-q3",
      ],
    );
    expect(NOT_RECORDING.sort()).toEqual(
      ["cf-flux-3-video", "cf-grok-video", "cf-hh1-r2v", "cf-seedance", "plan-enhance"].sort(),
    );
  });

  it("hosted catalog does not include finish-lipsync", () => {
    // MuseTalk is self-host only. A row here would upload and bind it on every hosted tenant.
    expect(TENANT_MODULE_CATALOG.map((s) => s.module)).not.toContain("finish-lipsync");
    expect(TENANT_MODULE_CATALOG.some((s) => s.endpointKey === "lipsync")).toBe(false);
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

/** Zero-wait clock for the double sample so unit tests never burn the production gap. */
const instantTiming: ProbeTiming = { now: () => 0, sleep: async () => {} };

describe("probeTenantModuleReadiness", () => {
  // THE THREE WIRE SHAPES, PINNED (cp#378). A suite that exercised only the current string would
  // let the twelve-day regression back in from the other direction: the parser was `boolean`-only
  // for twelve days while modules emitted strings, and a string-only suite would be exactly as
  // blind to a tenant still pinned to the boolean release. All three are measured at the artifact
  // in vivijure-cf: 15 modules emit the string at v1.23.0, 5 emitted the boolean at v1.13.0, and
  // 12 of 27 modules emit no telemetry key at all.

  it("reports \"ok\" when the worker resolved the binding (current contract)", async () => {
    const { d } = readyDeps((m) => ({ status: 200, text: readyBody(m, { telemetry: { job_log: "ok" } }) }));
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    for (const o of obs.filter((x) => x.records_runpod_jobs)) expect(o.job_log, o.module).toBe("ok");
  });

  it("reports \"unavailable\" when the worker answered that it cannot record", async () => {
    // THE CASE THAT MATTERS: ok is still true, credentials are still true, the module still renders.
    // Only this field distinguishes a tenant whose jobs are being recorded from one whose are not.
    const { d } = readyDeps((m) => ({
      status: 200,
      text: readyBody(m, { telemetry: { job_log: "unavailable" } }),
    }));
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    const keyframe = obs.find((o) => o.module === "keyframe")!;
    expect(keyframe.ok).toBe(true);
    expect(keyframe.credentials).toEqual({ runpod_api_key: true, runpod_endpoint_id: true });
    expect(keyframe.job_log).toBe("unavailable");
  });

  it("reports \"unknown\" as ITSELF, never as null", async () => {
    // "unknown" is the worker saying it PROBED and could not answer. Mapping it to null would say
    // "this image is too old to report", which sends an operator to bump modules_release for a
    // module that answered. Different fact, different remedy, so it must survive the parse.
    const { d } = readyDeps((m) => ({ status: 200, text: readyBody(m, { telemetry: { job_log: "unknown" } }) }));
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    for (const o of obs.filter((x) => x.records_runpod_jobs)) expect(o.job_log, o.module).toBe("unknown");
  });

  it("LEGACY: accepts boolean true from a pre-815c9ff0 image and reads it as \"ok\"", async () => {
    // NOT hypothetical. vivijure-cf v1.13.0 was a published studio release whose five recording
    // modules emitted `Boolean(env.TELEMETRY_DB)`. A tenant pinned there records perfectly well,
    // and dropping it to null would report a WORKING binding as unprovable -- the same false alarm
    // as the bug this fixes, pointed the other way.
    const { d } = readyDeps((m) => ({ status: 200, text: readyBody(m, { telemetry: { job_log: true } }) }));
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    for (const o of obs.filter((x) => x.records_runpod_jobs)) expect(o.job_log, o.module).toBe("ok");
  });

  it("LEGACY: accepts boolean false and reads it as \"unavailable\"", async () => {
    const { d } = readyDeps((m) => ({ status: 200, text: readyBody(m, { telemetry: { job_log: false } }) }));
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    const keyframe = obs.find((o) => o.module === "keyframe")!;
    expect(keyframe.job_log).toBe("unavailable");
    // and it must still count as unproven on the route summary, exactly like the string form.
    expect(keyframe.job_log === "ok").toBe(false);
  });

  it("an UNRECOGNISED value reads null AND names itself in detail", async () => {
    // A cf-side rename. It parses to null like an absent field does, because this plane genuinely
    // has no usable answer -- but absent and unrecognised have different remedies, so the raw value
    // is carried in `detail` and the two are never indistinguishable.
    const { d } = readyDeps((m) => ({
      status: 200,
      text: readyBody(m, { telemetry: { job_log: "recordable" } }),
    }));
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    for (const o of obs.filter((x) => x.records_runpod_jobs)) {
      expect(o.job_log, o.module).toBeNull();
      expect(o.detail, o.module).toContain("recordable");
    }
  });

  it("reports NULL, not false, when the worker never mentioned the field", async () => {
    // A module image predating the upstream change reports no telemetry at all. Reading that as
    // false would say the binding is missing when what is missing is the report, and would send
    // somebody to re-provision a tenant whose real problem is a stale release pin.
    const { d } = readyDeps((m) => ({ status: 200, text: readyBody(m) }));
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    for (const o of obs) expect(o.job_log, o.module).toBeNull();
    // ABSENT IS NOT UNRECOGNISED. A module that never mentioned the field gets no detail string;
    // that is the only thing separating "the pin is old" from "the contract moved" at a glance.
    for (const o of obs) expect(o.detail, o.module).toBeUndefined();
  });

  it("reports NULL and the raw response when nothing answered", async () => {
    const { d } = readyDeps(() => ({ status: 404, text: "TENANT_MODULE_DISPATCH not bound" }));
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
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
    const { d } = readyDeps(() => ({ status: 200, text: readyBody("some-other-module", { telemetry: { job_log: "ok" } }) }));
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    for (const o of obs) {
      expect(o.job_log, o.module).toBeNull();
      expect(o.credentials, o.module).toBeNull();
    }
  });

  it("marks plan-enhance as a module that is NOT expected to record", async () => {
    const { d } = readyDeps((m) => ({ status: 200, text: readyBody(m, { telemetry: { job_log: "ok" } }) }));
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    expect(obs.find((o) => o.module === "plan-enhance")!.records_runpod_jobs).toBe(false);
    for (const m of RECORDING) expect(obs.find((o) => o.module === m)!.records_runpod_jobs, m).toBe(true);
  });

  // cp#254: two samples with a gap, BOTH REPORTED. This test used to assert that the second sample
  // wins and the first is discarded, which is the option the cp#254 thread ruled against: two reads
  // 250ms apart both land inside the measured 40-to-50-second convergence window, so the later one
  // is not the better one, it is just the one that looks corroborated. The reported value is still
  // the newest read; what changed is that the route now says how many reads it took and whether
  // they agreed. The sequence-level assertions live in tests/module-readiness-settling.test.ts.
  it("probes every catalog module TWICE and reports BOTH reads with the newest value", async () => {
    const seen: string[] = [];
    let afterGap = false;
    const slept: number[] = [];
    const timing: ProbeTiming = {
      now: () => 0,
      sleep: async (ms) => {
        slept.push(ms);
        afterGap = true;
      },
    };
    const { d } = deps({
      callTenantModule: vi.fn(async (scriptName: string, path: string) => {
        seen.push(scriptName + " " + path);
        const spec = TENANT_MODULE_CATALOG.find((s) => scriptName === tenantModuleScriptName(TENANT, s.module));
        // First pass: job_log "unavailable" (stale). After the gap: "ok" (converged). Report "ok".
        const jobLog = afterGap;
        if (spec) {
          return {
            status: 200,
            text: readyBody(spec.module, { telemetry: { job_log: jobLog } }),
          };
        }
        return { status: 404, text: "no such script" };
      }),
    } as Partial<TenantModuleDeps>);
    const obs = await probeTenantModuleReadiness(d, TENANT, timing, 250);
    expect(slept).toEqual([250]);
    const once = TENANT_MODULE_CATALOG.map((s) => tenantModuleScriptName(TENANT, s.module) + " /ready");
    expect(seen.sort()).toEqual([...once, ...once].sort());
    for (const o of obs.filter((x) => x.records_runpod_jobs)) {
      // The newest read, reported as the value.
      expect(o.job_log, o.module).toBe("ok");
      // AND the read it replaced, which is what stops that "ok" from reading as settled. Before
      // cp#254 reopened this, the first sample was thrown away here and the assertion above was the
      // whole test -- a module mid-convergence and a module that answered twice were identical.
      expect(o.readings, o.module).toEqual(["unavailable", "ok"]);
      expect(o.settled, o.module).toBe(false);
    }
  });
});
