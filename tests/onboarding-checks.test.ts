import { describe, expect, it } from "vitest";

import {
  KEY_PREFIX,
  STEPS,
  canAdvance,
  provisionFailureCopy,
  resumeStep,
  slugVerdict,
  planCanProvision,
  invokeRequirement,
  costCeilingUsd,
  formatUsd,
  keyShapeHint,
  planWorkerTotal,
  planRowMeta,
  planSummaryCopy,
  aupAcceptFailureCopy,
  aupPinningRefusalCopy,
  aupUrlPinning,
  invokeRejectionCopy,
  REJECTION_COPY,
  quotaFit,
  slugHint,
  SLUG_RESERVED,
  stepIndex,
  PROVISION_FIRST_POLL_MS,
  PROVISION_PRE_BOUNDARY_POLL_MS,
  PROVISION_POLL_MS,
  PROVISION_WATCH_MS,
  PROVISION_ROWS,
  pastResumeBoundary,
  provisionWaitNote,
  provisionPollDelayMs,
  provisionRows,
  provisionWaitCopy,
  provisionTimeoutCopy,
  type PlannedEndpoint,
  type ProvisionJobView,
} from "../public/onboarding-checks.js";
// The SERVER list, imported rather than restated: the point of the pin below is
// that the UI cannot drift from it.
import { PROVISION_STEPS } from "../src/provisioner";

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

