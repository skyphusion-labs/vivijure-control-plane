// Hosted-tier onboarding flow (#58). Vanilla JS, no framework, no build step.
//
// WHAT IS SETTLED HERE vs WHAT IS NOT
// -----------------------------------
// Settled (this file owns it): the flow, the copy, the gates, and the rule that
// every number shown to the user is one we actually read back from RunPod.
//
// NOT settled (do not treat as contract): the API shapes in PlatformApi below.
// The control plane is Rollins' lane (#52 skeleton, #54 provisioner). These are
// a PROVISIONAL seam so the screens are drivable today; they are mocked until a
// real base is wired. When #52 posts the real contract, this adapter is the only
// place that changes -- the screens read from the returned data, never from
// hardcoded knowledge of what a plan contains.
//
// SECRET HYGIENE (hard rule): the pasted RunPod key lives in ONE closure
// variable. It is never written to localStorage/sessionStorage, never put in a
// URL, never logged, and never sent anywhere but the control plane over POST.
// It is cleared the moment provisioning finishes. The input is type=password and
// the reveal toggle is opt-in.
(function () {
  "use strict";

  const checks = window.onboardingChecks;

  // The control plane's origin. Empty means same-origin, which is the normal
  // case: this page is served BY the control plane.
  const API_BASE = window.HOSTED_API_BASE || "";

  // Mock mode is an EXPLICIT opt-in (?mock=1, or data-mock on <html>), never a
  // fallback.
  //
  // This was the other way round for one commit, and it was a real trap: mock
  // was inferred from "no API base configured," which is exactly what a normal
  // same-origin production deploy looks like. A misconfigured control plane
  // would then have served a real stranger a real-looking signup page full of
  // invented numbers (quota 10, $0.44) and a fake "your studio is live" link.
  // A page that cannot reach its API must look BROKEN, loudly, never
  // fake-working: honest failures apply to the front door too. Now a broken
  // deploy throws a visible fetch error, and fabricated data can only ever
  // appear when someone deliberately asked for the preview.
  const params = new URLSearchParams(window.location.search);
  const USE_MOCK =
    params.get("mock") === "1" || document.documentElement.dataset.mock === "1";

  // ---- the keys, and nowhere else ---------------------------------------
  // Two-phase custody (#52 ruling). Key A is transient and dies at the end of
  // provisioning. Key B is verified before it is kept, and this page never
  // keeps either one: both live in a closure and go nowhere else.
  let runpodKey = "";   // key A: transient, graphql R/W, used once to build
  let invokeKey = "";   // key B: invoke-only on the 4 created endpoints
  function clearKey() { runpodKey = ""; }
  function clearInvokeKey() { invokeKey = ""; }

  const state = {
    rulesAccepted: false,
    keyPresent: false,
    capacity: null,
    confirmed: false,
    invokeVerified: false,
    plan: [],
    costExample: null,
    studioUrl: null,
    createdEndpoints: [],
    tenantId: null,
    slug: "",
    slugValid: false,
    slugAvailable: false,
    tenantDomainSuffix: ".studio.vivijure.com",
  };

  let current = "what";

  // ---- the control-plane API (reconciled against Rollins' #52 contract) --
  //
  // Routes below marked CONTRACT are from the posted #52 contract
  // (issuecomment-4998960324) and are authoritative. Routes marked REQUESTED
  // are ones this flow needs that the contract does not carry yet; they are
  // raised on #52 and are NOT invented facts -- if they land in a different
  // shape, this adapter is the only thing that changes.
  const PlatformApi = {
    async json(path, init) {
      const r = await fetch(API_BASE + path, init);
      const body = await r.json().catch(function () { return {}; });
      if (!r.ok) {
        const err = new Error(body.error || "request failed (" + r.status + ")");
        err.status = r.status;
        err.body = body;
        throw err;
      }
      return body;
    },

    // CONTRACT. Drives the shell: signups switch, AUP version, and the auth
    // methods. auth_methods is projected, never hardcoded -- Apple appears the
    // day Conrad stages the .p8, with no UI change. Same ethos as the planner
    // rendering from the module registry.
    config() {
      if (USE_MOCK) return Promise.resolve(mock.config());
      return this.json("/api/platform/config");
    },

    // CONTRACT. The one call the front door needs on load: account, AUP state,
    // and the tenant (or null). Tenant status is what tells us whether we are
    // awaiting key B or live.
    me() {
      if (USE_MOCK) return Promise.resolve(mock.me());
      return this.json("/api/me");
    },

    // CONTRACT: { version, url, summary }. Ernst owns the words (#57).
    async aup() {
      if (USE_MOCK) return null;
      try { return await this.json("/api/aup/current"); } catch (err) { return null; }
    },

    // 204 = recorded. 409 = the version moved under us (aup_version_stale).
    //
    // This used to `await fetch(...)` and return {ok:true} unconditionally,
    // swallowing the 409. That is the worst bug I have written on this surface:
    // the flow would advance telling someone their consent was recorded when it
    // was not, and they would only find out at provision time via a 403. A
    // consent gate that lies about consent is not a gate. It reports honestly
    // now, and the caller refuses to advance.
    async acceptAup(version) {
      if (USE_MOCK) return { ok: true };
      const r = await fetch(API_BASE + "/api/aup/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: version }),
      });
      if (r.status === 204) return { ok: true };
      const body = await r.json().catch(function () { return {}; });
      if (r.status === 409) {
        return { ok: false, stale: true, current: body.current || null, error: body.error || "aup_version_stale" };
      }
      return { ok: false, stale: false, error: body.error || null, status: r.status };
    },

    // CONTRACT: { available, reason? }
    slugAvailable(slug) {
      if (USE_MOCK) return Promise.resolve(mock.slugAvailable(slug));
      return this.json("/api/tenant/slug-available?slug=" + encodeURIComponent(slug));
    },

    // REQUESTED (raised on #52): what will be created, with the pinned
    // max_workers per endpoint. The review screen cannot honestly say "this is
    // what we will create on your account" without it, and the numbers belong
    // to the provisioner (#54), not to this page.
    plan() {
      if (USE_MOCK) return Promise.resolve(mock.plan());
      return this.json("/api/tenant/provision-plan");
    },

    // REQUESTED (raised on #52): a read-only capacity probe that creates
    // nothing, so we can show the account's REAL quota BEFORE touching it.
    // #58 requires the happy path to surface the number we found; a number
    // that only appears in a failure message does not satisfy that.
    capacity(key) {
      if (USE_MOCK) return Promise.resolve(mock.capacity());
      return this.json("/api/tenant/capacity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runpod_api_key: key }),
      });
    },

    // CONTRACT: 202 { tenant_id, job_id }
    provision(slug, key) {
      if (USE_MOCK) return Promise.resolve(mock.provision());
      return this.json("/api/tenant/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: slug, runpod_api_key: key }),
      });
    },

    // CONTRACT: { status, step, steps_done, error_step, error_message }.
    // error_message is the REAL step error, verbatim, and we show it as such.
    job(tenantId) {
      if (USE_MOCK) return Promise.resolve(mock.job());
      return this.json("/api/tenant/" + encodeURIComponent(tenantId) + "/job");
    },

    // CONTRACT: 202 { job_id }, or 409 runpod_key_required when the failure was
    // in the RunPod steps (we stored no key, so we cannot resume alone).
    retry(tenantId, key) {
      if (USE_MOCK) return Promise.resolve({ job_id: "mock-job" });
      return this.json("/api/tenant/" + encodeURIComponent(tenantId) + "/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(key ? { runpod_api_key: key } : {}),
      });
    },

    // As IMPLEMENTED in src/control-plane/runpod-invoke-key.ts (#52):
    //   204                        -> verified AND installed
    //   400 invoke_key_rejected    -> { reason, message } (the honest refusal)
    //   501 not_implemented        -> verified, but the secret install lands with #53
    // The probe-payload shape stays supported for when #53 carries it.
    async invokeKey(tenantId, key) {
      if (USE_MOCK) return mock.invokeKey();
      const r = await fetch(API_BASE + "/api/tenant/" + encodeURIComponent(tenantId) + "/invoke-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runpod_invoke_key: key }),
      });
      if (r.status === 204) return { ok: true, installed: true };
      const body = await r.json().catch(function () { return {}; });
      return {
        ok: false,
        status: r.status,
        installed: false,
        probe: body.probe || null,
        reason: body.reason || body.error || null,
        detail: body.message || null,
      };
    },
  };

  // ---- mock data (preview only; the banner is loud about it) ------------
  const mock = {
    config() {
      return { signups_enabled: true, aup_version: "mock-v1", auth_methods: ["email", "google", "github"] };
    },
    me() {
      return {
        account: { id: "acct_mock", email: "you@example.com" },
        aup: { required_version: "mock-v1", accepted: true },
        tenant: mockTenant,
      };
    },
    slugAvailable(slug) {
      return { available: slug !== "taken", reason: slug === "taken" ? "already in use" : undefined };
    },
    plan() {
      return {
        endpoints: [
          { key: "backend", label: "backend", purpose: "The main render: keyframes, video, and cast LoRA training", image: "ghcr.io/skyphusion-labs/vivijure-backend", max_workers: 2, gpu: "H200 / B200" },
          { key: "upscale", label: "upscale", purpose: "Makes finished video sharper", image: "ghcr.io/skyphusion-labs/vivijure-upscale", max_workers: 1, gpu: "RTX 6000 Pro" },
          { key: "lipsync", label: "lipsync", purpose: "Matches mouth movement to dialogue", image: "ghcr.io/skyphusion-labs/vivijure-musetalk", max_workers: 1, gpu: "RTX 6000 Pro" },
          { key: "audio-upscale", label: "audio-upscale", purpose: "Cleans up and sharpens audio", image: "ghcr.io/skyphusion-labs/vivijure-audio-upscale", max_workers: 1, gpu: "RTX 6000 Pro" },
        ],
        // A real, named render from our own history (film-2294a9d7, 2026-07-14:
        // 2 shots, 10s of finished video, final quality). wall_clock_ms is
        // wall-clock since submit, so the derived cost is a CEILING and is
        // labelled as one wherever it is shown. Provenance travels WITH the
        // number so a reader can audit it. TODO(#53/#54): the provisioner's
        // end-to-end verify render produces a real BILLED-seconds figure as a
        // side effect; swap this for that number and drop the ceiling framing.
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
    },
    capacity() { return { quota: 10, existing_worker_sum: 0 }; },
    provision() { return { tenant_id: "ten_mock", job_id: "job_mock" }; },
    job() {
      return { status: "succeeded", step: "verify", steps_done: ["d1", "r2", "runpod", "studio", "verify"] };
    },
    invokeKey() {
      return {
        ok: true,
        probe: {
          graphql_denied: true,
          health: { abc123backend: true, abc123upscale: true, abc123lipsync: true, abc123audio: true },
        },
      };
    },
  };

  // The mock tenant walks the real status machine: a provision lands in
  // awaiting_invoke_key, and only key B moves it to live.
  let mockTenant = {
    id: "ten_mock",
    slug: "your-studio",
    status: "awaiting_invoke_key",
    endpoints: [
      { key: "backend", label: "backend", id: "abc123backend", name: "vivijure-backend-your-studio" },
      { key: "upscale", label: "upscale", id: "abc123upscale", name: "vivijure-upscale-your-studio" },
      { key: "lipsync", label: "lipsync", id: "abc123lipsync", name: "vivijure-musetalk-your-studio" },
      { key: "audio-upscale", label: "audio-upscale", id: "abc123audio", name: "vivijure-audio-upscale-your-studio" },
    ],
  };

  // ---- rendering --------------------------------------------------------
  const $ = function (sel) { return document.querySelector(sel); };

  function renderStepper() {
    const ol = $("#stepper");
    if (!ol) return;
    const currentIdx = checks.stepIndex(current);
    ol.innerHTML = "";
    checks.STEPS.forEach(function (step, i) {
      const li = document.createElement("li");
      li.textContent = step.title;
      li.dataset.state = i < currentIdx ? "done" : i === currentIdx ? "current" : "todo";
      if (i === currentIdx) li.setAttribute("aria-current", "step");
      ol.appendChild(li);
    });
  }

  function show(stepKey) {
    current = stepKey;
    document.querySelectorAll("[data-step]").forEach(function (el) {
      el.hidden = el.dataset.step !== stepKey;
    });
    renderStepper();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function refreshGates() {
    document.querySelectorAll("[data-next]").forEach(function (btn) {
      const step = btn.dataset.next;
      if (step === "what" || step === "build") return;
      btn.disabled = !checks.canAdvance(step, state);
    });
  }

  // Renders the plan rows. Reads ONLY from the data: an endpoint added to the
  // plan grows a row here with no change to this function.
  function renderPlan(container, opts) {
    const el = typeof container === "string" ? $(container) : container;
    if (!el) return;
    el.innerHTML = "";
    if (!state.plan.length) {
      el.innerHTML = '<p class="muted small">No plan loaded.</p>';
      return;
    }
    state.plan.forEach(function (ep) {
      const row = document.createElement("div");
      row.className = "row";

      const head = document.createElement("div");
      head.className = "row-head";
      const name = document.createElement("span");
      name.className = "row-name";
      name.textContent = ep.label || ep.key;
      head.appendChild(name);

      const meta = document.createElement("span");
      meta.className = "row-meta";
      const bits = [];
      if (ep.gpu) bits.push(ep.gpu);
      if (typeof ep.max_workers === "number") {
        bits.push("max " + ep.max_workers + (ep.max_workers === 1 ? " worker" : " workers"));
      }
      bits.push("scale-to-zero");
      meta.textContent = bits.join(" -- ");
      head.appendChild(meta);
      row.appendChild(head);

      if (ep.purpose) {
        const why = document.createElement("p");
        why.className = "row-why";
        why.textContent = ep.purpose;
        row.appendChild(why);
      }
      if (ep.image && (!opts || opts.showImage !== false)) {
        const img = document.createElement("p");
        img.className = "row-why row-image";
        img.textContent = ep.image;
        row.appendChild(img);
      }
      el.appendChild(row);
    });
  }

  // The four endpoints we just created, named, so the console step is a
  // copy-match rather than guesswork (#52 ruling).
  function renderCreatedEndpoints() {
    const el = $("#created-endpoints");
    if (!el) return;
    el.innerHTML = "";
    if (!state.createdEndpoints.length) {
      el.innerHTML = '<p class="muted small">No endpoints reported yet.</p>';
      return;
    }
    state.createdEndpoints.forEach(function (ep) {
      const row = document.createElement("div");
      row.className = "row";
      const head = document.createElement("div");
      head.className = "row-head";
      const name = document.createElement("span");
      name.className = "row-name";
      name.textContent = ep.name || ep.label || ep.key;
      head.appendChild(name);
      const meta = document.createElement("span");
      meta.className = "row-meta";
      meta.textContent = "Read/Write";
      head.appendChild(meta);
      row.appendChild(head);
      if (ep.id) {
        const id = document.createElement("p");
        id.className = "row-why row-image";
        id.textContent = "id: " + ep.id;
        row.appendChild(id);
      }
      el.appendChild(row);
    });
  }

  function renderCostExample() {
    const el = $("#cost-example");
    if (!el) return;
    const ex = state.costExample;
    if (!ex) { el.textContent = ""; return; }
    const ceiling = checks.costCeilingUsd(ex.wall_clock_ms, ex.gpu_hourly_usd);
    const money = checks.formatUsd(ceiling);
    if (!money) { el.textContent = ""; return; }
    const minutes = Math.round(ex.wall_clock_ms / 60000);
    // The word "at most" is not hedging, it is the truth: wall-clock includes
    // queue and model-load time, and RunPod bills active worker seconds.
    el.textContent =
      "A real render from our own history (" + ex.description + ", " + ex.rendered_on +
      "): " + minutes + " minutes, start to finish. At the " + ex.gpu_label + " rate of $" +
      ex.gpu_hourly_usd + "/hr, that costs you at most " + money +
      ". Probably less: that clock includes queue and model-load time, and RunPod bills you for " +
      "active GPU seconds. Your studio shows your real spend after the first render.";
  }

  function renderCapacity() {
    const el = $("#capacity-result");
    if (!el) return;
    const fit = state.capacity;
    if (!fit) { el.textContent = "checking with RunPod..."; return; }

    el.innerHTML = "";
    const callout = document.createElement("div");
    callout.className = "callout " + (fit.fits ? "" : "callout-bad");

    const msg = document.createElement("p");
    msg.textContent = fit.message;
    callout.appendChild(msg);

    if (!fit.fits && fit.guidance && fit.guidance.length) {
      const what = document.createElement("p");
      what.className = "small";
      what.innerHTML = "<strong>What you can do:</strong>";
      callout.appendChild(what);
      const ul = document.createElement("ul");
      ul.className = "small muted";
      fit.guidance.forEach(function (g) {
        const li = document.createElement("li");
        li.textContent = g;
        ul.appendChild(li);
      });
      callout.appendChild(ul);
    }
    el.appendChild(callout);

    if (fit.fits) {
      const note = document.createElement("p");
      note.className = "small muted";
      note.textContent =
        "That is the number we read back from RunPod for your account, not a guess from their " +
        "published balance chart. We have seen that chart be wrong.";
      el.appendChild(note);
    }
  }

  function renderProgress(steps) {
    const ol = $("#build-progress");
    if (!ol) return;
    ol.innerHTML = "";
    (steps || []).forEach(function (s) {
      const li = document.createElement("li");
      li.dataset.status = s.status || "todo";
      const dot = document.createElement("span");
      dot.className = "dot";
      li.appendChild(dot);
      const body = document.createElement("span");
      body.textContent = s.label || s.key;
      // Honest failures: show the REAL error, never a shrug.
      if (s.status === "failed" && s.error) {
        const err = document.createElement("span");
        err.className = "step-error";
        err.textContent = s.error;
        body.appendChild(err);
      }
      li.appendChild(body);
      ol.appendChild(li);
    });
  }

  // ---- flow -------------------------------------------------------------
  async function loadPlan() {
    try {
      const data = await PlatformApi.plan();
      state.plan = (data && data.endpoints) || [];
      state.costExample = (data && data.cost_example) || null;
      renderPlan("#plan-preview");
      renderCostExample();
    } catch (err) {
      const el = $("#plan-preview");
      if (el) el.innerHTML = '<p class="hint" data-level="bad"></p>';
      const hint = el && el.querySelector(".hint");
      if (hint) hint.textContent = "Could not load the setup plan: " + err.message;
    }
  }

  // The rules step, wired to Ernst's landed AUP (#57).
  //
  // The control plane serves { version, url } from GET /api/aup/current, pinned
  // by AUP_VERSION. Three things this function will not do, each because the
  // acceptance record has to be worth something:
  //
  //   1. It never writes policy prose. The text is Ernst's, in one place.
  //   2. It fails CLOSED. No policy readable -> the accept box stays disabled.
  //      You should not be able to agree to something you cannot read, and a
  //      gate that shrugs and lets you through is not a gate (the same lesson
  //      as the 409 swallow).
  //   3. It refuses a MOVING policy URL, per Ernst's immutable-ref rule: if the
  //      link points at a branch, the wording can change after someone agreed
  //      while the recorded label stays put, and "nothing detects the drift."
  //      Something detects it now.
  async function loadAup() {
    const el = $("#aup-text");
    if (!el) return;
    let aup = null;
    try {
      aup = await PlatformApi.aup();
    } catch (err) {
      aup = null;
    }

    const pinning = checks.aupUrlPinning(aup && aup.url);
    if (!aup || pinning.state === "missing" || pinning.state === "moving") {
      // Fail closed, loudly, and say whose fault it is.
      const copy = checks.aupPinningRefusalCopy(pinning) ||
        "We cannot show you the policy right now, so we are not going to ask you to accept it.";
      el.classList.add("placeholder-seam");
      el.innerHTML = "";
      el.appendChild(textP(copy));
      lockAupGate(copy);
      return;
    }

    el.classList.remove("placeholder-seam");
    el.innerHTML = "";
    if (aup.summary) el.appendChild(textP(aup.summary));

    const p = document.createElement("p");
    const a = document.createElement("a");
    a.href = aup.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Read the Acceptable Use Policy" + (aup.version ? " (version " + aup.version + ")" : "");
    p.appendChild(a);
    el.appendChild(p);

    // The one line that is never a link and never a summary.
    const csam = document.createElement("p");
    csam.className = "small muted";
    csam.textContent =
      "One line, so you do not have to go looking for it: vivijure has an absolute ban on child " +
      "sexual abuse material, including AI-generated material. It is enforced, it is reported, and " +
      "it is not negotiable.";
    el.appendChild(csam);

    // Record the version the tenant is actually being shown. The acceptance
    // POSTs this exact string, and the control plane 409s if it has moved on.
    el.dataset.version = aup.version || "";
    unlockAupGate();
  }

  function showAupError(res) {
    const el = $("#aup-error");
    if (!el) return;
    el.textContent = checks.aupAcceptFailureCopy(res);
    el.hidden = false;
  }

  function hideAupError() {
    const el = $("#aup-error");
    if (el) el.hidden = true;
  }

  function lockAupGate(copy) {
    const box = $("#accept-aup");
    if (box) { box.checked = false; box.disabled = true; }
    state.rulesAccepted = false;
    const err = $("#aup-error");
    if (err && copy) { err.textContent = copy; err.hidden = false; }
    refreshGates();
  }

  function unlockAupGate() {
    const box = $("#accept-aup");
    if (box) box.disabled = false;
    hideAupError();
  }

  // Slug availability is the SERVER's answer; the local regex only catches
  // typos early. Debounced so a keystroke is not a request.
  let slugTimer = null;
  function onSlugInput(value) {
    const hint = checks.slugHint(value);
    state.slug = (value || "").trim().toLowerCase();
    state.slugValid = hint.valid;
    state.slugAvailable = false;
    const el = $("#slug-hint");
    if (el) {
      el.textContent = hint.message;
      el.dataset.level = hint.level === "empty" ? "" : hint.level;
    }
    const preview = $("#slug-preview");
    if (preview) {
      preview.textContent = state.slug
        ? "https://" + state.slug + state.tenantDomainSuffix
        : "";
    }
    refreshGates();
    if (slugTimer) clearTimeout(slugTimer);
    if (!hint.valid) return;
    slugTimer = setTimeout(checkSlug, 350);
  }

  async function checkSlug() {
    const el = $("#slug-hint");
    try {
      const res = await PlatformApi.slugAvailable(state.slug);
      state.slugAvailable = res.available === true;
      if (el) {
        el.textContent = res.available
          ? "\"" + state.slug + "\" is free."
          : "\"" + state.slug + "\" is taken" + (res.reason ? " (" + res.reason + ")" : "") + ". Try another.";
        el.dataset.level = res.available ? "ok" : "warn";
      }
    } catch (err) {
      state.slugAvailable = false;
      if (el) {
        el.textContent = "We could not check that name: " + err.message;
        el.dataset.level = "bad";
      }
    }
    refreshGates();
  }

  async function runCapacityCheck() {
    state.capacity = null;
    renderCapacity();
    refreshGates();
    try {
      const data = await PlatformApi.capacity(runpodKey);
      state.capacity = checks.quotaFit(data.quota, data.existing_worker_sum, state.plan);
    } catch (err) {
      state.capacity = {
        fits: false, known: false, needed: checks.planWorkerTotal(state.plan),
        available: null, quota: null,
        message: "We could not check your account with RunPod: " + err.message,
        guidance: ["Check the key you pasted is complete, and that its graphql access is Read/Write."],
      };
    }
    renderCapacity();
    refreshGates();
  }

  // Provisioning: start the job, poll it, then read the TENANT status to learn
  // where we landed. Job status (queued/running/succeeded/failed) and tenant
  // status (provisioning/awaiting_invoke_key/live) are different machines in
  // the #52 contract, and conflating them is how a UI ends up lying: a job can
  // succeed and the tenant still not be live, which is exactly the
  // awaiting_invoke_key case.
  const POLL_MS = 2500;
  const POLL_CEILING = 240; // ~10 minutes, then we stop and say so.

  async function runProvision() {
    renderProgress([{ key: "start", label: "Starting setup", status: "running" }]);
    try {
      const job = await PlatformApi.provision(state.slug, runpodKey);
      state.tenantId = job.tenant_id;

      let last = null;
      for (let i = 0; i < POLL_CEILING; i++) {
        last = await PlatformApi.job(state.tenantId);
        renderJobProgress(last);
        if (last.status === "succeeded" || last.status === "failed") break;
        await sleep(POLL_MS);
      }

      if (!last || (last.status !== "succeeded" && last.status !== "failed")) {
        // No silent cap: if we stop watching, say so rather than spin forever.
        renderProgress([{
          key: "timeout", label: "Setup is taking longer than we expected", status: "failed",
          error: "We stopped watching after 10 minutes. Setup may still be running; reload this page to pick the status back up.",
        }]);
        return;
      }

      if (last.status === "failed") {
        renderJobProgress(last);
        offerRetry(last);
        return;
      }

      // The endpoints exist, so key A has done its whole job. It stops existing
      // here, BEFORE the tenant is asked for key B: we never hold both at once.
      clearKey();

      const me = await PlatformApi.me();
      const tenant = (me && me.tenant) || null;
      state.createdEndpoints = (tenant && tenant.endpoints) || [];
      // tenantView only returns a url once the tenant is live ("a link that
      // 5xx's is not honest"). Prefer the server's answer; fall back to the
      // derived address only for the preview.
      if (tenant && tenant.url) state.studioUrl = tenant.url;
      else if (tenant && tenant.slug) state.studioUrl = "https://" + tenant.slug + state.tenantDomainSuffix;

      if (tenant && tenant.status === "awaiting_invoke_key") {
        renderCreatedEndpoints();
        show("invoke");
        return;
      }
      if (tenant && tenant.status === "live") {
        // The contract says a provision lands in awaiting_invoke_key. Going
        // straight to live means the control plane skipped the key-B phase,
        // which is a contract change, not something to shrug past.
        finishAndShowDone();
        return;
      }
      renderProgress([{
        key: "status", label: "Setup finished in an unexpected state", status: "failed",
        error: "Your studio reports status " + (tenant ? tenant.status : "unknown") +
          ". We have not marked it live. Please tell us about this rather than retrying.",
      }]);
    } catch (err) {
      handleProvisionError(err);
    }
  }

  function finishAndShowDone() {
    // Both keys stop existing here. Key A was already dropped when the
    // endpoints appeared; key B lives on the tenant's own studio now, not in
    // this page.
    clearKey();
    clearInvokeKey();
    const link = $("#studio-link");
    if (link && state.studioUrl) {
      link.href = state.studioUrl;
      link.textContent = "Open my studio: " + state.studioUrl;
    }
    show("done");
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Render the contract's job payload. error_message is the REAL step error and
  // is shown verbatim: if RunPod says the worker quota is 10 and we need 12,
  // the tenant reads exactly that, not "provisioning failed".
  function renderJobProgress(job) {
    const done = Array.isArray(job.steps_done) ? job.steps_done : [];
    const known = [
      { key: "d1", label: "Creating your database" },
      { key: "r2", label: "Creating your storage bucket" },
      { key: "runpod", label: "Creating your 4 RunPod endpoints" },
      { key: "studio", label: "Deploying your studio" },
      { key: "verify", label: "Checking it all works" },
    ];
    renderProgress(known.map(function (st) {
      let status = "todo";
      if (done.indexOf(st.key) !== -1) status = "done";
      else if (job.error_step === st.key) status = "failed";
      else if (job.step === st.key) status = job.status === "failed" ? "failed" : "running";
      return {
        key: st.key,
        label: st.label,
        status: status,
        error: job.error_step === st.key ? job.error_message : undefined,
      };
    }));
  }

  function offerRetry(job) {
    const ol = $("#build-progress");
    if (!ol) return;
    const p = document.createElement("p");
    p.className = "small muted";
    p.textContent =
      "Nothing is half-built on your account that we know of; the step above is where it stopped. " +
      "You can go back and try again.";
    ol.appendChild(p);
    const cont = $("#build-continue");
    if (cont) { cont.hidden = false; cont.textContent = "Back to the key step"; }
  }

  function handleProvisionError(err) {
    // Ruled on #52: because we never store key A, a failure in the RunPod steps
    // cannot self-resume. Retry answers 409 runpod_key_required and the tenant
    // re-pastes. Say that plainly instead of a dead end.
    const needsKey = err.status === 409 ||
      /runpod_key_required/.test((err.body && err.body.error) || err.message || "");
    renderProgress([{
      key: "start",
      label: needsKey ? "Setup needs your key again" : "Setup could not finish",
      status: "failed",
      error: err.message,
    }]);
    if (needsKey) {
      const ol = $("#build-progress");
      if (ol) {
        const p = document.createElement("p");
        p.className = "small muted";
        p.textContent =
          "We never stored your setup key, so we cannot retry this on our own. That is the " +
          "tradeoff for not holding it. Go back and paste it again to pick up where this left off.";
        ol.appendChild(p);
      }
    }
    const cont = $("#build-continue");
    if (cont) { cont.hidden = false; cont.textContent = "Back to the key step"; }
  }

  // Key B: verify scope LIVE, then keep it. Never keep it on a failed verdict.
  async function runInvokeKeyCheck() {
    const verdictEl = $("#invoke-verdict");
    if (verdictEl) verdictEl.innerHTML = '<p class="small muted">Checking that key against your endpoints...</p>';
    state.invokeVerified = false;
    refreshGates();

    let verdict;
    try {
      const res = await PlatformApi.invokeKey(state.tenantId, invokeKey);
      if (res.installed) {
        verdict = { ok: true, failures: [], message: "That key checks out: your studio accepted it." };
      } else if (res.probe) {
        // #53 may carry the probe payload; read it when it is there.
        verdict = checks.scopeVerdict(res.probe);
      } else if (res.status === 501) {
        // Honest about a real, current limitation: the key passed the scope
        // check, but nothing is installed yet, so the studio is NOT live. Do
        // not dress a 501 up as success.
        verdict = {
          ok: false,
          failures: ["Your key checks out, but we cannot finish setting up your studio yet: installing it is still being built (#53). Nothing is wrong with your key."],
          message: "Your key checks out, but your studio is not live yet.",
        };
      } else {
        const copy = checks.invokeRejectionCopy(res.reason, res.detail);
        verdict = { ok: false, failures: [copy], message: copy };
      }
      if (res.studio_url) state.studioUrl = res.studio_url;
    } catch (err) {
      verdict = { ok: false, failures: [err.message], message: err.message };
    }

    state.invokeVerified = verdict.ok;
    if (!verdict.ok) {
      // Rejected keys are not kept, here or anywhere. Clear the field so a bad
      // key does not sit in the DOM waiting to be pasted somewhere worse.
      clearInvokeKey();
      const input = $("#invoke-key");
      if (input) input.value = "";
    }

    if (verdictEl) {
      verdictEl.innerHTML = "";
      const callout = document.createElement("div");
      callout.className = "callout " + (verdict.ok ? "" : "callout-bad");
      verdict.ok
        ? callout.appendChild(textP(verdict.message))
        : verdict.failures.forEach(function (f) { callout.appendChild(textP(f)); });
      verdictEl.appendChild(callout);
    }
    refreshGates();
  }

  function textP(text) {
    const p = document.createElement("p");
    p.textContent = text;
    return p;
  }

  // ---- wiring -----------------------------------------------------------
  function wire() {
    if (USE_MOCK) {
      const banner = $("#mock-banner");
      if (banner) banner.hidden = false;
    }

    const accept = $("#accept-aup");
    if (accept) {
      accept.addEventListener("change", function () {
        state.rulesAccepted = accept.checked;
        refreshGates();
      });
    }

    const slugInput = $("#slug");
    if (slugInput) {
      slugInput.addEventListener("input", function () { onSlugInput(slugInput.value); });
    }

    const keyInput = $("#runpod-key");
    const keyHint = $("#key-hint");
    if (keyInput) {
      keyInput.addEventListener("input", function () {
        runpodKey = keyInput.value.trim();
        const hint = checks.keyShapeHint(runpodKey);
        if (keyHint) {
          keyHint.textContent = hint.message;
          keyHint.dataset.level = hint.level === "empty" ? "" : hint.level;
        }
        state.keyPresent = runpodKey.length > 0;
        refreshGates();
      });
    }

    const reveal = $("#key-reveal");
    if (reveal && keyInput) {
      reveal.addEventListener("click", function () {
        const showing = keyInput.type === "text";
        keyInput.type = showing ? "password" : "text";
        reveal.textContent = showing ? "Show" : "Hide";
        reveal.setAttribute("aria-pressed", String(!showing));
      });
    }

    const confirm = $("#confirm-create");
    if (confirm) {
      confirm.addEventListener("change", function () {
        state.confirmed = confirm.checked;
        refreshGates();
      });
    }

    const invokeInput = $("#invoke-key");
    const invokeHint = $("#invoke-hint");
    if (invokeInput) {
      invokeInput.addEventListener("input", function () {
        invokeKey = invokeInput.value.trim();
        const hint = checks.keyShapeHint(invokeKey);
        if (invokeHint) {
          invokeHint.textContent = hint.message;
          invokeHint.dataset.level = hint.level === "empty" ? "" : hint.level;
        }
        // Editing the key invalidates any earlier verdict: never let a verified
        // flag outlive the key it was about.
        state.invokeVerified = false;
        refreshGates();
      });
    }
    const invokeReveal = $("#invoke-reveal");
    if (invokeReveal && invokeInput) {
      invokeReveal.addEventListener("click", function () {
        const showing = invokeInput.type === "text";
        invokeInput.type = showing ? "password" : "text";
        invokeReveal.textContent = showing ? "Show" : "Hide";
        invokeReveal.setAttribute("aria-pressed", String(!showing));
      });
    }
    const invokeCheck = $("#invoke-check");
    if (invokeCheck) {
      invokeCheck.addEventListener("click", function () {
        if (invokeKey) runInvokeKeyCheck();
      });
    }

    document.querySelectorAll("[data-next]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const from = btn.dataset.next;
        if (from !== "what" && from !== "build" && !checks.canAdvance(from, state)) return;

        if (from === "rules") {
          const el = $("#aup-text");
          const version = el && el.dataset ? el.dataset.version : "";
          let res;
          try {
            res = await PlatformApi.acceptAup(version || null);
          } catch (err) {
            res = { ok: false, stale: false, error: err.message };
          }
          if (!res.ok) {
            // Never advance on an unrecorded acceptance.
            showAupError(res);
            if (res.stale) {
              // The policy moved: re-fetch it and make them accept the NEW text.
              // Silently carrying their old tick forward would record consent
              // to words they never saw.
              state.rulesAccepted = false;
              const box = $("#accept-aup");
              if (box) box.checked = false;
              refreshGates();
              await loadAup();
            }
            return;
          }
          hideAupError();
        }

        if (from === "invoke") {
          // The tenant only becomes live once the key is installed, so re-read
          // /api/me rather than assuming the URL we derived earlier is serving.
          try {
            const me = await PlatformApi.me();
            if (me && me.tenant && me.tenant.url) state.studioUrl = me.tenant.url;
          } catch (err) { /* fall back to the derived address */ }
          finishAndShowDone();
          return;
        }

        const idx = checks.stepIndex(from);
        const next = checks.STEPS[idx + 1];
        if (!next) return;
        show(next.key);

        if (next.key === "capacity") runCapacityCheck();
        if (next.key === "review") { renderPlan("#plan-review"); renderTotal(); }
        if (next.key === "build") runProvision();
      });
    });

    document.querySelectorAll("[data-back]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const idx = checks.stepIndex(btn.dataset.back);
        const prev = checks.STEPS[idx - 1];
        if (prev) show(prev.key);
      });
    });
  }

  function renderTotal() {
    const el = $("#plan-total");
    if (!el) return;
    const total = checks.planWorkerTotal(state.plan);
    const fit = state.capacity;
    let text = "Total: " + total + (total === 1 ? " worker" : " workers") + " at most, across " +
      state.plan.length + " endpoints, all scale-to-zero.";
    if (fit && fit.known && typeof fit.quota === "number") {
      text += " Your account's real quota is " + fit.quota + ".";
    }
    el.textContent = text;
  }

  async function loadConfig() {
    try {
      const cfg = await PlatformApi.config();
      if (cfg && cfg.tenant_domain_suffix) state.tenantDomainSuffix = cfg.tenant_domain_suffix;
      if (cfg && cfg.signups_enabled === false) {
        const banner = $("#signups-off");
        if (banner) banner.hidden = false;
        document.querySelectorAll("[data-next]").forEach(function (b) { b.disabled = true; });
      }
    } catch (err) {
      // Non-fatal: the per-step calls surface their own errors honestly.
    }
  }

  function init() {
    if (!checks) return;
    wire();
    show("what");
    refreshGates();
    loadConfig();
    loadPlan();
    loadAup();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
