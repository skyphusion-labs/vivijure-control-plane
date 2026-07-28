// The operator console (cp#89): its pure helpers, and the headers the document is served with.
//
// TWO THINGS ARE PROVEN HERE AND A THIRD IS NOT, said plainly so nobody reads more into a green run.
//   1. The PROJECTION. Every section, every scope checkbox and every per-tenant button is derived
//      from GET /api/admin/whoami. These tests drive the derivation with payloads shaped like the
//      real one and assert that a credential is never offered an action it cannot perform, and that
//      a scope the backend invents appears with no change to the frontend.
//   2. The HEADERS. The document response really carries the CSP, through the real router.
//   3. NOT PROVEN: the DOM wiring in admin.js. There is no browser in this suite and no build step
//      to introduce one, so admin.js is held to `node --check` plus the rule that all of its
//      decisions live in admin-checks.js, which is what these tests exercise. A DOM bug here would
//      be found by opening the page, and that is stated rather than papered over.

import { describe, expect, it } from "vitest";

import { handle, isOperatorConsoleDocument, withOperatorConsoleHeaders, ADMIN_REQUIREMENTS } from "../src/index";
import { OPERATOR_SCOPES, ALL_SCOPES } from "../src/operator-auth";
import type { ControlPlaneDeps } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import { MemoryStore } from "./memory-store";
import * as checks from "../public/admin-checks.js";
import type { WhoAmI } from "../public/admin-checks.js";

const ORIGIN = "https://studio.example.com";

/** The REAL catalogue, so a scope added to the backend flows into these tests automatically. */
const CATALOGUE = OPERATOR_SCOPES.map((s) => ({ id: s.id, summary: s.summary }));

/**
 * THE REAL AUTHORIZATION TABLE, serialised exactly as GET /api/admin/whoami serves it.
 *
 * This is what makes these tests worth running: the console's decision about whether to offer a
 * button is driven by the same rows the gate enforces, so a requirement changed server-side changes
 * this suite's answers without anyone editing a fixture. A hand-written fixture here would let the
 * UI and the gate drift while both stayed green.
 */
const REQUIREMENTS = ADMIN_REQUIREMENTS.map((r) => ({ method: r.method, pattern: r.pattern.source, requires: r.requires }));

const who = (over: Partial<WhoAmI> = {}): WhoAmI => ({
  actor: "operator:joan",
  kind: "credential",
  operator: "joan",
  credential_id: "opc_abc",
  scopes: ["tenants:read"],
  catalogue: CATALOGUE,
  requirements: REQUIREMENTS,
  ...over,
});

const ROOT = who({ actor: "admin-token", kind: "root", operator: null, credential_id: null, scopes: [...ALL_SCOPES] });

