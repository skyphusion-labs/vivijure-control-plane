import { describe, expect, it } from "vitest";

import {
  AUTH_ERRORS,
  authErrorCopy,
  aupCopyKind,
  aupReturningLede,
  methodLabel,
  orderMethods,
  shellRoute,
  shouldWatch,
  signupsOpen,
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
    expect(shellRoute(null)).toBe("auth");

    expect(shellRoute({})).toBe("auth");
  });
  // THE REGRESSION (cp#428). This test used to assert the bug: with signups off, a
  // signed-out visitor was routed to a closed panel and the sign-in form went away
  // with it, so an account that already existed had no way back into a studio it
  // already owned. The plane never worked that way -- POST /api/auth/email/start
  // mails the link to an existing address with the switch off -- and only the UI
  // conflated can a NEW account be created with can a KNOWN person get back in.
  it("NEVER routes a signed-out visitor away from sign-in, whatever the signup switch says", () => {
    expect(shellRoute(null)).toBe("auth");
    // And structurally: the route no longer takes the platform config AT ALL, so no
    // future edit can reintroduce the conflation by reading the switch in here.
    expect(shellRoute.length).toBe(1);
  });

  // The switch still has to be VISIBLE -- it just changes the copy rather than the door.
  it("signupsOpen answers the copy question, and defaults OPEN on a payload it cannot read", () => {
    expect(signupsOpen({ signups_enabled: false })).toBe(false);
    expect(signupsOpen({ signups_enabled: true })).toBe(true);
    // An unreadable or absent config must not invent a closure: the plane refuses on
    // its own, and a page that announces closed signups it never read is a guess.
    expect(signupsOpen({})).toBe(true);
    expect(signupsOpen(null)).toBe(true);
    expect(signupsOpen(undefined)).toBe(true);
  });

  it("does not lock out an EXISTING account when signups are closed", () => {
    // signups_enabled gates new studios, not people who already have one.
    expect(shellRoute(me({ tenant: { id: "t", slug: "s", status: "live" } }))).toBe("studio");
  });

  it("gates on the AUP before anything else", () => {
    expect(shellRoute(me({ aup: { required_version: "v3", accepted: false } }))).toBe("aup");
    expect(shellRoute(me({ aup: null }))).toBe("aup");
    // A bumped version re-gates an account that accepted an older one: the
    // server compares versions, and the UI must not cache a stale yes.
    expect(shellRoute(me({ aup: { required_version: "v4", accepted: false } }))).toBe("aup");
  });

  it("routes each tenant status to its own screen", () => {
    const cases: Array<[string, string]> = [
      ["awaiting_go_live", "go-live"],
      ["awaiting_invoke_key", "go-live"],
      ["live", "studio"],
      ["suspended", "suspended"],
      ["pending", "building"],
      ["provisioning", "building"],
      ["failed", "failed"],
      ["deleting", "deleted"],
      ["deleted", "deleted"],
    ];
    for (const [status, route] of cases) {
      expect(shellRoute(me({ tenant: { id: "t", slug: "s", status } }))).toBe(route);
    }
  });

  it("sends an account with no tenant to onboarding", () => {
    expect(shellRoute(me())).toBe("onboarding");
  });

  it("REFUSES to guess on an unrecognized status", () => {
    // A status this file has never heard of must not fall through to "studio"
    // and hand someone a link that 5xx's.
    expect(shellRoute(me({ tenant: { id: "t", slug: "s", status: "reticulating" } }))).toBe("unknown");
    expect(shellRoute(me({ tenant: { id: "t", slug: "s", status: "" } }))).toBe("unknown");
  });

  it("never routes a non-live tenant to the studio screen", () => {
    // The studio screen is the only one that hands out a URL, and tenantView
    // only returns one when the tenant is actually live.
    for (const status of ["pending", "provisioning", "awaiting_go_live", "failed", "suspended", "deleting", "deleted", "bogus"]) {
      expect(shellRoute(me({ tenant: { id: "t", slug: "s", status } }))).not.toBe("studio");
    }
  });
});

describe("shouldWatch (cp#432)", () => {
  it("re-checks only the in-flight and failed panels", () => {
    expect(shouldWatch("building")).toBe(true);
    expect(shouldWatch("failed")).toBe(true);
  });

  it("does not poll signed-out, live, or click-through screens", () => {
    for (const route of ["auth", "aup", "onboarding", "go-live", "studio", "suspended", "deleted", "unknown", "link-sent"]) {
      expect(shouldWatch(route), route).toBe(false);
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

describe("aupCopyKind (cp#452)", () => {
  it("is first-run when last_accepted is missing or null", () => {
    expect(aupCopyKind(me({ aup: { required_version: "v3", accepted: false } }))).toBe("first");
    expect(aupCopyKind(me({ aup: { required_version: "v3", accepted: false, last_accepted: null } }))).toBe("first");
  });

  it("is returning when last_accepted names a prior accept", () => {
    expect(aupCopyKind(me({
      aup: {
        required_version: "v4",
        accepted: false,
        last_accepted: { version: "v3", accepted_at: "2026-07-12T09:31:04Z" },
      },
    }))).toBe("returning");
  });

  it("names the prior version and day in the returning lede", () => {
    const lede = aupReturningLede({ version: "v3", accepted_at: "2026-07-12T09:31:04Z" });
    expect(lede).toContain("version v3");
    expect(lede).toContain("2026-07-12");
    expect(lede).toMatch(/studio keeps running/i);
    expect(lede).not.toMatch(/set up a studio/i);
  });
});
