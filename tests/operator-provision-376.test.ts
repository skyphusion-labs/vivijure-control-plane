// The operator-provisioned tenant (cp#376), end to end through the REAL router.
//
// WHAT IS REAL HERE, because on an authorization-plus-audit surface that is the whole value. The
// store is a D1Store over a REAL SQLite database built from the REAL migrations, so account
// creation, the one-tenant-per-account rule, the slug tiers and the admin_audit writes are
// exercised as SQL rather than as this file's idea of what that SQL does. A fake store here would
// encode my own assumptions about my own route and would agree with a bug.
//
// THE BIAS IS NEGATIVE. This route creates an account holder and spends provisioning resources on
// somebody else's behalf, so what matters is the set of things it REFUSES, and a suite built only
// from valid input cannot tell a working gate from an absent one. Every refusal below is watched
// firing AND has a positive control in the same test proving the instrument could have reported the
// other answer.
//
// THE CENTRAL CLAIM THIS FILE EXISTS TO PIN is not that the happy path works. It is that an
// operator-provisioned studio CANNOT become usable without the owner's own AUP acceptance. That is
// asserted structurally -- by driving the owner's real session against the real router before and
// after acceptance and watching two DIFFERENT named refusals -- rather than by asserting that some
// boolean is false.

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE, startSession } from "../src/auth";
import type { ControlPlaneDeps, ProvisionerWiring } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import { handle } from "../src/index";
import { ALL_SCOPES, type OperatorScope } from "../src/operator-auth";
import { D1Store } from "../src/store-d1";
import { d1Over, freshMigratedDb } from "./sqlite-d1";

const ORIGIN = "https://studio.example.com";
const ROOT_TOKEN = "r".repeat(64);
const NOW = 1_750_000_000_000;
const AUP_VERSION = "2026-07-17";
const AUP_TEXT = "No CSAM. Ever. This is the acceptable use policy text.";
const OWNER = "owner@example.com";

const env = (over: Partial<ControlPlaneEnv> = {}): ControlPlaneEnv =>
  ({
    CP_DB: {} as D1Database,
    AUP_VERSION,
    AUP_URL: `${ORIGIN}/aup`,
    CONTROL_PLANE_HOST: "studio.example.com",
    CONTROL_PLANE_ADMIN_TOKEN: ROOT_TOKEN,
    CP_RATE_LIMIT: { limit: async () => ({ success: true }) },
    ...over,
  }) as ControlPlaneEnv;

let pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (p: Promise<unknown>) => void pending.push(p),
  passThroughOnException() {},
} as unknown as ExecutionContext;
const flush = async () => {
  await Promise.all(pending);
  pending = [];
};

const req = (path: string, init: RequestInit = {}) =>
  new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { origin: ORIGIN, ...(init.headers as Record<string, string>) },
  });
