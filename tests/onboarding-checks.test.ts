import { describe, expect, it } from "vitest";

import {
  KEY_PREFIX,
  STEPS,
  canAdvance,
  costCeilingUsd,
  formatUsd,
  keyShapeHint,
  planWorkerTotal,
  aupAcceptFailureCopy,
  aupPinningRefusalCopy,
  aupUrlPinning,
  invokeRejectionCopy,
  REJECTION_COPY,
  quotaFit,
  scopeVerdict,
  slugHint,
  SLUG_RESERVED,
  stepIndex,
  type PlannedEndpoint,
} from "../public/onboarding-checks.js";

// The hosted onboarding front door (#58). These helpers carry the claims the
// flow makes to a stranger about their money and their RunPod account, so the
// gates get negative tests: a guard that has never been watched to FAIL is not
// a guard.

const PLAN: PlannedEndpoint[] = [
  { key: "backend", label: "backend", purpose: "render", image: "ghcr.io/x/backend", max_workers: 2 },
  { key: "upscale", label: "upscale", purpose: "sharper", image: "ghcr.io/x/upscale", max_workers: 1 },
  { key: "lipsync", label: "lipsync", purpose: "mouths", image: "ghcr.io/x/musetalk", max_workers: 1 },
  { key: "audio-upscale", label: "audio-upscale", purpose: "audio", image: "ghcr.io/x/audio", max_workers: 1 },
];

