// The module-upgrade route for a LIVE tenant (cf#103 half two).
//
// WHAT THIS FILE IS ACTUALLY GUARDING, and why every fixture below is an ALREADY-PROVISIONED
// tenant: the hosted-tier sprint found five production defects in one night, and every one of them
// was invisible to fresh-slug testing because they only existed on the ADOPT path -- the path that
// runs against resources that already exist. An upgrade is nothing BUT that path: it re-runs module
// steps against a tenant that already completed them. A test here that started from a clean create
// would be testing the one shape this route never sees.
//
// The gate this file exists to hold is single: A FAILED UPGRADE MUST LEAVE THE TENANT SERVING. That
// is not an aspiration, it is an assertion, and it is made on the failure path FIRST.

import { describe, it, expect, vi } from "vitest";
import {
  preflightModuleUpgrade,
  upgradeTenantModules,
  type ModuleUpgradeContext,
  type ProvisionDeps,
} from "../src/provisioner";
import { routingStatusFor } from "../src/tenant-resolver";
import { tenantRefusal } from "../src/routing";
import type { CfApi } from "../src/cf-api";
import type { Tenant } from "../src/store";
import { encryptStudioToken } from "../src/token-crypto";
import { MemoryStore } from "./memory-store";

const KEK = btoa("0123456789abcdef0123456789abcdef");
const OLD_RELEASE = "v1.0.0";
const NEW_RELEASE = "v1.1.0";

/** All four endpoints: the catalog maps a module onto each, so a short list fails at upload for a
 *  reason that has nothing to do with what is under test. */
