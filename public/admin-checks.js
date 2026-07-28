// Pure helpers for the operator console (cp#89). No DOM, no fetch, no token.
//
// Same UMD-ish shape as onboarding-checks.js / front-door-checks.js: unit-tested under plain Node
// (tests/admin-checks.test.ts) and loaded as a classic <script> in the browser as
// `window.adminChecks`. No framework, no build step, deliberately.
//
// THE PRINCIPLE THIS FILE EXISTS TO HOLD: the console is a PROJECTION of what the backend declares.
// Nothing here carries a list of scopes, a list of actions, or a rule about which credential may do
// what. All of that arrives in GET /api/admin/whoami (the caller's scopes plus the whole scope
// catalogue) and these functions only rearrange it. A scope added to src/operator-auth.ts appears in
// this UI with zero frontend change, exactly like the planner grows a section when a module is bound.
//
// CREDENTIAL HYGIENE: the operator's token NEVER reaches this file. Every function here takes
// already-fetched JSON. The one function that touches a credential at all is tokenShapeHint, which
// inspects only the LENGTH and the character class, and returns a sentence, never the value.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.adminChecks = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // ---- the projection ------------------------------------------------------------------------

  // Every scope the BACKEND declares, each marked held or not. Rendering the whole catalogue rather
  // than only what is held is deliberate: an operator who cannot see what exists cannot ask for the
  // right grant, and "the button is missing" is indistinguishable from "the page is broken".
  function scopeRows(whoami) {
    const held = new Set((whoami && whoami.scopes) || []);
    const catalogue = (whoami && whoami.catalogue) || [];
    return catalogue.map(function (s) {
      return { id: s.id, summary: s.summary, held: held.has(s.id) };
    });
  }

  function canDo(whoami, scope) {
    return !!whoami && Array.isArray(whoami.scopes) && whoami.scopes.indexOf(scope) !== -1;
  }

  function isRoot(whoami) {
    return !!whoami && whoami.kind === "root";
  }

  // Which sections this credential may see AT ALL. A section whose every action would 403 is not
  // rendered: showing an operator a panel that can only refuse them is worse than not showing it,
  // because it reads as a bug rather than as a boundary. The scope list above is where they find out
  // what they are missing.
  //
  // Each section asks the table about the ROUTE it would call, so not one scope id appears in this
  // file. The credentials section is gated on the mint route, which the backend makes root-only; the
  // console must not pretend otherwise, because the backend refuses it to every scoped credential
  // including one holding the entire catalogue.
  //
  // THE BREAK-GLASS RESTRICTION, and it is a POLICY CLAIM MADE TRUE rather than a UI preference.
  // The merged privacy text (PRIVACY-DELTA Section 2.3, AUP 1.0.0 Section 5) says routine support
  // access is made with a NAMED credential, and that the shared root credential exists "for
  // emergencies and for managing operator credentials" and "is not used for routine support". The
  // console is the routine path. So on the root credential it offers credential management and
  // NOTHING else, which turns that sentence from a promise about our habits into a property of the
  // tool we actually reach for.
  //
  // IT IS ENFORCED HERE AND DELIBERATELY NOT IN THE GATE. Refusing the root credential server-side
  // would disarm break-glass at exactly the moment it exists for: an emergency where every named
  // credential is unusable. The API stays open to it, the console does not, and the audit trail
  // shows the difference, which is the honest split.
  function sectionsFor(whoami) {
    const routine = !!whoami && !isRoot(whoami);
    return {
      identity: !!whoami,
      tenants: routine && canCall(whoami, "GET", "/api/admin/tenants"),
      audit: routine && canCall(whoami, "GET", "/api/admin/audit"),
      settings: routine && canCall(whoami, "POST", "/api/admin/settings"),
      credentials: canCall(whoami, "POST", "/api/admin/operators"),
      // Shown to the root credential in place of the sections it is declining to offer, so an
      // operator sees a reason rather than an empty page that reads as a broken console.
      breakGlassNotice: isRoot(whoami),
    };
  }

  // How to name the caller in the header. The root credential names NOBODY, and the console says so
  // rather than leaving a blank where a person should be: that blank IS the gap cp#219 closes, and a
  // UI that hides it would undo the point of the change.
  function principalLabel(whoami) {
    if (!whoami) return "not signed in";
    if (whoami.kind === "root") return "shared root credential (names nobody; every action records admin-token)";
    return whoami.operator + " (named credential " + whoami.credential_id + ")";
  }

  // ---- can this credential call this route? ----------------------------------------------------

  // THE SAME TABLE THE GATE ENFORCES, asked the same way. whoami serves ADMIN_REQUIREMENTS, so this
  // file never carries its own opinion about which route needs which scope. A copy would be a thing
  // that drifts silently: the day a route's requirement changes server-side, a console holding its
  // own map keeps offering a button that now refuses, or hides one that now works.
  //
  // FIRST MATCH WINS and NO MATCH IS A REFUSAL, mirroring the server exactly. Failing closed here
  // matters even though the server is the real gate: a UI that offers an action the server will
  // refuse teaches operators that refusals are noise.
  function requirementFor(whoami, method, path) {
    const table = (whoami && whoami.requirements) || [];
    for (let i = 0; i < table.length; i++) {
      const row = table[i];
      if (row.method !== method) continue;
      let re;
      try {
        re = new RegExp(row.pattern);
      } catch (e) {
        continue;
      }
      if (re.test(path)) return row.requires;
    }
    return null;
  }

  function canCall(whoami, method, path) {
    const required = requirementFor(whoami, method, path);
    if (required === null) return false;
    if (required === "authenticated") return !!whoami;
    if (required === "root") return isRoot(whoami);
    return canDo(whoami, required);
  }

  // ---- per-tenant actions ----------------------------------------------------------------------

  // An id the tenant-scoped patterns accept, used to ask the table what a tenant route requires
  // WITHOUT needing a real tenant in hand. The patterns are shaped `ten_[a-f0-9]+`, so any hex id
  // answers the same question the real one would.
  const PROBE_TENANT = "ten_0";

  // The actions the console offers on a tenant row. Each names the REQUEST it will make; the scope
  // is looked up from the served table rather than written down here. Kept as DATA rather than as
  // markup so the gating is testable without a browser.
  const TENANT_ACTIONS = [
    { id: "suspend", label: "Suspend", method: "POST", path: "/suspend", needsReason: true, danger: true },
    { id: "resume", label: "Resume", method: "POST", path: "/resume", needsReason: false, danger: false },
    { id: "credits", label: "Read credits", method: "GET", path: "/credits", needsReason: false, danger: false },
    // Not a tenant route: this one re-points the audit panel, which reads the trail.
    { id: "audit", label: "Audit trail", method: "GET", path: null, needsReason: false, danger: false },
  ];

  function actionPath(action, tenantId) {
    return action.path === null ? "/api/admin/audit" : "/api/admin/tenants/" + tenantId + action.path;
  }

  function tenantActions(whoami) {
    return TENANT_ACTIONS.filter(function (a) {
      return canCall(whoami, a.method, actionPath(a, PROBE_TENANT));
    });
  }

  // ---- the audit trail -------------------------------------------------------------------------

  // A row, rendered for a person. The DETAIL is JSON the backend wrote; a malformed one is shown as
  // the raw string rather than dropped, because a row we cannot parse is still evidence that
  // something happened and hiding it would be the one failure mode an audit view must not have.
  function auditRow(row) {
    let detail = "";
    if (row && typeof row.detail === "string" && row.detail) {
      try {
        detail = Object.entries(JSON.parse(row.detail))
          .map(function (kv) {
            return kv[0] + "=" + (typeof kv[1] === "object" ? JSON.stringify(kv[1]) : String(kv[1]));
          })
          .join("  ");
      } catch (e) {
        detail = row.detail;
      }
    }
    return {
      id: (row && row.id) || 0,
      when: (row && row.created_at) || "",
      who: (row && row.actor) || "",
      // The distinction cp#219 is about, surfaced in the UI rather than left for a reader to infer
      // from a string prefix: a row attributed to a PERSON and a row attributed to the shared
      // credential are different kinds of evidence.
      attributed: !!row && typeof row.actor === "string" && row.actor.indexOf("operator:") === 0,
      what: (row && row.action) || "",
      // A read of a tenant is the event the access disclosure is actually about, so it is labelled
      // rather than left to look like any other row.
      isTenantRead: !!row && typeof row.action === "string" && row.action.indexOf("tenant.read.") === 0,
      target: (row && row.target) || "",
      detail: detail,
    };
  }

  // ---- minting -------------------------------------------------------------------------------

  // Client-side pre-validation, and ONLY that. The server is the authority on every one of these
  // rules and its refusal message is what the console displays; this exists to catch a typo before a
  // round trip, never to decide anything. Anywhere the two disagree, the server wins and the UI
  // shows the server.
  const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

  function mintPayload(name, scopes, expiresDays) {
    const n = String(name || "").trim();
    if (!NAME_RE.test(n)) {
      return {
        ok: false,
        message:
          "Name must be 1-32 characters of lowercase letters, digits, underscore or hyphen. " +
          "It is an identity that lands in the audit trail, so name a person, not a purpose.",
      };
    }
    const list = Array.isArray(scopes) ? scopes.filter(Boolean) : [];
    if (list.length === 0) {
      return { ok: false, message: "Pick at least one scope. A credential with none can authenticate and do nothing." };
    }
    const payload = { name: n, scopes: list };
    const days = String(expiresDays == null ? "" : expiresDays).trim();
    if (days) {
      const parsed = Number(days);
      if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 3650) {
        return { ok: false, message: "Expiry must be a whole number of days between 1 and 3650, or blank for no expiry." };
      }
      payload.expires_in_days = parsed;
    }
    return { ok: true, payload: payload };
  }

  // What a listed credential IS right now. Three states, computed in one place so the list and any
  // future filter cannot disagree about what "live" means.
  function credentialState(credential, nowIso) {
    if (!credential) return "unknown";
    if (credential.revoked_at) return "revoked";
    if (credential.expires_at && Date.parse(credential.expires_at) <= Date.parse(nowIso)) return "expired";
    return "live";
  }

  // ---- the pasted credential ------------------------------------------------------------------

  // A SHAPE hint, never a validity claim: only the server can say whether a credential is real, and
  // a UI that guessed would teach an operator to trust the guess. Returns a sentence and never the
  // value, matching the RunPod key hint on the onboarding page.
  function tokenShapeHint(token) {
    const t = String(token || "");
    if (!t) return { level: "", text: "" };
    if (/\s/.test(t)) return { level: "warn", text: "That contains whitespace; a pasted credential usually should not." };
    if (!/^[0-9a-f]+$/i.test(t) || t.length !== 64) {
      return {
        level: "warn",
        text: "A minted operator credential is 64 hexadecimal characters. This may still be the shared root credential, which is a different shape.",
      };
    }
    return { level: "ok", text: "Shape looks like a minted operator credential. Only the server can say whether it is live." };
  }

  // What went wrong, in words an operator can act on. The server's own message is preferred wherever
  // it sent one: it knows more than this file does, and paraphrasing it here is how a UI ends up
  // explaining a refusal that is no longer the one being made.
  const ERRORS = {
    unauthorized: "That credential was refused. It may be revoked, expired, or simply wrong.",
    insufficient_scope: "Your credential does not hold the scope this action needs.",
    root_credential_required: "Only the shared root credential can create or revoke operator credentials.",
    not_found: "Nothing there.",
  };

  function errorCopy(body, status) {
    if (body && typeof body.message === "string" && body.message) return body.message;
    if (body && typeof body.error === "string" && ERRORS[body.error]) return ERRORS[body.error];
    if (body && typeof body.error === "string" && body.error) return body.error;
    return "The request failed (HTTP " + String(status) + ").";
  }

  return {
    scopeRows: scopeRows,
    canDo: canDo,
    isRoot: isRoot,
    sectionsFor: sectionsFor,
    requirementFor: requirementFor,
    canCall: canCall,
    actionPath: actionPath,
    PROBE_TENANT: PROBE_TENANT,
    principalLabel: principalLabel,
    TENANT_ACTIONS: TENANT_ACTIONS,
    tenantActions: tenantActions,
    auditRow: auditRow,
    mintPayload: mintPayload,
    credentialState: credentialState,
    tokenShapeHint: tokenShapeHint,
    errorCopy: errorCopy,
  };
});