describe("the console is a projection of what the backend declares (cp#89)", () => {
  it("renders the WHOLE catalogue, marking what is held, not just what is held", () => {
    // An operator who cannot see what exists cannot ask for the right grant, and a missing button is
    // indistinguishable from a broken page.
    const rows = checks.scopeRows(who({ scopes: ["tenants:read", "credits:write"] }));
    expect(rows.length).toBe(CATALOGUE.length);
    expect(rows.filter((r) => r.held).map((r) => r.id)).toEqual(["tenants:read", "credits:write"]);
    expect(rows.every((r) => r.summary.length > 20)).toBe(true);
  });

  it("shows a scope the frontend has never heard of, because the list comes from the server", () => {
    const invented = who({
      scopes: ["tenants:read", "invented:scope"],
      catalogue: [...CATALOGUE, { id: "invented:scope", summary: "something the backend added after this page shipped" }],
    });
    const row = checks.scopeRows(invented).find((r) => r.id === "invented:scope");
    expect(row).toEqual({
      id: "invented:scope",
      summary: "something the backend added after this page shipped",
      held: true,
    });
  });

  it("hides a section whose every action would be refused, and shows it when the scope arrives", () => {
    const reader = checks.sectionsFor(who({ scopes: ["tenants:read"] }));
    expect(reader).toEqual({
      identity: true, tenants: true, audit: true, settings: false, credentials: false, breakGlassNotice: false,
    });

    // POSITIVE CONTROL for each negative above: the same function, the scope added, section appears.
    expect(checks.sectionsFor(who({ scopes: ["platform:settings"] })).settings).toBe(true);
    expect(checks.sectionsFor(ROOT).credentials).toBe(true);
  });

  it("REFUSES to drive routine work with the break-glass credential, offering only credential management", () => {
    // The merged privacy text says routine support access is made with a NAMED credential and that
    // the shared credential is "not used for routine support". The console is the routine path, so
    // this turns that sentence into a property of the tool rather than a claim about our habits.
    const sections = checks.sectionsFor(ROOT);
    expect(sections).toEqual({
      identity: true,
      tenants: false,
      audit: false,
      settings: false,
      credentials: true,
      breakGlassNotice: true,
    });

    // CONTROL: the identical scopes on a NAMED credential drive everything. That is what proves the
    // refusal is about the credential KIND rather than about the sections being broken.
    const named = who({ scopes: [...ALL_SCOPES] });
    const asNamed = checks.sectionsFor(named);
    expect(asNamed.tenants).toBe(true);
    expect(asNamed.audit).toBe(true);
    expect(asNamed.settings).toBe(true);
    expect(asNamed.breakGlassNotice).toBe(false);
    // ...and it still cannot manage credentials, which stays root-only.
    expect(asNamed.credentials).toBe(false);
  });

  it("does not merely HIDE root's tenant panel: it must not be loadable either", () => {
    // Hiding a panel while still fetching its data would write an access the console declined to
    // display, which is the worst of both. The section flags are what admin.js branches on for BOTH
    // rendering and loading, so a false here is a fetch that never happens.
    expect(checks.sectionsFor(ROOT).tenants).toBe(false);
    expect(checks.canCall(ROOT, "GET", "/api/admin/tenants")).toBe(true); // the API still allows it
  });

  it("NEVER offers the credentials section to a scoped credential holding EVERY scope", () => {
    // The escalation boundary, mirrored in the UI. The backend refuses this regardless; a console
    // that offered the button would just be teaching operators that the console is broken.
    const god = who({ scopes: [...ALL_SCOPES] });
    expect(checks.isRoot(god)).toBe(false);
    expect(checks.sectionsFor(god).credentials).toBe(false);
  });

  it("offers a tenant only the actions the credential can perform", () => {
    expect(checks.tenantActions(who({ scopes: ["tenants:read"] })).map((a) => a.id)).toEqual(["credits", "audit"]);
    expect(checks.tenantActions(who({ scopes: ["tenants:read", "tenants:write"] })).map((a) => a.id)).toEqual([
      "suspend", "resume", "credits", "audit",
    ]);
    expect(checks.tenantActions(who({ scopes: ["keys:rotate"] }))).toEqual([]);
  });

  it("every action names a route the SERVER's table actually gates: a typo would hide a button forever", () => {
    // The console derives each button's scope by asking the served table about the route it will
    // call. An action naming a path the table does not cover fails closed (no match = refused), so
    // the button would silently never appear. This is the check that catches that at build time.
    for (const action of checks.TENANT_ACTIONS) {
      const path = checks.actionPath(action, checks.PROBE_TENANT);
      const required = checks.requirementFor(ROOT, action.method, path);
      expect(required, `${action.id} -> ${action.method} ${path} is not in ADMIN_REQUIREMENTS`).not.toBeNull();
      expect(ALL_SCOPES as readonly string[], action.id).toContain(required as string);
    }
  });

  it("gating fails CLOSED on a route the table does not cover, exactly as the server does", () => {
    expect(checks.canCall(ROOT, "GET", "/api/admin/invented")).toBe(false);
    expect(checks.canCall(ROOT, "DELETE", "/api/admin/tenants")).toBe(false);
    // CONTROL: a route the table DOES cover is allowed for root, so the two falses above are about
    // the table rather than about canCall refusing everything.
    expect(checks.canCall(ROOT, "GET", "/api/admin/tenants")).toBe(true);
  });

  it("honours root-only exactly as the gate does: a full-scope credential is still refused the mint route", () => {
    const god = who({ scopes: [...ALL_SCOPES] });
    expect(checks.requirementFor(god, "POST", "/api/admin/operators")).toBe("root");
    expect(checks.canCall(god, "POST", "/api/admin/operators")).toBe(false);
    expect(checks.canCall(ROOT, "POST", "/api/admin/operators")).toBe(true);
  });

  it("whoami needs no scope, so a credential holding nothing useful can still identify itself", () => {
    const minimal = who({ scopes: [] });
    expect(checks.requirementFor(minimal, "GET", "/api/admin/whoami")).toBe("authenticated");
    expect(checks.canCall(minimal, "GET", "/api/admin/whoami")).toBe(true);
    expect(checks.canCall(null, "GET", "/api/admin/whoami")).toBe(false);
  });

  it("says out loud that the root credential names nobody", () => {
    expect(checks.principalLabel(ROOT)).toContain("names nobody");
    expect(checks.principalLabel(who())).toBe("joan (named credential opc_abc)");
    expect(checks.principalLabel(null)).toBe("not signed in");
  });

  it("nothing here carries its own copy of the scope list", async () => {
    // The projection rule as a FILE assertion, because a helpful future edit that inlines the scope
    // ids for convenience is exactly how a projection quietly becomes a parallel copy.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src: string = readFileSync(join(import.meta.dirname, "..", "public", "admin-checks.js"), "utf8");
    for (const scope of ALL_SCOPES) {
      expect(src.includes('"' + scope + '"'), `admin-checks.js hardcodes the scope ${scope}`).toBe(false);
    }
    // CONTROL: the assertion is not vacuous. The file really was read and really does mention scopes
    // as a concept, so "no scope id appears" is a finding about ids rather than about an empty read.
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("scopes");
  });
});

