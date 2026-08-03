// RunPod reconciliation (cp#137): DETECTION ONLY, read-only by construction.
//
// THE DEFECT THIS ANSWERS. The plane records the RunPod endpoints of a tenant in
// tenants.endpoints_json and nothing ever compares that record to RunPod. cp#137 found the
// consequence live: the standing testbed reads status=live while all four endpoints it names 404.
// A status column says "provisioning completed once", never "renders today", and nothing was
// checking the difference.
//
// NOT THE SAME THING AS src/runpod-job-sweep.ts, and the distinction is worth a line HERE rather
// than only over there, because this file is the one someone finds first. This module reconciles
// ENDPOINTS against an operator's inventory snapshot. That one reconciles JOB ROWS against RunPod
// directly, on a cron. The "rules out a background poller" sentence below is about a TENANT's
// account, where key A is never stored and key B is transient -- it does NOT cover the job sweep,
// which asks about OUR pool endpoints with OUR pool key, held by the plane because the proxy holds
// it. Same vendor, different custody, opposite conclusion.
//
// WHY THE INVENTORY IS AN ARGUMENT AND NOT A FETCH. The plane deliberately holds no credential that
// can read the RunPod account of a tenant: key A (graphql read/write) is used once at provision and
// never stored, key B is invoke-only and transient here. So this module cannot poll RunPod and must
// not pretend it can. The RunPod side arrives as a snapshot an OPERATOR gathered with their own key
// (scripts/reconcile-runpod.mjs) and the custody boundary is unchanged. It is also why cp#137 rules
// out a background poller: a poller needs a credential we refuse to hold.
//
// WHY IT NEVER WRITES. Every remediation this could suggest is destructive (delete an endpoint,
// delete a template) or spends money (re-provision), and both belong to a separate, lead-approved
// step. The output is a report; the caller decides. Nothing in this file, and nothing on the route
// that calls it, touches the store.
//
// THE TWO ORPHAN LAYERS (the cp#117 drill finding, recorded on cp#137). A torn-down tenant leaves
// endpoints behind, and deleting those endpoints EXPOSES the templates underneath, which the
// endpoint delete does not touch. A reconciliation that enumerates endpoints only would remove half
// the debris while reading as complete, so this compares BOTH layers, always, and says which layer
// each finding came from.
//
// ABSENCE IS A CLAIM THAT NEEDS A COMPLETE CENSUS. "This endpoint does not exist" is sound only if
// the endpoint list was whole; "no record owns this endpoint" is sound only if the tenant list was
// whole. Both censuses carry an explicit complete flag, and a finding that depends on a census which
// was not proven whole is reported as unproven rather than asserted. A check that could not be
// performed never reads here as a check that passed.

import { PROVISION_PLAN, tenantEndpointName } from "./runpod";
import { readRunPodMode } from "./runpod-pool";
import type { SharedRunPodPool } from "./runpod-pool";
import type { Tenant } from "./store";

/**
 * The page ceiling in D1Store.listTenants ("... LIMIT 200"). Mirrored here because the caller has to
 * decide whether the tenant census it just read was WHOLE, and a bare 200 at the call site would
 * drift away from the query silently.
 */
export const TENANT_PAGE_LIMIT = 200;

/** Refuse an inventory body larger than this: a reconciliation request is not a bulk upload. */
export const MAX_INVENTORY_RESOURCES = 5_000;

/** One RunPod resource as both list endpoints report it. Ids and names only, never a credential. */
export interface RunPodResource {
  id: string;
  name: string;
}

/**
 * A snapshot of ONE RunPod account, gathered by an operator with their own key.
 *
 * complete is required and never defaulted: only the gatherer can know whether it read the whole
 * list, and defaulting it to true is exactly how a truncated page becomes a confident claim that a
 * resource does not exist.
 */
export interface RunPodInventory {
  /** Operator label for the account read ("prod", "scratch", a tenant name). Never a credential. */
  account_label: string;
  /** When the operator read RunPod, in their own words. Restated so a saved report is dateable. */
  read_at: string;
  complete: boolean;
  endpoints: RunPodResource[];
  templates: RunPodResource[];
}

