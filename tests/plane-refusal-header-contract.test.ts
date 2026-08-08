// Pin the plane-refusal header string that this repo EMITS and vivijure-cf READS (cf#403).
//
// THE DEFECT THIS EXISTS TO PREVENT. The same wire header is a string literal in two repositories
// with no shared package and no cross-repo CI fetch. A rename on either side without the other
// restores the forever-pend that cf#398 / cp#288 closed: modules call planeRefusalReason(), get
// null because the header name no longer matches, and every refused render goes pending forever.
// Behavioural suites on the cf side construct refusals with the cf-side constant, so they stay
// green while this plane still speaks a different name.
//
// WHAT IS ACTUALLY COVERED, and what is NOT. State this precisely: a control that is cited but
// does not exist is worse than an absent one, because it stops the next person checking.
//
//   AUTHORITY   vivijure-core/src/runpod-route.ts  -- the wire value lives here.
//   cf side     modules/_shared/runpod-route.ts is a PURE RE-EXPORT of core (cp#321), so cf and
//               core cannot drift from each other. There is nothing to pin on the cf side and no
//               cf-side pin exists. Do NOT add a `const` to that file to create one: its own
//               comment names that as "the duplicate this change removed, reappearing in the
//               exact file that was fixed".
//   plane side  THIS test pins the literal, and imports the real export so a plane-side rename
//               fails here.
//
// SO THE CONTRACT IS ONE-SIDED, AND THE REMAINING GAP IS REAL. If CORE changes the wire value,
// core stays internally consistent, this plane keeps emitting the old name, and no CI anywhere
// fails -- which is the forever-pend this file exists to prevent, surviving in the one direction
// nothing watches. Closing it needs a cf/core-side pin against the plane's value, or a shared
// package. Until then this test closes the plane half only.
//
// This imports the REAL export. A second local "x-vivijure-plane-refusal" here would re-create the
// gap: the suite could pass while src/runpod-proxy-poll.ts had already moved.

import { describe, it, expect } from "vitest";
import { PLANE_REFUSAL_HEADER } from "../src/runpod-proxy-poll";

/** Byte-equal to `PLANE_REFUSAL_HEADER` in vivijure-core/src/runpod-route.ts, the authority. */
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
