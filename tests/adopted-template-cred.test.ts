// The adopted-template credential refresh gate (#83).
//
// WHAT THIS PROVES, and why it is shaped this way: the failure it guards against is NOT "we forgot
// to call the updater". It is "the template OBJECT still carries a dead credential". So the fake
// RunPod here STORES template state and the assertions read that stored state back. Asserting that
// updateTemplateEnv was called would pass just as happily against an updater that wrote nothing,
// which is exactly the class of stub that let this ship broken the first time.
//
// Found live: an adopted tenant provisioned green, then died at its first render with
// botocore ClientError (401) HeadObject, because every provision mints a fresh R2 credential and the
// adopted template kept the one baked in when it was first created.

import { describe, it, expect, vi } from "vitest";
import {
  PROVISION_PLAN,
  createTenantEndpoints,
  templateEnv,
  tenantEndpointName,
} from "../src/runpod";

const STALE = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  accessKeyId: "STALE_AK_revoked",
  secretAccessKey: "STALE_SK_revoked",
  bucket: "vivijure-tenant-hero",
};
const FRESH = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  accessKeyId: "FRESH_AK_minted_this_run",
  secretAccessKey: "FRESH_SK_minted_this_run",
  bucket: "vivijure-tenant-hero",
};

/**
 * A RunPod fake that keeps real state: templates carry env, and a PATCH mutates it. `calls` records
 * ordering so "template refreshed BEFORE the endpoint is touched" is assertable.
 */
function statefulRunPod(opts: { seedTemplates?: boolean; seedEndpoints?: boolean; seedEnv?: typeof STALE } = {}) {
  const seedEnv = opts.seedEnv ?? STALE;
  const templates = new Map<string, { id: string; name: string; env: Record<string, string> }>();
  const endpoints = new Map<string, { id: string; name: string; workersMax: number }>();
  const calls: string[] = [];

  if (opts.seedTemplates) {
    for (const spec of PROVISION_PLAN) {
      const name = tenantEndpointName("hero", spec.key);
      templates.set(name, { id: `tpl-${name}`, name, env: templateEnv(spec.key, seedEnv) });
    }
  }
  if (opts.seedEndpoints) {
    for (const spec of PROVISION_PLAN) {
      const name = tenantEndpointName("hero", spec.key);
      endpoints.set(name, { id: `ep-${name}`, name, workersMax: spec.maxWorkers });
    }
  }

  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";

    if (method === "GET" && u.endsWith("/endpoints")) {
      calls.push("GET /endpoints");
      return new Response(JSON.stringify([...endpoints.values()]));
    }
    if (method === "GET" && u.endsWith("/templates")) {
      calls.push("GET /templates");
      return new Response(JSON.stringify([...templates.values()]));
    }
    if (method === "PATCH" && u.includes("/templates/")) {
      const id = u.split("/templates/")[1];
      const body = JSON.parse(String(init?.body)) as { env: Record<string, string> };
      const found = [...templates.values()].find((t) => t.id === id);
      if (!found) return new Response("no such template", { status: 404 });
      found.env = body.env; // the mutation the whole gate is about
      calls.push(`PATCH template:${found.name}`);
      return new Response(JSON.stringify({ id }));
    }
    if (method === "POST" && u.endsWith("/templates")) {
      const body = JSON.parse(String(init?.body)) as { name: string; env: Record<string, string> };
      templates.set(body.name, { id: `tpl-${body.name}`, name: body.name, env: body.env });
      calls.push(`POST template:${body.name}`);
      return new Response(JSON.stringify({ id: `tpl-${body.name}` }));
    }
    if (method === "POST" && u.endsWith("/endpoints")) {
      const body = JSON.parse(String(init?.body)) as { name: string; templateId: string; workersMax: number };
      endpoints.set(body.name, { id: `ep-${body.name}`, name: body.name, workersMax: body.workersMax });
      calls.push(`POST endpoint:${body.name}:${body.templateId}`);
      return new Response(JSON.stringify({ id: `ep-${body.name}` }));
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, templates, endpoints, calls };
}

/** Every template the plan owns, as the fake currently stores it. */
const storedEnvs = (t: Map<string, { env: Record<string, string> }>) => [...t.values()].map((v) => v.env);

