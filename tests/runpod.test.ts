// The RunPod port (#54). Fakes RunPod, so this proves the PLAN, the quota reading, and the env
// asymmetry -- not that the API is shaped right. The live legs against the scratch account are what
// prove that, and they are reported separately rather than implied by this suite.

import { describe, it, expect, vi } from "vitest";
import {
  PROVISION_PLAN,
  createTenantEndpoints,
  parseQuotaError,
  planWorkerTotal,
  preflightQuota,
  quotaGuidance,
  RunPodClient,
  templateEnv,
  tenantEndpointName,
  invokeKeyRecipe,
} from "../src/runpod";

const R2 = { endpoint: "https://acct.r2.cloudflarestorage.com", accessKeyId: "ak", secretAccessKey: "sk", bucket: "vivijure-tenant-hero" };

// RunPod's real refusal text (#60), verbatim.
const QUOTA_ERR =
  "input validation error: Max workers across all endpoints will exceed your worker quota of 10. " +
  "Reduce the max workers for other endpoints or lower the max worker count for this endpoint to at most 9";

function fakeRunPod(opts: { endpoints?: unknown[]; templates?: unknown[]; quotaError?: string; created?: string[] } = {}) {
  const created: string[] = opts.created ?? [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && u.endsWith("/endpoints")) return new Response(JSON.stringify(opts.endpoints ?? []));
    if (method === "GET" && u.endsWith("/templates")) return new Response(JSON.stringify(opts.templates ?? []));
    if (method === "PATCH" && u.includes("/templates/")) {
      created.push(`template-refresh:${u.split("/templates/")[1]}`);
      return new Response(JSON.stringify({ id: u.split("/templates/")[1] }));
    }
    if (method === "POST" && u.endsWith("/templates")) {
      const body = JSON.parse(String(init?.body)) as { name: string };
      created.push(`template:${body.name}`);
      return new Response(JSON.stringify({ id: `tpl-${body.name}` }));
    }
    if (method === "POST" && u.endsWith("/endpoints")) {
      const body = JSON.parse(String(init?.body)) as { name: string; workersMax: number };
      if (body.workersMax === 9999) return new Response(opts.quotaError ?? QUOTA_ERR, { status: 400 });
      created.push(`endpoint:${body.name}:${body.workersMax}`);
      return new Response(JSON.stringify({ id: `ep-${body.name}` }));
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, created };
}

describe("the provisioning plan", () => {
  it("fits any observed quota: 4 endpoints summing to 5 workers", () => {
    expect(PROVISION_PLAN).toHaveLength(4);
    expect(planWorkerTotal()).toBe(5);
  });

  it("pins max_workers EXPLICITLY on every endpoint (RunPod's default of 3 x 4 = 12 breaks it)", () => {
    for (const e of PROVISION_PLAN) expect(e.maxWorkers, e.key).toBeGreaterThan(0);
  });

  it("never uses the frozen python default tag (0.4.4 footgun stays in the script)", () => {
    expect(PROVISION_PLAN.find((e) => e.key === "backend")?.tag).not.toBe("0.4.4");
  });
});

describe("templateEnv", () => {
  it("gives the BACKEND R2_ENDPOINT + HF_HUB_OFFLINE", () => {
    const env = templateEnv("backend", R2);
    expect(env.R2_ENDPOINT).toBe(R2.endpoint);
    expect(env.HF_HUB_OFFLINE).toBe("1");
    expect(env.R2_ENDPOINT_URL).toBeUndefined();
  });

  it("gives SATELLITES R2_ENDPOINT_URL, not R2_ENDPOINT (finding F10: fails at first render, not at provision)", () => {
    for (const key of ["upscale", "lipsync", "audio-upscale"] as const) {
      const env = templateEnv(key, R2);
      expect(env.R2_ENDPOINT_URL, key).toBe(R2.endpoint);
      expect(env.R2_ENDPOINT, key).toBeUndefined();
    }
  });

  it("scopes every endpoint to the TENANT's own bucket", () => {
    for (const e of PROVISION_PLAN) expect(templateEnv(e.key, R2).R2_BUCKET).toBe("vivijure-tenant-hero");
  });
});

