// The hosted front door (#52 UI). Vanilla JS, no framework, no build step.
//
// Built against Rollins' control plane as IMPLEMENTED in PR #67
// (src/control-plane/index.ts), not against the design comment: where the two
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
  const API_BASE = window.HOSTED_API_BASE || "";
  const $ = function (sel) { return document.querySelector(sel); };

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
  };

  function show(route) {
    document.querySelectorAll("[data-shell]").forEach(function (el) {
      el.hidden = el.dataset.shell !== route;
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
      return;
    }

    const route = checks.shellRoute(me, config);

    if (me && me.account) {
      const email = $("#account-email");
      if (email) email.textContent = me.account.email;
      const out = $("#logout");
      if (out) out.hidden = false;
    }

    if (route === "auth") renderAuthMethods(config.auth_methods);

    if (route === "studio" && me.tenant && me.tenant.url) {
      const link = $("#studio-link");
      if (link) {
        link.href = me.tenant.url;
        link.textContent = "Open " + me.tenant.url.replace(/^https:\/\//, "");
      }
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { wire(); boot(); });
  } else {
    wire();
    boot();
  }
})();
