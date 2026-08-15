// THE CRON DRIVES THE PROVISIONS NOBODY IS POLLING (cp#429).
//
// WHAT WAS BROKEN. The poll was the only engine. Both provision routes fire ONE driver under
// waitUntil and return 202; that driver spends its 15s budget, persists progress, hands the lease
// back and yields, and every step after it needs an inbound GET /api/tenant/:id/job. An
// operator-provisioned tenant has no client, so nothing polled it, so nothing drove it: the studio
// never built. It never failed honestly either, because the stale reap lives inside the same
// poll-only path, so the row simply read provisioning forever.
//
// WHY THIS FILE DRIVES REAL SQLITE AND runScheduledTick.
//
// The observable that matters is A ROW THAT MOVED, not a function that was called. A test asserting
// the driver was invoked would pass against a drive that never committed anything. So this builds
// the REAL D1Store over a REAL migrated SQLite, drives the SAME exported body the cron drives, and
// reads the tenant and job rows back through raw SQL.
//
// RED ON MAIN is marked per test. The two that matter (a job ADVANCES, and an abandoned job is
// DECLARED LOST) fail against main for exactly the right reason: runScheduledTick exists there and
// simply does not drive provisions, so the row does not move. The guard tests pass on main too --
// vacuously, because nothing drives at all -- and they are here to keep the guards from being
// dropped once something does.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ControlPlaneDeps, ProvisionerWiring } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import {
  PROVISION_DRIVE_TENANT_SLICE_MS,
  PROVISION_DRIVE_TICK_BUDGET_MS,
  runScheduledTick,
} from "../src/index";
import { D1Store } from "../src/store-d1";
import { d1Over, freshMigratedDb as freshDb } from "./sqlite-d1";

// A pooled provision, which is the shape the operator route creates and the ONLY shape a
// continuation can finish from an early yield without the tenant re-submitting a key.
const SHARED_FACTS = { runpodMode: "shared", toRelease: "v1.0.0" } as const;

const env = (): ControlPlaneEnv => ({ SHARED_RUNPOD_INVOKE_KEY: "pool-key" }) as ControlPlaneEnv;

