// The operator console (cp#89). Vanilla JS, classic script, no framework and no build step.
//
// THE BROWSER THREAT MODEL, settled rather than assumed, because cp#89 asks for exactly this.
//
// An operator presenting a credential in a browser is a different problem from presenting one on a
// command line: the page is a program that runs in the same context as the secret. Three custody
// options were on the table.
//
//   (a) localStorage / sessionStorage. Survives the tab, lands in the browser profile (and therefore
//       in any profile backup or sync), and is readable by any script that ever runs on this origin.
//       Rejected: a credential at rest in a browser profile is a credential we did not choose to
//       store.
//   (b) Exchange the credential for an HttpOnly cookie session. Strongest against exfiltration by a
//       script, and it buys a CSRF problem on every state-changing admin route plus a second session
//       lifecycle (issue, expire, revoke) layered on the credential lifecycle cp#219 just built.
//       Rejected as more machinery and more attack surface than the surface warrants.
//   (c) MEMORY ONLY. The credential lives in the closure variable below, is sent as a bearer header,
//       and dies with the tab. CHOSEN.
//
// What (c) buys, stated precisely so nobody over-reads it:
//   - Nothing is at rest. A reload asks again, which is correct for a console meant to be opened on
//     a report rather than left open.
//   - There is NO ambient credential, so there is no CSRF surface at all: a cross-site request
//     carries no cookie and cannot set an Authorization header, which means every state-changing
//     route here is unreachable from another origin by construction rather than by a token check.
//   - The credential never enters the DOM after submit, never enters a URL (so it cannot land in an
//     access log, a Referer, or a shared link), and never enters history.
//
// WHAT (c) DOES NOT BUY, and this is the residual risk, recorded rather than hidden: a script
// injected into this origin can read the variable while the page is open. Three things bound that,
// none of which is a claim it is impossible:
//   - The page is served with a strict CSP (default-src 'none', script-src 'self', connect-src
//     'self'), set on the response in src/index.ts, so an injected inline script does not execute
//     and an injected fetch cannot reach a third-party origin.
//   - Nothing here writes server data into the DOM as HTML. Every insertion is textContent.
//   - The window is bounded by an IDLE LOCK: the credential is zeroed after inactivity, so the
//     exposure is "while an operator is working", not "while a tab is open".
//
// PROJECTION: every section renders from GET /api/admin/whoami (the caller's scopes plus the whole
// catalogue the backend declares). Nothing here carries its own list of scopes or its own rule about
// which credential may do what. A scope added in src/operator-auth.ts shows up here with no change
// to this file.
(function () {
  "use strict";

  const checks = window.adminChecks;

  // THE CREDENTIAL. Module scope, never a property of anything reachable, never persisted. Cleared
  // by lock(), by the idle timer, and by any 401 from the server.
  let credential = null;
  let whoami = null;
  let idleTimer = null;

  // Fifteen minutes. Long enough to work an incident without re-entering, short enough that a
  // walked-away-from tab is not a live credential for the rest of the afternoon.
  const IDLE_MS = 15 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const screens = {};
  document.querySelectorAll("[data-screen]").forEach((el) => {
    screens[el.getAttribute("data-screen")] = el;
  });

  function show(name, on) {
    if (screens[name]) screens[name].hidden = !on;
  }

  function banner(text) {
    $("banner-text").textContent = text || "";
    $("banner").hidden = !text;
  }

  function hint(id, level, text) {
    const el = $(id);
    el.setAttribute("data-level", level || "");
    el.textContent = text || "";
  }

  /** Remove every child. Used instead of innerHTML = "" so the same rule holds everywhere: this file
   *  never assigns HTML, only nodes and text. */
  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  // ---- the one place a credential is used ------------------------------------------------------

  async function api(path, options) {
    if (!credential) throw new Error("locked");
    const opts = options || {};
    const headers = { authorization: "Bearer " + credential };
    if (opts.body != null) headers["content-type"] = "application/json";
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body == null ? undefined : JSON.stringify(opts.body),
      // No cookies on any admin call, ever. This console authenticates with a bearer and nothing
      // else; sending the tenant session cookie alongside would be a second, ambient credential on
      // a surface whose whole custody argument is that it has none.
      credentials: "omit",
      cache: "no-store",
    });
    let body = null;
    if (res.status !== 204) {
      try {
        body = await res.json();
      } catch (e) {
        body = null;
      }
    }
    if (res.status === 401) {
      // The credential is dead (revoked, expired, or wrong). Drop it rather than letting the page
      // keep retrying with something the server has already refused.
      lock("That credential was refused. It may have been revoked or expired.");
      throw new Error("unauthorized");
    }
    if (!res.ok) {
      const e = new Error(checks.errorCopy(body, res.status));
      e.body = body;
      e.status = res.status;
      throw e;
    }
    touchIdle();
    return body;
  }

  // ---- lock / unlock ---------------------------------------------------------------------------

  function touchIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      lock("Locked after 15 minutes of inactivity. Present the credential again to continue.");
    }, IDLE_MS);
  }

  function lock(message) {
    credential = null;
    whoami = null;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    ["identity", "tenants", "audit", "credentials", "settings", "breakGlassNotice"].forEach((s) => show(s, false));
    show("locked", true);
    $("lock").hidden = true;
    $("principal").textContent = "";
    $("credential").value = "";
    hint("credential-hint", "", "");
    banner(message || "");
  }

  async function unlock(token) {
    credential = token;
    let me;
    try {
      me = await api("/api/admin/whoami");
    } catch (e) {
      // api() already locked on a 401; anything else is worth saying out loud.
      if (e.message !== "unauthorized") {
        credential = null;
        banner(e.message);
      }
      return;
    }
    whoami = me;
    banner("");
    show("locked", false);
    $("lock").hidden = false;
    $("principal").textContent = checks.principalLabel(whoami);
    renderIdentity();

    const sections = checks.sectionsFor(whoami);
    show("identity", sections.identity);
    show("breakGlassNotice", sections.breakGlassNotice);
    show("tenants", sections.tenants);
    show("audit", sections.audit);
    show("credentials", sections.credentials);
    show("settings", sections.settings);

    // Only the sections actually shown are LOADED. This is the enforcement, not the hiding: a
    // console that hid the tenant panel but still fetched the tenant list on the root credential
    // would have written an access it declined to display.
    if (sections.tenants) await loadTenants();
    if (sections.audit) await loadAudit();
    if (sections.credentials) { renderMintScopes(); await loadCredentials(); }
    if (sections.settings) await loadSettings();
    touchIdle();
  }

  // ---- identity --------------------------------------------------------------------------------

  function renderIdentity() {
    $("identity-line").textContent = checks.principalLabel(whoami);
    const list = $("scope-list");
    clear(list);
    checks.scopeRows(whoami).forEach(function (row) {
      const li = el("li");
      li.setAttribute("data-held", row.held ? "true" : "false");
      li.appendChild(el("span", "scope-id", row.id));
      li.appendChild(el("span", "scope-held", row.held ? "held" : "not held"));
      li.appendChild(el("span", "scope-summary", row.summary));
      list.appendChild(li);
    });
  }

  // ---- tenants ---------------------------------------------------------------------------------

  async function loadTenants() {
    const q = $("tenant-q").value.trim();
    let body;
    try {
      body = await api("/api/admin/tenants" + (q ? "?q=" + encodeURIComponent(q) : ""));
    } catch (e) {
      banner(e.message);
      return;
    }
    const rows = $("tenant-rows");
    clear(rows);
    const tenants = (body && body.tenants) || [];
    $("tenant-empty").hidden = tenants.length > 0;
    const actions = checks.tenantActions(whoami);
    tenants.forEach(function (t) {
      const row = el("div", "row");
      const head = el("div", "row-head");
      head.appendChild(el("span", "row-name", t.slug || t.id));
      head.appendChild(el("span", "row-meta", t.status || ""));
      head.appendChild(el("span", "row-meta", t.id));
      row.appendChild(head);

      const bar = el("div", "actions");
      actions.forEach(function (a) {
        const b = el("button", null, a.label);
        b.type = "button";
        b.addEventListener("click", function () {
          runTenantAction(a, t, row);
        });
        bar.appendChild(b);
      });
      row.appendChild(bar);

      const out = el("p", "row-why");
      out.hidden = true;
      row.appendChild(out);
      rows.appendChild(row);
    });
  }

  async function runTenantAction(action, tenant, row) {
    const out = row.querySelector(".row-why");
    out.hidden = false;
    out.textContent = "Working...";
    try {
      if (action.id === "credits") {
        const body = await api(checks.actionPath(action, tenant.id));
        out.textContent = "balance " + JSON.stringify((body && body.balance) || body);
        return;
      }
      if (action.id === "audit") {
        $("audit-target").value = tenant.id;
        await loadAudit();
        out.textContent = "Audit trail filtered to this tenant.";
        return;
      }
      if (action.needsReason) {
        // A reason is REQUIRED by the route, and it lands in the audit row. Asking for it here means
        // the operator writes it once, deliberately, rather than discovering the 400 afterwards.
        const reason = window.prompt("Reason (recorded in the audit trail, against your credential):");
        if (!reason) {
          out.textContent = "Cancelled; nothing was sent.";
          return;
        }
        await api(checks.actionPath(action, tenant.id), { method: action.method, body: { reason: reason } });
      } else {
        await api(checks.actionPath(action, tenant.id), { method: action.method, body: {} });
      }
      out.textContent = action.label + " done, and recorded against " + whoami.actor + ".";
      await loadAudit();
    } catch (e) {
      out.textContent = e.message;
    }
  }

  // ---- audit -----------------------------------------------------------------------------------

  async function loadAudit() {
    const target = $("audit-target").value.trim();
    let body;
    try {
      body = await api("/api/admin/audit?limit=50" + (target ? "&target=" + encodeURIComponent(target) : ""));
    } catch (e) {
      banner(e.message);
      return;
    }
    const rows = $("audit-rows");
    clear(rows);
    const list = (body && body.audit) || [];
    $("audit-empty").hidden = list.length > 0;
    list.forEach(function (raw) {
      const v = checks.auditRow(raw);
      const row = el("div", "row");
      const head = el("div", "row-head");
      head.appendChild(el("span", "row-name", v.what));
      head.appendChild(el("span", "row-meta", v.who));
      head.appendChild(el("span", "row-meta", v.when));
      if (v.target) head.appendChild(el("span", "row-meta", v.target));
      if (v.isTenantRead) head.appendChild(el("span", "pill pill-read", "read"));
      if (!v.attributed) head.appendChild(el("span", "pill pill-unattributed", "unattributed"));
      row.appendChild(head);
      if (v.detail) row.appendChild(el("span", "audit-detail", v.detail));
      rows.appendChild(row);
    });
  }

  // ---- credentials (root only) -----------------------------------------------------------------

  function renderMintScopes() {
    const box = $("mint-scopes");
    clear(box);
    // Rendered from the catalogue the SERVER declares, so this form can never offer a scope the gate
    // does not know, nor miss one it does.
    checks.scopeRows(whoami).forEach(function (row) {
      const wrap = el("div", "checkbox-row");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = row.id;
      input.id = "scope-" + row.id.replace(/[^a-z0-9]/g, "-");
      input.setAttribute("data-scope", row.id);
      const label = el("label", null, row.id + " -- " + row.summary);
      label.setAttribute("for", input.id);
      wrap.appendChild(input);
      wrap.appendChild(label);
      box.appendChild(wrap);
    });
  }

  async function loadCredentials() {
    let body;
    try {
      body = await api("/api/admin/operators");
    } catch (e) {
      banner(e.message);
      return;
    }
    const rows = $("credential-rows");
    clear(rows);
    const now = new Date().toISOString();
    ((body && body.credentials) || []).forEach(function (c) {
      const state = checks.credentialState(c, now);
      const row = el("div", "row");
      const head = el("div", "row-head");
      head.appendChild(el("span", "row-name", c.name));
      head.appendChild(el("span", "pill pill-" + state, state));
      head.appendChild(el("span", "row-meta", c.id));
      head.appendChild(el("span", "row-meta", "last used " + (c.last_used_at || "never")));
      row.appendChild(head);
      row.appendChild(el("p", "row-why", (c.scopes || []).join("  ")));
      if (state === "live") {
        const bar = el("div", "actions");
        const b = el("button", null, "Revoke");
        b.type = "button";
        b.addEventListener("click", async function () {
          if (!window.confirm("Revoke " + c.name + "? It stops working on the next request.")) return;
          try {
            await api("/api/admin/operators/" + c.id + "/revoke", { method: "POST", body: {} });
            await loadCredentials();
            await loadAudit();
          } catch (e) {
            banner(e.message);
          }
        });
        bar.appendChild(b);
        row.appendChild(bar);
      }
      rows.appendChild(row);
    });
  }

  async function mint(event) {
    event.preventDefault();
    const scopes = [];
    $("mint-scopes").querySelectorAll("input[type=checkbox]").forEach(function (cb) {
      if (cb.checked) scopes.push(cb.getAttribute("data-scope"));
    });
    const built = checks.mintPayload($("mint-name").value, scopes, $("mint-expiry").value);
    if (!built.ok) {
      hint("mint-hint", "bad", built.message);
      return;
    }
    hint("mint-hint", "", "Minting...");
    let body;
    try {
      body = await api("/api/admin/operators", { method: "POST", body: built.payload });
    } catch (e) {
      // The SERVER's refusal, verbatim. It knows more than the client-side pre-check does, and
      // paraphrasing it here is how a UI ends up explaining a rule that has since changed.
      hint("mint-hint", "bad", e.message);
      return;
    }
    hint("mint-hint", "ok", "Minted " + body.name + ".");
    // The one moment this value exists. It is placed as TEXT, never as HTML, and cleared by the
    // dismiss button; it is not stored, not logged, and not re-fetchable.
    $("minted-token").textContent = body.token;
    $("minted").hidden = false;
    $("mint-name").value = "";
    $("mint-expiry").value = "";
    $("mint-scopes").querySelectorAll("input[type=checkbox]").forEach(function (cb) { cb.checked = false; });
    await loadCredentials();
    await loadAudit();
  }

  // ---- settings --------------------------------------------------------------------------------

  async function loadSettings() {
    try {
      const body = await api("/api/admin/settings");
      $("signups").checked = !!(body && body.signups_enabled);
      hint("settings-hint", "", "");
    } catch (e) {
      hint("settings-hint", "bad", e.message);
    }
  }

  async function saveSettings() {
    try {
      await api("/api/admin/settings", { method: "POST", body: { signups_enabled: $("signups").checked } });
      hint("settings-hint", "ok", "Saved, and recorded against " + whoami.actor + ".");
      await loadAudit();
    } catch (e) {
      hint("settings-hint", "bad", e.message);
      await loadSettings();
    }
  }

  // ---- wiring ----------------------------------------------------------------------------------

  $("unlock-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    const input = $("credential");
    const token = input.value.trim();
    if (!token) return;
    // The value leaves the DOM immediately: from here it exists only in the closure variable, so a
    // later screenshot, an inspector, or a form autofill has nothing to find.
    input.value = "";
    await unlock(token);
  });

  $("credential").addEventListener("input", function () {
    const h = checks.tokenShapeHint($("credential").value.trim());
    hint("credential-hint", h.level, h.text);
  });

  $("lock").addEventListener("click", function () {
    lock("Locked.");
  });
  $("tenant-refresh").addEventListener("click", loadTenants);
  $("audit-refresh").addEventListener("click", loadAudit);
  $("mint-form").addEventListener("submit", mint);
  $("minted-dismiss").addEventListener("click", function () {
    $("minted-token").textContent = "";
    $("minted").hidden = true;
  });
  $("signups").addEventListener("change", saveSettings);

  // Any keystroke or click counts as activity, so the idle lock measures inactivity rather than
  // elapsed time. Registered once, passive, and only while unlocked (touchIdle is a no-op otherwise
  // because lock() clears the timer).
  ["keydown", "click"].forEach(function (evt) {
    document.addEventListener(evt, function () {
      if (credential) touchIdle();
    }, { passive: true });
  });

  lock("");
})();
