// Pure helpers for the tenant programmatic-access token panel (cf#94). No DOM:
// unit-tested under plain Node (tests/api-token-checks.test.ts) and loaded as a
// classic <script> on index.html as `window.apiTokenChecks`. Same UMD-ish shape
// as front-door-checks.js / onboarding-checks.js. No framework, no build step.
//
// Custody is RULED (Mackaye, sprint cf#215): the programmatic token is a SEPARATE
// tenant-scoped token, never the KEK-encrypted STUDIO_API_TOKEN the dispatcher
// injects into the owner's browser session. That ruling lives in the BACKEND; this
// file still projects `custody` off the payload rather than hardcoding it, because
// a UI that assumes a fact it did not read is exactly how a warning goes stale. If
// the plane ever reports shared custody, the rotate warning gets harsher on its own.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.apiTokenChecks = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  function str(value) {
    return typeof value === "string" && value.trim() ? value : null;
  }

  // THE state decision for the panel. Total on purpose: a payload we cannot read
  // is "unknown", never "absent". Those two must not collapse, because "absent"
  // renders a Create button and "unknown" must not: offering to mint against a
  // reply we failed to parse is how you get a button that throws.
  function tokenView(payload) {
    const blank = {
      state: "unknown",
      display: "",
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
      // Masked, backend-supplied. Never a value this file derives: deriving a mask
      // from a plaintext would mean the plaintext passed through here at all.
      display: typeof payload.display === "string" ? payload.display : "",
      custody: custody,
      created_at: str(payload.created_at),
      last_rotated_at: str(payload.last_rotated_at),
    };
  }

  // Copy for the error codes the control plane returns as { error: "<code>" }.
  // Anything unrecognized gets an honest generic that says we do not know, rather
  // than a guess dressed up as a diagnosis.
  const TOKEN_ERRORS = {
    not_found:
      "We could not find that studio. If you just created it, reload the page.",
    tenant_not_live:
      "Your studio is not live yet, so there is no API token to hand out. Finish setup first, then come back.",
    kek_unavailable:
      "We cannot reach the key that protects your token right now. That is our problem, not yours, and nothing about your token changed.",
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

  // What rotation actually costs the person clicking it, read off custody rather
  // than assumed. The `shared` branch is not dead code: it is the honest answer if
  // the backend ever welds the two tokens together again.
  function rotateWarning(custody) {
    if (custody === "separate") {
      return "Rotating issues a new programmatic token and invalidates the old one immediately. Anything using the old value (scripts, CI, an MCP client) stops working until you paste the new one in. Your studio browser session is NOT affected.";
    }
    if (custody === "shared") {
      return "WARNING: this token is the same one your browser session uses. Rotating it signs you out of the studio in this browser AND breaks anything using the old value.";
    }
    return "Rotating issues a new token and invalidates the old one immediately. We cannot tell from here what else is holding the old value, so assume everything using it stops working.";
  }

  function revokeWarning() {
    return "Revoking deletes the programmatic token. Anything using it stops working immediately. You can create a new one afterwards; you cannot get this one back.";
  }

  // Shown next to the plaintext, once, at mint/rotate time.
  function revealNotice() {
    return "This is the only time this value is shown. We do not keep a copy we can show you again, and it is never written to a log. Copy it somewhere safe now. If you lose it, rotate to get a new one.";
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
  // scrollback, and the reveal-once promise would be a fiction.
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
  // projected. Never claims a creation date it was not given.
  function summaryLine(view) {
    if (!view || view.state !== "present") return "";
    const parts = [];
    if (view.display) parts.push(view.display);
    const rotated = whenLabel(view.last_rotated_at);
    const created = whenLabel(view.created_at);
    if (rotated) parts.push("last rotated " + rotated);
    else if (created) parts.push("created " + created);
    return parts.join(" -- ");
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