describe("audit rows are rendered honestly", () => {
  it("marks an unattributed row, which is the whole distinction cp#219 draws", () => {
    const rootRow = checks.auditRow({ id: 1, actor: "admin-token", action: "tenant.suspend", target: "ten_1", detail: null, created_at: "t" });
    expect(rootRow.attributed).toBe(false);
    const named = checks.auditRow({ id: 2, actor: "operator:joan", action: "tenant.suspend", target: "ten_1", detail: null, created_at: "t" });
    expect(named.attributed).toBe(true);
  });

  it("labels a per-tenant READ, which is the event the access disclosure is about", () => {
    expect(checks.auditRow({ action: "tenant.read.smoke_render_artifact" }).isTenantRead).toBe(true);
    expect(checks.auditRow({ action: "tenant.suspend" }).isTenantRead).toBe(false);
  });

  it("SHOWS a row whose detail will not parse, rather than dropping it", () => {
    // A row we cannot parse is still evidence that something happened. Hiding it is the one failure
    // mode an audit view must not have.
    const v = checks.auditRow({ id: 3, actor: "operator:joan", action: "x", target: null, detail: "{not json", created_at: "t" });
    expect(v.detail).toBe("{not json");
  });

  it("flattens a parseable detail into something readable", () => {
    const v = checks.auditRow({ detail: JSON.stringify({ operator_authenticated: "joan", reason: "comp" }) });
    expect(v.detail).toContain("operator_authenticated=joan");
    expect(v.detail).toContain("reason=comp");
  });
});

describe("mint form pre-validation (the server stays the authority)", () => {
  it("refuses the same shapes the server refuses, before a round trip", () => {
    expect(checks.mintPayload("", ["tenants:read"], "").ok).toBe(false);
    expect(checks.mintPayload("Joan", ["tenants:read"], "").ok).toBe(false);
    expect(checks.mintPayload("joan", [], "").ok).toBe(false);
    expect(checks.mintPayload("joan", ["tenants:read"], "0").ok).toBe(false);
    expect(checks.mintPayload("joan", ["tenants:read"], "1.5").ok).toBe(false);
    expect(checks.mintPayload("joan", ["tenants:read"], "4000").ok).toBe(false);
  });

  it("builds the payload, and omits expiry entirely when blank rather than sending a null", () => {
    const blank = checks.mintPayload("joan", ["tenants:read"], "");
    expect(blank).toEqual({ ok: true, payload: { name: "joan", scopes: ["tenants:read"] } });
    const dated = checks.mintPayload("joan", ["tenants:read"], "30");
    expect(dated).toEqual({ ok: true, payload: { name: "joan", scopes: ["tenants:read"], expires_in_days: 30 } });
  });

  it("prefers the SERVER's message over its own copy for a refusal", () => {
    expect(checks.errorCopy({ error: "invalid_scopes", message: "unknown scope(s) tenants:reed" }, 400)).toBe(
      "unknown scope(s) tenants:reed",
    );
    // Falls back to local copy only when the server sent none.
    expect(checks.errorCopy({ error: "root_credential_required" }, 403)).toContain("shared root credential");
    expect(checks.errorCopy(null, 500)).toContain("500");
  });
});

