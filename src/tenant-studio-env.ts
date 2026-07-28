// The tenant studio's platform-env contract (#116).
//
// WHY THIS FILE EXISTS: the studio reads its configuration through a contract it declares
// (ORCHESTRATOR_VAR_KEYS in the studio source). The provisioner binds a hand-written set of vars
// onto each tenant studio. Those were two independent lists with no link between them, so they
// drifted, and the drift was invisible until a tenant FIRST RENDER: R2_S3_ENDPOINT was never bound,
// presign threw its required-vars error, and the film poll kept 500ing with the keyframe already
// rendered and sitting in R2.
//
// HOW THE LINK WORKS NOW (cf#85): the studio contract arrives in the PINNED RELEASE MANIFEST as
// `required_vars`, not as a source import. This file used to import ORCHESTRATOR_VAR_KEYS directly
// out of the studio tree, which is precisely the cross-repo coupling the extraction removes. The
// guarantee moved from compile time to provision time and did NOT weaken:
// assertDispositionCoversContract() runs against the artifact we actually pinned, BEFORE any tenant
// resource is created, so a studio var with no disposition here refuses the provision by name.
//
// Every key the release declares needs an explicit disposition below, and the tests assert both that
// an undecided var is refused (with a positive control, so the refusal cannot pass vacuously) and
// that everything marked `provisioned` is really present in what the provisioner uploads.
//
// "Looks optional" is exactly the assumption that produced that outage, so each entry carries the
// REASON, and every "absent is fine" claim below was verified against the reading code rather than
// assumed from the name.


/**
 * - `provisioned`: the provisioner MUST bind it, always; the test asserts it appears in the upload
 *   and the provision-time verify census refuses a studio without it.
 * - `conditional`: bound only when the operator supplies a value. It cannot join the required set --
 *   requiring a var that is legitimately absent would fail every provision that did not configure
 *   it, which is a worse defect than the one this file exists to prevent.
 * - `default`: deliberately NOT bound; the studio's behaviour with it absent is correct AND safe,
 *   and the entry says what that behaviour is.
 * - `not-hosted`: belongs to a deployment shape the hosted tier does not run (Access auth, the
 *   public demo studio, test mocks). Binding it would be meaningless or harmful.
 */
export type VarDisposition = "provisioned" | "conditional" | "default" | "not-hosted";

