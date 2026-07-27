// cp#139: move a LIVE tenant's STUDIO BYTES onto a newer release, in place, bindings preserved.
//
// THE GAP THIS CLOSES. There was no operation in this plane that moved a live tenant's studio.
// `runProvisionJob` uploads once at creation, `continueProvisionJob` refuses anything short of
// `wfp_upload`, `upgradeTenantModules` deliberately never touches the studio, `refreshStudioBindings`
// (cp#112) changes bindings and explicitly NOT bytes, and teardown deletes. So a tenant whose studio
// predates a feature could be handed the BINDING for that feature and never the CODE that projects
// it -- which is the live state cp#139 records for `rollins-e2e`.
//
// WHY THIS IS SAFE NOW AND WAS NOT BEFORE. The cp#112 divergence ruling gave two reasons for
// bindings-only. Reason 1 was SECRET CUSTODY: a live studio carries secrets the plane cannot
// reproduce (R2_S3_SECRET_ACCESS_KEY is the SHA-256 of an R2 token value we never stored;
// RUNPOD_API_KEY is key B, transient by ruling), so a re-upload that re-states the binding set would
// strand the tenant. That objection was MEASURED AWAY on cp#139 against throwaway scripts:
//
//   - `inherit` works on the UPLOAD endpoint, not just the settings PATCH: new bytes land and a
//     `secret_text` binding survives, with the caller never holding its value.
//   - The omission rule differs by binding class, and this is the one that makes the shape below
//     MANDATORY rather than stylistic: a `plain_text` (and every non-secret) binding omitted from an
//     upload is DROPPED, while a `secret_text` binding installed via `PUT /secrets` SURVIVES
//     omission. So every non-secret binding must be carried forward explicitly, and the way to carry
//     one forward without holding its value is `inherit`.
//   - The ASSETS seam coexists with `inherit` on the same PUT: new assets (session -> bucket upload
//     -> completion JWT) plus `[{inherit ...}, {assets ASSETS}]` preserved everything.
//
// Reason 2 of that ruling STANDS and is why this is a job kind rather than a script: a bytes move IS
// a release change on a live tenant, and this plane already treats that as its own operation with a
// preflight and a from_release/to_release record. Doing it by hand would be exactly the unrecorded
// release change the ruling forbids, just performed manually.
//
// THE STATUS RULE, inherited from upgradeTenantModules and load-bearing for the same reason: this
// NEVER writes tenants.status. Not on entry, not on success, not on failure. A live tenant stays
// live, routing keeps dispatching to its unchanged script_name, and its users keep being served.
// Progress and failure live on the JOB row. A "provisioning-shaped" transit would take a paying
// customer dark on the path where everything went RIGHT.
//
// IN-PLACE ONLY. Never delete-and-recreate: the slug is a lease, the R2 bucket and D1 belong to the
// tenant, and a recreate would mint new credentials the tenant's own resources are not keyed to.
//
// MIGRATIONS RUN FIRST, and they are not optional. The issue's proposed shape did not mention them;
// building it without them would have shipped a defect on the very first real upgrade, because the
// v1.6.0 -> v1.8.0 move ADDS `0012_wan_lora_keys.sql` (measured off the release manifests, not
// assumed). New studio bytes expect the new schema, so the schema goes first; `applyStudioMigrations`
// is tracking-table based and safe against an already-migrated D1, which is what makes "first" also
// mean "idempotent". A release that adds NO migration re-runs this as a no-op.

import { applyStudioMigrations } from "./migrate";
import { type ProvisionDeps, type StudioBundleSource, startLeaseHeartbeat, uploadStudioAssets } from "./provisioner";
import type { Tenant } from "./store";
import { REQUIRED_TENANT_STUDIO_VARS, assertDispositionCoversContract } from "./tenant-studio-env";
import { withAbuseReportUrl } from "./tenant-abuse-report";
import { resolveStorageQuota, withStorageQuota } from "./tenant-storage-quota";
import { withVideoFinishTierState } from "./video-finish-tier-state";
import { decryptStudioToken } from "./token-crypto";

type StudioBundle = Awaited<ReturnType<StudioBundleSource["fetch"]>>;

/** The binding name a tenant studio serves its static UI through; the provision-path constant. */
const ASSETS_BINDING = "ASSETS";