/** The plane-side census. complete is false when the read may have been truncated. */
export interface TenantCensus {
  tenants: Tenant[];
  complete: boolean;
}

export type DriftKind =
  /** A record names an endpoint id RunPod does not have. The cp#137 case. */
  | "record_endpoint_missing"
  /** A record names an endpoint that exists under a DIFFERENT name than the record claims. */
  | "record_endpoint_renamed"
  /** Layer 2: the template a recorded endpoint was built from is gone. */
  | "record_template_missing"
  /** RunPod holds an endpoint whose only owner is a torn-down record, or no record at all. */
  | "orphan_endpoint"
  /** Layer 2 orphan: the template left behind underneath an orphaned endpoint. */
  | "orphan_template"
  /** The record itself cannot be read, so nothing about this tenant can be reconciled. */
  | "record_unreadable";

/** proven = the census this finding depends on was whole. unproven = it was not; do not act on it. */
export type Confidence = "proven" | "unproven";

export type UnprovenReason = "inventory_incomplete" | "tenant_census_incomplete";

export interface DriftFinding {
  kind: DriftKind;
  layer: "endpoint" | "template" | "record";
  confidence: Confidence;
  unproven_reason?: UnprovenReason;
  tenant_id: string | null;
  tenant_slug: string | null;
  tenant_status: string | null;
  resource_id: string | null;
  resource_name: string | null;
  /** The plan key ("backend", "upscale", ...) when the resource is attributable to one. */
  endpoint_key: string | null;
  detail: string;
}

export type Verdict = "clean" | "drift" | "unproven";

export interface TenantVerdict {
  tenant_id: string;
  slug: string;
  status: string;
  endpoints_recorded: number;
  endpoints_present: number;
  templates_present: number;
  findings: number;
  verdict: Verdict;
}

export interface ReconcileReport {
  /** Restated from the snapshot so a saved report says which account was read, and when. */
  account_label: string;
  read_at: string;
  census: {
    tenants: number;
    tenants_complete: boolean;
    endpoints: number;
    templates: number;
    inventory_complete: boolean;
  };
  /** clean requires BOTH censuses whole AND zero findings. An unprovable check is never a pass. */
  verdict: Verdict;
  tenants: TenantVerdict[];
  findings: DriftFinding[];
  /**
   * RunPod resources this pass refuses to attribute to any tenant: house endpoints, another
   * product, anything not named for a slug the plane knows. Reported so the operator sees the whole
   * account, and deliberately NOT called orphaned: claiming ownership of a resource we cannot trace
   * is how a later cleanup step deletes something that was never ours.
   */
  unattributed: {
    endpoints: RunPodResource[];
    templates: RunPodResource[];
  };
  /** Structural, not decorative: this pass writes nothing. Remediation is a separate step. */
  writes: "none";
}

interface RecordedEndpoint {
  key: string;
  id: string;
  name: string;
}

/** A tenant row whose resources are legitimately gone. Only deleted; deleting still owns them. */
const isTornDown = (t: Tenant): boolean => t.status === "deleted";

function parseRecordedEndpoints(
  t: Tenant,
): { ok: true; endpoints: RecordedEndpoint[] } | { ok: false; detail: string } {
  if (!t.endpoints_json) return { ok: true, endpoints: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(t.endpoints_json);
  } catch (e) {
    return { ok: false, detail: `endpoints_json is not JSON: ${String(e).slice(0, 120)}` };
  }
  if (!Array.isArray(raw)) return { ok: false, detail: "endpoints_json is not an array" };
  const endpoints: RecordedEndpoint[] = [];
  for (const entry of raw) {
    const rec = entry as Record<string, unknown> | null;
    const id = rec && typeof rec.id === "string" ? rec.id : null;
    if (!id) return { ok: false, detail: "an endpoints_json entry carries no id" };
    endpoints.push({
      key: rec && typeof rec.key === "string" ? rec.key : "",
      id,
      name: rec && typeof rec.name === "string" ? rec.name : "",
    });
  }
  return { ok: true, endpoints };
}

