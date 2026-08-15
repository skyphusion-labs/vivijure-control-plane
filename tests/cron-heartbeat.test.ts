// THE CRON HAS NO DURABLE LIVENESS SIGNAL (cp#436).
//
// WHAT WAS BROKEN. The scheduled handler ran three halves and every one reported to console only.
// Nothing persisted a tick ran at T, so the cron could not be observed from outside the Worker: if
// it stopped firing, every symptom was an ABSENCE (no meter periods, no sweep, no provision
// drives), and an absence is indistinguishable from an idle plane. Since cp#429 the cron is the
// ONLY engine that drives an operator-provisioned tenant to a studio, so the blast radius had
// moved from billing-is-late to the-product-silently-does-not-work while the observability stayed
// where it was.
//
// WHAT THIS FILE IS ACTUALLY TESTING, because it is easy to write a suite here that cannot fail.
// A heartbeat is an INSTRUMENT, and the failure that matters is not it being absent, it is it
// reading GREEN while the thing it measures is dead. So every test below is built to distinguish a
// real signal from a comfortable one, and each is paired with the mutation that turns it red.

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CRON_HEARTBEAT_KEY,
  CRON_STALE_AFTER_MS,
  CRON_TICK_INTERVAL_MS,
  summarizeCronLiveness,
  type TickHeartbeat,
} from "../src/cron-heartbeat";
import type { ControlPlaneDeps, ProvisionerWiring } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import { handle, runScheduledTick } from "../src/index";
import { D1Store } from "../src/store-d1";
import { d1Over, freshMigratedDb as freshDb } from "./sqlite-d1";

const NOW = 1_750_000_000_000;

const rowAt = (atMs: number, ok = true): string =>
  JSON.stringify({
    at: new Date(atMs).toISOString(),
    ok,
    halves: {
      llm_meter: { ok },
      runpod_sweep: { ok },
      provision_drive: { ok },
    },
  } satisfies TickHeartbeat);

describe("summarizeCronLiveness: the reader must never answer green from not-knowing", () => {
  it("reports NEVER RAN when there is no row, rather than a quiet healthy plane", () => {
    const v = summarizeCronLiveness(null, NOW);
    expect(v.ran).toBe(false);
    expect(v.stale).toBe(true);
    expect(v.at).toBeNull();
    expect(v.detail).toMatch(/has not run/);
  });

  // THE REQUIREMENT THE ISSUE NAMES, asserted as a CONTRAST rather than as two separate passing
  // reads. Each of these alone would pass against a function that returned a constant; only the
  // comparison shows the two states are actually distinguishable, which is the property an
  // operator depends on.
  it("DISTINGUISHES never-ran from ran-and-found-nothing", () => {
    const never = summarizeCronLiveness(null, NOW);
    const quiet = summarizeCronLiveness(rowAt(NOW - 1000), NOW);

    expect(never.ran).toBe(false);
    expect(quiet.ran).toBe(true);
    expect(never.stale).toBe(true);
    expect(quiet.stale).toBe(false);
    // The whole point, stated as the inequality it is.
    expect(quiet).not.toEqual(never);
  });

  it("goes RED on a tick that is recent but UNHEALTHY, not just on an old one", () => {
    // One second old. A staleness-only reader would call this the freshest possible tick.
    const v = summarizeCronLiveness(rowAt(NOW - 1000, false), NOW);
    expect(v.ran).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.stale).toBe(true);
  });

  it("goes RED once the last tick is older than the threshold, and stays GREEN just inside it", () => {
    // A PAIR either side of the boundary. A single old-is-stale assertion would also pass against
    // a function that called everything stale, which is a broken instrument in the other direction.
    expect(summarizeCronLiveness(rowAt(NOW - (CRON_STALE_AFTER_MS - 1000)), NOW).stale).toBe(false);
    expect(summarizeCronLiveness(rowAt(NOW - (CRON_STALE_AFTER_MS + 1000)), NOW).stale).toBe(true);
  });

  it("treats a PRESENT BUT UNPARSEABLE row as broken, not as never-ran and not as healthy", () => {
    const v = summarizeCronLiveness("{not json", NOW);
    expect(v.stale).toBe(true);
    expect(v.detail).toMatch(/unparseable/);
  });

  it("refuses to read a FUTURE timestamp as the freshest possible tick", () => {
    // The failure mode that looks healthiest: a bad clock or a bad write puts the stamp ahead of
    // now, and a naive age check then reports a negative age as maximally fresh forever.
    const v = summarizeCronLiveness(rowAt(NOW + 10 * CRON_TICK_INTERVAL_MS), NOW);
    expect(v.stale).toBe(true);
    expect(v.detail).toMatch(/future/);
  });
});

