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
// There is no tenant RunPod key on this page. Go-live is an empty POST that
// attaches the plane shared pool. Do not add a key field.
(function () {
  "use strict";

  const checks = window.onboardingChecks;
  const platform = window.onboardingApi;

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

  const state = {
    rulesAccepted: false,
    confirmed: false,
    invokeVerified: false,
    plan: [],
    planError: null,
    studioUrl: null,
    createdEndpoints: [],
    tenantId: null,
    slug: "",
    slugValid: false,
    slugAvailable: false,
    // cp#435: available and reclaimable are DIFFERENT answers. The second means the name is free
    // to this account because it is that account own unfinished studio, and taking it destroys it.
    slugReclaimable: false,
    slugReclaimConfirmedFor: null,
    tenantDomainSuffix: ".studio.vivijure.com",
  };

  let current = "what";

  // ---- the control-plane API --------------------------------------------
  //
  // The transport and the preview mock BOTH live in onboarding-api.js (cp#31).
  // They were inline here, inside this IIFE, which meant no test could import
  // them: the suite had to assert a hand-written MIRROR of the fetch calls
  // instead of the shipped ones, and a mirror stays green while the code it
  // copies drifts away from it.
  //
  // This file must never build a request itself. That is not a convention to
  // remember: tests/onboarding-transport.test.ts reads this source and fails if
  // a fetch call reappears in it.
  const PlatformApi = platform && platform.createPlatformApi({
    apiBase: API_BASE,
    useMock: USE_MOCK,
  });

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

  // Renders the plan rows from the endpoints it is HANDED. Reads only the data:
  // an endpoint added to the array grows a row here with no change to this
  // function. The caller chooses the source -- the intro passes the
  // representative example, the review step passes the fetched real plan -- so
  // the two render identically from one code path.
  function renderPlan(container, endpoints, opts) {
    const el = typeof container === "string" ? $(container) : container;
    if (!el) return;
    const rows = endpoints || [];
    el.innerHTML = "";
    if (!rows.length) {
      // An empty plan on the REVIEW step means the real fetch failed or has not
      // landed. Say which, honestly. The intro never reaches this branch: it is
      // handed a non-empty representative example.
      const msg = (opts && opts.errorMessage)
        ? "Could not load the setup plan: " + opts.errorMessage
        : "No plan loaded.";
      const pEl = document.createElement("p");
      pEl.className = opts && opts.errorMessage ? "hint" : "muted small";
      if (opts && opts.errorMessage) pEl.dataset.level = "bad";
      pEl.textContent = msg;
      el.appendChild(pEl);
      return;
    }
    rows.forEach(function (ep) {
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
      // Own-iron rows are not scale-to-zero and have no worker pin (cp#474).
      meta.textContent = checks.planRowMeta(ep);
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

  // The intro cost line. Takes the example it renders so it never depends on a
  // fetch: the figure is a real, dated render from our history (representative),
  // and the account sees its own spend in the studio after the first render.
  function renderCostExample(ex) {
    const el = $("#cost-example");
    if (!el) return;
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
      ". Probably less: that clock includes queue and model-load time, and we are billed for " +
      "active GPU seconds. Your studio shows the real figure after the first render.";
  }

  // The intro renders a REPRESENTATIVE example immediately, with NO network
  // call. The real plan lives behind a session, so fetching it here 401d a
  // signed-out visitor: a red error in the plan box and a cost line stuck on
  // "loading a real example" forever. This shows a clearly-labelled stand-in
  // instead; the account sees its real numbers at the Review step, which is
  // past the sign-in and where the live plan is fetched.
  function renderRepresentativePlan() {
    const rep = checks.REPRESENTATIVE_PLAN || { endpoints: [], cost_example: null };
    renderPlan("#plan-preview", rep.endpoints);
    renderCostExample(rep.cost_example);
  }

  function renderProgress(steps, note) {
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
    if (note) {
      const p = document.createElement("p");
      p.className = "small muted";
      p.textContent = note;
      ol.appendChild(p);
    }
  }

  // ---- flow -------------------------------------------------------------
  // Fetch the REAL plan for the steps that need it (capacity fit, the review
  // rows and total). This runs once the flow BEGINS -- never on the intro --
  // because the route needs a session, so a load here cannot 401 a signed-out
  // visitor on the landing page. A failure is recorded and surfaced at Review,
  // where the numbers are due, and nowhere else.
  async function loadPlan() {
    try {
      const data = await PlatformApi.plan();
      state.plan = (data && data.endpoints) || [];
      state.planError = null;
    } catch (err) {
      state.plan = [];
      state.planError = err.message;
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

  // cp#435: RESET THE ACKNOWLEDGEMENT WHENEVER THE ANSWER COULD HAVE CHANGED.
  //
  // A ticked box is consent to destroy ONE named studio. Carrying it across a slug edit would let
  // somebody acknowledge the deletion of one name and then provision over a different one, which
  // is consent to something they were never shown.
  function resetReclaimAck() {
    state.slugReclaimable = false;
    state.slugReclaimConfirmedFor = null;
    const box = $("#slug-reclaim");
    const ack = $("#slug-reclaim-ack");
    if (ack) ack.checked = false;
    if (box) box.hidden = true;
  }

  async function checkSlug() {
    const el = $("#slug-hint");
    resetReclaimAck();
    try {
      const res = await PlatformApi.slugAvailable(state.slug);
      state.slugAvailable = res.available === true;
      // THE PLANE ALREADY DISTINGUISHES FREE FROM YOUR-OWN-STUDIO. Read both, never just the first.
      state.slugReclaimable = res.available === true && res.reclaimable === true;
      const verdict = checks.slugVerdict(res, state.slug);
      if (el) {
        el.textContent = verdict.text;
        el.dataset.level = verdict.level;
      }
      const box = $("#slug-reclaim");
      if (box) box.hidden = verdict.state !== "reclaim";
    } catch (err) {
      state.slugAvailable = false;
      if (el) {
        el.textContent = "We could not check that name: " + err.message;
        el.dataset.level = "bad";
      }
    }
    refreshGates();
  }

  // Provisioning: start the job, poll it, then read the TENANT status to learn
  // where we landed. Job status (queued/running/succeeded/failed) and tenant
  // status (provisioning/awaiting_go_live/live) are different machines in
  // the #52 contract, and conflating them is how a UI ends up lying: a job can
  // succeed and the tenant still not be live, which is exactly the
  // awaiting_go_live case.
  // The cadence, the boundary rule and the copy all live in onboarding-checks
  // (cp#124), where they are pure and tested. Nothing here re-decides them.

  async function runProvision() {
    renderProgress([{ key: "start", label: "Starting setup", status: "running" }]);
    try {
      const job = await PlatformApi.provision(state.slug);
      state.tenantId = job.tenant_id;

      // THE BOUNDARY (cp#124). The job is now running on the plane side, and
      // until it records `wfp_upload` a poll cannot drive it -- it can only
      // take the lease and write the honest keyless refusal, which kills a
      // healthy provision. So we leave it alone first, then watch it.
      await waitOutProvisionBoundary();

      let last = null;
      const stopAt = Date.now() + checks.PROVISION_WATCH_MS;
      while (Date.now() < stopAt) {
        last = await PlatformApi.job(state.tenantId);
        renderJobProgress(last);
        if (checks.provisionTerminal(last)) break;
        // Cadence from the JOB, not from our clock: slow while it is still
        // short of the boundary, fast once the poll is genuinely the engine.
        await sleep(checks.provisionPollDelayMs(last));
      }

      if (!checks.provisionTerminal(last)) {
        // No silent cap: if we stop watching, say so rather than spin forever.
        renderProgress([{
          key: "timeout", label: "Setup is taking longer than we expected", status: "failed",
          error: checks.provisionTimeoutCopy(),
        }]);
        return;
      }

      if (last.status === "failed") {
        renderJobProgress(last);
        offerRetry(last);
        return;
      }

      const me = await PlatformApi.me();
      const tenant = (me && me.tenant) || null;
      state.createdEndpoints = (tenant && tenant.endpoints) || [];
      // tenantView only returns a url once the tenant is live ("a link that
      // 5xx's is not honest"). Prefer the server's answer; fall back to the
      // derived address only for the preview.
      if (tenant && tenant.url) state.studioUrl = tenant.url;
      else if (tenant && tenant.slug) state.studioUrl = "https://" + tenant.slug + state.tenantDomainSuffix;

      if (tenant && (tenant.status === "awaiting_go_live" || tenant.status === "awaiting_invoke_key")) {
        applyInvokeRequirement(tenant);
        show("go-live");
        return;
      }
      if (tenant && tenant.status === "live") {
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

  /**
   * Hold the first poll until the plane has had time to cross the resume
   * boundary (cp#124). The wait is OUR clock and is labelled as such: the
   * screen never claims a step is done, it says when it will look.
   *
   * Preview mode compresses the wait so the mock flow stays walkable. The mock
   * has no job to kill, and the banner already says loudly that nothing in the
   * preview is real.
   */
  async function waitOutProvisionBoundary() {
    const total = USE_MOCK ? 3000 : checks.PROVISION_FIRST_POLL_MS;
    const until = Date.now() + total;
    let remaining = total;
    while (remaining > 0) {
      renderBoundaryWait(remaining, total);
      await sleep(Math.min(1000, remaining));
      remaining = until - Date.now();
    }
    renderBoundaryWait(0, total);
  }

  function renderBoundaryWait(remainingMs, totalMs) {
    renderProgress(
      [{ key: "boundary", label: checks.provisionWaitCopy(remainingMs), status: "running" }],
      checks.provisionWaitNote(totalMs),
    );
  }

  function finishAndShowDone() {
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

  // Render the job payload the API contract carries. error_message is the REAL
  // step error and is shown verbatim: if RunPod says the worker quota is 10 and
  // we need 12, the tenant reads exactly that, not "provisioning failed".
  //
  // The row-to-step mapping lives in onboarding-checks (cp#124) because it is
  // the half that was wrong and could not be tested from here: this function
  // used to match on d1/r2/runpod/studio/verify, and a real job reports
  // d1_create, d1_migrate, r2_bucket, r2_token, runpod_endpoints, wfp_upload,
  // modules_upload, modules_install, verify. Only the last one ever matched, so
  // a live provision rendered as five untouched rows and then a tick.
  function renderJobProgress(job) {
    renderProgress(checks.provisionRows(job));
  }

  function offerRetry(job) {
    const ol = $("#build-progress");
    if (!ol) return;
    const p = document.createElement("p");
    p.className = "small muted";
    p.textContent =
      "Nothing is half-built on your account that we know of; the step above is where it stopped. " +
      "You can start again with a different name, or tell us and we will look at this one.";
    ol.appendChild(p);
    // cp#447: the control that used to appear here was labelled "Back to the key step" and was a
    // data-next button, so it advanced BY INDEX into the render-key step -- forward, past its own
    // gate, on a page that had none of the state that step needs. The key step no longer exists at
    // all (cp#427), so the label pointed at nothing as well as going the wrong way. A failure
    // screen that cannot offer a correct action offers none.
  }

  function handleProvisionError(err) {
    // CLASSIFIED ON THE CODE, and the plane's own sentence is what the owner reads (cp#448).
    const copy = checks.provisionFailureCopy(err);
    renderProgress([{
      key: "start",
      label: copy.headline,
      status: "failed",
      error: copy.detail,
    }]);
    // WHEN THE PLANE DID NOT SPEAK, say so rather than inventing a reason. A bare code is not an
    // explanation, and pretending otherwise is how somebody goes hunting for a problem that is
    // ours. Deliberately no re-provision advice on any path: under cp#427 there is no key to
    // re-paste, and the destroy route belongs behind the cp#435 acknowledgement, never in a hint.
    if (!copy.spoken) {
      const ol = $("#build-progress");
      if (ol) {
        const p = document.createElement("p");
        p.className = "small muted";
        p.textContent =
          "That is the code we were given and nothing more, which is our gap rather than yours. " +
          "Please tell us you saw it and we will find out what it means.";
        ol.appendChild(p);
      }
    }
  }

  // Attach the shared pool and, on live, walk to done. One button, no key.
  async function runGoLive() {
    const verdictEl = $("#invoke-verdict");
    if (verdictEl) verdictEl.innerHTML = '<p class="small muted">Attaching the shared pool...</p>';
    state.invokeVerified = false;
    refreshGates();

    let verdict;
    try {
      const res = await PlatformApi.invokeKey(state.tenantId);
      // ONE call, one pure decision. Every branch that used to live here (204
      // installed, 501 not_implemented, res.probe, res.studio_url) was written
      // against shapes no route serves; they are gone rather than left as a
      // second copy of the trap that produced this defect.
      verdict = checks.invokeKeyVerdict(res.status, res.body);
    } catch (err) {
      verdict = {
        ok: false, tone: "bad", live: false, pending: false, keyStored: false,
        // A transport failure (offline, DNS, TLS) tells us NOTHING about
        // whether the key was stored, so we must not blank the field on a
        // guess. Keep it and let them retry.
        clearKey: false, message: err.message, notes: [], failures: [err.message],
      };
    }

    // The gate opens on LIVE only. A 202 is honest progress, not a pass: the
    // tenant is still awaiting_invoke_key server-side and must not be walked
    // forward as though the studio were serving.
    state.invokeVerified = verdict.live === true;

    // Clear the field ONLY when the verdict says the KEY was refused. The old
    // code cleared on every non-success, which meant a 202 -- whose whole
    // message is "Do not re-paste your key; nothing is wrong with it" -- wiped
    // the key out from under that sentence and invited exactly the re-paste it
    // warns against. The UI must not contradict the words it is displaying.
    if (verdictEl) {
      verdictEl.innerHTML = "";
      const callout = document.createElement("div");
      // pending reuses callout-warn: a 202 wants attention, but it is NOT a
      // failure and must not be painted as one. Only tone "bad" gets bad.
      callout.className = "callout" + TONE_CLASS[verdict.tone];
      // The headline is ALWAYS rendered. The old paint showed message only on
      // success and failures only on failure, so a 202 (ok false, failures
      // empty) would have painted an EMPTY box -- the customer told nothing at
      // all about a key we are holding.
      callout.appendChild(textP(verdict.message));
      verdict.notes.forEach(function (n) { callout.appendChild(textP(n)); });
      verdict.failures.forEach(function (f) {
        // Do not print the headline twice when it IS the failure copy.
        if (f !== verdict.message) callout.appendChild(textP(f));
      });
      verdictEl.appendChild(callout);
    }
    refreshGates();
    if (verdict.live === true) {
      try {
        const me = await PlatformApi.me();
        if (me && me.tenant && me.tenant.url) state.studioUrl = me.tenant.url;
      } catch (err) { /* fall back to the derived address */ }
      finishAndShowDone();
    }
  }

  const TONE_CLASS = { good: "", warn: " callout-warn", pending: " callout-warn", bad: " callout-bad" };

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

    const reclaimAck = $("#slug-reclaim-ack");
    if (reclaimAck) {
      reclaimAck.addEventListener("change", function () {
        // Record WHICH name was acknowledged, not merely that a box was ticked.
        state.slugReclaimConfirmedFor = reclaimAck.checked ? state.slug : null;
        refreshGates();
      });
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

    const confirm = $("#confirm-create");
    if (confirm) {
      confirm.addEventListener("change", function () {
        state.confirmed = confirm.checked;
        refreshGates();
      });
    }

    const goLive = $("#go-live");
    if (goLive) {
      goLive.addEventListener("click", function () {
        runGoLive();
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

        // Leaving the intro is where the flow truly begins, so this is where the
        // real plan is fetched -- past the landing page, ready well before the
        // capacity and review steps that read it.
        if (from === "what" && !state.plan.length) loadPlan();

        const idx = checks.stepIndex(from);
        const next = checks.STEPS[idx + 1];
        if (!next) return;
        show(next.key);

        if (next.key === "review") { renderPlan("#plan-review", state.plan, { errorMessage: state.planError }); renderTotal(); }
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
    el.textContent = checks.planSummaryCopy(state.plan);
  }

  // cp#439: PROJECT THE TIER ONTO BOTH STEPS THAT ASSUMED BYOK.
  //
  // Step 4 asks a PLATFORM question (does this plane pool, so is a key optional) and step 8 asks a
  // TENANT question (is THIS tenant pooled, so is a key refused). Two facts, two moments, and the
  // tenant does not exist yet at step 4, which is why one field cannot serve both.
  // WHICH GO-LIVE SCREEN THIS TENANT GETS (cp#427 purge).
  //
  // Three states and no BYO one. pooled is the supported shape and the only one with an action;
  // unsupported is a legacy dedicated row the invoke-key route refuses by name, so we say that
  // rather than offering key instructions nothing will accept; undecided is an unwritten
  // runpod_mode, which is NOT a tier and must not be read as either answer.
  function applyInvokeRequirement(tenant) {
    const req = checks.invokeRequirement(tenant);
    state.invokePooled = req === "pooled";
    const pool = $("#invoke-pooled");
    if (pool) pool.hidden = req !== "pooled";
    const unknown = $("#invoke-undecided");
    if (unknown) unknown.hidden = req !== "undecided";
    const legacy = $("#invoke-unsupported");
    if (legacy) legacy.hidden = req !== "unsupported";
  }

  // CAN THIS PLANE PROVISION AT ALL (cp#427). Said up front: the provision route refuses a
  // poolless plane, and walking somebody through naming a studio we cannot build is the same
  // confidently-wrong screen the rest of this work has been removing.
  function applyProvisionAvailability(cfg) {
    state.canProvision = checks.planCanProvision(cfg);
    const el = $("#no-shared-capacity");
    if (el) el.hidden = state.canProvision;
  }

  async function loadConfig() {
    try {
      const cfg = await PlatformApi.config();
      if (cfg && cfg.tenant_domain_suffix) state.tenantDomainSuffix = cfg.tenant_domain_suffix;
      applyProvisionAvailability(cfg);
      // SIGNUPS-OFF FREEZES A STRANGER, NEVER AN ACCOUNT THAT ALREADY EXISTS (cp#428).
      //
      // This used to disable every [data-next] on the page the moment the switch was off, which
      // stranded exactly the person the plane goes out of its way NOT to strand: provisioning
      // gates on session plus accepted AUP only, and src/index.ts says so in as many words --
      // an existing, AUP-accepted account mid-onboarding is never stranded by the admin closing
      // signups. An operator-provisioned tenant reaches this page to hand over its render key,
      // and a disabled Next there is the difference between a studio that finishes and one that
      // cannot. The banner is true for a stranger and false for an account holder, so it follows
      // the same test instead of being shown to both.
      if (cfg && cfg.signups_enabled === false) {
        let signedOut = false;
        try {
          const me = await PlatformApi.me();
          signedOut = !(me && me.account);
        } catch (err) {
          // 401/403 IS the signed-out answer. Any other failure leaves us NOT KNOWING, and a
          // client that refuses on not knowing invents a refusal the plane never made; the
          // provision route is the real gate and refuses legibly by itself.
          signedOut = Boolean(err) && (err.status === 401 || err.status === 403);
        }
        if (signedOut) {
          const banner = $("#signups-off");
          if (banner) banner.hidden = false;
          document.querySelectorAll("[data-next]").forEach(function (b) { b.disabled = true; });
        }
      }
    } catch (err) {
      // Non-fatal: the per-step calls surface their own errors honestly.
    }
  }

  /**
   * BOOT FROM /api/me AND LAND WHERE THE TENANT ACTUALLY IS (cp#455).
   *
   * init() showed step 1 unconditionally, so a person the front door had ALREADY routed here on
   * purpose -- finish your setup, watch the progress, see what happened -- was handed a fresh
   * wizard that did not know their studio existed. Everything they needed was in a payload this
   * page never asked for.
   *
   * The wizard still OPENS at step 1 and this runs after, deliberately: a self-served visitor is
   * the common case, must see no delay, and must not have a screen swapped under them for a
   * tenant they do not have. resumeStep returns what for exactly that case, so the common path is
   * unchanged including its timing.
   */
  async function resumeFromAccount() {
    let me;
    try {
      me = await PlatformApi.me();
    } catch (err) {
      // 401 is the ordinary signed-out answer and is not worth shouting about; anything else
      // leaves us NOT KNOWING, and a page that reroutes on not-knowing is how somebody ends up
      // on a screen about a studio we never actually read. Stay at step 1 either way.
      return;
    }

    const target = checks.resumeStep(me);
    if (target.step === "what") return;

    const tenant = (me && me.tenant) || null;
    if (tenant) {
      // THE STATE EVERY LATER STEP ASSUMED IT HAD. state.tenantId had exactly one assignment,
      // inside runProvision, which is why a fresh arrival POSTed to /api/tenant/null/... and was
      // then told its key was rejected (cp#447).
      state.tenantId = tenant.id;
      state.createdEndpoints = tenant.endpoints || [];
      if (tenant.url) state.studioUrl = tenant.url;
      else if (tenant.slug) state.studioUrl = "https://" + tenant.slug + state.tenantDomainSuffix;
    }

    if (target.step === null) {
      // Not a setup state at all. The FRONT DOOR has screens for suspended, deleting and deleted;
      // this page does not, and starting a wizard for a deleted studio would be exactly the
      // confidently-wrong screen this issue is about. Say so and point at the page that knows.
      const el = $("#not-in-setup");
      if (el) el.hidden = false;
      show("not-in-setup");
      return;
    }

    if (target.step === "go-live") {
      // THE SEAM cp#455 MARKED, now closed. A tenant arriving here BY RESUME must get the same
      // tier projection as one arriving BY PROVISION, or the two paths disagree about which of
      // the three go-live states this studio is in.
      applyInvokeRequirement(tenant);
      show("go-live");
      return;
    }

    if (target.step === "done") {
      finishAndShowDone();
      return;
    }

    if (target.step === "build") {
      show("build");
      await renderResumedJob(tenant);
    }
  }

  /** Render the REAL job for a tenant we did not provision in this page session. */
  async function renderResumedJob(tenant) {
    if (!tenant) return;
    let job = null;
    try {
      job = await PlatformApi.job(tenant.id);
    } catch (err) {
      renderProgress([{ key: "status", label: "We could not read this build", status: "failed", error: err.message }]);
      return;
    }
    // error_step and error_message live on the job row, which is what makes See what happened
    // able to show what happened rather than a sales pitch (cp#455).
    renderJobProgress(job);
    if (job && job.status === "failed") offerRetry(job);
  }

  function init() {
    // Both dependencies are hard: without the transport there is nothing to
    // render from, and a half-wired page that looks alive is worse than one
    // that does nothing at all.
    if (!checks || !PlatformApi) return;
    wire();
    show("what");
    refreshGates();
    loadConfig();
    renderRepresentativePlan();
    loadAup();
    // AFTER the wizard has opened at step 1, so the common self-served path is unchanged.
    resumeFromAccount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
