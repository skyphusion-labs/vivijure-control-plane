// cp#183: the plane SETS the per-tenant storage ceiling the tenant studio ENFORCES.
//
// THE GAP THIS CLOSES. vivijure-core v1.3.0 shipped the knob (core#52): a studio reads
// R2_STORAGE_QUOTA_BYTES, accounts every object write in its own DB at write time, and at SUBMIT
// either allows, denies 507 with both real numbers, or fails CLOSED 503 when the quota is set and
// its check cannot run. vivijure-cf v1.11.0 wired it and v1.12.0 declares it in the release
// manifest. Nothing in this plane ever wrote the var (repo-wide grep before this file: zero hits),
// so hosted shipped the enforcement and bound it to NOBODY: every hosted tenant ran with the knob
// absent, which core reads as OFF. A tenant who left the render queue running had no storage bound
// at all, and the bill is ours.
//
// WHY THE NUMBER IS CONFIGURED AND NOT DERIVED, the opposite call from ABUSE_REPORT_URL next door.
// That URL is a FACT OF THE DEPLOY (we serve the page, so we can compute it and a second env var
// could only disagree with it). A storage ceiling is a POLICY: it prices what we are willing to
// carry per tenant, and nothing in this code base knows that number. So it comes from plane config,
// and this file ships NO default -- unset means the ceiling is off, exactly as R2_USAGE_ALERT_BYTES
// unset means no alert. An invented default here would be a pricing decision smuggled in as a
// fallback, and it would be wrong for every other operator running this plane.
//
// SET-BUT-MALFORMED IS REFUSED, NOT ROUNDED DOWN TO OFF. core parses unset / empty / 0 / garbage
// identically: quota off. That is right for the STUDIO (an absent knob has absent behaviour) and
// dangerous for the PLANE, because it makes "the operator typed 100GB instead of a byte count" and
// "the operator wants no ceiling" the same outcome, with the operator believing they are capped.
// This plane therefore validates the var and REFUSES to write a studio while it is malformed, which
// is loud, bounded to the paths that would have bound it, and reversible by fixing the deploy var.
//
// THE READER FLOOR IS A REAL PRE-WRITE PROBE HERE, and that is the one thing this var has that
// cp#164 did not. ABUSE_REPORT_URL is only observable once set, so its floor could only be checked
// by writing and asking afterwards. A studio carrying the core#52 reader serves
// GET /api/storage/usage with a quota_bytes field WHETHER OR NOT the quota is set, so a studio
// predating vivijure-cf v1.11.0 answers 404 and can be refused BEFORE anything is written. Use it:
// the silent no-op family (cf#98 / cf#118 / cp#112) is exactly what a capability probe prevents.
//
// THE READBACK IS THE ENFORCED NUMBER, not our opinion of a binding. After the patch we ask the
// studio what quota_bytes it serves and compare it to what we bound. Cloudflare accepting a binding
// proves the API call; the studio echoing the ceiling proves the tenant is actually capped. The
// same measured lesson as cp#164 applies to the wait: a settings PATCH returning 200 does not mean
// the isolate serving the next dispatch has it yet, so the confirm is BOUNDED-RETRIED and an
// unconfirmed readback is reported as "bound, not yet observed, re-run", never as a green.

import type { WorkerBinding } from "./cf-api";
import type { ControlPlaneEnv } from "./env";
import type { ProvisionDeps } from "./provisioner";
import type { Tenant } from "./store";
import { decryptStudioToken } from "./token-crypto";

/**
 * How long to keep asking the studio whether it enforces the number yet, and how often.
 *
 * The same budget as the cp#164 converge, and for the same measured reason: that live run needed
 * more than one immediate read and less than a minute, and the honest answer when it does not
 * converge inside a request is "bound, not yet observed, re-run me" rather than a longer wait.
 */
export const QUOTA_READBACK_PROBE_MS = 2500;
export const QUOTA_READBACK_BUDGET_MS = 15000;

/** The studio var core#52 reads (vivijure-core src/storage-quota.ts). Named once; every writer imports it. */
export const STORAGE_QUOTA_VAR = "R2_STORAGE_QUOTA_BYTES";

/** The studio route that reports the ceiling. Its ABSENCE is the reader floor (vivijure-cf v1.11.0). */
export const STORAGE_USAGE_PATH = "/api/storage/usage";

/**
 * The plane's configured per-tenant ceiling, split into the two facts a caller needs.
 *
 * `bytes` is the value to bind (null = no ceiling on this plane). `invalid` carries the raw string
 * when the operator configured something that is NOT a positive integer, so a write path can refuse
 * by name instead of binding a value the studio would silently ignore.
 */
export interface StorageQuotaConfig {
  bytes: string | null;
  invalid: string | null;
}

