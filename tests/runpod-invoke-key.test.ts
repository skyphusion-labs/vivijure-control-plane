// Key-B scope verification (#52, ruled in at the design gate).
//
// The probe semantics asserted here are the EMPIRICAL #60 matrix, not docs and not guesses:
//   invoke-scoped key: health 200 in scope, 403 out of scope, graphql 401
//   graphql R/W key:   graphql 200  <- the tell we must refuse
// Every case below is a REFUSAL case except the one positive control, because the whole point of
// this function is to reject, and a refusal I have not watched happen is not a guard.

import { describe, it, expect, vi } from "vitest";
import { hasModernKeyPrefix, verifyInvokeKeyScope } from "../src/runpod-invoke-key";

const ENDPOINTS = ["ep1", "ep2", "ep3", "ep4"];
const KEY = "rpa_testkey";

/** A fake RunPod shaped by the #60 findings. */
function runpod(opts: { graphqlOk?: boolean; inScope?: string[]; error?: string[] }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.runpod.io/graphql")) {
      return opts.graphqlOk
        ? new Response(JSON.stringify({ data: { myself: { id: "u1" } } }), { status: 200 })
        : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    const id = /v2\/([^/]+)\/health/.exec(url)?.[1] ?? "";
    if (opts.error?.includes(id)) throw new Error("network");
    const inScope = opts.inScope ?? ENDPOINTS;
    return inScope.includes(id)
      ? new Response(JSON.stringify({ workers: {} }), { status: 200 })
      : new Response("forbidden", { status: 403 });
  }) as unknown as typeof fetch;
}

describe("verifyInvokeKeyScope", () => {
  it("ACCEPTS an invoke key scoped to all four endpoints (the positive control)", async () => {
    const v = await verifyInvokeKeyScope(KEY, ENDPOINTS, runpod({}));
    expect(v.ok).toBe(true);
    expect(v.inScope).toEqual(ENDPOINTS);
  });

  it("REFUSES a graphql-capable key: storing that throws away the whole custody win", async () => {
    const v = await verifyInvokeKeyScope(KEY, ENDPOINTS, runpod({ graphqlOk: true }));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("graphql_capable");
    expect(v.detail).toContain("Restricted key");
  });

  it("checks graphql BEFORE probing endpoints, so a powerful key is refused on sight", async () => {
    const f = runpod({ graphqlOk: true });
    await verifyInvokeKeyScope(KEY, ENDPOINTS, f);
    const urls = (f as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("graphql"))).toBe(true);
    expect(urls.some((u) => u.includes("/health"))).toBe(false);
  });

  it("REFUSES a key that misses even one endpoint", async () => {
    const v = await verifyInvokeKeyScope(KEY, ENDPOINTS, runpod({ inScope: ["ep1", "ep2", "ep3"] }));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("endpoint_out_of_scope");
    expect(v.outOfScope).toEqual(["ep4"]);
  });

  it("REFUSES a legacy (pre-scoped-keys) key on its prefix", async () => {
    const v = await verifyInvokeKeyScope("OLDSTYLEKEY", ENDPOINTS, runpod({}));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("bad_prefix");
  });

  it("REFUSES when there are no endpoints to scope against", async () => {
    const v = await verifyInvokeKeyScope(KEY, [], runpod({}));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("no_endpoints");
  });

  it("fails CLOSED on a probe error: an unverifiable key is never accepted", async () => {
    const v = await verifyInvokeKeyScope(KEY, ENDPOINTS, runpod({ error: ["ep3"] }));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("endpoint_unreachable");
  });

  it("does not treat a graphql transport failure as proof the key is safe", async () => {
    // The graphql probe blipping must not hand a pass to a key whose endpoints also fail.
    const f = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("graphql")) throw new Error("network");
      return new Response("forbidden", { status: 403 });
    }) as unknown as typeof fetch;
    const v = await verifyInvokeKeyScope(KEY, ENDPOINTS, f);
    expect(v.ok).toBe(false);
  });
});

describe("hasModernKeyPrefix", () => {
  it("separates post-2024-11 keys from legacy ones", () => {
    expect(hasModernKeyPrefix("rpa_abc")).toBe(true);
    expect(hasModernKeyPrefix("ABCDEF")).toBe(false);
  });
});
