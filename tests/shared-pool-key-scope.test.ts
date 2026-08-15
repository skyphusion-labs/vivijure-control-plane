// The deploy-time shared-pool scope gate (cp#396, cp#389).
//
// EVERY CASE IS PAIRED. A gate worth having refuses some inputs and passes others, and a fake that
// can never answer 200 would refuse everything while looking like coverage. So the in-scope and
// out-of-scope cases run against the SAME fake and differ only in what the key can reach.
//
// WHAT CHANGED WITH THE TRANSPORT SPLIT, because this file used to say the opposite. It used to
// name 4q8idwbk6tyqbq (vivijure-video-upscale) as a POOL ENTRY, on the grounds that a complete pool
// had to cover the upscale plan key and the shared invoke key could not reach that endpoint --
// which was the live, un-arm-able state of the shared tier and the reason for cp#396.
//
// That pairing is now GONE at the source: upscale and audio-upscale are vpc-backed, so a pool is
// two endpoint-backed keys and naming the video-upscale endpoint here is REFUSED outright by
// parseSharedPool. Keeping it as a pool fixture would document a configuration the code now
// rejects.
//
// The realness of an endpoint id only ever mattered where a REAL API answers, so that argument
// lives in the live sibling (shared-pool-key-scope.live.test.ts), which still probes the real
// endpoint with the real key. Against a fake, an unreachable id is unreachable because the fake
// says so, and pretending otherwise would be borrowed authority.

import { describe, it, expect } from "vitest";
import { verifySharedPoolScope } from "../src/shared-pool-scope";
import { endpointBackedPlan } from "../src/runpod";

const KEY = "rpa_testkey_not_a_real_credential";

/** A pool covering every ENDPOINT-BACKED plan key, which is the only shape parseSharedPool accepts.
 *  Derived from the plan, so this fixture cannot claim a shape the code can no longer produce. */
const POOL_FULL = JSON.stringify(
  Object.fromEntries(endpointBackedPlan().map((c) => [c.key, { id: `ep-${c.key}`, name: `vivijure-prod-${c.key}` }])),
);

const ALL_IDS = endpointBackedPlan().map((c) => `ep-${c.key}`);
/** The one the key will not cover in the refusal case. Any pool id serves; this is the last.
 *  Named rather than positional so the assertions below read as a claim, not an index. */
const UNREACHABLE = `ep-${endpointBackedPlan()[endpointBackedPlan().length - 1].key}`;

/** A RunPod that enforces per-endpoint scoping exactly as the #60 probe matrix measured it. */
function fakeRunPod(reachable: string[]) {
  return async (url: RequestInfo | URL): Promise<Response> => {
    const u = String(url);
    if (u.includes("graphql")) return new Response("{}", { status: 401 });
    const id = u.split("/v2/")[1]?.split("/")[0] ?? "";
    if (reachable.includes(id)) return new Response(JSON.stringify({ workers: {} }), { status: 200 });
    return new Response("forbidden", { status: 403 });
  };
}

