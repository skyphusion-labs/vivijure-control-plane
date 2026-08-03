// The sweep (cp#290). Every test plants a row in a KNOWN state and watches the sweep act on it --
// "a sweep nobody has seen act is not known to act."
//
// THE ORGANISING RULE, asserted everywhere rather than stated once: the only ways a row is ever
// closed are (a) we read a terminal status ourselves, or (b) TWO independent conditions agree it
// can never be answered. Every other outcome leaves the row OPEN, because an open row says "nobody
// knows" out loud and a wrongly-closed row asserts something nobody observed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryStore } from "./memory-store";
import { runRunpodJobSweep, SWEEP_MAX_ROWS_PER_RUN, type JobSweepDeps } from "../src/runpod-job-sweep";
import { OBSERVED_RESULT_RETENTION_MS, RECONCILER_ADOPT_AFTER_MS } from "../src/runpod-proxy";

const NOW = 1_750_000_000_000;
const KEY = "pool-key-under-test";

let store: MemoryStore;
let upstream: string[];
let reply: (url: string) => Response;

/** Open a proxy row aged `ageMs`, exactly as a submit would have. */
async function openJob(jobId: string, ageMs: number, endpoint = "pool-backend"): Promise<void> {
  await store.openRunpodProxyJob({
    job_id: jobId,
    tenant_id: "ten_1",
    tenant_slug: "hero",
    module: "keyframe",
    endpoint_id: endpoint,
    submitted_at: NOW - ageMs,
    webhook_token_sha256: jobId.padEnd(64, "0"),
  });
}

const deps = (over: Partial<JobSweepDeps> = {}): JobSweepDeps => ({
  fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
    upstream.push(String(input));
    return reply(String(input));
  }) as unknown as typeof fetch,
  runpodApiKey: async () => KEY,
  store,
  now: () => NOW,
  ...over,
});

/** Comfortably past the adopt delay and inside the retention horizon. */
const RIPE = RECONCILER_ADOPT_AFTER_MS + 60_000;
/** Past the retention horizon, so a `gone` answer is explainable. */
const ANCIENT = OBSERVED_RESULT_RETENTION_MS + 60_000;

beforeEach(() => {
  store = new MemoryStore();
  upstream = [];
  reply = () => new Response(JSON.stringify({ status: "IN_PROGRESS" }), { status: 200 });
});

const row = (jobId: string) => store.jobIndex.get(jobId) as Record<string, unknown> | undefined;

describe("what the sweep is eligible to touch", () => {
  it("NEVER races a working push: a row younger than the adopt delay is not examined", async () => {
    await openJob("job-fresh", 30_000);
    const res = await runRunpodJobSweep(deps());
    expect(res.examined).toBe(0);
    expect(upstream).toHaveLength(0);
    // CONTROL: the same row, older, IS examined -- so the zero above is the age gate and not a
    // sweep that examines nothing at all.
    await openJob("job-ripe", RIPE);
    expect((await runRunpodJobSweep(deps())).examined).toBe(1);
  });

  it("does NOT touch a harvested row, which it cannot ask about", async () => {
    await store.indexRunpodJobs("ten_1", "hero", [
      { job_id: "job-harvested", module: "own-gpu", outcome: "submitted", submitted_at: NOW - RIPE, terminal_at: null },
    ]);
    const res = await runRunpodJobSweep(deps());
    expect(res.eligible).toBe(0);
    expect(upstream).toHaveLength(0);
    expect(row("job-harvested")).toMatchObject({ terminal_at: null });
  });

  it("REPORTS a truncated run: eligible is the true count, examined is what the cap allowed", async () => {
    for (let i = 0; i < SWEEP_MAX_ROWS_PER_RUN + 7; i++) await openJob(`job-${i}`, RIPE + i);
    const res = await runRunpodJobSweep(deps());
    // A capped run that reported only `examined` would read as complete coverage.
    expect(res.eligible).toBe(SWEEP_MAX_ROWS_PER_RUN + 7);
    expect(res.examined).toBe(SWEEP_MAX_ROWS_PER_RUN);
    expect(res.eligible).toBeGreaterThan(res.examined);
  });

  it("takes the OLDEST first, so a backlog truncates the youngest rather than the closest to death", async () => {
    await openJob("job-young", RIPE);
    await openJob("job-old", ANCIENT);
    const rows = await store.listOpenRunpodProxyJobs(NOW - RECONCILER_ADOPT_AFTER_MS, 1);
    expect(rows.map((r) => r.job_id)).toEqual(["job-old"]);
  });
});

