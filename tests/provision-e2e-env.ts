// Env contract for the full provision e2e (#4). Every value is required for LIVE; nothing is invented.

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
    "STUDIO_TOKEN_KEK",
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
    studioTokenKek: required("STUDIO_TOKEN_KEK")!,
    dispatchNamespace: process.env.DISPATCH_NAMESPACE ?? "vivijure-tenants",
    moduleNamespace: process.env.TENANT_MODULE_NAMESPACE ?? "vivijure-tenant-modules",
    spendDailyCeiling: process.env.TENANT_SPEND_DAILY_CEILING ?? "25",
    workersDevSubdomain: required("PROVISION_E2E_WORKERS_DEV_SUBDOMAIN")!,
  };
}
