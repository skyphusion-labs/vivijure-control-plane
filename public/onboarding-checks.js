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
  // SEVEN STEPS, not nine (cp#427 purge). Setup key and Your capacity were both BYOK-only:
  // the first asked for a RunPod key the plane no longer accepts, and the second probed the
  // CUSTOMER own RunPod quota, which is meaningless when the capacity is ours.
  //
  // Capacity had to go WITH the key step rather than after it. It POSTed to /api/tenant/capacity,
  // a route the plane has never served (cp#467), so it 404d and its gate demanded fits === true,
  // which the error path never sets. Removing the key gate alone would have moved everybody from
  // the first wall onto the second and read as a regression introduced by the fix.
  const STEPS = [
    { key: "what", title: "What you get" },
    { key: "rules", title: "The rules" },
    { key: "name", title: "Name it" },
    { key: "review", title: "Review" },
    { key: "build", title: "Building" },
    { key: "go-live", title: "Go live" },
    { key: "done", title: "Done" },
  ];

  // A REPRESENTATIVE example for the INTRO, shown before anyone signs in.
  //
  // The intro must render with ZERO network calls. The real provisioning plan
  // lives behind a session (GET /api/tenant/provision-plan requires auth), so a
  // signed-out visitor whose intro fetched it got a 401 painted red into the
  // plan box and a cost line stuck forever on "loading a real example". This is
  // the fix: the intro renders THIS instead, clearly labelled representative,
  // and the REAL numbers for the account appear at the Review step, which is
  // past the sign-in and where the live plan is fetched.
  //
  // "Representative" is honest, not invented: the endpoints are the actual
  // product composition (the same four every tenant gets, not per-account or
  // secret), and the cost figure is a real, dated render from our own history.
  // The intro is a projection of THIS constant the same way the review screen
  // is a projection of the fetched plan; neither hardcodes a per-feature
  // section. Keep the fields in step with the PlannedEndpoint shape the review
  // rows read, so the two render identically.
  const REPRESENTATIVE_PLAN = {
    endpoints: [
      // Labels match PROVISION_PLAN. backing is what lets the intro tell own-iron
      // from the shared pool without inventing four RunPod endpoints (cp#474).
      // cp#303: purpose matches the plan -- training is not on this endpoint.
      { key: "backend", label: "Render (keyframes, video)", purpose: "The main render: keyframes and video", image: "ghcr.io/skyphusion-labs/vivijure-backend", max_workers: 2, gpu: "H200 / B200", backing: "runpod" },
      { key: "upscale", label: "Video upscale", purpose: "Makes finished video sharper", image: "ghcr.io/skyphusion-labs/vivijure-upscale", gpu: "our hardware", backing: "vpc" },
      { key: "lipsync", label: "Lip sync", purpose: "Matches mouth movement to dialogue", image: "ghcr.io/skyphusion-labs/vivijure-musetalk", max_workers: 1, gpu: "RTX 6000 Pro", backing: "runpod" },
      { key: "audio-upscale", label: "Audio upscale", purpose: "Cleans up and sharpens audio", image: "ghcr.io/skyphusion-labs/vivijure-audio-upscale", gpu: "our hardware", backing: "vpc" },
    ],
    // A real, named render from our own history (film-2294a9d7, 2026-07-14: 2
    // shots, 10s of finished video, final quality). wall_clock_ms is wall-clock
    // since submit, so the derived cost is a CEILING and is labelled as one
    // wherever it is shown. Provenance travels WITH the number so a reader can
    // audit it.
    cost_example: {
      job_id: "film-2294a9d7-d994-4807-8ed8-301a8e2fd796",
      rendered_on: "2026-07-14",
      description: "a 2-shot film, 10 seconds of finished video, final quality",
      wall_clock_ms: 362857,
      gpu_hourly_usd: 4.39,
      gpu_label: "H200 secure",
      rate_checked_on: "2026-07-17",
    },
  };

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

  // The meta line under a review row. Own-iron is not scale-to-zero and has no
  // worker pin, so a single "max N -- scale-to-zero" sentence on every row
  // would lie about half the plan the moment cp#474 served the real one.
  function planRowMeta(ep) {
    const row = ep || {};
    if (row.backing === "vpc") {
      return row.gpu || "our hardware";
    }
    const bits = [];
    if (row.gpu) bits.push(row.gpu);
    if (typeof row.max_workers === "number" && Number.isFinite(row.max_workers) && row.max_workers > 0) {
      bits.push("max " + row.max_workers + (row.max_workers === 1 ? " worker" : " workers"));
    }
    bits.push("scale-to-zero");
    return bits.join(" -- ");
  }

  function planSummaryCopy(plan) {
    const rows = Array.isArray(plan) ? plan : [];
    if (!rows.length) return "";
    const workers = planWorkerTotal(rows);
    const ours = rows.filter(function (ep) { return ep && ep.backing === "vpc"; }).length;
    const bits = [];
    if (workers > 0) {
      bits.push(
        workers + (workers === 1 ? " worker" : " workers") +
          " at most on the shared GPU pool, all scale-to-zero",
      );
    }
    if (ours > 0) {
      bits.push(ours + (ours === 1 ? " capability" : " capabilities") + " on our own hardware");
    }
    if (!bits.length) return "Total: " + rows.length + (rows.length === 1 ? " item" : " items") + ".";
    return "Total: " + bits.join(", plus ") + ".";
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

  // Map the control plane's invoke-key rejection REASON codes (#52, as
  // implemented in src/runpod-invoke-key.ts) to copy that tells
  // the tenant which way their key is wrong. "Rejected" alone is not an honest
  // error: too-powerful and scoped-to-the-wrong-endpoints are different fixes.
  // This is the live path: the plane returns reason codes, not a probe body.
  // A client-side probe verdict was removed in cp#30 (no production caller after
  // the cp#20 client fix, and no route emits the probe shape it read).
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
  // Ernst's rule (docs/legal/hosted/README.md, recommendation 2): if AUP_URL
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
  // POLYNOMIAL ReDoS, fixed: the old form was
  //   /^v?\d+\.\d+\.\d+[A-Za-z0-9.-]*$/
  // where the third \d+ is followed by a class that ALSO matches digits, so a
  // long digit run can be split n ways and a failing match costs O(n^2)
  // (measured: doubling the input quadrupled the time). Forbidding the tail to
  // START with a digit makes the digit run maximal, which removes the
  // ambiguity while accepting exactly the same language -- "digits then
  // anything over T" is the same set as "maximal digits, then optionally a
  // non-digit-led T*". Verified by differential test, not by reading it.
  const TAG_RE = /^v?\d+\.\d+\.\d+(?:[A-Za-z.-][A-Za-z0-9.-]*)?$/;

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
  // THE SLUG PREVIEW ANSWERS TWO QUESTIONS, AND THE SECOND ONE IS DESTRUCTIVE (cp#435).
  //
  // GET /api/tenant/slug-available returns available AND reclaimable, and the second is not
  // decoration: it means the name is free TO YOU because the row behind it is YOUR OWN unfinished
  // studio. Provisioning over it does not resume that studio. It runs a full teardown with
  // deleteData true and rebuilds from scratch.
  //
  // This UI read only availability and printed is free, which is how an operator-provisioned owner
  // could be told his own studio name was available and then destroy it by clicking Continue. The
  // plane computes the distinction and projects it on purpose; the client dropped it on the floor.
  // THREE outcomes now, never two.
  function slugVerdict(res, slug) {
    const r = res || {};
    const name = JSON.stringify(String(slug || ""));
    if (r.available !== true) {
      return {
        state: "taken",
        level: "warn",
        text: name + " is taken" + (r.reason ? " (" + r.reason + ")" : "") + ". Try another.",
      };
    }
    if (r.reclaimable === true) {
      return {
        state: "reclaim",
        level: "bad",
        text: name + " is a studio you already have. Continuing DELETES it and builds a new one.",
      };
    }
    return { state: "free", level: "ok", text: name + " is free." };
  }

  // WHERE A FRESH ARRIVAL BELONGS (cp#455).
  //
  // init() called show("what") unconditionally and never read /api/me, so every step after the
  // first assumed you had walked the previous one and kept what it needed in page memory a fresh
  // arrival does not have. That single fact produced five separate defects, because a self-served
  // tenant PASSES THROUGH these screens while an operator-provisioned one ARRIVES at them.
  //
  // The front door already computes this correctly from the same payload and then hands off to a
  // page that throws it away. This is that decision, kept pure so it can be tested without a DOM,
  // and deliberately shaped the same way: total, no cheerful default, and an unrecognised state
  // returns null rather than a guess.
  //
  // step null means THE WIZARD IS NOT THE RIGHT PLACE. Suspended, deleting, deleted and anything
  // unmodelled are real states the front door has screens for and this page does not; starting a
  // setup wizard for a deleted studio would be the same species of confidently-wrong screen the
  // rest of this issue is about.
  function resumeStep(me) {
    if (!me || !me.account) return { step: "what", reason: "signed_out" };
    if (!me.aup || me.aup.accepted !== true) return { step: "what", reason: "aup_required" };

    const tenant = me.tenant;
    if (!tenant) return { step: "what", reason: "no_tenant" };

    switch (tenant.status) {
      case "pending":
      case "provisioning":
        return { step: "build", reason: "provisioning" };
      case "awaiting_go_live":
      case "awaiting_invoke_key":
        return { step: "go-live", reason: "awaiting_go_live" };
      case "failed":
        // The build screen is where progress and errors render, and error_step and error_message
        // are on the job row. This is what makes See what happened able to show what happened.
        return { step: "build", reason: "failed" };
      case "live":
        return { step: "done", reason: "live" };
      default:
        return { step: null, reason: "not_in_setup" };
    }
  }

  // CAN THIS PLANE PROVISION AT ALL (cp#427 purge widened this question).
  //
  // shared_tier_available was introduced to answer a narrower one -- is a setup key optional --
  // back when a pasted key still selected a dedicated tier. With BYOK removed there is no other
  // tier, so the pool IS the product: a plane without one cannot provision anybody. The field is
  // the same, the question it answers is bigger, and the name still fits.
  //
  // Said UP FRONT rather than discovered at the end. The provision route refuses a poolless plane,
  // so without this the wizard would walk somebody through naming a studio it could never build.
  function planCanProvision(config) {
    return (config || {}).shared_tier_available === true;
  }

  // THREE ANSWERS, because NULL IS NOT A TIER (cp#439, and the contract tenants.ts states in as
  // many words: a consumer that treats null as dedicated re-introduces this very issue).
  //
  // tenants.runpod_mode is NOT NULL DEFAULT dedicated and is written INSIDE the runpod_endpoints
  // step, so before that step every row READS dedicated whether or not it is one. The projection
  // therefore withholds the value until endpoints exist, and null means NOT DECIDED YET, never
  // BYO. Collapsing it into byok here would hand a pooled tenant the key-paste screen again, which
  // is the wall this whole issue is about.
  // WHAT THIS TENANT NEEDS TO GO LIVE (cp#427 purge).
  //
  // pooled is now the ONLY supported shape: the plane installs its own key on an empty-bodied
  // POST. A row still recording dedicated is a LEGACY tenant from before the purge, and the
  // invoke-key route refuses it by name (tenant_not_on_shared_tier), so the honest UI answer is
  // not BYO instructions -- those would send somebody to make a key nothing will accept -- it is
  // to say this studio is on a path we no longer run.
  //
  // NULL IS STILL NOT A TIER. runpod_mode is withheld until the endpoints exist, so absent means
  // NOT DECIDED YET and must not be read as either answer.
  function invokeRequirement(tenant) {
    const mode = (tenant || {}).runpod_mode;
    if (mode === "shared") return "pooled";
    if (mode === "dedicated") return "unsupported";
    return "undecided";
  }

  // WHAT ACTUALLY WENT WRONG, from the CODE rather than the status (cp#448).
  //
  // This read err.status === 409 and called every one of them a key problem. The provision route
  // serves at least four distinct 409s and only one was ever about a key, so tenant_exists,
  // slug_taken, slug_reclaim_in_progress and reclaim_teardown_failed all rendered as
  // "Setup needs your key again".
  //
  // Two things made that worse than a wrong headline. The client rendered err.message, which the
  // transport sets to body.error -- the CODE -- so the plane's own carefully written sentence was
  // dropped; the owner of a genuinely stuck teardown saw the bare string reclaim_teardown_failed
  // and never the words telling them to stop retrying and get in touch. And because it believed a
  // key was needed, it advised provisioning the same name again, which is the cp#435 teardown. The
  // one paragraph in the product that describes the destruction appeared as INSTRUCTIONS in cases
  // where destruction is not the answer.
  //
  // THE PLANE'S MESSAGE WINS whenever it sent one. It is written for the owner, it knows which
  // refusal this is, and nothing the client can infer beats it. The code is a last resort, and a
  // headline is chosen only where we can say something true without one.
  const PROVISION_FAILURE_HEADLINE = {
    tenant_exists: "You already have a studio",
    slug_taken: "That name is taken",
    slug_reclaim_in_progress: "That name is being reset",
    reclaim_teardown_failed: "We could not free that name",
    runpod_key_required: "This deploy cannot build studios right now",
    invalid_slug: "That name will not work",
    provisioner_unconfigured: "We cannot build studios right now",
  };

  function provisionFailureCopy(err) {
    const e = err || {};
    const code = (e.body && e.body.error) || e.message || "";
    const message = e.body && typeof e.body.message === "string" ? e.body.message : null;
    return {
      code: code,
      headline: PROVISION_FAILURE_HEADLINE[code] || "Setup could not finish",
      // The plane's sentence, or the code as the honest last resort. Never a guess dressed as an
      // explanation: if we do not have words for it, we show what we were told.
      detail: message || code || "Something went wrong and we were not told what.",
      // NO CASE ADVISES RE-PROVISIONING. Under cp#427 there is no key to re-paste, and the destroy
      // path belongs behind the cp#435 acknowledgement rather than in a failure hint.
      spoken: Boolean(message),
    };
  }
  function canAdvance(key, state) {
    const s = state || {};
    if (key === "rules") return s.rulesAccepted === true;
    // The server owns slug availability; the UI will not advance on a local
    // regex pass alone.
    // cp#435: availability alone is NOT consent. A reclaimable slug is the owner OWN studio, and
    // advancing over it destroys that studio, so the gate additionally demands an explicit
    // acknowledgement. Unchanged for the ordinary free-name case, which is what most people hit.
    if (key === "name") {
      if (!(s.slugValid === true && s.slugAvailable === true)) return false;
      if (s.slugReclaimable !== true) return true;
      // CONSENT NAMES THE STUDIO IT DESTROYS (cp#446 review).
      //
      // A boolean would be consent to whatever the box happened to be next to. Recording WHICH
      // name was acknowledged makes the revocation a property of this function rather than of a
      // reset running somewhere else: consent for one name cannot open the gate for another, and
      // deleting the DOM reset cannot silently re-enable a destruction, because the recorded name
      // still has to equal the one about to be torn down.
      return typeof s.slug === "string" && s.slug.length > 0 && s.slugReclaimConfirmedFor === s.slug;
    }
    if (key === "review") return s.confirmed === true;
    // Nothing goes live on a key whose scope we did not verify.
    if (key === "go-live") return !!(s.invokeVerified === true);
    return true;
  }

  // ---- invoke-key: the RESPONSE the control plane actually serves -------
  //
  // control-plane#20 / this fix. The previous client was written against a
  // contract that never shipped ("204 -> verified AND installed, 501 ->
  // not_implemented", citing #52). The route serves neither. It serves 200 on
  // go-live and 202 when the key is stored but module propagation has not been
  // observed yet, so EVERY successful go-live fell through to the failure
  // branch and told a live customer "That key was not accepted, and we have
  // not stored it." That is the exact inverse of the truth, and the field was
  // cleared underneath it, inviting the re-paste the 202 copy exists to stop.
  //
  // This function is PURE and takes (httpStatus, parsedBody) so a test can
  // drive the real response shapes and assert what the customer is TOLD.
  // Branch on the HTTP status plus `status` and `modules_ready` -- never on a
  // summary field. There is no summary field: cp#20 removed `ok` from both
  // success bodies precisely because it flattened the distinction below.
  //
  // THE SUBTLE CASE: 200 does NOT mean "all good". 200 means LIVE.
  // modules_ready means PROVEN. A tenant goes live with modules_ready:false
  // when a module image predates GET /ready and its readiness could not be
  // observed. That is a real, non-failing state and it must not read to the
  // customer as an unqualified success -- swallowing it is what cf#114 closed.
  /**
   * The NAMES out of modules_unverified, which is an array of OBJECTS.
   *
   * The route spreads `readiness.unverified` straight into the body, and that is
   * UnverifiedModule[] -- {module, reason, detail, script} -- never a string[].
   * Joining the raw array rendered "([object Object], [object Object])" to the
   * customer, in the ONE state the cp#20 work existed to make legible.
   *
   * It survived a green suite because the route test mocked installInvokeKey
   * returning strings: the mock encoded our assumption instead of the function's
   * real contract, so nothing on either side ever saw the shipped shape. Same
   * defect as the MemoryStore UNIQUE(slug) stub, one file over.
   *
   * Strings are still tolerated because a projection that throws on the wrong
   * shape would trade a cosmetic bug for a broken page, and this runs at the
   * moment a customer is handing us a credential.
   */
  function unverifiedNames(list) {
    return list
      .map(function (u) {
        return u && typeof u === "object" ? u.module : u;
      })
      .filter(Boolean);
  }

  function invokeKeyVerdict(httpStatus, body) {
    const b = body || {};
    const unverified = Array.isArray(b.modules_unverified) ? b.modules_unverified : [];

    if (httpStatus === 200) {
      // Live. The only question left is whether every module PROVED ready.
      if (b.modules_ready === false || unverified.length) {
        return {
          ok: true,
          tone: "warn",
          live: true,
          pending: false,
          keyStored: true,
          clearKey: false,
          message: "Your studio is live.",
          notes: [
            "We could not confirm every render module is ready" +
              (unverified.length ? " (" + unverifiedNames(unverified).join(", ") + ")" : "") +
              ". That usually means those modules run an older image that cannot report " +
              "readiness, not that anything is broken. If a render fails on one of them, tell us.",
          ],
          failures: [],
        };
      }
      return {
        ok: true,
        tone: "good",
        live: true,
        pending: false,
        keyStored: true,
        clearKey: false,
        message: "Your studio is live: your key checks out and every render module is ready.",
        notes: [],
        failures: [],
      };
    }

    if (httpStatus === 202) {
      // Installed, NOT live. The server already wrote the right words for this
      // (it knows how many times it checked and for how long); show them
      // VERBATIM rather than inventing a second, drifting copy of them. The
      // key stays in the field: this is the one state where blanking it would
      // actively cause the re-paste the message is telling them not to do.
      return {
        ok: false,
        tone: "pending",
        live: false,
        pending: true,
        keyStored: true,
        clearKey: false,
        message: b.message || "Your key is installed and stored, but your studio is not live yet.",
        notes: [],
        failures: [],
      };
    }

    // Everything below is a real failure, and every one of these responses
    // carries a diagnostic -- unlike the success bodies, which is why the old
    // client produced a blank refusal.
    const reason = b.error || b.reason || null;
    const copy = invokeRejectionCopy(reason, b.message || null);

    // Clear the field ONLY when the KEY is what was refused. On 409, 503 and
    // 500 the key is not at fault (and on modules_not_ready it is already
    // stored), so blanking it just forces a needless re-paste of a credential.
    // DELIBERATE: this branch is not a fallthrough. 503 modules_not_ready
    // carries {step, message} and 400 invoke_key_rejected carries
    // {reason, message}; both surface a REAL diagnostic here on purpose. Do
    // not "simplify" this into a generic error path -- an opaque failure at
    // this exact moment is the defect cf#114 and control-plane#17 closed.
    const keyWasRefused = reason === "invoke_key_rejected" || reason === "invoke_key_required";

    return {
      ok: false,
      tone: "bad",
      live: false,
      pending: false,
      keyStored: false,
      clearKey: keyWasRefused,
      message: copy,
      notes: [],
      failures: [copy],
    };
  }

  // ---- provisioning: the poll boundary and the build screen (cp#124) ------
  //
  // WHY THE UI KNOWS ABOUT A BACKEND BOUNDARY AT ALL
  // ------------------------------------------------
  // A provision does not fit in one invocation, so the control plane persists
  // progress and lets the next POLL drive the rest (cp#112). That makes the
  // poll the engine, with ONE exception that is custody rather than a bug: the
  // RunPod setup key is never stored, so a poll-driven continuation can only
  // carry a job forward from `wfp_upload` onward (cp#18). A poll that lands
  // BEFORE that step cannot help the job along at all. The only thing it can
  // do is win the job lease and write the honest refusal, which marks the job
  // failed and rolls the half-built tenant back.
  //
  // So an early poll is not a wasted request, it is the thing that ends a
  // healthy provision. Live on 2026-07-25 (vivijure-cf#240): attempt 1 polled
  // immediately and declared the failure; attempt 2 waited about 90 seconds
  // past the boundary, then polled, and completed 9/9. Waiting is not hope:
  // the first invocation is built to cross the boundary on its own (the yield
  // at `runpod_endpoints` is suppressed exactly so it carries through to
  // `wfp_upload`), so the step we wait for is one the runner always takes.
  //
  // Hence two rules, and the second is why this is more than a sleep:
  //   1. the first poll waits out PROVISION_FIRST_POLL_MS;
  //   2. the cadence after that is decided by the JOB, not by the clock: fast
  //      only once steps_done actually reports the boundary step. A clock says
  //      what we hoped happened, steps_done says what did.

  /** The step after which a keyless poll can drive a provision (cp#18). */
  const PROVISION_RESUME_BOUNDARY = "wfp_upload";

  /**
   * How long the page waits before its FIRST poll.
   *
   * PROVENANCE, so nobody trims it as a magic number: the whole pre-install
   * prefix measured about 22 seconds on the finale run, and 90 seconds is the
   * operator cadence proven live on cf#240 (attempt 2, 9/9 green). It also
   * clears the runtime window the first invocation runs in, so a job that has
   * NOT crossed the boundary by then is one no poll could have saved anyway.
   * Well under the plane own 10-minute lost-driver rule, so nothing here can
   * outlive the server patience and hide a dead job.
   */
  const PROVISION_FIRST_POLL_MS = 90000;

  /** Cadence while the job is still short of the boundary: slow, because every
   *  such poll is another chance to take the lease from a live driver. */
  const PROVISION_PRE_BOUNDARY_POLL_MS = 15000;

  /** Cadence past the boundary, where the poll IS the engine and speed helps. */
  const PROVISION_POLL_MS = 2500;

  /** How long we keep watching after the first poll before saying we stopped. */
  const PROVISION_WATCH_MS = 600000;

  /**
   * The build screen, as rows over the control plane REAL step names.
   *
   * The `steps` strings are the provisioner PROVISION_STEPS values verbatim,
   * not a friendly parallel vocabulary: the job payload reports `step`,
   * `steps_done` and `error_step` in those exact words, so anything else here
   * silently matches nothing. That is not hypothetical -- this list used to
   * read d1/r2/runpod/studio/verify, none of which a real job ever reports, so
   * a live provision rendered as five untouched rows until the last one.
   * tests/onboarding-checks.test.ts pins these against the server list.
   */
  const PROVISION_ROWS = [
    { key: "database", label: "Creating your database", steps: ["d1_create", "d1_migrate"] },
    { key: "storage", label: "Creating your storage bucket", steps: ["r2_bucket", "r2_token"] },
    { key: "endpoints", label: "Creating your 4 RunPod endpoints", steps: ["runpod_endpoints"] },
    { key: "studio", label: "Deploying your studio", steps: ["wfp_upload"] },
    { key: "modules", label: "Installing your render modules", steps: ["modules_upload", "modules_install"] },
    { key: "verify", label: "Checking it all works", steps: ["verify"] },
  ];

  function provisionStepsDone(job) {
    return job && Array.isArray(job.steps_done) ? job.steps_done : [];
  }

  /** True once the job has recorded the step a keyless poll can resume from. */
  function pastResumeBoundary(job) {
    return provisionStepsDone(job).indexOf(PROVISION_RESUME_BOUNDARY) !== -1;
  }

  function provisionTerminal(job) {
    return !!job && (job.status === "succeeded" || job.status === "failed");
  }

  /** How long to wait before the NEXT poll of this job. */
  function provisionPollDelayMs(job) {
    if (provisionTerminal(job)) return 0;
    return pastResumeBoundary(job) ? PROVISION_POLL_MS : PROVISION_PRE_BOUNDARY_POLL_MS;
  }

  /**
   * Project a job payload onto the build rows. Pure, so the screen is testable.
   *
   * An error on a step no row covers (a PRECONDITION such as `bundle_fetch`,
   * which is named precisely so a bad release pin is attributable) is appended
   * as its own row rather than dropped. A failure the screen cannot place is
   * still a failure the tenant must see.
   */
  function provisionRows(job) {
    const done = provisionStepsDone(job);
    const step = (job && job.step) || null;
    const errorStep = (job && job.error_step) || null;
    const rows = PROVISION_ROWS.map(function (row) {
      let status = "todo";
      if (errorStep && row.steps.indexOf(errorStep) !== -1) status = "failed";
      else if (row.steps.every(function (s) { return done.indexOf(s) !== -1; })) status = "done";
      else if (step && row.steps.indexOf(step) !== -1) status = job && job.status === "failed" ? "failed" : "running";
      else if (row.steps.some(function (s) { return done.indexOf(s) !== -1; })) status = "running";
      return {
        key: row.key,
        label: row.label,
        status: status,
        error: status === "failed" ? (job && job.error_message) || undefined : undefined,
      };
    });
    const covered = PROVISION_ROWS.some(function (row) { return errorStep && row.steps.indexOf(errorStep) !== -1; });
    if (errorStep && !covered) {
      rows.push({
        key: errorStep,
        label: "Setup stopped at " + errorStep,
        status: "failed",
        error: (job && job.error_message) || undefined,
      });
    }
    return rows;
  }

  /** The waiting row shown before the first poll. Counts OUR clock, and says so. */
  function provisionWaitCopy(remainingMs) {
    const secs = Math.max(0, Math.ceil((remainingMs || 0) / 1000));
    if (secs === 0) return "Checking on your studio now";
    return "Building your studio: first check in " + secs + (secs === 1 ? " second" : " seconds");
  }

  /**
   * Why the screen is quiet. Plain, because the alternative reads as a hang.
   *
   * It takes the wait it is describing rather than reading the constant: the
   * preview compresses the wait, and a note that said 90 while the screen
   * counted 3 would be a small lie on a screen whose whole job is not telling
   * them any. Caught in a browser, not by a unit test.
   */
  function provisionWaitNote(totalMs) {
    const ms = typeof totalMs === "number" && totalMs > 0 ? totalMs : PROVISION_FIRST_POLL_MS;
    return "The first stage of setup runs on our side and cannot be hurried along. Checking too " +
      "early cannot help it and would cut it short, so we leave it alone for about " +
      Math.round(ms / 1000) + " seconds and then watch it step by step.";
  }

  /** No silent cap: when we stop watching we say so, with the real number. */
  function provisionTimeoutCopy() {
    const minutes = Math.floor((PROVISION_FIRST_POLL_MS + PROVISION_WATCH_MS) / 60000);
    return "We stopped watching after more than " + minutes + " minutes. Setup may still be " +
      "running; reload this page to pick the status back up.";
  }

  return {
    STEPS: STEPS,
    REPRESENTATIVE_PLAN: REPRESENTATIVE_PLAN,
    KEY_PREFIX: KEY_PREFIX,
    keyShapeHint: keyShapeHint,
    slugHint: slugHint,
    SLUG_RESERVED: SLUG_RESERVED,
    invokeRejectionCopy: invokeRejectionCopy,
    invokeKeyVerdict: invokeKeyVerdict,
    aupAcceptFailureCopy: aupAcceptFailureCopy,
    aupUrlPinning: aupUrlPinning,
    aupPinningRefusalCopy: aupPinningRefusalCopy,
    REJECTION_COPY: REJECTION_COPY,
    planWorkerTotal: planWorkerTotal,
    planRowMeta: planRowMeta,
    planSummaryCopy: planSummaryCopy,
    quotaFit: quotaFit,
    costCeilingUsd: costCeilingUsd,
    formatUsd: formatUsd,
    stepIndex: stepIndex,
    canAdvance: canAdvance,
    provisionFailureCopy: provisionFailureCopy,
    PROVISION_FAILURE_HEADLINE: PROVISION_FAILURE_HEADLINE,
    resumeStep: resumeStep,
    slugVerdict: slugVerdict,
    planCanProvision: planCanProvision,
    invokeRequirement: invokeRequirement,
    PROVISION_RESUME_BOUNDARY: PROVISION_RESUME_BOUNDARY,
    PROVISION_FIRST_POLL_MS: PROVISION_FIRST_POLL_MS,
    PROVISION_PRE_BOUNDARY_POLL_MS: PROVISION_PRE_BOUNDARY_POLL_MS,
    PROVISION_POLL_MS: PROVISION_POLL_MS,
    PROVISION_WATCH_MS: PROVISION_WATCH_MS,
    PROVISION_ROWS: PROVISION_ROWS,
    provisionWaitNote: provisionWaitNote,
    pastResumeBoundary: pastResumeBoundary,
    provisionTerminal: provisionTerminal,
    provisionPollDelayMs: provisionPollDelayMs,
    provisionRows: provisionRows,
    provisionWaitCopy: provisionWaitCopy,
    provisionTimeoutCopy: provisionTimeoutCopy,
  };
});
