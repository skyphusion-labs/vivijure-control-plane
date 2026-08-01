// The SHARED RunPod endpoint pool (cp#270): config parsing, and the reconciliation exclusion.
//
// WHAT THESE PROVE AND WHAT THEY CANNOT. The parse tests are complete: parseSharedPool is pure, so a
// unit test IS the artifact. The reconcile tests are the important half and they are written the
// hard way on purpose -- every exclusion assertion is paired with a CONTROL that must still FIRE.
// An exclusion is a mute button, and a mute button that mutes too much is indistinguishable from one
// that works, from the inside. The controls are what tell those apart.
//
// NOT PROVEN HERE: that a shared tenant renders. That needs a live provision against the real pool
// and is called out in the PR rather than implied by a green suite.

import { describe, it, expect } from "vitest";
import { parseSharedPool, readRunPodMode, requiredPoolKeys } from "../src/runpod-pool";
import { reconcileRunPod, type RunPodInventory, type TenantCensus } from "../src/reconcile-runpod";
import { PROVISION_PLAN } from "../src/runpod";
import type { Tenant, TenantLifecycle } from "../src/store";

const POOL_JSON = JSON.stringify({
  backend: { id: "pool-backend", name: "vivijure-prod-backend" },
  upscale: { id: "pool-upscale", name: "vivijure-prod-upscale" },
  lipsync: { id: "pool-lipsync", name: "vivijure-prod-lipsync" },
  "audio-upscale": { id: "pool-audio", name: "vivijure-prod-audio-upscale" },
});

const pool = () => {
  const parsed = parseSharedPool(POOL_JSON);
  if (!parsed.ok) throw new Error(`fixture pool does not parse: ${parsed.detail}`);
  return parsed.pool;
};

describe("parseSharedPool", () => {
  it("refuses an unset or empty var, so an unconfigured plane offers no shared tier", () => {
    expect(parseSharedPool(undefined).ok).toBe(false);
    expect(parseSharedPool(null).ok).toBe(false);
    // EMPTY MEANS ABSENT: these vars are declared ALLOW_EMPTY in the deploy lists, so an unset knob
    // arrives as "" rather than undefined. A `?? undefined` check would read "" as a pool.
    expect(parseSharedPool("").ok).toBe(false);
    expect(parseSharedPool("   ").ok).toBe(false);
  });

  it("refuses malformed JSON and names the var, because the reader is looking at deploy config", () => {
    const res = parseSharedPool("{not json");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toContain("SHARED_RUNPOD_ENDPOINTS");
  });

  it("refuses a non-object (an array is the likely wrong shape)", () => {
    expect(parseSharedPool("[]").ok).toBe(false);
    expect(parseSharedPool('"a string"').ok).toBe(false);
  });

  it("REFUSES A PARTIAL POOL and names every missing key", () => {
    // The whole point. A pool covering keyframes and not lip sync provisions a tenant that is green
    // through verify and dies at the first finish render, which is the silent-degrade shape.
    const res = parseSharedPool(JSON.stringify({ backend: { id: "a", name: "n" } }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.detail).toContain("upscale");
      expect(res.detail).toContain("lipsync");
      expect(res.detail).toContain("audio-upscale");
    }
  });

  it("refuses an entry missing its NAME, which is what the reconcile exclusion depends on", () => {
    const broken = JSON.parse(POOL_JSON) as Record<string, { id: string; name?: string }>;
    delete broken.lipsync.name;
    const res = parseSharedPool(JSON.stringify(broken));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toContain("lipsync");
  });

  it("refuses a duplicated endpoint id, which is a copy-paste rather than a pool", () => {
    const dup = JSON.parse(POOL_JSON) as Record<string, { id: string; name: string }>;
    dup.lipsync.id = dup.backend.id;
    const res = parseSharedPool(JSON.stringify(dup));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toContain(dup.backend.id);
  });

  it("resolves a complete pool into the SAME shape the dedicated path returns", () => {
    const res = parseSharedPool(POOL_JSON);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // endpointVar and label come from the PLAN, never from the config: which studio var an endpoint
    // id belongs in is a property of the capability, not of who owns the endpoint. That is why both
    // paths can hand the same array to the same two consumers.
    for (const spec of PROVISION_PLAN) {
      const got = res.pool.endpoints.find((e) => e.key === spec.key);
      expect(got, `pool is missing plan key ${spec.key}`).toBeTruthy();
      expect(got!.endpointVar).toBe(spec.endpointVar);
      expect(got!.label).toBe(spec.label);
    }
    expect(res.pool.endpoints).toHaveLength(PROVISION_PLAN.length);
    expect([...res.pool.ids].sort()).toEqual(
      ["pool-audio", "pool-backend", "pool-lipsync", "pool-upscale"],
    );
  });

  it("derives the required keys from the PLAN, so a new satellite makes every pool refuse", () => {
    // Deliberate coupling. Adding a capability to PROVISION_PLAN must break existing pool config
    // loudly rather than produce a shared tier that silently lacks the new capability.
    expect(requiredPoolKeys()).toEqual(PROVISION_PLAN.map((s) => s.key));
  });
});