/**
 * A refusal that happens BEFORE anything is written, so the route can answer having touched nothing:
 * no job row, no cleared release, no uploaded byte. Same split as preflightUpgrade and
 * preflightStudioBindings, for the same reason.
 */
export interface StudioUpgradeRefusal {
  code:
    | "not_provisioned"
    | "tenant_deleted"
    | "tenant_suspended"
    | "tenant_not_live"
    | "tenant_d1_missing"
    | "tenant_studio_token_missing"
    | "tenant_studio_token_unreadable"
    | "tenant_studio_not_serving"
    | "studio_bundle_unavailable"
    | "studio_var_contract_undecided"
    // cp#183: the plane configures a storage ceiling that is not a positive integer of bytes, so
    // this move would re-derive an unreadable value onto a live tenant and uncap it.
    | "plane_storage_quota_malformed";
  status: number;
  message: string;
}

/** Everything the run needs, gathered by the preflight so the run does no fetching that can refuse. */
export interface StudioUpgradeContext {
  script: string;
  release: string;
  fromRelease: string | null;
  bundle: StudioBundle;
  studioApiToken: string;
  /** The served `/api/modules` host object BEFORE the move: the content marker acceptance 2 compares. */
  hostBefore: Record<string, unknown> | null;
}

export type StudioUpgradePreflight =
  | { ok: true; context: StudioUpgradeContext }
  | { ok: false; refusal: StudioUpgradeRefusal };

export type StudioUpgradeOutcome =
  | { ok: true; result: StudioUpgradeResult }
  | { ok: false; step: StudioUpgradeStep; message: string; result: StudioUpgradeResult | null };

export type StudioUpgradeStep = "d1_migrate" | "assets_upload" | "wfp_upload" | "verify";

/** What the operator gets back: the READBACK, not our opinion of the write. */
export interface StudioUpgradeResult {
  ok: boolean;
  script: string;
  from_release: string | null;
  to_release: string;
  /** Migrations the tenant D1 was missing and this run applied. Empty is the normal case. */
  migrations_applied: string[];
  /** What we SHIPPED, by content, so the record names an artifact and not a version string. */
  worker_sha256: string;
  worker_size: number;
  assets_shipped: number;
  bindings_before: string[];
  bindings_after: string[];
  secrets_before: string[];
  secrets_after: string[];
  /** Present before and absent after. MUST be empty; non-empty is the strand this route fears. */
  missing_bindings: string[];
  missing_secrets: string[];
  /** Required studio vars absent from the post-state census (#116's contract, re-checked after). */
  missing_required_vars: string[];
  /** The served `/api/modules` host object before and after: acceptance 2's content marker. */
  host_keys_before: string[];
  host_keys_after: string[];
  /** True when the served host object CHANGED. False on a same-release convergence run, honestly. */
  served_shape_changed: boolean;
  /** The status the tenant studio answered on the post-move probe. 2xx/4xx is serving; 5xx is not. */
  serving_status: number;
}

const names = (list: { name: string }[]): string[] => list.map((b) => b.name).sort();

/** Hash of the bytes we SHIPPED, so the job record names an artifact rather than a version string. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A failure carrying the step it happened at, so the job row attributes it correctly. */
export class StudioUpgradeError extends Error {
  constructor(
    readonly step: StudioUpgradeStep,
    message: string,
  ) {
    super(message);
    this.name = "StudioUpgradeError";
  }
}

/**
 * Ask the tenant studio for its module projection and return the `host` object it serves.
 *
 * WHY THE SERVED RESPONSE AND NOT THE RELEASE NUMBER: cp#139's acceptance criterion is a property of
 * what the tenant SERVES, not of the release we believe we shipped. A release string is our claim; a
 * served field is the tenant's own assertion about itself. Returns null when the studio did not
 * answer with parseable JSON, which is reported rather than treated as an empty object -- "we could
 * not read it" and "it served nothing" are different facts.
 */
