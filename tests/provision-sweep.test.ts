// The cron half that drives stuck provisions (cp#431).
//
// THE DEFECT, measured live before this was written: an operator-provisioned tenant returns 202 and
// nothing ever polls it, so it sits at provisioning forever. Tenant ten_cafd0eb9e802104d988778c0
// was stuck 36 minutes with url and studio_release null, and there was no way to advance it: the
// tenant job route is session-only (401 to an operator token) and no admin equivalent exists.
//
// WRITTEN AGAINST runScheduledTick, NOT against the sweep function directly, and that is the point:
// runScheduledTick exists on main, so this file can be run against main and WATCHED FAILING. A test
// importing sweepStuckProvisions could not fail on main, it could only fail to compile, which is
// not the same evidence.

import { describe, it, expect, vi } from "vitest";
import { runScheduledTick } from "../src/index";
import { MemoryStore } from "./memory-store";
import type { ControlPlaneDeps } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";

const NOW = Date.parse("2026-08-15T18:00:00Z");

/** A tenant mid-provision whose driver yielded and whose job nobody will ever poll. */
async function strandedTenant(store: MemoryStore, ageMinutes: number) {
  await store.createAccount("acct_1", "a@b.com");
  const t = await store.createTenant("ten_stuck", "conrad", "acct_1", "provisioning");
  const job = await store.createProvisionJob("job_1", t.id, "provision", {
    runpodMode: "shared",
    toRelease: "v1.25.0",
  });
  // A driver DID arrive and then yielded: that is what leaves status running with a free lease.
  await store.setJobRunning(job.id);
  await store.updateJobProgress(job.id, "r2_token", JSON.stringify(["d1_create", "d1_migrate", "r2_bucket", "r2_token"]));
  const created = new Date(NOW - ageMinutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
  const row = store.jobs.get(job.id)!;
  // A YIELD RELEASES THE LEASE. That is the state the bug leaves behind: status running, progress
  // recorded, no lease, and nothing that will ever poll it again.
  row.lease_until = null;
  row.created_at = created;
  row.updated_at = created;
  return { tenant: t, job };
}

function deps(store: MemoryStore, resume: ReturnType<typeof vi.fn>): ControlPlaneDeps {
  return {
    store,
    now: () => NOW,
    fetch: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    provisioner: {
      // The double ADVANCES THE ROW, so the assertion below is about a tenant that moved rather
      // than about a spy that was called.
      resume,
      start: vi.fn(async () => undefined),
      offersSharedTier: () => true,
      currentRelease: () => "v1.25.0",
      sharedPoolInvokeKey: () => "rpa_poolkey",
      installInvokeKey: vi.fn(async () => ({ ready: true, verified: [], unverified: [] })),
    },
  } as unknown as ControlPlaneDeps;
}

const env = {} as ControlPlaneEnv;

describe("the scheduled tick drives stuck provisions (cp#431)", () => {
  it("ADVANCES a tenant nobody is polling: the row moves off provisioning", async () => {
    const store = new MemoryStore();
    const { tenant } = await strandedTenant(store, 36);
    const resume = vi.fn(async (jobId: string, t: { id: string }) => {
      await store.setTenantStatus(t.id, "awaiting_invoke_key");
      await store.finishJob(jobId, "succeeded", null, null);
    });

    await runScheduledTick(env, deps(store, resume));

    // THE EVIDENCE: the tenant row, not the spy.
    expect(store.tenants.get(tenant.id)?.status).toBe("awaiting_invoke_key");
  });

  it("resumes from the steps ALREADY DONE, not from the beginning", async () => {
    // Driving from scratch would re-run d1_create and re-mint a credential on a tenant that already
    // has one. The steps the row records are the whole point of resuming rather than restarting.
    const store = new MemoryStore();
    await strandedTenant(store, 36);
    const resume = vi.fn(async () => undefined);
    await runScheduledTick(env, deps(store, resume));
    expect(resume).toHaveBeenCalledTimes(1);
    const [, , stepsDone] = resume.mock.calls[0] as unknown as [string, unknown, string[]];
    expect(stepsDone).toEqual(["d1_create", "d1_migrate", "r2_bucket", "r2_token"]);
  });

  it("CONTROL: a LIVE tenant is not touched, so the sweep is not simply driving everything", async () => {
    // Without this the assertion above would also pass on a sweep that resumed every row it found.
    const store = new MemoryStore();
    await store.createAccount("acct_1", "a@b.com");
    await store.createTenant("ten_live", "other", "acct_1", "live");
    const resume = vi.fn(async () => undefined);
    await runScheduledTick(env, deps(store, resume));
    expect(resume).not.toHaveBeenCalled();
  });

  it("CONTROL: a job no driver has taken yet is LEFT ALONE (cp#132)", async () => {
    // Claiming it races the driver that is starting under waitUntil, and winning that race deletes
    // the D1 and bucket the real driver is building. The poll path refuses this and so must the
    // sweep.
    const store = new MemoryStore();
    await store.createAccount("acct_1", "a@b.com");
    const t = await store.createTenant("ten_new", "fresh", "acct_1", "provisioning");
    await store.createProvisionJob("job_new", t.id, "provision", { runpodMode: "shared", toRelease: "v1.25.0" });
    const resume = vi.fn(async () => undefined);
    await runScheduledTick(env, deps(store, resume));
    expect(resume).not.toHaveBeenCalled();
  });

  it("gives up on a job older than the age cap rather than driving it forever", async () => {
    // The runaway guard, on TOTAL AGE. Idle time cannot be the measure here: with nothing polling,
    // idleness is the normal state of a healthy job between five-minute ticks.
    const store = new MemoryStore();
    const { tenant } = await strandedTenant(store, 3 * 60);
    const resume = vi.fn(async () => undefined);
    await runScheduledTick(env, deps(store, resume));
    expect(resume).not.toHaveBeenCalled();
    expect(store.tenants.get(tenant.id)?.status).toBe("failed");
  });
});
