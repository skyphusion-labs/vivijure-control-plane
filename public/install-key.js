// The owner-completed invoke-key page (cp#169). DOM wiring only.
//
// Every decision this file makes is delegated: the LINK decisions to handoff-checks.js, and every
// decision about the KEY to onboarding-checks.js -- the same keyShapeHint and invokeKeyVerdict the
// signup flow runs against the same install route. That is deliberate and is the point: a second
// copy of the verdict logic would drift from the signup copy the first time either was corrected,
// and the sentence a customer reads about their own credential is not a good place to discover that.
//
// The token is read from the URL for the CONTEXT read (it arrives that way) and sent in the BODY on
// the install, so a credential-bearing request never puts the authorization in a query string.
(function () {
  "use strict";

  const checks = window.onboardingChecks;
  const link = window.handoffChecks;
  const $ = (sel) => document.querySelector(sel);
  const TONE_CLASS = { good: "", warn: " callout-warn", pending: " callout-warn", bad: " callout-bad" };

  let token = "";
  let context = null;

  function textP(text) {
    const p = document.createElement("p");
    p.textContent = text;
    return p;
  }

  function showLinkFailure(code, message) {
    const el = $("#link-bad-message");
    if (el) el.textContent = link.linkErrorCopy(code, message);
    if ($("#link-bad")) $("#link-bad").hidden = false;
    if ($("#loading")) $("#loading").hidden = true;
    if ($("#main-panel")) $("#main-panel").hidden = true;
  }

  async function readJson(res) {
    try {
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  function renderEndpoints(payload) {
    const el = $("#endpoints");
    if (!el) return;
    el.innerHTML = "";
    const rows = link.endpointRows(payload);
    if (!rows.length) {
      // Not a cosmetic empty state: with no endpoints named there is nothing to scope a key to, and
      // saying so is better than an empty box above a paste field that cannot succeed.
      el.innerHTML = '<p class="muted small">We could not list your endpoints. Ask for a new link.</p>';
      return;
    }
    rows.forEach(function (ep) {
      const row = document.createElement("div");
      row.className = "row";
      const head = document.createElement("div");
      head.className = "row-head";
      const name = document.createElement("span");
      name.className = "row-name";
      name.textContent = ep.name || ep.label || ep.id;
      head.appendChild(name);
      const meta = document.createElement("span");
      meta.className = "row-meta";
      meta.textContent = "Read/Write";
      head.appendChild(meta);
      row.appendChild(head);
      const id = document.createElement("p");
      id.className = "row-why";
      id.textContent = "id: " + ep.id;
      row.appendChild(id);
      el.appendChild(row);
    });
  }

  async function loadContext() {
    token = link.tokenFromSearch(window.location.search);
    if (!token) return showLinkFailure("handoff_unknown", null);

    let res;
    try {
      res = await fetch("/api/handoff/invoke-key?" + link.TOKEN_PARAM + "=" + encodeURIComponent(token), {
        headers: { accept: "application/json" },
      });
    } catch (e) {
      // A transport failure is not a dead link, and saying "this link is not valid" here would send
      // someone back to their operator over a dropped connection.
      return showLinkFailure(null, "We could not reach the studio service just now. Try again shortly.");
    }
    const body = await readJson(res);
    if (!res.ok) return showLinkFailure(body && body.error, body && body.message);

    context = body || {};
    if ($("#slug-name")) $("#slug-name").textContent = context.slug || "your studio";
    if ($("#expiry-note")) $("#expiry-note").textContent = link.expiryNote(context.expires_at);
    renderEndpoints(context);
    if ($("#loading")) $("#loading").hidden = true;
    if ($("#main-panel")) $("#main-panel").hidden = false;
  }

  function paintVerdict(verdict) {
    const el = $("#invoke-verdict");
    if (!el) return;
    el.innerHTML = "";
    const callout = document.createElement("div");
    callout.className = "callout" + TONE_CLASS[verdict.tone];
    callout.appendChild(textP(verdict.message));
    (verdict.notes || []).forEach(function (n) { callout.appendChild(textP(n)); });
    (verdict.failures || []).forEach(function (f) {
      if (f !== verdict.message) callout.appendChild(textP(f));
    });
    el.appendChild(callout);
  }

  function goLive(verdict) {
    if ($("#main-panel")) $("#main-panel").hidden = true;
    if ($("#done-panel")) $("#done-panel").hidden = false;
    if ($("#done-message")) $("#done-message").textContent = verdict.message;
    const a = $("#studio-link");
    // The studio host is derived from the slug and THIS page's own host, which is the same
    // derivation the plane uses for a tenant domain. Nothing is hardcoded, so a differently-hosted
    // plane sends its owners to its own studios.
    if (a && context && context.slug) {
      a.href = "https://" + context.slug + "." + window.location.host;
      a.textContent = "Open " + context.slug;
    }
  }

  async function submitKey() {
    const input = $("#invoke-key");
    const key = input ? input.value.trim() : "";
    if (!key) return;
    const el = $("#invoke-verdict");
    if (el) el.innerHTML = '<p class="small muted">Checking that key against your endpoints...</p>';

    let verdict;
    try {
      const res = await fetch("/api/handoff/invoke-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token, runpod_invoke_key: key }),
      });
      const body = await readJson(res);
      // A LINK-level refusal is not a key verdict, and must not be painted as one: telling someone
      // their key was rejected when the link expired sends them to re-make a key that was fine.
      if (body && body.error && Object.prototype.hasOwnProperty.call(link.LINK_ERRORS, body.error)) {
        return showLinkFailure(body.error, body.message);
      }
      verdict = checks.invokeKeyVerdict(res.status, body);
    } catch (e) {
      verdict = {
        ok: false, tone: "bad", live: false, pending: false, keyStored: false,
        // A transport failure says NOTHING about whether the key was stored, so the field is kept:
        // clearing it here would invite a re-paste on a guess.
        clearKey: false, message: e.message, notes: [], failures: [e.message],
      };
    }

    if (verdict.clearKey && input) input.value = "";
    if (verdict.live === true) return goLive(verdict);
    paintVerdict(verdict);
  }

  function wire() {
    const input = $("#invoke-key");
    const hint = $("#invoke-hint");
    if (input) {
      input.addEventListener("input", function () {
        const shape = checks.keyShapeHint(input.value.trim());
        if (hint) {
          hint.textContent = shape.message;
          hint.dataset.level = shape.level === "empty" ? "" : shape.level;
        }
      });
    }
    const reveal = $("#invoke-reveal");
    if (reveal && input) {
      reveal.addEventListener("click", function () {
        const showing = input.type === "text";
        input.type = showing ? "password" : "text";
        reveal.setAttribute("aria-pressed", showing ? "false" : "true");
        reveal.textContent = showing ? "Show" : "Hide";
      });
    }
    const submit = $("#invoke-submit");
    if (submit) submit.addEventListener("click", submitKey);
  }

  document.addEventListener("DOMContentLoaded", function () {
    wire();
    loadContext();
  });
})();
