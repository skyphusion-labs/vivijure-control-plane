// The routing seam (#52/#55), and the status mapping ruled at integration.
//
// Strummer's dispatcher (src/control-plane/routing.ts, #55) asks exactly one question and knows
// nothing about D1, sessions, or accounts. This is the only thing that answers it.
//
// WHY THE MAPPING IS NARROWER THAN THE LIFECYCLE (the ruling): the control-plane table carries the
// full 7-state lifecycle, which is canonical because it is the one backed by real rows. Routing
// does not want that vocabulary; it wants "may I serve this?". So this PROJECTS the lifecycle down
// to routing's four values, and it projects FAIL-CLOSED: anything not positively routable becomes
// "unknown", never a default that serves. A new lifecycle state added later is therefore
// unroutable until someone deliberately makes it routable, which is the correct direction for a
// mistake to fall.

import type { Tenant, ControlPlaneStore } from "./store";

/** Routing's narrow view. Structurally identical to routing.ts's TenantStatus (#55). */
export type RoutingStatus = "live" | "suspended" | "provisioning" | "unknown";

export interface RoutingTenantRecord {
  slug: string;
  status: RoutingStatus;
  /** Authoritative at route time; written by the provisioner via the shared tenantScriptName(). */
  script_name: string;
}

export interface TenantResolver {
  resolve(slug: string): Promise<RoutingTenantRecord | null>;
}

/**
 * Project a tenant row onto routing's status.
 *
 * Suspension wins over everything: it is the admin kill switch, and it is checked FIRST so a
 * suspended tenant can never present as routable regardless of its lifecycle. (This is exactly why
 * suspension is a separate column: when it lived in `status`, a resumed tenant guessed its way back
 * to "live" and a never-provisioned tenant became routable. Caught on a real D1 in the #52 verify.)
 */
export function routingStatusFor(tenant: Tenant): RoutingStatus {
  if (tenant.suspended_at !== null) return "suspended";
  switch (tenant.status) {
    case "live":
      return "live";
    case "provisioning":
      return "provisioning";
    // pending | awaiting_invoke_key | failed | deleting | deleted are all NOT routable.
    // awaiting_invoke_key is the interesting one: the tenant's worker exists and would happily
    // serve, but it cannot render without key B, and key B is pasted on the control-plane front
    // door, not on the tenant studio. Serving a studio that cannot render is not honest, so it
    // stays dark until it is genuinely live.
    default:
      return "unknown";
  }
}

/** The D1-backed resolver. Satisfies routing.ts's TenantResolver structurally. */
export class D1TenantResolver implements TenantResolver {
  constructor(private readonly store: ControlPlaneStore) {}

  async resolve(slug: string): Promise<RoutingTenantRecord | null> {
    const tenant = await this.store.getTenantBySlug(slug);
    if (!tenant) return null;
    return {
      slug: tenant.slug,
      status: routingStatusFor(tenant),
      // A routable tenant always has a script name; anything else is unroutable anyway, and an
      // empty string here would be a silent 404 rather than a loud one.
      script_name: tenant.script_name ?? "",
    };
  }
}
