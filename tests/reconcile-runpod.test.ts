// RunPod reconciliation (cp#137): the drift detector, driven from both ends.
//
// Bias, same as routes.test.ts: every guard is watched REFUSING before it is trusted, and each
// refusal sits next to a positive control, because "everything reports drift" is as broken as
// "everything reports clean" and a suite without controls cannot tell them apart.
//
// The two controls that matter most here:
//   1. A CONSISTENT tenant must report clean. Without it, a detector that flags everything passes.
//   2. The ENDPOINTS-ALREADY-DELETED fixture (the cp#117 shape: zero endpoints left, four templates
//      still there) must still report drift. An implementation that enumerated endpoints only would
//      go green on it, which is exactly the half-done cleanup that reads as complete.
//
// And the read-only claim is asserted the only way it can be honestly asserted: a proxy that records
// every store call, so the test proves no mutator was ever CALLED, not that the state looked the
// same afterwards. A point-in-time read cannot see a write-then-restore. The proxy carries its own
// control: a route that does write must be seen writing through the same proxy.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { handle } from "../src/index";
import type { ControlPlaneDeps } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import { MemoryStore } from "./memory-store";
import type { ControlPlaneStore, Tenant, TenantLifecycle } from "../src/store";
import {
  MAX_INVENTORY_RESOURCES,
  TENANT_PAGE_LIMIT,
  listWasWhole,
  parseInventoryBody,
  reconcileRunPod,
  type RunPodInventory,
  type TenantCensus,
} from "../src/reconcile-runpod";

const ROOT_HOST = "studio.vivijure.com";
const ORIGIN = `https://${ROOT_HOST}`;
const ADMIN_TOKEN = "a".repeat(64);
const READ_AT = "2026-07-26T12:00:00.000Z";

const KEYS = ["backend", "upscale", "lipsync", "audio-upscale"] as const;

/** Endpoint ids in the shape RunPod issues, distinct per tenant so a mix-up cannot pass. */
const idFor = (slug: string, key: string) => `ep-${slug}-${key}`;
const templateIdFor = (slug: string, key: string) => `tpl-${slug}-${key}`;
const nameFor = (slug: string, key: string) => `vivijure-${slug}-${key}`;

function recordedEndpoints(slug: string) {
  return KEYS.map((key) => ({
    key,
    label: key,
    id: idFor(slug, key),
    name: nameFor(slug, key),
    endpointVar: `${key.toUpperCase()}_RUNPOD_ENDPOINT_ID`,
  }));
}

function tenantRow(
  slug: string,
  status: TenantLifecycle,
  endpointsJson: string | null,
  /** cp#270. DEFAULTS TO dedicated so every existing case is unchanged and still exercises the
   *  ownership path; the pooled cases pass "shared" explicitly. */
  runpodMode: string = "dedicated",
): Tenant {
  return {
    id: `ten_${slug.replace(/[^a-z0-9]/g, "")}`,
    slug,
    account_id: "acct_1",
    status,
    runpod_mode: runpodMode,
    script_name: `tenant-${slug}-studio`,
    d1_database_id: "db",
    r2_bucket_name: "bucket",
    endpoints_json: endpointsJson,
    r2_token_id: "tok",
    studio_release: "v1.9.0",
    modules_release: "v1.9.0",
    studio_token_enc: null,
    created_at: "2026-07-01T00:00:00.000Z",
    live_at: status === "live" ? "2026-07-01T00:00:00.000Z" : null,
    suspended_at: null,
    suspended_reason: null,
    deleted_at: status === "deleted" ? "2026-07-20T00:00:00.000Z" : null,
    api_token_rotated_at: null,
    // cp#136 columns, present because the row type requires them: a fixture that omits a NOT NULL
    // column is a row the real store cannot return.
    video_finish_unreachable: 0,
    video_finish_unreachable_reason: null,
    video_finish_unreachable_at: null,
  r2_storage_quota_override: null,
  r2_storage_quota_bytes: null,
    teardown_at: status === "deleted" ? "2026-07-20T00:00:00.000Z" : null,
    teardown_failures: status === "deleted" ? "[]" : null,
    reclaim_lease_until: null,
    reclaim_lease_token: null,
  };
}