/**
 * Compare the tenant records with a RunPod snapshot and report the drift. Pure: no clock, no
 * network, no store. The same function the admin route serves and the live check drives, so there
 * is no second code path that only one of them takes.
 */
export function reconcileRunPod(
  census: TenantCensus,
  inventory: RunPodInventory,
  /**
   * The SHARED pool this plane offers, when it offers one (cp#270). Optional so every existing
   * caller is unchanged, and an omitted pool reconciles exactly as it did before pooling existed.
   */
  sharedPool?: SharedRunPodPool | null,
): ReconcileReport {
  const endpointsById = new Map(inventory.endpoints.map((e) => [e.id, e]));
  const templatesByName = new Map(inventory.templates.map((t) => [t.name, t]));

  // ---- THE POOL EXCLUSION (cp#270) -----------------------------------------------------------
  //
  // THE DEFECT THIS CLOSES, and it is the worst thing pooling can do to this file. A shared
  // tenant's endpoints_json names the PLANE's production endpoints. Without this exclusion:
  //
  //   1. `claimedEndpointIds` is a Map keyed by endpoint id, so N shared tenants naming one pool
  //      endpoint collapse to ONE claimant, last-write-wins in census order. Nine live tenants
  //      using an endpoint are invisible behind whichever row happened to be read last.
  //   2. The orphan loop skips an endpoint only when its single surviving claimant is NOT torn
  //      down. So one DELETED shared tenant is enough to emit a live production endpoint as
  //      `orphan_endpoint` at confidence "proven", worded "endpoint survives after tenant X was
  //      torn down" -- while every other shared tenant is still rendering on it.
  //
  // This function writes nothing, so it cannot delete anything itself. That is not much comfort:
  // a proven-confidence orphan finding is precisely what a human acts on by hand, which is how
  // the hosted-phase1 endpoints were removed.
  //
  // WHY IT EXCLUDES BY ID *AND* NAME rather than by tenant mode alone: the mode tells us which
  // ROWS to ignore, and that is done below, but the pool endpoints must also be recognised in the
  // INVENTORY, where there is no tenant to consult. Both halves are needed -- skipping only the
  // rows would still leave the pool unattributed-or-orphaned depending on its names.
  const poolIds: ReadonlySet<string> = sharedPool?.ids ?? new Set<string>();
  const poolNames: ReadonlySet<string> = sharedPool?.names ?? new Set<string>();

  // NAME attribution built from slugs we actually hold, never from a regex guess. A slug may
  // contain dashes, so parsing "vivijure-<slug>-<key>" back apart is ambiguous; matching against the
  // names the naming function PRODUCES for known slugs is not.
  //
  // SHARED tenants are omitted from this map (cp#270). The map answers "which tenant would OWN an
  // endpoint of this name", and a pooled tenant owns none -- it would never have created
  // `vivijure-<its-slug>-backend`, so claiming a resource of that name for it would be attributing
  // someone else's endpoint to a tenant that could not have made it.
  const owningTenantByName = new Map<string, { tenant: Tenant; key: string }>();
  for (const tenant of census.tenants) {
    if (readRunPodMode(tenant.runpod_mode) === "shared") continue;
    for (const spec of PROVISION_PLAN) {
      owningTenantByName.set(tenantEndpointName(tenant.slug, spec.key), { tenant, key: spec.key });
    }
  }

  const findings: DriftFinding[] = [];
  const verdicts: TenantVerdict[] = [];
  /** endpoint id -> the record that names it, whatever the status of that record. */
  const claimedEndpointIds = new Map<string, { tenant: Tenant; recorded: RecordedEndpoint }>();
  /** resource NAME -> a record that names it and is not torn down. */
  const liveNames = new Map<string, { tenant: Tenant; recorded: RecordedEndpoint }>();

  const absenceConfidence = (): Pick<DriftFinding, "confidence" | "unproven_reason"> =>
    inventory.complete
      ? { confidence: "proven" }
      : { confidence: "unproven", unproven_reason: "inventory_incomplete" };

  const orphanConfidence = (): Pick<DriftFinding, "confidence" | "unproven_reason"> =>
    census.complete
      ? { confidence: "proven" }
      : { confidence: "unproven", unproven_reason: "tenant_census_incomplete" };

  for (const tenant of census.tenants) {
    // A SHARED tenant records the pool, not property (cp#270). Every check in this loop asks an
    // ownership question -- does RunPod still have the endpoint this tenant made, is its template
    // still there -- and none of them is meaningful about a resource the tenant never created.
    //
    // It gets a verdict rather than being dropped from the report. A tenant that silently does not
    // appear reads as a tenant nobody looked at, which is the absent-row-reads-as-fine shape this
    // whole file is built against. `clean` is honest here and is not a free pass: the pool's own
    // presence is still checked below, once, against the inventory.
    const parsed = parseRecordedEndpoints(tenant);
    if (readRunPodMode(tenant.runpod_mode) === "shared") {
      verdicts.push({
        tenant_id: tenant.id,
        slug: tenant.slug,
        status: tenant.status,
        endpoints_recorded: parsed.ok ? parsed.endpoints.length : 0,
        endpoints_present: 0,
        templates_present: 0,
        findings: 0,
        verdict: inventory.complete && census.complete ? "clean" : "unproven",
      });
      continue;
    }
    if (!parsed.ok) {
      findings.push({
        kind: "record_unreadable",
        layer: "record",
        confidence: "proven",
        tenant_id: tenant.id,
        tenant_slug: tenant.slug,
        tenant_status: tenant.status,
        resource_id: null,
        resource_name: null,
        endpoint_key: null,
        detail: parsed.detail,
      });
      verdicts.push({
        tenant_id: tenant.id,
        slug: tenant.slug,
        status: tenant.status,
        endpoints_recorded: 0,
        endpoints_present: 0,
        templates_present: 0,
        findings: 1,
        verdict: "drift",
      });
      continue;
    }

    let present = 0;
    let templatesPresent = 0;
    let tenantFindings = 0;

    for (const recorded of parsed.endpoints) {
      claimedEndpointIds.set(recorded.id, { tenant, recorded });
      if (!isTornDown(tenant) && recorded.name) liveNames.set(recorded.name, { tenant, recorded });

      const live = endpointsById.get(recorded.id);
      if (live) present += 1;
      const expectedName = recorded.name || tenantEndpointName(tenant.slug, recorded.key);
      if (templatesByName.has(expectedName)) templatesPresent += 1;

      // A torn-down record SHOULD point at nothing. Reporting its dead endpoints as drift would bury
      // the live tenants under noise; whatever survived on RunPod is caught below as an orphan,
      // which is the honest name for it.
      if (isTornDown(tenant)) continue;

      if (!live) {
        tenantFindings += 1;
        findings.push({
          kind: "record_endpoint_missing",
          layer: "endpoint",
          ...absenceConfidence(),
          tenant_id: tenant.id,
          tenant_slug: tenant.slug,
          tenant_status: tenant.status,
          resource_id: recorded.id,
          resource_name: recorded.name || null,
          endpoint_key: recorded.key || null,
          detail:
            `the record names endpoint ${recorded.id} (${recorded.key || "unkeyed"}) and the ` +
            `${inventory.account_label} account does not have it: this tenant cannot render that step`,
        });
      } else if (recorded.name && live.name !== recorded.name) {
        tenantFindings += 1;
        findings.push({
          kind: "record_endpoint_renamed",
          layer: "endpoint",
          confidence: "proven",
          tenant_id: tenant.id,
          tenant_slug: tenant.slug,
          tenant_status: tenant.status,
          resource_id: recorded.id,
          resource_name: live.name,
          endpoint_key: recorded.key || null,
          detail:
            `endpoint ${recorded.id} exists as "${live.name}" but the record calls it ` +
            `"${recorded.name}": provisioning adopts BY NAME, so a re-provision would build a second one`,
        });
      }

      if (!templatesByName.has(expectedName)) {
        tenantFindings += 1;
        findings.push({
          kind: "record_template_missing",
          layer: "template",
          ...absenceConfidence(),
          tenant_id: tenant.id,
          tenant_slug: tenant.slug,
          tenant_status: tenant.status,
          resource_id: null,
          resource_name: expectedName,
          endpoint_key: recorded.key || null,
          detail:
            `no template named "${expectedName}" in the ${inventory.account_label} account: a ` +
            `re-provision has nowhere to write the fresh R2 credential of this tenant and refuses (409)`,
        });
      }
    }

    verdicts.push({
      tenant_id: tenant.id,
      slug: tenant.slug,
      status: tenant.status,
      endpoints_recorded: parsed.endpoints.length,
      endpoints_present: present,
      templates_present: templatesPresent,
      findings: tenantFindings,
      verdict:
        tenantFindings > 0 ? "drift" : inventory.complete && census.complete ? "clean" : "unproven",
    });
  }

  const unattributedEndpoints: RunPodResource[] = [];
  for (const endpoint of inventory.endpoints) {
    // THE POOL IS THE PLANE'S, and it is in use by every shared tenant at once (cp#270). It is
    // neither orphaned nor unattributed: it is attributed to US. Skipped before the claim lookup
    // so no tenant row can ever be the thing that decides a production endpoint's fate.
    if (poolIds.has(endpoint.id) || poolNames.has(endpoint.name)) continue;
    const claim = claimedEndpointIds.get(endpoint.id);
    if (claim && !isTornDown(claim.tenant)) continue;

    const named = owningTenantByName.get(endpoint.name);
    const owner = claim?.tenant ?? named?.tenant ?? null;
    if (!owner) {
      unattributedEndpoints.push(endpoint);
      continue;
    }
    findings.push({
      kind: "orphan_endpoint",
      layer: "endpoint",
      // A torn-down CLAIMANT is proof in itself. An attribution by name alone is sound only if the
      // tenant census was whole, since a row we did not read could be the legitimate owner.
      ...(claim ? { confidence: "proven" as const } : orphanConfidence()),
      tenant_id: owner.id,
      tenant_slug: owner.slug,
      tenant_status: owner.status,
      resource_id: endpoint.id,
      resource_name: endpoint.name,
      endpoint_key: claim?.recorded.key || named?.key || null,
      detail: claim
        ? `endpoint survives on the ${inventory.account_label} account after tenant ${owner.slug} was ` +
          `torn down (the plane holds no credential that could delete it), and its TEMPLATE will still ` +
          `be there after the endpoint is deleted`
        : `endpoint is named for tenant ${owner.slug} but no record names this id; do not assume it is ` +
          `disposable until a record is found or ruled out`,
    });
  }

  const unattributedTemplates: RunPodResource[] = [];
  for (const template of inventory.templates) {
    // Same as the endpoint loop: an endpoint resolves its image THROUGH its template, so the
    // pool's templates are as load-bearing as the pool's endpoints and are equally not debris.
    if (poolNames.has(template.name)) continue;
    if (liveNames.has(template.name)) continue;
    const named = owningTenantByName.get(template.name);
    if (!named) {
      unattributedTemplates.push(template);
      continue;
    }
    const halfBuilt = !isTornDown(named.tenant) && named.tenant.endpoints_json === null;
    findings.push({
      kind: "orphan_template",
      layer: "template",
      ...orphanConfidence(),
      tenant_id: named.tenant.id,
      tenant_slug: named.tenant.slug,
      tenant_status: named.tenant.status,
      resource_id: template.id,
      resource_name: template.name,
      endpoint_key: named.key,
      detail: halfBuilt
        ? `template exists for tenant ${named.tenant.slug} (${named.tenant.status}) whose record names ` +
          `no endpoints at all: a provision that died between the template and the endpoint`
        : `template survives on the ${inventory.account_label} account with no live endpoint record for ` +
          `tenant ${named.tenant.slug} (${named.tenant.status}): this is the SECOND debris layer, the ` +
          `one that stays invisible until the endpoints are cleared`,
    });
  }

  const proven = findings.some((f) => f.confidence === "proven");
  const complete = inventory.complete && census.complete;
  const verdict: Verdict = proven ? "drift" : complete && findings.length === 0 ? "clean" : "unproven";

  return {
    account_label: inventory.account_label,
    read_at: inventory.read_at,
    census: {
      tenants: census.tenants.length,
      tenants_complete: census.complete,
      endpoints: inventory.endpoints.length,
      templates: inventory.templates.length,
      inventory_complete: inventory.complete,
    },
    verdict,
    tenants: verdicts,
    findings,
    unattributed: { endpoints: unattributedEndpoints, templates: unattributedTemplates },
    writes: "none",
  };
}

