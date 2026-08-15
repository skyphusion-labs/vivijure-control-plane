// cp#254: what GET /api/admin/tenants/:id/module-readiness can and cannot prove about one reading.
//
// WHY THIS FILE EXISTS SEPARATELY from module-telemetry-binding.test.ts. That suite asks what a
// module SAID. This one asks whether the route is entitled to believe it. The two are different
// questions and the second one has no home in a per-value parser suite: every assertion here is
// about a SEQUENCE of reads, and a single read cannot express the defect.
//
// THE DEFECT, stated once. A /ready read taken soon after a module version REPLACES another can be
// answered by an isolate still serving the previous version. Measured in the cp#254 thread, twice,
// live: the sequences were TFTFFF (stable after 50s) and FTFFF (stable after 40s), both on a
// keyframe worker re-uploaded with the TELEMETRY_DB binding REMOVED -- a worker that could not
// record anything, whose very first read said it could.
//
// #349 (bf35182be2) responded by sampling twice 250ms apart and returning the SECOND sample. Both
// samples land inside a 40-second window, so that does not settle the answer; on FTFFF it returns
// "ok" for the no-database worker AND makes it look corroborated. This suite drives that case and
// the honest-reporting behaviour that replaced it.

import { describe, it, expect, vi } from "vitest";
import {
  probeTenantModuleReadiness,
  summariseModuleReadiness,
  MODULE_READINESS_SAMPLES,
  TENANT_MODULE_CATALOG,
  tenantModuleScriptName,
  type ModuleReadingState,
  type TenantModuleDeps,
  type ProbeTiming,
} from "../src/tenant-modules";

const TENANT = "ten_1";
const instantTiming: ProbeTiming = { now: () => 0, sleep: async () => {} };

const readyBody = (module: string, telemetry?: Record<string, unknown>) =>
  JSON.stringify({
    ok: true,
    module,
    credentials: { runpod_api_key: true, runpod_endpoint_id: true },
    ...(telemetry ? { telemetry } : {}),
  });

/**
 * The measured replace-path sequence from the cp#254 reproduction, run 2, VERBATIM.
 *
 * Kept as the measurement rather than as a tidied "flaps then settles" fixture. A sequence invented
 * to exercise the code agrees with the code by construction; this one was recorded against real
 * Cloudflare before any of this code existed, and the first two entries are the whole problem.
 */
const FTFFF = ["unavailable", "ok", "unavailable", "unavailable", "unavailable"] as const;

/** A transport that replays a per-module script of /ready answers, one entry per read. */
function scripted(sequences: Record<string, readonly string[]>, fallback = "ok") {
  const taken = new Map<string, number>();
  const d = {
    cf: {},
    moduleNamespace: "vivijure-tenant-modules",
    log: vi.fn(),
    callTenantModule: vi.fn(async (scriptName: string) => {
      const spec = TENANT_MODULE_CATALOG.find((s) => scriptName === tenantModuleScriptName(TENANT, s.module));
      if (!spec) return { status: 404, text: "no such script" };
      // COUNTED FOR EVERY MODULE, scripted or not: `taken` is the read denominator the suite
      // asserts on, and a counter that only advanced on the interesting modules would report the
      // steady ones as never probed.
      const i = taken.get(spec.module) ?? 0;
      taken.set(spec.module, i + 1);
      const seq = sequences[spec.module];
      if (!seq) return { status: 200, text: readyBody(spec.module, { job_log: fallback }) };
      const value = seq[Math.min(i, seq.length - 1)];
      if (value === "404") return { status: 404, text: "TENANT_MODULE_DISPATCH not bound" };
      if (value === "no-field") return { status: 200, text: readyBody(spec.module) };
      return { status: 200, text: readyBody(spec.module, { job_log: value }) };
    }),
  } as unknown as TenantModuleDeps;
  return { d, taken };
}

const readingsOf = (obs: { module: string; readings: ModuleReadingState[] }[], module: string) =>
  obs.find((o) => o.module === module)!.readings;

