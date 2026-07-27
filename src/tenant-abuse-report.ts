// cp#164: the plane SETS the abuse-report URL the tenant studio panel READS.
//
// THE GAP THIS CLOSES. cp#130 shipped the intake page and the front-door link, and vivijure-cf
// v1.10.0 shipped the READER: src/abuse-contact.ts validates ABUSE_REPORT_URL and src/index.ts
// projects it onto GET /api/modules as host.abuse_report_url, which public/abuse-link.js renders
// from as its sole signal. Nothing in this plane ever wrote that var (repo-wide grep: zero hits),
// so the reader shipped with nothing to read and a hosted tenant studio -- the surface where hosted
// content is actually SEEN -- could not show a reporter anywhere to go. Under the report-driven
// enforcement ruling, intake is the entire detection surface, so an unreachable intake path is a
// thin detection surface by construction.
//
// WHY THE VALUE IS DERIVED AND NOT CONFIGURED. The page is served by THIS worker, out of this
// repository public/report-abuse.html, at the deployment host the plane already holds as a single
// fact (CONTROL_PLANE_HOST; PUBLIC_ORIGIN and the tenant domain suffix are derived from it for
// exactly this reason -- three names for one fact is a drift generator, and the mismatch only ever
// fails in production). So the URL is a FACT OF THE DEPLOY, not an operator preference, and it is
// derived through publicOrigin() like every other. A second env var here could disagree with the
// page we actually serve; a derivation cannot. It is also what keeps this parity-correct rather
// than us-specific: another operator running this plane on their own host gets THEIR intake page,
// not ours, with no code change and no hardcoded hostname anywhere.
//
// THE CANONICAL PATH IS /report-abuse, verified live 2026-07-27 rather than read off the markup:
// GET /report-abuse returns 200 directly, and /report-abuse.html (the link text on the front door)
// returns 307 to it. We bind the 200, not the redirect: a reporter following a link is a person we
// should not be spending a round trip on, and the studio panel puts this string straight into an
// href where the extensionless form is the one the assets handler serves.
//
// HOSTED-ONLY, AND IT IS LOAD-BEARING (cp#130 parity caveat, restated because it is easy to erode).
// A self-hosted studio must NEVER advertise abuse@skyphusion.org: we are not the provider for a
// self-hoster, we cannot see their studio and cannot act on their content, so sending a reporter to
// us is worse than sending them nowhere. That property is structural here, not a policy anyone has
// to remember: the value is computed from the CONTROL PLANE env, inside the control plane, and the
// studio bytes we upload are the published release unmodified. Nothing in this file can reach the
// bundle a self-hoster installs. Their unset var rendering nothing is the correct behaviour, and it
// stays correct mid-rollout for a hosted tenant we have not converged yet.
//
// THE READBACK RACES EDGE PROPAGATION, and this was measured on the live testbed rather than
// reasoned about (cp#164 acceptance run, 2026-07-27). The FIRST converge on `rollins-e2e` bound the
// var cleanly -- 19 bindings to 20, nothing stranded, all four secrets intact -- and the studio
// still served no `host.abuse_report_url`, so the route answered 409 and told the operator to move
// the studio bytes. Sixty seconds later the same call returned `reader_live: true` with the URL,
// twice in a row. The studio was fine the whole time; the settings PATCH had simply not reached the
// isolate serving that dispatch by the time we asked.
//
// That is the cf#114 lesson arriving from a new direction -- "the secrets PUT returning 200 does NOT
// mean the edge serves the key yet" -- and the first cut of this file did not apply it to its own
// readback. The failure is expensive in the wrong direction: a 409 saying "move the studio bytes"
// sends an operator to move a live tenant onto a new release to fix a problem that did not exist.
// So the confirm is now BOUNDED-RETRIED, and an unconfirmed readback is reported as 202 (bound, not
// yet observed, re-run) rather than 409 (go do something else). Both possible causes are named in
// the message, because from here they are genuinely indistinguishable: a bundle predating the reader
// and an edge that has not recycled both answer with the key absent.
//
// THE READER FLOOR, and why it is a READBACK rather than a version compare. Setting this var on a
// studio whose bundle predates the reader (vivijure-cf v1.10.0) is a silent no-op -- the cf#98 /
// cf#118 / cp#112 failure family, a change that looks applied and reaches nobody. cp#136 guards its
// var with a PRE-write capability probe, but that shape is unavailable here: the panel emits
// host.abuse_report_url ONLY when the var is already set, so its absence before a write proves
// nothing at all. The honest check is therefore the other way round -- write, then ASK THE STUDIO
// what it serves. A studio that echoes the URL back has proven the reader is live in the bytes it
// is running; one that does not has proven the write reached nobody, and the route reports that
// rather than a green it has not earned. A served field is the tenant assertion about itself; a
// release number is our claim about it, and this file deliberately does not compare STUDIO_RELEASE
// strings.

