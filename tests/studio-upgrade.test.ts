// The studio bytes-move for a LIVE tenant (cp#139).
//
// WHAT THIS FILE IS GUARDING, stated as the two sentences the route can fail at:
//
//   1. A LIVE TENANT MUST NOT BE STRANDED. The whole reason cp#112 refused to re-upload was secret
//      custody: a studio carries secrets the plane cannot reproduce, and an upload that omits a
//      binding DROPS it. So the assertions that matter most here are about what the upload CARRIES
//      (every non-secret binding, as `inherit`) and what it never touches (a secret VALUE).
//   2. A FAILED MOVE MUST LEAVE THE TENANT SERVING, and must not leave a release value standing that
//      claims a move completed. Asserted on the failure paths FIRST.
//
// A note on method, because it is the difference between a suite that proves something and a suite
// that proves its own fixtures: the "never handles a secret" and "never writes status" claims are
// made with RECORDING PROXIES over the real call, each with a positive control asserting the proxy
// records at all. A negative assertion over a call that never happens passes vacuously, and that is
// exactly the shape that has burned this estate before.

import { describe, it, expect, vi } from "vitest";
import type { ProvisionDeps } from "../src/provisioner";
import {
  preflightStudioUpgrade,
  upgradeTenantStudio,
  type StudioUpgradeContext,
} from "../src/tenant-studio-upgrade";
import type { CfApi } from "../src/cf-api";
import type { ProvisionJob, Tenant } from "../src/store";
import { jobHasLiveDriver } from "../src/store";
import { encryptStudioToken, kekRing } from "../src/token-crypto";
import { TENANT_STUDIO_VAR_DISPOSITION } from "../src/tenant-studio-env";
import { MemoryStore } from "./memory-store";
import { VIDEO_FINISH_TIER_STATE_VAR, VIDEO_FINISH_UNPROVISIONABLE } from "../src/video-finish-tier-state";

const KEK = btoa("0123456789abcdef0123456789abcdef");
const RING = kekRing(KEK);
const OLD_RELEASE = "v1.6.0";
const NEW_RELEASE = "v1.9.0";

/**
 * The binding set a REAL provisioned tenant carries, split the way the live one is: non-secret
 * bindings are visible to the bindings census, and the two unreconstructable secrets live in the
 * secret-names census. The fixture matters: if it did not include a secret the plane cannot rebuild,
 * this suite could not tell a safe upload from a stranding one.
 */
const LIVE_BINDINGS = [
  { type: "assets", name: "ASSETS" },
  { type: "dispatch_namespace", name: "MODULE_DISPATCH" },
  { type: "d1", name: "DB" },
  { type: "r2_bucket", name: "R2_RENDERS" },
  { type: "r2_bucket", name: "R2" },
  { type: "plain_text", name: "AUTH_MODE" },
  { type: "plain_text", name: "R2_S3_BUCKET" },
  { type: "plain_text", name: "R2_S3_ENDPOINT" },
  { type: "plain_text", name: "RUNPOD_ENDPOINT_ID" },
  { type: "ratelimit", name: "SPEND_RATE_LIMITER" },
  { type: "vpc_service", name: "VIDEO_FINISH_VPC" },
  { type: "secret_text", name: "R2_S3_ACCESS_KEY_ID" },
  { type: "secret_text", name: "R2_S3_SECRET_ACCESS_KEY" },
  { type: "secret_text", name: "STUDIO_API_TOKEN" },
];
const LIVE_SECRETS = ["R2_S3_ACCESS_KEY_ID", "R2_S3_SECRET_ACCESS_KEY", "STUDIO_API_TOKEN"];

/**
 * The env contract the fixture release declares: derived from the plane's OWN disposition table
 * rather than hand-copied. A hand-copied list would drift the moment someone adds a var, and this
 * suite would then be asserting against a contract that no longer exists.
 */
const CONTRACT_VARS = Object.keys(TENANT_STUDIO_VAR_DISPOSITION);

