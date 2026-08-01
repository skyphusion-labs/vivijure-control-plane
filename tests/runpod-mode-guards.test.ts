// The RunPod MODE column and the reconciliation guards it drives (cp#270).
//
// WHAT THESE ARE FOR. Nothing in this change can set a tenant to `shared` -- the branch that does
// arrives separately. These guards land FIRST on purpose: the failure they prevent is a torn-down
// shared tenant making a LIVE production endpoint look like disposable debris, at confidence
// "proven", to a human who then deletes it by hand. That has already happened once on this account
// with hosted-phase1's four endpoints, which is why the guard cannot land after the thing that arms
// it.
//
// HOW THEY ARE WRITTEN, and this is the part to preserve if you edit them. Every exclusion
// assertion is paired with a CONTROL that must still FIRE. An exclusion is a mute button, and a mute
// button that mutes too much is indistinguishable from one that works, from the inside -- a mute on
// a drift detector is worse than the drift. Both guards here were proved by REINTRODUCING the defect
// and watching this file go red; that is how the per-tenant row skip was found to be untested by an
// earlier draft of these fixtures, which always had the pool present in the inventory and therefore
// let the endpoint exclusion carry every assertion.

import { describe, it, expect } from "vitest";
import { readRunPodMode, type SharedRunPodPool } from "../src/runpod-pool";
import { reconcileRunPod, type RunPodInventory, type TenantCensus } from "../src/reconcile-runpod";
import { PROVISION_PLAN } from "../src/runpod";
import type { Tenant, TenantLifecycle } from "../src/store";

/**
 * A pool fixture, hand-built rather than parsed: the parser ships with the provisioning branch, and
 * a guard test that could not run without it would be coupled to a feature it does not exercise.
 */
const pool = (): SharedRunPodPool => {
  const endpoints = PROVISION_PLAN.map((spec, i) => ({
    key: spec.key,
    label: spec.label,
    id: `pool-${i + 1}`,
    name: `vivijure-prod-${spec.key}`,
    endpointVar: spec.endpointVar,
  }));
  return {
    endpoints,
    ids: new Set(endpoints.map((e) => e.id)),
    names: new Set(endpoints.map((e) => e.name)),
  };
};

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
    // DERIVED FROM THE POOL FIXTURE, never restated. Two hand-written lists that must agree is a
    // fixture that silently stops testing what it claims the day one of them is edited -- and the
    // thing under test here is precisely whether the reconciler matches a pool member to an
    // inventory row, so a typo would make every assertion pass against nothing.
    endpoints: pool().endpoints.map((e) => ({ id: e.id, name: e.name })),
    // Templates share the endpoint NAME on this account, which is what the reconciler matches on.
    templates: pool().endpoints.map((e, i) => ({ id: `tpl-${i + 1}`, name: e.name })),
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