const SHARED_FACTS = { runpodMode: "shared", toRelease: "v1.0.0" } as const;
const env = (): ControlPlaneEnv => ({ SHARED_RUNPOD_INVOKE_KEY: "pool-key" }) as ControlPlaneEnv;

describe("the tick stamps a heartbeat a human can read (cp#436)", () => {
  let db: DatabaseSync;
  let store: D1Store;
  let deps: ControlPlaneDeps;

  /** Read the row the way the route does, straight out of committed SQL. */
  const heartbeat = async (): Promise<TickHeartbeat | null> => {
    const raw = await store.getSetting(CRON_HEARTBEAT_KEY);
    return raw === null ? null : (JSON.parse(raw) as TickHeartbeat);
  };

  beforeEach(async () => {
    db = freshDb();
    store = new D1Store(d1Over(db));
    await store.createAccount("acct_1", "owner@example.com");
    deps = {
      store,
      mailer: { send: async () => {} },
      fetch: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      provisioner: { resume: vi.fn(async () => {}) } as unknown as ProvisionerWiring,
    } as unknown as ControlPlaneDeps;
  });

  it("RED ON MAIN: a tick over an EMPTY plane still leaves a durable record that it ran", async () => {
    // The before-check is the half that makes this a test rather than a tautology: it pins that
    // the row is absent to begin with, so the after-check cannot be satisfied by a fixture.
    expect(await heartbeat()).toBeNull();

    await runScheduledTick(env(), deps);

    const row = await heartbeat();
    expect(row).not.toBeNull();
    expect(Date.parse(String(row?.at))).toBe(NOW);
  });

  // THE FALSE NEGATIVE THIS ISSUE IS ABOUT. If the stamp were skipped when the work failed, a
  // totally broken tick and a cron that never fired would leave the SAME evidence (none), and the
  // operator reading it would conclude the wrong thing in the more dangerous direction.
  it("stamps the row EVEN WHEN EVERY HALF FAILS, so broken never looks like dead", async () => {
    const broken = {
      ...deps,
      get llmSpend(): never {
        throw new Error("meter exploded");
      },
      store: new Proxy(store, {
        get(t, k: string, r) {
          if (k === "countOpenRunpodProxyJobs" || k === "listTenants") {
            return () => {
              throw new Error(k + " exploded");
            };
          }
          return Reflect.get(t, k, r);
        },
      }),
    } as unknown as ControlPlaneDeps;

    await expect(runScheduledTick(env(), broken)).resolves.toBeUndefined();

    const row = await heartbeat();
    expect(row?.ok).toBe(false);
    // Named, not merely aggregated: an operator has to know WHICH half to go and look at.
    expect(row?.halves.runpod_sweep.ok).toBe(false);
    expect(row?.halves.provision_drive.ok).toBe(false);
    expect(String(row?.halves.provision_drive.detail)).toMatch(/threw/);
  });
});

describe("a half that swallows its own errors must still be able to go RED (cp#436)", () => {
  let db: DatabaseSync;
  let store: D1Store;
  let deps: ControlPlaneDeps;

  const heartbeat = async (): Promise<TickHeartbeat | null> => {
    const raw = await store.getSetting(CRON_HEARTBEAT_KEY);
    return raw === null ? null : (JSON.parse(raw) as TickHeartbeat);
  };

  const expireLease = (jobId: string) =>
    db
      .prepare("UPDATE provision_jobs SET lease_until = datetime(:now, :ago) WHERE id = :id")
      .run({ now: "now", ago: "-120 seconds", id: jobId });

  beforeEach(async () => {
    db = freshDb();
    store = new D1Store(d1Over(db));
    await store.createAccount("acct_1", "owner@example.com");
  });

  // THE POINT OF THIS WHOLE FILE, IN ONE TEST.
  //
  // runPendingProvisionDrive catches PER TENANT, deliberately, so that one bad tenant cannot take
  // the sweep down. The consequence is that it RETURNS NORMALLY when every drive it attempted
  // failed. A heartbeat that marked the half ok because nothing propagated out of it would
  // therefore read GREEN through a total outage of the only engine that builds studios -- a
  // prettier version of exactly the blindness cp#436 exists to remove.
  //
  // So the half is judged on its ERROR COUNT, and this is the test that can tell the difference.
  it("RED: every provision drive fails, the half returns normally, and the record says so", async () => {
    await store.createTenant("ten_1", "conrad", "acct_1", "provisioning");
    await store.createProvisionJob("job_1", "ten_1", "provision", SHARED_FACTS);
    await store.setJobRunning("job_1");
    expireLease("job_1");

    const resume = vi.fn(async () => {
      throw new Error("provisioner blew up mid-step");
    });
    deps = {
      store,
      mailer: { send: async () => {} },
      fetch: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      provisioner: { resume } as unknown as ProvisionerWiring,
    } as unknown as ControlPlaneDeps;

    // It does NOT throw. That is the trap: the tick completes cleanly.
    await expect(runScheduledTick(env(), deps)).resolves.toBeUndefined();
    expect(resume).toHaveBeenCalled();

    const row = await heartbeat();
    expect(row?.halves.provision_drive.ok).toBe(false);
    expect(String(row?.halves.provision_drive.detail)).toMatch(/1 of 1 candidates threw/);
    expect(row?.ok).toBe(false);
  });

  // The instrument must not become the outage. A heartbeat write that fails is a monitoring gap;
  // a heartbeat write that takes down the engine it measures is a worse defect than the blindness.
  it("a FAILING heartbeat write does not take the tick down with it", async () => {
    const store2 = new Proxy(store, {
      get(t, k: string, r) {
        if (k === "setSetting") {
          return () => {
            throw new Error("D1 unavailable");
          };
        }
        return Reflect.get(t, k, r);
      },
    });
    deps = {
      store: store2,
      mailer: { send: async () => {} },
      fetch: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      provisioner: { resume: vi.fn(async () => {}) } as unknown as ProvisionerWiring,
    } as unknown as ControlPlaneDeps;

    await expect(runScheduledTick(env(), deps)).resolves.toBeUndefined();
  });
});

