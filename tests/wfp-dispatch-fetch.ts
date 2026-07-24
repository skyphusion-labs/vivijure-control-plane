// Out-of-worker dispatch fetch for live provision e2e (#4).
//
// Production uses TENANT_DISPATCH inside the control plane Worker. Vitest runs on Node, so we reach
// tenant scripts via the dispatch namespace workers.dev subdomain when PROVISION_E2E_WORKERS_DEV_SUBDOMAIN
// is set (the account's *.workers.dev suffix). This is harness-only; tenant prod routes stay off workers.dev.

const FETCH_TIMEOUT_MS = 5_000;

export interface WfpDispatchFetchConfig {
  /** Account workers.dev subdomain suffix, e.g. `skyphusion.workers.dev`. */
  workersDevSubdomain: string;
  studioNamespace: string;
  moduleNamespace: string;
}

export function wfpDispatchFetch(config: WfpDispatchFetchConfig) {
  const studioBase = (scriptName: string) =>
    `https://${scriptName}.${config.studioNamespace}.${config.workersDevSubdomain}`;

  const moduleBase = (scriptName: string) =>
    `https://${scriptName}.${config.moduleNamespace}.${config.workersDevSubdomain}`;

  return {
    async callTenantStudio(
      scriptName: string,
      init: { method: string; path: string; studioApiToken: string; body?: string },
    ): Promise<{ status: number; text: string }> {
      const headers: Record<string, string> = { authorization: `Bearer ${init.studioApiToken}` };
      if (init.body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(`${studioBase(scriptName)}${init.path}`, {
        method: init.method,
        headers,
        body: init.body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      return { status: res.status, text: await res.text() };
    },

    async callTenantModule(scriptName: string, path: string): Promise<{ status: number; text: string }> {
      const res = await fetch(`${moduleBase(scriptName)}${path}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      return { status: res.status, text: await res.text() };
    },
  };
}