function fakeCf(over: Record<string, unknown> = {}) {
  return {
    uploadUserWorker: vi.fn(async () => undefined),
    createAssetsUploadSession: vi.fn(async () => ({ jwt: "jwt-complete", buckets: [] })),
    uploadAssetBucket: vi.fn(async () => ({ jwt: "jwt-complete" })),
    queryD1: vi.fn(async () => [{ results: [] }]),
    getScriptBindings: vi.fn(async () => LIVE_BINDINGS.map((b) => ({ ...b }))),
    getScriptSecretNames: vi.fn(async () => [...LIVE_SECRETS]),
    ...over,
  } as unknown as CfApi;
}

/** A bundle shaped like a real one: assets present, migrations present, the env contract declared. */
function fakeBundle(over: Record<string, unknown> = {}) {
  return {
    fetch: vi.fn(async (release: string) => ({
      mainModule: "worker.js",
      moduleText: `export default {} // studio@${release}`,
      compatibilityDate: "2026-06-01",
      assetsConfig: { html_handling: "none", run_worker_first: true },
      assets: [{ path: "/app.css", base64: "", contentType: "text/css", hash: "h1", size: 4 }],
      migrations: [{ name: "0012_wan_lora_keys.sql", sql: "CREATE TABLE IF NOT EXISTS wan (id TEXT);" }],
      requiredVars: CONTRACT_VARS,
      ...over,
    })),
  };
}

function deps(store: MemoryStore, over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    store,
    cf: fakeCf(),
    // The write credential is DELIBERATELY a different object from `cf` (cf#118): the readback must
    // go through the reader, and a test that shared one object could not tell them apart.
    scriptUploadCf: fakeCf(),
    bundle: fakeBundle(),
    namespace: "vivijure-tenants",
    moduleNamespace: "vivijure-tenant-modules",
    // The PLANE-WIDE pin, deliberately the OLD release: every assertion about what shipped is made
    // against the explicitly-requested release, never this, because shipping "whatever the plane was
    // pinned to" with nobody having said so is the defect the route refuses by requiring a release.
    release: OLD_RELEASE,
    tenantScriptName: (slug: string) => `tenant-${slug}-studio`,
    kek: RING,
    spendDailyCeiling: null,
    // A studio that serves, and whose /api/modules host object GAINS a field on the new release --
    // the served content marker acceptance criterion 2 asks for.
    callTenantStudio: vi.fn(async (_s: string, init: { path: string }) => {
      if (init.path === "/api/modules") {
        return { status: 200, text: JSON.stringify({ host: { video_finish: true } }) };
      }
      return { status: 200, text: "{}" };
    }),
    now: () => Date.now(),
    log: () => undefined,
    ...over,
  } as unknown as ProvisionDeps;
}

async function seedLiveTenant(store: MemoryStore, over: Partial<Tenant> = {}): Promise<Tenant> {
  await store.createAccount("acct_1", "a@b.com");
  const t = await store.createTenant("ten_1", "hero", "acct_1", "provisioning");
  await store.setTenantStudioToken(t.id, await encryptStudioToken(RING, "the-studio-token"));
  await store.setTenantScript(t.id, "tenant-hero-studio", OLD_RELEASE);
  await store.setTenantD1(t.id, "db-uuid-1");
  await store.setTenantStatus(t.id, "live");
  const row = (await store.getTenantById(t.id)) as Tenant;
  return { ...row, ...over };
}

/**
 * Create the job row the route creates before it drives the run. Tests that assert the TERMINAL job
 * write need this: finishJob against an id that was never inserted is a silent no-op, so asserting
 * a job status without it would pass whether or not the route wrote anything.
 */
async function seedJob(store: MemoryStore, tenant: Tenant, id = "job_1") {
  return await store.createStudioUpgradeJob(id, tenant.id, OLD_RELEASE, NEW_RELEASE);
}

async function contextFor(d: ProvisionDeps, tenant: Tenant, release = NEW_RELEASE): Promise<StudioUpgradeContext> {
  const pre = await preflightStudioUpgrade(d, tenant, release);
  if (!pre.ok) throw new Error(`preflight refused unexpectedly: ${pre.refusal.code}`);
  return pre.context;
}