describe("cp#254 negative control: a worker with NO database bound", () => {
  // THE LOAD-BEARING TEST. Truth for this worker is fixed and known: TELEMETRY_DB is not bound, it
  // cannot record, and no sampling strategy is allowed to answer otherwise.
  it("is NEVER reported as proven to record, on the measured FTFFF sequence", async () => {
    const { d } = scripted({ keyframe: FTFFF });
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    const keyframe = obs.find((o) => o.module === "keyframe")!;

    // What the two reads actually were, in order. This is the evidence, and it is now reported
    // rather than discarded -- #349 threw the first one away, which is what made the second look
    // like a settled answer.
    expect(keyframe.readings).toEqual(["unavailable", "ok"]);
    expect(keyframe.reads).toBe(2);
    expect(keyframe.settled, "two reads that disagree are not a settled answer").toBe(false);

    // The reported value is still the newest read, and it is still "ok" -- that is deliberate and
    // it is exactly why the value alone must never be the control. ASSERTED, not glossed: if this
    // ever silently became null or "unavailable", the summary below would pass for a reason that
    // has nothing to do with settling.
    expect(keyframe.job_log, "the raw field is the last READING, not a conclusion").toBe("ok");

    // AND THE ROUTE REFUSES TO COUNT IT. This is the assertion the defect fails: on origin/main
    // f7f3dd8 the probe returns job_log "ok" for this worker and the summary counted it as proven.
    expect(summariseModuleReadiness(obs).records_unproven).toContain("keyframe");
    expect(summariseModuleReadiness(obs).unsettled).toContain("keyframe");
  });

  it("stays unproven no matter which two adjacent reads of FTFFF the probe lands on", async () => {
    // SAMPLING IS NOT ENUMERATING. The probe does not choose where in the window it lands, so the
    // control has to hold at EVERY offset, not at the one that happens to be convenient. Offsets 1
    // and 2 are the dangerous ones: reads ("ok","unavailable") and ("unavailable","unavailable")
    // -- the second pair AGREES, on a value that is correct here, and the third read onward agrees
    // on "unavailable" forever. The honest outcome is unproven at every offset, but for two
    // different reasons, and this test would catch a rule that only handled one of them.
    for (let offset = 0; offset < FTFFF.length - 1; offset += 1) {
      const { d } = scripted({ keyframe: FTFFF.slice(offset) });
      const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
      const summary = summariseModuleReadiness(obs);
      expect(summary.records_unproven, `offset ${offset}: ${readingsOf(obs, "keyframe").join(",")}`).toContain(
        "keyframe",
      );
    }
  });
});

describe("cp#254 positive control: the route still says yes when it can", () => {
  // WITHOUT THIS, the negative control above passes against a summary that refuses everything. A
  // gate that cannot say yes is not a gate.
  it("a module answering ok on every read is proven and settled", async () => {
    const { d } = scripted({});
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    const summary = summariseModuleReadiness(obs);
    expect(summary.records_unproven, "every recording module answered ok twice").toEqual([]);
    expect(summary.unsettled).toEqual([]);
    for (const o of obs.filter((x) => x.records_runpod_jobs)) {
      expect(o.settled, o.module).toBe(true);
      expect(o.readings, o.module).toEqual(["ok", "ok"]);
    }
  });

  it("a module that steadily reports unavailable is unproven but NOT unsettled", async () => {
    // The two summaries are different facts and must not move together. This module has a real,
    // stable, actionable defect: re-asking will not change it, and telling an operator to wait
    // would be the wrong remedy.
    const { d } = scripted({ keyframe: ["unavailable", "unavailable"] });
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    const summary = summariseModuleReadiness(obs);
    expect(summary.records_unproven).toContain("keyframe");
    expect(summary.unsettled).not.toContain("keyframe");
  });
});

