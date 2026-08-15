// Tenant identity rules (#52). The provisioner itself is #53; this owns slugs and the status machine.

import type { Tenant, TenantLifecycle, TenantStatus } from "./store";
import { readRunPodMode, type RunPodMode } from "./runpod-pool";

/**
 * A slug is BOTH a DNS label (<slug>.studio.vivijure.com) and a Workers-for-Platforms script name,
 * so it is validated ONCE, here, against the intersection of both alphabets. 3..32 chars,
 * lowercase alnum and internal hyphens, no leading/trailing hyphen.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

/**
 * Reserved labels. Two reasons, both load-bearing: a tenant must not be able to mint a hostname
 * that impersonates a platform surface (admin., api., www.), and must not collide with a sibling
 * service on the zone that already exists (demo., studio-mcp.).
 */
const RESERVED = new Set([
  "www", "api", "admin", "administrator", "root", "demo", "studio", "mcp", "studio-mcp",
  "app", "status", "mail", "smtp", "imap", "ns", "ns1", "ns2", "dns", "cdn", "static",
  "assets", "support", "help", "docs", "blog", "billing", "account", "accounts", "auth",
  "login", "signup", "security", "abuse", "postmaster", "webmaster", "test", "staging",
  "dev", "internal", "vivijure",
]);

export type SlugRejection = "too_short" | "too_long" | "bad_shape" | "reserved" | "punycode";

export function validateSlug(slug: string): { ok: true } | { ok: false; reason: SlugRejection } {
  if (slug.length < 3) return { ok: false, reason: "too_short" };
  if (slug.length > 32) return { ok: false, reason: "too_long" };
  if (!SLUG_RE.test(slug)) return { ok: false, reason: "bad_shape" };
  // Punycode (#55): "xn--" survives SLUG_RE (lowercase alnum + hyphens), but a browser renders it
  // as the Unicode it encodes -- so a tenant could mint a hostname that LOOKS like the front door
  // (homograph). Refused at signup AND at route time, because it is one rule in one place.
  if (slug.startsWith("xn--")) return { ok: false, reason: "punycode" };
  if (RESERVED.has(slug)) return { ok: false, reason: "reserved" };
  return { ok: true };
}

export function slugRejectionMessage(reason: SlugRejection): string {
  switch (reason) {
    case "too_short":
      return "must be at least 3 characters";
    case "too_long":
      return "must be at most 32 characters";
    case "bad_shape":
      return "use lowercase letters, numbers, and hyphens; must start and end with a letter or number";
    case "reserved":
      return "that name is reserved";
    case "punycode":
      return "use plain letters, numbers, and hyphens";
  }
}

/** The public projection of a tenant. Never leaks internal provisioning ids to the front door. */
export interface TenantView {
  id: string;
  slug: string;
  /**
   * Projected availability for the existing API contract: `"suspended"` when the suspend flag is
   * set, otherwise the stored lifecycle. Callers that need the real lifecycle must read `lifecycle`
   * (cp#281) -- this field alone cannot answer "is this restorable?".
   */
  status: TenantStatus;
  /**
   * The stored lifecycle column verbatim (`pending` … `deleted`), never overwritten by suspension
   * (cp#281). Suspension stays on the orthogonal flag; projecting it into `status` alone made a
   * deleted-but-suspended tenant look restorable. A consumer can answer "is this restorable?" from
   * the response: suspended AND lifecycle is a live-ish state vs suspended over deleted.
   */
  lifecycle: TenantLifecycle;
  url: string | null;
  studio_release: string | null;
  /**
   * The release whose MODULE bytes this tenant runs, or NULL (cp#43).
   *
   * Projected alongside studio_release because they are a PAIR, and withholding one half is what
   * made the other half unreadable. NULL here is load-bearing, not "unknown legacy row": per
   * 0006_module_upgrade.sql it means "not known to be uniformly at any one release; consult the job
   * row". Callers must not render it as a version; render it as "consult the job".
   */
  modules_release: string | null;
  created_at: string;
  live_at: string | null;
  suspended_reason: string | null;
  /**
   * Which RunPod shape this tenant is on (cp#439), or NULL while that is not yet decided.
   *
   * The two tiers need DIFFERENT SCREENS, and without this the front door could not tell them
   * apart at all. The concrete wall: every operator-provisioned tenant is shared, and the shared
   * invoke-key branch succeeds only on an EMPTY-bodied POST, so a wizard that cannot see the tier
   * cannot know to send one.
   *
   * NULL IS NOT A THIRD TIER, and it is not the column being nullable. tenants.runpod_mode is NOT
   * NULL DEFAULT dedicated and is written INSIDE the runpod_endpoints provisioning step, so
   * before that step every row reads dedicated whether or not it is one (the tree says so itself
   * at store.ts, on ProvisionJob.runpod_mode). Projecting the raw column would therefore ship the
   * exact defect this issue is about: a value that collapses "genuinely dedicated" and "not
   * decided yet" into one string a client picks a screen from.
   *
   * So the untrustworthy region is made UNREPRESENTABLE rather than documented. A consumer that
   * treats null as dedicated re-introduces cp#439; treat it as "do not claim a tier yet".
   */
  runpod_mode: RunPodMode | null;
}