// ---- cp#158: the lease on a studio upgrade means A DRIVER IS ALIVE ----------------------------
//
// THE SHAPE, inherited whole from cp#148. This driver marks at step boundaries only, and its steps
// are unbounded remote work: a migration set, an asset upload session, the script PUT. Any one of
// them longer than JOB_LEASE_SECONDS used to expire the lease under a perfectly healthy upgrade.
//
// WHAT THAT COSTS HERE is not a stolen job (no poll-driven continuation claims this kind); it is the
// ONE-WRITER guard. The route refuses a second upgrade on jobHasLiveDriver, which reads lease_until,
// so a lapsed lease admits a second driver PUTting different bytes into the same LIVE studio script.
// claimReclaim and beginTeardown read the same column.
describe("cp#158: the studio-upgrade lease is heartbeated while its driver lives", () => {
  it("a second writer CANNOT take the row while the driver is still inside the script upload", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryStore();
      const tenant = await seedLiveTenant(store);
      const job = await seedJob(store, tenant);

      // Two promises rather than a spin loop, for the reason the cp#148 test records: the steps
      // ahead of this one settle on the event loop, so a tight poll starves what it waits for.
      let entered!: () => void;
      const inUpload = new Promise<void>((r) => {
        entered = r;
      });
      let release!: () => void;
      const slowUpload = new Promise<void>((r) => {
        release = r;
      });
      const uploadUserWorker = vi.fn(async () => {
        entered();
        await slowUpload;
      });
      const d = deps(store, { scriptUploadCf: fakeCf({ uploadUserWorker }) });
      const context = await contextFor(d, tenant);

      // THE POSITIVE CONTROL: a second job takes the same 60s lease at the same instant with nobody
      // driving it. Without this, a harness that never expires anything would make the assertion
      // below pass for the wrong reason.
      const idle = await seedJob(store, tenant, "job_control");
      await store.setJobRunning(idle.id);

      const run = upgradeTenantStudio(d, job.id, tenant, context);
      await inUpload;
      expect(uploadUserWorker).toHaveBeenCalledTimes(1);

      // 90 seconds: a full 30s past the lease the last mark (assets_upload) left behind.
      await vi.advanceTimersByTimeAsync(90_000);

      const mid = (await store.getJob(job.id)) as ProvisionJob;
      expect(jobHasLiveDriver(mid, Date.now())).toBe(true);
      expect(await store.claimJob(job.id, 60)).toBe(false);

      // The control, same clock, same lease length, no driver: claimable. So the false above is the
      // heartbeat and not a clock that never moved.
      expect(jobHasLiveDriver((await store.getJob(idle.id)) as ProvisionJob, Date.now())).toBe(false);
      expect(await store.claimJob(idle.id, 60)).toBe(true);

      release();
      const outcome = await run;
      expect(outcome.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the beat DIES WITH THE DRIVER: a finished upgrade leaves no lease behind", async () => {
    // The other half of the meaning. A heartbeat that outlived its invocation would lock the row for
    // a lease term after the job is over, and would also be evidence that the timer is not coupled
    // to the invocation the way the whole design claims.
    vi.useFakeTimers();
    try {
      const store = new MemoryStore();
      const tenant = await seedLiveTenant(store);
      const job = await seedJob(store, tenant);
      const d = deps(store);
      const context = await contextFor(d, tenant);

      const outcome = await upgradeTenantStudio(d, job.id, tenant, context);
      expect(outcome.ok).toBe(true);

      await vi.advanceTimersByTimeAsync(120_000);
      const finished = (await store.getJob(job.id)) as ProvisionJob;
      expect(finished.status).toBe("succeeded");
      expect(finished.lease_until).toBeNull();
      expect(jobHasLiveDriver(finished, Date.now())).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- preflight: every refusal must have written NOTHING ----------------------------------------

describe("preflight refuses before anything is written", () => {
  it("PASSES on a healthy live tenant (the positive control every refusal below is measured against)", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);

    const pre = await preflightStudioUpgrade(deps(store), tenant, NEW_RELEASE);

    expect(pre.ok).toBe(true);
    if (!pre.ok) throw new Error("unreachable");
    expect(pre.context.release).toBe(NEW_RELEASE);
    expect(pre.context.fromRelease).toBe(OLD_RELEASE);
    // The served host object was captured BEFORE the move: without it there is no content marker.
    expect(pre.context.hostBefore).toEqual({ video_finish: true });
  });

  it("refuses a tenant with no studio script: there are no bytes to move", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);

    const pre = await preflightStudioUpgrade(deps(store), { ...tenant, script_name: null }, NEW_RELEASE);

    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error("unreachable");
    expect(pre.refusal.code).toBe("not_provisioned");
    expect(pre.refusal.status).toBe(409);
  });

  it("refuses a SUSPENDED tenant: a bytes move must not route around the kill switch", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    // status stays live -- suspension is the orthogonal axis and must win anyway.
    const pre = await preflightStudioUpgrade(
      deps(store),
      { ...tenant, suspended_at: "2026-07-19T00:00:00Z" },
      NEW_RELEASE,
    );

    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error("unreachable");
    expect(pre.refusal.code).toBe("tenant_suspended");
  });

  it("refuses a tenant that is not LIVE: an unfinished provision belongs to the resume path", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    await store.setTenantStatus(tenant.id, "awaiting_invoke_key");
    const row = (await store.getTenantById(tenant.id)) as Tenant;

    const pre = await preflightStudioUpgrade(deps(store), row, NEW_RELEASE);

    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error("unreachable");
    expect(pre.refusal.code).toBe("tenant_not_live");
  });

  it("refuses when there is no tenant D1: bytes must never arrive ahead of their schema", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);

    const pre = await preflightStudioUpgrade(deps(store), { ...tenant, d1_database_id: null }, NEW_RELEASE);

    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error("unreachable");
    expect(pre.refusal.code).toBe("tenant_d1_missing");
  });

  it("refuses a studio that is ALREADY not serving, rather than being blamed for it later", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const d = deps(store, {
      callTenantStudio: vi.fn(async () => ({ status: 503, text: "down" })) as unknown as ProvisionDeps["callTenantStudio"],
    });

    const pre = await preflightStudioUpgrade(d, tenant, NEW_RELEASE);

    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error("unreachable");
    expect(pre.refusal.code).toBe("tenant_studio_not_serving");
  });

  it("A BAD RELEASE PIN WRITES NOTHING AT ALL: no upload, no migration, no cleared release", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const cf = fakeCf();
    const upload = fakeCf();
    const d = deps(store, {
      cf,
      scriptUploadCf: upload,
      bundle: { fetch: vi.fn(async () => { throw new Error("studio release object missing from the mirror"); }) } as unknown as ProvisionDeps["bundle"],
    });

    const pre = await preflightStudioUpgrade(d, tenant, "v9.9.9");

    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error("unreachable");
    expect(pre.refusal.code).toBe("studio_bundle_unavailable");
    expect(upload.uploadUserWorker).not.toHaveBeenCalled();
    expect(cf.queryD1).not.toHaveBeenCalled();
    // The release the tenant runs is untouched: a refusal is not a partial move.
    expect(((await store.getTenantById(tenant.id)) as Tenant).studio_release).toBe(OLD_RELEASE);
  });

  it("refuses a release whose env contract this plane has not decided about, BY NAME", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const d = deps(store, {
      bundle: fakeBundle({ requiredVars: [...CONTRACT_VARS, "SOME_NEW_STUDIO_VAR"] }) as unknown as ProvisionDeps["bundle"],
    });

    const pre = await preflightStudioUpgrade(d, tenant, NEW_RELEASE);

    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error("unreachable");
    expect(pre.refusal.code).toBe("studio_var_contract_undecided");
    expect(pre.refusal.message).toContain("SOME_NEW_STUDIO_VAR");
  });

  it("ALLOWS a same-release run: re-shipping is convergence, not a no-op to refuse", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);

    const pre = await preflightStudioUpgrade(deps(store), tenant, OLD_RELEASE);

    expect(pre.ok).toBe(true);
  });
});

