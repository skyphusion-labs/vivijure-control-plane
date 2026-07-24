// THE FULL PROVISIONER CHAIN, live (#53 + #54, epic #40).
//
// Everything before this verified legs. This runs runProvisionJob -- the SHIPPING step machine --
// against real Cloudflare AND the real RunPod scratch account, and produces an actual tenant studio.
//
//   node scripts/build-studio-release.ts --bundle <outdir>/index.js --assets public \
//     --config wrangler.toml --tag <tag> --out /tmp/studio-release
//   set -a; . ~/.cf-provisioner-full.env; . ~/.runpod-scratch.env; set +a
//   CF_ACCOUNT_ID=<id> STUDIO_RELEASE_DIR=/tmp/studio-release PROVISION_E2E=1 \
//     STUDIO_TOKEN_KEK=<base64-32-byte-kek> \
//     PROVISION_E2E_WORKERS_DEV_SUBDOMAIN=<account>.workers.dev \
//     npx vitest run tests/provision-e2e.live.test.ts
//
// PROVENANCE LABEL (same as the upload leg, and it is not a formality): the bundle comes from a
// LOCAL REPRODUCIBLE BUILD of main, not a published tag. Byte-identical to what the workflow will
// publish for this commit, because the build reads no secrets and no account state -- but
// "fetched from the published location" is a different claim, proven at first release.
//
// SPEND: $0. Endpoints are created scale-to-zero and never invoked here. The render burn is a
// separate, explicitly authorized step.
//
// SAFETY: RunPod ACCOUNT GUARD runs first and gates everything. CF side is prod (only WfP account),
// rollins-verify- prefixed, torn down.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { CfApi } from "../src/cf-api";
import { CfTokenMinter } from "../src/token-minter";
import { runProvisionJob, teardownTenant, type ProvisionDeps } from "../src/provisioner";
import { createTenantEndpoints, RunPodClient, tenantEndpointName, PROVISION_PLAN } from "../src/runpod";
import { localStudioBundleSource } from "./studio-bundle-local";
import { localModuleBundleSource } from "./module-bundle-local";
import { provisionE2eLive, provisionE2eEnvOrThrow } from "./provision-e2e-env";
import { wfpDispatchFetch } from "./wfp-dispatch-fetch";
import { MemoryStore } from "./memory-store";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expectProvisionFailure } from "./provision-assert";

const LIVE = provisionE2eLive();
const env = LIVE ? provisionE2eEnvOrThrow(true)! : null;

const PROD_TELL = "t9wcvlxh8rc5la";
const slug = `rollins-e2e-${Date.now().toString(36).slice(-6)}`;
const NAMESPACE = env?.dispatchNamespace ?? "vivijure-tenants";

const cf = LIVE ? new CfApi(env!.cfAccountId, env!.cfToken) : (null as unknown as CfApi);
const runpodClient = LIVE ? new RunPodClient(env!.runpodKey) : (null as unknown as RunPodClient);
let scratchOk = false;
let store: MemoryStore;
let deps: ProvisionDeps;

const migrations = LIVE
  ? readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()
      .map((f) => ({ name: f, sql: readFileSync(join("migrations", f), "utf8") }))
  : [];

beforeAll(async () => {
  if (!LIVE || !env) return;
  const eps = await runpodClient.listEndpoints();
  scratchOk = !eps.some((e) => e.id === PROD_TELL);

  store = new MemoryStore();
  const tag = (JSON.parse(readFileSync(join(env.studioReleaseDir, "manifest.json"), "utf8")) as { tag: string }).tag;
  const dispatch = wfpDispatchFetch({
    workersDevSubdomain: env.workersDevSubdomain,
    studioNamespace: env.dispatchNamespace,
    moduleNamespace: env.moduleNamespace,
  });

  deps = {
    store,
    cf,
    runpod: { createEndpoints: (key, s, r2) => createTenantEndpoints(key, s, r2) },
    bundle: localStudioBundleSource(env.studioReleaseDir),
    moduleBundle: localModuleBundleSource(env.studioReleaseDir),
    tokenMinter: new CfTokenMinter(cf),
    r2Endpoint: `https://${env.cfAccountId}.r2.cloudflarestorage.com`,
    namespace: NAMESPACE,
    moduleNamespace: env.moduleNamespace,
    release: tag,
    tenantScriptName: (s: string) => `tenant-${s}-studio`,
    kek: env.studioTokenKek,
    spendDailyCeiling: env.spendDailyCeiling,
    callTenantStudio: dispatch.callTenantStudio,
    callTenantModule: dispatch.callTenantModule,
    log: (event, fields) => console.log(`  [${event}]`, JSON.stringify(fields).slice(0, 200)),
  };
});

