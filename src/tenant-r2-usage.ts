// Aggregate per-tenant R2 usage for the admin surface (cf#56, gate section 5).
//
// WHY THIS IS HOSTED-ONLY AND CORRECTLY SO: this is about OUR bill, not about studio behaviour.
// It reads what each tenant bucket holds and totals it. Nothing here can reach a tenant studio, and
// a self-hoster needs none of it (their R2 bill is their own dashboard). That is the opposite of the
// hosted-glue tripwire: the tripwire is hosted-only code that changes what a TENANT can do, and this
// changes nothing for anyone. Enforcement is a separate question and deliberately not here; the
// storage QUOTA is a studio-core operator knob (vivijure-core#52) so self-host gets the same feature.
//
// READS ONLY. No route in this file writes anything, and there is no audit row, for the same reason
// /api/admin/reconcile/runpod records none: there is no state change to audit, and a write would
// give the pass the one property a measurement must not have, the ability to alter what it measures.
//
// THE HONESTY RULE THAT SHAPES EVERY TYPE BELOW: a number we could not read is NULL, never 0. A
// failed bucket read and an empty bucket are different facts, and collapsing them makes the total
// under-report, which makes the alert under-fire. That is the failure mode this surface exists to
// prevent, so it is modelled explicitly rather than smoothed over.

/** One tenant bucket, as measured. */
export interface TenantBucketUsage {
  tenant_id: string;
  slug: string;
  bucket: string;
  /** Bytes stored, or NULL when the read failed. NEVER 0 for a failed read. */
  payload_bytes: number | null;
  /** Objects stored, or NULL when the read failed. */
  object_count: number | null;
  /** Why the read failed, or null when it succeeded. */
  error: string | null;
}

/**
 * Whether the aggregate breaches the operator threshold.
 *
 * THREE STATES, NOT A BOOLEAN, and the third one is the point. The total is a FLOOR whenever the
 * tenant census was truncated or any bucket read failed, so:
 *  - "over" is sound even from a floor: a floor above the threshold is still definitely above it.
 *  - "under" may only be claimed from a COMPLETE total. Claiming it from a floor is exactly the
 *    truncated-census negative conclusion that produces a quiet, confident, wrong all-clear.
 *  - "indeterminate" is the honest answer in between, and it is a signal to fix the read, not noise.
 */
export type AlertState = "over" | "under" | "indeterminate" | "no_threshold";

export interface R2UsageReport {
  /** Was the tenant census itself complete? A truncated census cannot support a total. */
  census_complete: boolean;
  /** The operator threshold in bytes, or null when none is configured. */
  threshold_bytes: number | null;
  /** Sum over buckets we could actually read. A FLOOR when total_is_floor is true. */
  total_bytes: number;
  total_objects: number;
  buckets_read: number;
  buckets_unreadable: number;
  /** Tenants with no bucket provisioned yet; counted, not silently dropped. */
  tenants_without_bucket: number;
  /**
   * True when total_bytes is a lower bound rather than the total: the census was truncated, or at
   * least one bucket read failed. Anything consuming total_bytes must branch on this.
   */
  total_is_floor: boolean;
  alert: AlertState;
  tenants: TenantBucketUsage[];
}

/** The tenant fields this core needs. Kept minimal so the caller shape stays free. */
export interface TenantLite {
  id: string;
  slug: string;
  r2_bucket_name: string | null;
}

/**
 * Build the report from measurements already taken.
 *
 * PURE: no IO, no clock, no globals, so the aggregation and the alert logic are testable without
 * touching Cloudflare. The live read is the callers job (CfApi.getR2BucketUsage); the DECISION that
 * a number means an alert lives here, under the unit gate, because that decision is the part that
 * can be silently wrong.
 */
export function buildR2UsageReport(args: {
  tenants: TenantLite[];
  censusComplete: boolean;
  /** Measurement per bucket name. A bucket absent from this map counts as UNREADABLE, not empty. */
  measurements: Map<string, { payloadBytes: number; objectCount: number } | { error: string }>;
  thresholdBytes: number | null;
}): R2UsageReport {
  const rows: TenantBucketUsage[] = [];
  let totalBytes = 0;
  let totalObjects = 0;
  let read = 0;
  let unreadable = 0;
  let withoutBucket = 0;

  for (const t of args.tenants) {
    if (!t.r2_bucket_name) {
      withoutBucket++;
      continue;
    }
    const m = args.measurements.get(t.r2_bucket_name);
    if (!m || "error" in m) {
      unreadable++;
      rows.push({
        tenant_id: t.id,
        slug: t.slug,
        bucket: t.r2_bucket_name,
        payload_bytes: null,
        object_count: null,
        error: m && "error" in m ? m.error : "no measurement returned",
      });
      continue;
    }
    read++;
    totalBytes += m.payloadBytes;
    totalObjects += m.objectCount;
    rows.push({
      tenant_id: t.id,
      slug: t.slug,
      bucket: t.r2_bucket_name,
      payload_bytes: m.payloadBytes,
      object_count: m.objectCount,
      error: null,
    });
  }

  const totalIsFloor = !args.censusComplete || unreadable > 0;
  // Biggest bucket first: an operator opening this because the bill moved wants the cause on line 1.
  rows.sort((a, b) => (b.payload_bytes ?? -1) - (a.payload_bytes ?? -1));

  let alert: AlertState;
  if (args.thresholdBytes === null) {
    alert = "no_threshold";
  } else if (totalBytes > args.thresholdBytes) {
    alert = "over";
  } else if (totalIsFloor) {
    alert = "indeterminate";
  } else {
    alert = "under";
  }

  return {
    census_complete: args.censusComplete,
    threshold_bytes: args.thresholdBytes,
    total_bytes: totalBytes,
    total_objects: totalObjects,
    buckets_read: read,
    buckets_unreadable: unreadable,
    tenants_without_bucket: withoutBucket,
    total_is_floor: totalIsFloor,
    alert,
    tenants: rows,
  };
}

/**
 * Parse the operator threshold var. Returns null when unset, blank, or not a positive integer.
 *
 * A malformed threshold reads as NO threshold rather than as 0. Zero would put the surface
 * permanently in "over" and train the operator to ignore it, which is worse than no alert at all.
 */
export function parseThresholdBytes(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}
