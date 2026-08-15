// The deploy-time shared-pool scope gate (cp#396, cp#389).
//
// EVERY CASE IS PAIRED. A gate worth having refuses some inputs and passes others, and a fake that
// can never answer 200 would refuse everything while looking like coverage. So the in-scope and
// out-of-scope cases run against the SAME fake and differ only in what the key can reach.
//
// THE OUT-OF-SCOPE FIXTURE IS THE REAL PRODUCTION PAIRING, NOT AN INVENTED ONE. 4q8idwbk6tyqbq is
// vivijure-video-upscale, live on the account, and it is the endpoint a pool MUST name for the
// upscale plan key today. Conrad minted the shared invoke key with no access to it. So the second
// case below is not a hypothetical: it is the live state of the shared tier, and it is why
// cp#389 cannot simply be armed.
//
// A made-up id would also produce a refusal, and that refusal would read identically while meaning
// something else entirely: nothing there, rather than there and refused.

import { describe, it, expect } from "vitest";
import { verifySharedPoolScope } from "../src/shared-pool-scope";

const VIDEO_UPSCALE = "4q8idwbk6tyqbq"; // real, live, and outside the shared key scope by design
const KEY = "rpa_testkey_not_a_real_credential";

/** A pool naming every plan key, which is the only shape parseSharedPool accepts. */
const POOL_FULL = JSON.stringify({
  backend: { id: "ep-backend", name: "vivijure-prod-backend" },
  upscale: { id: VIDEO_UPSCALE, name: "vivijure-video-upscale" },
  lipsync: { id: "ep-lipsync", name: "vivijure-prod-lipsync" },
  "audio-upscale": { id: "ep-audio", name: "vivijure-prod-audio-upscale" },
});

const ALL_IDS = ["ep-backend", VIDEO_UPSCALE, "ep-lipsync", "ep-audio"];

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
    const v = await verifySharedPoolScope(POOL_FULL, KEY, fakeRunPod(["ep-backend", "ep-lipsync", "ep-audio"]));
    expect(v.ok).toBe(false);
    expect(v.state).toBe("key_out_of_scope");
    expect(v.outOfScope).toEqual([VIDEO_UPSCALE]);
    // It must NAME the endpoint. A refusal that does not say which knob to turn sends the reader
    // to the wrong one, which is its own defect class.
    expect(v.detail).toContain(VIDEO_UPSCALE);
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
