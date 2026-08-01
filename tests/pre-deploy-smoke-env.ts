// Env contract for the COMMITTED pre-deploy smoke (cp#255).
//
// Conrad's standing policy, 2026-08-01: a full smoke on a secure surface before EVERY prod
// deployment, every time, no gate. "No gate" means no approval gate and no cost gate; it does not
// mean no smoke. The v1.20.0 run satisfied that policy from a scratch driver in one member's home
// directory, which is a policy that survives exactly as long as that home directory. This file and
// its siblings are that driver, committed.
//
// SMOKE_REQUIRED IS THE WHOLE POINT OF THIS FILE.
//
// Every other live suite in this repo skips silently when its credentials are absent, which is
// correct for a suite that runs opportunistically on a PR. A RELEASE GATE that skips silently is a
// decoration: it reports the same green whether it ran or not, which is the exact shape of the
// changelog guard that once passed by comparing zero released sections and printing ok.
//
// So there are two modes and they are not the same mode:
//   - unset            skip, and say so. The suite is part of `npm test` and must not fail a PR.
//   - SMOKE_REQUIRED=1 a missing credential is a FAILURE, naming every var that is absent.
//
// The workflow that gates a release sets SMOKE_REQUIRED=1. Nothing else does.

declare const process: { env: Record<string, string | undefined> };

/**
 * Every throwaway object this suite creates is named with this prefix, so a run killed halfway
 * leaves debris that is (a) instantly identifiable as test debris rather than something an operator
 * has to reason about, and (b) reapable by prefix. The next run LISTS leftovers loudly rather than
 * deleting them: deleting another session's resource is how you take down someone else's live run.
 */
export const SMOKE_PREFIX = "cpsmoke-";

export interface PreDeploySmokeEnv {
  cfToken: string;
  cfAccountId: string;
  /** Account workers.dev suffix, e.g. `<account>.workers.dev`. The harness dispatcher lives here. */
  workersDevSubdomain: string;
  /**
   * The studio release tag this plane is PINNED to (repo variable STUDIO_RELEASE). The smoke uploads
   * the module bundles from THAT release, because the pinned release is what a tenant would actually
   * receive; smoking against a newer one would prove something nobody is about to ship.
   */
  studioRelease: string;
  /** Where the module bundles come from. Public repo, anonymous HTTPS, no credential. */
  releaseRepo: string;
}

const REQUIRED = [
  "CF_PROVISIONER_TOKEN",
  "CF_ACCOUNT_ID",
  "PRE_DEPLOY_SMOKE_WORKERS_DEV_SUBDOMAIN",
  "STUDIO_RELEASE",
] as const;

function present(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/** True when this run is REQUIRED to be a real run. Set by the release-gate workflow only. */
export function smokeRequired(): boolean {
  return process.env.SMOKE_REQUIRED === "1";
}

/** Env vars the contract asks for that are not set. Names only; never a value. */
export function missingSmokeEnv(): string[] {
  const missing: string[] = REQUIRED.filter((k) => !present(k));
  if (process.env.PRE_DEPLOY_SMOKE !== "1") missing.push("PRE_DEPLOY_SMOKE=1");
  return missing;
}

/** True only when PRE_DEPLOY_SMOKE=1 and every credential and knob is present. */
export function preDeploySmokeLive(): boolean {
  return missingSmokeEnv().length === 0;
}

export function preDeploySmokeEnv(): PreDeploySmokeEnv {
  const missing = missingSmokeEnv();
  if (missing.length > 0) {
    throw new Error(`pre-deploy smoke missing env: ${missing.join(", ")} (cp#255)`);
  }
  return {
    cfToken: present("CF_PROVISIONER_TOKEN")!,
    cfAccountId: present("CF_ACCOUNT_ID")!,
    workersDevSubdomain: present("PRE_DEPLOY_SMOKE_WORKERS_DEV_SUBDOMAIN")!,
    studioRelease: present("STUDIO_RELEASE")!,
    releaseRepo: process.env.STUDIO_RELEASE_REPO ?? "skyphusion-labs/vivijure-cf",
  };
}