describe("keyShapeHint", () => {
  it("says nothing on an empty field", () => {
    expect(keyShapeHint("").level).toBe("empty");
    expect(keyShapeHint(null).level).toBe("empty");
    expect(keyShapeHint(undefined).message).toBe("");
  });

  it("accepts a current-format key", () => {
    const hint = keyShapeHint(KEY_PREFIX + "0123456789abcdef");
    expect(hint.level).toBe("ok");
  });

  it("warns on a legacy key (pre-2024-11 keys have different permission semantics)", () => {
    const hint = keyShapeHint("ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
    expect(hint.level).toBe("warn");
    expect(hint.message).toContain(KEY_PREFIX);
  });

  it("warns on a truncated key rather than letting a bad paste reach RunPod", () => {
    expect(keyShapeHint(KEY_PREFIX + "abc").level).toBe("warn");
  });

  it("trims surrounding whitespace from a paste", () => {
    expect(keyShapeHint("  " + KEY_PREFIX + "0123456789abcdef  ").level).toBe("ok");
  });

  it("never echoes the key back in the hint (secret hygiene)", () => {
    const secret = KEY_PREFIX + "supersecretvalue1234";
    expect(keyShapeHint(secret).message).not.toContain("supersecretvalue");
  });
});

describe("planWorkerTotal", () => {
  it("sums the pinned max_workers across the plan", () => {
    expect(planWorkerTotal(PLAN)).toBe(5);
  });

  it("is zero for a missing or empty plan", () => {
    expect(planWorkerTotal([])).toBe(0);
    expect(planWorkerTotal(null)).toBe(0);
  });

  it("ignores rows with a nonsense worker count instead of producing NaN", () => {
    const junk = [
      { key: "a", label: "a", purpose: "", image: "", max_workers: Number.NaN },
      { key: "b", label: "b", purpose: "", image: "", max_workers: -3 },
      { key: "c", label: "c", purpose: "", image: "", max_workers: 2 },
    ] as PlannedEndpoint[];
    expect(planWorkerTotal(junk)).toBe(2);
  });
});

describe("quotaFit", () => {
  it("fits the plan on an account with room", () => {
    const fit = quotaFit(10, 0, PLAN);
    expect(fit.fits).toBe(true);
    expect(fit.needed).toBe(5);
    // available is the room on the ACCOUNT (quota minus what existing
    // endpoints already spend), not the size of this plan.
    expect(fit.available).toBe(10);
    expect(fit.guidance).toEqual([]);
  });

  it("counts the account-wide sum, not just this plan (#60: quota is enforced across ALL endpoints)", () => {
    const fit = quotaFit(10, 7, PLAN);
    expect(fit.fits).toBe(false);
    expect(fit.available).toBe(3);
    expect(fit.needed).toBe(5);
  });

  it("REFUSES rather than half-building when the account has no room", () => {
    const fit = quotaFit(5, 4, PLAN);
    expect(fit.fits).toBe(false);
    expect(fit.message).toContain("Setup stops here");
    expect(fit.guidance.length).toBeGreaterThan(0);
    expect(fit.guidance[0]).toContain("4");
  });

  it("fits exactly at the boundary", () => {
    expect(quotaFit(5, 0, PLAN).fits).toBe(true);
    expect(quotaFit(5, 1, PLAN).fits).toBe(false);
  });

  it("REFUSES when the real quota could not be read, instead of guessing from the balance table", () => {
    for (const bad of [null, undefined, 0, Number.NaN, "unknown"]) {
      const fit = quotaFit(bad as number, 0, PLAN);
      expect(fit.fits).toBe(false);
      expect(fit.known).toBe(false);
      expect(fit.message).toContain("will not guess");
    }
  });

  it("surfaces the REAL number it was given, never a funding tier", () => {
    // Conrad's own account: $50 funded, quota 10 from day one. The docs table
    // says that account should have 5. We report what RunPod actually told us.
    const fit = quotaFit(10, 0, PLAN);
    expect(fit.quota).toBe(10);
    expect(fit.message).toContain("10");
    expect(fit.message).not.toMatch(/\$\d/);
  });
});

describe("costCeilingUsd / formatUsd", () => {
  it("computes the ceiling from wall-clock and the hourly rate", () => {
    // film-2294a9d7 (2026-07-14): 2 shots, 10s of finished video, 362857ms
    // wall-clock, H200 secure at $4.39/hr as listed 2026-07-17.
    const ceiling = costCeilingUsd(362857, 4.39);
    expect(ceiling).toBeCloseTo(0.4425, 3);
    expect(formatUsd(ceiling)).toBe("$0.44");
  });

  it("returns null on junk rather than a fabricated number", () => {
    expect(costCeilingUsd(0, 4.39)).toBeNull();
    expect(costCeilingUsd(-5, 4.39)).toBeNull();
    expect(costCeilingUsd(1000, 0)).toBeNull();
    expect(costCeilingUsd(null, 4.39)).toBeNull();
    expect(costCeilingUsd(1000, null)).toBeNull();
    expect(formatUsd(null)).toBeNull();
    expect(formatUsd(Number.NaN)).toBeNull();
  });

  it("never rounds a real cost down to a free-looking $0.00", () => {
    expect(formatUsd(0.004)).toBe("under $0.01");
    expect(formatUsd(0.001)).not.toBe("$0.00");
  });
});

describe("slugHint (mirrors the control plane's slug rule, #52)", () => {
  it("accepts a normal name", () => {
    expect(slugHint("my-studio").valid).toBe(true);
    expect(slugHint("a1b").valid).toBe(true);
  });

  it("NORMALIZES case and whitespace rather than scolding about it", () => {
    // The server rule is lowercase-only, but rejecting "My-Studio" would be
    // pedantry: we lowercase it, provision the normalized value, and the
    // address preview shows exactly what they will get. Normalizing is only
    // honest because the result is visible before they commit.
    expect(slugHint("  My-Studio  ").valid).toBe(true);
    expect(slugHint("Upper").valid).toBe(true);
  });

  it("REFUSES the reserved names, which are the ones that would break routing", () => {
    for (const reserved of SLUG_RESERVED) {
      const hint = slugHint(reserved);
      expect(hint.valid).toBe(false);
      expect(hint.message).toContain("reserved");
    }
    // The suffix is <slug>.studio.vivijure.com, so "studio" and "www" landing
    // as tenant slugs would collide with the front door itself.
    expect(SLUG_RESERVED).toContain("studio");
    expect(SLUG_RESERVED).toContain("www");
  });

  it("REFUSES shapes the subdomain AND the WfP script name cannot both take", () => {
    for (const bad of ["-lead", "trail-", "has_underscore", "has space", "dot.dot", "ab", "a"]) {
      expect(slugHint(bad).valid).toBe(false);
    }
  });

  it("REFUSES an over-long name", () => {
    expect(slugHint("a".repeat(33)).valid).toBe(false);
    expect(slugHint("a".repeat(32)).valid).toBe(true);
  });

  it("says nothing on an empty field", () => {
    expect(slugHint("").level).toBe("empty");
    expect(slugHint(null).valid).toBe(false);
  });
});

describe("scopeVerdict (key B, the one we actually keep)", () => {
  const FOUR = { ep_backend: true, ep_upscale: true, ep_lipsync: true, ep_audio: true };

  it("accepts a correctly scoped invoke-only key", () => {
    const v = scopeVerdict({ graphql_denied: true, health: FOUR });
    expect(v.ok).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it("REJECTS a full key even though every endpoint works", () => {
    // The dangerous case: a graphql key passes every health check, so "it
    // works" is true and useless as a test. The refusal has to hang on graphql
    // being DENIED, or we would happily store account-wide power forever.
    const v = scopeVerdict({ graphql_denied: false, health: FOUR });
    expect(v.ok).toBe(false);
    expect(v.message).toContain("account access");
  });

  it("REJECTS a key scoped to the wrong endpoints, and names them", () => {
    const v = scopeVerdict({
      graphql_denied: true,
      health: { ep_backend: true, ep_upscale: false, ep_lipsync: true, ep_audio: false },
    });
    expect(v.ok).toBe(false);
    expect(v.message).toContain("ep_upscale");
    expect(v.message).toContain("ep_audio");
    expect(v.message).not.toContain("ep_backend");
  });

  it("REJECTS when the probe is missing, absent, or junk rather than assuming pass", () => {
    for (const junk of [null, undefined, {}, { graphql_denied: true }, { health: FOUR }]) {
      expect(scopeVerdict(junk as never).ok).toBe(false);
    }
  });

  it("REJECTS a truthy-but-not-true graphql_denied (no sloppy coercion on the security check)", () => {
    for (const sloppy of ["true", 1, "yes"]) {
      const v = scopeVerdict({ graphql_denied: sloppy as never, health: FOUR });
      expect(v.ok).toBe(false);
    }
  });

  it("reports BOTH problems when a key is wrong in both ways", () => {
    const v = scopeVerdict({ graphql_denied: false, health: { ep_backend: false } });
    expect(v.ok).toBe(false);
    expect(v.failures.length).toBe(2);
  });
});

describe("invokeRejectionCopy (the control plane's real reason codes)", () => {
  it("explains every reason code src/control-plane/runpod-invoke-key.ts can return", () => {
    for (const reason of ["graphql_capable", "bad_prefix", "endpoint_out_of_scope", "endpoint_unreachable", "no_endpoints"]) {
      expect(REJECTION_COPY[reason]).toBeTruthy();
      expect(invokeRejectionCopy(reason).length).toBeGreaterThan(30);
    }
  });

  it("tells the tenant WHICH way the key is wrong: the fixes are different", () => {
    expect(invokeRejectionCopy("graphql_capable")).toContain("account access");
    expect(invokeRejectionCopy("endpoint_out_of_scope")).toContain("four");
    expect(invokeRejectionCopy("graphql_capable")).not.toBe(invokeRejectionCopy("endpoint_out_of_scope"));
  });

  it("does not blame the tenant for our bug or RunPod's blip", () => {
    expect(invokeRejectionCopy("no_endpoints")).toContain("our bug");
    expect(invokeRejectionCopy("endpoint_unreachable")).toContain("RunPod");
  });

  it("surfaces the server's own words for an unknown reason rather than inventing copy", () => {
    expect(invokeRejectionCopy("brand_new_reason", "the server said this")).toBe("the server said this");
    expect(invokeRejectionCopy(null, null)).toContain("was not accepted");
  });
});

describe("aupAcceptFailureCopy (a consent gate must not lie about consent)", () => {
  it("explains a stale version as the policy moving, not as the tenant's mistake", () => {
    const copy = aupAcceptFailureCopy({ ok: false, stale: true, current: "v4" });
    expect(copy).toContain("policy changed");
    expect(copy).toContain("v4");
    // The load-bearing promise: we do not record consent to unseen wording.
    expect(copy).toContain("never shown");
  });

  it("handles a stale version with no current version reported", () => {
    expect(aupAcceptFailureCopy({ ok: false, stale: true })).toContain("policy changed");
  });

  it("says nothing was saved on a transport failure", () => {
    expect(aupAcceptFailureCopy({ ok: false, error: "boom" })).toContain("Nothing has been saved");
    expect(aupAcceptFailureCopy({})).toContain("Nothing has been saved");
    expect(aupAcceptFailureCopy(null)).toContain("Nothing has been saved");
  });
});

describe("aupUrlPinning (Ernst's immutable-ref rule, docs/legal/hosted/README.md)", () => {
  it("spots the moving forge refs, which is the mistake that actually gets made", () => {
    const moving = [
      "https://github.com/skyphusion-labs/vivijure-control-plane/blob/main/docs/legal/hosted/aup/1.0.0.md",
      "https://github.com/o/r/blob/master/aup.md",
      "https://raw.githubusercontent.com/o/r/main/aup.md",
      "https://github.com/o/r/tree/HEAD/aup.md",
      "https://github.com/o/r/raw/develop/aup.md",
      "https://example.com/refs/heads/main/aup.md",
      // refs/heads/<anything> is a branch by construction, whatever it is called.
      "https://example.com/refs/heads/policy-v1/aup.md",
      // The one that nearly slipped through: raw.githubusercontent.com has no
      // /blob/ segment, and is probably the likeliest way to get this wrong.
      "https://raw.githubusercontent.com/skyphusion-labs/vivijure-control-plane/main/docs/legal/hosted/aup/1.0.0.md",
      "https://raw.githubusercontent.com/o/r/master/aup.md",
    ];
    for (const url of moving) {
      const p = aupUrlPinning(url);
      expect(p.state).toBe("moving");
      expect(p.movingRef).toBeTruthy();
    }
  });

  it("accepts a ref pinned to a commit SHA or a version tag", () => {
    const pinned = [
      "https://github.com/o/r/blob/4143f8e6f0a09b843936c466245806c8a5107a90/aup.md",
      "https://github.com/o/r/blob/4143f8e/aup.md",
      "https://raw.githubusercontent.com/o/r/v1.0.0/aup.md",
      "https://github.com/o/r/blob/1.0.0/aup.md",
    ];
    for (const url of pinned) {
      expect(aupUrlPinning(url).state).toBe("pinned");
    }
  });

  it("says unverifiable rather than crying wolf on a non-forge URL", () => {
    // A client cannot prove immutability. The guard must never false-positive
    // and wrongly close the gate on a perfectly good policy URL.
    for (const url of ["https://vivijure.com/aup/1.0.0", "https://example.org/legal/aup"]) {
      expect(aupUrlPinning(url).state).toBe("unverifiable");
    }
    // A ref that is neither a known-moving name nor a SHA/semver tag could be
    // either; refusing it would be a false positive that closes the gate on a
    // good URL.
    expect(aupUrlPinning("https://github.com/o/r/blob/policy-tag/aup.md").state).toBe("unverifiable");
  });

  it("reports a missing URL rather than treating it as fine", () => {
    expect(aupUrlPinning("").state).toBe("missing");
    expect(aupUrlPinning(null).state).toBe("missing");
    expect(aupUrlPinning(undefined).state).toBe("missing");
  });

  it("does not mistake a branch NAME inside a pinned path for a moving ref", () => {
    // "main" appearing as a directory is not the ref slot.
    expect(aupUrlPinning("https://github.com/o/r/blob/v1.0.0/main/aup.md").state).toBe("pinned");
  });

  // The tag matcher used to be /^v?\d+\.\d+\.\d+[A-Za-z0-9.-]*$/, where the
  // third \d+ is followed by a class that also matches digits. A long digit run
  // could be split n ways, so a FAILING match cost O(n^2) (js/polynomial-redos,
  // the same class CodeQL found in the login door).
  //
  // The cases below are not decoration. Two of them are the exact inputs that
  // caught wrong fixes of mine that looked obviously correct while reading them:
  // one silently WIDENED what was accepted, the other silently NARROWED it.
  // Neither was found by inspection; both were found by differential testing.
  describe("the tag matcher accepts exactly what it always did (ReDoS fix)", () => {
    const pinnedRef = (ref: string) => aupUrlPinning(`https://github.com/o/r/blob/${ref}/aup.md`).state;

    it("still accepts a suffix with NO separator", () => {
      // The fix that REQUIRED a separator broke these two. Guard against it.
      expect(pinnedRef("v1.0.0rc1")).toBe("pinned");
      expect(pinnedRef("1.0.0alpha")).toBe("pinned");
    });

    it("still accepts a separated suffix, and a trailing dot segment", () => {
      expect(pinnedRef("1.0.0-rc1")).toBe("pinned");
      expect(pinnedRef("v1.0.0-rc.1")).toBe("pinned");
      expect(pinnedRef("v1.0.0.4")).toBe("pinned");
    });

    it("still REFUSES a build-metadata plus, which it never accepted", () => {
      // The fix that added "+" to a character class silently started accepting
      // this. It is not a tag shape this ever recognised, so it must stay
      // unverifiable rather than quietly becoming "pinned".
      expect(pinnedRef("v1.0.0+build.5")).toBe("unverifiable");
    });

    it("matches a pathological digit run in linear time, not quadratic", () => {
      // The old pattern took ~100ms at n=16000 and quadrupled per doubling, so
      // n=200000 would have been minutes. A generous ceiling: this is a
      // regression guard against reintroducing the ambiguity, not a benchmark.
      const hostile = `https://github.com/o/r/blob/v1.1.${"1".repeat(200000)}!/aup.md`;
      const started = Date.now();
      aupUrlPinning(hostile);
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });
});

describe("aupPinningRefusalCopy", () => {
  it("owns the mistake instead of blaming the tenant", () => {
    const copy = aupPinningRefusalCopy({ state: "moving", movingRef: "main" });
    expect(copy).toContain("main");
    expect(copy).toContain("our configuration mistake");
    expect(copy).toContain("change after you agreed");
  });

  it("explains a missing policy as a reason not to ask for consent at all", () => {
    expect(aupPinningRefusalCopy({ state: "missing", movingRef: null })).toContain("cannot read");
  });

  it("is silent when there is nothing to refuse", () => {
    expect(aupPinningRefusalCopy({ state: "pinned", movingRef: null })).toBe("");
    expect(aupPinningRefusalCopy({ state: "unverifiable", movingRef: null })).toBe("");
    expect(aupPinningRefusalCopy(null)).toBe("");
  });
});

describe("canAdvance (the gates)", () => {
  it("blocks the rules step until the AUP is accepted", () => {
    expect(canAdvance("rules", { rulesAccepted: false })).toBe(false);
    expect(canAdvance("rules", {})).toBe(false);
    expect(canAdvance("rules", null)).toBe(false);
    expect(canAdvance("rules", { rulesAccepted: true })).toBe(true);
  });

  it("blocks the name step on a local pass alone: the SERVER owns availability", () => {
    expect(canAdvance("name", { slugValid: true, slugAvailable: false })).toBe(false);
    expect(canAdvance("name", { slugValid: false, slugAvailable: true })).toBe(false);
    expect(canAdvance("name", {})).toBe(false);
    expect(canAdvance("name", { slugValid: true, slugAvailable: true })).toBe(true);
  });

  it("blocks the key step until a key is present", () => {
    expect(canAdvance("key", { keyPresent: false })).toBe(false);
    expect(canAdvance("key", {})).toBe(false);
    expect(canAdvance("key", { keyPresent: true })).toBe(true);
  });

  it("blocks the capacity step on a failed OR missing capacity check", () => {
    expect(canAdvance("capacity", { capacity: null })).toBe(false);
    expect(canAdvance("capacity", {})).toBe(false);
    expect(canAdvance("capacity", { capacity: quotaFit(5, 4, PLAN) })).toBe(false);
    expect(canAdvance("capacity", { capacity: quotaFit(10, 0, PLAN) })).toBe(true);
  });

  it("blocks the review step until create is explicitly confirmed", () => {
    expect(canAdvance("review", { confirmed: false })).toBe(false);
    expect(canAdvance("review", {})).toBe(false);
    expect(canAdvance("review", { confirmed: true })).toBe(true);
  });

  it("blocks go-live until key B's scope is verified", () => {
    expect(canAdvance("invoke", {})).toBe(false);
    expect(canAdvance("invoke", { invokeVerified: false })).toBe(false);
    expect(canAdvance("invoke", null)).toBe(false);
    expect(canAdvance("invoke", { invokeVerified: true })).toBe(true);
  });

  it("does not gate the informational steps", () => {
    expect(canAdvance("what", {})).toBe(true);
    expect(canAdvance("build", {})).toBe(true);
  });
});

describe("STEPS / stepIndex", () => {
  it("orders the flow: understand and consent BEFORE the key is asked for", () => {
    expect(STEPS.map((s) => s.key)).toEqual([
      "what", "rules", "name", "key", "capacity", "review", "build", "invoke", "done",
    ]);
    // The slug is required by POST /api/tenant/provision, so it must be
    // collected before the build.
    expect(stepIndex("name")).toBeLessThan(stepIndex("build"));
    // Two-phase custody (#52): key B can only be minted once the endpoints it
    // scopes to exist, so the invoke step MUST sit after the build.
    expect(stepIndex("build")).toBeLessThan(stepIndex("invoke"));
    expect(stepIndex("invoke")).toBeLessThan(stepIndex("done"));
    expect(stepIndex("what")).toBeLessThan(stepIndex("key"));
    expect(stepIndex("rules")).toBeLessThan(stepIndex("key"));
    // Nothing is created on the tenant's account before an explicit review.
    expect(stepIndex("review")).toBeLessThan(stepIndex("build"));
  });

  it("returns -1 for an unknown step", () => {
    expect(stepIndex("nope")).toBe(-1);
  });
});
