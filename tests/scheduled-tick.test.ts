// The cron tick's ISOLATION (cp#290), driven through the SAME exported body the cron drives.
//
// WHY THIS EXISTS AS A TEST RATHER THAN A TRY/CATCH SOMEONE TRUSTS. The handler was one bare
// `await runLlmMeterTick(...)` for its whole life, which was fine with one consumer. Adding a second
// to that shape couples them: a throw in either silently skips the rest of the tick, and the
// SYMPTOM IS AN ABSENCE -- no sweep log, no period row -- which is exactly what a healthy idle plane
// looks like. It would be invisible for precisely as long as nobody looked.
//
// Note what is NOT asserted here: that either half does its job. Those have their own suites. This
// asserts only that neither can take the other down, because that is the property the composition
// adds and the one no other test can see.

import { describe, it, expect, vi } from "vitest";
import { runScheduledTick } from "../src/index";
import type { ControlPlaneDeps } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import { MemoryStore } from "./memory-store";

const env = (over: Partial<ControlPlaneEnv> = {}): ControlPlaneEnv =>
  ({ SHARED_RUNPOD_INVOKE_KEY: "pool-key", ...over }) as ControlPlaneEnv;

/** A tick where BOTH halves have real work to do, so "it ran" is observable rather than vacuous:
 *  the sweep has an eligible row to examine, which is what makes the fetch call its evidence. */
async function depsWithWork(): Promise<{ deps: ControlPlaneDeps; fetched: string[] }> {
  const store = new MemoryStore();
  await store.openRunpodProxyJob({
    job_id: "job-1",
    tenant_id: "ten_1",
    tenant_slug: "hero",
    module: "keyframe",
    endpoint_id: "pool-backend",
    submitted_at: 0,
    webhook_token_sha256: "a".repeat(64),
  });
  const fetched: string[] = [];
  return {
    fetched,
    deps: {
      store,
      mailer: { send: async () => {} },
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        fetched.push(String(input));
        return new Response(JSON.stringify({ status: "COMPLETED", executionTime: 10 }), { status: 200 });
      }) as unknown as typeof fetch,
      now: () => 1_750_000_000_000,
    } as ControlPlaneDeps,
  };
}

describe("the scheduled tick isolates its halves", () => {
  it("runs the sweep even when the METER throws", async () => {
    const { deps, fetched } = await depsWithWork();
    // The meter refuses on absent wiring today rather than throwing. Forcing a throw is the point:
    // this asserts the ISOLATION, not the meter's current politeness, because the coupling would
    // arrive on the day that politeness changes.
    vi.spyOn(deps.store, "listOpenRunpodProxyJobs");
    const boom = { ...deps, get llmSpend() { throw new Error("meter exploded"); } } as unknown as ControlPlaneDeps;
    await expect(runScheduledTick(env(), boom)).resolves.toBeUndefined();
    expect(fetched).toEqual(["https://api.runpod.ai/v2/pool-backend/status/job-1"]);
  });

  it("does not reject when the SWEEP throws, so a later half would still run", async () => {
    const { deps } = await depsWithWork();
    vi.spyOn(deps.store, "countOpenRunpodProxyJobs").mockRejectedValue(new Error("d1 down"));
    // The tick must SWALLOW and log, never propagate: a rejected scheduled handler is a failed
    // invocation with no per-half attribution in the log.
    await expect(runScheduledTick(env(), deps)).resolves.toBeUndefined();
  });

  it("POSITIVE CONTROL: with neither half throwing, the sweep really does reach upstream", async () => {
    // Without this, both assertions above pass against a tick that runs nothing at all.
    const { deps, fetched } = await depsWithWork();
    await runScheduledTick(env(), deps);
    expect(fetched).toEqual(["https://api.runpod.ai/v2/pool-backend/status/job-1"]);
  });

  it("still runs the sweep on a plane with the meter unwired, which is the shipped shape", async () => {
    const { deps, fetched } = await depsWithWork();
    // deps carries no llmSpend and no gatewayLogs, so runLlmMeterTick refuses. The sweep must not
    // inherit that refusal -- they are independent capabilities on one timer.
    await runScheduledTick(env(), deps);
    expect(fetched).toHaveLength(1);
  });
});