// ---- the upload shape: what strands a tenant is what the upload OMITS ---------------------------

describe("the upload carries the tenant forward instead of re-stating it", () => {
  it("sends EVERY non-secret binding as inherit, ASSETS as an assets binding, and NO secret value", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const upload = fakeCf();
    const d = deps(store, { scriptUploadCf: upload });

    const out = await upgradeTenantStudio(d, "job_1", tenant, await contextFor(d, tenant));

    expect(out.ok).toBe(true);
    const args = (upload.uploadUserWorker as unknown as { mock: { calls: [{ bindings: { type: string; name: string }[] }][] } })
      .mock.calls[0][0];
    const byName = new Map(args.bindings.map((b) => [b.name, b.type]));

    // CONTROL first: the proxy sees a real payload. Without this the assertions below could pass on
    // an upload that never happened.
    expect(args.bindings.length).toBeGreaterThan(0);

    // Every censused binding is still named. A binding omitted from an upload is DROPPED, which is
    // precisely how a live tenant loses a credential it cannot get back.
    for (const b of LIVE_BINDINGS) expect(byName.has(b.name)).toBe(true);
    // ...and every one of them travels as `inherit` EXCEPT ASSETS, which must be declared because
    // this upload ships new asset bytes.
    expect(byName.get("ASSETS")).toBe("assets");
    for (const b of LIVE_BINDINGS.filter((x) => x.name !== "ASSETS")) {
      expect(byName.get(b.name)).toBe("inherit");
    }
    // THE CUSTODY CLAIM, asserted as "was never PASSED" rather than "is not in the final state":
    // no binding in the payload carries a value field at all.
    for (const b of args.bindings as Record<string, unknown>[]) {
      expect(b.text).toBeUndefined();
      expect(b.service_id).toBeUndefined();
    }
  });

  it("ships the release's OWN asset config and bytes, verbatim", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const upload = fakeCf();
    const d = deps(store, { scriptUploadCf: upload });

    await upgradeTenantStudio(d, "job_1", tenant, await contextFor(d, tenant));

    const args = (upload.uploadUserWorker as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls[0][0];
    expect(args.moduleText).toContain(NEW_RELEASE);
    expect(args.assetsConfig).toEqual({ html_handling: "none", run_worker_first: true });
    expect(args.assetsJwt).toBe("jwt-complete");
  });

  it("applies the release migrations BEFORE the bytes land, not after", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const order: string[] = [];
    const cf = fakeCf({ queryD1: vi.fn(async () => { order.push("d1"); return [{ results: [] }]; }) });
    const upload = fakeCf({ uploadUserWorker: vi.fn(async () => { order.push("upload"); }) });
    const d = deps(store, { cf, scriptUploadCf: upload });

    await upgradeTenantStudio(d, "job_1", tenant, await contextFor(d, tenant));

    // CONTROL: both legs actually ran, so the ordering assertion is about order and not absence.
    expect(order).toContain("d1");
    expect(order).toContain("upload");
    expect(order.indexOf("d1")).toBeLessThan(order.indexOf("upload"));
  });
});