describe("credential state and the pasted credential", () => {
  it("computes live, revoked and expired in one place", () => {
    const now = "2026-07-28T00:00:00.000Z";
    expect(checks.credentialState({ revoked_at: null, expires_at: null }, now)).toBe("live");
    expect(checks.credentialState({ revoked_at: "2026-07-27T00:00:00.000Z", expires_at: null }, now)).toBe("revoked");
    expect(checks.credentialState({ revoked_at: null, expires_at: "2026-07-27T00:00:00.000Z" }, now)).toBe("expired");
    expect(checks.credentialState({ revoked_at: null, expires_at: "2026-07-29T00:00:00.000Z" }, now)).toBe("live");
  });

  it("hints at the SHAPE and never echoes the value", () => {
    const token = "a".repeat(64);
    const ok = checks.tokenShapeHint(token);
    expect(ok.level).toBe("ok");
    expect(ok.text).not.toContain(token);
    expect(ok.text).toContain("Only the server");

    const odd = checks.tokenShapeHint("short-secret-value");
    expect(odd.level).toBe("warn");
    expect(odd.text).not.toContain("short-secret-value");
    expect(checks.tokenShapeHint("")).toEqual({ level: "", text: "" });
  });
});

describe("the console document is served with a policy that bounds an injected script", () => {
  const env = () =>
    ({
      ASSETS: { fetch: async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }) } as unknown as Fetcher,
      CP_DB: {} as D1Database,
      AUP_VERSION: "1",
      AUP_URL: `${ORIGIN}/aup`,
      CONTROL_PLANE_HOST: "studio.example.com",
      CP_RATE_LIMIT: { limit: async () => ({ success: true }) },
    }) as unknown as ControlPlaneEnv;
  const ctx = { waitUntil: () => {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const deps = { store: new MemoryStore(), mailer: { send: async () => {} }, now: () => 1, fetch } as unknown as ControlPlaneDeps;

  it("serves the console with a CSP that blocks inline script and third-party connect", async () => {
    const res = await handle(new Request(`${ORIGIN}/admin.html`), env(), ctx, deps);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // No 'unsafe-inline' anywhere: the page has no inline script or style, and the day someone adds
    // one this fails rather than the policy being widened to accommodate it.
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("does NOT apply the policy to the rest of the front door", async () => {
    // NEGATIVE CONTROL for the test above: if the header were being set unconditionally, the
    // assertion above would pass while proving nothing about the path matching.
    const res = await handle(new Request(`${ORIGIN}/`), env(), ctx, deps);
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("matches the document and nothing else", () => {
    expect(isOperatorConsoleDocument("/admin")).toBe(true);
    expect(isOperatorConsoleDocument("/admin.html")).toBe(true);
    expect(isOperatorConsoleDocument("/admin.js")).toBe(false);
    expect(isOperatorConsoleDocument("/administrator")).toBe(false);
    expect(isOperatorConsoleDocument("/")).toBe(false);
  });

  it("builds a NEW response rather than mutating immutable asset headers", () => {
    // The failure this guards is production-only: an asset response's headers are immutable, so a
    // set() on them throws or no-ops depending on the runtime, and every test that built its own
    // mutable Response would still pass.
    const original = new Response("body", { headers: { "content-type": "text/html" } });
    const wrapped = withOperatorConsoleHeaders(original);
    expect(wrapped).not.toBe(original);
    expect(wrapped.headers.get("content-type")).toBe("text/html");
    expect(original.headers.get("content-security-policy")).toBeNull();
  });
});

describe("the page itself", () => {
  it("loads no third-party origin and carries no inline script or style, so the CSP is satisfiable", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const html: string = readFileSync(join(import.meta.dirname, "..", "public", "admin.html"), "utf8");
    expect(html.length).toBeGreaterThan(500);
    // An inline handler or a <style> block would be silently dead under this policy, which is worse
    // than a broken page: the feature simply would not work and nothing would say why.
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    // Every script and stylesheet is same-origin and relative.
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = m[1];
      if (ref.startsWith("http")) {
        // Documentation links are allowed; asset references are not.
        expect(ref, "asset loaded from a third-party origin").not.toMatch(/\.(js|css|woff2?|png|svg)$/);
      }
    }
  });
});