const ENDPOINTS = [
  { key: "backend", label: "Render", id: "ep1", name: "n1", endpointVar: "RUNPOD_ENDPOINT_ID" },
  { key: "upscale", label: "Upscale", id: "ep2", name: "n2", endpointVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { key: "lipsync", label: "Lipsync", id: "ep3", name: "n3", endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID" },
  { key: "audio-upscale", label: "Audio", id: "ep4", name: "n4", endpointVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
];

function fakeCf(over: Record<string, unknown> = {}) {
  return {
    uploadUserWorker: vi.fn(async () => undefined),
    createDispatchNamespace: vi.fn(async () => undefined),
    getScriptBindings: vi.fn(async () => [
      { type: "assets", name: "ASSETS" },
      { type: "d1", name: "DB" },
      { type: "r2_bucket", name: "R2_RENDERS" },
      { type: "plain_text", name: "AUTH_MODE" },
      { type: "plain_text", name: "R2_S3_BUCKET" },
      { type: "plain_text", name: "R2_S3_ENDPOINT" },
      { type: "ratelimit", name: "SPEND_RATE_LIMITER" },
      { type: "plain_text", name: "RUNPOD_ENDPOINT_ID" },
      { type: "plain_text", name: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
      { type: "plain_text", name: "MUSETALK_RUNPOD_ENDPOINT_ID" },
      { type: "plain_text", name: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
    ]),
    getScriptSecretNames: vi.fn(async () => ["R2_S3_SECRET_ACCESS_KEY", "STUDIO_API_TOKEN"]),
    ...over,
  } as unknown as CfApi;
}

function deps(store: MemoryStore, over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    store,
    cf: fakeCf(),
    moduleBundle: {
      fetch: vi.fn(async (release: string, name: string) => ({
        mainModule: "i.js",
        moduleText: `export default {} // ${name}@${release}`,
        compatibilityDate: "2026-06-01",
      })),
    },
    moduleNamespace: "vivijure-tenant-modules",
    namespace: "vivijure-tenants",
    // The PLANE-WIDE pin. Every assertion about which release actually shipped is made against
    // NEW_RELEASE, never this, because the defect that produced this route was module bytes
    // silently shipping at deps.release while nobody had said so.
    release: OLD_RELEASE,
    tenantScriptName: (slug: string) => `tenant-${slug}-studio`,
    kek: KEK,
    spendDailyCeiling: null,
    callTenantStudio: vi.fn(async (_s: string, init: { path: string }) => {
      if (init.path === "/api/modules/installed") {
        return { status: 200, text: JSON.stringify({ modules: [{ name: "keyframe" }] }) };
      }
      if (init.path === "/api/modules/install") return { status: 201, text: "{}" };
      return { status: 200, text: "{}" };
    }),
    log: () => undefined,
    ...over,
  } as unknown as ProvisionDeps;
}

/**
 * A tenant that is ALREADY FULLY PROVISIONED AND LIVE. Everything the upgrade needs is on the row
 * because a real live tenant has it: endpoints, a studio token, a script name, a recorded module
 * release it is moving away from.
 */
async function seedLiveTenant(store: MemoryStore, over: Partial<Tenant> = {}): Promise<Tenant> {
  await store.createAccount("acct_1", "a@b.com");
  const t = await store.createTenant("ten_1", "hero", "acct_1", "provisioning");
  await store.setTenantEndpoints(t.id, JSON.stringify(ENDPOINTS));
  await store.setTenantStudioToken(t.id, await encryptStudioToken(KEK, "the-studio-token"));
  await store.setTenantScript(t.id, "tenant-hero-studio", OLD_RELEASE);
  await store.setTenantModulesRelease(t.id, OLD_RELEASE);
  await store.setTenantStatus(t.id, "live");
  const row = (await store.getTenantById(t.id)) as Tenant;
  return { ...row, ...over };
}

/** The context a passing preflight hands to the upgrade. */
async function contextFor(d: ProvisionDeps, tenant: Tenant, release = NEW_RELEASE): Promise<ModuleUpgradeContext> {
  const pre = await preflightModuleUpgrade(d, tenant, release);
  if (!pre.ok) throw new Error(`preflight refused unexpectedly: ${pre.refusal.code}`);
  return pre.context;
}

// ---- preflight: every refusal must have written NOTHING -------------------------------------

describe("preflight refuses before anything is written", () => {
  it("refuses a tenant that is not LIVE, and names the path that DOES handle it", async () => {
    const store = new MemoryStore();
    // Otherwise complete: endpoints, token, script all present. ONLY the status differs, so this
    // proves the status guard rather than the absence of everything else.
    const tenant = await seedLiveTenant(store);
    await store.setTenantStatus(tenant.id, "awaiting_invoke_key");
    const live = (await store.getTenantById(tenant.id)) as Tenant;

    const pre = await preflightModuleUpgrade(deps(store), live, NEW_RELEASE);

    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error("unreachable");
    expect(pre.refusal.code).toBe("tenant_not_live");
    expect(pre.refusal.status).toBe(409);
    expect(pre.refusal.message).toContain("resumed through the provision job");
  });

  it("refuses a SUSPENDED tenant: an upgrade must not route around the kill switch", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    // status is still live -- suspension is the orthogonal axis, and it must win anyway.
    const suspended: Tenant = { ...tenant, suspended_at: "2026-07-19T00:00:00Z" };

    const pre = await preflightModuleUpgrade(deps(store), suspended, NEW_RELEASE);

    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error("unreachable");
    expect(pre.refusal.code).toBe("tenant_suspended");
    expect(pre.refusal.status).toBe(409);
  });

  it("refuses a studio that is ALREADY not serving, rather than being blamed for it later", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const d = deps(store, {
      callTenantStudio: vi.fn(async () => ({ status: 503, text: "down" })) as unknown as ProvisionDeps["callTenantStudio"],
    });

    const pre = await preflightModuleUpgrade(d, tenant, NEW_RELEASE);

    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error("unreachable");
    expect(pre.refusal.code).toBe("tenant_studio_not_serving");
    expect(pre.refusal.status).toBe(422);
  });

  it("A BAD RELEASE PIN UPLOADS NOTHING AT ALL -- the fetch-all-before-upload payoff", async () => {
    // THE defect this ordering exists to prevent: the provision path fetches and uploads in one
    // loop, so a release missing its 4th bundle swaps three modules and THEN fails, leaving a live
    // tenant on mixed bytes. Here the failure must happen with zero uploads issued.
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const cf = fakeCf();
    const d = deps(store, {
      cf,
      moduleBundle: {
        fetch: vi.fn(async (_r: string, name: string) => {
          // The FOURTH catalog module is the missing one, so any fetch-then-upload interleaving
          // would already have uploaded three scripts by the time this throws.
          if (name === "finish-lipsync") throw new Error("no such object in the release mirror");
          return { mainModule: "i.js", moduleText: "export default {}", compatibilityDate: "2026-06-01" };
        }),
      } as unknown as ProvisionDeps["moduleBundle"],
    });

    const pre = await preflightModuleUpgrade(d, tenant, NEW_RELEASE);

    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error("unreachable");
    expect(pre.refusal.code).toBe("module_bundle_unavailable");
    expect(pre.refusal.status).toBe(422);
    expect(pre.refusal.message).toContain("finish-lipsync");
    // The whole point.
    expect(cf.uploadUserWorker).not.toHaveBeenCalled();
    // And the tenant row is untouched: still recorded at the release it was already on.
    expect(((await store.getTenantById(tenant.id)) as Tenant).modules_release).toBe(OLD_RELEASE);
  });

  it("accepts a live, fully-provisioned tenant and returns EXACTLY the context keys", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);

    const pre = await preflightModuleUpgrade(deps(store), tenant, NEW_RELEASE);

    expect(pre.ok).toBe(true);
    if (!pre.ok) throw new Error("unreachable");
    // EXACT key set, not a subset: toMatchObject would pass while the context silently grew or
    // lost a field, and this object is what the upgrade runs on.
    expect(Object.keys(pre.context).sort()).toEqual(
      ["bundles", "endpoints", "release", "script", "studioApiToken"].sort(),
    );
    // VALUE TYPES, not just presence: a fixture that agreed on the wrong type is how [object Object]
    // shipped to customers past an exact key-set check.
    expect(typeof pre.context.script).toBe("string");
    expect(typeof pre.context.studioApiToken).toBe("string");
    expect(typeof pre.context.release).toBe("string");
    expect(Array.isArray(pre.context.endpoints)).toBe(true);
    expect(pre.context.bundles).toBeInstanceOf(Map);
    // It carries the release the OPERATOR asked for, never the plane-wide deps.release.
    expect(pre.context.release).toBe(NEW_RELEASE);
    expect(pre.context.bundles.size).toBe(5);
  });

  it("fetches every bundle at the REQUESTED release, not the plane-wide pin", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const fetchSpy = vi.fn(async () => ({
      mainModule: "i.js",
      moduleText: "export default {}",
      compatibilityDate: "2026-06-01",
    }));
    const d = deps(store, { moduleBundle: { fetch: fetchSpy } as unknown as ProvisionDeps["moduleBundle"] });

    await preflightModuleUpgrade(d, tenant, NEW_RELEASE);

    expect(fetchSpy).toHaveBeenCalledTimes(5);
    // deps.release is OLD_RELEASE; if the explicit release were being dropped this would be it.
    for (const call of fetchSpy.mock.calls as unknown as [string, string][]) {
      expect(call[0]).toBe(NEW_RELEASE);
    }
  });
});