// ---- the two facts a live tenant depends on ----------------------------------------------------

describe("a live tenant stays live, and the release column never lies", () => {
  it("NEVER writes tenants.status, on the success path", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const statusWrites: string[] = [];
    const realSetStatus = store.setTenantStatus.bind(store);
    store.setTenantStatus = (async (id: string, status: string) => {
      statusWrites.push(status);
      return await realSetStatus(id, status as never);
    }) as typeof store.setTenantStatus;
    const d = deps(store);

    const out = await upgradeTenantStudio(d, "job_1", tenant, await contextFor(d, tenant));

    expect(out.ok).toBe(true);
    expect(statusWrites).toEqual([]);
    // CONTROL that the recorder RECORDS: without this, an empty array proves nothing about the
    // route and everything about a broken proxy.
    await store.setTenantStatus(tenant.id, "live");
    expect(statusWrites).toEqual(["live"]);
  });

  it("NEVER writes tenants.status on the FAILURE path either, and leaves studio_release NULL", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const statusWrites: string[] = [];
    const realSetStatus = store.setTenantStatus.bind(store);
    store.setTenantStatus = (async (id: string, status: string) => {
      statusWrites.push(status);
      return await realSetStatus(id, status as never);
    }) as typeof store.setTenantStatus;
    const d = deps(store, {
      scriptUploadCf: fakeCf({ uploadUserWorker: vi.fn(async () => { throw new Error("CF said no"); }) }),
    });
    const ctx = await contextFor(d, tenant);
    const seeded = await seedJob(store, tenant);

    const out = await upgradeTenantStudio(d, seeded.id, tenant, ctx);

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.step).toBe("wfp_upload");
    const job = await store.getJob(seeded.id);
    expect(job?.status).toBe("failed");
    expect(job?.error_step).toBe("wfp_upload");
    expect(statusWrites).toEqual([]);
    // NULL, not the old value and not the new one: the tenant is not known to be uniformly at any
    // release, and from_release survives on the job row.
    expect(((await store.getTenantById(tenant.id)) as Tenant).studio_release).toBeNull();
  });

  it("records the release only on SUCCESS, and clears it before the first write", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const seen: (string | null)[] = [];
    const realSet = store.setTenantStudioRelease.bind(store);
    store.setTenantStudioRelease = (async (id: string, release: string | null) => {
      seen.push(release);
      return await realSet(id, release);
    }) as typeof store.setTenantStudioRelease;
    const d = deps(store);

    const out = await upgradeTenantStudio(d, "job_1", tenant, await contextFor(d, tenant));

    expect(out.ok).toBe(true);
    // Cleared first, written last. The order IS the safety property.
    expect(seen).toEqual([null, NEW_RELEASE]);
    expect(((await store.getTenantById(tenant.id)) as Tenant).studio_release).toBe(NEW_RELEASE);
  });

  it("FAILS the job when the readback is short, even though every call returned 200", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    // The reader loses a binding after the write: the exact strand this route exists to catch.
    let read = 0;
    const cf = fakeCf({
      getScriptBindings: vi.fn(async () => {
        read += 1;
        return read === 1
          ? LIVE_BINDINGS.map((b) => ({ ...b }))
          : LIVE_BINDINGS.filter((b) => b.name !== "R2_S3_ENDPOINT").map((b) => ({ ...b }));
      }),
    });
    const d = deps(store, { cf });
    const ctx = await contextFor(d, tenant);
    const seeded = await seedJob(store, tenant);

    const out = await upgradeTenantStudio(d, seeded.id, tenant, ctx);

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.step).toBe("verify");
    expect(out.result?.missing_bindings).toEqual(["R2_S3_ENDPOINT"]);
    expect(((await store.getTenantById(tenant.id)) as Tenant).studio_release).toBeNull();
    const job = await store.getJob(seeded.id);
    expect(job?.status).toBe("failed");
    expect(job?.error_step).toBe("verify");
    // The pair that makes a failed move rollback-able: from_release survives on the row precisely
    // because studio_release was cleared.
    expect(job?.from_release).toBe(OLD_RELEASE);
    expect(job?.to_release).toBe(NEW_RELEASE);
  });

  it("FAILS when a SECRET went missing across the move: the custody claim, negatively tested", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    let read = 0;
    const cf = fakeCf({
      getScriptSecretNames: vi.fn(async () => {
        read += 1;
        return read === 1 ? [...LIVE_SECRETS] : LIVE_SECRETS.filter((n) => n !== "R2_S3_SECRET_ACCESS_KEY");
      }),
    });
    const d = deps(store, { cf });
    const ctx = await contextFor(d, tenant);

    const out = await upgradeTenantStudio(d, "job_1", tenant, ctx);

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.result?.missing_secrets).toEqual(["R2_S3_SECRET_ACCESS_KEY"]);
  });
});

