// LIVE reconciliation check (cp#137): BOTH sides read from the real world, no stubs anywhere.
//
//   set -a; . ~/.cf-vivijure-hosted.env; . ~/your-runpod.env; set +a
//   CF_ACCOUNT_ID=<id> RECONCILE_LIVE=1 npx vitest run tests/reconcile-runpod.live.test.ts
//
// WHY IT EXISTS. reconcile-runpod.test.ts drives the detector from fixtures, so it proves the
// decision path and nothing about the shipped artifact: fixtures encode MY assumptions about what
// RunPod returns and what a tenant row looks like. This runs the SAME reconcileRunPod over a live
// RunPod account and the live tenants table, through the shipping clients (RunPodClient, CfApi), so
// the seam being exercised is the one production takes.
//
// SAFETY. Read-only end to end: two RunPod GETs, one D1 SELECT. It creates nothing, deletes nothing,
// and spends no GPU seconds. The D1 id is RESOLVED FROM THE DATABASE NAME at use time, never
// recorded here, for the same reason tenant ids are resolved from slugs: recorded ids go stale and a
// stale id 404s into a false pass.
//
// It asserts SHAPE and INTERNAL CONSISTENCY, never "clean": the live account is expected to carry
// known drift (that is what cp#137 is about), so a test demanding clean would be a test demanding
// the bug be fixed before the detector can be trusted.

import { describe, it, expect, beforeAll } from "vitest";
import { CfApi } from "../src/cf-api";
import { RunPodClient } from "../src/runpod";
import { listWasWhole, reconcileRunPod, TENANT_PAGE_LIMIT, type RunPodResource } from "../src/reconcile-runpod";
import type { Tenant } from "../src/store";

declare const process: { env: Record<string, string | undefined> };

const RUNPOD_KEY = process.env.RUNPOD_API_KEY;
const CF_TOKEN = process.env.CF_PROVISIONER_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT = process.env.CF_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
const LIVE = Boolean(RUNPOD_KEY && CF_TOKEN && CF_ACCOUNT && process.env.RECONCILE_LIVE);

const D1_NAME = process.env.CONTROL_PLANE_D1_NAME ?? "vivijure-control-plane";
// A LITERAL chosen by a comparison, never the environment value itself. The report is printed, and
// an env value printed verbatim is clear-text logging of whatever was really in that variable; only
// two accounts exist to label, so a whitelist costs nothing and the printed line carries a constant.
const ACCOUNT_LABEL = process.env.RUNPOD_ACCOUNT_LABEL === "scratch" ? "scratch" : "prod";

const RUNPOD_API = "https://rest.runpod.io/v1";

let tenants: Tenant[] = [];
let endpoints: RunPodResource[] = [];
let templates: RunPodResource[] = [];
let inventoryComplete = false;

/** The RAW list, so completeness can be judged before any absence is concluded from it. */
async function rawList(kind: "endpoints" | "templates"): Promise<unknown> {
  const res = await fetch(`${RUNPOD_API}/${kind}`, { headers: { authorization: `Bearer ${RUNPOD_KEY}` } });
  expect(res.ok, `GET /${kind} returned HTTP ${res.status}`).toBe(true);
  return await res.json();
}

beforeAll(async () => {
  if (!LIVE) return;

  const client = new RunPodClient(RUNPOD_KEY!);
  const [rawEndpoints, rawTemplates] = await Promise.all([rawList("endpoints"), rawList("templates")]);
  inventoryComplete = listWasWhole(rawEndpoints) && listWasWhole(rawTemplates);
  const [liveEndpoints, liveTemplates] = await Promise.all([client.listEndpoints(), client.listTemplates()]);
  endpoints = liveEndpoints.map((e) => ({ id: e.id, name: e.name }));
  templates = liveTemplates.map((t) => ({ id: t.id, name: t.name }));

  const cf = new CfApi(CF_ACCOUNT!, CF_TOKEN!);
  const db = await cf.findD1ByName(D1_NAME);
  expect(db, "the control-plane D1 database was not found on this account").not.toBeNull();
  const result = (await cf.queryD1(db!.uuid, "SELECT * FROM tenants ORDER BY created_at DESC")) as
    | { results?: Tenant[] }[]
    | { results?: Tenant[] };
  const rows = Array.isArray(result) ? result[0]?.results : result?.results;
  // A shape we cannot read must NOT become an empty census: zero tenants reconciles as nothing to
  // check, which would read as a pass. Refuse instead.
  expect(Array.isArray(rows), "the D1 query returned a shape this check cannot read").toBe(true);
  tenants = rows as Tenant[];
});

describe.skipIf(!LIVE)("reconcileRunPod against live RunPod and the live tenants table", () => {
  it("read both sides, and says plainly whether each census was whole", () => {
    expect(tenants.length).toBeGreaterThan(0);
    expect(endpoints.length + templates.length).toBeGreaterThan(0);
    const report = reconcileRunPod(
      { tenants, complete: tenants.length < TENANT_PAGE_LIMIT },
      {
        account_label: ACCOUNT_LABEL,
        read_at: new Date().toISOString(),
        complete: inventoryComplete,
        endpoints,
        templates,
      },
    );
    // The artifact this run exists to produce. Ids and names only; no credential can reach here.
    console.log(JSON.stringify(report, null, 2));

    expect(report.census.tenants).toBe(tenants.length);
    expect(report.census.endpoints).toBe(endpoints.length);
    expect(report.writes).toBe("none");
    expect(["clean", "drift", "unproven"]).toContain(report.verdict);
  });

  it("every finding traces to a tenant this run actually read (no invented owners)", () => {
    const report = reconcileRunPod(
      { tenants, complete: tenants.length < TENANT_PAGE_LIMIT },
      {
        account_label: ACCOUNT_LABEL,
        read_at: new Date().toISOString(),
        complete: inventoryComplete,
        endpoints,
        templates,
      },
    );
    const slugs = new Set(tenants.map((t) => t.slug));
    for (const finding of report.findings) {
      if (finding.tenant_slug !== null) expect(slugs.has(finding.tenant_slug)).toBe(true);
    }
    // Unattributed resources must never also appear as findings: the two lists are disjoint claims.
    const findingIds = new Set(report.findings.map((f) => f.resource_id).filter(Boolean));
    for (const resource of [...report.unattributed.endpoints, ...report.unattributed.templates]) {
      expect(findingIds.has(resource.id)).toBe(false);
    }
  });

  it("the standing testbed is reconciled by SLUG, with the id resolved from the row, never recorded", () => {
    const slug = process.env.RECONCILE_TESTBED_SLUG ?? "rollins-e2e";
    const rows = tenants.filter((t) => t.slug === slug && t.status !== "deleted");
    // Zero live rows for the slug is a fact worth failing on: this check is pointless if the tenant
    // it was written for is not there under the name we resolve it by.
    expect(rows.length, "no non-deleted tenant carries the testbed slug").toBeGreaterThan(0);
    const report = reconcileRunPod(
      { tenants, complete: tenants.length < TENANT_PAGE_LIMIT },
      {
        account_label: ACCOUNT_LABEL,
        read_at: new Date().toISOString(),
        complete: inventoryComplete,
        endpoints,
        templates,
      },
    );
    const verdict = report.tenants.find((t) => t.tenant_id === rows[0].id);
    expect(verdict, "the testbed tenant is missing from the per-tenant verdicts").toBeTruthy();
    // Printed from the ROW, never from the environment: the row is what the reconciliation actually
    // read, and it keeps an env value out of the printed line.
    console.log(`testbed ${rows[0].slug} (${rows[0].id}): ${JSON.stringify(verdict)}`);
  });
});
