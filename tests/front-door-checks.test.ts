import { describe, expect, it } from "vitest";

import {
  AUTH_ERRORS,
  authErrorCopy,
  methodLabel,
  orderMethods,
  shellRoute,
  type MePayload,
} from "../public/front-door-checks.js";

// The hosted front door (#52 UI). shellRoute decides what a stranger is told
// about their own account, so every branch gets a test and the failure modes
// (unknown status, missing payload) are asserted to REFUSE rather than default
// to something cheerful.

const ACCOUNT = { id: "acct_1", email: "a@b.c" };
const AUP_OK = { required_version: "v3", accepted: true };

function me(over: Partial<MePayload> = {}): MePayload {
  return { account: ACCOUNT, aup: AUP_OK, tenant: null, ...over };
}

describe("orderMethods / methodLabel (projected from auth_methods)", () => {
  it("puts magic-link first: it is the ruled primary path", () => {
    expect(orderMethods(["google", "github", "email"])[0]).toBe("email");
  });

  it("keeps server order for the rest, and never invents a provider", () => {
    expect(orderMethods(["github", "google"])).toEqual(["github", "google"]);
    expect(orderMethods([])).toEqual([]);
    expect(orderMethods(null)).toEqual([]);
  });

  it("shows Apple the day the backend offers it, with no UI change", () => {
    // The whole point of projecting: Apple is parked on Conrad's side, so it is
    // simply absent from auth_methods until his account unsticks.
    expect(orderMethods(["email", "google", "github"])).not.toContain("apple");
    expect(orderMethods(["email", "google", "github", "apple"])).toContain("apple");
    expect(methodLabel("apple")).toBe("Continue with Apple");
  });

  it("labels an unknown method rather than dropping it", () => {
    // A provider the backend added and this file has never heard of must still
    // be reachable; silently hiding it would make the projection a lie.
    expect(methodLabel("gitlab")).toBe("Continue with Gitlab");
    expect(orderMethods(["email", "gitlab"])).toContain("gitlab");
  });

  it("drops junk entries", () => {
    expect(orderMethods(["email", "", null as never, 7 as never])).toEqual(["email"]);
  });
});

describe("shellRoute", () => {
  it("sends a signed-out visitor to sign in", () => {
    expect(shellRoute(null, { signups_enabled: true })).toBe("auth");
    expect(shellRoute({}, {})).toBe("auth");
  });

  it("tells a signed-out visitor signups are closed instead of a dead form", () => {
    expect(shellRoute(null, { signups_enabled: false })).toBe("signups-closed");
  });

  it("does not lock out an EXISTING account when signups are closed", () => {
    // signups_enabled gates new studios, not people who already have one.
    expect(shellRoute(me({ tenant: { id: "t", slug: "s", status: "live" } }), { signups_enabled: false })).toBe("studio");
  });

  it("gates on the AUP before anything else", () => {
    expect(shellRoute(me({ aup: { required_version: "v3", accepted: false } }), {})).toBe("aup");
    expect(shellRoute(me({ aup: null }), {})).toBe("aup");
    // A bumped version re-gates an account that accepted an older one: the
    // server compares versions, and the UI must not cache a stale yes.
    expect(shellRoute(me({ aup: { required_version: "v4", accepted: false } }), {})).toBe("aup");
  });

  it("routes each tenant status to its own screen", () => {
    const cases: Array<[string, string]> = [
      ["awaiting_invoke_key", "resume-key"],
      ["live", "studio"],
      ["suspended", "suspended"],
      ["pending", "building"],
      ["provisioning", "building"],
      ["failed", "failed"],
      ["deleting", "deleted"],
      ["deleted", "deleted"],
    ];
    for (const [status, route] of cases) {
      expect(shellRoute(me({ tenant: { id: "t", slug: "s", status } }), {})).toBe(route);
    }
  });

  it("sends an account with no tenant to onboarding", () => {
    expect(shellRoute(me(), {})).toBe("onboarding");
  });

  it("REFUSES to guess on an unrecognized status", () => {
    // A status this file has never heard of must not fall through to "studio"
    // and hand someone a link that 5xx's.
    expect(shellRoute(me({ tenant: { id: "t", slug: "s", status: "reticulating" } }), {})).toBe("unknown");
    expect(shellRoute(me({ tenant: { id: "t", slug: "s", status: "" } }), {})).toBe("unknown");
  });

  it("never routes a non-live tenant to the studio screen", () => {
    // The studio screen is the only one that hands out a URL, and tenantView
    // only returns one when the tenant is actually live.
    for (const status of ["pending", "provisioning", "awaiting_invoke_key", "failed", "suspended", "deleting", "deleted", "bogus"]) {
      expect(shellRoute(me({ tenant: { id: "t", slug: "s", status } }), {})).not.toBe("studio");
    }
  });
});

describe("authErrorCopy", () => {
  it("explains every error code the control plane redirects with", () => {
    // These are the real ?error= values in src/control-plane (link_invalid,
    // signups_closed, sso_failed, sso_unverified_email, account_unavailable).
    for (const code of Object.keys(AUTH_ERRORS)) {
      expect(authErrorCopy(code)).toBeTruthy();
      expect(authErrorCopy(code)!.length).toBeGreaterThan(20);
    }
    expect(authErrorCopy("link_invalid")).toContain("expire");
  });

  it("is silent when there is no error", () => {
    expect(authErrorCopy(null)).toBeNull();
    expect(authErrorCopy("")).toBeNull();
  });

  it("gives an honest generic for a code it does not know", () => {
    expect(authErrorCopy("brand_new_code")).toBeTruthy();
  });
});