describe("adopted RunPod templates carry the freshly minted R2 credential (#83)", () => {
  it("CONTROL: the fake really stores the stale credential first (else the gate is vacuous)", () => {
    const rp = statefulRunPod({ seedTemplates: true, seedEndpoints: true });
    for (const env of storedEnvs(rp.templates)) {
      expect(env.R2_ACCESS_KEY_ID).toBe("STALE_AK_revoked");
    }
  });

  it("THE #83 GATE: a fully adopted tenant ends with the FRESH cred on every template object", async () => {
    // Exactly the live case: endpoints AND templates already exist from an earlier provision.
    const rp = statefulRunPod({ seedTemplates: true, seedEndpoints: true });

    const out = await createTenantEndpoints("rpa_keyA", "hero", FRESH, PROVISION_PLAN, rp.fetchImpl);

    expect(out).toHaveLength(PROVISION_PLAN.length);
    for (const env of storedEnvs(rp.templates)) {
      expect(env.R2_ACCESS_KEY_ID).toBe("FRESH_AK_minted_this_run");
      expect(env.R2_SECRET_ACCESS_KEY).toBe("FRESH_SK_minted_this_run");
    }
    // And nothing stale survived anywhere.
    expect(JSON.stringify(storedEnvs(rp.templates))).not.toContain("STALE");
  });

  it("refreshes the template BEFORE touching the endpoint, so no consumer sees a dead cred window", async () => {
    const rp = statefulRunPod({ seedTemplates: true, seedEndpoints: false });

    await createTenantEndpoints("rpa_keyA", "hero", FRESH, PROVISION_PLAN, rp.fetchImpl);

    const firstBackendPatch = rp.calls.indexOf("PATCH template:vivijure-hero-backend");
    const firstBackendEndpoint = rp.calls.findIndex((c) => c.startsWith("POST endpoint:vivijure-hero-backend"));
    expect(firstBackendPatch).toBeGreaterThanOrEqual(0);
    expect(firstBackendEndpoint).toBeGreaterThan(firstBackendPatch);
  });

  it("adopted template + missing endpoint: template refreshed AND the new endpoint uses it", async () => {
    const rp = statefulRunPod({ seedTemplates: true, seedEndpoints: false });

    await createTenantEndpoints("rpa_keyA", "hero", FRESH, PROVISION_PLAN, rp.fetchImpl);

    for (const env of storedEnvs(rp.templates)) {
      expect(env.R2_ACCESS_KEY_ID).toBe("FRESH_AK_minted_this_run");
    }
    expect(rp.calls).toContain("POST endpoint:vivijure-hero-backend:tpl-vivijure-hero-backend");
  });

  it("fresh tenant: creates templates carrying the minted cred (unchanged behaviour)", async () => {
    const rp = statefulRunPod();

    await createTenantEndpoints("rpa_keyA", "hero", FRESH, PROVISION_PLAN, rp.fetchImpl);

    expect(rp.templates.size).toBe(PROVISION_PLAN.length);
    for (const env of storedEnvs(rp.templates)) {
      expect(env.R2_ACCESS_KEY_ID).toBe("FRESH_AK_minted_this_run");
    }
  });

  it("NEGATIVE: an endpoint with no matching template REFUSES rather than reporting a ready endpoint", async () => {
    // We would have nowhere to write the fresh credential, so claiming this endpoint can render
    // would be the #83 lie in a new costume.
    const rp = statefulRunPod({ seedTemplates: false, seedEndpoints: true });

    await expect(createTenantEndpoints("rpa_keyA", "hero", FRESH, PROVISION_PLAN, rp.fetchImpl)).rejects.toThrow(
      /no template named .* was found/,
    );
  });

  it("preserves the handler-side env asymmetry when REFRESHING, not just when creating", async () => {
    // F17: the backend reads R2_ENDPOINT (+ HF_HUB_OFFLINE); satellites read R2_ENDPOINT_URL.
    // Getting this wrong on the refresh path would fail only at the tenant first render.
    const rp = statefulRunPod({ seedTemplates: true, seedEndpoints: true });

    await createTenantEndpoints("rpa_keyA", "hero", FRESH, PROVISION_PLAN, rp.fetchImpl);

    const backend = rp.templates.get("vivijure-hero-backend")!.env;
    expect(backend.R2_ENDPOINT).toBe(FRESH.endpoint);
    expect(backend.HF_HUB_OFFLINE).toBe("1");
    expect(backend.R2_ENDPOINT_URL).toBeUndefined();

    const upscale = rp.templates.get("vivijure-hero-upscale")!.env;
    expect(upscale.R2_ENDPOINT_URL).toBe(FRESH.endpoint);
    expect(upscale.R2_ENDPOINT).toBeUndefined();
  });
});
