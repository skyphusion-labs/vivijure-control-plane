// Pure front-door helpers (#52 UI). No DOM: unit-tested under plain Node
// (tests/front-door-checks.test.ts) and loaded as a classic <script> on
// index.html as `window.frontDoorChecks`. Same UMD-ish shape as
// onboarding-checks.js / render-eta.js. No framework, no build step.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.frontDoorChecks = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  // Auth methods are PROJECTED from GET /api/platform/config.auth_methods,
  // which the control plane computes from the credentials actually configured.
  // Nothing here hardcodes a provider list: Apple appears the day Conrad's .p8
  // is staged, with zero UI change, exactly like the planner grows a section
  // when a module is bound. An unknown method gets a sane label rather than
  // being dropped, so a new provider is visible the day the backend offers it.
  const METHOD_LABELS = {
    email: "Email me a link",
    google: "Continue with Google",
    github: "Continue with GitHub",
    apple: "Continue with Apple",
  };

  function methodLabel(method) {
    return METHOD_LABELS[method] || ("Continue with " + String(method || "").replace(/^./, function (c) {
      return c.toUpperCase();
    }));
  }

  // Magic-link is the primary path (ruled), so email leads regardless of the
  // order the server lists methods in; the rest keep server order.
  function orderMethods(methods) {
    const list = Array.isArray(methods) ? methods.filter(function (m) { return typeof m === "string" && m; }) : [];
    const email = list.filter(function (m) { return m === "email"; });
    const rest = list.filter(function (m) { return m !== "email"; });
    return email.concat(rest);
  }

  // THE shell decision: given GET /api/me (or null when signed out), which
  // screen does this person belong on?
  //
  // Kept pure and total on purpose. Every branch here is a claim about somebody
  // else's account and money, and an unknown state must never fall through to a
  // cheerful default: it returns "unknown" so the UI can say so honestly.
  function shellRoute(me, config) {
    const cfg = config || {};
    if (!me || !me.account) {
      return cfg.signups_enabled === false ? "signups-closed" : "auth";
    }
    // The AUP gate is blocking and versioned: a bumped version re-gates an
    // existing account, which is the whole point of comparing versions rather
    // than storing a boolean.
    if (!me.aup || me.aup.accepted !== true) return "aup";

    const tenant = me.tenant;
    if (!tenant) return "onboarding";

    switch (tenant.status) {
      case "awaiting_invoke_key": return "resume-key";
      case "live": return "studio";
      case "suspended": return "suspended";
      case "pending":
      case "provisioning": return "building";
      case "failed": return "failed";
      case "deleting":
      case "deleted": return "deleted";
      default: return "unknown";
    }
  }

  // Copy for the error codes the control plane redirects back with
  // (?error=... on /). Anything unrecognized gets an honest generic rather than
  // a guess about what went wrong.
  const AUTH_ERRORS = {
    link_invalid:
      "That sign-in link did not work. Links expire after 15 minutes and only work once. Ask for a fresh one.",
    signups_closed:
      "Signups are closed right now, so we could not finish creating your account.",
    sso_failed:
      "That sign-in did not complete. Nothing happened to your account; please try again.",
    sso_unverified_email:
      "That account's email address is not verified with the provider. Verify it there first, or use the email link instead.",
    account_unavailable:
      "That account is not available. If you think this is a mistake, please get in touch.",
  };

  function authErrorCopy(code) {
    if (!code) return null;
    return AUTH_ERRORS[code] || "Something went wrong signing you in. Please try again.";
  }

  return {
    METHOD_LABELS: METHOD_LABELS,
    AUTH_ERRORS: AUTH_ERRORS,
    methodLabel: methodLabel,
    orderMethods: orderMethods,
    shellRoute: shellRoute,
    authErrorCopy: authErrorCopy,
  };
});