/**
 * Read the knob off plane config. BYTES ONLY, deliberately, matching core: no unit parsing, because
 * a mis-parsed unit is an order-of-magnitude error on somebody's bill.
 */
export function tenantStorageQuota(env: ControlPlaneEnv): StorageQuotaConfig {
  const raw = env.TENANT_R2_STORAGE_QUOTA_BYTES;
  if (typeof raw !== "string" || raw.trim() === "") return { bytes: null, invalid: null };
  const trimmed = raw.trim();
  const n = Number(trimmed);
  // Integer AND positive, the same predicate core applies, so the plane cannot consider a value
  // configured that the studio would read as off. 0 is refused rather than treated as "off": an
  // operator who typed 0 asked for something, and a zero ceiling denies every submit.
  if (!Number.isInteger(n) || n <= 0) return { bytes: null, invalid: trimmed };
  // Normalized through Number so "007" and "1e3" cannot reach a studio as a string core parses
  // differently from what an operator read in the deploy config.
  return { bytes: String(n), invalid: null };
}

/**
 * The projection onto a studio binding set. Empty when there is no ceiling, because ABSENT is how
 * core reads "no quota" -- there is no value meaning off, and binding "0" would deny every submit.
 */
export function storageQuotaBindings(bytes: string | null): WorkerBinding[] {
  if (!bytes) return [];
  return [{ type: "plain_text", name: STORAGE_QUOTA_VAR, text: bytes }];
}

/**
 * Carry a binding set forward while RE-DERIVING this var from plane config.
 *
 * Filtering first is what makes the outcome depend on plane config alone: an `inherit` would
 * PRESERVE a ceiling this plane no longer configures, so a plane that lifted its quota could never
 * lift it on a live tenant. Dropping is how the ceiling is removed and re-adding is how it reaches
 * a studio that never had one. Same shape and same reason as withAbuseReportUrl.
 */
export function withStorageQuota(carried: WorkerBinding[], bytes: string | null): WorkerBinding[] {
  return [...carried.filter((b) => b.name !== STORAGE_QUOTA_VAR), ...storageQuotaBindings(bytes)];
}

export interface StorageQuotaRefusal {
  code:
    | "not_provisioned"
    | "tenant_deleted"
    | "plane_quota_malformed"
    | "tenant_studio_token_missing"
    | "tenant_studio_token_unreadable"
    | "studio_not_serving"
    | "studio_predates_quota_reader";
  status: number;
  message: string;
}

export interface StorageQuotaContext {
  script: string;
  studioApiToken: string;
  /** What the plane wants enforced. null = converge the tenant to NO ceiling. */
  bytes: string | null;
  /** What the studio reported for quota_bytes BEFORE the write. */
  servedBefore: number | null;
  /** What the studio reported for used_bytes BEFORE the write, so the operator sees the headroom. */
  usedBefore: number | null;
}

export type StorageQuotaPreflight =
  | { ok: true; context: StorageQuotaContext }
  | { ok: false; refusal: StorageQuotaRefusal };

/** The READBACK, not our opinion of the write. */
export interface StorageQuotaResult {
  ok: boolean;
  script: string;
  /** What the plane bound, as bound. null = the ceiling was REMOVED. */
  quota_bytes: string | null;
  already_present: boolean;
  var_present_after: boolean;
  bindings_before: string[];
  bindings_after: string[];
  secrets_before: string[];
  secrets_after: string[];
  /** Present before and absent after. MUST be empty; non-empty is the strand every write path fears. */
  missing_bindings: string[];
  missing_secrets: string[];
  /** What the STUDIO enforces, before and after. The reader-side half, and the only proof that counts. */
  served_quota_before: number | null;
  served_quota_after: number | null;
  /** The tenant's accounted usage, carried so an operator can see whether the new ceiling is already breached. */
  used_bytes: number | null;
  /** Already over the ceiling the moment it was set. Not an error: submits deny, stored data is untouched. */
  over_on_arrival: boolean;
  /** Did the studio report the ceiling we bound, within the confirm budget. */
  enforced: boolean;
  readback_attempts: number;
  readback_elapsed_ms: number;
}

const names = (list: { name: string }[]): string[] => list.map((b) => b.name).sort();

/**
 * What the studio says about its own storage: the ceiling it enforces and what it has stored.
 *
 * THREE outcomes, because they need three different responses and collapsing any two would hide the
 * thing this probe exists to find:
 *   - `unreadable`: the studio did not answer usably. We can establish nothing.
 *   - `no_reader`: it answered 404. The route does not exist, so this bundle predates the core#52
 *     reader and binding the var would be a silent no-op.
 *   - a reading: quota (null when off) and used bytes.
 */