const liveTenant = (slug = "hero") => tenantRow(slug, "live", JSON.stringify(recordedEndpoints(slug)));

const inventoryFor = (
  slugs: string[],
  over: Partial<RunPodInventory> = {},
): RunPodInventory => ({
  account_label: "prod",
  read_at: READ_AT,
  complete: true,
  endpoints: slugs.flatMap((slug) =>
    KEYS.map((key) => ({ id: idFor(slug, key), name: nameFor(slug, key) })),
  ),
  templates: slugs.flatMap((slug) =>
    KEYS.map((key) => ({ id: templateIdFor(slug, key), name: nameFor(slug, key) })),
  ),
  ...over,
});

const census = (tenants: Tenant[], complete = true): TenantCensus => ({ tenants, complete });

describe("reconcileRunPod: the positive control", () => {
  it("a consistent tenant reports CLEAN with zero findings", () => {
    const tenant = liveTenant();
    const report = reconcileRunPod(census([tenant]), inventoryFor(["hero"]));

    expect(report.verdict).toBe("clean");
    expect(report.findings).toEqual([]);
    expect(report.tenants).toEqual([
      {
        tenant_id: tenant.id,
        slug: "hero",
        status: "live",
        endpoints_recorded: 4,
        endpoints_present: 4,
        templates_present: 4,
        findings: 0,
        verdict: "clean",
      },
    ]);
    expect(report.writes).toBe("none");
    expect(report.census).toMatchObject({ tenants: 1, endpoints: 4, templates: 4, inventory_complete: true });
  });

  it("reports the account and the read time it was given, so a saved report is dateable", () => {
    const report = reconcileRunPod(census([liveTenant()]), inventoryFor(["hero"], { account_label: "scratch" }));
    expect(report.account_label).toBe("scratch");
    expect(report.read_at).toBe(READ_AT);
  });
});

describe("reconcileRunPod: layer 1, the record points at endpoints that are gone (the cp#137 case)", () => {
  it("names every missing endpoint, its key and its id, and calls the tenant drifted", () => {
    // The live shape from cp#137: the row survived a debris sweep that took its endpoints.
    const tenant = liveTenant("rollins-e2e");
    const report = reconcileRunPod(census([tenant]), inventoryFor([]));

    const missing = report.findings.filter((f) => f.kind === "record_endpoint_missing");
    expect(missing).toHaveLength(4);
    expect(missing.map((f) => f.resource_id).sort()).toEqual(
      KEYS.map((k) => idFor("rollins-e2e", k)).sort(),
    );
    expect(missing.every((f) => f.confidence === "proven")).toBe(true);
    expect(missing.every((f) => f.tenant_slug === "rollins-e2e" && f.layer === "endpoint")).toBe(true);
    expect(report.verdict).toBe("drift");
    expect(report.tenants[0]).toMatchObject({ endpoints_recorded: 4, endpoints_present: 0, verdict: "drift" });
  });

  it("an endpoint that exists under another NAME is drift, not a pass: provisioning adopts by name", () => {
    const tenant = liveTenant();
    const inventory = inventoryFor(["hero"]);
    inventory.endpoints[0] = { id: idFor("hero", "backend"), name: "vivijure-somebody-else-backend" };

    const report = reconcileRunPod(census([tenant]), inventory);
    const renamed = report.findings.filter((f) => f.kind === "record_endpoint_renamed");
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({
      resource_id: idFor("hero", "backend"),
      resource_name: "vivijure-somebody-else-backend",
      confidence: "proven",
    });
  });

  it("a record that cannot be parsed is reported, never skipped as if it were consistent", () => {
    const broken = tenantRow("broken", "live", "{not json");
    const report = reconcileRunPod(census([broken]), inventoryFor([]));
    expect(report.findings.map((f) => f.kind)).toEqual(["record_unreadable"]);
    expect(report.tenants[0].verdict).toBe("drift");
  });
});