const jsonReq = (path: string, body: unknown, init: RequestInit = {}) =>
  req(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, ...init });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * A DELIBERATELY MINIMAL provisioner double: exactly the three members operatorProvision reaches.
 *
 * routes.test.ts builds a complete WiringDouble mapped over `keyof ProvisionerWiring` so widening
 * the seam fails at typecheck (cp#307). That is right for a file that drives many routes. Here a
 * complete double would imply this suite exercises members it never touches, and the three below
 * are the whole reachable surface of the route under test -- so the narrowness is the honest
 * statement of coverage rather than a shortcut.
 */
function wiring(over: { offersSharedTier?: boolean } = {}) {
  return {
    start: vi.fn(async () => {}),
    offersSharedTier: vi.fn(() => over.offersSharedTier ?? true),
    currentRelease: vi.fn(() => "v1.9.9"),
  };
}

describe("operator-provisioned tenant (cp#376)", () => {
  let db: DatabaseSync;
  let store: D1Store;
  let deps: ControlPlaneDeps;
  let wire: ReturnType<typeof wiring>;

  beforeEach(async () => {
    pending = [];
    db = freshMigratedDb();
    store = new D1Store(d1Over(db));
    wire = wiring();
    deps = {
      store,
      credits: store,
      mailer: { send: async () => {} },
      fetch: vi.fn(async () => new Response(AUP_TEXT)) as unknown as typeof fetch,
      now: () => NOW,
      provisioner: wire as unknown as ProvisionerWiring,
    } as unknown as ControlPlaneDeps;
    // Signups CLOSED for every test in this file. That is the whole point of the route: it must
    // work here, and the front door must stay shut. Both halves are asserted below.
    await store.setSetting("signups_enabled", "false", "test");
  });

  /** Mint a scoped credential through the REAL route, as root, and hand back its one-time token. */
  async function mint(name: string, scopes: OperatorScope[]) {
    const res = await handle(
      jsonReq("/api/admin/operators", { name, scopes }, { headers: bearer(ROOT_TOKEN) }),
      env(),
      ctx,
      deps,
    );
    const body = (await res.json()) as { token: string };
    return body.token;
  }

  const provision = (token: string, body: unknown) =>
    handle(jsonReq("/api/admin/tenants/provision", body, { headers: bearer(token) }), env(), ctx, deps);

  const ok = (token: string, over: Record<string, unknown> = {}) =>
    provision(token, { email: OWNER, slug: "hero", ...over });

  const accounts = () => db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number };
  const tenants = () => db.prepare("SELECT COUNT(*) AS n FROM tenants").get() as { n: number };

  // ---- SCOPE: this capability is implied by nothing ---------------------------------------------

  describe("scope", () => {
    it("is refused to a credential holding EVERY OTHER SCOPE, and granted by tenants:provision", async () => {
      // DERIVED, not a hand-written list: every scope in the catalogue except this one. A literal
      // list here would silently stop covering a scope added later, which is exactly the drift the
      // route's own comment argues about.
      const others = ALL_SCOPES.filter((s) => s !== "tenants:provision");
      expect(others.length).toBe(ALL_SCOPES.length - 1);
      expect(others).not.toContain("tenants:provision");

      const almighty = await mint("almighty", [...others]);
      const refused = await ok(almighty);
      expect(refused.status).toBe(403);
      expect((await refused.json()) as { error: string; required: string }).toMatchObject({
        error: "insufficient_scope",
        required: "tenants:provision",
      });
      // Nothing was created by the refusal.
      expect(accounts().n).toBe(0);
      expect(tenants().n).toBe(0);

      // POSITIVE CONTROL: the same call, the same everything, with the one scope it lacked.
      const provisioner = await mint("prov", ["tenants:provision"]);
      expect((await ok(provisioner)).status).toBe(202);
    });

    it("is refused without a bearer at all, and root still holds it", async () => {
      expect((await handle(jsonReq("/api/admin/tenants/provision", {}), env(), ctx, deps)).status).toBe(401);
      // POSITIVE CONTROL: root holds every scope, so it reaches the handler and gets a 202.
      expect((await ok(ROOT_TOKEN)).status).toBe(202);
    });
  });

  // ---- THE AUP IS NOT WAIVED AND NOT ASSERTED ---------------------------------------------------

  describe("the AUP", () => {
    it("records NO acceptance for the account it creates, and leaves the tenant short of live", async () => {
      const res = await ok(ROOT_TOKEN);
      expect(res.status).toBe(202);
      const body = (await res.json()) as { account_id: string; tenant_id: string; aup_accepted: boolean };
      expect(body.aup_accepted).toBe(false);

      // The acceptance table is the authority, not the response field.
      expect(await store.hasAcceptedAup(body.account_id, AUP_VERSION)).toBe(false);

      // POSITIVE CONTROL for that reader: after a real acceptance it answers true, so the false
      // above is a real absence rather than a reader that always says no.
      await store.recordAupAcceptance(body.account_id, AUP_VERSION, "sha", null, null);
      expect(await store.hasAcceptedAup(body.account_id, AUP_VERSION)).toBe(true);

      const tenant = await store.getTenantById(body.tenant_id);
      expect(tenant?.status).not.toBe("live");
      expect(tenant?.live_at).toBe(null);
    });

    it("BLOCKS the owner's own promotion path until the owner accepts, and lets it through after", async () => {
      // THIS IS THE CENTRAL ASSERTION OF THE FILE. The only route that promotes a tenant to live is
      // POST /api/tenant/<ten>/invoke-key, which sits below the blocking AUP gate. Drive it as the
      // real owner, over the real router, before and after acceptance, and watch the refusal CHANGE.
      const res = await ok(ROOT_TOKEN);
      const { account_id, tenant_id } = (await res.json()) as { account_id: string; tenant_id: string };

      const { token } = await startSession(store, account_id, NOW);
      const asOwner = () =>
        handle(
          jsonReq(`/api/tenant/${tenant_id}/invoke-key`, {}, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
          env(),
          ctx,
          deps,
        );

      const before = await asOwner();
      expect(before.status).toBe(403);
      expect(((await before.json()) as { error: string }).error).toBe("aup_required");

      // The owner accepts, themselves, through the real route.
      const accept = await handle(
        jsonReq("/api/aup/accept", { version: AUP_VERSION }, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
        env(),
        ctx,
        deps,
      );
      expect(accept.status).toBe(204);

      // AFTER: a DIFFERENT refusal. Reaching the handler is the claim; what the handler then wants
      // (a key, because this double never ran the job that stamps runpod_mode) is not. Asserting a
      // different NAMED error rather than "not 403" is what makes this a discrimination instead of
      // a check that passes in both worlds.
      const after = await asOwner();
      const afterBody = (await after.json()) as { error: string };
      expect(afterBody.error).not.toBe("aup_required");
      expect(after.status).not.toBe(403);
    });
  });

  // ---- SHARED TIER, NO KEY, EVER ----------------------------------------------------------------

  describe("shared tier", () => {
    it("hands the provisioner a NULL key and records the job as shared", async () => {
      const res = await ok(ROOT_TOKEN);
      expect(res.status).toBe(202);
      const body = (await res.json()) as { tenant_id: string; job_id: string; runpod_mode: string };
      expect(body.runpod_mode).toBe("shared");
      await flush();

      // The strongest available evidence that no RunPod key was issued on our account: the value
      // the runner was actually handed.
      expect(wire.start).toHaveBeenCalledTimes(1);
      const [jobId, tenant, key] = wire.start.mock.calls[0] as unknown as [string, { id: string }, string | null];
      expect(jobId).toBe(body.job_id);
      expect(tenant.id).toBe(body.tenant_id);
      expect(key).toBe(null);

      // And the durable record agrees with what was handed over.
      const job = await store.getLatestJobForTenant(body.tenant_id);
      expect(job?.runpod_mode).toBe("shared");
    });

    it("REFUSES a body carrying a runpod_api_key and creates nothing", async () => {
      const res = await ok(ROOT_TOKEN, { runpod_api_key: "rpa_operator_should_not_do_this" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("runpod_key_not_accepted");
      expect(accounts().n).toBe(0);
      expect(tenants().n).toBe(0);
      expect(wire.start).not.toHaveBeenCalled();

      // POSITIVE CONTROL: the identical call minus that one field is accepted, so the 400 is about
      // the key and not about anything else in the body.
      expect((await ok(ROOT_TOKEN)).status).toBe(202);
      expect(accounts().n).toBe(1);
    });

    it("REFUSES on a plane with no shared tier rather than asking for a key it cannot accept", async () => {
      const noPool = wiring({ offersSharedTier: false });
      const res = await handle(
        jsonReq("/api/admin/tenants/provision", { email: OWNER, slug: "hero" }, { headers: bearer(ROOT_TOKEN) }),
        env(),
        ctx,
        { ...deps, provisioner: noPool as unknown as ProvisionerWiring },
      );
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("shared_tier_unavailable");
      expect(tenants().n).toBe(0);

      // POSITIVE CONTROL: the same call on a plane that DOES offer the tier is accepted.
      expect((await ok(ROOT_TOKEN)).status).toBe(202);
    });
  });

  // ---- AUDIT ------------------------------------------------------------------------------------

  describe("audit (cp#219)", () => {
    it("records the AUTHENTICATED operator on both the request and the completion", async () => {
      const token = await mint("joan", ["tenants:provision"]);
      const res = await ok(token);
      const { tenant_id, account_id } = (await res.json()) as { tenant_id: string; account_id: string };

      const trail = await store.listAdminAudit({ limit: 50 });
      const mine = trail.filter((r) => r.action.startsWith("tenant.operator_provision"));
      expect(mine.map((r) => r.action).sort()).toEqual([
        "tenant.operator_provision",
        "tenant.operator_provision.requested",
      ]);
      // A NAME, authenticated, never the literal "admin-token" and never a claim typed into a form.
      expect(mine.every((r) => r.actor === "operator:joan")).toBe(true);

      const requested = mine.find((r) => r.action === "tenant.operator_provision.requested");
      expect(requested?.target).toBe(OWNER);

      const done = mine.find((r) => r.action === "tenant.operator_provision");
      expect(done?.target).toBe(tenant_id);
      expect(JSON.parse(done?.detail ?? "{}")).toMatchObject({
        email: OWNER,
        slug: "hero",
        account_id,
        account_created: true,
        runpod_mode: "shared",
      });
    });

    it("FAILS THE OPERATION when the audit write fails, leaving no account behind", async () => {
      // The requirement is that a failed audit fails the operation, and the ONLY ordering that
      // delivers it is audit-first. This test is what distinguishes that ordering from the
      // write-then-audit shape every other route here uses: under write-then-audit the account
      // would exist and this assertion would go red.
      const failing = new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === "recordAdminAction") {
            return async () => {
              throw new Error("admin_audit is unwritable");
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as D1Store;

      const res = await handle(
        jsonReq("/api/admin/tenants/provision", { email: OWNER, slug: "hero" }, { headers: bearer(ROOT_TOKEN) }),
        env(),
        ctx,
        { ...deps, store: failing },
      );
      expect(res.status).toBe(500);
      expect(accounts().n).toBe(0);
      expect(tenants().n).toBe(0);
      expect(wire.start).not.toHaveBeenCalled();

      // POSITIVE CONTROL: the same call against the unproxied store succeeds, so the 500 is the
      // audit failure and not something else about this request.
      expect((await ok(ROOT_TOKEN)).status).toBe(202);
      expect(accounts().n).toBe(1);
    });
  });

  // ---- THE FRONT DOOR STAYS SHUT ----------------------------------------------------------------

  describe("signups", () => {
    it("provisions with signups CLOSED without opening public registration", async () => {
      expect(await store.getSetting("signups_enabled")).toBe("false");

      // The operator route works.
      expect((await ok(ROOT_TOKEN)).status).toBe(202);
      expect(accounts().n).toBe(1);

      // NEGATIVE CONTROL, and it is the reason this route exists rather than a signups toggle: the
      // PUBLIC path for a DIFFERENT address still creates nothing. A magic-link start always
      // answers 202 (it must not be an enumeration oracle), so the assertion is on the accounts
      // table, which is the only thing that can tell the two apart.
      const start = await handle(
        jsonReq("/api/auth/email/start", { email: "stranger@example.com" }, {}),
        env(),
        ctx,
        deps,
      );
      expect(start.status).toBe(202);
      await flush();
      expect(accounts().n).toBe(1);
    });
  });

  // ---- ORDINARY REFUSALS ------------------------------------------------------------------------

  describe("refusals", () => {
    it("refuses a second studio for the same account", async () => {
      expect((await ok(ROOT_TOKEN)).status).toBe(202);
      const again = await ok(ROOT_TOKEN, { slug: "second" });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toBe("tenant_exists");
      expect(tenants().n).toBe(1);
    });

    it("refuses a slug another account already holds", async () => {
      expect((await ok(ROOT_TOKEN)).status).toBe(202);
      const clash = await ok(ROOT_TOKEN, { email: "other@example.com" });
      expect(clash.status).toBe(409);
      expect(((await clash.json()) as { error: string }).error).toBe("slug_taken");
      expect(tenants().n).toBe(1);
    });

    it("refuses a malformed email and a malformed slug, and creates nothing either way", async () => {
      expect((await ok(ROOT_TOKEN, { email: "not-an-email" })).status).toBe(400);
      expect((await ok(ROOT_TOKEN, { slug: "Not A Slug" })).status).toBe(400);
      expect(accounts().n).toBe(0);
      expect(tenants().n).toBe(0);
      // POSITIVE CONTROL: well-formed input through the same route is accepted.
      expect((await ok(ROOT_TOKEN)).status).toBe(202);
    });

    it("refuses an address whose account is suspended, and does not resurrect it", async () => {
      // SYNTHETIC FIXTURE, LABELLED. Measured on this tree: `UPDATE accounts` appears ZERO times in
      // src/ (positive control: `UPDATE tenants` appears 22 times in store-d1.ts alone, so the
      // matcher works and the zero is real), while accounts.suspended_at is READ in 22 places
      // including upsertAccountForVerifiedEmail. Nothing in the control plane can suspend or delete
      // an account today, so this state is reachable only by an out-of-band write, which is exactly
      // what this sets up. The branch under test is NOT synthetic: upsertAccountForVerifiedEmail
      // returns `unavailable` for such a row and this route has to answer it, so the handling is on
      // a live code path whether or not the plane can currently produce the input.
      const acct = await store.createAccount("acct_susp", OWNER);
      db.prepare("UPDATE accounts SET suspended_at = ?1, suspended_reason = ?2 WHERE id = ?3").run(
        new Date(NOW).toISOString(),
        "abuse",
        acct.id,
      );
      const res = await ok(ROOT_TOKEN);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("account_unavailable");
      expect(tenants().n).toBe(0);
    });
  });
});
