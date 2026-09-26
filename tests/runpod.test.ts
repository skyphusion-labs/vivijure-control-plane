// The RunPod port (#54). Fakes RunPod, so this proves the PLAN, the quota reading, and the env
// asymmetry -- not that the API is shaped right. The live legs against the scratch account are what
// prove that, and they are reported separately rather than implied by this suite.

import { describe, it, expect, vi } from "vitest";
import {
  PROVISION_PLAN,
  endpointBackedPlan,
  vpcBackedPlan,
  provisionPlanView,
  NO_TRAINING_CLAUSE,
  RETIRED_ENDPOINT_KEYS,





  RunPodClient,

  tenantEndpointName,
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
  it("holds 3 capabilities: 2 endpoint-backed, 1 on our own iron", () => {
    // cp#517 dropped the lipsync entry (musetalk ruled out, endpoint gone); cp#519 dropped
    // audio-upscale with the speech-upscale module. ALL THREE numbers are asserted because a total
    // alone cannot distinguish a capability that was DROPPED from one that MOVED transport.
    //
    // THE WORKER SUM IS UNCHANGED AT 4, and that is the honest reading: audio-upscale was
    // door-backed, so it spent NO account-wide worker quota and its removal hands none back. Saying
    // otherwise would be inventing a saving. What cp#517 handed back was 1, from an ENDPOINT.
    expect(PROVISION_PLAN).toHaveLength(3);
    expect(endpointBackedPlan()).toHaveLength(2);
    expect(vpcBackedPlan()).toHaveLength(1);
    expect(endpointBackedPlan().map((c) => c.key).sort()).toEqual(["backend", "wan-train"]);
    expect(vpcBackedPlan().map((c) => c.key).sort()).toEqual(["upscale"]);
    expect(endpointBackedPlan().reduce((n, e) => n + e.maxWorkers, 0)).toBe(4);
    // A retired key is not reachable from the plan by any route, which is what stops it being
    // provisioned, pinned or demanded of a pool. It survives ONLY for reconcile attribution, and
    // BOTH halves are asserted per key: absent from the plan, present in the retired list. Assert
    // only the first and the attribution can be dropped silently, which is the cp#517 defect.
    expect(PROVISION_PLAN.map((c) => c.key)).not.toContain("lipsync");
    expect(RETIRED_ENDPOINT_KEYS).toContain("lipsync");
    expect(PROVISION_PLAN.map((c) => c.key)).not.toContain("audio-upscale");
    expect(RETIRED_ENDPOINT_KEYS).toContain("audio-upscale");
  });

  it("pins max_workers EXPLICITLY on every ENDPOINT (RunPod default of 3 would overrun the quota)", () => {
    for (const e of endpointBackedPlan()) expect(e.maxWorkers, e.key).toBeGreaterThan(0);
  });

  it("a vpc-backed capability carries NO maxWorkers and NO endpointVar, by design", () => {
    // The absences are the safety property, not an oversight: no quota to spend, and no endpoint id
    // that could reach a studio as an empty string and fail at the tenant first render.
    for (const c of vpcBackedPlan()) {
      const asAny = c as unknown as Record<string, unknown>;
      expect(asAny.maxWorkers, c.key).toBeUndefined();
      expect(asAny.endpointVar, c.key).toBeUndefined();
      expect(c.doorsUrlVar, c.key).toMatch(/_DOORS$/);
      expect(c.tokens.length, c.key).toBeGreaterThan(0);
    }
  });


  it("never uses the frozen python default tag (0.4.4 footgun stays in the script)", () => {
    expect(PROVISION_PLAN.find((e) => e.key === "backend")?.tag).not.toBe("0.4.4");
  });

  // cp#303: the backend endpoint never trains cast LoRAs (that is vivijure-wan-train, fail-closed
  // on its own binding). The label is tenant-visible via onboarding, so a training clause here is
  // a product lie, not decoration.
  it("backend label does not promise cast LoRA training (cp#303)", () => {
    const backend = PROVISION_PLAN.find((e) => e.key === "backend");
    expect(backend?.label).toBe("Render (keyframes, video)");
    expect(backend?.label).not.toMatch(NO_TRAINING_CLAUSE);
  });

  it("provisionPlanView is a projection of the same array, not a second list (cp#474)", () => {
    const view = provisionPlanView();
    expect(view.map((r) => r.key)).toEqual(PROVISION_PLAN.map((c) => c.key));
    expect(view.map((r) => r.label)).toEqual(PROVISION_PLAN.map((c) => c.label));
    expect(view.filter((r) => r.backing === "runpod")).toHaveLength(endpointBackedPlan().length);
    expect(view.filter((r) => r.backing === "door")).toHaveLength(vpcBackedPlan().length);
    for (const row of view) {
      if (row.backing === "door") {
        expect(row.max_workers).toBeNull();
        expect(row.gpu).toBe("our hardware");
      } else {
        expect(row.max_workers).toBeGreaterThan(0);
        expect(row.gpu.length).toBeGreaterThan(0);
        expect(row.gpu).not.toBe("our hardware");
      }
      expect(row.image.startsWith("ghcr.io/")).toBe(true);
    }
  });
});