describe("reconcileRunPod: layer 2, the templates underneath", () => {
  it("a live endpoint whose TEMPLATE is gone is drift (a re-provision would refuse with 409)", () => {
    const tenant = liveTenant();
    const inventory = inventoryFor(["hero"]);
    inventory.templates = inventory.templates.filter((t) => t.name !== nameFor("hero", "lipsync"));

    const report = reconcileRunPod(census([tenant]), inventory);
    const missing = report.findings.filter((f) => f.kind === "record_template_missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      layer: "template",
      resource_name: nameFor("hero", "lipsync"),
      endpoint_key: "lipsync",
      confidence: "proven",
    });
    expect(report.tenants[0].templates_present).toBe(3);
  });

  it("THE CONTROL THAT CATCHES AN ENDPOINT-ONLY DETECTOR: endpoints already deleted, templates left", () => {
    // The cp#117 debris shape. Four endpoints were deleted by hand and four templates survived
    // underneath them. Enumerating endpoints alone returns nothing here and reads as complete.
    const torn = tenantRow("cp117-rehearsal", "deleted", JSON.stringify(recordedEndpoints("cp117-rehearsal")));
    const inventory = inventoryFor(["cp117-rehearsal"], { endpoints: [] });

    const report = reconcileRunPod(census([torn]), inventory);
    const orphanTemplates = report.findings.filter((f) => f.kind === "orphan_template");
    expect(orphanTemplates).toHaveLength(4);
    expect(orphanTemplates.every((f) => f.confidence === "proven" && f.layer === "template")).toBe(true);
    expect(orphanTemplates.every((f) => f.tenant_slug === "cp117-rehearsal")).toBe(true);
    expect(report.verdict).toBe("drift");
  });

  it("orphaned ENDPOINTS of a torn-down tenant are reported, and the finding warns the template stays", () => {
    const torn = tenantRow("cp117-rehearsal", "deleted", JSON.stringify(recordedEndpoints("cp117-rehearsal")));
    const report = reconcileRunPod(census([torn]), inventoryFor(["cp117-rehearsal"]));

    const orphanEndpoints = report.findings.filter((f) => f.kind === "orphan_endpoint");
    expect(orphanEndpoints).toHaveLength(4);
    expect(orphanEndpoints.every((f) => f.confidence === "proven")).toBe(true);
    expect(orphanEndpoints[0].detail).toContain("TEMPLATE");
    // Both layers in one pass: the templates are orphaned too, and both are named.
    expect(report.findings.filter((f) => f.kind === "orphan_template")).toHaveLength(4);
  });

  it("a torn-down record does NOT produce missing-endpoint noise: its resources being gone is correct", () => {
    const torn = tenantRow("gone", "deleted", JSON.stringify(recordedEndpoints("gone")));
    const report = reconcileRunPod(census([torn]), inventoryFor([]));
    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe("clean");
  });

  it("a template for a tenant that never recorded an endpoint is named as a half-built provision", () => {
    const halfBuilt = tenantRow("halfbuilt", "provisioning", null);
    const inventory = inventoryFor([], {
      templates: [{ id: templateIdFor("halfbuilt", "backend"), name: nameFor("halfbuilt", "backend") }],
    });
    const report = reconcileRunPod(census([halfBuilt]), inventory);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ kind: "orphan_template", tenant_slug: "halfbuilt" });
    expect(report.findings[0].detail).toContain("died between the template and the endpoint");
  });
});

describe("reconcileRunPod: ownership is never assumed", () => {
  it("resources it cannot trace to a known slug are listed as unattributed, never as orphans", () => {
    const tenant = liveTenant();
    const inventory = inventoryFor(["hero"]);
    inventory.endpoints.push({ id: "t9wcvlxh8rc5la", name: "vivijure-backend-freefloor" });
    inventory.templates.push({ id: "tpl-house", name: "vivijure-backend-freefloor" });

    const report = reconcileRunPod(census([tenant]), inventory);
    expect(report.findings).toEqual([]);
    expect(report.unattributed.endpoints).toEqual([{ id: "t9wcvlxh8rc5la", name: "vivijure-backend-freefloor" }]);
    expect(report.unattributed.templates).toEqual([{ id: "tpl-house", name: "vivijure-backend-freefloor" }]);
    // Unattributed is information, not drift: a clean tenant next to house resources stays clean.
    expect(report.verdict).toBe("clean");
  });

  it("an endpoint NAMED for a live tenant that its record does not claim is drift, not disposable", () => {
    const tenant = liveTenant();
    const inventory = inventoryFor(["hero"]);
    inventory.endpoints.push({ id: "ep-stray", name: nameFor("hero", "backend") });

    const report = reconcileRunPod(census([tenant]), inventory);
    const stray = report.findings.filter((f) => f.resource_id === "ep-stray");
    expect(stray).toHaveLength(1);
    expect(stray[0]).toMatchObject({ kind: "orphan_endpoint", tenant_slug: "hero", confidence: "proven" });
    expect(stray[0].detail).toContain("do not assume it is disposable");
  });
});

