// Env contract for the full provision e2e (#4). Every CREDENTIAL is required for LIVE; nothing is
// invented. The one value deliberately NOT required is the KEK -- see below.

import { randomBytes } from "node:crypto";

declare const process: { env: Record<string, string | undefined> };

export interface ProvisionE2eEnv {
  cfToken: string;
  cfAccountId: string;
  runpodKey: string;
  studioReleaseDir: string;
  studioTokenKek: string;
  dispatchNamespace: string;
  moduleNamespace: string;
  spendDailyCeiling: string;
  workersDevSubdomain: string;
}

/**
 * The KEK this suite runs under is EPHEMERAL, generated per process, and that is the correct
 * value -- not a convenience.
 *
 * STUDIO_TOKEN_KEK was on the required-credential list for a week and blocked #4 the whole time,
 * on the belief that the suite needed the live worker's KEK. It does not, and supplying that one
 * would be actively wrong. The suite drives `runProvisionJob` over a `MemoryStore` (tests/
 * memory-store.ts) against a tenant it creates in this process. The KEK encrypts that fresh
 * tenant's newly minted STUDIO_API_TOKEN (provisioner.ts, setTenantStudioToken) and decrypts it
 * again in the same run for the studio call and for teardown. Both ends are in-process and
 * symmetric, so the key has no external referent: no ciphertext generated here outlives the run,
 * and no ciphertext from anywhere else is ever read.
 *
 * The production KEK, by contrast, is the key to 7 live tenants' `studio_token_enc` in the
 * control-plane D1. Putting it in a test harness (and therefore in CI secrets, where it has never
 * been) would widen the custody of the one credential in this system stored as a usable value, to
 * buy nothing -- the round trip is identical under any valid key.
 *
 * This is a real 32-byte key exercising the real AES-256-GCM path in token-crypto.ts, not a stub:
 * a wrong-length or malformed key still fails exactly as it would in production.
 *
 * Deliberately NOT overridable from the environment. An override is the seam through which the
 * production KEK gets pasted in "just to check something", which is the exact custody widening
 * this comment exists to prevent.
 */
const EPHEMERAL_KEK = randomBytes(32).toString("base64");

function required(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/** True only when PROVISION_E2E=1 and every live credential + harness knob is present. */
export function provisionE2eLive(): boolean {
  if (process.env.PROVISION_E2E !== "1") return false;
  return provisionE2eEnvOrThrow(false) !== null;
}

/**
 * Parse the live env contract. When `throwOnMissing` is true, lists every absent var; otherwise
 * returns null if anything is missing (for skipIf gates).
 */
export function provisionE2eEnvOrThrow(throwOnMissing: boolean): ProvisionE2eEnv | null {
  const need = [
    "CF_PROVISIONER_TOKEN",
    "CF_ACCOUNT_ID",
    "RUNPOD_API_KEY",
    "STUDIO_RELEASE_DIR",
    "PROVISION_E2E_WORKERS_DEV_SUBDOMAIN",
  ] as const;

  const missing = need.filter((k) => !required(k));
  if (missing.length > 0) {
    if (throwOnMissing) {
      throw new Error(
        `provision e2e missing env: ${missing.join(", ")}. See vivijure-control-plane#4 and test header.`,
      );
    }
    return null;
  }

  return {
    cfToken: required("CF_PROVISIONER_TOKEN")!,
    cfAccountId: required("CF_ACCOUNT_ID")!,
    runpodKey: required("RUNPOD_API_KEY")!,
    studioReleaseDir: required("STUDIO_RELEASE_DIR")!,
    studioTokenKek: EPHEMERAL_KEK,
    dispatchNamespace: process.env.DISPATCH_NAMESPACE ?? "vivijure-tenants",
    moduleNamespace: process.env.TENANT_MODULE_NAMESPACE ?? "vivijure-tenant-modules",
    spendDailyCeiling: process.env.TENANT_SPEND_DAILY_CEILING ?? "25",
    workersDevSubdomain: required("PROVISION_E2E_WORKERS_DEV_SUBDOMAIN")!,
  };
}