// THE ROUTE SEAM. The pure reader and the tick writer are each proven above; what neither can see
// is whether the endpoint actually joins them. A route that read the wrong key, or that ignored
// the stored row and returned a fixed object, would pass every test written so far.
describe("GET /api/admin/cron serves what the tick actually wrote (cp#436)", () => {
  const ADMIN_TOKEN = "a".repeat(64);
  const ORIGIN = "https://cp.example";

  const routeEnv = (): ControlPlaneEnv =>
    ({
      CONTROL_PLANE_HOST: "cp.example",
      CONTROL_PLANE_ADMIN_TOKEN: ADMIN_TOKEN,
      SHARED_RUNPOD_INVOKE_KEY: "pool-key",
      CP_RATE_LIMIT: { limit: async () => ({ success: true }) },
      ASSETS: { fetch: async () => new Response("ui", { status: 200 }) },
    }) as unknown as ControlPlaneEnv;

  const ctx = { waitUntil: () => {}, passThroughOnException() {} } as unknown as ExecutionContext;

  const get = (deps: ControlPlaneDeps) =>
    handle(
      new Request(ORIGIN + "/api/admin/cron", { headers: { origin: ORIGIN, authorization: "Bearer " + ADMIN_TOKEN } }),
      routeEnv(),
      ctx,
      deps,
    );

  it("reports NEVER RAN before any tick, then the real stamp after one", async () => {
    const db = freshDb();
    const store = new D1Store(d1Over(db));
    await store.createAccount("acct_1", "owner@example.com");
    const deps = {
      store,
      mailer: { send: async () => {} },
      fetch: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
      provisioner: { resume: vi.fn(async () => {}) } as unknown as ProvisionerWiring,
    } as unknown as ControlPlaneDeps;

    // BEFORE. This is the contrast that makes the after-read mean something: the same route on the
    // same store, differing only in whether a tick has happened.
    const before = (await (await get(deps)).json()) as Record<string, unknown>;
    expect(before.ran).toBe(false);
    expect(before.stale).toBe(true);

    await runScheduledTick(routeEnv(), deps);

    const after = (await (await get(deps)).json()) as Record<string, unknown>;
    expect(after.ran).toBe(true);
    expect(after.age_seconds).toBe(0);
    // Reads the STORED row rather than a constant: the halves come back individually named.
    expect(Object.keys(after.halves as object).sort()).toEqual(["llm_meter", "provision_drive", "runpod_sweep"]);
  });

  // BOTH HALVES, in one test, on purpose. A no-credential 401 ALONE is a dead assertion here: the
  // admin layer refuses an unknown path with 401 too, so it passes identically whether this route
  // exists or not. Proven, not assumed -- deleting the route left this test green until the
  // authorized half was added beside it. The contrast is what makes it a test of THIS route.
  it("is gated: no credential is refused, and the same request WITH one is served", async () => {
    const db = freshDb();
    const store = new D1Store(d1Over(db));
    const deps = { store, mailer: { send: async () => {} }, now: () => NOW } as unknown as ControlPlaneDeps;

    const anonymous = await handle(
      new Request(ORIGIN + "/api/admin/cron", { headers: { origin: ORIGIN } }),
      routeEnv(),
      ctx,
      deps,
    );
    expect(anonymous.status).toBe(401);

    const authorized = await get(deps);
    expect(authorized.status).toBe(200);
  });
});