export function tenantView(tenant: Tenant, domainSuffix: string): TenantView {
  // Suspension is projected OVER the lifecycle into `status`, never stored in the lifecycle column.
  // The API contract Joan builds against is unchanged (status may read "suspended"), while
  // `lifecycle` carries the real column so a deleted-but-suspended row is not mistaken for
  // restorable (cp#281).
  const suspended = tenant.suspended_at !== null;
  return {
    id: tenant.id,
    slug: tenant.slug,
    status: suspended ? "suspended" : tenant.status,
    lifecycle: tenant.status,
    // A URL is shown only once there is something behind it; a link that 5xx's is not honest. A
    // suspended tenant gets no URL either, whatever its lifecycle says.
    url: tenant.status === "live" && !suspended ? `https://${tenant.slug}${domainSuffix}` : null,
    studio_release: tenant.studio_release,
    // NOT gated on status or suspension, unlike url. A URL is withheld because a dead link is a
    // lie; a release is a FACT about the bytes installed, and it stays true (and stays needed for
    // diagnosis) whatever the lifecycle says.
    modules_release: tenant.modules_release,
    created_at: tenant.created_at,
    live_at: tenant.live_at,
    suspended_reason: tenant.suspended_reason,
    // SETTLED-NESS IS INFERRED FROM endpoints_json, and the direction of that inference is the
    // whole reason it is safe. The provisioner writes the MODE BEFORE the endpoint list on both
    // branches, deliberately (a crash between the two must not leave pool endpoint ids under the
    // default mode). So endpoints present IMPLIES the mode was written, while the reverse does
    // not hold. Reading it this way can therefore only ever under-claim -- report "not decided"
    // for a tenant whose mode is in fact settled, in the crash window -- and can never assert a
    // tier that was not written. Fail toward claiming less, exactly as readRunPodMode does.
    runpod_mode:
      tenant.endpoints_json === null || tenant.endpoints_json === ""
        ? null
        : readRunPodMode(tenant.runpod_mode),
  };
}

/**
 * The canonical tenant studio script name in the dispatch namespace (#55).
 *
 * ONE definition, both sides: the provisioner (#53) creates the user Worker under this name and
 * records it as tenant.script_name; routing dispatches to the STORED name (authoritative at request
 * time). If the two ever drift, every tenant 503s.
 */
export function tenantScriptName(slug: string): string {
  return `tenant-${slug}-studio`;
}

/** The 4 endpoint ids the provisioner (#53/#54) records; read by the invoke-key scope check. */
/**
 * The endpoint list a HUMAN has to match in the RunPod console: id, plus the name and label the
 * provisioner gave it (cp#169).
 *
 * WHY IT IS SEPARATE FROM tenantEndpointIds. The ids are what verifyInvokeKeyScope probes; the names
 * are what a person ticks in a console, and a scoping step done by matching a name is measurably
 * less error-prone than one done by matching an opaque id. The onboarding screen already renders
 * exactly this shape, so a returning owner (the cp#169 handoff) reads the same list they read at
 * signup rather than a second dialect of the same fact.
 *
 * Tolerant in the same direction as tenantEndpointIds: an element we cannot read is dropped rather
 * than throwing, and a bare-string element yields an id with no name, which the page can still show.
 */
export function tenantEndpointRecipe(tenant: Tenant): { id: string; name: string | null; label: string | null }[] {
  if (!tenant.endpoints_json) return [];
  try {
    const parsed: unknown = JSON.parse(tenant.endpoints_json);
    if (!Array.isArray(parsed)) return [];
    const out: { id: string; name: string | null; label: string | null }[] = [];
    for (const v of parsed) {
      if (typeof v === "string") {
        out.push({ id: v, name: null, label: null });
        continue;
      }
      if (!v || typeof v !== "object") continue;
      const row = v as { id?: unknown; name?: unknown; label?: unknown };
      if (typeof row.id !== "string") continue;
      out.push({
        id: row.id,
        name: typeof row.name === "string" ? row.name : null,
        label: typeof row.label === "string" ? row.label : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function tenantEndpointIds(tenant: Tenant): string[] {
  if (!tenant.endpoints_json) return [];
  try {
    const parsed: unknown = JSON.parse(tenant.endpoints_json);
    if (!Array.isArray(parsed)) return [];
    // The provisioner stores endpoints_json as the CreatedEndpoint[] it built (objects carrying
    // {key,label,id,name} -- the same shape invokeKeyRecipe consumes), so the endpoint id is the
    // .id field. A bare-string element is tolerated for safety, but the writer emits objects. The
    // earlier string-only filter returned [] against the real stored shape, so every live key
    // install 409-d no_endpoints; stubbed tests hand-stored string arrays the provisioner never
    // produces, so they never caught it.
    const idOf = (v: unknown): string | null =>
      typeof v === "string"
        ? v
        : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string"
          ? (v as { id: string }).id
          : null;
    return parsed.map(idOf).filter((v): v is string => v !== null);
  } catch {
    return [];
  }
}