import type { WorkerBinding } from "./cf-api";
import { publicOrigin, type ControlPlaneEnv } from "./env";
import type { ProvisionDeps } from "./provisioner";
import type { Tenant } from "./store";
import { decryptStudioToken } from "./token-crypto";

/**
 * How long to keep asking the studio whether it serves the URL yet, and how often.
 *
 * MEASURED, not picked: the live cp#164 converge needed more than one immediate read and less than
 * one minute (see the header). The budget is deliberately SHORT of that worst case rather than
 * generous, because this runs inside a request: the honest answer when it does not converge in time
 * is "bound, not yet observed, re-run me", and the route is idempotent so a re-run costs nothing.
 * Making the budget long enough to always win would trade an operator's clarity for their patience.
 */
export const READBACK_PROBE_MS = 2500;
export const READBACK_BUDGET_MS = 15000;

/** The studio var the panel reads (vivijure-cf src/abuse-contact.ts). Named once; every writer imports it. */
export const ABUSE_REPORT_URL_VAR = "ABUSE_REPORT_URL";

/** The path the intake page is SERVED at. `/report-abuse.html` 307s here; we bind the 200. */
export const ABUSE_REPORT_PATH = "/report-abuse";

/** The asset that path resolves to. Held so a test can prove the derived URL names a page we ship. */
export const ABUSE_REPORT_ASSET = "report-abuse.html";

/**
 * The intake URL for THIS deploy, or null when the plane does not know its own host.
 *
 * Null is not a degraded mode with an opinion attached: it means we cannot name a page we are sure
 * we serve, and binding a var that points at a guess would send reporters somewhere worse than
 * nowhere. Unset renders nothing, which is the deliberate behaviour on both hosts.
 */
export function hostedAbuseReportUrl(env: ControlPlaneEnv): string | null {
  if (!env.CONTROL_PLANE_HOST || env.CONTROL_PLANE_HOST.trim() === "") return null;
  return `${publicOrigin(env)}${ABUSE_REPORT_PATH}`;
}

/**
 * The projection onto a studio binding set. Empty when there is no URL, because ABSENT is the state
 * the panel reads as "no intake to advertise" -- not a value meaning absent.
 */
export function abuseReportUrlBindings(url: string | null): WorkerBinding[] {
  if (!url) return [];
  return [{ type: "plain_text", name: ABUSE_REPORT_URL_VAR, text: url }];
}

/**
 * Carry a binding set forward while RE-DERIVING this one var from plane config.
 *
 * Every studio write path calls this, and the reason is the cp#136 reason from both directions: a
 * non-secret binding omitted from an upload or a settings patch is DROPPED, while an inherited one
 * SURVIVES. So dropping is how a plane that no longer publishes an intake page stops advertising a
 * dead one, and re-adding is how the URL reaches a studio that never had it. Filtering first makes
 * the outcome depend on plane config alone rather than on what happened to be bound already, which
 * is what converges a studio carrying a URL from a previous host.
 */
export function withAbuseReportUrl(carried: WorkerBinding[], url: string | null): WorkerBinding[] {
  return [...carried.filter((b) => b.name !== ABUSE_REPORT_URL_VAR), ...abuseReportUrlBindings(url)];
}

export interface AbuseReportUrlRefusal {
  code:
    | "not_provisioned"
    | "tenant_deleted"
    | "plane_has_no_intake_url"
    | "tenant_studio_token_missing"
    | "tenant_studio_token_unreadable"
    | "studio_not_serving";
  status: number;
  message: string;
}

export interface AbuseReportUrlContext {
  script: string;
  studioApiToken: string;
  url: string;
  /** What the studio served for host.abuse_report_url BEFORE the write, verbatim, or null. */
  servedBefore: string | null;
}

export type AbuseReportUrlPreflight =
  | { ok: true; context: AbuseReportUrlContext }
  | { ok: false; refusal: AbuseReportUrlRefusal };

