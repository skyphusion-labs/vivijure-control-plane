// Pure helpers for the owner-completed invoke-key handoff page (cp#169). No DOM:
// unit-tested under plain Node (tests/handoff-checks.test.ts) and loaded as a
// classic <script> on install-key.html as `window.handoffChecks`. Same UMD-ish
// shape as onboarding-checks.js / front-door-checks.js. No framework, no build.
//
// WHAT IS DELIBERATELY *NOT* HERE: anything about judging a pasted key. The page
// reuses onboarding-checks.js for keyShapeHint and invokeKeyVerdict, because the
// owner is doing the SAME operation they did at signup against the SAME endpoint,
// and a second copy of that logic would be a drift source with no owner -- the
// two would disagree the first time one of them was corrected. This module holds
// only what is new: reading the token off the URL, and saying what a refused or
// expired LINK means.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.handoffChecks = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  /** Must match HANDOFF_TOKEN_PARAM in src/invoke-key-handoff.ts. */
  const TOKEN_PARAM = "t";

  /**
   * The token out of a location.search. Returns "" rather than null for absent,
   * so a caller cannot accidentally send the string "null" to the plane.
   *
   * Total: a search string we cannot parse yields "", which the page renders as
   * "this link is not valid" -- the same sentence an unknown token gets, because
   * from the reader's side they are the same situation.
   */
  function tokenFromSearch(search) {
    try {
      const params = new URLSearchParams(String(search || ""));
      const raw = params.get(TOKEN_PARAM);
      return typeof raw === "string" ? raw.trim() : "";
    } catch (e) {
      return "";
    }
  }

  // One sentence per refusal the plane can make about the LINK (not about the
  // key). Each names what the reader should DO, because every one of these is a
  // dead end for them personally: the fix is always to go back to the operator,
  // and a message that does not say so leaves them re-pasting into a dead page.
  const LINK_ERRORS = {
    handoff_unknown:
      "This link is not valid. It may have been copied incompletely; ask whoever sent it for a fresh one.",
    handoff_expired:
      "This link has expired. Ask whoever sent it for a new one; it takes them a moment to issue.",
    handoff_consumed:
      "This link has already been used, and your key was installed. If something still looks wrong, " +
      "ask for a new link rather than pasting again here.",
    handoff_tenant_missing: "The studio this link was issued for no longer exists.",
    handoff_endpoints_changed:
      "Your studio's render endpoints have changed since this link was made, so a key scoped to the " +
      "ones listed here would not work. Ask for a new link.",
    invoke_key_required: "Paste your render key first.",
    provisioner_unconfigured:
      "This is on our side, not yours: the plane is not configured to install keys right now. Tell us.",
  };

  /**
   * Copy for a link-level refusal. Falls back to the server's own message, and
   * then to a generic line, so an error code we have never seen still renders a
   * sentence instead of an empty box.
   */
  function linkErrorCopy(code, serverMessage) {
    if (code && Object.prototype.hasOwnProperty.call(LINK_ERRORS, code)) return LINK_ERRORS[code];
    if (typeof serverMessage === "string" && serverMessage.trim()) return serverMessage.trim();
    return "We could not use this link. Ask whoever sent it for a new one.";
  }

  /**
   * The endpoint rows to show, normalised. The plane sends {id,name,label}; a row
   * without a name still renders (its id is what the console shows), because
   * dropping it would silently understate how many endpoints must be ticked --
   * and the whole verification requires ALL of them.
   */
  function endpointRows(payload) {
    const list = payload && Array.isArray(payload.endpoints) ? payload.endpoints : [];
    const out = [];
    for (const raw of list) {
      if (!raw) continue;
      if (typeof raw === "string") {
        out.push({ id: raw, name: null, label: null });
        continue;
      }
      if (typeof raw.id !== "string" || !raw.id) continue;
      out.push({
        id: raw.id,
        name: typeof raw.name === "string" && raw.name ? raw.name : null,
        label: typeof raw.label === "string" && raw.label ? raw.label : null,
      });
    }
    return out;
  }

  /**
   * How long the link is good for, in words a person can act on. Deliberately
   * coarse: an exact countdown implies a precision the support channel this
   * travels through does not have, and "about 2 days left" is what actually
   * changes someone's behaviour.
   */
  function expiryNote(expiresAt, nowMs) {
    const at = Date.parse(String(expiresAt || ""));
    if (!Number.isFinite(at)) return "";
    const ms = at - (typeof nowMs === "number" ? nowMs : Date.now());
    if (ms <= 0) return "This link has expired.";
    const hours = Math.floor(ms / 3600000);
    if (hours < 1) return "This link expires in under an hour.";
    if (hours < 24) return "This link expires in about " + hours + (hours === 1 ? " hour." : " hours.");
    const days = Math.round(hours / 24);
    return "This link expires in about " + days + (days === 1 ? " day." : " days.");
  }

  return {
    TOKEN_PARAM: TOKEN_PARAM,
    LINK_ERRORS: LINK_ERRORS,
    tokenFromSearch: tokenFromSearch,
    linkErrorCopy: linkErrorCopy,
    endpointRows: endpointRows,
    expiryNote: expiryNote,
  };
});
