// The hosted front door (#52 UI). Vanilla JS, no framework, no build step.
//
// Built against Rollins' control plane as IMPLEMENTED in PR #67
// (src/index.ts), not against the design comment: where the two
// differ, the code is the contract.
//
// Two calls drive the whole shell, exactly as he specced:
//   GET /api/platform/config -> signups switch + auth_methods
//   GET /api/me              -> account, AUP state, tenant (+ status)
// Everything the page shows is a projection of those two payloads. There is no
// hardcoded provider list and no hardcoded status list.
(function () {
  "use strict";

  const checks = window.frontDoorChecks;
  const creditChecks = window.creditsChecks;
  const API_BASE = window.HOSTED_API_BASE || "";
  const $ = function (sel) { return document.querySelector(sel); };
  // Same cadence as onboarding.html's provision poll. Only armed on
  // building/failed (cp#432). One timer, replaced not stacked.
  const WATCH_MS = 2500;
  let watchTimer = null;

  const Api = {
    async json(path, init) {
      const r = await fetch(API_BASE + path, init);
      if (r.status === 204) return null;
      const body = await r.json().catch(function () { return {}; });
      if (!r.ok) {
        const err = new Error(body.error || "request failed (" + r.status + ")");
        err.status = r.status;
        throw err;
      }
      return body;
    },
    config() { return this.json("/api/platform/config"); },
    // 401 is the normal signed-out answer, not an error worth shouting about.
    async me() {
      try { return await this.json("/api/me"); } catch (err) {
        if (err.status === 401 || err.status === 403) return null;
        throw err;
      }
    },
    emailStart(email) {
      return this.json("/api/auth/email/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email }),
      });
    },
    logout() { return this.json("/api/auth/logout", { method: "POST" }); },
    // cp#194. A failure here must never take the studio panel down with it: the
    // balance is an addition to a page whose primary job is the studio link.
    async credits(tenantId) {
      try { return await this.json("/api/tenant/" + tenantId + "/credits"); } catch (err) {
        // 503 is the plane telling us honestly that it could not read the balance
        // (an unwired ledger, or a failed aggregate). That is a REAL state with its
        // own copy, not an error to swallow, so it is reported rather than dropped.
        if (err.status === 503) return { credits_apply: true, complete: false };
        return null;
      }
    },
  };


  // cp#194: the prepaid credit panel.
  //
  // MOUNTED ONLY ON THE LIVE-STUDIO ROUTE, for the same reason the cf#94 token
  // panel is: the control plane already told us what "live" means, and a second
  // opinion in the panel is how two surfaces start disagreeing.
  //
  // EVERY DECISION BELOW COMES FROM THE PAYLOAD. The panel never infers that a
  // tenant is prepaid from having a balance, because a studio we do not bill and a prepaid
  // tenant who has not topped up both read zero, and telling the first they owe
  // us money is the failure this gate exists to prevent.
  async function mountCredits(tenant) {
    const panel = $("#credits");
    if (!panel || !tenant || !tenant.id) return;

    const payload = await Api.credits(tenant.id);
    const state = creditChecks.panelState(payload);
    if (!state.show) return;   // stays hidden: credits do not apply to this studio
    panel.hidden = false;

    if (state.reason === "unreadable") {
      // Show the honest sentence and NOTHING else. A stale or zero figure here is
      // worse than no figure: this is the number a tenant uses to decide whether
      // they can start work.
      const bad = $("#credits-unreadable");
      if (bad) bad.hidden = false;
      return;
    }

    const figures = $("#credits-figures");
    if (figures) figures.hidden = false;
    const avail = $("#credits-available");
    if (avail) avail.textContent = creditChecks.formatUsd(payload.available_micro_usd) || "";

    // Held is shown only when there IS something held. A permanent "USD 0.00
    // reserved" line is noise that trains people to stop reading the panel.
    if (payload.held_micro_usd > 0) {
      const row = $("#credits-held-row");
      const held = $("#credits-held");
      if (held) held.textContent = creditChecks.formatUsd(payload.held_micro_usd) || "";
      if (row) row.hidden = false;
    }

    // Counting mode is stated, not hidden. A tenant whose balance is never
    // enforced should not be left to infer that from nothing being refused.
    if (payload.enforcing === false) {
      const counting = $("#credits-counting");
      if (counting) counting.hidden = false;
    }

    const topUp = creditChecks.topUpState(payload);
    if (topUp === "not_open_yet") {
      const closed = $("#credits-topup-closed");
      if (closed) closed.hidden = false;
    } else if (topUp === "available") {
      const open = $("#credits-topup-open");
      if (open) open.hidden = false;
    }

    const lines = creditChecks.projectActivity(payload);
    if (lines.length) {
      const list = $("#credits-activity");
      if (list) {
        lines.forEach(function (line) {
          const li = document.createElement("li");
          li.className = "row";
          const name = document.createElement("span");
          name.className = "row-name";
          name.textContent = line.label;
          li.appendChild(name);
          if (line.amount) {
            const amt = document.createElement("span");
            amt.className = "small";
            amt.textContent = line.amount;
            li.appendChild(amt);
          }
          // The no-charge reason is the completed-only policy made legible on the
          // tenant's OWN job. Dropping it turns "Not charged" into something that
          // reads as a bug rather than as the thing we promised.
          if (line.note) {
            const note = document.createElement("span");
            note.className = "small muted";
            note.textContent = line.note;
            li.appendChild(note);
          }
          list.appendChild(li);
        });
        list.hidden = false;
      }
    }

    if (payload.activity_truncated === true) {
      const more = $("#credits-activity-more");
      if (more) more.hidden = false;
    }
  }

  function show(route) {
    document.querySelectorAll("[data-shell]").forEach(function (el) {
      el.hidden = el.dataset.shell !== route;
    });
  }

  // THE SIGNUP SWITCH CHANGES THE COPY, NOT THE DOOR (cp#428).
  //
  // Both variants ship in index.html and this only picks one, for the same reason the rest of
  // this page keeps its words in the markup: copy gets reviewed as copy. What it must never do
  // is remove the sign-in form, which is what routing a closed signup to its own panel did.
  function applySignedOutCopy(open) {
    [
      ["#auth-title-open", "#auth-title-closed"],
      ["#auth-lede-open", "#auth-lede-closed"],
      ["#auth-open-note", "#auth-closed-note"],
    ].forEach(function (pair) {
      const openEl = $(pair[0]);
      const closedEl = $(pair[1]);
      if (openEl) openEl.hidden = !open;
      if (closedEl) closedEl.hidden = open;
    });
  }

  // Auth buttons are rendered FROM config.auth_methods. Adding a provider on
  // the backend grows a button here with no change to this file; Apple appears
  // the day its credentials are staged. The registry-projection ethos, applied
  // to auth.
  function renderAuthMethods(methods) {
    const el = $("#auth-methods");
    if (!el) return;
    el.innerHTML = "";
    const ordered = checks.orderMethods(methods);

    if (!ordered.length) {
      // Do not render a dead form: if nothing is configured, say so.
      el.innerHTML = '<p class="muted small">No sign-in method is available right now. This is our problem, not yours.</p>';
      return;
    }

    ordered.forEach(function (method) {
      if (method === "email") {
        const row = document.createElement("div");
        row.className = "row";
        const label = document.createElement("label");
        label.setAttribute("for", "email");
        label.textContent = "Your email address";
        row.appendChild(label);

        const fieldRow = document.createElement("div");
        fieldRow.className = "field-row";
        const input = document.createElement("input");
        input.type = "email";
        input.id = "email";
        input.autocomplete = "email";
        input.placeholder = "you@example.com";
        fieldRow.appendChild(input);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "primary";
        btn.id = "email-send";
        btn.textContent = checks.methodLabel("email");
        fieldRow.appendChild(btn);
        row.appendChild(fieldRow);

        const note = document.createElement("p");
        note.className = "row-why";
        note.textContent = "No password to forget. We email you a link that signs you in.";
        row.appendChild(note);
        el.appendChild(row);

        btn.addEventListener("click", function () { sendLink(input.value, btn); });
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") sendLink(input.value, btn);
        });
        return;
      }

      const row = document.createElement("div");
      row.className = "row";
      const a = document.createElement("a");
      a.className = "row-name";
      a.href = API_BASE + "/auth/" + encodeURIComponent(method) + "/start";
      a.textContent = checks.methodLabel(method);
      row.appendChild(a);
      el.appendChild(row);
    });
  }

  async function sendLink(value, btn) {
    const email = (value || "").trim();
    if (!email) return;
    if (btn) btn.disabled = true;
    try {
      await Api.emailStart(email);
    } catch (err) {
      // The route answers 202 for every outcome by design (no account
      // enumeration). A thrown error here is a transport problem, and the
      // honest move is still not to reveal anything about the address.
    }
    if (btn) btn.disabled = false;
    // ALWAYS the same screen, whatever happened. This page must not become an
    // oracle for "does this person have an account".
    show("link-sent");
  }

  function renderAuthError() {
    const params = new URLSearchParams(window.location.search);
    const copy = checks.authErrorCopy(params.get("error"));
    if (!copy) return;
    const box = $("#auth-error");
    const text = $("#auth-error-text");
    if (box && text) {
      text.textContent = copy;
      box.hidden = false;
    }
  }

  async function boot() {
    if (!checks) return;
    renderAuthError();

    let config = {};
    let me = null;
    try {
      config = (await Api.config()) || {};
      me = await Api.me();
    } catch (err) {
      // A front door that cannot reach its control plane must look broken, not
      // cheerfully signed-out.
      show("unknown");
      const detail = $("#unknown-detail");
      if (detail) {
        detail.textContent = "We could not reach the studio control plane: " + err.message +
          ". This is our problem, not yours. Please try again in a minute.";
      }
      // Keep the watch armed so a transient plane outage does not freeze
      // a building tenant on the error panel.
      startWatch();
      return;
    }

    const route = checks.shellRoute(me);

    if (me && me.account) {
      const email = $("#account-email");
      if (email) email.textContent = me.account.email;
      const out = $("#logout");
      if (out) out.hidden = false;
    }

    if (route === "auth") {
      // The switch decides what this screen SAYS. It never decides whether it has a
      // way in: an account that already exists must be able to sign in with signups
      // closed, which is what the plane has done all along (cp#428).
      applySignedOutCopy(checks.signupsOpen(config));
      renderAuthMethods(config.auth_methods);
    }

    if (route === "studio" && me.tenant && me.tenant.url) {
      const link = $("#studio-link");
      if (link) {
        link.href = me.tenant.url;
        link.textContent = "Open " + me.tenant.url.replace(/^https:\/\//, "");
      }
    }

    // cf#94: the programmatic-token panel is mounted ONLY here, on the route the
    // control plane already told us means a live studio. Gating it on the route
    // rather than on its own status check keeps ONE rule about what "live" means:
    // a second opinion in the panel is how two surfaces start disagreeing.
    if (route === "studio" && me.tenant && window.tenantApiToken) {
      window.tenantApiToken.mount(me.tenant);
    }

    // Fire-and-forget: the credit panel is additive, and a slow or failing balance
    // read must not delay or break the studio link, which is what this page is FOR.
    if (route === "studio" && me.tenant && creditChecks) {
      mountCredits(me.tenant);
    }

    if (route === "suspended" && me.tenant) {
      const el = $("#suspended-reason");
      if (el && me.tenant.suspended_reason) {
        el.textContent = "Your studio is not serving right now: " + me.tenant.suspended_reason;
      }
    }

    if (route === "unknown" && me && me.tenant) {
      const el = $("#unknown-detail");
      if (el) {
        el.textContent = "Your studio reports status \"" + me.tenant.status +
          "\", which we do not recognize, so we are not going to guess what it means. " +
          "Please tell us about this rather than retrying.";
      }
    }

    show(route);
    // cp#432: a frozen building panel used to tell you to leave, which
    // removed the only driver the owner was looking at. Re-check /api/me
    // while the tenant is in flight (or failed, so a retry becomes visible).
    if (checks.shouldWatch(route)) startWatch();
    else stopWatch();
  }

  function stopWatch() {
    if (watchTimer !== null) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  }

  function startWatch() {
    if (watchTimer !== null) return;
    watchTimer = setInterval(function () { boot(); }, WATCH_MS);
  }

  function wire() {
    const out = $("#logout");
    if (out) {
      out.addEventListener("click", async function () {
        try { await Api.logout(); } catch (err) { /* falls through to reload */ }
        window.location.href = "/";
      });
    }
    const again = $("#link-again");
    if (again) again.addEventListener("click", function () { boot(); });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && watchTimer !== null) boot();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { wire(); boot(); });
  } else {
    wire();
    boot();
  }
})();
