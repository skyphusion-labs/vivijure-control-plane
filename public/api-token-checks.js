// Pure helpers for the tenant programmatic-access token panel (cf#94). No DOM:
// unit-tested under plain Node (tests/api-token-checks.test.ts) and loaded as a
// classic <script> on index.html as `window.apiTokenChecks`. Same UMD-ish shape
// as front-door-checks.js / onboarding-checks.js. No framework, no build step.
//
// ALIGNED to the contract Rollins committed (sprint cf#215). Two things changed
// from the first cut, and both made the panel MORE honest, so they are worth
// recording rather than quietly editing away:
//
//  1. There is NO `display` field, because there is nothing to mask. The studio
//     stores only the SHA-256 hash of a token (migrations/0009_api_tokens.sql,
//     auth-gate.ts sha256Hex); the plaintext exists exactly once, in the mint
//     response. A masked "vjs_...9f2c" would have implied we kept a copy we could
//     partially show, which is a lie about custody. Reveal-once here is enforced
//     BY CONSTRUCTION, not by anyone's discipline: nobody can show you the value
//     later because nobody has it.
//  2. There is no `custody` field on the wire, because custody is settled
//     architecture, not runtime state: a named row in the tenant's own api_tokens
//     table, revoked independently, resolving to sub "api-token:<name>" distinct
//     from the operator token. So the DEFAULT rotate warning is the accurate
//     separate-custody one. The `shared` branch is kept as an explicit override
//     and tripwire: if some future payload ever declares shared custody, the
//     warning gets harsher on its own rather than silently going stale.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.apiTokenChecks = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  function str(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  // THE state decision for the panel. Total on purpose: a payload we cannot read
  // is "unknown", never "absent". Those two must not collapse, because "absent"
  // renders a Create button and "unknown" must not: offering to mint against a
  // reply we failed to parse is how you get a button that throws.
  function tokenView(payload) {
    const blank = {
      state: "unknown",
      name: null,
      custody: null,
      created_at: null,
      last_rotated_at: null,
    };
    if (!payload || typeof payload !== "object") return blank;
    const configured = payload.configured;
    const state = configured === true ? "present" : configured === false ? "absent" : "unknown";
    const custody = payload.custody === "shared" || payload.custody === "separate" ? payload.custody : null;
    return {
      state: state,
      name: str(payload.name),
      custody: custody,
      created_at: str(payload.created_at),
      last_rotated_at: str(payload.last_rotated_at),
    };
  }

  // Copy for the error codes the control plane returns as { error: "<code>" }.
  // These are the codes Rollins committed for this path, no more and no fewer:
  // carrying copy for a code the route cannot emit is dead weight that implies a
  // mechanism we do not use (the KEK, notably, is irrelevant here -- a direct
  // dividend of the separate-token ruling).
  const TOKEN_ERRORS = {
    not_found:
      "We could not find that studio. If you just created it, reload the page.",
    tenant_not_live:
      "Your studio is not live yet, so there is no API token to hand out. Finish setup first, then come back.",
    not_provisioned:
      "Your studio is still being built, so it cannot hold a token yet. Give it a few minutes and reload.",
    tenant_unreachable:
      "We could not reach your studio's database just now, so nothing was changed. That is our problem, not yours; please try again in a minute.",
    unauthorized:
      "Your session expired while this page was open. Sign in again and retry.",
    rate_limited:
      "Too many token requests in a row. Wait a minute and try again.",
  };

  function tokenErrorCopy(code) {
    if (!code) return null;
    return (
      TOKEN_ERRORS[code] ||
      "Something went wrong talking to the control plane, and we are not going to guess what. Nothing was changed. Please try again, and tell us if it keeps happening."
    );
  }

  // What rotation actually costs the person clicking it.
  //
  // The default is the SEPARATE-custody statement because that is what the system
  // structurally is: rotating replaces one named row in the tenant's api_tokens
  // table and never touches the operator secret the browser session rides on. The
  // `shared` branch is not dead code; it is the tripwire for a future payload that
  // says otherwise.
  function rotateWarning(custody) {
    if (custody === "shared") {
      return "WARNING: this token is the same one your browser session uses. Rotating it signs you out of the studio in this browser AND breaks anything using the old value.";
    }
    return "Rotating issues a new programmatic token and invalidates the old one immediately. Anything using the old value (scripts, CI, an MCP client) stops working until you paste the new one in. Your studio browser session is NOT affected.";
  }

  function revokeWarning() {
    return "Revoking deletes the programmatic token. Anything using it stops working immediately. You can create a new one afterwards; you cannot get this one back.";
  }

  // Shown next to the plaintext, once, at mint/rotate time. It states the actual
  // mechanism rather than making a promise about our behaviour, because the
  // mechanism is the stronger claim: only a SHA-256 hash of this value is stored,
  // so "we cannot show it to you again" is a fact about the system, not a policy
  // we could quietly change later.
  function revealNotice() {
    return "This is the only time this value exists. Your studio stores only a one-way hash of it, so nobody, including us, can show it to you again. Copy it somewhere safe now. If you lose it, rotate to get a new one.";
  }

  // A studio URL we are willing to print into a copyable command. Anything that is
  // not a plain https origin is refused rather than interpolated: these strings get
  // pasted into a shell.
  function safeStudioUrl(url) {
    const raw = str(url);
    if (!raw) return null;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (err) {
      return null;
    }
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed.origin;
  }

  // Copyable examples. DELIBERATELY placeholder-based: the token value is never
  // interpolated into a snippet. A snippet with the live secret baked in is a
  // secret that ends up in a bug report, a screenshot, or a pasted terminal
  // scrollback, and the reveal-once property would be undermined by our own UI.
  //
  // The header shape is CONFIRMED against the studio's token gate
  // (vivijure-cf src/auth-gate.ts verifyTokenRequest): Authorization: Bearer.
  //
  // Projection rule, same as everywhere else: a surface is only advertised if the
  // payload says it exists. The MCP example appears the day the plane reports an
  // mcp_url and not one minute before, because a config block pointing at a
  // hostname that does not serve MCP is a button that throws.
  function snippets(studioUrl, payload) {
    const origin = safeStudioUrl(studioUrl);
    if (!origin) return [];
    const out = [
      {
        id: "curl",
        label: "Call your studio API",
        body:
          "export VIVIJURE_TOKEN='paste-your-token-here'\n" +
          'curl -H "Authorization: Bearer $VIVIJURE_TOKEN" \\\n' +
          "  " + origin + "/api/modules",
      },
    ];
    const mcp = safeStudioUrl(payload && payload.mcp_url);
    if (mcp) {
      out.push({
        id: "mcp",
        label: "Point an MCP client at it",
        body:
          "{\n" +
          '  "mcpServers": {\n' +
          '    "vivijure-studio": {\n' +
          '      "url": "' + mcp + '",\n' +
          '      "headers": { "Authorization": "Bearer $VIVIJURE_TOKEN" }\n' +
          "    }\n" +
          "  }\n" +
          "}",
      });
    }
    return out;
  }

  // Dates are rendered as the calendar day only. The panel has no business
  // implying more precision than the person needs, and no timezone guessing.
  function whenLabel(iso) {
    const raw = str(iso);
    if (!raw) return "";
    const at = new Date(raw);
    if (isNaN(at.getTime())) return "";
    return at.toISOString().slice(0, 10);
  }

  // One line describing the token that exists, built only from what the backend
  // projected. Never claims a name or a date it was not given.
  function summaryLine(view) {
    if (!view || view.state !== "present") return "";
    const parts = [];
    if (view.name) parts.push('named "' + view.name + '"');
    const rotated = whenLabel(view.last_rotated_at);
    const created = whenLabel(view.created_at);
    if (rotated) parts.push("last rotated " + rotated);
    else if (created) parts.push("created " + created);
    if (!parts.length) return "A programmatic token exists for this studio.";
    return "Active token, " + parts.join(", ") + ".";
  }

  return {
    TOKEN_ERRORS: TOKEN_ERRORS,
    tokenView: tokenView,
    tokenErrorCopy: tokenErrorCopy,
    rotateWarning: rotateWarning,
    revokeWarning: revokeWarning,
    revealNotice: revealNotice,
    safeStudioUrl: safeStudioUrl,
    snippets: snippets,
    whenLabel: whenLabel,
    summaryLine: summaryLine,
  };
});