export const TENANT_STUDIO_VAR_DISPOSITION: Record<string, { disposition: VarDisposition; why: string }> = {
  // ---- provisioned ---------------------------------------------------------------------------
  AUTH_MODE: {
    disposition: "provisioned",
    why: 'bound to "token": the dispatcher injects the owner bearer and the studio fail-closed-denies everyone else',
  },
  R2_S3_BUCKET: {
    disposition: "provisioned",
    why: "the tenant's own bucket; one of the four values r2-presign.ts requires",
  },
  R2_S3_ENDPOINT: {
    disposition: "provisioned",
    why:
      "THE #116 DEFECT. r2-presign.ts requires it and THROWS without it, so the keyframe->clips " +
      "handoff died on every poll. Constructed, not minted: https://<account>.r2.cloudflarestorage.com, " +
      "the same endpoint the provisioner already hands the RunPod templates. Self-host derives it from " +
      "CLOUDFLARE_ACCOUNT_ID at deploy, so its absence here was also a parity break",
  },
  SPEND_DAILY_CEILING: {
    disposition: "conditional",
    why:
      "bound from deps.spendDailyCeiling. The conditional label describes the TYPE (string or null), " +
      "not what this deploy does: productionDeps supplies TENANT_SPEND_DAILY_CEILING with a 25 " +
      "fallback, so the value is never null and the var is bound on EVERY provision here. " +
      "Live-confirmed present on the testbed tenant studio (cf#56). It stays out of the required " +
      "set because a plane that configured no ceiling is still a valid deployment shape and " +
      "requiring it would fail those provisions outright, but on THIS plane a tenant without a " +
      "ceiling is not a state that occurs",
  },

  R2_STORAGE_QUOTA_BYTES: {
    disposition: "conditional",
    why:
      "cp#183: the per-tenant storage ceiling, bound from deps.storageQuota.bytes (plane var " +
      "TENANT_R2_STORAGE_QUOTA_BYTES). vivijure-core v1.3.0 enforces it at submit with an honest " +
      "507; unset = no ceiling, which is what core reads an absent knob as, so the var is bound " +
      "only when this plane configures a number. NOT `provisioned`, for the ABUSE_REPORT_URL " +
      "reason rather than any doubt that it gets bound: `provisioned` joins " +
      "REQUIRED_TENANT_STUDIO_VARS, which the MODULE upgrade re-checks in its verify census, and " +
      "that path never touches studio bindings -- so requiring it would fail an unrelated module " +
      "upgrade on every tenant not yet converged and strand it. A studio without it is fully " +
      "functional, uncapped, which is the deliberate self-host default. THE DISPOSITION ITSELF IS " +
      "LOAD-BEARING: vivijure-cf v1.12.0 declares this var in its release manifest, so with no " +
      "entry here assertDispositionCoversContract refused EVERY provision and EVERY studio " +
      "upgrade on the pinned release, which is exactly what the guard is for"
  },

  R2_STORAGE_QUOTA_MODE: {
    disposition: "conditional",
    why:
      "cp#195: what the ceiling MEANS, bound from deps.storageQuota.mode (plane var " +
      "TENANT_R2_STORAGE_QUOTA_MODE). vivijure-core v1.4.0 reads `deny` (a hard cap, the DEFAULT " +
      "and byte-identical to core#52) or `meter` (an included quota, nothing refused, the biller " +
      "meters overage). Bound ONLY when this plane configures `meter`, because core defaults to " +
      "`deny` and binding the default would spend a var slot to change nothing -- so a studio on a " +
      "plane that has not asked for metering is byte-identical to today. `conditional` for the " +
      "same reason as the ceiling next door rather than any doubt it gets bound: `provisioned` " +
      "joins REQUIRED_TENANT_STUDIO_VARS, which the MODULE upgrade re-checks in a path that never " +
      "touches studio bindings, so requiring it would fail an unrelated module upgrade on every " +
      "tenant not yet converged. THE ENTRY EXISTS AHEAD OF ITS MANIFEST ENTRY ON PURPOSE: the cf " +
      "release that declares this var in required_vars must land AFTER this disposition is " +
      "deployed, or assertDispositionCoversContract refuses every provision and every upgrade on " +
      "the pinned release, which is exactly what v1.12.0 did",
  },

  ABUSE_REPORT_URL: {
    disposition: "conditional",
    why:
      "cp#164: the hosted intake page this deploy publishes, DERIVED from CONTROL_PLANE_HOST and " +
      "bound by every studio write path (provision, studio upgrade, and the admin converge route). " +
      "Deliberately NOT `provisioned`, for a reason that is about blast radius rather than about " +
      "how sure we are it gets bound: `provisioned` joins REQUIRED_TENANT_STUDIO_VARS, which the " +
      "MODULE upgrade re-checks in its verify census (runModuleSteps), and that path never touches " +
      "studio bindings -- so requiring it would fail an unrelated module upgrade on every tenant " +
      "not yet converged, and strand it. A studio without the var is fully functional: the panel " +
      "renders no link, which is the deliberate self-host behaviour, not a degrade. The write is " +
      "proven where it is made, by reading host.abuse_report_url back off the studio",
  },

  // ---- deliberately absent, safe default VERIFIED in the reading code -------------------------
  ALLOW_UNAUTHENTICATED: {
    disposition: "default",
    why: 'access-auth.ts allows only on the exact string "true"; absent = DENY. Binding it would open the studio',
  },
  SPEND_LIMIT_FAIL_CLOSED: {
    disposition: "default",
    why: 'rate-limit.ts returns `env.SPEND_LIMIT_FAIL_CLOSED !== "false"`, so absent = fail-CLOSED, the safe posture',
  },
  FILM_CLIP_DURATION_FLOOR: {
    disposition: "default",
    why: "optional tuning; resolveClipDurationFloor falls back to the core default when unset",
  },

  // ---- not applicable to a hosted tenant -----------------------------------------------------
  ACCESS_TEAM_DOMAIN: {
    disposition: "not-hosted",
    why: "Cloudflare Access auth; hosted tenants authenticate by dispatcher-injected token instead",
  },
  ACCESS_AUD: { disposition: "not-hosted", why: "Cloudflare Access auth, same as ACCESS_TEAM_DOMAIN" },
  PLANNER_AI_MOCK: { disposition: "not-hosted", why: "test-only planner mock; absent = the real planner" },
  DEMO_RENDER_ENABLED: { disposition: "not-hosted", why: "public demo studio only; absent = off" },
  DEMO_ARTIFACT_ORIGIN: { disposition: "not-hosted", why: "public demo studio only" },
  DEMO_ASSISTANT_MODEL: { disposition: "not-hosted", why: "public demo studio only" },
  DEMO_RENDER_PER_IP_DAILY: { disposition: "not-hosted", why: "public demo studio only" },
  DEMO_RENDER_GLOBAL_DAILY: { disposition: "not-hosted", why: "public demo studio only" },
  DEMO_RENDER_QUEUE_DEPTH: { disposition: "not-hosted", why: "public demo studio only" },
  DEMO_CHAT_PER_IP_DAILY: { disposition: "not-hosted", why: "public demo studio only" },
  DEMO_CHAT_GLOBAL_DAILY: { disposition: "not-hosted", why: "public demo studio only" },
};