describe("cp#254: a read that never reached the module is its own state", () => {
  it("keeps \"the probe could not reach it\" apart from \"the module reported no field\"", async () => {
    // The #255 smoke had to invent a separate glyph for this because the two have completely
    // different causes: a control plane that cannot dispatch, versus a tenant module image too old
    // to carry the field. Both read job_log null, so only the per-read state separates them.
    const { d } = scripted({ keyframe: ["404", "404"], "own-gpu": ["no-field", "no-field"] });
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    expect(readingsOf(obs, "keyframe")).toEqual(["unreachable", "unreachable"]);
    expect(readingsOf(obs, "own-gpu")).toEqual(["absent", "absent"]);
    // Same null in the flat field. That is the collapse the readings exist to undo.
    expect(obs.find((o) => o.module === "keyframe")!.job_log).toBeNull();
    expect(obs.find((o) => o.module === "own-gpu")!.job_log).toBeNull();
  });

  it("a module that becomes reachable mid-probe is unsettled, not quietly ok", async () => {
    // The third reading state the cp#255 run added: one read died on a Cloudflare 404 page because
    // the dispatch door was live at one PoP and not another. That is a probe that has not settled,
    // and a route that reported only the second read would call it a clean yes.
    const { d } = scripted({ keyframe: ["404", "ok"] });
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    expect(readingsOf(obs, "keyframe")).toEqual(["unreachable", "ok"]);
    expect(summariseModuleReadiness(obs).records_unproven).toContain("keyframe");
  });
});

describe("cp#254: settled cannot be a flag that is always true", () => {
  it("reports settled FALSE when only one sample was taken", async () => {
    // THE FLOOR, DRIVEN rather than asserted in a comment. One read agrees with itself, so a
    // one-sample probe could only ever report settled true. Dropping MODULE_READINESS_SAMPLES to 1
    // must therefore delete the signal LOUDLY -- everything unproven -- instead of turning every
    // module green.
    const { d } = scripted({});
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming, 250, 1);
    for (const o of obs) {
      expect(o.reads, o.module).toBe(1);
      expect(o.settled, o.module).toBe(false);
    }
    expect(summariseModuleReadiness(obs).records_unproven.length).toBeGreaterThan(0);
  });

  it("takes MODULE_READINESS_SAMPLES reads per module and reports every one", async () => {
    // The denominator, checked against the constant rather than against the number 2, so the two
    // cannot drift apart while both look right.
    const { d, taken } = scripted({});
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    expect(MODULE_READINESS_SAMPLES).toBeGreaterThanOrEqual(2);
    for (const spec of TENANT_MODULE_CATALOG) {
      expect(taken.get(spec.module) ?? 0, spec.module).toBe(MODULE_READINESS_SAMPLES);
    }
    for (const o of obs) {
      expect(o.reads, o.module).toBe(MODULE_READINESS_SAMPLES);
      expect(o.readings.length, o.module).toBe(MODULE_READINESS_SAMPLES);
    }
    expect(obs).toHaveLength(TENANT_MODULE_CATALOG.length);
  });

  it("sleeps between samples and not before the first", async () => {
    const slept: number[] = [];
    const timing: ProbeTiming = { now: () => 0, sleep: async (ms) => void slept.push(ms) };
    const { d } = scripted({});
    await probeTenantModuleReadiness(d, TENANT, timing, 250);
    expect(slept).toEqual(Array(MODULE_READINESS_SAMPLES - 1).fill(250));
  });
});

describe("cp#254: the readings belong to the module that produced them", () => {
  it("folds samples by module NAME, so a flap cannot be attributed to a neighbour", async () => {
    // A positional fold would line up today and go wrong silently the day the catalog order stopped
    // matching between rounds. Only keyframe flaps here; every other module must read settled.
    const { d } = scripted({ keyframe: FTFFF });
    const obs = await probeTenantModuleReadiness(d, TENANT, instantTiming);
    const unsettled = summariseModuleReadiness(obs).unsettled;
    expect(unsettled).toEqual(["keyframe"]);
  });
});