describe("reconcileRunPod: an incomplete census never reads as a clean one", () => {
  it("absence findings drop to unproven when the RunPod list was not proven whole", () => {
    const report = reconcileRunPod(census([liveTenant()]), inventoryFor([], { complete: false }));
    const missing = report.findings.filter((f) => f.kind === "record_endpoint_missing");
    expect(missing).toHaveLength(4);
    expect(missing.every((f) => f.confidence === "unproven")).toBe(true);
    expect(missing.every((f) => f.unproven_reason === "inventory_incomplete")).toBe(true);
    // The whole report refuses to call this drift: it is a report that could not be performed.
    expect(report.verdict).toBe("unproven");
  });

  it("orphan findings drop to unproven when the TENANT census may have been truncated", () => {
    const torn = tenantRow("cp117-rehearsal", "deleted", null);
    const report = reconcileRunPod(census([torn], false), inventoryFor(["cp117-rehearsal"]));
    const orphans = report.findings.filter((f) => f.kind === "orphan_endpoint" || f.kind === "orphan_template");
    expect(orphans).toHaveLength(8);
    expect(orphans.every((f) => f.confidence === "unproven")).toBe(true);
    expect(orphans.every((f) => f.unproven_reason === "tenant_census_incomplete")).toBe(true);
    expect(report.verdict).toBe("unproven");
  });

  it("zero findings plus an incomplete census is UNPROVEN, not clean", () => {
    const report = reconcileRunPod(census([liveTenant()], false), inventoryFor(["hero"], { complete: false }));
    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe("unproven");
    expect(report.tenants[0].verdict).toBe("unproven");
  });

  it("a torn-down claimant is proof on its own, even when the tenant census was truncated", () => {
    // The claim "this endpoint belongs to a dead tenant" rests on a row we HAVE read, so truncation
    // elsewhere cannot weaken it. Without this the truncation guard would swallow real evidence.
    const torn = tenantRow("cp117-rehearsal", "deleted", JSON.stringify(recordedEndpoints("cp117-rehearsal")));
    const report = reconcileRunPod(census([torn], false), inventoryFor(["cp117-rehearsal"], { templates: [] }));
    const orphans = report.findings.filter((f) => f.kind === "orphan_endpoint");
    expect(orphans).toHaveLength(4);
    expect(orphans.every((f) => f.confidence === "proven")).toBe(true);
    expect(report.verdict).toBe("drift");
  });
});

describe("parseInventoryBody", () => {
  const good = { account_label: "prod", read_at: READ_AT, complete: true, endpoints: [], templates: [] };

  it("accepts a well-formed snapshot (the control for the refusals below)", () => {
    const parsed = parseInventoryBody(good);
    expect(parsed.ok).toBe(true);
  });

  it("REFUSES a snapshot that does not state whether it was complete", () => {
    const { complete, ...withoutComplete } = good;
    expect(complete).toBe(true);
    const parsed = parseInventoryBody(withoutComplete);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.detail).toContain("false absence");
  });

  it("refuses a missing account label, a missing read time, and non-object bodies", () => {
    expect(parseInventoryBody({ ...good, account_label: "  " }).ok).toBe(false);
    expect(parseInventoryBody({ ...good, read_at: "" }).ok).toBe(false);
    expect(parseInventoryBody(null).ok).toBe(false);
    expect(parseInventoryBody("prod").ok).toBe(false);
  });

  it("refuses resource entries that are not id plus name, and oversized inventories", () => {
    expect(parseInventoryBody({ ...good, endpoints: [{ id: "e" }] }).ok).toBe(false);
    expect(parseInventoryBody({ ...good, templates: "all of them" }).ok).toBe(false);
    const huge = Array.from({ length: MAX_INVENTORY_RESOURCES + 1 }, (_, i) => ({ id: `e${i}`, name: `n${i}` }));
    expect(parseInventoryBody({ ...good, endpoints: huge }).ok).toBe(false);
  });
});