/**
 * Validate an operator-supplied snapshot. Deliberately strict, and complete is REQUIRED: a body that
 * omitted it would be reconciled as a whole census and would produce confident absences from a page
 * that may have been cut off.
 */
export function parseInventoryBody(
  body: unknown,
): { ok: true; inventory: RunPodInventory } | { ok: false; detail: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { ok: false, detail: "body must be a JSON object" };

  const label = typeof b.account_label === "string" ? b.account_label.trim() : "";
  if (!label || label.length > 64) {
    return { ok: false, detail: "account_label must be a non-empty string of at most 64 characters" };
  }
  const readAt = typeof b.read_at === "string" ? b.read_at.trim() : "";
  if (!readAt || readAt.length > 40) {
    return { ok: false, detail: "read_at must be the ISO time at which the operator read RunPod" };
  }
  if (typeof b.complete !== "boolean") {
    return {
      ok: false,
      detail:
        "complete must be an explicit boolean: only the gatherer knows whether it read the whole " +
        "list, and an assumed-complete census turns a truncated page into a false absence",
    };
  }

  const resources = (value: unknown, field: string): RunPodResource[] | string => {
    if (!Array.isArray(value)) return `${field} must be an array`;
    const out: RunPodResource[] = [];
    for (const entry of value) {
      const r = entry as Record<string, unknown> | null;
      if (!r || typeof r.id !== "string" || typeof r.name !== "string") {
        return `every ${field} entry must carry a string id and a string name`;
      }
      out.push({ id: r.id, name: r.name });
    }
    return out;
  };

  const endpoints = resources(b.endpoints, "endpoints");
  if (typeof endpoints === "string") return { ok: false, detail: endpoints };
  const templates = resources(b.templates, "templates");
  if (typeof templates === "string") return { ok: false, detail: templates };
  if (endpoints.length + templates.length > MAX_INVENTORY_RESOURCES) {
    return { ok: false, detail: `inventory exceeds ${MAX_INVENTORY_RESOURCES} resources` };
  }

  return {
    ok: true,
    inventory: { account_label: label, read_at: readAt, complete: b.complete, endpoints, templates },
  };
}

/**
 * Was a RunPod list payload WHOLE, or might it have been a page of a longer list?
 *
 * Mirrored by wholePage() in scripts/reconcile-runpod.mjs (a .mjs operator tool cannot import TS);
 * keep the two in step. This exists because every absence conclusion downstream ("that endpoint is
 * gone", "no record owns this") is only as sound as the census it came from, and a truncated page
 * that reports itself complete is precisely how a reconciliation invents a missing resource.
 */
export function listWasWhole(payload: unknown): boolean {
  if (Array.isArray(payload)) return true;
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  for (const cursor of ["next", "nextCursor", "next_cursor", "cursor", "paginate", "pagination"]) {
    if (p[cursor]) return false;
  }
  return Array.isArray(p.endpoints) || Array.isArray(p.templates) || Array.isArray(p.data);
}
