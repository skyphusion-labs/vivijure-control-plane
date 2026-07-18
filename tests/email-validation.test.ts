// looksLikeEmail: acceptance shape AND the ReDoS properties (js/polynomial-redos, CodeQL high).
//
// This function runs on UNAUTHENTICATED input at the login-start door, and it runs BEFORE the rate
// limiter, so anything quadratic in here is reachable by anyone with no throttle in front of it.
// There were no tests for it at all; these exist so both fixes are pinned rather than assumed.

import { describe, it, expect } from "vitest";
import { EMAIL_RE, looksLikeEmail, normalizeEmail } from "../src/auth";

describe("looksLikeEmail: shape", () => {
  it.each([
    "a@b.co",
    "user@example.com",
    "first.last@sub.example.co.uk",
    "user+tag@example.org",
  ])("accepts %s", (e) => {
    expect(looksLikeEmail(e)).toBe(true);
  });

  it.each([
    ["no at sign", "example.com"],
    ["no dot in domain", "user@example"],
    ["empty local part", "@example.com"],
    ["empty domain", "user@"],
    ["whitespace", "us er@example.com"],
    ["two at signs", "a@b@c.com"],
    ["empty", ""],
    ["leading dot in domain", "user@.com"],
  ])("rejects %s", (_label, e) => {
    expect(looksLikeEmail(e)).toBe(false);
  });

  it("rejects consecutive dots, a DELIBERATE tightening over the old pattern", () => {
    // The previous regex accepted this. It is not deliverable, so rejecting it is correct; recorded
    // as a test so the change is reviewed rather than discovered.
    expect(looksLikeEmail("a@b..c")).toBe(false);
  });
});

describe("looksLikeEmail: ReDoS resistance", () => {
  // THE ADVERSARIAL INPUT, measured rather than imagined. The blow-up needs a FAILING match: the
  // trailing at-sign cannot be consumed by the segment class, so the engine backtracks across every
  // way of splitting the repeated run between the segment and the separator.
  //
  // Against the ORIGINAL implementation this is quadratic and reachable: 10k reps ~90ms, 40k ~1.4s,
  // 80k ~5.5s of pure CPU. On an unauthenticated endpoint sitting BEFORE the rate limiter, on a
  // Worker with a CPU budget, that is a denial of service from one request body.
  const adversarial = (reps: number) => "a@" + "b.".repeat(reps) + "@";

  it("returns promptly on unbounded adversarial input", () => {
    // HONEST SCOPE, stated because the obvious claim would be wrong: this does NOT isolate the
    // length-check ordering. The two fixes are redundant by design, so with a linear pattern the
    // ordering makes no observable difference, and reverting it alone leaves this test green. That
    // was mutation-tested rather than assumed.
    //
    // What this DOES pin is the property that matters operationally: unbounded adversarial input
    // returns fast. It fails only if BOTH fixes regress, which is exactly when the endpoint becomes
    // vulnerable again. The pattern itself is isolated by the EMAIL_RE test below.
    const evil = adversarial(80_000);
    const started = Date.now();
    expect(looksLikeEmail(evil)).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("rejects over-long input on length alone", () => {
    const overLong = "a".repeat(255) + "@example.com";
    expect(looksLikeEmail(overLong)).toBe(false);
    expect(overLong.length).toBeGreaterThan(254);
  });

  it("accepts an address exactly at the cap", () => {
    // POSITIVE CONTROL for the cap: without this, a cap of 0 would satisfy the rejection tests.
    const local = "a".repeat(254 - "@example.com".length);
    const atCap = local + "@example.com";
    expect(atCap.length).toBe(254);
    expect(looksLikeEmail(atCap)).toBe(true);
  });

  it("the PATTERN ITSELF is linear, independent of the length cap", () => {
    // Defence in depth, tested separately on purpose. The cap alone would hide a quadratic pattern
    // from every test above, so this exercises EMAIL_RE directly on input the cap would have
    // rejected. If someone reintroduces an ambiguous pattern, this fails even though the shipped
    // function stays fast.
    const evil = adversarial(80_000);
    const started = Date.now();
    expect(EMAIL_RE.test(evil)).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims, so identity is canonical in one place", () => {
    expect(normalizeEmail("  User@Example.COM  ")).toBe("user@example.com");
  });
});