// 5 minutes, NOT vitest's 10s default. This hook deletes real resources across TWO cloud accounts,
// and it timed out mid-teardown on the first run, stranding an endpoint (found and cleaned by hand).
// A teardown that can time out is how you strand a live credential, which is the exact orphaned-grant
// class this suite exists to prevent.
afterAll(async () => {
  if (!LIVE || !store) return;
  const tenant = [...store.tenants.values()][0];
  if (tenant) {
    const res = await teardownTenant(deps, tenant, { deleteData: true });
    if (!res.ok) console.warn("  teardown failures:", JSON.stringify(res.failures));
  }
  // The tenant's RunPod endpoints are on the SCRATCH account and are ours to clean here (in
  // production they are the tenant's own and we never touch them).
  if (scratchOk) {
    for (const spec of PROVISION_PLAN) {
      const name = tenantEndpointName(slug, spec.key);
      try {
        const eps = await runpodClient.listEndpoints();
        const mine = eps.find((e) => e.name === name);
        if (mine) await runpodClient.deleteEndpoint(mine.id);
        const tpls = await runpodClient.listTemplates();
        const t = tpls.find((x) => x.name === name);
        if (t) await runpodClient.deleteTemplate(t.id);
      } catch (e) {
        console.warn(`  LEFTOVER runpod ${name}: ${String(e).slice(0, 100)}`);
      }
    }
  }
}, 300_000);

describe.skipIf(!LIVE)("full provisioner chain (real CF + real RunPod scratch)", () => {
  it("GUARD: RunPod key reaches the SCRATCH account, not prod", async () => {
    expect(scratchOk, "PROD TELL PRESENT -- refusing to provision").toBe(true);
  });

  it("provisions a REAL tenant end to end and parks at awaiting_invoke_key", async () => {
    expect(scratchOk).toBe(true);
    const account = await store.createAccount("acct_e2e", "e2e@example.com");
    const tenant = await store.createTenant("ten_e2e", slug, account.id, "pending");
    const job = await store.createProvisionJob("job_e2e", tenant.id, "provision");

    const result = await runProvisionJob(deps, job.id, tenant, env!.runpodKey);
    if (!result.ok) {
      const fail = expectProvisionFailure(result);
      throw new Error(`provision failed at ${fail.step}: ${fail.message}`);
    }

    expect(result).toEqual({ ok: true, status: "awaiting_invoke_key" });
    const t = store.tenants.get("ten_e2e")!;
    console.log(`  tenant ${slug}: d1=${t.d1_database_id?.slice(0, 8)} bucket=${t.r2_bucket_name} script=${t.script_name}`);
    console.log(`  endpoints: ${t.endpoints_json}`);
    expect(t.status).toBe("awaiting_invoke_key");
    expect(JSON.parse(store.jobs.get("job_e2e")!.steps_done)).toContain("verify");
  }, 300_000);

  it("the tenant's studio worker is really resident with its real bindings", async () => {
    const names = new Set((await cf.getScriptBindings(NAMESPACE, `tenant-${slug}-studio`)).map((b) => b.name));
    for (const want of ["DB", "R2_RENDERS", "AUTH_MODE"]) expect(names, want).toContain(want);
  });

  it("the tenant's 4 RunPod endpoints exist, scale-to-zero, with workers PINNED", async () => {
    const eps = await runpodClient.listEndpoints();
    for (const spec of PROVISION_PLAN) {
      const mine = eps.find((e) => e.name === tenantEndpointName(slug, spec.key));
      expect(mine, `${spec.key} endpoint missing`).toBeTruthy();
      const detail = await runpodClient.getEndpoint(mine!.id);
      expect(detail.workersMin, `${spec.key} not scale-to-zero`).toBe(0);
      expect(detail.workersMax, `${spec.key} workers not pinned`).toBe(spec.maxWorkers);
    }
  }, 120_000);
});
