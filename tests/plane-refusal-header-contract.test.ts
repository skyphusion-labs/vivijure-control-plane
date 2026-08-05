// Pin the plane-refusal header string that this repo EMITS and vivijure-cf READS (cf#403).
//
// THE DEFECT THIS EXISTS TO PREVENT. The same wire header is a string literal in two repositories
// with no shared package and no cross-repo CI fetch. A rename on either side without the other
// restores the forever-pend that cf#398 / cp#288 closed: modules call planeRefusalReason(), get
// null because the header name no longer matches, and every refused render goes pending forever.
// Behavioural suites on the cf side construct refusals with the cf-side constant, so they stay
// green while this plane still speaks a different name.
//
// THE CONTROL. Both repos pin the exact same literal in their own unit suite. Renaming either
// constant without updating its pin fails that repo's CI. Renaming both pins to different values
// is a deliberate dual-repo edit; that is the remaining process cost of not sharing a package.
// The cf pin lives at vivijure-cf/tests/plane-refusal-header-contract.test.ts.
//
// This imports the REAL export. A second local "x-vivijure-plane-refusal" here would re-create the
// gap: the suite could pass while src/runpod-proxy-poll.ts had already moved.

import { describe, it, expect } from "vitest";
import { PLANE_REFUSAL_HEADER } from "../src/runpod-proxy-poll";

/** Byte-equal to vivijure-cf `PLANE_REFUSAL_HEADER` in modules/_shared/runpod-route.ts. */
const CONTRACTED_PLANE_REFUSAL_HEADER = "x-vivijure-plane-refusal";

describe("plane-refusal header wire contract (cf#403)", () => {
  it("exports PLANE_REFUSAL_HEADER equal to the contracted literal modules read", () => {
    expect(PLANE_REFUSAL_HEADER).toBe(CONTRACTED_PLANE_REFUSAL_HEADER);
  });

  it("is the exact header name, not a reason value or a longer prefix", () => {
    // Guards against accidental "x-vivijure-plane-refusal:" or a reason baked into the name.
    expect(PLANE_REFUSAL_HEADER).toMatch(/^x-[a-z0-9-]+$/);
    expect(PLANE_REFUSAL_HEADER.includes(":")).toBe(false);
    expect(PLANE_REFUSAL_HEADER.length).toBeLessThan(64);
  });
});