/** The vars a tenant studio MUST carry. Derived from the map, so it cannot drift from it. */
export const REQUIRED_TENANT_STUDIO_VARS: string[] = Object.entries(TENANT_STUDIO_VAR_DISPOSITION)
  .filter(([, v]) => v.disposition === "provisioned")
  .map(([k]) => k)
  .sort();

/**
 * The account-scoped R2 S3 endpoint (r2-presign.ts:10). Constructed from the account id, never
 * minted or stored: it is an identifier, not a credential.
 */
export const r2S3Endpoint = (accountId: string): string => `https://${accountId}.r2.cloudflarestorage.com`;

/**
 * Assert this map has a deliberate disposition for every var the PINNED RELEASE declares (cf#85).
 *
 * THIS REPLACES A COMPILE-TIME GUARANTEE, and the swap is the point. The map used to be keyed by
 * `(typeof ORCHESTRATOR_VAR_KEYS)[number]`, imported from the studio source tree, so adding a studio
 * var broke OUR build. That import crossed the repo seam the extraction removes, so the check moves
 * from "the type of a constant we import" to "the required_vars the artifact we pinned declares".
 *
 * The PURPOSE is unchanged and must stay unchanged: a new studio var gets a deliberate decision here
 * instead of being silently unbound. That is the #116 defect class, where the studio contract and the
 * provisioner bind list drifted with nothing connecting them, and it surfaced only at a tenant FIRST
 * RENDER as an opaque 500.
 *
 * Called at provision time against `built.requiredVars`, so an unknown var fails the provision
 * loudly rather than producing a studio that is quietly missing something it reads.
 */
export function assertDispositionCoversContract(requiredVars: readonly string[]): void {
  const undecided = requiredVars.filter((k) => !(k in TENANT_STUDIO_VAR_DISPOSITION));
  if (undecided.length > 0) {
    throw new Error(
      `the pinned studio release declares ${undecided.length} var(s) with no disposition in ` +
        `tenant-studio-env.ts: ${undecided.join(", ")}. Add each one with its reason ` +
        `(provisioned / conditional / default / not-hosted) rather than leaving it unbound.`,
    );
  }
}