/** The READBACK, not our opinion of the write. */
export interface AbuseReportUrlResult {
  ok: boolean;
  script: string;
  /** What the plane bound. Reported so an operator never has to re-derive it from config. */
  url: string;
  /** True when the tenant already carried the var; the PATCH still runs (it converges the value). */
  already_present: boolean;
  var_present_after: boolean;
  bindings_before: string[];
  bindings_after: string[];
  secrets_before: string[];
  secrets_after: string[];
  /** Present before and absent after. MUST be empty; non-empty is the strand every write path fears. */
  missing_bindings: string[];
  missing_secrets: string[];
  /** What the STUDIO serves for host.abuse_report_url, before and after. The reader-side half. */
  served_url_before: string | null;
  served_url_after: string | null;
  /**
   * Did the studio project the URL back, after the bounded confirm.
   *
   * False no longer means "the bundle is too old" on its own, and the first cut of this file was
   * wrong to say so: it means the studio had not served the URL by the end of the budget, which is
   * EITHER a bundle predating the vivijure-cf v1.10.0 reader OR an edge that has not picked the
   * binding up yet. The two are indistinguishable from here, so the caller is told both and told to
   * re-run rather than sent to move a live tenant's bytes.
   */
  reader_live: boolean;
  /** How many times the studio was asked, and over how long. Numbers, so nobody parses a sentence. */
  readback_attempts: number;
  readback_elapsed_ms: number;
}

const names = (list: { name: string }[]): string[] => list.map((b) => b.name).sort();

/**
 * Ask the studio what it currently advertises as its intake URL.
 *
 * Returns `undefined` when the studio could not be read at all, and `null` when it answered and the
 * key is absent. Those are different facts and the callers treat them differently: unreadable is a
 * refusal (we cannot establish anything), absent is either "no var yet" (before) or the reader floor
 * (after).
 */
async function servedAbuseReportUrl(
  deps: ProvisionDeps,
  script: string,
  studioApiToken: string,
): Promise<string | null | undefined> {
  let res: { status: number; text: string };
  try {
    res = await deps.callTenantStudio(script, { method: "GET", path: "/api/modules", studioApiToken });
  } catch {
    return undefined;
  }
  if (res.status >= 300) return undefined;
  try {
    const body = JSON.parse(res.text) as { host?: { abuse_report_url?: unknown } };
    const value = body?.host?.abuse_report_url;
    return typeof value === "string" ? value : null;
  } catch {
    return undefined;
  }
}

/**
 * Everything that can refuse, checked BEFORE anything is written.
 *
 * The studio read here is not ceremony: it establishes the BEFORE state for the evidence, and it
 * refuses a tenant whose studio cannot be read at all rather than patching a binding set onto
 * something whose behaviour we cannot then check.
 */