describe("adopting a row whose callback never arrived", () => {
  it("closes it with the facts WE read, and records the vendor status verbatim", async () => {
    await openJob("job-1", RIPE);
    reply = () =>
      new Response(JSON.stringify({ status: "COMPLETED", executionTime: 4200, delayTime: 300 }), { status: 200 });
    const res = await runRunpodJobSweep(deps());
    expect(upstream).toEqual(["https://api.runpod.ai/v2/pool-backend/status/job-1"]);
    expect(res).toMatchObject({ examined: 1, closed: 1, unknown: 0, errors: 0 });
    expect(row("job-1")).toMatchObject({
      outcome: "completed",
      status_raw: "COMPLETED",
      execution_ms: 4200,
      delay_ms: 300,
    });
  });

  it("adopts the NON-SUCCESS terminals a naive poll walks past", async () => {
    for (const [job, status, outcome] of [
      ["job-f", "FAILED", "failed"],
      ["job-c", "CANCELLED", "cancelled"],
      ["job-t", "TIMED_OUT", "timed-out"],
    ] as const) {
      await openJob(job, RIPE);
      reply = () => new Response(JSON.stringify({ status }), { status: 200 });
      await runRunpodJobSweep(deps());
      expect(row(job)).toMatchObject({ outcome, status_raw: status });
    }
  });

  it("leaves a genuinely running job OPEN", async () => {
    await openJob("job-1", RIPE);
    reply = () => new Response(JSON.stringify({ status: "IN_QUEUE" }), { status: 200 });
    const res = await runRunpodJobSweep(deps());
    expect(res).toMatchObject({ stillRunning: 1, closed: 0, unknown: 0 });
    expect(row("job-1")).toMatchObject({ terminal_at: null });
  });

  it("is a no-op against a callback that won the race (the SAME guarded write)", async () => {
    await openJob("job-1", RIPE);
    await store.closeRunpodProxyJob({
      job_id: "job-1", outcome: "completed", status_raw: "COMPLETED",
      execution_ms: 99, delay_ms: 1, terminal_at: NOW - 1000,
    });
    // Already closed, so it is no longer eligible and the sweep never even asks.
    const res = await runRunpodJobSweep(deps());
    expect(res.examined).toBe(0);
    expect(row("job-1")).toMatchObject({ execution_ms: 99 });
  });
});

describe("the row it can NEVER answer", () => {
  it("records `unknown` only when RunPod is gone AND the row is past the retention horizon", async () => {
    await openJob("job-lost", ANCIENT);
    reply = () => new Response("not found", { status: 404 });
    const res = await runRunpodJobSweep(deps());
    expect(res).toMatchObject({ unknown: 1, closed: 0, errors: 0 });
    expect(row("job-lost")).toMatchObject({
      outcome: "unknown",
      status_raw: "",
      // NULL, never 0: nobody measured this job and a zero would claim someone did.
      execution_ms: null,
      delay_ms: null,
    });
  });

  it("REFUSES to write `unknown` on a 404 for a row still inside the horizon -- leaves it OPEN", async () => {
    // The retention figure is a WORKING NUMBER we wrote down, not a measurement. So a 404 alone is
    // never sufficient: if the endpoint were mistyped, or the horizon wrong, this is the branch
    // that stops a fabricated terminal.
    await openJob("job-young-404", RIPE);
    reply = () => new Response("not found", { status: 404 });
    const res = await runRunpodJobSweep(deps());
    expect(res).toMatchObject({ unknown: 0, closed: 0, errors: 1 });
    expect(row("job-young-404")).toMatchObject({ terminal_at: null });
  });

  it("`unknown` is never billable, and that is structural rather than a rule", async () => {
    await openJob("job-lost", ANCIENT);
    reply = () => new Response("not found", { status: 404 });
    await runRunpodJobSweep(deps());
    const { isBillable } = await import("../src/runpod-proxy");
    expect(isBillable("unknown")).toBe(false);
    // CONTROL: the predicate CAN answer true, so the false above is about the outcome and not a
    // function that refuses everything.
    expect(isBillable("completed")).toBe(true);
  });
});