describe("readRunPodMode", () => {
  it('reads "shared" and treats everything else as dedicated', () => {
    expect(readRunPodMode("shared")).toBe("shared");
    expect(readRunPodMode("dedicated")).toBe("dedicated");
  });

  it("FAILS TOWARD DEDICATED on a null, empty or unrecognised value", () => {
    // Which direction this fails in is the whole design of the function. A wrong DEDICATED reading
    // makes teardown and reconcile treat endpoints as tenant property, which does less; a wrong
    // SHARED reading would exempt a real tenant's endpoints from ever being reported. Do less.
    expect(readRunPodMode(null)).toBe("dedicated");
    expect(readRunPodMode(undefined)).toBe("dedicated");
    expect(readRunPodMode("")).toBe("dedicated");
    expect(readRunPodMode("Shared")).toBe("dedicated");
    expect(readRunPodMode("pooled")).toBe("dedicated");
  });
});

// ---------------------------------------------------------------------------------------------
// Reconciliation. Read the header of this file before changing anything below: every exclusion has
// a control, and the controls are the point.
// ---------------------------------------------------------------------------------------------

function tenantRow(over: Partial<Tenant> & { slug: string; status: TenantLifecycle }): Tenant {
  return {
    id: `ten_${over.slug.replace(/[^a-z0-9]/g, "")}`,
    account_id: "acct_1",
    script_name: null,
    d1_database_id: null,
    r2_bucket_name: null,
    endpoints_json: null,
    r2_token_id: null,
    studio_release: null,
    modules_release: null,
    studio_token_enc: null,
    created_at: "2026-08-01T00:00:00Z",
    live_at: null,
    suspended_at: null,
    suspended_reason: null,
    deleted_at: null,
    api_token_rotated_at: null,
    teardown_at: null,
    teardown_failures: null,
    reclaim_lease_until: null,
    reclaim_lease_token: null,
    video_finish_unreachable: 0,
    video_finish_unreachable_reason: null,
    video_finish_unreachable_at: null,
    r2_storage_quota_override: null,
    r2_storage_quota_bytes: null,
    runpod_mode: "dedicated",
    ...over,
  } as Tenant;
}

/** A tenant row recording the POOL, exactly as the provisioner writes it for a shared tenant. */
const poolEndpointsJson = () => JSON.stringify(pool().endpoints);

/** The operator inventory: the production account, carrying the pool. */
function inventory(over: Partial<RunPodInventory> = {}): RunPodInventory {
  return {
    account_label: "prod",
    read_at: "2026-08-01T12:00:00Z",
    complete: true,
    endpoints: [
      { id: "pool-backend", name: "vivijure-prod-backend" },
      { id: "pool-upscale", name: "vivijure-prod-upscale" },
      { id: "pool-lipsync", name: "vivijure-prod-lipsync" },
      { id: "pool-audio", name: "vivijure-prod-audio-upscale" },
    ],
    templates: [
      { id: "tpl-backend", name: "vivijure-prod-backend" },
      { id: "tpl-upscale", name: "vivijure-prod-upscale" },
      { id: "tpl-lipsync", name: "vivijure-prod-lipsync" },
      { id: "tpl-audio", name: "vivijure-prod-audio-upscale" },
    ],
    ...over,
  };
}

const census = (tenants: Tenant[]): TenantCensus => ({ tenants, complete: true });