export async function preflightAbuseReportUrl(
  deps: ProvisionDeps,
  tenant: Tenant,
): Promise<AbuseReportUrlPreflight> {
  const refuse = (
    code: AbuseReportUrlRefusal["code"],
    status: number,
    message: string,
  ): AbuseReportUrlPreflight => ({ ok: false, refusal: { code, status, message } });

  if (tenant.deleted_at !== null) return refuse("tenant_deleted", 404, "this tenant no longer exists");
  if (!tenant.script_name) {
    return refuse(
      "not_provisioned",
      409,
      "this tenant has no studio script recorded, so there is no studio to advertise an intake path " +
        "on; it needs a provision, not a binding patch",
    );
  }
  if (!deps.abuseReportUrl) {
    return refuse(
      "plane_has_no_intake_url",
      409,
      "this plane cannot name its own abuse-report page (CONTROL_PLANE_HOST is unset), so there is " +
        "nothing to advertise; fix the deploy config, then re-run",
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

  const servedBefore = await servedAbuseReportUrl(deps, tenant.script_name, studioApiToken);
  if (servedBefore === undefined) {
    return refuse(
      "studio_not_serving",
      422,
      "the tenant studio did not answer GET /api/modules with readable JSON, so what it advertises " +
        "cannot be established; fix that before writing to it",
    );
  }
  return {
    ok: true,
    context: { script: tenant.script_name, studioApiToken, url: deps.abuseReportUrl, servedBefore },
  };
}

/**
 * Give an EXISTING tenant studio the intake URL, idempotently, and PROVE the panel now serves it.
 *
 * Idempotent by CONVERGENCE rather than by skipping: a tenant that already carries the var is
 * patched anyway with the currently derived URL, so a plane moved to a new host heals its tenants
 * instead of reporting "already present" over a stale address.
 *
 * A BINDING PATCH, NOT A RE-UPLOAD, for the two cp#112 reasons and they both still hold: the plane
 * cannot reproduce two of the four secrets a live tenant studio carries (R2_S3_SECRET_ACCESS_KEY is
 * the hash of an R2 token value we never stored, RUNPOD_API_KEY is key B, transient by ruling), and
 * re-uploading the bundle would move the tenant onto whatever release the plane is pinned to, which
 * is a release change smuggled in as a config fix. Everything we keep travels as `inherit`, so no
 * binding VALUE is handled here at all.
 *
 * NEVER writes tenants.status, tenants.studio_release, or the studio bytes. A live tenant is serving
 * throughout, exactly as the cp#112 refresh and the cp#136 state write are.
 */
export async function applyAbuseReportUrl(
  deps: ProvisionDeps,
  tenant: Tenant,
  context: AbuseReportUrlContext,
): Promise<AbuseReportUrlResult> {
  const { script, studioApiToken, url, servedBefore } = context;

  // Census BEFORE, through the provisioner credential (reads), so a loss is recognisable. Secret
  // NAMES only; these endpoints never return values and this file never wants one.
  const before = await deps.cf.getScriptBindings(deps.namespace, script);
  const secretsBefore = await deps.cf.getScriptSecretNames(deps.namespace, script);
  const alreadyPresent = before.some((b) => b.name === ABUSE_REPORT_URL_VAR);

  const desired = withAbuseReportUrl(
    before.map((b) => ({ type: "inherit" as const, name: b.name })),
    url,
  );
  await deps.scriptUploadCf.patchScriptSettings(deps.namespace, script, desired);

  // Read back through the OTHER credential. `success:true` is the writing client opinion of its own
  // work, and this route risk is a binding set that came back smaller than it went in.
  const after = await deps.cf.getScriptBindings(deps.namespace, script);
  const secretsAfter = await deps.cf.getScriptSecretNames(deps.namespace, script);
  const afterNames = new Set(after.map((b) => b.name));
  const afterSecrets = new Set(secretsAfter);
  const missingBindings = names(before).filter((n) => !afterNames.has(n));
  const missingSecrets = [...secretsBefore].sort().filter((n) => !afterSecrets.has(n));

  // THE READER FLOOR, measured on the artifact and RETRIED, because the write reaching Cloudflare is
  // not the write reaching the isolate that answers the next dispatch (measured live, see header).
  // First read happens immediately, so a studio that is already current still returns instantly.
  const probeStarted = deps.now();
  let servedAfter: string | null = null;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const raw = await servedAbuseReportUrl(deps, script, studioApiToken);
    servedAfter = raw === undefined ? null : raw;
    if (servedAfter === url) break;
    if (deps.now() - probeStarted + READBACK_PROBE_MS > READBACK_BUDGET_MS) break;
    await deps.sleep(READBACK_PROBE_MS);
  }
  const readbackElapsed = deps.now() - probeStarted;

  const result: AbuseReportUrlResult = {
    ok:
      missingBindings.length === 0 &&
      missingSecrets.length === 0 &&
      afterNames.has(ABUSE_REPORT_URL_VAR) &&
      servedAfter === url,
    script,
    url,
    already_present: alreadyPresent,
    var_present_after: afterNames.has(ABUSE_REPORT_URL_VAR),
    bindings_before: names(before),
    bindings_after: names(after),
    secrets_before: [...secretsBefore].sort(),
    secrets_after: [...secretsAfter].sort(),
    missing_bindings: missingBindings,
    missing_secrets: missingSecrets,
    served_url_before: servedBefore,
    served_url_after: servedAfter,
    reader_live: servedAfter === url,
    readback_attempts: attempts,
    readback_elapsed_ms: readbackElapsed,
  };

  deps.log("abuse_report_url.write", {
    tenant: tenant.id,
    script,
    ok: result.ok,
    already_present: alreadyPresent,
    var_present_after: result.var_present_after,
    reader_live: result.reader_live,
    readback_attempts: attempts,
    readback_elapsed_ms: readbackElapsed,
    missing_bindings: missingBindings,
    missing_secrets: missingSecrets,
  });

  return result;
}