describe("parseQuotaError", () => {
  it("reads the quota from #60's recorded sentence", () => {
    expect(parseQuotaError(QUOTA_ERR)).toEqual({ quota: 10, atMost: 9 });
  });

  it("reads the quota from the sentence RunPod ACTUALLY sends today (it drifted mid-sprint)", () => {
    // Observed live on 2026-07-17, and it is NOT what #60 recorded: "worker quota of 10" became
    // "workers quota (10)". A parser pinned to either exact phrasing reads null, and because the
    // preflight fails closed, null means no tenant can EVER provision. Both shapes stay covered.
    const live =
      "create endpoint: create endpoint: graphql: Max workers across all endpoints must not exceed " +
      "your workers quota (10). Reduce the max workers for other endpoints or lower the max worker " +
      "count for this endpoint to at most 9.";
    expect(parseQuotaError(live)).toEqual({ quota: 10, atMost: 9 });
  });

  it("returns nulls rather than guessing when RunPod said something else", () => {
    expect(parseQuotaError("some other failure")).toEqual({ quota: null, atMost: null });
  });
});

describe("preflightQuota", () => {
  it("reads the account quota and fits the plan", async () => {
    const { fetchImpl } = fakeRunPod();
    const r = await preflightQuota(new RunPodClient("rpa_k", fetchImpl));
    expect(r).toMatchObject({ quota: 10, atMost: 9, fits: true });
  });

  it("counts EXISTING endpoints' workersMax against the account-wide quota", async () => {
    // The quota is account-wide and enforced against the SUM (#60), so a busy account does not fit.
    const { fetchImpl } = fakeRunPod({ endpoints: [{ id: "e1", name: "other", workersMax: 8 }] });
    const r = await preflightQuota(new RunPodClient("rpa_k", fetchImpl));
    expect(r.fits).toBe(false);
  });

  it("refuses to claim a fit when it could not READ the quota, and says WHICH refusal it is", async () => {
    const { fetchImpl } = fakeRunPod({ quotaError: "template not found" });
    const r = await preflightQuota(new RunPodClient("rpa_k", fetchImpl));
    expect(r).toMatchObject({ quota: null, fits: false, refusal: "quota_unreadable" });
  });

  it("distinguishes too-small from unreadable (they need different actions from different people)", async () => {
    const small = fakeRunPod({ endpoints: [{ id: "e1", name: "other", workersMax: 8 }] });
    expect(await preflightQuota(new RunPodClient("rpa_k", small.fetchImpl))).toMatchObject({
      fits: false, refusal: "quota_too_small",
    });
  });

  it("does NOT double-count a re-provision's OWN endpoints (existing-by-name are adopted, not re-added)", async () => {
    // A prior partial provision left the tenant's 4 endpoints (5 workers) on the account, plus an
    // unrelated 3-worker endpoint = 8 used, quota 10. Counting the whole plan on top (8 + 5 = 13)
    // would exceed quota and permanently block the retry; adopt-by-name means net-new is 0.
    const existing = [
      { id: "b", name: tenantEndpointName("hero", "backend"), workersMax: 2 },
      { id: "u", name: tenantEndpointName("hero", "upscale"), workersMax: 1 },
      { id: "l", name: tenantEndpointName("hero", "lipsync"), workersMax: 1 },
      { id: "a", name: tenantEndpointName("hero", "audio-upscale"), workersMax: 1 },
      { id: "x", name: "someone-else", workersMax: 3 },
    ];
    const { fetchImpl } = fakeRunPod({ endpoints: existing });
    // No slug: the whole plan is net-new (8 + 5 = 13 > 10) -- the old double-count.
    expect((await preflightQuota(new RunPodClient("rpa_k", fetchImpl))).fits).toBe(false);
    // With the slug: the tenant's own 4 endpoints adopt (net-new 0), 8 + 0 = 8 <= 10 -> fits.
    expect((await preflightQuota(new RunPodClient("rpa_k", fetchImpl), "hero")).fits).toBe(true);
  });
});