describe("every failure leaves the row OPEN", () => {
  const cases: { name: string; reply: () => Response }[] = [
    { name: "a 500 from RunPod", reply: () => new Response("boom", { status: 500 }) },
    { name: "a 401 (our own credential is wrong)", reply: () => new Response("unauthorized", { status: 401 }) },
    { name: "a 429 (rate limited)", reply: () => new Response("slow down", { status: 429 }) },
    { name: "an unreadable body", reply: () => new Response("<html>nope", { status: 200 }) },
  ];

  for (const c of cases) {
    it(`leaves the row open on ${c.name}, and counts it as an error rather than an outcome`, async () => {
      await openJob("job-1", ANCIENT);
      reply = c.reply;
      const res = await runRunpodJobSweep(deps());
      expect(res).toMatchObject({ errors: 1, closed: 0, unknown: 0 });
      expect(row("job-1")).toMatchObject({ terminal_at: null, outcome: "submitted" });
    });
  }

  it("leaves the row open when the network throws", async () => {
    await openJob("job-1", ANCIENT);
    const res = await runRunpodJobSweep(
      deps({ fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch }),
    );
    expect(res).toMatchObject({ errors: 1 });
    expect(row("job-1")).toMatchObject({ terminal_at: null });
  });

  it("REFUSES to run at all without a pool credential, rather than reporting a clean sweep", async () => {
    await openJob("job-1", ANCIENT);
    const res = await runRunpodJobSweep(deps({ runpodApiKey: async () => "" }));
    // ran:false is the whole point: a run that examined nothing because it COULD not must never
    // look like a run that examined nothing because there was nothing to do.
    expect(res).toMatchObject({ ran: false, reason: "credential_unavailable", examined: 0 });
    expect(upstream).toHaveLength(0);
    // CONTROL: with a credential the same row IS examined.
    expect((await runRunpodJobSweep(deps())).examined).toBe(1);
  });

  it("one bad row does not abandon the rest of the sweep", async () => {
    await openJob("job-bad", ANCIENT);
    await openJob("job-good", ANCIENT - 1000);
    reply = (url) =>
      url.includes("job-bad")
        ? new Response("boom", { status: 500 })
        : new Response(JSON.stringify({ status: "COMPLETED", executionTime: 10 }), { status: 200 });
    const res = await runRunpodJobSweep(deps());
    expect(res).toMatchObject({ examined: 2, closed: 1, errors: 1 });
    expect(row("job-good")).toMatchObject({ outcome: "completed" });
    expect(row("job-bad")).toMatchObject({ terminal_at: null });
  });
});

describe("the denominator", () => {
  it("reports every bucket on a clean run, including the zeros", async () => {
    const res = await runRunpodJobSweep(deps());
    // A sweep that resolved nothing and a sweep that had nothing to do are the same exit code, so
    // the numbers are the only thing that tells them apart.
    expect(res).toEqual({
      ran: true, eligible: 0, examined: 0, closed: 0, unknown: 0, stillRunning: 0, errors: 0,
    });
  });
});