// ---- the evidence the operator reads ------------------------------------------------------------

describe("the result is a readback, not a success flag", () => {
  it("reports the served host shape BEFORE and AFTER, and says when it changed", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    let calls = 0;
    const d = deps(store, {
      callTenantStudio: vi.fn(async (_s: string, init: { path: string }) => {
        if (init.path !== "/api/modules") return { status: 200, text: "{}" };
        calls += 1;
        // Before: no hooks_unavailable. After: the field the new release projects. This is the
        // content marker read off the SERVED response rather than off a release number.
        return calls === 1
          ? { status: 200, text: JSON.stringify({ host: { video_finish: true } }) }
          : { status: 200, text: JSON.stringify({ host: { video_finish: true, hooks_unavailable: {} } }) };
      }) as unknown as ProvisionDeps["callTenantStudio"],
    });

    const out = await upgradeTenantStudio(d, "job_1", tenant, await contextFor(d, tenant));

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.result.host_keys_before).toEqual(["video_finish"]);
    expect(out.result.host_keys_after).toEqual(["hooks_unavailable", "video_finish"]);
    expect(out.result.served_shape_changed).toBe(true);
    expect(out.result.migrations_applied).toEqual(["0012_wan_lora_keys.sql"]);
    expect(out.result.worker_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.result.assets_shipped).toBe(1);
  });

  it("says served_shape_changed:false honestly when the served shape did NOT move", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const d = deps(store);

    const out = await upgradeTenantStudio(d, "job_1", tenant, await contextFor(d, tenant, OLD_RELEASE));

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    // Same host object both sides: a convergence run reports no movement rather than dressing a
    // no-op as a move.
    expect(out.result.served_shape_changed).toBe(false);
  });
});