// ---- the upgrade itself ----------------------------------------------------------------------

describe("upgradeTenantModules", () => {
  it("re-runs EVERY module step against a tenant that already completed them", async () => {
    // The behavioural difference from resume, which skips completed steps. The tenant below has
    // been through all of this once already.
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const cf = fakeCf();
    const d = deps(store, { cf });
    const job = await store.createModuleUpgradeJob("job_up", tenant.id, OLD_RELEASE, NEW_RELEASE);

    const out = await upgradeTenantModules(d, job.id, tenant, await contextFor(d, tenant));

    expect(out.ok).toBe(true);
    // All five catalog modules, uploaded and installed again.
    expect(cf.uploadUserWorker).toHaveBeenCalledTimes(5);
    const installs = (d.callTenantStudio as unknown as { mock: { calls: [string, { path: string }][] } }).mock.calls
      .filter((c) => c[1].path === "/api/modules/install");
    expect(installs).toHaveLength(5);
  });

  it("uses the PRE-FETCHED bundles; it does not re-fetch during upload", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const fetchSpy = vi.fn(async () => ({
      mainModule: "i.js",
      moduleText: "export default {}",
      compatibilityDate: "2026-06-01",
    }));
    const d = deps(store, { moduleBundle: { fetch: fetchSpy } as unknown as ProvisionDeps["moduleBundle"] });
    const context = await contextFor(d, tenant);
    const job = await store.createModuleUpgradeJob("job_up", tenant.id, OLD_RELEASE, NEW_RELEASE);
    fetchSpy.mockClear();

    await upgradeTenantModules(d, job.id, tenant, context);

    // Zero: everything it needed was already in hand before the first write.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HAPPY PATH: the tenant stays LIVE and ROUTABLE, and the module release moves", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const d = deps(store);
    const job = await store.createModuleUpgradeJob("job_up", tenant.id, OLD_RELEASE, NEW_RELEASE);

    const out = await upgradeTenantModules(d, job.id, tenant, await contextFor(d, tenant));

    expect(out).toEqual({
      ok: true,
      release: NEW_RELEASE,
      modules: ["keyframe", "own-gpu", "finish-upscale", "finish-lipsync", "speech-upscale"],
    });
    const after = (await store.getTenantById(tenant.id)) as Tenant;
    // THE RULE: status untouched. continueProvisionJob would have written awaiting_invoke_key here,
    // which is a 503 to the tenant own users -- on the SUCCESS path.
    expect(after.status).toBe("live");
    expect(routingStatusFor(after)).toBe("live");
    expect(tenantRefusal(after)).toBeNull();
    // The module release moved; the STUDIO pin did not, because the studio bytes did not.
    expect(after.modules_release).toBe(NEW_RELEASE);
    expect(after.studio_release).toBe(OLD_RELEASE);
    const finished = await store.getJob(job.id);
    expect(finished?.status).toBe("succeeded");
  });

  it("THE GATE -- a FAILED upgrade leaves the tenant LIVE and SERVING", async () => {
    // If this assertion ever inverts, the route is an outage generator and must not ship.
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const d = deps(store, {
      callTenantStudio: vi.fn(async (_s: string, init: { path: string }) => {
        if (init.path === "/api/modules/install") return { status: 500, text: "conformance exploded" };
        if (init.path === "/api/modules/installed") {
          return { status: 200, text: JSON.stringify({ modules: [{ name: "keyframe" }] }) };
        }
        return { status: 200, text: "{}" };
      }) as unknown as ProvisionDeps["callTenantStudio"],
    });
    const context = await contextFor(d, tenant);
    const job = await store.createModuleUpgradeJob("job_up", tenant.id, OLD_RELEASE, NEW_RELEASE);

    const out = await upgradeTenantModules(d, job.id, tenant, context);

    expect(out.ok).toBe(false);
    const after = (await store.getTenantById(tenant.id)) as Tenant;
    expect(after.status).toBe("live");
    // Proven through the ACTUAL serving path, not by reading the column: this is what a user
    // hitting the studio mid-failure gets.
    expect(routingStatusFor(after)).toBe("live");
    expect(tenantRefusal(after)).toBeNull();
    // The failure is RECORDED, with the studio own words.
    const finished = await store.getJob(job.id);
    expect(finished?.status).toBe("failed");
    expect(finished?.error_step).toBe("modules_install");
    expect(finished?.error_message).toContain("conformance exploded");
  });

  it("a partial failure leaves modules_release NULL, never a value asserting a false uniformity", async () => {
    // The ledger defect: modules 1-3 swapped to NEW, module 4 dead, column still reading OLD would
    // claim a uniformity the resident scripts do not have.
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const d = deps(store, {
      callTenantStudio: vi.fn(async (_s: string, init: { path: string }) => {
        if (init.path === "/api/modules/install") return { status: 500, text: "boom" };
        return { status: 200, text: "{}" };
      }) as unknown as ProvisionDeps["callTenantStudio"],
    });
    const context = await contextFor(d, tenant);
    const job = await store.createModuleUpgradeJob("job_up", tenant.id, OLD_RELEASE, NEW_RELEASE);

    await upgradeTenantModules(d, job.id, tenant, context);

    const after = (await store.getTenantById(tenant.id)) as Tenant;
    expect(after.modules_release).toBeNull();
    // And the previous release is still recoverable -- from the JOB, which is the whole reason it
    // is recorded there. Without this, rollback is unknowable in exactly the state that needs it.
    const finished = await store.getJob(job.id);
    expect(finished?.from_release).toBe(OLD_RELEASE);
    expect(finished?.to_release).toBe(NEW_RELEASE);
  });

  it("never calls setTenantStatus, on either path (recorded, not inferred from the final row)", async () => {
    // A point-in-time read of the final row cannot prove a write-then-restore never happened.
    // Record every call instead, and CONTROL-assert that the recorder actually records.
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const calls: unknown[][] = [];
    const recording = new Proxy(store, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop === "setTenantStatus" && typeof v === "function") {
          return (...args: unknown[]) => {
            calls.push(args);
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    // CONTROL: the proxy really does observe this method. Without this the test passes just as
    // happily when the recorder is broken.
    await recording.setTenantStatus(tenant.id, "live");
    expect(calls).toHaveLength(1);
    calls.length = 0;

    const d = deps(recording as unknown as MemoryStore);
    const context = await contextFor(d, tenant);
    const okJob = await store.createModuleUpgradeJob("job_ok", tenant.id, OLD_RELEASE, NEW_RELEASE);
    await upgradeTenantModules(d, okJob.id, tenant, context);

    const failing = deps(recording as unknown as MemoryStore, {
      callTenantStudio: vi.fn(async (_s: string, init: { path: string }) => {
        if (init.path === "/api/modules/install") return { status: 500, text: "boom" };
        return { status: 200, text: "{}" };
      }) as unknown as ProvisionDeps["callTenantStudio"],
    });
    const failJob = await store.createModuleUpgradeJob("job_bad", tenant.id, OLD_RELEASE, NEW_RELEASE);
    await upgradeTenantModules(failing, failJob.id, tenant, context);

    expect(calls).toEqual([]);
  });
});

// ---- per-step timing on the upgrade path (cp#18) ------------------------------------------------
//
// The instrumentation was added to all three drivers so the log shape is uniform. cp#18 is about
// the PROVISION path, so this is deliberately one test: enough to prove the upgrade path emits the
// same record under its own phase label, not a second full timing suite.
describe("per-step timing on a module upgrade (cp#18)", () => {
  it("emits provision.step under the module_upgrade phase", async () => {
    const store = new MemoryStore();
    const tenant = await seedLiveTenant(store);
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    const d = deps(store, { log: (event, fields) => void logs.push({ event, fields }) });
    const job = await store.createModuleUpgradeJob("job_up", tenant.id, OLD_RELEASE, NEW_RELEASE);

    const out = await upgradeTenantModules(d, job.id, tenant, await contextFor(d, tenant));

    expect(out.ok).toBe(true);
    const steps = logs.filter((l) => l.event === "provision.step");
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) {
      expect(s.fields.phase).toBe("module_upgrade");
      expect(typeof s.fields.stepMs).toBe("number");
      expect(typeof s.fields.elapsedMs).toBe("number");
    }
  });
});