describe("the cron drives provisions that nobody is polling (cp#429)", () => {
  let db: DatabaseSync;
  let store: D1Store;
  let resume: ReturnType<typeof vi.fn>;
  let deps: ControlPlaneDeps;
  /** Steered, not waited on. Advanced explicitly by a driver double so a read never moves it: the
   *  stale check reads the same clock, and a clock that ticked on every read would perturb it. */
  let clockMs: number;

  /** What the real continuation does on its success path, and nothing else: progress, a terminal
   *  job, and the tenant lifecycle move. Written THROUGH THE STORE so the assertions below read
   *  committed SQL rather than a promise that resolved. */
  const resumeThatSucceeds = () =>
    vi.fn(async (jobId: string, tenant: { id: string }) => {
      await store.updateJobProgress(jobId, "verify", JSON.stringify(["wfp_upload", "verify"]));
      await store.finishJob(jobId, "succeeded", null, null);
      await store.setTenantStatus(tenant.id, "awaiting_invoke_key");
    });

  /** A driver that ran and then stopped beating: the one state a new driver may take over. */
  const expireLease = (jobId: string) =>
    db.prepare("UPDATE provision_jobs SET lease_until = datetime(:now, :ago) WHERE id = :id")
      .run({ now: "now", ago: "-120 seconds", id: jobId });

  const noProgressFor = (jobId: string, minutes: number) =>
    db.prepare("UPDATE provision_jobs SET updated_at = datetime(:now, :ago) WHERE id = :id")
      .run({ now: "now", ago: -minutes + " minutes", id: jobId });

  const tenantRow = (id: string) =>
    db.prepare("SELECT status FROM tenants WHERE id = ?1").get(id) as { status: string };

  const jobRow = (id: string) =>
    db.prepare("SELECT status, error_message FROM provision_jobs WHERE id = ?1").get(id) as {
      status: string;
      error_message: string | null;
    };

  beforeEach(async () => {
    db = freshDb();
    store = new D1Store(d1Over(db));
    await store.createAccount("acct_1", "owner@example.com");
    clockMs = Date.now();
    resume = resumeThatSucceeds();
    deps = {
      store,
      mailer: { send: async () => {} },
      fetch: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      now: () => Date.now(),
      provisioner: { resume } as unknown as ProvisionerWiring,
    } as unknown as ControlPlaneDeps;
  });

  it("RED ON MAIN: an unpolled provision ADVANCES, and the tenant row moves off provisioning", async () => {
    await store.createTenant("ten_1", "conrad", "acct_1", "provisioning");
    await store.createProvisionJob("job_1", "ten_1", "provision", SHARED_FACTS);
    await store.setJobRunning("job_1");
    expireLease("job_1");

    // BEFORE: the state an operator-provisioned tenant is stuck in. Asserted rather than assumed,
    // so a setup that never reached provisioning could not make the after-check pass by itself.
    expect(tenantRow("ten_1").status).toBe("provisioning");

    await runScheduledTick(env(), deps);

    // AFTER: committed SQL, read back. This is the whole point of the test.
    expect(tenantRow("ten_1").status).toBe("awaiting_invoke_key");
    expect(jobRow("job_1").status).toBe("succeeded");
  });

  it("RED ON MAIN: an abandoned provision is DECLARED LOST instead of reading provisioning forever", async () => {
    await store.createTenant("ten_2", "abandoned", "acct_1", "provisioning");
    await store.createProvisionJob("job_2", "ten_2", "provision", SHARED_FACTS);
    await store.setJobRunning("job_2");
    expireLease("job_2");
    noProgressFor("job_2", 30);

    await runScheduledTick(env(), deps);

    // The reap is a REFUSAL to drive, so the driver must not have run.
    expect(resume).not.toHaveBeenCalled();
    expect(jobRow("job_2").status).toBe("failed");
    expect(jobRow("job_2").error_message).toMatch(/invocation lost/);
    expect(tenantRow("ten_2").status).toBe("failed");
  });

  it("never claims a job no driver has taken yet (cp#132), because winning it is destructive", async () => {
    await store.createTenant("ten_3", "fresh", "acct_1", "pending");
    await store.createProvisionJob("job_3", "ten_3", "provision", SHARED_FACTS);

    await runScheduledTick(env(), deps);

    expect(resume).not.toHaveBeenCalled();
    expect(jobRow("job_3").status).toBe("queued");
    expect(tenantRow("ten_3").status).toBe("pending");
  });

  it("never hands a module_upgrade job to the provision driver (cp#43)", async () => {
    // A provisioning tenant whose LATEST job is an upgrade. Driving it would run the provision
    // continuation against an upgrade row, which is the outage the kind guard exists to prevent.
    await store.createTenant("ten_4", "upgrading", "acct_1", "provisioning");
    await store.createModuleUpgradeJob("job_4", "ten_4", "v1.0.0", "v1.1.0");
    await store.setJobRunning("job_4");
    expireLease("job_4");

    await runScheduledTick(env(), deps);

    expect(resume).not.toHaveBeenCalled();
    expect(jobRow("job_4").status).toBe("running");
    expect(tenantRow("ten_4").status).toBe("provisioning");
  });

  it("leaves a LIVE tenant alone: the sweep scans the in-flight lifecycle states only", async () => {
    await store.createTenant("ten_5", "serving", "acct_1", "live");
    await store.createProvisionJob("job_5", "ten_5", "provision", SHARED_FACTS);
    await store.setJobRunning("job_5");
    expireLease("job_5");
    noProgressFor("job_5", 30);

    await runScheduledTick(env(), deps);

    // Not driven AND not reaped: a live tenant is not the sweep's business, and terminalizing its
    // old job would be a claim about a studio that is serving.
    expect(resume).not.toHaveBeenCalled();
    expect(jobRow("job_5").status).toBe("running");
    expect(tenantRow("ten_5").status).toBe("live");
  });

  it("POSITIVE CONTROL: the driver double really can move the row, so the refusals above are not vacuous", async () => {
    // Every it() above that asserts NOT-driven shares one failure mode: a double that could never
    // have moved anything. This drives the same double through the same tick on an eligible row.
    await store.createTenant("ten_6", "control", "acct_1", "pending");
    await store.createProvisionJob("job_6", "ten_6", "provision", SHARED_FACTS);
    await store.setJobRunning("job_6");
    expireLease("job_6");

    await runScheduledTick(env(), deps);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(tenantRow("ten_6").status).toBe("awaiting_invoke_key");
  });

  // ---- cp#437: the TOTAL-AGE cap ---------------------------------------------------------------

  /** Backdate CREATION, which is the quantity the cap measures and the one re-claiming cannot
   *  reset. Deliberately separate from noProgressFor above: that moves updated_at, and the whole
   *  point of the cap is that updated_at is no longer a usable clock under a cron. */
  const createdAgo = (jobId: string, minutes: number) =>
    db.prepare("UPDATE provision_jobs SET created_at = datetime(:now, :ago) WHERE id = :id")
      .run({ now: "now", ago: -minutes + " minutes", id: jobId });

  it("gives up on a job older than the cap, even though it was touched a moment ago", async () => {
    // THE CASE THE STALENESS RULE CANNOT SEE. updated_at is FRESH here -- claimJob stamps it on
    // every tick -- so the idle reap will never fire on this row no matter how long it runs.
    await store.createTenant("ten_old", "conrad", "acct_1", "provisioning");
    await store.createProvisionJob("job_old", "ten_old", "provision", SHARED_FACTS);
    await store.setJobRunning("job_old");
    expireLease("job_old");
    createdAgo("job_old", 3 * 60);

    await runScheduledTick(env(), deps);

    expect(tenantRow("ten_old").status).toBe("failed");
    expect(jobRow("job_old").status).toBe("failed");
    expect(jobRow("job_old").error_message).toMatch(/did not complete within/);
    // and it was REAPED rather than driven: the resume never ran.
    expect(resume).not.toHaveBeenCalled();
  });

  it("CONTROL: a job INSIDE the cap is still driven, so the cap is not just refusing everything", async () => {
    // Without this the case above would pass identically against a cap of zero.
    await store.createTenant("ten_young", "conrad", "acct_1", "provisioning");
    await store.createProvisionJob("job_young", "ten_young", "provision", SHARED_FACTS);
    await store.setJobRunning("job_young");
    expireLease("job_young");
    createdAgo("job_young", 30);

    await runScheduledTick(env(), deps);

    expect(tenantRow("ten_young").status).toBe("awaiting_invoke_key");
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("THE FOREVER LOOP: a job re-claimed every tick is eventually reaped by the cap", async () => {
    // ernst edge, and the second independent argument for this constant. claimJob stamps
    // updated_at (store-d1.ts:645), and the cron cadence sits INSIDE the staleness window, so a job
    // that keeps being claimed keeps resetting the only clock the idle rule reads. Simulated by
    // ticking repeatedly and letting each tick stamp the row.
    await store.createTenant("ten_loop", "conrad", "acct_1", "provisioning");
    await store.createProvisionJob("job_loop", "ten_loop", "provision", SHARED_FACTS);
    await store.setJobRunning("job_loop");

    // A driver that throws AFTER the claim: the row is stamped, nothing progresses, nothing fails.
    resume.mockImplementation(async () => {
      throw new Error("driver died after claim");
    });

    for (let i = 0; i < 3; i += 1) {
      expireLease("job_loop");
      await runScheduledTick(env(), deps);
      // updated_at is fresh after every tick, which is exactly why the idle rule never fires.
      expect(jobRow("job_loop").status).not.toBe("failed");
    }

    // Now age it past the cap. THIS is what breaks the loop, and nothing else would.
    createdAgo("job_loop", 3 * 60);
    expireLease("job_loop");
    await runScheduledTick(env(), deps);

    expect(jobRow("job_loop").status).toBe("failed");
    expect(tenantRow("ten_loop").status).toBe("failed");
  });

  // ---- cp#438 + cp#443: the reap is TWO writes, and half a guard is worse than none -------------

  it("a reap whose job write REFUSES does not flip the tenant either", async () => {
    // THE STATE THIS PREVENTS, and it is worse than the bug it comes from: another driver closes the
    // job between our read and our write, the job write correctly refuses on the terminal predicate
    // (cp#438), and without cp#443 the tenant write runs anyway. That leaves a studio which
    // provisioned CORRECTLY reading failed, beside a job row reading succeeded. Two records that
    // disagree are harder to diagnose than either being wrong alone.
    //
    // SIMULATED AT THE STORE SEAM rather than through the sweep, deliberately and stated because it
    // matters: driveJobIfNeeded returns early on a terminal job (index.ts:913), so a job that is
    // ALREADY closed never reaches the reap at all. The window is a genuine time-of-check to
    // time-of-use one -- read running, closed by someone else, then written -- and a fixture that
    // merely pre-closes the row tests nothing. I wrote that fixture first and it passed with the
    // conditional REMOVED, which is how I found it.
    await store.createTenant("ten_race", "conrad", "acct_1", "provisioning");
    await store.createProvisionJob("job_race", "ten_race", "provision", SHARED_FACTS);
    await store.setJobRunning("job_race");
    noProgressFor("job_race", 30);
    expireLease("job_race");

    // The other driver wins the moment our reap tries to close: the write changes no row.
    const realFinish = store.finishJob.bind(store);
    let refusedOnce = false;
    (store as unknown as { finishJob: unknown }).finishJob = async (...args: unknown[]) => {
      refusedOnce = true;
      void realFinish;
      void args;
      return false;
    };

    await runScheduledTick(env(), deps);

    expect(refusedOnce, "the reap never attempted a close, so this asserts nothing").toBe(true);
    // THE ASSERTION: the tenant is untouched because the job write refused.
    expect(tenantRow("ten_race").status).toBe("provisioning");
  });

  it("CONTROL: finishJob still closes a job that is genuinely open, and refuses the second close", async () => {
    // The predicate must not be refusing everything, and the terminal-record rule must actually
    // hold. Both directions, at the store, against real SQL.
    await store.createTenant("ten_open", "conrad", "acct_1", "provisioning");
    await store.createProvisionJob("job_open", "ten_open", "provision", SHARED_FACTS);
    await store.setJobRunning("job_open");
    expect(await store.finishJob("job_open", "failed", "wfp_upload", "boom")).toBe(true);
    expect(await store.finishJob("job_open", "succeeded", null, null)).toBe(false);
    expect(jobRow("job_open").status).toBe("failed");
  });

  it("NEVER reaps a job whose driver is still HEARTBEATING, however old or idle it looks", async () => {
    // cp#451, found by ernst. renewJobLease bumps lease_until ALONE and never updated_at, so a
    // driver sitting inside one long step is STALE by both reap clocks and ALIVE by the lease.
    // Before this guard the reap could not tell it from a dead one, killed it, and the living
    // driver then wrote its own terminal status over the row.
    //
    // Old by BOTH rules at once, so this fails if either terminalizer ignores the lease.
    await store.createTenant("ten_alive", "conrad", "acct_1", "provisioning");
    await store.createProvisionJob("job_alive", "ten_alive", "provision", SHARED_FACTS);
    await store.setJobRunning("job_alive");
    noProgressFor("job_alive", 30);
    createdAgo("job_alive", 3 * 60);
    // The heartbeat, doing exactly what cp#148 designed it to do.
    await store.renewJobLease("job_alive", 60);

    await runScheduledTick(env(), deps);

    // Untouched: not failed, not driven, left for the driver that owns it.
    expect(jobRow("job_alive").status).toBe("running");
    expect(tenantRow("ten_alive").status).toBe("provisioning");
    expect(resume).not.toHaveBeenCalled();
  });

  // ---- THE DUTY CYCLE (cp#429) ----------------------------------------------------------------
  //
  // A drive buys at most PROVISION_INVOCATION_BUDGET_MS (15s) of progress and then YIELDS, handing
  // the lease straight back (cp#158). The cron fires every 5 minutes. So one drive per tenant per
  // tick is 15 seconds of work per 300 seconds of clock: a 5% duty cycle, and roughly twenty times
  // slower than the poll path it substitutes for, which got a drive every few seconds because a
  // client was polling.
  //
  // Worse, it defeats the guard it inherits. cp#158 releases the lease ON YIELD precisely so the
  // next driver does not wait out a dead lease; driving once per tick then makes the job wait five
  // minutes anyway. Every guard individually intact, the optimisation one of them was written to
  // buy thrown away. No existing test can see that, because none of them measures HOW MANY times
  // one tick drives.
  //
  // So this one does, and it is the assertion that matters: the SAME tick drives the SAME job more
  // than once, and the row lands where the second drive puts it.

  /** A driver that behaves like the real one across a yield boundary: the first drive persists
   *  progress and hands the lease back (cp#158), the second finishes. Anything that drives only
   *  once leaves the tenant mid-flight, which is exactly what the assertion catches. */
  const resumeThatYieldsThenCompletes = () => {
    let calls = 0;
    return vi.fn(async (jobId: string, tenant: { id: string }) => {
      calls += 1;
      if (calls === 1) {
        await store.updateJobProgress(jobId, "wfp_upload", JSON.stringify(["wfp_upload"]));
        // The yield hand-back. Without it the next claimJob loses and the loop stops, so this is
        // also what makes the test drive the REAL contention path rather than an easier one.
        await store.releaseJobLease(jobId);
        return;
      }
      await store.updateJobProgress(jobId, "verify", JSON.stringify(["wfp_upload", "verify"]));
      await store.finishJob(jobId, "succeeded", null, null);
      await store.setTenantStatus(tenant.id, "awaiting_invoke_key");
    });
  };

  it("RED ON THE FIRST CUT: ONE tick drives a yielding job MORE THAN ONCE, instead of once per 5 minutes", async () => {
    resume = resumeThatYieldsThenCompletes();
    deps = { ...deps, provisioner: { resume } as unknown as ProvisionerWiring } as ControlPlaneDeps;
    await store.createTenant("ten_7", "duty", "acct_1", "provisioning");
    await store.createProvisionJob("job_7", "ten_7", "provision", SHARED_FACTS);
    await store.setJobRunning("job_7");
    expireLease("job_7");

    await runScheduledTick(env(), deps);

    // THE ASSERTION. Not that the tenant finished -- it could finish for other reasons -- but that
    // ONE tick drove it twice. A single-drive tick calls this once and leaves the row behind.
    expect(resume).toHaveBeenCalledTimes(2);
    expect(tenantRow("ten_7").status).toBe("awaiting_invoke_key");
    expect(jobRow("job_7").status).toBe("succeeded");
  });

  it("stops driving a job the guards refuse, rather than spinning on it inside the tick", async () => {
    // The loop termination proof. A queued job is refused by cp#132 on EVERY drive, so a loop that
    // retried on refusal would spin until the wall budget ran out and burn the whole tick.
    clockMs = Date.now();
    resume = resumeThatSucceeds();
    deps = { ...deps, provisioner: { resume } as unknown as ProvisionerWiring } as ControlPlaneDeps;
    await store.createTenant("ten_8", "queued", "acct_1", "pending");
    await store.createProvisionJob("job_8", "ten_8", "provision", SHARED_FACTS);

    await runScheduledTick(env(), deps);

    expect(resume).not.toHaveBeenCalled();
    expect(jobRow("job_8").status).toBe("queued");
  });

  it("stops when the job COMPLETES, without driving a terminal job a second time", async () => {
    // The other termination edge: after the drive that finishes the job, the next read sees a
    // terminal row and must stop. Driving a succeeded job would re-run a provision that is done.
    clockMs = Date.now();
    resume = resumeThatSucceeds();
    deps = { ...deps, provisioner: { resume } as unknown as ProvisionerWiring } as ControlPlaneDeps;
    await store.createTenant("ten_9", "onedrive", "acct_1", "provisioning");
    await store.createProvisionJob("job_9", "ten_9", "provision", SHARED_FACTS);
    await store.setJobRunning("job_9");
    expireLease("job_9");

    await runScheduledTick(env(), deps);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(jobRow("job_9").status).toBe("succeeded");
  });

  // ---- THE BOUNDS THEMSELVES (ernst) ----------------------------------------------------------
  //
  // The loop stops on refusal-stability, which the tests above cover. The BUDGET and the SLICE are
  // the other two exits and nothing exercised them, so they were assertions about code that had
  // never run. deps.now is injectable, so time is steered rather than waited on: the driver double
  // advances the clock the way real work would, instead of the clock advancing on every read (which
  // would perturb the stale check this loop also depends on).
  //
  // WHAT THESE TWO PIN, AND WHAT THEY DO NOT. They derive the burn from the constants, so they are
  // insensitive to the VALUES: setting either bound to a billion leaves them green. Measured, not
  // assumed. What they DO pin is that each exit EXISTS and FIRES, which is the part an edit removes:
  // stubbing out the slice branch turns the first red (2 drives instead of 1), and hardcoding the
  // outcome to drained turns the second red. Retuning a bound is a deliberate act and belongs in
  // review; deleting an exit is an accident and belongs in a test.
  const driveThatBurns = (ms: number) =>
    vi.fn(async (jobId: string) => {
      await store.updateJobProgress(jobId, "wfp_upload", JSON.stringify(["wfp_upload"]));
      await store.releaseJobLease(jobId);
      clockMs += ms;
    });

  it("stops driving a tenant once its SLICE is spent, even though the job would still yield", async () => {
    resume = driveThatBurns(PROVISION_DRIVE_TENANT_SLICE_MS + 10_000);
    deps = { ...deps, now: () => clockMs, provisioner: { resume } as unknown as ProvisionerWiring } as ControlPlaneDeps;
    await store.createTenant("ten_a", "slice", "acct_1", "provisioning");
    await store.createProvisionJob("job_a", "ten_a", "provision", SHARED_FACTS);
    await store.setJobRunning("job_a");
    expireLease("job_a");

    await runScheduledTick(env(), deps);

    // One drive, not a loop that runs until the job finishes: the slice is what stopped it.
    expect(resume).toHaveBeenCalledTimes(1);
    expect(jobRow("job_a").status).toBe("running");
  });

  it("reports budget_spent, so a truncated tick cannot read as a finished one", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logged.push(a.join(" ")));
    resume = driveThatBurns(PROVISION_DRIVE_TICK_BUDGET_MS + 10_000);
    deps = { ...deps, now: () => clockMs, provisioner: { resume } as unknown as ProvisionerWiring } as ControlPlaneDeps;
    await store.createTenant("ten_b", "budget", "acct_1", "provisioning");
    await store.createProvisionJob("job_b", "ten_b", "provision", SHARED_FACTS);
    await store.setJobRunning("job_b");
    expireLease("job_b");

    await runScheduledTick(env(), deps);
    spy.mockRestore();

    const tick = logged.find((l) => l.indexOf("scheduled.provision_drive_tick") !== -1) || "";
    expect(tick).toContain("budget_spent");
    expect(tick).not.toContain("drained");
  });
});
