// Pure onboarding helpers for the hosted-tier front door (#58).
//
// NO DOM access on purpose: these unit-test under plain Node
// (tests/onboarding-checks.test.ts) and also load as a classic <script> on
// onboarding.html, exposing `window.onboardingChecks`. The UMD-ish wrapper
// picks CommonJS when `module` exists (the test harness) and a global
// otherwise (the browser), so one file serves both with no build step. This
// mirrors public/render-eta.js and public/lora-preflight.js.
//
// PRINCIPLE: none of these functions hardcode the provisioning plan. The plan
// (which endpoints, what max_workers each pins) is DATA supplied by the
// control plane and owned by the provisioner (#54). The UI is a projection of
// that plan, exactly like the planner is a projection of the module registry:
// add an endpoint to the plan and the review screen grows a row on its own.
//
// SECRET HYGIENE: the pasted RunPod key never reaches these helpers except in
// keyShapeHint, which inspects only the PREFIX and length and never returns,
// stores, or logs the value.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.onboardingChecks = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // The onboarding steps, in order. The stepper renders from this list.
  // Two-phase key custody (ruled on #52): RunPod keys are console-minted only,
  // and a per-endpoint invoke scope can only name endpoints that ALREADY exist.
  // So the tenant necessarily mints twice: key A (transient, graphql R/W)
  // creates the 4 endpoints, then key B (invoke-only, scoped to exactly those
  // 4) is what we keep. The "invoke" step is that second mint. It cannot be
  // collapsed into one paste, and account-wide invoke as a shortcut was
  // rejected for launch: we hold other people's keys, so minimal stored blast
  // radius beats one screen of friction.
  const STEPS = [
    { key: "what", title: "What you get" },
    { key: "rules", title: "The rules" },
    { key: "name", title: "Name it" },
    { key: "key", title: "Setup key" },
    { key: "capacity", title: "Your capacity" },
    { key: "review", title: "Review" },
    { key: "build", title: "Building" },
    { key: "invoke", title: "Render key" },
    { key: "done", title: "Done" },
  ];

  // RunPod re-issued its API keys in 2024-11 with an `rpa_` prefix; older keys
  // carry different permission semantics and cannot express the Restricted
  // graphql-R/W shape this flow asks for (spike delta 4). This is a courtesy
  // hint at paste time, NOT authorization: only RunPod can say if a key works,
  // and the capacity probe is what actually proves it.
  const KEY_PREFIX = "rpa_";

  // Client-side MIRROR of the control plane's slug rule (#52 contract). The
  // server is the authority and re-validates; this exists so a typo is caught
  // while the tenant is looking at the field, not after a round trip.
  //
  // The slug is BOTH the subdomain and the WfP script name, which is why the
  // rule is this strict: it has to be legal in both alphabets.
  const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
  const SLUG_RESERVED = [
    "www", "api", "admin", "demo", "studio", "mcp", "app", "status", "mail",
  ];

  function slugHint(raw) {
    const slug = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!slug) return { level: "empty", valid: false, message: "" };
    if (slug.length < 3) {
      return { level: "warn", valid: false, message: "A bit longer, please: at least 3 characters." };
    }
    if (slug.length > 32) {
      return { level: "warn", valid: false, message: "That is too long. Keep it to 32 characters or fewer." };
    }
    if (SLUG_RESERVED.indexOf(slug) !== -1) {
      return { level: "warn", valid: false, message: "\"" + slug + "\" is reserved for us. Pick another name." };
    }
    if (!SLUG_RE.test(slug)) {
      return {
        level: "warn",
        valid: false,
        message: "Use lowercase letters, numbers, and dashes; start and end with a letter or number.",
      };
    }
    return { level: "ok", valid: true, message: "" };
  }

  function keyShapeHint(raw) {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key) {
      return { level: "empty", message: "" };
    }
    if (!key.startsWith(KEY_PREFIX)) {
      return {
        level: "warn",
        message:
          "This does not look like a current RunPod key. Newer keys start with " +
          KEY_PREFIX +
          " and are the ones this setup expects. An older key may not have the right permissions. You can try it anyway; we check with RunPod either way.",
      };
    }
    if (key.length < 16) {
      return {
        level: "warn",
        message: "That key looks too short to be complete. Check you copied all of it.",
      };
    }
    return { level: "ok", message: "Key shape looks right. We check it with RunPod next." };
  }

  // Sum the max_workers a provisioning plan asks for. The plan is the control
  // plane's data, not ours.
  function planWorkerTotal(plan) {
    if (!Array.isArray(plan)) return 0;
    return plan.reduce(function (sum, ep) {
      const n = ep && typeof ep.max_workers === "number" ? ep.max_workers : 0;
      return sum + (Number.isFinite(n) && n > 0 ? n : 0);
    }, 0);
  }

  // Does the plan fit the account's REAL worker quota?
  //
  // RunPod enforces the quota account-wide, at config time, against the sum of
  // max_workers across ALL endpoints on the account (#60, proven against the
  // real validation error). So the room we have is quota minus what the
  // account already spends on its existing endpoints.
  //
  // `quota` and `existingWorkerSum` are the REAL numbers the provisioner read
  // back from RunPod. We never derive them from the published balance table:
  // that table is stale (a $50 account was observed with the full quota of 10),
  // and quoting a funding tier at someone whose account disagrees is exactly
  // the sort of confident wrong number this flow exists to avoid.
  function quotaFit(quota, existingWorkerSum, plan) {
    const q = Number(quota);
    const used = Number(existingWorkerSum) || 0;
    const needed = planWorkerTotal(plan);

    if (!Number.isFinite(q) || q <= 0) {
      return {
        fits: false,
        known: false,
        needed: needed,
        available: null,
        quota: null,
        message:
          "We could not read your account's worker quota from RunPod. We will not guess it, so setup stops here rather than half-building your studio.",
      };
    }

    const available = q - used;
    const fits = available >= needed;

    return {
      fits: fits,
      known: true,
      needed: needed,
      available: available,
      quota: q,
      message: fits
        ? "Your account's real worker quota is " +
          q +
          ". Your existing endpoints use " +
          used +
          ", which leaves " +
          available +
          ". This setup needs " +
          needed +
          ", so it fits."
        : "Your account's real worker quota is " +
          q +
          ". Your existing endpoints already use " +
          used +
          ", which leaves only " +
          available +
          ". This setup needs " +
          needed +
          ". Setup stops here so you do not end up with a half-built studio.",
      // Honest, specific guidance instead of a funding-tier sales pitch.
      guidance: fits
        ? []
        : [
            "Lower the max workers on endpoints you already have, to free up " +
              Math.max(0, needed - available) +
              " more.",
            "Delete RunPod endpoints you no longer use.",
            "Ask RunPod support to raise your account's worker quota.",
          ],
    };
  }

  // Cost ceiling for a render, from wall-clock time and an hourly GPU rate.
  //
  // Deliberately a CEILING and labelled as one everywhere it is shown: the
  // wall-clock we have includes queue time and model-load time, while RunPod
  // bills active worker seconds. The real bill is at or under this. Quoting
  // the number we can actually prove beats quoting a prettier one we cannot.
  function costCeilingUsd(wallClockMs, hourlyRateUsd) {
    const ms = Number(wallClockMs);
    const rate = Number(hourlyRateUsd);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return (ms / 3600000) * rate;
  }

  function formatUsd(amount) {
    if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
    if (amount < 0.01) return "under $0.01";
    return "$" + amount.toFixed(2);
  }

  // Turn the control plane's live scope probe of key B into a verdict.
  //
  // The probes are the #60-proven ones: GET /health must succeed on each of the
  // 4 endpoints we created, AND a graphql call must be DENIED. Both halves
  // matter and they catch different mistakes:
  //   - graphql NOT denied  => they pasted a full/graphql key. It would work
  //     fine, which is exactly the danger: we would be storing account-wide
  //     power forever to save one screen of friction.
  //   - a health failure    => the key is scoped to the wrong endpoints (403).
  // Either way we refuse and never store it. "It works" is not the bar; "it can
  // do only what it needs" is.
  function scopeVerdict(probe) {
    const p = probe || {};
    const health = p.health && typeof p.health === "object" ? p.health : null;
    const failures = [];

    if (p.graphql_denied !== true) {
      failures.push(
        "That key can do more than run your renders: it still has account access. " +
          "This is the one thing we will not store, so we have not kept it. Mint a key with " +
          "the invoke surface only, and api.runpod.io/graphql set to None.",
      );
    }

    if (!health) {
      failures.push("We could not check that key against your endpoints, so we have not stored it.");
    } else {
      const unreachable = Object.keys(health).filter(function (id) { return health[id] !== true; });
      if (unreachable.length) {
        failures.push(
          "That key cannot reach " +
            (unreachable.length === 1 ? "this endpoint" : "these endpoints") +
            ": " +
            unreachable.join(", ") +
            ". Check you gave it Read/Write on all four of the endpoints we just created.",
        );
      }
    }

    return {
      ok: failures.length === 0,
      failures: failures,
      message: failures.length === 0
        ? "That key checks out: it can run jobs on your four endpoints, and nothing else."
        : failures[0],
    };
  }

  // Map the control plane's invoke-key rejection REASON codes (#52, as
  // implemented in src/runpod-invoke-key.ts) to copy that tells
  // the tenant which way their key is wrong. "Rejected" alone is not an honest
  // error: too-powerful and scoped-to-the-wrong-endpoints are different fixes.
  //
  // scopeVerdict (above) reads a probe payload; this reads reason codes. The
  // shipped control plane returns reasons today, so this is the live path; the
  // probe path stays for when #53 carries the field.
  const REJECTION_COPY = {
    graphql_capable:
      "That key can do more than run your renders: it still has account access. This is the one " +
      "thing we will not store, so we have not kept it. Mint a key with api.runpod.io/graphql set " +
      "to None, and only the invoke surface enabled.",
    bad_prefix:
      "That does not look like a current RunPod key. Newer keys start with rpa_. Check you copied " +
      "the whole thing.",
    endpoint_out_of_scope:
      "That key cannot reach all four of your endpoints. Check you gave it Read/Write on exactly " +
      "the four listed above.",
    endpoint_unreachable:
      "We could not reach your endpoints with that key. This may be RunPod having a moment rather " +
      "than anything you did; try again in a minute.",
    no_endpoints:
      "Your endpoints are not there yet, so there is nothing to scope a key to. This is our bug, " +
      "not yours; please tell us.",
  };

  function invokeRejectionCopy(reason, detail) {
    const known = REJECTION_COPY[reason];
    if (known) return known;
    // Never swallow an unknown reason: show whatever the server actually said
    // rather than inventing a friendly lie about a key we refused.
    return detail || "That key was not accepted, and we have not stored it.";
  }

  // Copy for a REFUSED acceptance. The stale case is not an error the tenant
  // caused: the policy changed between the page loading and them ticking the
  // box, and the honest move is to show the new words and ask again.
  function aupAcceptFailureCopy(res) {
    const r = res || {};
    if (r.stale) {
      return "The policy changed while this page was open" +
        (r.current ? " (it is now version " + r.current + ")" : "") +
        ". We have loaded the new text; please read it and accept again. We will not record you as " +
        "agreeing to wording you were never shown.";
    }
    if (r.error) return "We could not record your acceptance: " + r.error + ". Nothing has been saved; please try again.";
    return "We could not record your acceptance. Nothing has been saved; please try again.";
  }

  // Is AUP_URL pinned to an IMMUTABLE ref?
  //
  // Ernst's rule (docs/legal/README.md, recommendation 2): if AUP_URL
  // resolves to a moving branch, the text a tenant reads changes whenever the
  // branch does while the recorded version label stays 1.0.0, "and nothing
  // detects the drift." An acceptance record pointing at text that can change
  // is not evidence of anything. So: something detects the drift now.
  //
  // DELIBERATELY CONSERVATIVE. A client cannot prove a URL is immutable (an
  // opaque https://vivijure.com/aup/1.0.0 may be perfectly pinned, or served
  // from a mutable file). It CAN recognise the known-moving forge refs, which
  // is the mistake that actually gets made. So this reports "moving" only on a
  // ref it can positively identify as moving, and "unverifiable" otherwise --
  // never a false positive that would wrongly close the gate on a good URL.
  // The real guarantee is operator-side and at first serve; this is the cheap
  // tripwire under it.
  const MOVING_NAMES = ["main", "master", "head", "develop", "trunk"];
  const SHA_RE = /^[0-9a-f]{7,64}$/i;
  const TAG_RE = /^v?\d+\.\d+\.\d+[A-Za-z0-9.-]*$/;

  // Pull the ref out of a forge URL. Two shapes matter, and the second one is
  // the one that nearly slipped through: raw.githubusercontent.com has NO
  // /blob/ segment, so a pattern written around /blob/<ref>/ misses
  // raw.githubusercontent.com/<owner>/<repo>/main/... entirely -- which is
  // probably the single most likely way this mistake gets made. Caught by the
  // test, not by reading the regex.
  function refOf(url) {
    let m = /\/(?:blob|raw|tree|blame)\/([^/]+)\//.exec(url);
    if (m) return { ref: m[1], alwaysMoving: false };

    m = /^https?:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\//i.exec(url);
    if (m) return { ref: m[1], alwaysMoving: false };

    // An explicit refs/heads/<branch> is a branch by construction, whatever it
    // is called.
    m = /refs\/heads\/([^/]+)/i.exec(url);
    if (m) return { ref: m[1], alwaysMoving: true };

    return null;
  }

  function aupUrlPinning(url) {
    const u = typeof url === "string" ? url.trim() : "";
    if (!u) return { state: "missing", movingRef: null };

    const found = refOf(u);
    if (!found) return { state: "unverifiable", movingRef: null };

    if (found.alwaysMoving) return { state: "moving", movingRef: found.ref };
    if (MOVING_NAMES.indexOf(found.ref.toLowerCase()) !== -1) {
      return { state: "moving", movingRef: found.ref };
    }
    if (SHA_RE.test(found.ref) || TAG_RE.test(found.ref)) {
      return { state: "pinned", movingRef: null };
    }
    // A ref slot holding something that is neither a known-moving name nor a
    // SHA/semver tag: could be a tag we do not recognise, could be a branch.
    // Not provable either way from here, and a false positive would wrongly
    // close the gate on a good URL, so it stays unverifiable.
    return { state: "unverifiable", movingRef: null };
  }

  // Why we refuse to take an acceptance against a moving policy URL.
  function aupPinningRefusalCopy(pinning) {
    const p = pinning || {};
    if (p.state === "moving") {
      return "We are not going to ask you to accept this policy, because the link we have for it " +
        "points at a moving target (" + p.movingRef + "), which means the wording could change " +
        "after you agreed to it. That is our configuration mistake, not yours. It is being fixed; " +
        "nothing you do here would be recorded properly until it is.";
    }
    if (p.state === "missing") {
      return "We cannot show you the policy right now, so we are not going to ask you to accept " +
        "it. You should never have to agree to something you cannot read.";
    }
    return "";
  }

  function stepIndex(key) {
    for (let i = 0; i < STEPS.length; i++) {
      if (STEPS[i].key === key) return i;
    }
    return -1;
  }

  // Can the flow advance past `key` given what the user has done so far?
  // Gates are honest: the rules gate is blocking (#57), and the review gate
  // will not open on a capacity check that failed or never ran.
  function canAdvance(key, state) {
    const s = state || {};
    if (key === "rules") return s.rulesAccepted === true;
    // The server owns slug availability; the UI will not advance on a local
    // regex pass alone.
    if (key === "name") return !!(s.slugValid === true && s.slugAvailable === true);
    if (key === "key") return typeof s.keyPresent === "boolean" ? s.keyPresent : false;
    if (key === "capacity") return !!(s.capacity && s.capacity.fits === true);
    if (key === "review") return s.confirmed === true;
    // Nothing goes live on a key whose scope we did not verify.
    if (key === "invoke") return !!(s.invokeVerified === true);
    return true;
  }

  return {
    STEPS: STEPS,
    KEY_PREFIX: KEY_PREFIX,
    keyShapeHint: keyShapeHint,
    slugHint: slugHint,
    SLUG_RESERVED: SLUG_RESERVED,
    scopeVerdict: scopeVerdict,
    invokeRejectionCopy: invokeRejectionCopy,
    aupAcceptFailureCopy: aupAcceptFailureCopy,
    aupUrlPinning: aupUrlPinning,
    aupPinningRefusalCopy: aupPinningRefusalCopy,
    REJECTION_COPY: REJECTION_COPY,
    planWorkerTotal: planWorkerTotal,
    quotaFit: quotaFit,
    costCeilingUsd: costCeilingUsd,
    formatUsd: formatUsd,
    stepIndex: stepIndex,
    canAdvance: canAdvance,
  };
});
