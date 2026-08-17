// The shared-pool scope gate against the REAL RunPod API and the REAL shared key (cp#396, cp#389).
//
// SKIPS SILENTLY on a PR, FAILS LOUDLY on the deploy path. Same two-mode contract as the
// pre-deploy smoke (cp#255) and for the same reason: a release gate that skips when its
// credentials are absent reports the identical green whether it ran or not.
//
// This suite reads a SECRET and must never render one. Only endpoint ids, which are identifiers,
// reach any assertion or any message.

import { describe, it, expect } from "vitest";
import { verifySharedPoolScope } from "../src/shared-pool-scope";
import { verifyInvokeKeyScope } from "../src/runpod-invoke-key";

declare const process: { env: Record<string, string | undefined> };

/** A REAL public RunPod endpoint the shared invoke key must not cover.
 *  The old control (4q8idwbk6tyqbq, vivijure-video-upscale) was deleted when upscale
 *  moved to the fleet. A 404 reads as endpoint_unreachable, which is not the
 *  instrument. infinitetalk is live public and returns 401 without our scope. */
const OUT_OF_SCOPE_CONTROL = "infinitetalk";

const REQUIRED = process.env.SHARED_POOL_SCOPE_REQUIRED === "1";
const POOL = process.env.SHARED_RUNPOD_ENDPOINTS;
const KEY = process.env.SHARED_RUNPOD_INVOKE_KEY;
const ARMED = Boolean(POOL && KEY);

describe("shared-pool invoke-key scope, live (cp#396)", () => {
  it("BOTH HALVES OR NEITHER, checked in every mode", () => {
    // Deliberately NOT gated on REQUIRED. A plane that sets the key and not the pool (or the
    // reverse) would otherwise leave ARMED false and skip every assertion below, which is a silent
    // pass on the misconfiguration nearest this file.
    const halfConfigured = Boolean(POOL) !== Boolean(KEY);
    expect(halfConfigured, "exactly one of SHARED_RUNPOD_ENDPOINTS / SHARED_RUNPOD_INVOKE_KEY is set; either alone offers nothing").toBe(false);
  });

  it("REQUIRED mode refuses to be a no-op: both halves must be present", () => {
    if (!REQUIRED) return; // opportunistic run; the skips below say so themselves
    const missing: string[] = [];
    if (!POOL) missing.push("SHARED_RUNPOD_ENDPOINTS");
    if (!KEY) missing.push("SHARED_RUNPOD_INVOKE_KEY");
    expect(missing, "SHARED_POOL_SCOPE_REQUIRED=1 but the gate has nothing to check").toEqual([]);
  });

  it.skipIf(!ARMED)("the shared key reaches EVERY endpoint the live pool names", async () => {
    const v = await verifySharedPoolScope(POOL, KEY);
    // A RED HERE IS THE POINT, not a broken test. On the four-key plan a pool must name the video
    // upscale endpoint, and the shared key has no access to it, so this is expected to refuse
    // until either the key scope or the plan changes. That refusal is what must block arming the
    // shared tier (cp#389); it names the endpoint, and it never names the key.
    expect(v.state, v.detail).toBe("scope_verified");
    expect(v.ok, v.detail).toBe(true);
    expect(v.inScope.length).toBeGreaterThan(0);
  });

  it.skipIf(!ARMED)("NEGATIVE CONTROL: the key is REFUSED on a real endpoint it does not cover", async () => {
    // Without this, the assertion above cannot be told apart from a probe that answers 200 to
    // anything: a key with account-wide reach, or a health route ignoring auth, would both read as
    // a clean pass. This is the reading that proves the instrument can fail. Probed on its own, so
    // it holds whether or not the pool happens to name the same endpoint.
    const verdict = await verifyInvokeKeyScope(KEY!, [OUT_OF_SCOPE_CONTROL]);
    expect(verdict.ok, "the shared key reached an endpoint it must not reach").toBe(false);
    expect(verdict.outOfScope).toEqual([OUT_OF_SCOPE_CONTROL]);
    // and NOT because the key is dead: graphql_capable or bad_prefix would mean something else.
    expect(verdict.reason).toBe("endpoint_out_of_scope");
  });
});