describe("listWasWhole: a page that might be truncated is never called whole", () => {
  it("accepts a bare array and a wrapped array with no cursor (the controls)", () => {
    expect(listWasWhole([{ id: "e", name: "n" }])).toBe(true);
    expect(listWasWhole([])).toBe(true);
    expect(listWasWhole({ endpoints: [] })).toBe(true);
    expect(listWasWhole({ data: [] })).toBe(true);
  });

  it("refuses a payload carrying a pagination cursor, and any shape it cannot read", () => {
    expect(listWasWhole({ endpoints: [], next: "abc" })).toBe(false);
    expect(listWasWhole({ endpoints: [], nextCursor: "abc" })).toBe(false);
    expect(listWasWhole({ templates: [], pagination: { next: "x" } })).toBe(false);
    expect(listWasWhole(null)).toBe(false);
    expect(listWasWhole("endpoints")).toBe(false);
    expect(listWasWhole({ things: [] })).toBe(false);
  });
});

// ---- the route: read-only, admin-gated, and proven to write nothing ---------------------------

/** Every store method the plane can use to CHANGE something. A reconcile pass may call none. */
const MUTATORS = new Set([
  "createAccount", "linkIdentity", "createLoginToken", "consumeLoginToken", "createSession",
  "deleteSession", "createOAuthState", "consumeOAuthState", "createTenant", "setTenantStatus",
  "suspendTenant", "resumeTenant", "setTenantD1", "setTenantBucket", "setTenantR2Token",
  "setTenantEndpoints", "setTenantScript", "setTenantStudioRelease", "setTenantModulesRelease",
  "setTenantStudioToken", "setTenantDeleted", "renameTenantSlug", "reclaimSlug", "claimReclaim",
  "releaseReclaim", "recordTeardown", "createProvisionJob", "updateProvisionJob", "setSetting",
  "recordAdminAction", "openPreservationHold", "releasePreservationHold", "recordSmokeRender",
  "acceptAup", "deleteAccount",
]);

interface CallLog {
  calls: string[];
  mutations: string[];
}

/**
 * A recording proxy over the store. It asserts what was CALLED, not what the state looked like
 * afterwards: a point-in-time read cannot see a write that was undone, so "we never write" has to be
 * proven at the call, not at the row.
 */
function recordingStore(inner: ControlPlaneStore): { store: ControlPlaneStore; log: CallLog } {
  const log: CallLog = { calls: [], mutations: [] };
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: unknown[]) => {
        log.calls.push(prop);
        if (MUTATORS.has(prop)) log.mutations.push(prop);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as ControlPlaneStore;
  return { store, log };
}

const env = (over: Partial<ControlPlaneEnv> = {}): ControlPlaneEnv =>
  ({
    ASSETS: { fetch: async () => new Response("ui", { status: 200 }) } as unknown as Fetcher,
    CP_DB: {} as D1Database,
    AUP_VERSION: "2026-07-17",
    AUP_URL: `${ORIGIN}/aup`,
    CONTROL_PLANE_HOST: ROOT_HOST,
    CONTROL_PLANE_ADMIN_TOKEN: ADMIN_TOKEN,
    CP_RATE_LIMIT: { limit: async () => ({ success: true }) },
    ...over,
  }) as ControlPlaneEnv;