async function servedHost(
  deps: ProvisionDeps,
  script: string,
  studioApiToken: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await deps.callTenantStudio(script, { method: "GET", path: "/api/modules", studioApiToken });
    if (res.status >= 300) return null;
    const body = JSON.parse(res.text) as { host?: unknown };
    return body && typeof body.host === "object" && body.host !== null ? (body.host as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Everything that can refuse, checked WITHOUT writing.
 *
 * Deliberately NOT a refusal: a target release equal to the tenant's current one. Re-shipping the
 * same release is a legitimate CONVERGENCE/repair run (it is also how a half-finished move is
 * finished), and refusing it would remove the only in-plane way to re-assert a tenant's studio.
 * `served_shape_changed: false` reports that outcome honestly instead of dressing a no-op as a move.
 */
export async function preflightStudioUpgrade(
  deps: ProvisionDeps,
  tenant: Tenant,
  release: string,
): Promise<StudioUpgradePreflight> {
  const refuse = (code: StudioUpgradeRefusal["code"], status: number, message: string): StudioUpgradePreflight => ({
    ok: false,
    refusal: { code, status, message },
  });

  if (!tenant.script_name) {
    return refuse(
      "not_provisioned",
      409,
      "this tenant has no studio script recorded, so there are no bytes to move; it needs a provision, not an upgrade",
    );
  }
  if (tenant.deleted_at !== null) return refuse("tenant_deleted", 404, "this tenant no longer exists");
  // Suspension is the admin kill switch and is checked OFF suspended_at, before the lifecycle,
  // exactly as routing and the module upgrade do it: shipping new code into a suspended tenant
  // would be working around the kill switch.
  if (tenant.suspended_at !== null) {
    return refuse("tenant_suspended", 409, "this tenant is suspended; resume it before upgrading its studio");
  }
  // ONLY a live tenant. An unfinished provision belongs to the resume path, which knows how to finish
  // it; overlapping that here would give one tenant two drivers with different terminal writes.
  if (tenant.status !== "live") {
    return refuse(
      "tenant_not_live",
      409,
      "this tenant is " + tenant.status + ", not live; an unfinished provision belongs to the resume path",
    );
  }
  if (!tenant.d1_database_id) {
    return refuse(
      "tenant_d1_missing",
      422,
      "no tenant D1 recorded, so the release's migrations cannot be applied; a bytes move without its " +
        "schema is how a studio ends up running code its database cannot serve",
    );
  }
  if (!tenant.studio_token_enc) {
    return refuse("tenant_studio_token_missing", 422, "no studio token recorded for this tenant");
  }
  let studioApiToken: string;
  try {
    studioApiToken = await decryptStudioToken(deps.kek, tenant.studio_token_enc);
  } catch (e) {
    return refuse("tenant_studio_token_unreadable", 422, `the stored studio token could not be decrypted: ${String(e)}`);
  }

  // The tenant must be SERVING before we touch it. If it is already broken, this upgrade would be
  // blamed for a fault it did not cause, and "the tenant kept serving" is unverifiable when it was
  // not serving to begin with. Same gate, same reasoning, as preflightModuleUpgrade.
  const probe = await deps.callTenantStudio(tenant.script_name, { method: "GET", path: "/", studioApiToken });
  if (probe.status >= 500) {
    return refuse(
      "tenant_studio_not_serving",
      422,
      `the tenant studio answered ${probe.status} before the upgrade started; fix that first`,
    );
  }

  // Fetch and integrity-check the target bundle BEFORE any write. The likely real failures here are a
  // bad release name or an empty mirror slot, and this turns both into a refusal that has written
  // nothing rather than a tenant left mid-move.
  let bundle: StudioBundle;
  try {
    bundle = await deps.bundle.fetch(release);
  } catch (e) {
    return refuse("studio_bundle_unavailable", 422, `studio bundle ${release} is not usable: ${(e as Error).message}`);
  }

  // The release's OWN env contract, checked against this plane's dispositions (#116/cf#85). A release
  // that declares a var nobody here has decided about must refuse BY NAME rather than ship bytes that
  // read an unbound var at runtime. This is the same assertion the provision path runs, applied where
  // it was missing: an upgrade is the other way new studio bytes reach a tenant.
  try {
    assertDispositionCoversContract(bundle.requiredVars ?? []);
  } catch (e) {
    return refuse("studio_var_contract_undecided", 422, (e as Error).message);
  }

  // cp#183: this move RE-DERIVES the storage ceiling onto the studio, so a malformed plane value
  // would silently uncap a tenant that was capped a moment ago. Refuse before the bytes move, not
  // after: the same reason the provision path refuses, with more at stake because there is a live
  // tenant on the other side.
  const resolvedQuota = resolveStorageQuota(deps.storageQuota, tenant);
  if (resolvedQuota.blocked !== null) {
    return refuse("plane_storage_quota_malformed", 409, resolvedQuota.blocked);
  }

  const hostBefore = await servedHost(deps, tenant.script_name, studioApiToken);

  return {
    ok: true,
    context: {
      script: tenant.script_name,
      release,
      fromRelease: tenant.studio_release,
      bundle,
      studioApiToken,
      hostBefore,
    },
  };
}

/**
 * Move the studio bytes. Never throws (the job row is the record) and never writes tenants.status.
 *
 * ORDER IS THE DESIGN, and each position is load-bearing:
 *   1. NULL `tenants.studio_release` before the first write. From here until success the tenant is
 *      not known to be at any one release and the column must say so; the job row carries
 *      from_release, which is the only place the previous value survives a failure.
 *   2. Migrations (additive, tracked, idempotent) BEFORE bytes, so new code never meets an old schema.
 *   3. Assets, then the script PUT that redeems the completion JWT -- one credential owns both legs.
 *   4. Readback through a DIFFERENT credential than the one that wrote, because success:true is the
 *      writing client's opinion of its own work.
 *
 * NO AUTOMATIC ROLLBACK, deliberately, and for the same reason upgradeTenantModules refuses one:
 * rollback means issuing MORE writes against a tenant that just failed a write, on the path that is
 * already failing, to reach a state nobody has verified is reachable. Rollback here is re-running
 * this route at `from_release`, which the job row preserves precisely because studio_release is
 * NULLed first.
 */
export async function upgradeTenantStudio(
  deps: ProvisionDeps,
  jobId: string,
  tenant: Tenant,
  context: StudioUpgradeContext,
): Promise<StudioUpgradeOutcome> {
  const { script, release, bundle } = context;
  let step: StudioUpgradeStep = "d1_migrate";
  const mark = async (s: StudioUpgradeStep, done: StudioUpgradeStep[]) => {
    step = s;
    done.push(s);
    await deps.store.updateJobProgress(jobId, s, JSON.stringify(done));
    deps.log("studio_upgrade.step", { tenant: tenant.id, job: jobId, step: s, release });
  };
  const done: StudioUpgradeStep[] = [];

  // THE LEASE MUST MEAN A DRIVER IS ALIVE HERE TOO (cp#158, the cp#148 pattern).
  //
  // This driver marks only at step boundaries, and three of its four steps are unbounded remote
  // work: a D1 migration set, an asset upload session, and the script PUT. Any one of them running
  // past JOB_LEASE_SECONDS let the lease lapse under a perfectly healthy upgrade, and lease_until is
  // the column the ONE-writer guard reads (the route refuses a second upgrade on
  // jobHasLiveDriver). A lapsed lease there is not cosmetic: it lets a second POST start a second
  // driver PUTting different bytes into the SAME live studio script, which is the one way this
  // route can reach a state nothing recorded. claimReclaim and beginTeardown read the same column
  // and were reading it just as wrongly.
  //
  // No poll-driven continuation claims a studio_upgrade job today, which is why cp#148 could leave
  // this for a follow-up rather than a fix. That is an argument about who ELSE reads the column, not
  // about whether it tells the truth, and "the lease lies but nothing important reads it yet" is
  // exactly the shape that became cp#148.
  const stopHeartbeat = startLeaseHeartbeat(deps, jobId);
  try {
    await deps.store.setJobRunning(jobId);

    // Census BEFORE anything, through the provisioner credential (reads). Secret NAMES only; these
    // endpoints never return values and this file never wants one.
    const before = await deps.cf.getScriptBindings(deps.namespace, script);
    const secretsBefore = await deps.cf.getScriptSecretNames(deps.namespace, script);

    // (1) The release column stops asserting a uniformity that is about to be untrue.
    await deps.store.setTenantStudioRelease(tenant.id, null);

    // (2) Schema first. Tracked per-migration, so an already-migrated D1 is a no-op and a release
    //     that adds nothing applies nothing.
    let migrationsApplied: string[] = [];
    try {
      const migrated = await applyStudioMigrations(deps.cf, tenant.d1_database_id as string, bundle.migrations);
      migrationsApplied = migrated.applied;
      deps.log("studio_upgrade.migrate", {
        tenant: tenant.id,
        applied: migrated.applied,
        seeded: migrated.seeded,
      });
    } catch (e) {
      throw new StudioUpgradeError("d1_migrate", `tenant D1 migration failed: ${(e as Error).message}`);
    }
    await mark("d1_migrate", done);

    // (3) Assets, then the script. The upload credential owns BOTH legs: the completion JWT is minted
    //     by one client and redeemed by another, and "it probably does not care which token" is the
    //     assumption this repo keeps getting burned by.
    let assetsJwt: string | undefined;
    try {
      if (bundle.assets?.length) assetsJwt = await uploadStudioAssets(deps, tenant.slug, bundle.assets);
    } catch (e) {
      throw new StudioUpgradeError("assets_upload", `studio asset upload failed: ${(e as Error).message}`);
    }
    await mark("assets_upload", done);

    // THE BINDING SET, and every part of this shape is a measurement rather than a preference.
    //
    // Every censused binding travels as `inherit`: a non-secret binding omitted from an upload is
    // DROPPED, and `inherit` is the documented way to carry one forward WITHOUT holding its value --
    // which is what lets this run against a tenant whose secrets the plane cannot reproduce.
    //
    // The ASSETS binding is the one exception, declared as `assets` rather than inherited, because
    // this upload ships NEW asset bytes and the completion JWT has to attach to a declared assets
    // binding. That exact combination (`inherit` bindings alongside `{assets}`) is the cp#139 probe-3
    // shape, which lost nothing.
    const assetsBindingName = before.find((b) => b.type === "assets")?.name ?? ASSETS_BINDING;
    //
    // ONE binding does NOT travel as `inherit`, and it is the cp#136 var. `inherit` PRESERVES what is
    // already bound, which is exactly wrong for a projection: a tenant whose unreachable declaration
    // was CLEARED would carry VIDEO_FINISH_TIER_STATE across this move and keep displaying a sentence
    // the plane no longer believes. So it is stripped out of the carried set and re-derived from the
    // record, which converges the studio in BOTH directions (omitted = dropped, re-added = set).
    //
    // The cp#164 var is re-derived for the SAME reason and it is not a second special case, it is
    // the same one: ABUSE_REPORT_URL is a projection of plane config onto the studio, so carrying it
    // as `inherit` would preserve a URL from a plane that no longer publishes that page. Re-deriving
    // converges in both directions, and it is also the door this bytes move opens for cp#164 -- a
    // tenant that predated the var gets it as a side effect of any studio upgrade.
    //
    // The cp#183 ceiling is re-derived for the SAME reason, and it is the case where `inherit` is
    // most obviously wrong: a plane that RAISED or LIFTED its storage quota would otherwise carry
    // the old number across every bytes move, so the tenant would keep enforcing a ceiling nobody
    // configures any more. Re-deriving converges in both directions, and it is also the door this
    // move opens for cp#183 -- a tenant provisioned before the var existed gets it as a side effect
    // of any studio upgrade, which is the ONLY way an already-live tenant would otherwise get it
    // without an operator running the converge route by hand.
    const bindings = withStorageQuota(
      withAbuseReportUrl(
        withVideoFinishTierState(
          [
            ...before
              .filter((b) => b.name !== assetsBindingName)
              .map((b) => ({ type: "inherit" as const, name: b.name })),
            { type: "assets" as const, name: assetsBindingName },
          ],
          tenant,
        ),
        deps.abuseReportUrl,
      ),
      // Re-derived from the RECORD-plus-plane resolution, not from the plane alone: a tenant that
      // recorded its own ceiling (or recorded that it has none) must not have that decision
      // overwritten by a bytes move it did not ask for.
      resolveStorageQuota(deps.storageQuota, tenant).bytes,
    );

    try {
      await deps.scriptUploadCf.uploadUserWorker({
        namespace: deps.namespace,
        scriptName: script,
        mainModule: bundle.mainModule,
        moduleText: bundle.moduleText,
        compatibilityDate: bundle.compatibilityDate,
        compatibilityFlags: bundle.compatibilityFlags,
        assetsJwt,
        // The release's own asset handling, verbatim, including {} (#77/#78). Never substitute.
        assetsConfig: bundle.assetsConfig,
        bindings,
      });
    } catch (e) {
      throw new StudioUpgradeError("wfp_upload", `studio script upload failed: ${(e as Error).message}`);
    }
    await mark("wfp_upload", done);

    // (4) Readback through the OTHER credential. This route's whole risk is a binding set that came
    //     back smaller than it went in.
    const after = await deps.cf.getScriptBindings(deps.namespace, script);
    const secretsAfter = await deps.cf.getScriptSecretNames(deps.namespace, script);
    const afterNames = new Set(after.map((b) => b.name));
    const afterSecrets = new Set(secretsAfter);
    const missingBindings = names(before).filter((n) => !afterNames.has(n));
    const missingSecrets = [...secretsBefore].sort().filter((n) => !afterSecrets.has(n));
    // The #116 contract re-checked on the POST state: a required var can be satisfied by a binding or
    // by a secret, so the union is the honest denominator.
    const bound = new Set([...afterNames, ...afterSecrets]);
    const missingRequiredVars = REQUIRED_TENANT_STUDIO_VARS.filter((v) => !bound.has(v));

    // Does it still SERVE, and what does it serve now? Both are the tenant's assertion about itself.
    const probe = await deps.callTenantStudio(script, {
      method: "GET",
      path: "/",
      studioApiToken: context.studioApiToken,
    });
    const hostAfter = await servedHost(deps, script, context.studioApiToken);
    const keysBefore = Object.keys(context.hostBefore ?? {}).sort();
    const keysAfter = Object.keys(hostAfter ?? {}).sort();

    const result: StudioUpgradeResult = {
      ok:
        missingBindings.length === 0 &&
        missingSecrets.length === 0 &&
        missingRequiredVars.length === 0 &&
        probe.status < 500,
      script,
      from_release: context.fromRelease,
      to_release: release,
      migrations_applied: migrationsApplied,
      worker_sha256: await sha256Hex(bundle.moduleText),
      worker_size: bundle.moduleText.length,
      assets_shipped: bundle.assets?.length ?? 0,
      bindings_before: names(before),
      bindings_after: names(after),
      secrets_before: [...secretsBefore].sort(),
      secrets_after: [...secretsAfter].sort(),
      missing_bindings: missingBindings,
      missing_secrets: missingSecrets,
      missing_required_vars: missingRequiredVars,
      host_keys_before: keysBefore,
      host_keys_after: keysAfter,
      served_shape_changed: JSON.stringify(keysBefore) !== JSON.stringify(keysAfter),
      serving_status: probe.status,
    };
    await mark("verify", done);

    if (!result.ok) {
      // A short readback is a FAILED job even though every call returned 200. The tenant is still
      // serving whatever it is serving, and studio_release stays NULL, which is the honest record of
      // "moved, but not verified whole".
      const message =
        "post-upgrade readback is short: " +
        `missing_bindings=[${missingBindings.join(", ")}] missing_secrets=[${missingSecrets.join(", ")}] ` +
        `missing_required_vars=[${missingRequiredVars.join(", ")}] serving_status=${probe.status}`;
      deps.log("studio_upgrade.failed", { tenant: tenant.id, step: "verify", message, release });
      await deps.store.finishJob(jobId, "failed", "verify", message);
      return { ok: false, step: "verify", message, result };
    }

    await deps.store.setTenantStudioRelease(tenant.id, release);
    await deps.store.finishJob(jobId, "succeeded", null, null);
    deps.log("studio_upgrade.succeeded", {
      tenant: tenant.id,
      release,
      migrations_applied: migrationsApplied.length,
      served_shape_changed: result.served_shape_changed,
    });
    // NOTE what is absent and must stay absent: no setTenantStatus call, on any path.
    return { ok: true, result };
  } catch (e) {
    const failedStep = e instanceof StudioUpgradeError ? e.step : step;
    const message = e instanceof Error ? e.message : String(e);
    deps.log("studio_upgrade.failed", { tenant: tenant.id, step: failedStep, message, release });
    await deps.store.finishJob(jobId, "failed", failedStep, message);
    // studio_release stays NULL: the tenant is not known to be uniformly at any release, and the job
    // row carries from_release so a rollback re-run has a target.
    return { ok: false, step: failedStep, message, result: null };
  } finally {
    // Every exit, terminal or thrown. The timer lifetime IS the invocation: when this driver dies
    // the beat dies with it, the lease lapses within one interval, and only then does anything else
    // get to act on this row.
    stopHeartbeat();
  }
}
