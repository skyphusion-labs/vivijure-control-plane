// Out-of-worker dispatch fetch for the live provision e2e (#4).
//
// Production uses the TENANT_DISPATCH / TENANT_MODULE_DISPATCH bindings inside the control plane
// Worker. Vitest runs on Node, which has no such binding and cannot get one.
//
// The previous implementation tried to reach tenant scripts directly at
// `<script>.<namespace>.<subdomain>.workers.dev`. That shape cannot work and never did: WfP user
// Workers are not published on workers.dev at all, and even if they were, `*.workers.dev` TLS covers
// exactly one label, so a two-label host fails the handshake before any request is sent. It was
// never exercised, so nothing said so until the suite was first run for real.
//
// What replaces it is not a cleverer URL, because no URL exists. It is an ephemeral Worker that
// holds the bindings -- deployed for the run, scoped to this run's own tenant, deleted afterwards.
// See e2e-harness-dispatcher.ts. Harness-only; tenant prod routes stay off workers.dev.

import type { HarnessDispatcher } from "./e2e-harness-dispatcher";

export function wfpDispatchFetch(dispatcher: HarnessDispatcher) {
  return {
    async callTenantStudio(
      scriptName: string,
      init: { method: string; path: string; studioApiToken: string; body?: string },
    ): Promise<{ status: number; text: string }> {
      return await dispatcher.call({
        ns: "studio",
        script: scriptName,
        path: init.path,
        method: init.method,
        authorization: `Bearer ${init.studioApiToken}`,
        body: init.body,
      });
    },

    async callTenantModule(scriptName: string, path: string): Promise<{ status: number; text: string }> {
      return await dispatcher.call({ ns: "module", script: scriptName, path, method: "GET" });
    },
  };
}