describe("createTenantEndpoints", () => {
  it("creates 4 endpoints with explicitly pinned workers", async () => {
    const { fetchImpl, created } = fakeRunPod();
    const out = await createTenantEndpoints("rpa_keyA", "hero", R2, PROVISION_PLAN, fetchImpl);
    expect(out.map((e) => e.key)).toEqual(["backend", "upscale", "lipsync", "audio-upscale"]);
    expect(created).toContain(`endpoint:${tenantEndpointName("hero", "backend")}:2`);
    expect(created.filter((c) => c.startsWith("endpoint:"))).toHaveLength(4);
  });

  it("REUSES an existing endpoint by name instead of duplicating it on the tenant's bill", async () => {
    // The template is seeded alongside the endpoint because that is the only state we can actually
    // produce: we create both under the same name. An endpoint with no matching template is now a
    // refusal (#83) -- it is the one shape where the freshly minted R2 credential has nowhere to go
    // -- and it has its own test in adopted-template-cred.test.ts.
    const existing = { id: "ep-old", name: tenantEndpointName("hero", "backend"), workersMax: 2 };
    const existingTemplate = { id: "tpl-old", name: tenantEndpointName("hero", "backend") };
    const { fetchImpl, created } = fakeRunPod({ endpoints: [existing], templates: [existingTemplate] });
    const out = await createTenantEndpoints("rpa_keyA", "hero", R2, PROVISION_PLAN, fetchImpl);
    expect(out.find((e) => e.key === "backend")?.id).toBe("ep-old");
    expect(created).not.toContain(`endpoint:${existing.name}:2`);
    // and the adopted template got the fresh credential written to it
    expect(created).toContain("template-refresh:tpl-old");
  });

  it("FAILS BEFORE creating anything when the plan does not fit, with RunPod's real numbers", async () => {
    // A half-provisioned RunPod account is the tenant's mess, on their bill. Refuse early.
    const { fetchImpl, created } = fakeRunPod({ endpoints: [{ id: "e1", name: "other", workersMax: 8 }] });
    await expect(createTenantEndpoints("rpa_keyA", "hero", R2, PROVISION_PLAN, fetchImpl)).rejects.toThrow(/quota is 10/);
    expect(created.filter((c) => c.startsWith("endpoint:vivijure-hero"))).toHaveLength(0);
  });

  it("NEVER logs or returns key A", async () => {
    const { fetchImpl } = fakeRunPod();
    const out = await createTenantEndpoints("rpa_KEY_A_SECRET", "hero", R2, PROVISION_PLAN, fetchImpl);
    expect(JSON.stringify(out)).not.toContain("rpa_KEY_A_SECRET");
  });
});

describe("quotaGuidance", () => {
  it("tells the tenant the real numbers and that nothing was created", () => {
    const msg = quotaGuidance({ quota: 5, atMost: 4, fits: false, refusal: "quota_too_small" });
    expect(msg).toContain("quota is 5");
    expect(msg).toContain("needs 5 workers");
    expect(msg).toContain("Nothing was created");
  });

  it("does NOT tell a tenant to fund their account when the failure is ours", () => {
    // Wrong advice is worse than no advice: an unreadable quota is not something funding fixes.
    const msg = quotaGuidance({ quota: null, atMost: null, fits: false, refusal: "quota_unreadable" });
    expect(msg).toContain("on us");
    expect(msg).toContain("Nothing was created");
    expect(msg).not.toMatch(/fund|raise the quota|support/i);
  });
});

describe("invokeKeyRecipe", () => {
  const made = [
    { key: "backend", label: "Render", id: "ep1", name: "vivijure-hero-backend", endpointVar: "RUNPOD_ENDPOINT_ID" },
    { key: "upscale", label: "Video upscale", id: "ep2", name: "vivijure-hero-upscale", endpointVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  ];

  it("names the tenant's REAL endpoints, so nobody retypes a guess into a console", () => {
    const r = invokeKeyRecipe(made);
    expect(r.steps.join("\n")).toContain("vivijure-hero-backend");
    expect(r.steps.join("\n")).toContain("vivijure-hero-upscale");
    expect(r.endpoints.map((e) => e.id)).toEqual(["ep1", "ep2"]);
  });

  it("tells them to set graphql to None, and says WHY we refuse a powerful key", () => {
    const text = invokeKeyRecipe(made).steps.join("\n");
    expect(text).toContain("api.runpod.io/graphql to None");
    expect(text).toMatch(/will not store|refuse/i);
  });

  it("tells them to delete the setup key afterwards (we never kept it)", () => {
    expect(invokeKeyRecipe(made).steps.join("\n")).toMatch(/delete or rotate the FIRST key/i);
  });
});
