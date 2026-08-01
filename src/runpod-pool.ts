// How a tenant reaches RunPod: the MODE it was provisioned in, and the shape of a SHARED pool (cp#270).
//
// WHY THIS FILE EXISTS AHEAD OF THE FEATURE. Conrad ruled 2026-08-01 that the hosted SHARED tier
// never provisions dedicated per-tenant RunPod endpoints; shared tenants ride the endpoints that
// already exist. This module carries the two things every OTHER file needs in order to be safe when
// that lands: a recorded mode to branch on, and a type for the pool so reconciliation can be told
// which endpoints are the plane's rather than a tenant's.
//
// Nothing here CONSTRUCTS a pool yet. That is deliberate and it is the whole point of landing this
// first: the guards that keep reconciliation and teardown from mistaking shared capacity for tenant
// debris have to exist BEFORE anything can set a tenant to shared. The alternative order -- feature
// first, guards after -- has a window in which a torn-down shared tenant makes a live production
// endpoint look like disposable debris, at confidence "proven", to a human who then deletes it.

import type { TenantEndpoint } from "./provisioner";

/**
 * How a tenant reaches RunPod. Recorded on the tenant row (migration 0018) rather than derived.
 *
 * RECORDED, and this is the design decision the whole cp#270 change rests on. `endpoints_json` used
 * to mean exactly one thing, "the endpoints this tenant OWNS". Pooling gives it a second meaning,
 * "the endpoints this tenant USES", and five readers treat it as ownership: readTenantEndpoints,
 * tenants.ts, reconcile-runpod.ts, tenant-runpod-reprovision.ts, invoke-key-handoff.ts. Overloading
 * one column so its meaning depends on state stored elsewhere is what would make the reconcile and
 * teardown hazards invisible -- every one of those readers keeps compiling, keeps passing its tests,
 * and is quietly wrong for shared tenants.
 */
export type RunPodMode = "dedicated" | "shared";

/**
 * Narrow a stored column value.
 *
 * WHICH DIRECTION THIS FAILS IN IS THE DESIGN, not a default. Anything unrecognised reads as
 * dedicated, because a wrong DEDICATED reading makes teardown and reconcile treat the endpoints as
 * tenant property and therefore do LESS (the referential guard already refuses anything it cannot
 * prove is ours). A wrong SHARED reading would exempt a genuinely dedicated tenant's endpoints from
 * ever being reported as drift, which is the direction that loses information silently. Fail toward
 * doing less.
 */
export const readRunPodMode = (raw: string | null | undefined): RunPodMode =>
  raw === "shared" ? "shared" : "dedicated";

/**
 * The SHARED endpoint pool, as reconciliation needs to see it.
 *
 * TYPE ONLY IN THIS CHANGE. The parser that builds one from deploy config arrives with the
 * provisioning branch that can actually put a tenant on it; landing the shape now is what lets the
 * reconcile guard below take a pool argument and be tested against one before any plane can offer
 * the tier.
 *
 * `ids` and `names` are BOTH carried, and both are needed. The mode column says which tenant ROWS to
 * skip, but pool endpoints must also be recognised in an operator's RunPod INVENTORY, where there is
 * no tenant to consult -- so recognition there keys on the resources themselves.
 */
export interface SharedRunPodPool {
  /** The pool as the provisioner's own endpoint type. Same shape the dedicated path returns. */
  endpoints: TenantEndpoint[];
  /** Every pool endpoint id. Derived once, so no caller re-derives it differently. */
  ids: ReadonlySet<string>;
  /** Every pool endpoint name, for matching against an inventory snapshot. */
  names: ReadonlySet<string>;
}
