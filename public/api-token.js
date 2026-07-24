// The tenant programmatic-access token panel (cf#94). Vanilla JS, classic
// <script>, no framework, no build step, same idiom as front-door.js.
//
// Mounted by front-door.js ONLY on the "studio" shell route, i.e. only for a
// tenant the control plane just told us is live. That is deliberate: the panel
// never renders a Create button next to a studio that cannot serve the token,
// which is the local#201 "advertise a button that throws" class.
//
// Contract (COMMITTED by Rollins, sprint cf#215; custody ruled SEPARATE):
//   GET    /api/tenant/{id}/api-token -> { configured, name, created_at, last_rotated_at }
//   POST   /api/tenant/{id}/api-token -> { token, name, created_at }   <- plaintext, ONCE
//   DELETE /api/tenant/{id}/api-token -> { configured: false }
//
// There is no masked `display` field and there never will be: the studio stores
// only the SHA-256 hash of a token (migrations/0009_api_tokens.sql), so there is
// no copy to partially reveal. Reveal-once is a property of the SYSTEM here, not a
// promise about this file's behaviour.
//
// REVEAL-ONCE, enforced on this side as hard as it is on the backend:
//   - the plaintext lives in ONE parameter inside showReveal() and in the DOM node
//     it writes; it is never assigned to a module-scope variable, never put in
//     localStorage / sessionStorage / a cookie / the URL, and never console.logged;
//   - any other action, and the "hide this" control, tears it out of the DOM, so
//     the value cannot be recovered by reopening a panel;
//   - the refresh path (GET) can never show it: the backend does not have it to
//     return, and this file has no code path that would render it if it did.
(function () {
  "use strict";

  const checks = window.apiTokenChecks;
  const API_BASE = window.HOSTED_API_BASE || "";

  let tenantId = null;
  let studioUrl = null;
  let busy = false;
  let wired = false;
  // Read off every payload so the rotate warning tracks what the backend actually
  // reports, rather than what this file assumed when it loaded.
  let currentCustody = null;

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  async function call(method) {
    const r = await fetch(API_BASE + "/api/tenant/" + encodeURIComponent(tenantId) + "/api-token", {
      method: method,
      headers: { accept: "application/json" },
    });
    const body = await r.json().catch(function () {
      return {};
    });
    if (!r.ok) {
      const err = new Error(body.error || "request_failed");
      err.code = body.error || (r.status === 401 ? "unauthorized" : null);
      err.status = r.status;
      throw err;
    }
    return body;
  }

  function setStatus(text, level) {
    const node = $("token-status");
    if (!node) return;
    node.textContent = text || "";
    if (level) node.setAttribute("data-level", level);
    else node.removeAttribute("data-level");
  }

  // Tearing the reveal box down is a security operation, not a cosmetic one:
  // replaceChildren() drops the text node holding the plaintext.
  function clearReveal() {
    const box = $("token-reveal");
    if (!box) return;
    box.replaceChildren();
    box.hidden = true;
  }

  function renderSnippets(payload) {
    const host = $("token-snippets");
    if (!host) return;
    host.replaceChildren();
    const rows = checks.snippets(studioUrl, payload);
    if (!rows.length) return;
    rows.forEach(function (snippet) {
      const wrap = el("div", "row");
      wrap.appendChild(el("div", "row-name", snippet.label));
      wrap.appendChild(el("pre", "token-snippet", snippet.body));
      host.appendChild(wrap);
    });
    host.appendChild(
      el(
        "p",
        "row-why",
        "These examples use a placeholder on purpose. We do not print your token into a command you might paste somewhere public.",
      ),
    );
  }

  // The one place a plaintext token is ever in the DOM. Called only with the body
  // of a POST we just made, and never from the refresh path.
  function showReveal(token) {
    const box = $("token-reveal");
    if (!box) return;
    box.replaceChildren();

    box.appendChild(el("p", "row-name", "Your new token"));

    const field = el("div", "field-row");
    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.id = "token-reveal-value";
    input.value = token;
    input.setAttribute("aria-label", "Your new programmatic token");
    // autocomplete off so a browser password manager does not silently retain it.
    input.autocomplete = "off";
    field.appendChild(input);

    const copy = el("button", "primary", "Copy");
    copy.type = "button";
    copy.addEventListener("click", function () {
      const done = function () {
        copy.textContent = "Copied";
        window.setTimeout(function () {
          copy.textContent = "Copy";
        }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(input.value).then(done, function () {
          input.select();
        });
      } else {
        input.select();
      }
    });
    field.appendChild(copy);
    box.appendChild(field);

    box.appendChild(el("p", "row-why", checks.revealNotice()));

    const hide = el("button", null, "I have saved it, hide this");
    hide.type = "button";
    hide.addEventListener("click", clearReveal);
    const actions = el("div", "actions");
    actions.appendChild(hide);
    box.appendChild(actions);

    box.hidden = false;
  }

  // Destructive actions get an INLINE two-step confirm rather than window.confirm:
  // a modal dialog blocks the page (and anything driving it), and an irreversible
  // action deserves its warning on screen, not in a chrome popup.
  //
  // `warningFor` is a FUNCTION, evaluated at click time: the rotate warning depends
  // on custody, which is not known until the first payload lands. Passing the string
  // in at wire time would freeze the generic warning forever.
  function armConfirm(button, warningFor, run) {
    let armed = false;
    let timer = null;
    const original = button.textContent;
    button.addEventListener("click", function () {
      if (busy) return;
      if (!armed) {
        armed = true;
        button.textContent = "Really " + original.toLowerCase() + "?";
        setStatus(warningFor(), "warn");
        timer = window.setTimeout(function () {
          armed = false;
          button.textContent = original;
          setStatus("");
        }, 15000);
        return;
      }
      if (timer) window.clearTimeout(timer);
      armed = false;
      button.textContent = original;
      run();
    });
  }

  function applyView(view, payload) {
    currentCustody = view.custody;

    const summary = $("token-summary");
    if (summary) {
      if (view.state === "present") {
        summary.textContent = checks.summaryLine(view) || "A programmatic token exists for this studio.";
      } else if (view.state === "absent") {
        summary.textContent =
          "No programmatic token yet. Create one to use your studio from scripts, CI, or an MCP client.";
      } else {
        // The honest unknown. We read something we do not understand, so we say so
        // and offer no mint button.
        summary.textContent =
          "We could not read the token state for this studio, so we are not going to guess. Reload, and tell us if it persists.";
      }
    }

    const create = $("token-create");
    const rotate = $("token-rotate");
    const revokeBtn = $("token-revoke");
    if (create) create.hidden = view.state !== "absent";
    if (rotate) rotate.hidden = view.state !== "present";
    if (revokeBtn) revokeBtn.hidden = view.state !== "present";

    renderSnippets(payload);
  }

  function fail(err) {
    const copy = checks.tokenErrorCopy(err && err.code);
    setStatus(copy || "Something went wrong. Nothing was changed.", "bad");
  }

  async function refresh() {
    setStatus("Checking...");
    try {
      const payload = await call("GET");
      applyView(checks.tokenView(payload), payload);
      setStatus("");
    } catch (err) {
      applyView(checks.tokenView(null), null);
      fail(err);
    }
  }

  // Refresh the masked summary WITHOUT wiping the reveal box the person is still
  // reading from, and without letting a failed re-poll clear it either.
  async function refreshQuietly() {
    try {
      const payload = await call("GET");
      applyView(checks.tokenView(payload), payload);
    } catch (err) {
      /* the reveal box is the important thing on screen; leave it alone */
    }
  }

  async function mint(action) {
    if (busy) return;
    busy = true;
    clearReveal();
    setStatus(action === "rotate" ? "Rotating..." : "Creating...");
    try {
      const body = await call("POST");
      if (body && typeof body.token === "string" && body.token) {
        // Handed straight to the DOM writer; never stored in this closure.
        showReveal(body.token);
        setStatus("");
      } else {
        // A mint that did not return a token is a contract violation, not a
        // success to paper over.
        setStatus(
          "The control plane accepted that but did not return a token. There is nothing to show you, and we are not pretending otherwise. Please tell us about this.",
          "bad",
        );
      }
      await refreshQuietly();
    } catch (err) {
      fail(err);
    }
    busy = false;
  }

  async function revoke() {
    if (busy) return;
    busy = true;
    clearReveal();
    setStatus("Revoking...");
    try {
      await call("DELETE");
      await refresh();
      setStatus("Token revoked. Anything using it has stopped working.", "ok");
    } catch (err) {
      fail(err);
    }
    busy = false;
  }

  function wire() {
    if (wired) return;
    wired = true;
    const create = $("token-create");
    const rotate = $("token-rotate");
    const revokeBtn = $("token-revoke");
    if (create) {
      create.addEventListener("click", function () {
        mint("create");
      });
    }
    if (rotate) {
      armConfirm(
        rotate,
        function () {
          return checks.rotateWarning(currentCustody);
        },
        function () {
          mint("rotate");
        },
      );
    }
    if (revokeBtn) {
      armConfirm(revokeBtn, checks.revokeWarning, revoke);
    }
  }

  function mount(tenant) {
    if (!checks) return;
    const section = $("token-section");
    if (!section || !tenant || !tenant.id) return;
    tenantId = tenant.id;
    studioUrl = tenant.url || null;
    section.hidden = false;
    wire();
    refresh();
  }

  window.tenantApiToken = { mount: mount };
})();
