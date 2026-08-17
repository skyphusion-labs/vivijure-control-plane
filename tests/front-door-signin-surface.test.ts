// THE SIGNED-OUT SURFACE, READ FROM THE SHIPPED ASSETS (cp#428).
//
// WHY A MARKUP TEST AND NOT ONLY A UNIT TEST. shellRoute is pure and unit-tested, and it was
// still possible to lock every account holder out of the front door, because the LOCKOUT lived in
// the pairing of a route name with a panel: index.html carried a data-shell="signups-closed"
// section, and routing to it hid the panel that owns the sign-in form. No assertion about
// shellRoute could see that, and neither could a test that built its own DOM: the defect was in
// the shipped file. So these read public/index.html and public/front-door.js themselves.
//
// Every claim is paired with a POSITIVE CONTROL, because a renamed, moved or empty asset would
// otherwise satisfy every not.toContain in here by matching nothing at all.
//
// RED ON MAIN: the closed-panel assertion and the wiring assertions all fail against main, where
// the section and the two-argument shellRoute call are exactly what ships.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const readAsset = (name: string) => readFileSync(join(HERE, "..", "public", name), "utf8");

describe("the front door always carries a way in (cp#428)", () => {
  const page = readAsset("index.html");

  it("CONTROL: the page is really there, which every assertion below depends on", () => {
    expect(page.length).toBeGreaterThan(2000);
    expect(page).toContain("<title>");
    expect(page).toContain("data-shell=\"auth\"");
  });

  it("has NO panel that replaces the signed-out screen when signups are closed", () => {
    // The lockout in one line: a route that is not "auth" hides the auth panel, and the auth
    // panel is the only thing that mounts a sign-in form.
    expect(page).not.toContain("signups-closed");
  });

  it("mounts the sign-in form inside the ONE signed-out panel", () => {
    const auth = page.slice(page.indexOf("data-shell=\"auth\""), page.indexOf("data-shell=\"link-sent\""));
    expect(auth).toContain("id=\"auth-methods\"");
    // Both copy variants live in the markup, so the switch can change the words without any
    // code path being able to remove the form along with them.
    for (const id of ["auth-title-open", "auth-lede-open", "auth-title-closed", "auth-lede-closed", "auth-open-note", "auth-closed-note"]) {
      expect(auth).toContain("id=\"" + id + "\"");
    }
  });

  it("keeps the closed-signups voice, without a paste-a-key or self-host pitch", () => {
    expect(page).toMatch(/not taking new studios/i);
    expect(page).not.toMatch(/paste a key/i);
    expect(page).not.toMatch(/The GPUs are yours/i);
    expect(page).toMatch(/We run the GPUs/i);
  });

  it("ships both first-run and returning-owner AUP copy (cp#452)", () => {
    expect(page).toContain("id=\"aup-title-first\"");
    expect(page).toContain("id=\"aup-title-returning\"");
    expect(page).toContain("id=\"aup-lede-first\"");
    expect(page).toContain("id=\"aup-lede-returning\"");
    expect(page).toMatch(/One thing before you start/);
    expect(page).toMatch(/The policy changed/);
    expect(page).toMatch(/Your studio keeps running/);
  });

  it("still says the SAME thing for every address after a sign-in attempt", () => {
    // Enumeration safety is not collateral of the fix: the link-sent screen is the single
    // answer for every outcome, and it must stay that way now that more people reach it.
    expect(page).toContain("data-shell=\"link-sent\"");
    expect(page).toMatch(/If that address can sign in/i);
    expect(page).toMatch(/whether or not an account exists/i);
  });
});

describe("front-door.js wires the switch to the COPY, never to the door", () => {
  const js = readAsset("front-door.js");

  it("CONTROL: the script is really there", () => {
    expect(js.length).toBeGreaterThan(2000);
    expect(js).toContain("checks.shellRoute(");
  });

  it("routes from the SESSION alone: the config never reaches shellRoute", () => {
    expect(js).toContain("checks.shellRoute(me)");
    expect(js).not.toContain("shellRoute(me, config)");
  });

  it("renders the sign-in methods on the signed-out route, and picks the copy separately", () => {
    expect(js).toContain("checks.signupsOpen(config)");
    expect(js).toContain("applySignedOutCopy");
    expect(js).toContain("renderAuthMethods(config.auth_methods)");
  });

  it("branches AUP copy on last_accepted (cp#452)", () => {
    expect(js).toContain("applyAupCopy(me)");
    expect(js).toContain("checks.aupCopyKind(me)");
  });
});

describe("the building panel re-checks state (cp#432)", () => {
  const page = readAsset("index.html");
  const js = readAsset("front-door.js");

  it("CONTROL: the building panel is in the shipped markup", () => {
    expect(page).toContain("data-shell=\"building\"");
    expect(js).toContain("checks.shouldWatch(route)");
  });

  it("does not tell the owner to leave the one page that can show progress", () => {
    expect(page).not.toMatch(/You can leave this page; it keeps going/i);
    expect(page).toMatch(/Stay on this page/i);
    expect(page).toMatch(/slower background job/i);
  });

  it("arms one interval on building/failed and refreshes on tab focus", () => {
    expect(js).toContain("setInterval");
    expect(js).toContain("startWatch");
    expect(js).toContain("stopWatch");
    expect(js).toContain("visibilitychange");
    // Replaced, not stacked: a second startWatch is a no-op while armed.
    expect(js).toContain("if (watchTimer !== null) return");
  });
});

describe("onboarding.js does not freeze an account that already exists (cp#428)", () => {
  const js = readAsset("onboarding.js");

  it("CONTROL: the script is really there and still reads the switch", () => {
    expect(js.length).toBeGreaterThan(2000);
    expect(js).toContain("cfg.signups_enabled === false");
  });

  it("consults the SESSION before disabling the flow", () => {
    // Disabling every [data-next] on a closed switch stranded the one person the plane
    // deliberately does not strand: provisioning gates on session plus accepted AUP only.
    // An operator-provisioned tenant reaches this page to hand over its render key.
    const guard = js.slice(js.indexOf("cfg.signups_enabled === false"), js.indexOf("cfg.signups_enabled === false") + 1200);
    expect(guard).toContain("PlatformApi.me()");
    expect(guard).toContain("if (signedOut)");
    // And the disable must sit INSIDE that guard, not beside it.
    expect(guard.indexOf("if (signedOut)")).toBeLessThan(guard.indexOf("b.disabled = true"));
  });
});