describe("reconcileRunPod with a shared pool", () => {
  it("does NOT report the pool as orphaned debris when a shared tenant is torn down", async () => {
    // THE DEFECT THIS CLOSES, in one case. A deleted shared tenant's row names production endpoints.
    // Without the exclusion the orphan loop emits every one of them at confidence "proven", worded
    // "endpoint survives after tenant X was torn down" -- and a human acts on a proven finding.
    const deleted = tenantRow({
      slug: "gone",
      status: "deleted",
      runpod_mode: "shared",
      endpoints_json: poolEndpointsJson(),
    });
    const report = reconcileRunPod(census([deleted]), inventory(), pool());

    expect(report.findings.filter((f) => f.kind === "orphan_endpoint")).toEqual([]);
    expect(report.findings.filter((f) => f.kind === "orphan_template")).toEqual([]);
    // And not merely reclassified as "we cannot attribute this": the pool IS attributed, to us.
    expect(report.unattributed.endpoints).toEqual([]);
    expect(report.unattributed.templates).toEqual([]);
    expect(report.verdict).toBe("clean");
  });

  it("CONTROL: the same row read as DEDICATED still reports the endpoints as orphans", () => {
    // This is the control that makes the test above mean something. Same row, same inventory, same
    // pool argument -- only runpod_mode differs. If this ever goes quiet, the exclusion has stopped
    // being keyed on the mode and has become a blanket mute over the pool ids, and the test above
    // would keep passing while reconciliation stopped reporting real drift.
    const deleted = tenantRow({
      slug: "gone",
      status: "deleted",
      runpod_mode: "dedicated",
      endpoints_json: poolEndpointsJson(),
    });
    // NO pool passed, which is the pre-cp#270 caller. A dedicated row naming these ids is drift.
    const report = reconcileRunPod(census([deleted]), inventory());
    const orphans = report.findings.filter((f) => f.kind === "orphan_endpoint");
    expect(orphans.length).toBeGreaterThan(0);
    expect(orphans.every((f) => f.confidence === "proven")).toBe(true);
  });

  it("CONTROL: a real dedicated tenant's leftovers are STILL reported while a pool is configured", () => {
    // The second direction the exclusion could be wrong in: muting everything once a pool exists.
    // A torn-down DEDICATED tenant whose own endpoints survive is exactly the finding cp#137 exists
    // to produce, and passing a pool must not suppress it.
    const own = [
      { key: "backend", label: "Render", id: "own-1", name: "vivijure-oldtenant-backend", endpointVar: "RUNPOD_ENDPOINT_ID" },
    ];
    const deleted = tenantRow({
      slug: "oldtenant",
      status: "deleted",
      runpod_mode: "dedicated",
      endpoints_json: JSON.stringify(own),
    });
    const inv = inventory({
      endpoints: [...inventory().endpoints, { id: "own-1", name: "vivijure-oldtenant-backend" }],
    });
    const report = reconcileRunPod(census([deleted]), inv, pool());

    const orphans = report.findings.filter((f) => f.kind === "orphan_endpoint");
    expect(orphans).toHaveLength(1);
    expect(orphans[0].resource_id).toBe("own-1");
    expect(orphans[0].tenant_slug).toBe("oldtenant");
    // And the pool, in the same report, is still untouched.
    expect(orphans.some((f) => f.resource_id?.startsWith("pool-"))).toBe(false);
  });

  it("survives the MAP COLLISION: many shared tenants naming one pool endpoint, one of them deleted", () => {
    // The precise mechanism from the enumeration. claimedEndpointIds is keyed by endpoint id, so N
    // shared tenants collapse to ONE claimant, last-write-wins in census order. Put the DELETED row
    // last so it is the survivor -- the single arrangement that produced the false orphan.
    const live1 = tenantRow({ slug: "live-one", status: "live", runpod_mode: "shared", endpoints_json: poolEndpointsJson() });
    const live2 = tenantRow({ slug: "live-two", status: "live", runpod_mode: "shared", endpoints_json: poolEndpointsJson() });
    const dead = tenantRow({ slug: "dead-one", status: "deleted", runpod_mode: "shared", endpoints_json: poolEndpointsJson() });

    const report = reconcileRunPod(census([live1, live2, dead]), inventory(), pool());
    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe("clean");
  });

  it("gives every shared tenant a VERDICT ROW rather than dropping it from the report", () => {
    // An absent row reads as a tenant nobody looked at, which is the failure mode this whole file is
    // built against. Skipping the ownership checks must not mean skipping the tenant.
    const shared = tenantRow({ slug: "rider", status: "live", runpod_mode: "shared", endpoints_json: poolEndpointsJson() });
    const report = reconcileRunPod(census([shared]), inventory(), pool());

    expect(report.tenants).toHaveLength(1);
    expect(report.tenants[0]).toMatchObject({ slug: "rider", findings: 0, verdict: "clean" });
    expect(report.tenants[0].endpoints_recorded).toBe(PROVISION_PLAN.length);
  });

  it("does not invent ownership by NAME for a shared tenant", () => {
    // owningTenantByName answers "who would OWN an endpoint of this name". A pooled tenant owns
    // none, so an endpoint coincidentally named for its slug is NOT its debris -- claiming it would
    // attribute someone else's resource to a tenant that could not have created it.
    const shared = tenantRow({ slug: "rider", status: "deleted", runpod_mode: "shared", endpoints_json: poolEndpointsJson() });
    const inv = inventory({
      endpoints: [...inventory().endpoints, { id: "stray-1", name: "vivijure-rider-backend" }],
    });
    const report = reconcileRunPod(census([shared]), inv, pool());

    expect(report.findings.filter((f) => f.kind === "orphan_endpoint")).toEqual([]);
    // It is reported, but as UNATTRIBUTED: we can see it and we refuse to say whose it is. That is
    // the honest answer and it is deliberately not the same as calling it disposable.
    expect(report.unattributed.endpoints).toEqual([{ id: "stray-1", name: "vivijure-rider-backend" }]);
  });

  it("reports NO per-tenant drift for a shared tenant when the snapshot does not contain the pool", () => {
    // THIS is what the per-tenant row skip is for, and it took reintroducing the defect to find out:
    // with the pool present in the inventory, the skip is redundant because the endpoint and
    // template exclusions already carry every assertion. It only becomes load-bearing when the
    // snapshot does NOT contain the pool -- an operator reading a different account, or a snapshot
    // taken before the pool existed.
    //
    // Without the skip, every shared tenant emits record_endpoint_missing AND
    // record_template_missing on every pass, forever. Not a false alarm about production this time,
    // but the other failure: permanent noise that buries the real drift this file exists to surface.
    const shared = tenantRow({
      slug: "rider",
      status: "live",
      runpod_mode: "shared",
      endpoints_json: poolEndpointsJson(),
    });
    const elsewhere = inventory({ endpoints: [], templates: [] });
    const report = reconcileRunPod(census([shared]), elsewhere, pool());

    expect(report.findings).toEqual([]);
    expect(report.tenants[0]).toMatchObject({ slug: "rider", findings: 0 });
  });

  it("CONTROL: a DEDICATED tenant in that same situation still reports its missing endpoints", () => {
    // The control that stops the test above from passing because reconciliation went blind. Same
    // empty snapshot, same pool argument, one recorded endpoint -- a dedicated tenant naming an
    // endpoint the account does not have is the original cp#137 finding and must still fire.
    const dedicated = tenantRow({
      slug: "owner",
      status: "live",
      runpod_mode: "dedicated",
      endpoints_json: JSON.stringify([
        { key: "backend", label: "Render", id: "own-1", name: "vivijure-owner-backend", endpointVar: "RUNPOD_ENDPOINT_ID" },
      ]),
    });
    const elsewhere = inventory({ endpoints: [], templates: [] });
    const report = reconcileRunPod(census([dedicated]), elsewhere, pool());

    expect(report.findings.map((f) => f.kind).sort()).toEqual([
      "record_endpoint_missing",
      "record_template_missing",
    ]);
    expect(report.verdict).toBe("drift");
  });

  it("CONTROL: omitting the pool argument reconciles exactly as it did before pooling existed", () => {
    // Every existing caller passes two arguments. If the third being optional changed any behaviour
    // for a plane with no shared tier, that would be a regression hiding inside a feature.
    const deleted = tenantRow({
      slug: "oldtenant",
      status: "deleted",
      runpod_mode: "dedicated",
      endpoints_json: JSON.stringify([
        { key: "backend", label: "Render", id: "own-1", name: "vivijure-oldtenant-backend", endpointVar: "RUNPOD_ENDPOINT_ID" },
      ]),
    });
    const inv = inventory({ endpoints: [{ id: "own-1", name: "vivijure-oldtenant-backend" }], templates: [] });

    const withUndefined = reconcileRunPod(census([deleted]), inv, undefined);
    const withNothing = reconcileRunPod(census([deleted]), inv);
    expect(withUndefined).toEqual(withNothing);
    expect(withNothing.findings.filter((f) => f.kind === "orphan_endpoint")).toHaveLength(1);
  });
});