describe("the deploy-time shared-pool scope gate (cp#396)", () => {
  it("PASSES when the key reaches every endpoint the pool names", async () => {
    const v = await verifySharedPoolScope(POOL_FULL, KEY, fakeRunPod(ALL_IDS));
    expect(v.ok).toBe(true);
    expect(v.state).toBe("scope_verified");
    expect(v.inScope.sort()).toEqual([...ALL_IDS].sort());
    expect(v.outOfScope).toEqual([]);
  });

  it("THE GATE: REFUSES a COMPLETE pool naming an endpoint the key cannot reach", async () => {
    // Every plan key present, the pool well formed, requiredPoolKeys satisfied, and the tier still
    // cannot serve. Nothing else in this repo can see that, which is the whole reason this exists.
    const v = await verifySharedPoolScope(POOL_FULL, KEY, fakeRunPod(ALL_IDS.filter((i) => i !== UNREACHABLE)));
    expect(v.ok).toBe(false);
    expect(v.state).toBe("key_out_of_scope");
    expect(v.outOfScope).toEqual([UNREACHABLE]);
    // It must NAME the endpoint. A refusal that does not say which knob to turn sends the reader
    // to the wrong one, which is its own defect class.
    expect(v.detail).toContain(UNREACHABLE);
  });

  it("CONTROL: the SAME pool passes once the key reaches that endpoint, so the fake is not stuck red", async () => {
    const v = await verifySharedPoolScope(POOL_FULL, KEY, fakeRunPod(ALL_IDS));
    expect(v.ok).toBe(true);
  });

  it("a plane with NEITHER half configured PASSES: no shared tier is a supported shape", async () => {
    const v = await verifySharedPoolScope("", "", fakeRunPod([]));
    expect(v.ok).toBe(true);
    expect(v.state).toBe("no_shared_tier");
  });

  it("REFUSES a pool with no key, naming which half is missing", async () => {
    const v = await verifySharedPoolScope(POOL_FULL, "", fakeRunPod([]));
    expect(v.ok).toBe(false);
    expect(v.state).toBe("half_configured");
    expect(v.detail).toContain("SHARED_RUNPOD_INVOKE_KEY is not");
  });

  it("REFUSES a key with no pool, naming the other half", async () => {
    const v = await verifySharedPoolScope("", KEY, fakeRunPod([]));
    expect(v.ok).toBe(false);
    expect(v.state).toBe("half_configured");
    expect(v.detail).toContain("SHARED_RUNPOD_ENDPOINTS is not");
  });

  it("whitespace is ABSENT, not a value: a blank pool is no shared tier, never a parse failure", async () => {
    const v = await verifySharedPoolScope("   ", "  ", fakeRunPod([]));
    expect(v.state).toBe("no_shared_tier");
  });

  it("carries the pool parser OWN refusal rather than re-deriving one", async () => {
    // An incomplete pool is refused by runpod-pool.ts and this gate must surface that verbatim.
    // Two components restating one rule in two voices is how they drift apart.
    const partial = JSON.stringify({ backend: { id: "ep-backend", name: "b" } });
    const v = await verifySharedPoolScope(partial, KEY, fakeRunPod(["ep-backend"]));
    expect(v.ok).toBe(false);
    expect(v.state).toBe("pool_unparseable");
    expect(v.detail).toContain("SHARED_RUNPOD_ENDPOINTS is missing");
  });

  it("an endpoint that ERRORS counts as out of scope: unconfirmed is never quietly in", async () => {
    const boom = async (url: RequestInfo | URL): Promise<Response> => {
      const u = String(url);
      if (u.includes("graphql")) return new Response("{}", { status: 401 });
      if (u.includes("ep-lipsync")) throw new Error("connection reset");
      return new Response("{}", { status: 200 });
    };
    const v = await verifySharedPoolScope(POOL_FULL, KEY, boom);
    expect(v.ok).toBe(false);
    expect(v.outOfScope).toContain("ep-lipsync");
  });
});

describe("the gate carries the own-iron refusal too (cp#396)", () => {
  it("REFUSES a pool naming a vpc-backed capability, naming which one", async () => {
    // The new refusal parseSharedPool owns. It must reach the deploy in the parser OWN words rather
    // than being re-derived here: two components restating one rule in two voices is how they
    // drift. This is also the exact config an operator would write from muscle memory, since it was
    // the CORRECT config until the transport split.
    const withOwnIron = JSON.stringify({
      backend: { id: "ep-backend", name: "b" },
      lipsync: { id: "ep-lipsync", name: "l" },
      upscale: { id: "4q8idwbk6tyqbq", name: "vivijure-video-upscale" },
    });
    const v = await verifySharedPoolScope(withOwnIron, KEY, fakeRunPod(["ep-backend", "ep-lipsync"]));
    expect(v.ok).toBe(false);
    expect(v.state).toBe("pool_unparseable");
    expect(v.detail).toContain("upscale");
    expect(v.detail).toContain("own-iron");
  });

  it("CONTROL: the SAME pool minus that key passes, so the refusal is the key and not the shape", async () => {
    const clean = JSON.stringify({
      backend: { id: "ep-backend", name: "b" },
      lipsync: { id: "ep-lipsync", name: "l" },
    });
    const v = await verifySharedPoolScope(clean, KEY, fakeRunPod(["ep-backend", "ep-lipsync"]));
    expect(v.ok).toBe(true);
    expect(v.state).toBe("scope_verified");
  });
});