describe("planRowMeta / planSummaryCopy (cp#474)", () => {
  it("does not say scale-to-zero about own-iron", () => {
    expect(planRowMeta({ key: "upscale", label: "Video upscale", backing: "door", gpu: "our hardware" }))
      .toBe("our hardware");
    expect(planRowMeta({ key: "upscale", label: "Video upscale", backing: "door" }))
      .toBe("our hardware");
    expect(planRowMeta({ key: "upscale", label: "Video upscale", backing: "door", gpu: "our hardware" }))
      .not.toMatch(/scale-to-zero/);
  });

  it("keeps the worker pin and scale-to-zero on a pooled row", () => {
    const line = planRowMeta({
      key: "backend",
      label: "Render",
      backing: "runpod",
      max_workers: 2,
      gpu: "NVIDIA H200 / NVIDIA B200",
    });
    expect(line).toContain("NVIDIA H200 / NVIDIA B200");
    expect(line).toContain("max 2 workers");
    expect(line).toContain("scale-to-zero");
  });

  it("treats a missing backing as pooled, so an older payload still has a meta line", () => {
    expect(planRowMeta({ key: "backend", label: "Render", max_workers: 2 })).toContain("scale-to-zero");
  });

  it("summarises a mixed plan without calling own-iron scale-to-zero", () => {
    const copy = planSummaryCopy([
      { key: "backend", label: "Render", backing: "runpod", max_workers: 2 },
      { key: "upscale", label: "Video upscale", backing: "door" },
      { key: "lipsync", label: "Lip sync", backing: "runpod", max_workers: 1 },
      { key: "audio-upscale", label: "Audio upscale", backing: "door" },
    ]);
    expect(copy).toMatch(/3 workers/);
    expect(copy).toMatch(/shared GPU pool/);
    expect(copy).toMatch(/2 capabilities on our own hardware/);
    expect(copy).not.toMatch(/across 4 endpoints, all scale-to-zero/);
  });

  it("is empty on an empty plan rather than inventing a total", () => {
    expect(planSummaryCopy([])).toBe("");
    expect(planSummaryCopy(null)).toBe("");
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


  it("blocks the review step until create is explicitly confirmed", () => {
    expect(canAdvance("review", { confirmed: false })).toBe(false);
    expect(canAdvance("review", {})).toBe(false);
    expect(canAdvance("review", { confirmed: true })).toBe(true);
  });

  it("blocks go-live until key B's scope is verified", () => {
    expect(canAdvance("go-live", {})).toBe(false);
    expect(canAdvance("go-live", { invokeVerified: false })).toBe(false);
    expect(canAdvance("go-live", null)).toBe(false);
    expect(canAdvance("go-live", { invokeVerified: true })).toBe(true);
  });

  it("does not gate the informational steps", () => {
    expect(canAdvance("what", {})).toBe(true);
    expect(canAdvance("build", {})).toBe(true);
  });
});

describe("STEPS / stepIndex", () => {
  it("orders the flow: understand and consent BEFORE anything is created (cp#427)", () => {
    // SEVEN steps since the BYOK purge. Setup key and Your capacity retired with the path they
    // served: the first asked for a RunPod key the plane no longer accepts, and the second
    // probed the CUSTOMER own quota, which is meaningless when the capacity is ours. Capacity
    // additionally POSTed to a route that never existed (cp#467), so it was a hard stop.
    expect(STEPS.map((s) => s.key)).toEqual([
      "what", "rules", "name", "review", "build", "go-live", "done",
    ]);
    // The invariants that SURVIVE the purge, and they are the ones that mattered.
    //
    // The slug is required by POST /api/tenant/provision, so it is collected before the build.
    expect(stepIndex("name")).toBeLessThan(stepIndex("build"));
    // Going live can only happen once the endpoints exist, so it sits after the build.
    expect(stepIndex("build")).toBeLessThan(stepIndex("go-live"));
    expect(stepIndex("go-live")).toBeLessThan(stepIndex("done"));
    // NOTHING IS CREATED ON ANYBODY BEHALF BEFORE AN EXPLICIT REVIEW. This is the load-bearing
    // one and it is unchanged by the purge.
    expect(stepIndex("review")).toBeLessThan(stepIndex("build"));
    // Consent still precedes naming, which is the first thing that can take a slug.
    expect(stepIndex("rules")).toBeLessThan(stepIndex("name"));
  });

  it("returns -1 for an unknown step", () => {
    expect(stepIndex("nope")).toBe(-1);
  });
});

// ---- cp#124: the provision poll boundary --------------------------------
//
// The defect these cover is not cosmetic. A poll that lands before the plane
// records `wfp_upload` cannot drive the job (the setup key is never stored, so
// the keyless continuation refuses by design, cp#18); all it can do is take the
// job lease and write that refusal, which marks a HEALTHY provision failed and
// rolls the half-built tenant back. Live on 2026-07-25 (vivijure-cf#240):
// attempt 1 polled immediately and declared the failure, attempt 2 waited past
// the boundary and went 9/9.

const PRE_BOUNDARY: ProvisionJobView = {
  kind: "provision",
  status: "running",
  step: "r2_token",
  steps_done: ["d1_create", "d1_migrate", "r2_bucket", "r2_token"],
};

const PAST_BOUNDARY: ProvisionJobView = {
  kind: "provision",
  status: "running",
  step: "modules_upload",
  steps_done: [
    "d1_create", "d1_migrate", "r2_bucket", "r2_token", "runpod_endpoints",
    "wfp_upload", "modules_upload",
  ],
};

describe("pastResumeBoundary (the fact the cadence is decided by)", () => {
  it("is FALSE for a job that has not recorded the boundary step", () => {
    expect(pastResumeBoundary(PRE_BOUNDARY)).toBe(false);
  });

  it("is false for a job with no progress at all, and for nothing at all", () => {
    expect(pastResumeBoundary({ status: "queued", steps_done: [] })).toBe(false);
    expect(pastResumeBoundary(null)).toBe(false);
    expect(pastResumeBoundary(undefined)).toBe(false);
    // A malformed payload must not read as "past the boundary": that would be
    // the optimistic direction, and the optimistic direction kills provisions.
    expect(pastResumeBoundary({ status: "running" } as ProvisionJobView)).toBe(false);
  });

  it("is true once steps_done carries the boundary step", () => {
    expect(pastResumeBoundary(PAST_BOUNDARY)).toBe(true);
  });

  it("reads steps_done, NOT the elapsed clock or the step field", () => {
    // A job whose CURRENT step is past the boundary but whose recorded progress
    // is not: we believe the record, because the record is what the resume
    // reads. Anything else is the UI guessing on the tenant behalf.
    expect(pastResumeBoundary({ status: "running", step: "verify", steps_done: ["d1_create"] })).toBe(false);
  });
});

describe("provisionPollDelayMs (slow before the boundary, fast after)", () => {
  it("waits the slow cadence while the poll cannot drive anything", () => {
    expect(provisionPollDelayMs(PRE_BOUNDARY)).toBe(PROVISION_PRE_BOUNDARY_POLL_MS);
    expect(PROVISION_PRE_BOUNDARY_POLL_MS).toBeGreaterThan(PROVISION_POLL_MS);
  });

  it("polls fast once the poll IS the engine", () => {
    expect(provisionPollDelayMs(PAST_BOUNDARY)).toBe(PROVISION_POLL_MS);
  });

  it("does not wait at all on a terminal job", () => {
    expect(provisionPollDelayMs({ status: "succeeded", steps_done: [] })).toBe(0);
    expect(provisionPollDelayMs({ status: "failed", steps_done: [] })).toBe(0);
  });

  it("the first poll waits long enough to clear the boundary, and not so long it outlives the server patience", () => {
    // The plane calls a driver lost after 10 minutes (MAX_JOB_STALE_MS in
    // src/index.ts) and the whole pre-install prefix measured about 22s.
    expect(PROVISION_FIRST_POLL_MS).toBeGreaterThanOrEqual(60000);
    expect(PROVISION_FIRST_POLL_MS).toBeLessThan(10 * 60 * 1000);
  });
});

describe("provisionRows (the build screen speaks the plane OWN step names)", () => {
  it("every step the provisioner can record is covered by exactly one row", () => {
    // THE ANTI-DRIFT PIN. PROVISION_STEPS is imported from the shipped server
    // source, so a renamed or added step fails here instead of silently
    // rendering as a row that never lights up (which is what shipped: the rows
    // read d1/r2/runpod/studio/verify and only "verify" ever matched).
    const covered = PROVISION_ROWS.flatMap((row) => row.steps);
    expect([...covered].sort()).toEqual([...PROVISION_STEPS].sort());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it("marks a row done only when ALL of its steps are done", () => {
    const rows = provisionRows({ status: "running", step: "d1_migrate", steps_done: ["d1_create"] });
    const db = rows.find((r) => r.key === "database");
    expect(db?.status).toBe("running");
    const done = provisionRows({ status: "running", step: "r2_bucket", steps_done: ["d1_create", "d1_migrate"] });
    expect(done.find((r) => r.key === "database")?.status).toBe("done");
  });

  it("renders a real in-flight job as progress, not as five untouched rows", () => {
    const rows = provisionRows(PAST_BOUNDARY);
    expect(rows.find((r) => r.key === "database")?.status).toBe("done");
    expect(rows.find((r) => r.key === "storage")?.status).toBe("done");
    expect(rows.find((r) => r.key === "endpoints")?.status).toBe("done");
    expect(rows.find((r) => r.key === "studio")?.status).toBe("done");
    expect(rows.find((r) => r.key === "modules")?.status).toBe("running");
    expect(rows.find((r) => r.key === "verify")?.status).toBe("todo");
  });

  it("shows the REAL step error verbatim, on the row that failed", () => {
    const rows = provisionRows({
      status: "failed",
      step: "runpod_endpoints",
      steps_done: ["d1_create", "d1_migrate", "r2_bucket", "r2_token"],
      error_step: "runpod_endpoints",
      error_message: "your RunPod worker quota is 10 and this plan needs 12",
    });
    const ep = rows.find((r) => r.key === "endpoints");
    expect(ep?.status).toBe("failed");
    expect(ep?.error).toBe("your RunPod worker quota is 10 and this plan needs 12");
  });

  it("never drops a failure it cannot place: a PRECONDITION failure gets its own row", () => {
    // bundle_fetch is deliberately not a PROVISION_STEP (it creates nothing),
    // and it is exactly the failure a bad release pin produces.
    const rows = provisionRows({
      status: "failed",
      step: "d1_create",
      steps_done: [],
      error_step: "bundle_fetch",
      error_message: "no bundle for release v9.9.9",
    });
    const extra = rows.find((r) => r.key === "bundle_fetch");
    expect(extra?.status).toBe("failed");
    expect(extra?.error).toBe("no bundle for release v9.9.9");
  });

  it("renders nothing-yet as all todo rather than throwing", () => {
    expect(provisionRows(null).every((r) => r.status === "todo")).toBe(true);
  });
});

describe("the waiting screen says what it is doing", () => {
  it("counts down in seconds and never claims a step is done", () => {
    expect(provisionWaitCopy(90000)).toContain("90 seconds");
    expect(provisionWaitCopy(1000)).toContain("1 second");
    expect(provisionWaitCopy(0)).toBe("Checking on your studio now");
    expect(provisionWaitCopy(null)).toBe("Checking on your studio now");
  });

  it("describes the wait it is ACTUALLY doing, not the constant", () => {
    // The preview compresses the wait; a note reading 90 over a screen counting
    // 3 is a small lie on the one screen that must not tell any.
    expect(provisionWaitNote(3000)).toContain("3 seconds");
    expect(provisionWaitNote(PROVISION_FIRST_POLL_MS)).toContain("90 seconds");
    expect(provisionWaitNote(null)).toContain("90 seconds");
  });

  it("stops watching out loud, with the real number of minutes", () => {
    const copy = provisionTimeoutCopy();
    const minutes = Math.floor((PROVISION_FIRST_POLL_MS + PROVISION_WATCH_MS) / 60000);
    expect(copy).toContain(String(minutes));
    expect(copy).toContain("reload this page");
  });
});

// cp#435: THE SLUG PREVIEW AND THE DESTRUCTIVE CASE.
//
// GET /api/tenant/slug-available answers available AND reclaimable. reclaimable means the name is
// free TO THIS ACCOUNT because the row behind it is that account own unfinished studio, and
// provisioning over it is a teardown with deleteData true, not a resume. The client used to read
// only availability and print is free, so an operator-provisioned owner could be told his own
// studio name was available and then destroy it by clicking Continue.
//
// RED ON MAIN: slugVerdict does not exist there, and canAdvance(name) opens on availability alone.
describe("slugVerdict / the reclaim gate (cp#435)", () => {
  it("prints a plain free for a name nobody holds", () => {
    const v = slugVerdict({ available: true, reclaimable: false }, "fresh");
    expect(v.state).toBe("free");
    expect(v.level).toBe("ok");
    expect(v.text).toMatch(/is free/);
  });

  it("NEVER says free about a studio the account already has", () => {
    // The exact sentence that preceded a silent teardown.
    const v = slugVerdict({ available: true, reclaimable: true }, "conrad");
    expect(v.state).toBe("reclaim");
    expect(v.text).not.toMatch(/is free/);
    // And it must name the consequence, not merely decline to reassure.
    expect(v.text).toMatch(/DELETES/);
    expect(v.level).toBe("bad");
  });

  it("still reports a taken name with the plane own reason", () => {
    const v = slugVerdict({ available: false, reason: "that name is taken" }, "mine");
    expect(v.state).toBe("taken");
    expect(v.text).toMatch(/that name is taken/);
  });

  it("treats a missing reclaimable as NOT reclaimable, so an old payload cannot open the gate", () => {
    expect(slugVerdict({ available: true }, "x").state).toBe("free");
  });

  it("opens the name gate on an ordinary free slug, unchanged", () => {
    expect(canAdvance("name", { slugValid: true, slugAvailable: true })).toBe(true);
  });

  it("REFUSES to advance over the account own studio without an explicit acknowledgement", () => {
    const s = { slugValid: true, slugAvailable: true, slugReclaimable: true };
    expect(canAdvance("name", s)).toBe(false);
    expect(canAdvance("name", { ...s, slug: "conrad", slugReclaimConfirmedFor: "conrad" })).toBe(true);
  });

  it("does not accept a truthy accident as consent to destroy a studio", () => {
    const s = {
      slugValid: true,
      slugAvailable: true,
      slugReclaimable: true,
      slug: "conrad",
      slugReclaimConfirmedFor: 1 as unknown as string,
    };
    expect(canAdvance("name", s)).toBe(false);
  });

  // CONSENT DOES NOT CARRY (cp#446 review). Ernst caught that the revocation was claimed,
  // implemented and UNTESTED: resetReclaimAck existed, checkSlug called it, and deleting it broke
  // nothing red. A behaviour only the prose asserts is one the next refactor removes in silence.
  //
  // So the revocation stopped being a side effect and became a PROPERTY: consent records WHICH
  // name it was given for, and the gate compares that to the name about to be destroyed. Now the
  // guard holds even if every DOM reset in the file is deleted, and it is testable without a DOM.
  it("NEVER lets consent for one studio open the gate for a different one", () => {
    const s = { slugValid: true, slugAvailable: true, slugReclaimable: true, slugReclaimConfirmedFor: "alpha" };
    // Acknowledged alpha, now standing on beta: this is the edit-away case, and it must refuse.
    expect(canAdvance("name", { ...s, slug: "beta" })).toBe(false);
    // Same consent, back on the name it was actually given for.
    expect(canAdvance("name", { ...s, slug: "alpha" })).toBe(true);
  });

  it("treats an empty or missing slug as nothing to consent to", () => {
    // Guards the degenerate pair: a blank recorded name must not match a blank current one and
    // wave the destruction through on two absences agreeing with each other.
    expect(canAdvance("name", { slugValid: true, slugAvailable: true, slugReclaimable: true, slug: "", slugReclaimConfirmedFor: "" })).toBe(false);
    expect(canAdvance("name", { slugValid: true, slugAvailable: true, slugReclaimable: true })).toBe(false);
  });
});

// cp#455: WHERE A FRESH ARRIVAL BELONGS.
//
// init() showed step 1 unconditionally and never read /api/me, which is the single root under five
// separate defects: the wizard did not know a tenant existed (cp#435), a control labelled Back
// advanced into a step with a null tenant id (cp#447), the endpoint list sat on a literal
// loading... forever (cp#449), and See what happened delivered a sales pitch to somebody whose
// studio had just failed.
//
// RED ON MAIN: resumeStep does not exist there.
describe("resumeStep (cp#455)", () => {
  const ok = { id: "acct_1", email: "a@b.c" };
  const aup = { required_version: "1.1.0", accepted: true };
  const at = (status: string) => ({ account: ok, aup: aup, tenant: { id: "ten_1", slug: "s", status: status } });

  it("leaves a signed-out or un-accepted visitor at the start, exactly as today", () => {
    expect(resumeStep(null).step).toBe("what");
    expect(resumeStep({}).step).toBe("what");
    expect(resumeStep({ account: ok, aup: { required_version: "1.1.0", accepted: false } }).step).toBe("what");
  });

  it("sends an account with NO tenant to step 1, which is the self-served path and must not move", () => {
    // The regression control. Most people who reach this page are creating a studio, and that
    // flow is the one thing this change must leave alone.
    const r = resumeStep({ account: ok, aup: aup, tenant: null });
    expect(r.step).toBe("what");
    expect(r.reason).toBe("no_tenant");
  });

  it("resumes a build in flight instead of offering to start a new one", () => {
    expect(resumeStep(at("pending")).step).toBe("build");
    expect(resumeStep(at("provisioning")).step).toBe("build");
  });

  it("lands an awaiting_go_live tenant on go-live, including the dead BYOK status name", () => {
    const r = resumeStep(at("awaiting_go_live"));
    expect(r.step).toBe("go-live");
    expect(r.reason).toBe("awaiting_go_live");
    expect(resumeStep(at("awaiting_invoke_key")).step).toBe("go-live");
  });

  it("shows a FAILED studio its failure, rather than five minutes to your own studio", () => {
    // The link says See what happened. Landing on step 1 makes that label a false promise, and a
    // link label is a contract with whoever clicks it.
    const r = resumeStep(at("failed"));
    expect(r.step).toBe("build");
    expect(r.reason).toBe("failed");
  });

  it("sends a live studio to the finished screen", () => {
    expect(resumeStep(at("live")).step).toBe("done");
  });

  it("REFUSES to start a wizard for a studio that is not in setup at all", () => {
    // Suspended, deleting and deleted are real states the FRONT DOOR has screens for and this
    // page does not. Offering setup for a deleted studio is the same confidently-wrong screen
    // this whole issue is about, so step is null and the page says so.
    for (const s of ["suspended", "deleting", "deleted"]) {
      expect(resumeStep(at(s)).step, s).toBeNull();
    }
  });

  it("does not guess on a status it has never heard of", () => {
    const r = resumeStep(at("reticulating"));
    expect(r.step).toBeNull();
    expect(r.reason).toBe("not_in_setup");
  });
});

// cp#439: THE TIER DECIDES WHETHER A KEY IS A QUESTION, AT TWO DIFFERENT MOMENTS.
//
// A shared-tier tenant hit a wall at step 4 (the wizard would not advance without a pasted key)
// and again at step 8 (the plane REFUSES a pasted key and the winning request carries none). Both
// walls came from the same assumption -- everyone is BYOK -- and neither step could know better,
// because the tier was not projected anywhere the client could read.
//
// The two facts are deliberately NOT the same field, and that is the load-bearing part: at step 4
// no tenant exists yet (createTenant runs inside the provision this step leads to), so only a
// PLATFORM flag can answer it; at step 8 the tenant exists and carries its own mode.
describe("the tier questions after the BYOK purge (cp#427, cp#439)", () => {
  // These replace the optional-key tests. Under cp#427 there is no key to make optional and no
  // second tier to select, so the PLATFORM question widened from is a key optional to can this
  // plane provision at all, and the TENANT question lost its byok answer.

  it("says a pooling plane can provision", () => {
    expect(planCanProvision({ shared_tier_available: true })).toBe(true);
  });

  it("says a plane with no pool CANNOT, and defaults to cannot on a payload that does not say", () => {
    // Fail toward refusing. The provision route refuses a poolless plane, so a wizard that
    // assumed otherwise would walk somebody through naming a studio it could never build.
    expect(planCanProvision({ shared_tier_available: false })).toBe(false);
    expect(planCanProvision({})).toBe(false);
    expect(planCanProvision(null)).toBe(false);
  });

  it("does not accept a truthy accident as capacity", () => {
    expect(planCanProvision({ shared_tier_available: 1 as unknown as boolean })).toBe(false);
  });

  it("treats a pooled tenant as the supported shape", () => {
    expect(invokeRequirement({ runpod_mode: "shared" })).toBe("pooled");
  });

  it("treats a legacy dedicated row as UNSUPPORTED, not as a BYO path to walk", () => {
    // The invoke-key route refuses a non-shared row by name after the purge. Offering key
    // instructions would send somebody to make a credential nothing will accept, which is the
    // same confidently-wrong screen this whole line of work has been removing.
    expect(invokeRequirement({ runpod_mode: "dedicated" })).toBe("unsupported");
  });

  it("NEVER reads an absent mode as a tier", () => {
    // runpod_mode is withheld until the endpoints exist, so absent means NOT DECIDED YET.
    expect(invokeRequirement({ runpod_mode: null })).toBe("undecided");
    expect(invokeRequirement({})).toBe("undecided");
    expect(invokeRequirement(null)).toBe("undecided");
    expect(invokeRequirement({ runpod_mode: "pooled" })).toBe("undecided");
  });

  it("has no key gate left to open or close", () => {
    // canAdvance had a key branch and a capacity branch. Both retired with their steps; the
    // trailing default is what an unknown key now hits, and that is correct because there is no
    // longer any such step to gate.
    expect(STEPS.map((s) => s.key)).not.toContain("key");
    expect(STEPS.map((s) => s.key)).not.toContain("capacity");
  });
});

// cp#448: WHAT ACTUALLY WENT WRONG, from the code rather than the status.
//
// handleProvisionError read err.status === 409 and called every one of them a key problem. The
// provision route serves at least four distinct 409s and only one was ever about a key. Worse, it
// rendered err.message -- which the transport sets to body.error, the CODE -- so the plane's own
// sentence was dropped, and because it believed a key was needed it advised provisioning the same
// name again, which is the cp#435 teardown.
//
// RED ON MAIN: provisionFailureCopy does not exist there.
describe("provisionFailureCopy (cp#448)", () => {
  const withBody = (status: number, error: string, message: string | null) => ({ status, message: error, body: { error, message } });

  it("NEVER calls a name collision a key problem", () => {
    // The exact misclassification: any 409 became "Setup needs your key again".
    const c = provisionFailureCopy(withBody(409, "tenant_exists", "you already have a studio"));
    expect(c.headline).not.toMatch(/key/i);
    expect(c.headline).toBe("You already have a studio");
  });

  it("prefers the plane's own sentence over anything the client could infer", () => {
    const stuck = "some of the old studio pieces could not be removed; contact us";
    const c = provisionFailureCopy(withBody(409, "reclaim_teardown_failed", stuck));
    expect(c.detail).toBe(stuck);
    // And the bare code never reaches the reader when the plane spoke.
    expect(c.detail).not.toBe("reclaim_teardown_failed");
    expect(c.spoken).toBe(true);
  });

  it("falls back to the CODE, and says it is a fallback, when the plane sent no message", () => {
    const c = provisionFailureCopy({ status: 409, message: "slug_taken", body: { error: "slug_taken" } });
    expect(c.detail).toBe("slug_taken");
    expect(c.spoken).toBe(false);
  });

  it("distinguishes every 409 the route actually serves", () => {
    // The whole defect in one assertion: four codes, four different headlines, one status.
    const codes = ["tenant_exists", "slug_taken", "slug_reclaim_in_progress", "reclaim_teardown_failed"];
    const heads = codes.map((c) => provisionFailureCopy(withBody(409, c, null)).headline);
    expect(new Set(heads).size).toBe(4);
  });

  it("reads runpod_key_required with its NARROWED meaning, not as bring a key", () => {
    // cp#427 kept the code and changed what it means: this deploy has no shared render capacity.
    // A client still reading it as "paste a key" would send somebody after a key that no longer
    // exists anywhere in the product.
    const c = provisionFailureCopy(withBody(400, "runpod_key_required", null));
    expect(c.headline).toMatch(/cannot build studios/i);
    expect(c.headline).not.toMatch(/key/i);
  });

  it("says something honest about a code it has never heard of", () => {
    const c = provisionFailureCopy(withBody(409, "reticulating_splines", null));
    expect(c.headline).toBe("Setup could not finish");
    expect(c.detail).toBe("reticulating_splines");
  });

  it("survives an error with no body at all", () => {
    expect(provisionFailureCopy({ message: "boom" }).detail).toBe("boom");
    expect(provisionFailureCopy(null).headline).toBe("Setup could not finish");
  });
});