// cp#136: the ONE binding this upload must NOT simply carry forward.
//
// WHY IT IS HERE RATHER THAN IN THE cp#136 FILE: this is the seam where the two features meet, and
// it is the seam that fails silently. `inherit` PRESERVES what is bound, which is the right default
// for every other binding and exactly wrong for a projection of a plane record. A tenant whose
// unreachable declaration was cleared would otherwise carry VIDEO_FINISH_TIER_STATE across the move
// and keep telling its user the tier can never be turned on for them.
describe("the finish-tier state is RE-DERIVED across a bytes move, not inherited (cp#136)", () => {
  const staleCf = () =>
    fakeCf({
      getScriptBindings: vi.fn(async () => [
        ...LIVE_BINDINGS.map((b) => ({ ...b })),
        { type: "plain_text", name: VIDEO_FINISH_TIER_STATE_VAR },
      ]),
    });
  const sent = (upload: CfApi) =>
    (upload.uploadUserWorker as unknown as { mock: { calls: [{ bindings: { type: string; name: string; text?: string }[] }][] } })
      .mock.calls[0][0].bindings;

  it("DROPS a stale var when the plane record says the tenant is reachable", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const upload = fakeCf();
    const d = deps(store, { cf: staleCf(), scriptUploadCf: upload });

    await upgradeTenantStudio(d, "job_1", tenant, await contextFor(d, tenant));

    const bindings = sent(upload);
    // CONTROL: the proxy saw a real payload, so the absence below is an omission and not an
    // upload that never happened.
    expect(bindings.length).toBeGreaterThan(0);
    // Omitted means DROPPED for a non-secret binding (cp#112 live probe), and dropping it is how a
    // cleared record reaches the studio.
    expect(bindings.find((b) => b.name === VIDEO_FINISH_TIER_STATE_VAR)).toBeUndefined();
  });

  it("RE-STATES it from the record when the tenant is declared unreachable", async () => {
    const store = new MemoryStore();
    const seeded = await seedLiveTenant(store);
    await store.setTenantVideoFinishUnreachable(seeded.id, {
      reason: "the CF account holding this studio is gone",
      at: "2026-07-26T12:00:00.000Z",
    });
    const tenant = (await store.getTenantById(seeded.id)) as Tenant;
    const upload = fakeCf();
    const d = deps(store, { scriptUploadCf: upload });

    await upgradeTenantStudio(d, "job_1", tenant, await contextFor(d, tenant));

    const bindings = sent(upload);
    expect(bindings.length).toBeGreaterThan(0);
    // plain_text carrying the value, NOT an inherit: the value comes from the plane record on every
    // move, so a studio that lost it gets it back and a studio that has it keeps the right one.
    expect(bindings.find((b) => b.name === VIDEO_FINISH_TIER_STATE_VAR)).toEqual({
      type: "plain_text",
      name: VIDEO_FINISH_TIER_STATE_VAR,
      text: VIDEO_FINISH_UNPROVISIONABLE,
    });
    // And nothing else grew a value: the custody claim above still holds on this path.
    for (const b of bindings.filter((x) => x.name !== VIDEO_FINISH_TIER_STATE_VAR)) {
      expect(b.text).toBeUndefined();
    }
  });
});