type StorageReading =
  | { kind: "unreadable" }
  | { kind: "no_reader" }
  | { kind: "read"; quota: number | null; used: number | null };

async function readStudioStorage(
  deps: ProvisionDeps,
  script: string,
  studioApiToken: string,
): Promise<StorageReading> {
  let res: { status: number; text: string };
  try {
    res = await deps.callTenantStudio(script, { method: "GET", path: STORAGE_USAGE_PATH, studioApiToken });
  } catch {
    return { kind: "unreadable" };
  }
  // 404 is the FLOOR, and it is a route-shape fact rather than a guess: a studio carrying the reader
  // serves this path whether or not a quota is configured, so absence of the route is absence of the
  // reader. Every other non-2xx is "we could not establish anything", which is a different answer.
  if (res.status === 404) return { kind: "no_reader" };
  if (res.status >= 300) return { kind: "unreadable" };
  try {
    const body = JSON.parse(res.text) as { quota_bytes?: unknown; used_bytes?: unknown };
    // The field must be PRESENT. A 200 from some other handler that happens to return JSON is not a
    // reading, and treating a missing key as "quota off" would report an unbound tenant as converged.
    if (!("quota_bytes" in (body ?? {}))) return { kind: "unreadable" };
    const quota = typeof body.quota_bytes === "number" ? body.quota_bytes : null;
    const used = typeof body.used_bytes === "number" ? body.used_bytes : null;
    return { kind: "read", quota, used };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * Everything that can refuse, checked BEFORE anything is written.
 *
 * The studio read here is not ceremony. It establishes the BEFORE state for the evidence, it
 * refuses a studio we cannot read at all rather than patching a binding set onto something whose
 * behaviour we cannot then check, and above all it is the READER FLOOR probe: a bundle predating
 * core#52 is refused here instead of being told a ceiling it will never enforce.
 */
export async function preflightStorageQuota(
  deps: ProvisionDeps,
  tenant: Tenant,
): Promise<StorageQuotaPreflight> {
  const refuse = (
    code: StorageQuotaRefusal["code"],
    status: number,
    message: string,
  ): StorageQuotaPreflight => ({ ok: false, refusal: { code, status, message } });

  if (tenant.deleted_at !== null) return refuse("tenant_deleted", 404, "this tenant no longer exists");
  if (!tenant.script_name) {
    return refuse(
      "not_provisioned",
      409,
      "this tenant has no studio script recorded, so there is nothing to bind a ceiling on; it " +
        "needs a provision, not a binding patch",
    );
  }
  if (deps.storageQuota.invalid !== null) {
    return refuse(
      "plane_quota_malformed",
      409,
      `this plane configures TENANT_R2_STORAGE_QUOTA_BYTES="${deps.storageQuota.invalid}", which is ` +
        "not a positive integer number of BYTES. The studio would read that as NO ceiling, so this " +
        "refuses rather than leaving a tenant uncapped while the deploy config says otherwise. Fix " +
        "the var (bytes only, no units) and re-run",
    );
  }
  if (!tenant.studio_token_enc) {
    return refuse("tenant_studio_token_missing", 422, "no studio token recorded for this tenant");
  }
  let studioApiToken: string;
  try {
    studioApiToken = await decryptStudioToken(deps.kek, tenant.studio_token_enc);
  } catch (e) {
    return refuse(
      "tenant_studio_token_unreadable",
      422,
      "the stored studio token could not be decrypted: " + String(e),
    );
  }

  const before = await readStudioStorage(deps, tenant.script_name, studioApiToken);
  if (before.kind === "unreadable") {
    return refuse(
      "studio_not_serving",
      422,
      `the tenant studio did not answer GET ${STORAGE_USAGE_PATH} with readable JSON, so what it ` +
        "enforces cannot be established; fix that before writing to it",
    );
  }
  if (before.kind === "no_reader") {
    return refuse(
      "studio_predates_quota_reader",
      409,
      `this studio answers 404 for ${STORAGE_USAGE_PATH}, so its bundle predates the vivijure-cf ` +
        "v1.11.0 storage-quota reader. Binding the var would be a silent no-op: the tenant would " +
        "carry a ceiling nothing enforces. Move the studio bytes first (POST .../upgrade-studio), " +
        "then re-run this route",
    );
  }
  return {
    ok: true,
    context: {
      script: tenant.script_name,
      studioApiToken,
      bytes: deps.storageQuota.bytes,
      servedBefore: before.quota,
      usedBefore: before.used,
    },
  };
}

/**
 * Give an EXISTING tenant studio this plane's ceiling, idempotently, and PROVE it enforces it.
 *
 * Idempotent by CONVERGENCE rather than by skipping: a tenant already carrying a ceiling is patched
 * anyway with the currently configured one, so a plane that raised, lowered or LIFTED its quota
 * heals its tenants instead of reporting "already present" over a stale number.
 *
 * A BINDING PATCH, NOT A RE-UPLOAD, for the two cp#112 reasons that still hold: the plane cannot
 * reproduce two of the four secrets a live tenant studio carries, and re-uploading the bundle would
 * move the tenant onto whatever release the plane is pinned to, which is a release change smuggled
 * in as a config fix. Everything we keep travels as `inherit`, so no binding VALUE is handled here.
 *
 * NEVER writes tenants.status, tenants.studio_release, or the studio bytes.
 */
export async function applyStorageQuota(
  deps: ProvisionDeps,
  tenant: Tenant,
  context: StorageQuotaContext,
): Promise<StorageQuotaResult> {
  const { script, studioApiToken, bytes, servedBefore, usedBefore } = context;

  // Census BEFORE, through the provisioner credential (reads), so a loss is recognisable. Secret
  // NAMES only; these endpoints never return values and this file never wants one.
  const before = await deps.cf.getScriptBindings(deps.namespace, script);
  const secretsBefore = await deps.cf.getScriptSecretNames(deps.namespace, script);
  const alreadyPresent = before.some((b) => b.name === STORAGE_QUOTA_VAR);

  const desired = withStorageQuota(
    before.map((b) => ({ type: "inherit" as const, name: b.name })),
    bytes,
  );
  await deps.scriptUploadCf.patchScriptSettings(deps.namespace, script, desired);

  // Read back through the OTHER credential. `success:true` is the writing client's opinion of its
  // own work, and this route's risk is a binding set that came back smaller than it went in.
  const after = await deps.cf.getScriptBindings(deps.namespace, script);
  const secretsAfter = await deps.cf.getScriptSecretNames(deps.namespace, script);
  const afterNames = new Set(after.map((b) => b.name));
  const afterSecrets = new Set(secretsAfter);
  const missingBindings = names(before).filter((n) => !afterNames.has(n));
  const missingSecrets = [...secretsBefore].sort().filter((n) => !afterSecrets.has(n));

  // THE ENFORCED NUMBER, retried, because the write reaching Cloudflare is not the write reaching
  // the isolate that answers the next dispatch (cp#164, measured live). First read happens
  // immediately, so a studio that is already current returns instantly.
  const target = bytes === null ? null : Number(bytes);
  const probeStarted = deps.now();
  let servedAfter: number | null = null;
  let used: number | null = usedBefore;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const reading = await readStudioStorage(deps, script, studioApiToken);
    if (reading.kind === "read") {
      servedAfter = reading.quota;
      used = reading.used;
    } else {
      // A studio that stopped answering mid-converge is NOT evidence of the old number; it is no
      // reading at all, and reporting the previous value here would invent a fact.
      servedAfter = null;
    }
    if (reading.kind === "read" && servedAfter === target) break;
    if (deps.now() - probeStarted + QUOTA_READBACK_PROBE_MS > QUOTA_READBACK_BUDGET_MS) break;
    await deps.sleep(QUOTA_READBACK_PROBE_MS);
  }
  const readbackElapsed = deps.now() - probeStarted;
  const enforced = servedAfter === target;

  const result: StorageQuotaResult = {
    ok:
      missingBindings.length === 0 &&
      missingSecrets.length === 0 &&
      afterNames.has(STORAGE_QUOTA_VAR) === (bytes !== null) &&
      enforced,
    script,
    quota_bytes: bytes,
    already_present: alreadyPresent,
    var_present_after: afterNames.has(STORAGE_QUOTA_VAR),
    bindings_before: names(before),
    bindings_after: names(after),
    secrets_before: [...secretsBefore].sort(),
    secrets_after: [...secretsAfter].sort(),
    missing_bindings: missingBindings,
    missing_secrets: missingSecrets,
    served_quota_before: servedBefore,
    served_quota_after: servedAfter,
    used_bytes: used,
    // Stated rather than hidden: the tenant keeps every byte it has, and only the next SUBMIT is
    // denied. An operator lowering a ceiling under a heavy tenant should see that immediately.
    over_on_arrival: target !== null && used !== null && used >= target,
    enforced,
    readback_attempts: attempts,
    readback_elapsed_ms: readbackElapsed,
  };

  deps.log("storage_quota.write", {
    tenant: tenant.id,
    script,
    ok: result.ok,
    quota_bytes: bytes,
    already_present: alreadyPresent,
    var_present_after: result.var_present_after,
    enforced,
    over_on_arrival: result.over_on_arrival,
    readback_attempts: attempts,
    readback_elapsed_ms: readbackElapsed,
    missing_bindings: missingBindings,
    missing_secrets: missingSecrets,
  });

  return result;
}