const ctx = {
  waitUntil: () => {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

describe("POST /api/admin/reconcile/runpod", () => {
  let memory: MemoryStore;
  let log: CallLog;
  let deps: ControlPlaneDeps;

  const post = (body: unknown, token: string | null = ADMIN_TOKEN) =>
    handle(
      new Request(`${ORIGIN}/api/admin/reconcile/runpod`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      }),
      env(),
      ctx,
      deps,
    );

  const snapshot = (over: Record<string, unknown> = {}) => ({
    account_label: "prod",
    read_at: READ_AT,
    complete: true,
    endpoints: [] as { id: string; name: string }[],
    templates: [] as { id: string; name: string }[],
    ...over,
  });

  beforeEach(async () => {
    memory = new MemoryStore();
    const recorded = recordingStore(memory);
    log = recorded.log;
    deps = {
      store: recorded.store,
      mailer: { send: async () => {} },
      fetch: vi.fn() as unknown as typeof fetch,
      now: () => 1_750_000_000_000,
    };
  });

  const seedTenant = async (slug: string, status: TenantLifecycle) => {
    await memory.createAccount("acct_1", "a@b.com");
    const t = await memory.createTenant(`ten_${slug.replace(/[^a-z0-9]/g, "")}`, slug, "acct_1", "pending");
    await memory.setTenantEndpoints(t.id, JSON.stringify(recordedEndpoints(slug)));
    await memory.setTenantStatus(t.id, status);
    log.calls.length = 0;
    log.mutations.length = 0;
    return t;
  };

  it("refuses without the admin token (the gate is watched refusing before anything else is trusted)", async () => {
    const res = await post(snapshot(), null);
    expect(res.status).toBe(401);
    expect(log.calls).toEqual([]);
  });

  it("refuses a snapshot that never said whether it was complete, and accepts the same body with it", async () => {
    const { complete, ...withoutComplete } = snapshot();
    expect(complete).toBe(true);
    const refused = await post(withoutComplete);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_inventory" });

    const accepted = await post(snapshot());
    expect(accepted.status).toBe(200);
  });

  it("reports the cp#137 drift end to end: a live record pointing at endpoints RunPod does not have", async () => {
    await seedTenant("rollins-e2e", "live");
    const res = await post(snapshot());
    expect(res.status).toBe(200);

    const body = (await res.json()) as { report: ReturnType<typeof reconcileRunPod> };
    expect(body.report.verdict).toBe("drift");
    expect(body.report.findings.filter((f) => f.kind === "record_endpoint_missing")).toHaveLength(4);
    expect(body.report.tenants[0]).toMatchObject({ slug: "rollins-e2e", endpoints_present: 0 });
    expect(body.report.writes).toBe("none");
  });

  it("WRITES NOTHING: no store mutator is ever called, and the recorder is proven to work", async () => {
    await seedTenant("rollins-e2e", "live");
    const res = await post(
      snapshot({
        endpoints: [{ id: "ep-stray", name: "vivijure-rollins-e2e-backend" }],
        templates: [{ id: "tpl-stray", name: "vivijure-rollins-e2e-backend" }],
      }),
    );
    expect(res.status).toBe(200);

    // The claim.
    expect(log.mutations).toEqual([]);
    // CONTROL 1: the proxy really did observe this request (an inert proxy would also show zero).
    expect(log.calls).toContain("listTenants");
    // CONTROL 2: the proxy records a mutation when one happens, through the same seam.
    await deps.store.setSetting("signups_enabled", "false", "admin-token");
    expect(log.mutations).toEqual(["setSetting"]);
  });

  it("marks the tenant census incomplete when the store returned a full page", async () => {
    await memory.createAccount("acct_1", "a@b.com");
    for (let i = 0; i < TENANT_PAGE_LIMIT; i += 1) {
      await memory.createTenant(`ten_page${i}`, `page${i}`, "acct_1", "pending");
    }
    const res = await post(snapshot());
    const body = (await res.json()) as { report: ReturnType<typeof reconcileRunPod> };
    expect(body.report.census).toMatchObject({ tenants: TENANT_PAGE_LIMIT, tenants_complete: false });
    expect(body.report.verdict).toBe("unproven");
  });

  it("marks the tenant census complete when the store returned less than a full page", async () => {
    await seedTenant("hero", "live");
    const res = await post(
      snapshot({
        endpoints: KEYS.map((k) => ({ id: idFor("hero", k), name: nameFor("hero", k) })),
        templates: KEYS.map((k) => ({ id: templateIdFor("hero", k), name: nameFor("hero", k) })),
      }),
    );
    const body = (await res.json()) as { report: ReturnType<typeof reconcileRunPod> };
    expect(body.report.census.tenants_complete).toBe(true);
    expect(body.report.verdict).toBe("clean");
  });
});
