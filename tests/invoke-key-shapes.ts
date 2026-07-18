// CANONICAL invoke-key response shapes: ONE source of truth, imported by BOTH
// the server suite (routes.test.ts, which asserts the route actually serves
// these) and the client suite (onboarding-invoke-key.test.ts, which drives the
// browser interpretation of them).
//
// WHY THIS FILE EXISTS. control-plane#20 and its client-side twin were the same
// defect twice in two days: a caller confidently encoding a contract the server
// does not serve, with a green suite on both sides. Hand-copied fixtures cannot
// fix that, because being careful is not a mechanism -- the copy just goes
// stale silently. Shared fixtures plus an EXACT key-set assertion on the server
// side turn that drift into a red test in the suite that caused it.
//
// THE ASSERTION STYLE MATTERS AS MUCH AS THE FIXTURE. toMatchObject is a SUBSET
// match: it passes when the response grows a field the fixture lacks, and when
// the fixture is a stale subset of the response. Asserting these shapes with
// toMatchObject alone would rebuild the exact trap this file exists to close.
// Use expectExactKeys() so an added, renamed, or removed field FAILS.

// Exact key set of the 200 go-live body. modules_unverified is ABSENT when
// empty (the route spreads it conditionally), so it is not in this list.
export const LIVE_KEYS = [
  "modules_ready",
  "modules_verified",
  "status",
  "verified_endpoints",
] as const;

// Exact key set of the 200 body when some module could not be PROVEN ready.
export const LIVE_UNVERIFIED_KEYS = [...LIVE_KEYS, "modules_unverified"].sort();

// Exact key set of the 202 installed-but-unconfirmed body.
export const UNCONFIRMED_KEYS = [
  "message",
  "modules_ready",
  "modules_unconfirmed",
  "modules_verified",
  "status",
  "verified_endpoints",
] as const;

// NOTE ON THE REMOVED SUMMARY FIELD: cp#20 removes ok from BOTH success bodies.
// It is deliberately absent from every key set above. If ok reappears, the
// exact-key assertions fail, which is the point: it flattened the
// live-but-unproven case into an unqualified success, and that is what shipped
// a lie to a customer.

// 200, fully proven: live and every module observed ready.
export const LIVE_PROVEN = {
  status: "live",
  verified_endpoints: 4,
  modules_ready: true,
  modules_verified: ["backend", "upscale", "lipsync", "audio-upscale"],
};

// 200, LIVE BUT NOT PROVEN. The subtle one: a real, non-failing state where a
// module image predates GET /ready. 200 means LIVE; modules_ready means PROVEN.
// A client that reads 200 as unqualified success re-swallows what cf#114 closed.
export const LIVE_UNVERIFIED = {
  status: "live",
  verified_endpoints: 4,
  modules_ready: false,
  modules_verified: ["backend", "upscale"],
  modules_unverified: ["lipsync", "audio-upscale"],
};

// 202: key IS installed and stored, propagation not yet observed, NOT live.
// status is the TRUE stored lifecycle value, not an invented label. message
// interpolates attempts and elapsedMs, so it cannot be byte-exact; assert the
// stable substrings in MESSAGE_MUST_SAY instead.
export const UNCONFIRMED = {
  status: "awaiting_invoke_key",
  verified_endpoints: 4,
  modules_ready: false,
  modules_verified: ["backend"],
  modules_unconfirmed: ["lipsync", "audio-upscale"],
  message:
    "your key is installed and stored. Your render modules have not finished picking it up yet " +
    "(checked 6 times over 9800ms). This usually clears in under a minute: retry this request to " +
    "finish going live. Do not re-paste your key; nothing is wrong with it.",
};

// KNOWN UNCOVERED VARIANT, stated rather than left to be discovered: a 202 can ALSO carry
// modules_unverified (the route spreads it into both success bodies). No test drives that
// combination, on either side, so there is no key set for it here. It is a real shape; if you add a
// test for it, add its key set rather than making UNCONFIRMED_KEYS tolerate an optional field --
// allowing one optional key inside a single set is a subset match wearing a disguise, which is the
// exact weakness this file exists to remove.

// The claims the 202 message MUST keep making. If a rewording drops one of
// these, the customer loses the reason not to re-paste their credential.
export const MESSAGE_MUST_SAY = [/installed/i, /stored/i, /retry/i, /do not re-paste/i];

// Failure bodies. Unlike the success bodies these all carry a diagnostic,
// which is why the OLD client produced a blank refusal on SUCCESS only.
export const REJECTED = {
  error: "invoke_key_rejected",
  reason: "graphql_capable",
  message: "key has account access",
};
export const NOT_PROVISIONED = {
  error: "not_provisioned",
  message: "your studio was not fully provisioned; retry provisioning before installing a key",
};
export const MODULES_NOT_READY = {
  error: "modules_not_ready",
  step: "verify",
  message:
    "module keyframe (ten-abc123-keyframe) /ready -> 200: endpoint id absent " +
    "(not retryable; attempts=1, elapsed=120ms)",
};

// Exact key-set equality. Subset matching is what let the contract drift.
export function expectExactKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "invoke-key response shape DRIFTED.\n" +
        "  expected keys: " + expected.join(", ") + "\n" +
        "  actual keys:   " + actual.join(", ") + "\n" +
        "If this change is intended, update tests/invoke-key-shapes.ts AND the client that reads " +
        "it (public/onboarding-checks.js invokeKeyVerdict). Both, in the same release.",
    );
  }
}
