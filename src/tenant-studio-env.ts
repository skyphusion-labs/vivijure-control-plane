// The tenant studio's platform-env contract (#116).
//
// WHY THIS FILE EXISTS: the studio reads its configuration through ORCHESTRATOR_VAR_KEYS
// (src/platform/cf-platform.ts). The provisioner binds a hand-written set of vars onto each tenant
// studio. Those were two independent lists with no link between them, so they drifted, and the drift
// was invisible until a tenant's FIRST RENDER: R2_S3_ENDPOINT was never bound, presign threw its
// required-vars error, and the film poll 500'd forever with the keyframe already rendered and
// sitting in R2.
//
// The lists are linked here. Every key in the platform contract needs an explicit disposition below,
// and a test asserts both that the map is exhaustive (a new core var fails CI) and that everything
// marked `provisioned` is actually present in what the provisioner uploads.
//
// "Looks optional" is exactly the assumption that produced that outage, so each entry carries the
// REASON, and every "absent is fine" claim below was verified against the reading code rather than
// assumed from the name.

import { ORCHESTRATOR_VAR_KEYS } from "../platform/cf-platform";

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

export const TENANT_STUDIO_VAR_DISPOSITION: Record<(typeof ORCHESTRATOR_VAR_KEYS)[number], { disposition: VarDisposition; why: string }> = {
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
      "bound ONLY when the operator configures a ceiling (deps.spendDailyCeiling). Deliberately not " +
      "in the required set: a tenant provisioned without a configured ceiling is a valid state, and " +
      "requiring it would fail those provisions outright",
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
