// The control-plane transport seam for the hosted onboarding flow (cp#31).
//
// WHY THIS FILE EXISTS SEPARATELY FROM onboarding.js
// -------------------------------------------------
// onboarding.js is one big IIFE, so nothing inside it could be imported and no
// test could reach the functions that actually talk to the network. The suite
// covered that gap with a MIRROR: a reimplementation of the three lines in
// invokeKey(), tested against a stubbed fetch. A mirror asserts a copy of the
// code, not the code -- edit the shipped function to diverge and the mirror
// stays green. That is a stub encoding an assumption, which is the exact
// pattern that produced the defect cp#20 fixed.
//
// So the transport lives here, behind the same UMD-ish wrapper that
// onboarding-checks.js already uses: CommonJS when module exists (the test
// harness), a global otherwise (the browser). No build step, no framework, and
// onboarding.js keeps consuming it as a plain global.
//
// THE ONE SEAM. createPlatformApi() takes an optional fetchImpl and nothing
// else that a test would want to fake. Tests drive the SHIPPED functions with
// only fetch replaced; there is no second copy of the request-building code
// anywhere in the repo, and tests/onboarding-transport.test.ts carries a
// tripwire that fails if onboarding.js ever grows its own fetch call again.
//
// NOT settled (do not treat as contract): routes marked REQUESTED below are
// ones this flow needs that the #52 contract does not carry yet. If they land
// in a different shape, this adapter is the only thing that changes.
//
// SECRET HYGIENE: keys pass THROUGH these functions into a POST body and are
// never stored, logged, or placed in a URL. Nothing here retains an argument.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.onboardingApi = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // ---- mock data (preview only; onboarding.js makes the banner loud) ------
  //
  // The mock lives WITH the transport on purpose: it is an alternate
  // implementation of the same seam, so a mock that invents its own shape is
  // how a client drifts from the contract without anyone noticing. Keeping the
  // two in one file means the tests that check the real shapes also reach these.

  // The mock tenant walks the real status machine: a provision lands in
  // awaiting_go_live, then an empty POST takes it live.
  const mockTenant = {
    id: "ten_mock",
    slug: "your-studio",
    status: "awaiting_go_live",
    endpoints: [
      { key: "backend", label: "backend", id: "abc123backend", name: "vivijure-backend-your-studio" },
      { key: "upscale", label: "upscale", id: "abc123upscale", name: "vivijure-upscale-your-studio" },
      { key: "lipsync", label: "lipsync", id: "abc123lipsync", name: "vivijure-musetalk-your-studio" },
      { key: "audio-upscale", label: "audio-upscale", id: "abc123audio", name: "vivijure-audio-upscale-your-studio" },
    ],
  };

  const mock = {
    config() {
      return { signups_enabled: true, aup_version: "mock-v1", auth_methods: ["email", "google", "github"] };
    },
    me() {
      return {
        account: { id: "acct_mock", email: "you@example.com" },
        aup: { required_version: "mock-v1", accepted: true, last_accepted: { version: "mock-v1", accepted_at: "2026-07-12T09:31:04Z" } },
        tenant: mockTenant,
      };
    },
    slugAvailable(slug) {
      return { available: slug !== "taken", reason: slug === "taken" ? "already in use" : undefined };
    },
    plan() {
      return {
        // Shape matches provisionPlanView() (cp#474). The mock used to invent four RunPod
        // endpoints with purposes the plane never served, so preview walked and production
        // rendered an empty review.
        endpoints: [
          // cp#303: label matches PROVISION_PLAN -- training is not on this endpoint.
          { key: "backend", label: "Render (keyframes, video)", backing: "runpod", image: "ghcr.io/skyphusion-labs/vivijure-backend", max_workers: 2, gpu: "NVIDIA H200 / NVIDIA B200" },
          { key: "upscale", label: "Video upscale", backing: "vpc", image: "ghcr.io/skyphusion-labs/vivijure-upscale", max_workers: null, gpu: "our hardware" },
          { key: "lipsync", label: "Lip sync", backing: "runpod", image: "ghcr.io/skyphusion-labs/vivijure-musetalk", max_workers: 1, gpu: "NVIDIA RTX 6000 Ada Generation / NVIDIA L40S" },
          { key: "audio-upscale", label: "Audio upscale", backing: "vpc", image: "ghcr.io/skyphusion-labs/vivijure-audio-upscale", max_workers: null, gpu: "our hardware" },
        ],
        // A real, named render from our own history (film-2294a9d7, 2026-07-14:
        // 2 shots, 10s of finished video, final quality). wall_clock_ms is
        // wall-clock since submit, so the derived cost is a CEILING and is
        // labelled as one wherever it is shown. Provenance travels WITH the
        // number so a reader can audit it. TODO(#53/#54): the end-to-end verify
        // render in the provisioner produces a real BILLED-seconds figure as a
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
    provision() { return { tenant_id: "ten_mock", job_id: "job_mock" }; },
    // The REAL step vocabulary (provisioner PROVISION_STEPS), not a friendly
    // parallel one. The old mock reported d1/r2/runpod/studio/verify, which no
    // real job ever says, so the preview looked right while the shipped build
    // screen matched almost nothing. A mock that invents its own shape is how a
    // client drifts from the contract without anyone noticing.
    job() {
      return {
        kind: "provision",
        status: "succeeded",
        step: "verify",
        steps_done: [
          "d1_create", "d1_migrate", "r2_bucket", "r2_token", "runpod_endpoints",
          "wfp_upload", "modules_upload", "modules_install", "verify",
        ],
        error_step: null,
        error_message: null,
        from_release: null,
        to_release: null,
        finished_at: "2026-07-25T00:00:00Z",
      };
    },
    // Mirrors the REAL 200 go-live body. A mock that invents its own shape is
    // how a client drifts from the contract without anyone noticing.
    invokeKey() {
      return {
        status: 200,
        body: {
          status: "live",
          verified_endpoints: 4,
          modules_ready: true,
          modules_verified: ["backend", "upscale", "lipsync", "audio-upscale"],
        },
      };
    },
  };

  // ---- the control-plane API (reconciled against the #52 contract) -------
  //
  // Routes below marked CONTRACT are from the posted #52 contract
  // (issuecomment-4998960324) and are authoritative. Routes marked REQUESTED
  // are ones this flow needs that the contract does not carry yet; they are
  // raised on #52 and are NOT invented facts.
  //
  // opts.apiBase   -- "" means same-origin, the normal case (this page is
  //                   served BY the control plane).
  // opts.useMock   -- EXPLICIT preview opt-in, never a fallback. See the long
  //                   note in onboarding.js for why inferring it was a trap.
  // opts.fetchImpl -- the ONE seam. Omitted in the browser. When omitted, fetch
  //                   is resolved through globalThis on EVERY call rather than
  //                   captured at construction, so a test that stubs the global
  //                   after building the client still drives the shipped code.
  function createPlatformApi(opts) {
    const options = opts || {};
    const apiBase = options.apiBase || "";
    const useMock = options.useMock === true;
    const doFetch = options.fetchImpl || function () {
      return globalThis.fetch.apply(globalThis, arguments);
    };

    return {
      async json(path, init) {
        const r = await doFetch(apiBase + path, init);
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
      // methods. auth_methods is projected, never hardcoded -- Apple appears
      // the day the .p8 is staged, with no UI change. Same ethos as the planner
      // rendering from the module registry.
      config() {
        if (useMock) return Promise.resolve(mock.config());
        return this.json("/api/platform/config");
      },

      // CONTRACT. The one call the front door needs on load: account, AUP
      // state, and the tenant (or null). Tenant status is what tells us whether
      // we are awaiting key B or live.
      me() {
        if (useMock) return Promise.resolve(mock.me());
        return this.json("/api/me");
      },

      // CONTRACT: { version, url, summary }. Ernst owns the words (#57).
      async aup() {
        if (useMock) return null;
        try { return await this.json("/api/aup/current"); } catch (err) { return null; }
      },

      // 204 = recorded. 409 = the version moved under us (aup_version_stale).
      //
      // This used to await fetch(...) and return {ok:true} unconditionally,
      // swallowing the 409: the flow would advance telling someone their
      // consent was recorded when it was not, and they would only find out at
      // provision time via a 403. A consent gate that lies about consent is not
      // a gate. It reports honestly now, and the caller refuses to advance.
      async acceptAup(version) {
        if (useMock) return { ok: true };
        const r = await doFetch(apiBase + "/api/aup/accept", {
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
        if (useMock) return Promise.resolve(mock.slugAvailable(slug));
        return this.json("/api/tenant/slug-available?slug=" + encodeURIComponent(slug));
      },

      // CONTRACT (cp#474). Projection of PROVISION_PLAN, the same array the
      // provisioner builds from. The review screen cannot honestly say "this
      // is what we will create" without it, and the numbers belong to the
      // provisioner, not to the page.
      plan() {
        if (useMock) return Promise.resolve(mock.plan());
        return this.json("/api/tenant/provision-plan");
      },

      provision(slug) {
        if (useMock) return Promise.resolve(mock.provision());
        return this.json("/api/tenant/provision", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: slug }),
        });
      },

      // CONTRACT: { status, step, steps_done, error_step, error_message }.
      // error_message is the REAL step error, verbatim, and we show it as such.
      job(tenantId) {
        if (useMock) return Promise.resolve(mock.job());
        return this.json("/api/tenant/" + encodeURIComponent(tenantId) + "/job");
      },

      // CONTRACT: 202 { job_id }, or 409 runpod_key_required when the failure
      // was in the RunPod steps (we stored no key, so we cannot resume alone).
      // TRANSPORT ONLY. Returns the real HTTP status and the parsed body and
      // decides NOTHING. The interpretation lives in checks.invokeKeyVerdict,
      // which is pure and therefore testable against the shapes the route
      // actually serves (tests/onboarding-invoke-key.test.ts).
      //
      // The version this replaces encoded a "204 verified-and-installed / 501
      // not_implemented" contract that NO route has ever served, and it buried
      // the decision inside the fetch where no test could reach it. Both halves
      // of that are the defect. The route serves 200 (live) or 202 (installed,
      // not yet confirmed); failures carry a diagnostic.
      async invokeKey(tenantId, key) {
        if (useMock) return mock.invokeKey();
        // Shared-tier go-live is an EMPTY body (cp#439). A posted key is refused
        // on that tier, so a blank field must not become runpod_invoke_key:"".
        const payload = key ? { runpod_invoke_key: key } : {};
        const r = await doFetch(apiBase + "/api/tenant/" + encodeURIComponent(tenantId) + "/go-live", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await r.json().catch(function () { return {}; });
        return { status: r.status, body: body };
      },
    };
  }

  return {
    createPlatformApi: createPlatformApi,
    mockResponses: mock,
    mockTenant: mockTenant,
  };
});
