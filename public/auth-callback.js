// Sign-in link confirm page. Vanilla JS, no build step.
//
// The mailed link carries its token in the URL FRAGMENT (`#token=...`). A browser never sends the
// fragment to the server, so the token is never in a request line or a request log. This script
// moves it into the confirm form, then strips it from the address bar. Only the form POST spends
// the token. Same UMD shape as front-door-checks.js: `tokenFromHash` is unit-tested under Node.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.authCallback = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  /** The token in a `#token=<value>` fragment, or "" when there is none. */
  function tokenFromHash(hash) {
    if (typeof hash !== "string") return "";
    const raw = hash.charAt(0) === "#" ? hash.slice(1) : hash;
    let value = "";
    try {
      value = new URLSearchParams(raw).get("token") || "";
    } catch (_e) {
      return "";
    }
    return /^[A-Za-z0-9_-]{16,256}$/.test(value) ? value : "";
  }

  function wire(doc, loc, hist) {
    const token = tokenFromHash(loc.hash);
    const input = doc.getElementById("magic-link-token");
    const button = doc.getElementById("magic-link-continue");
    const missing = doc.getElementById("magic-link-missing");
    // Strip the fragment either way, so it does not linger in history or a copied URL.
    if (loc.hash && hist && typeof hist.replaceState === "function") {
      hist.replaceState(null, "", loc.pathname);
    }
    if (!token || !input || !button) {
      if (missing) missing.hidden = false;
      if (button) button.disabled = true;
      return false;
    }
    input.value = token;
    button.disabled = false;
    return true;
  }

  if (typeof document !== "undefined" && typeof location !== "undefined") {
    wire(document, location, typeof history !== "undefined" ? history : null);
  }

  return { tokenFromHash, wire };
});
