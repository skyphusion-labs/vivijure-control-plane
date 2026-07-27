// Pure credit-surface helpers (cp#194 UI). No DOM: unit-tested under plain Node
// (tests/credits-checks.test.ts) and loaded as a classic <script> on index.html
// as `window.creditsChecks`. Same UMD-ish shape as front-door-checks.js /
// onboarding-checks.js. No framework, no build step.
//
// EVERYTHING HERE IS A PROJECTION of GET /api/tenant/{id}/credits. Nothing
// infers a tenant's billing relationship from the SHAPE of a payload, and that
// restraint is the whole design: a balance of zero and "credits do not apply to
// this studio" look identical if you guess from the numbers, and guessing wrong
// tells a BYOK tenant they owe us money.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.creditsChecks = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  const MICRO_PER_USD = 1000000;

  // Money arrives as INTEGER micro-USD and becomes text exactly here. The server
  // never sends a formatted string, so there is one rounding rule in the system
  // and it lives at the edge that displays it.
  function formatUsd(micro) {
    if (typeof micro !== "number" || !isFinite(micro)) return null;
    const neg = micro < 0;
    const cents = Math.round(Math.abs(micro) / 10000);
    const s = Math.floor(cents / 100) + "." + String(cents % 100).padStart(2, "0");
    return (neg ? "-" : "") + "USD " + s;
  }

  // A sub-cent balance formats as "USD 0.00" while being genuinely non-zero, so
  // anything that must distinguish "nothing left" from "nearly nothing left"
  // asks THIS, never the formatted string. Comparing rendered money is how a
  // display rounding rule turns into a business rule by accident.
  function isEmpty(micro) {
    return typeof micro === "number" && micro <= 0;
  }

  // WHAT THE PANEL SHOWS, decided in one place.
  //
  // `credits_apply` comes from the server and is NEVER inferred here. A BYOK
  // tenant pays RunPod directly and has no credit relationship with us at all;
  // showing them a USD 0.00 balance would invent one, and would read as a bill
  // they had not been told about. So an absent or false flag renders NOTHING,
  // which is also the correct behaviour on a payload from an older plane.
  function panelState(payload) {
    if (!payload || payload.credits_apply !== true) {
      return { show: false, reason: "not_applicable" };
    }
    // The server could not compute the balance. Showing a stale or zero number
    // here would be worse than showing none: this is the figure a tenant uses to
    // decide whether they can start work.
    if (payload.complete !== true) {
      return { show: true, reason: "unreadable" };
    }
    return { show: true, reason: "ok" };
  }

  // The top-up control has THREE states, not two, because "you cannot buy
  // credits yet" and "you can buy credits" are different from "buying is broken".
  // A button that throws is worse than an absent one, so an unavailable rail
  // renders as a plain sentence and never as a disabled-looking control that
  // invites a click.
  function topUpState(payload) {
    if (!payload || payload.credits_apply !== true) return "hidden";
    return payload.topup_available === true ? "available" : "not_open_yet";
  }

  // Activity lines, projected for display. The server decides WHAT happened; this
  // decides only how to say it, and refuses to say anything it was not told.
  const KIND_LABELS = {
    purchase: "Credit added",
    charge: "Film rendered",
    no_charge_failed: "Not charged",
    reserved: "Reserved for a job in progress",
    refund: "Refunded",
    adjustment: "Adjustment",
  };

  function lineLabel(kind) {
    return KIND_LABELS[kind] || "Activity";
  }

  // A no-charge line MUST carry its reason through. The completed-only policy is
  // the differentiator, and a tenant seeing "Not charged" with no explanation
  // reads it as a bug rather than as the thing we promised them.
  function projectLine(line) {
    if (!line || typeof line !== "object") return null;
    const kind = typeof line.kind === "string" ? line.kind : "";
    const amount = typeof line.delta_micro_usd === "number" ? line.delta_micro_usd : 0;
    return {
      id: String(line.id || ""),
      label: lineLabel(kind),
      kind: kind,
      // Zero-delta lines (reservations, non-charges) show no money at all rather
      // than "USD 0.00", which would read as a charge that happened to be free.
      amount: amount === 0 ? null : formatUsd(amount),
      job_ref: typeof line.job_ref === "string" ? line.job_ref : null,
      note: typeof line.no_charge_reason === "string" ? line.no_charge_reason : null,
      when: typeof line.occurred_at === "string" ? line.occurred_at : null,
    };
  }

  function projectActivity(payload) {
    const rows = payload && Array.isArray(payload.activity) ? payload.activity : [];
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const p = projectLine(rows[i]);
      if (p) out.push(p);
    }
    return out;
  }

  return {
    MICRO_PER_USD: MICRO_PER_USD,
    formatUsd: formatUsd,
    isEmpty: isEmpty,
    panelState: panelState,
    topUpState: topUpState,
    lineLabel: lineLabel,
    projectLine: projectLine,
    projectActivity: projectActivity,
  };
});
