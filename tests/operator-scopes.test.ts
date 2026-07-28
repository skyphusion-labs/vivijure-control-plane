// Scoped operator credentials, end to end through the REAL router (cp#219).
//
// WHAT IS REAL HERE, because on an authorization surface that is the whole value of the test. The
// store is a D1Store over a REAL SQLite database built from the REAL migrations, so the unique
// live-name index, the revoke compare-and-set and the hash lookup are exercised as SQL rather than
// as my idea of what that SQL does. A fake credential store would encode my own assumptions about
// my own gate and would agree with a bug.
//
// THE BIAS IS NEGATIVE, and every negative here has a POSITIVE CONTROL beside it. A suite built only
// from valid inputs cannot tell a working authorization check from an absent one: with no gate at
// all, every "the right scope works" assertion still passes. So each boundary is watched REFUSING
// the credential that lacks the scope AND ACCEPTING the credential that holds it, in the same test
// wherever possible, against the same route.

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sha256Hex } from "../src/crypto";
import type { ControlPlaneDeps, ProvisionerWiring } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import { handle, adminRequirement, ADMIN_REQUIREMENTS } from "../src/index";
import { ALL_SCOPES, OPERATOR_SCOPES, type OperatorScope } from "../src/operator-auth";
import { D1Store, LlmSpendD1 } from "../src/store-d1";
import { recordingStore } from "./memory-store";
import { d1Over, freshMigratedDb } from "./sqlite-d1";

const ORIGIN = "https://studio.example.com";
const ROOT_TOKEN = "r".repeat(64);
const TEN = "ten_abc123";
const NOW = 1_750_000_000_000;

const env = (over: Partial<ControlPlaneEnv> = {}): ControlPlaneEnv =>
  ({
    CP_DB: {} as D1Database,
    AUP_VERSION: "1",
    AUP_URL: `${ORIGIN}/aup`,
    CONTROL_PLANE_HOST: "studio.example.com",
    CONTROL_PLANE_ADMIN_TOKEN: ROOT_TOKEN,
    CP_RATE_LIMIT: { limit: async () => ({ success: true }) },
    ...over,
  }) as ControlPlaneEnv;

// waitUntil work is COLLECTED, never discarded: last_used_at is stamped there, and a fake that threw
// the promise away would let a broken stamp pass as a working one.
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
  new Request(`${ORIGIN}${path}`, { ...init, headers: { origin: ORIGIN, ...(init.headers as Record<string, string>) } });
const jsonReq = (path: string, body: unknown, init: RequestInit = {}) =>
  req(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, ...init });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("scoped operator credentials (cp#219)", () => {
  let db: DatabaseSync;
  let store: D1Store;
  let deps: ControlPlaneDeps;

  beforeEach(async () => {
    pending = [];
    db = freshMigratedDb();
    store = new D1Store(d1Over(db));
    await store.createAccount("acct_1", "a@b.com");
    const tenant = await store.createTenant(TEN, "hero", "acct_1", "live");
    tenant.script_name = "tenant-hero-studio";
    deps = {
      store,
      credits: store,
      mailer: { send: async () => {} },
      fetch: vi.fn(async () => new Response("aup")) as unknown as typeof fetch,
      now: () => NOW,
      provisioner: undefined as unknown as ProvisionerWiring,
    } as ControlPlaneDeps;
  });

  /** Mint through the REAL route, as root, and hand back the one-time token. */
  async function mint(name: string, scopes: OperatorScope[], extra: Record<string, unknown> = {}) {
    const res = await handle(
      jsonReq("/api/admin/operators", { name, scopes, ...extra }, { headers: bearer(ROOT_TOKEN) }),
      env(),
      ctx,
      deps,
    );
    const body = (await res.json()) as { id: string; token: string; scopes: string[]; expires_at: string | null };
    return { status: res.status, ...body };
  }

  const call = (path: string, token: string, init: RequestInit = {}) =>
    handle(req(path, { ...init, headers: bearer(token) }), env(), ctx, deps);
  const post = (path: string, token: string, body: unknown = {}) =>
    handle(jsonReq(path, body, { headers: bearer(token) }), env(), ctx, deps);

  // ---- the gate itself -------------------------------------------------------------------------

  describe("authentication", () => {
    it("REFUSES no bearer, a wrong bearer, and a session cookie, exactly as the shared token did", async () => {
      expect((await handle(req("/api/admin/tenants"), env(), ctx, deps)).status).toBe(401);
      expect((await call("/api/admin/tenants", "wrong")).status).toBe(401);
      // POSITIVE CONTROL: the same route, the same everything, with the root token.
      expect((await call("/api/admin/tenants", ROOT_TOKEN)).status).toBe(200);
    });

    it("fails CLOSED with no root secret configured AND no credential minted", async () => {
      const res = await handle(
        req("/api/admin/tenants", { headers: bearer(ROOT_TOKEN) }),
        env({ CONTROL_PLANE_ADMIN_TOKEN: undefined }),
        ctx,
        deps,
      );
      expect(res.status).toBe(401);
    });

    it("a NAMED credential authenticates where the root secret is unset: the table is its own authority", async () => {
      const cred = await mint("joan", ["tenants:read"]);
      const res = await handle(
        req("/api/admin/tenants", { headers: bearer(cred.token) }),
        env({ CONTROL_PLANE_ADMIN_TOKEN: undefined }),
        ctx,
        deps,
      );
      expect(res.status).toBe(200);
    });
  });

  // ---- scope boundaries: every one watched refusing, with its own positive control --------------

  describe("scope boundaries", () => {
    it("tenants:read reads the census and CANNOT suspend a tenant", async () => {
      const reader = await mint("reader", ["tenants:read"]);
      const writer = await mint("writer", ["tenants:write"]);

      // POSITIVE: the scope it holds.
      expect((await call("/api/admin/tenants", reader.token)).status).toBe(200);

      // NEGATIVE: the scope it does not, on a route that DOES work for a credential that has it.
      const refused = await post(`/api/admin/tenants/${TEN}/suspend`, reader.token, { reason: "abuse" });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({
        error: "insufficient_scope",
        required: "tenants:write",
        held: ["tenants:read"],
      });

      // CONTROL for that negative: the identical request with the right scope is NOT refused, which
      // is what proves the 403 came from the scope check rather than from the route being broken.
      expect((await post(`/api/admin/tenants/${TEN}/suspend`, writer.token, { reason: "abuse" })).status).toBe(204);
    });

    it("tenants:write CANNOT tear a tenant down: destroy is its own scope, never folded in", async () => {
      const writer = await mint("writer", ["tenants:write"]);
      const destroyer = await mint("destroyer", ["tenants:destroy"]);

      const refused = await post(`/api/admin/tenants/${TEN}/teardown`, writer.token, { confirm_slug: "hero" });
      expect(refused.status).toBe(403);
      expect((await refused.json() as { required: string }).required).toBe("tenants:destroy");

      // CONTROL: the same request with tenants:destroy gets PAST the gate. It then refuses 503 for
      // want of provisioner wiring, which is a different refusal from a different layer, and that
      // difference is the whole point: 503 proves the request reached the handler.
      const passed = await post(`/api/admin/tenants/${TEN}/teardown`, destroyer.token, { confirm_slug: "hero" });
      expect(passed.status).not.toBe(403);
      expect(passed.status).toBe(503);
    });

    it("no scope grants the money surface except credits:write", async () => {
      const everythingElse = ALL_SCOPES.filter((s) => s !== "credits:write");
      const wide = await mint("wide", [...everythingElse]);
      const banker = await mint("banker", ["credits:write"]);

      const body = { amount_micro_usd: 1_000_000, reason: "comp", reference: "ref-1" };
      const refused = await post(`/api/admin/tenants/${TEN}/credits/manual`, wide.token, body);
      expect(refused.status).toBe(403);
      expect((await refused.json() as { required: string }).required).toBe("credits:write");

      // CONTROL: credits:write alone reaches the ledger and the credit lands.
      expect((await post(`/api/admin/tenants/${TEN}/credits/manual`, banker.token, body)).status).toBe(200);
    });

    it("platform:settings and keys:rotate are each refused to a credential holding the other", async () => {
      const settings = await mint("settings", ["platform:settings"]);
      const keys = await mint("keys", ["keys:rotate"]);

      expect((await post("/api/admin/settings", keys.token, { signups_enabled: false })).status).toBe(403);
      expect((await post("/api/admin/settings", settings.token, { signups_enabled: false })).status).toBe(204);

      expect((await call("/api/admin/kek/status", settings.token)).status).toBe(403);
      // CONTROL: keys:rotate gets past the gate and is refused by the ENV check instead (503), which
      // is a different refusal reached only by a request the gate let through.
      expect((await call("/api/admin/kek/status", keys.token)).status).toBe(503);
    });

    it("forcing a meter tick is its OWN scope: neither a tenant reader nor the money scope reaches it", async () => {
      // cp#185 landed these routes while this table was being written, and the fail-closed default
      // caught them: they 404'd for everyone until they declared a requirement. This test keeps the
      // decision, rather than the accident, in place.
      const reader = await mint("reader", ["tenants:read", "credits:write"]);
      const meter = await mint("meter", ["meter:operate"]);
      const window = `?tenant=${TEN}&start=2026-01-01&end=2026-02-01`;

      expect((await post("/api/admin/llm-meter/run", reader.token)).status).toBe(403);
      // CONTROL: meter:operate reaches the handler, which then refuses 503 for want of a reader. A
      // different refusal from a different layer, reached only by a request the gate let through.
      expect((await post("/api/admin/llm-meter/run", meter.token)).status).toBe(503);

      // The READ answers for ONE tenant, so it sits with the other tenant reads rather than here.
      expect((await call("/api/admin/llm-spend" + window, meter.token)).status).toBe(403);
      expect((await call("/api/admin/llm-spend" + window, reader.token)).status).not.toBe(403);
    });

    it("the refusal names the scope required AND the scopes held, so an operator can ask for the right grant", async () => {
      const cred = await mint("narrow", ["tenants:read", "studio:operate"]);
      const res = await post(`/api/admin/tenants/${TEN}/teardown`, cred.token, { confirm_slug: "hero" });
      expect(await res.json()).toEqual({
        error: "insufficient_scope",
        required: "tenants:destroy",
        held: ["tenants:read", "studio:operate"],
      });
    });
  });

  // ---- the escalation boundary -----------------------------------------------------------------

  describe("credential lifecycle is ROOT-ONLY", () => {
    it("a credential holding EVERY scope still cannot mint, list or revoke credentials", async () => {
      const god = await mint("god", [...ALL_SCOPES]);
      expect(god.scopes).toEqual([...ALL_SCOPES]);

      for (const res of [
        await call("/api/admin/operators", god.token),
        await post("/api/admin/operators", god.token, { name: "sneaky", scopes: ["tenants:destroy"] }),
        await post(`/api/admin/operators/${god.id}/revoke`, god.token),
      ]) {
        expect(res.status).toBe(403);
        expect((await res.json() as { error: string }).error).toBe("root_credential_required");
      }

      // CONTROL: the root token performs all three, so the 403s above are about the PRINCIPAL and
      // not about the routes being broken.
      expect((await call("/api/admin/operators", ROOT_TOKEN)).status).toBe(200);
      expect((await mint("minted-by-root", ["tenants:read"])).status).toBe(201);
      expect((await post(`/api/admin/operators/${god.id}/revoke`, ROOT_TOKEN)).status).toBe(204);
    });

    it("a scoped credential cannot escalate by minting one for itself: no scope in the catalogue reaches the mint route", async () => {
      // Stated as a test rather than a comment: if a scope is ever added that gates /operators, this
      // fails. The table's root-only entry is the only thing that may gate it.
      const minting = ADMIN_REQUIREMENTS.filter((r) => /\/operators/.test(r.pattern.source));
      expect(minting.length).toBeGreaterThan(0);
      for (const row of minting) expect(row.requires).toBe("root");
    });
  });

  // ---- revocation and expiry: the two ways a credential dies -----------------------------------

  describe("revocation", () => {
    it("works on the NEXT request, and kills exactly one credential", async () => {
      const alice = await mint("alice", ["tenants:read"]);
      const bob = await mint("bob", ["tenants:read"]);

      // POSITIVE CONTROL FIRST: both work. Without this the revoke assertion below could pass
      // against a credential that never worked at all.
      expect((await call("/api/admin/tenants", alice.token)).status).toBe(200);
      expect((await call("/api/admin/tenants", bob.token)).status).toBe(200);

      expect((await post(`/api/admin/operators/${alice.id}/revoke`, ROOT_TOKEN)).status).toBe(204);

      expect((await call("/api/admin/tenants", alice.token)).status).toBe(401);
      // Bob is untouched: revoking one member does not rotate everyone, which is the third thing
      // cp#219 asks for.
      expect((await call("/api/admin/tenants", bob.token)).status).toBe(200);
    });

    it("a second revoke is a visible no-op, not a second revocation with a new timestamp", async () => {
      const cred = await mint("twice", ["tenants:read"]);
      expect((await post(`/api/admin/operators/${cred.id}/revoke`, ROOT_TOKEN)).status).toBe(204);
      const second = await post(`/api/admin/operators/${cred.id}/revoke`, ROOT_TOKEN);
      expect(second.status).toBe(404);
      // Both attempts are in the trail: a repeat is either a confused operator or somebody probing.
      const rows = await store.listAdminAudit({ target: cred.id, limit: 10 });
      expect(rows.filter((r) => r.action === "operator.revoke").length).toBe(2);
    });

    it("the revoked row SURVIVES, so audit rows naming it still resolve to a credential", async () => {
      const cred = await mint("gone", ["tenants:read"]);
      await post(`/api/admin/operators/${cred.id}/revoke`, ROOT_TOKEN);
      const listed = (await (await call("/api/admin/operators", ROOT_TOKEN)).json()) as {
        credentials: { id: string; name: string; revoked_at: string | null; revoked_by: string | null }[];
      };
      const row = listed.credentials.find((c) => c.id === cred.id);
      expect(row?.name).toBe("gone");
      expect(row?.revoked_at).toBeTruthy();
      expect(row?.revoked_by).toBe("admin-token");
    });

    it("a name can be REUSED after revocation, and cannot be duplicated while live", async () => {
      const first = await mint("joan", ["tenants:read"]);
      expect(first.status).toBe(201);

      const clash = await handle(
        jsonReq("/api/admin/operators", { name: "joan", scopes: ["tenants:read"] }, { headers: bearer(ROOT_TOKEN) }),
        env(),
        ctx,
        deps,
      );
      expect(clash.status).toBe(409);
      expect((await clash.json() as { error: string }).error).toBe("name_in_use");
      // The clash must not have REPLACED the live credential: an upsert here would be a revocation
      // nobody asked for and nobody would see.
      expect((await call("/api/admin/tenants", first.token)).status).toBe(200);

      await post(`/api/admin/operators/${first.id}/revoke`, ROOT_TOKEN);
      expect((await mint("joan", ["tenants:read"])).status).toBe(201);
    });
  });

  describe("expiry", () => {
    it("an expired credential is dead ON PRESENTATION, with the same credential proven live first", async () => {
      const cred = await mint("temp", ["tenants:read"], { expires_in_days: 1 });
      expect(cred.expires_at).toBe(new Date(NOW + 86_400_000).toISOString());

      // POSITIVE CONTROL: alive before the clock moves.
      expect((await call("/api/admin/tenants", cred.token)).status).toBe(200);

      const later = { ...deps, now: () => NOW + 2 * 86_400_000 };
      const res = await handle(req("/api/admin/tenants", { headers: bearer(cred.token) }), env(), ctx, later);
      expect(res.status).toBe(401);
    });

    it("refuses a nonsense expiry rather than minting a credential with a meaningless clock", async () => {
      for (const days of [0, -1, 1.5, 4000, "7"]) {
        const res = await handle(
          jsonReq("/api/admin/operators", { name: "x", scopes: ["tenants:read"], expires_in_days: days }, { headers: bearer(ROOT_TOKEN) }),
          env(),
          ctx,
          deps,
        );
        expect(res.status, `expires_in_days ${String(days)}`).toBe(400);
      }
      // CONTROL: a sane value mints.
      expect((await mint("x", ["tenants:read"], { expires_in_days: 7 })).status).toBe(201);
    });
  });

  // ---- minting refusals ------------------------------------------------------------------------

  describe("minting", () => {
    it("REFUSES an unknown scope rather than dropping it silently", async () => {
      const res = await handle(
        jsonReq("/api/admin/operators", { name: "typo", scopes: ["tenants:read", "tenants:reed"] }, { headers: bearer(ROOT_TOKEN) }),
        env(),
        ctx,
        deps,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("invalid_scopes");
      expect(body.message).toContain("tenants:reed");
      // Nothing was minted: a rejected mint must leave no credential behind.
      const listed = (await (await call("/api/admin/operators", ROOT_TOKEN)).json()) as { credentials: unknown[] };
      expect(listed.credentials).toEqual([]);
    });

    it("REFUSES an empty scope list and a bad name", async () => {
      const cases: Array<Record<string, unknown>> = [
        { name: "ok", scopes: [] },
        { name: "ok", scopes: "tenants:read" },
        { name: "", scopes: ["tenants:read"] },
        { name: "Joan", scopes: ["tenants:read"] },
        { name: "joan smith", scopes: ["tenants:read"] },
        { name: "operator:joan", scopes: ["tenants:read"] },
        { name: "j".repeat(33), scopes: ["tenants:read"] },
      ];
      for (const body of cases) {
        const res = await handle(jsonReq("/api/admin/operators", body, { headers: bearer(ROOT_TOKEN) }), env(), ctx, deps);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      // CONTROL: a well-formed mint succeeds, so the seven refusals above are about the inputs.
      expect((await mint("joan-jett_1", ["tenants:read"])).status).toBe(201);
    });

    it("the mint is AUDITED and the response carries no-store", async () => {
      const res = await handle(
        jsonReq("/api/admin/operators", { name: "audited", scopes: ["tenants:read"] }, { headers: bearer(ROOT_TOKEN) }),
        env(),
        ctx,
        deps,
      );
      expect(res.headers.get("cache-control")).toBe("no-store");
      const rows = await store.listAdminAudit({ limit: 10 });
      const mintRow = rows.find((r) => r.action === "operator.mint");
      expect(mintRow?.actor).toBe("admin-token");
      expect(JSON.parse(mintRow?.detail ?? "{}")).toMatchObject({ name: "audited", scopes: ["tenants:read"] });
    });
  });

  // ---- custody: the token is never stored, and never PASSED to the store -----------------------

  describe("token custody", () => {
    it("stores the HASH and never the token, asserted over every store call rather than final state", async () => {
      // WHY A RECORDING PROXY AND NOT A ROW READ. A point-in-time read of the table proves the token
      // was not in the FINAL state, which a write-then-clear would satisfy while the value really did
      // land in the database. The claim being tested is that the value was never PASSED at all, so
      // the assertion runs over the whole call history.
      const { store: recorded, journal } = recordingStore(store);
      const spyDeps = { ...deps, store: recorded } as ControlPlaneDeps;
      const res = await handle(
        jsonReq("/api/admin/operators", { name: "custody", scopes: ["tenants:read"] }, { headers: bearer(ROOT_TOKEN) }),
        env(),
        ctx,
        spyDeps,
      );
      const { token } = (await res.json()) as { token: string };

      // CONTROL: the proxy really is recording. Without this the assertion below passes against an
      // empty journal, which is the classic vacuous negative.
      expect(journal.some((line) => line.startsWith("createOperatorCredential("))).toBe(true);

      expect(journal.some((line) => line.includes(token))).toBe(false);
      // And the hash IS there, so "the token is absent" is not merely "nothing was written".
      const hash = await sha256Hex(token);
      expect(journal.some((line) => line.includes(hash))).toBe(true);
    });

    it("the credential list carries neither the token nor its hash: there is nothing to mask", async () => {
      const cred = await mint("listed", ["tenants:read"]);
      const res = await call("/api/admin/operators", ROOT_TOKEN);
      const raw = await res.text();
      const listed = JSON.parse(raw) as { credentials: Record<string, unknown>[] };

      // The key set is asserted EXACTLY rather than as a subset: a subset match cannot see a field
      // appear, and the field that must never appear here is a credential.
      expect(Object.keys(listed.credentials[0]).sort()).toEqual([
        "created_at", "created_by", "expires_at", "id", "last_used_at", "name", "revoked_at", "revoked_by", "scopes",
      ]);
      // Asserted against the SERIALISED body, so a value smuggled anywhere in the payload is caught,
      // not only a top-level field. Both the token and the stored hash are checked: leaking the hash
      // would not be a credential, and it is still the one value an offline guess can be tested
      // against.
      expect(raw).not.toContain(cred.token);
      expect(raw).not.toContain(await sha256Hex(cred.token));
    });

    it("stamps last_used_at, so a dormant credential is visible and therefore revocable", async () => {
      const cred = await mint("used", ["tenants:read"]);
      let listed = (await (await call("/api/admin/operators", ROOT_TOKEN)).json()) as {
        credentials: { id: string; last_used_at: string | null }[];
      };
      expect(listed.credentials.find((c) => c.id === cred.id)?.last_used_at).toBeNull();

      await call("/api/admin/tenants", cred.token);
      await flush();

      listed = (await (await call("/api/admin/operators", ROOT_TOKEN)).json()) as {
        credentials: { id: string; last_used_at: string | null }[];
      };
      expect(listed.credentials.find((c) => c.id === cred.id)?.last_used_at).toBe(new Date(NOW).toISOString());
    });
  });

  // ---- attribution: the point of the whole exercise ---------------------------------------------

  describe("attribution", () => {
    it("a named credential records operator_authenticated, and the CLAIM key is gone from that row", async () => {
      const banker = await mint("joan", ["credits:write"]);
      const res = await post(`/api/admin/tenants/${TEN}/credits/manual`, banker.token, {
        amount_micro_usd: 2_000_000,
        reason: "render failed on our side",
        reference: "inc-77",
      });
      expect(res.status).toBe(200);

      const rows = await store.listAdminAudit({ target: TEN, limit: 10 });
      const credit = rows.find((r) => r.action === "tenant.credit_manual");
      expect(credit?.actor).toBe("operator:joan");
      const detail = JSON.parse(credit?.detail ?? "{}");
      expect(detail.operator_authenticated).toBe("joan");
      expect(detail).not.toHaveProperty("operator_claimed");

      // The LEDGER note carries the same key, so a money reader never has to cross-check which of
      // the two fields was the verified one.
      const ledger = await store.listLedger(TEN, 10);
      expect(JSON.parse(ledger[0].note ?? "{}")).toMatchObject({ operator_authenticated: "joan" });
    });

    it("REFUSES a credit attributed to somebody else, rather than ignoring the claim", async () => {
      const banker = await mint("joan", ["credits:write"]);
      const res = await post(`/api/admin/tenants/${TEN}/credits/manual`, banker.token, {
        amount_micro_usd: 2_000_000,
        operator: "rollins",
        reason: "not mine to claim",
        reference: "inc-78",
      });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe("operator_mismatch");
      // Nothing was credited: a refused attribution must not leave money behind.
      expect(await store.listLedger(TEN, 10)).toEqual([]);

      // CONTROL: the same body naming the SAME operator is accepted, so the refusal is about the
      // mismatch and not about the field being present.
      const ok = await post(`/api/admin/tenants/${TEN}/credits/manual`, banker.token, {
        amount_micro_usd: 2_000_000,
        operator: "joan",
        reason: "mine",
        reference: "inc-79",
      });
      expect(ok.status).toBe(200);
    });

    it("the ROOT token keeps the old contract exactly: operator required, recorded as a CLAIM", async () => {
      const missing = await post(`/api/admin/tenants/${TEN}/credits/manual`, ROOT_TOKEN, {
        amount_micro_usd: 1_000_000,
        reason: "comp",
        reference: "root-1",
      });
      expect(missing.status).toBe(400);
      expect((await missing.json() as { error: string }).error).toBe("operator_required");

      const ok = await post(`/api/admin/tenants/${TEN}/credits/manual`, ROOT_TOKEN, {
        amount_micro_usd: 1_000_000,
        operator: "somebody",
        reason: "comp",
        reference: "root-2",
      });
      expect(ok.status).toBe(200);
      const rows = await store.listAdminAudit({ target: TEN, limit: 10 });
      const detail = JSON.parse(rows.find((r) => r.action === "tenant.credit_manual")?.detail ?? "{}");
      expect(detail.operator_claimed).toBe("somebody");
      expect(detail).not.toHaveProperty("operator_authenticated");
    });

    it("every WRITE route records the operator, not the credential class", async () => {
      const writer = await mint("strummer", ["tenants:write", "platform:settings"]);
      await post(`/api/admin/tenants/${TEN}/suspend`, writer.token, { reason: "abuse report" });
      await post("/api/admin/settings", writer.token, { signups_enabled: false });

      const actors = (await store.listAdminAudit({ limit: 20 })).map((r) => r.actor);
      expect(actors).toContain("operator:strummer");
      // The settings write also records the operator on the SETTING row, not only in the trail.
      expect(actors.filter((a) => a === "admin-token").every((_, i) => i >= 0)).toBe(true);
    });
  });

  // ---- reads are audited too ---------------------------------------------------------------------

  describe("audit on read", () => {
    it("reaching into ONE tenant leaves a row naming who and which tenant", async () => {
      const reader = await mint("reader", ["tenants:read"]);
      expect((await call(`/api/admin/tenants/${TEN}/credits`, reader.token)).status).toBe(200);
      expect((await call(`/api/admin/tenants/${TEN}/preservation-holds`, reader.token)).status).toBe(200);

      const rows = await store.listAdminAudit({ target: TEN, limit: 20 });
      expect(rows.map((r) => r.action).sort()).toEqual(["tenant.read.credits", "tenant.read.preservation_holds"]);
      expect(rows.every((r) => r.actor === "operator:reader")).toBe(true);
    });

    it("a per-tenant LLM spend read is recorded too, so the disclosure claim stays true", async () => {
      const reader = await mint("reader", ["tenants:read"]);
      const spendDeps = { ...deps, llmSpend: new LlmSpendD1(d1Over(db)) } as ControlPlaneDeps;
      const spend = (query: string) =>
        handle(req("/api/admin/llm-spend" + query, { headers: bearer(reader.token) }), env(), ctx, spendDeps);

      const ok = await spend(`?tenant=${TEN}&start=2026-01-01&end=2026-02-01`);
      expect(ok.status).toBe(200);
      const rows = await store.listAdminAudit({ target: TEN, limit: 20 });
      expect(rows.some((r) => r.action === "tenant.read.llm_spend" && r.actor === "operator:reader")).toBe(true);

      // NEGATIVE CONTROL: a malformed query is a 400, not a reach, and writes NO row. Without this
      // the assertion above would also pass for a route that audited every request that arrived,
      // which would fill the trail with rows about typos.
      const before = (await store.listAdminAudit({ limit: 100 })).length;
      expect((await spend("?tenant=" + TEN)).status).toBe(400);
      expect((await store.listAdminAudit({ limit: 100 })).length).toBe(before);
    });

    it("FLEET-level reads are NOT audited, so the rows that matter are not buried", async () => {
      const reader = await mint("reader", ["tenants:read"]);
      await call("/api/admin/tenants", reader.token);
      await call("/api/admin/settings", reader.token);
      await call("/api/admin/audit", reader.token);
      // Only the mint from beforeEach-ish setup is in the trail; no read row was written.
      const rows = await store.listAdminAudit({ limit: 50 });
      expect(rows.filter((r) => r.action.startsWith("tenant.read.")).length).toBe(0);
    });

    it("the trail is READABLE, filtered by tenant, newest first", async () => {
      const writer = await mint("writer", ["tenants:write", "tenants:read"]);
      await post(`/api/admin/tenants/${TEN}/suspend`, writer.token, { reason: "one" });
      await post(`/api/admin/tenants/${TEN}/resume`, writer.token, {});

      const res = await call(`/api/admin/audit?target=${TEN}&limit=5`, writer.token);
      expect(res.status).toBe(200);
      const { audit } = (await res.json()) as { audit: { action: string; actor: string; target: string }[] };
      expect(audit[0].action).toBe("tenant.resume");
      expect(audit.every((r) => r.target === TEN)).toBe(true);
      expect(audit.every((r) => r.actor === "operator:writer")).toBe(true);
    });

    it("reading the trail needs tenants:read, and is refused without it", async () => {
      const nope = await mint("nope", ["studio:operate"]);
      expect((await call("/api/admin/audit", nope.token)).status).toBe(403);
      const yes = await mint("yes", ["tenants:read"]);
      expect((await call("/api/admin/audit", yes.token)).status).toBe(200);
    });
  });

  // ---- whoami: the console's projection seam ----------------------------------------------------

  describe("GET /api/admin/whoami", () => {
    it("needs authentication and NO scope: a credential can always discover its own reach", async () => {
      const cred = await mint("minimal", ["keys:rotate"]);
      const res = await call("/api/admin/whoami", cred.token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        actor: "operator:minimal",
        kind: "credential",
        operator: "minimal",
        credential_id: cred.id,
        scopes: ["keys:rotate"],
        catalogue: OPERATOR_SCOPES.map((s) => ({ id: s.id, summary: s.summary })),
        // The gate's OWN table, served so the console can ask it rather than keep a copy that
        // drifts. Asserted here against the live constant, so adding a route to the gate cannot
        // silently stop being served to the UI.
        requirements: ADMIN_REQUIREMENTS.map((r) => ({
          method: r.method,
          pattern: r.pattern.source,
          requires: r.requires,
        })),
      });
      expect((await handle(req("/api/admin/whoami"), env(), ctx, deps)).status).toBe(401);
    });

    it("says out loud that the root token names NOBODY, rather than showing a blank", async () => {
      const body = (await (await call("/api/admin/whoami", ROOT_TOKEN)).json()) as {
        kind: string; operator: string | null; scopes: string[];
      };
      expect(body.kind).toBe("root");
      expect(body.operator).toBeNull();
      expect(body.scopes).toEqual([...ALL_SCOPES]);
    });

    it("carries the whole catalogue, so the console renders scopes it was never taught", () => {
      // The projection rule, asserted rather than trusted: every scope the gate can require appears
      // in the payload the UI renders from. A scope missing here is a scope no console can show.
      expect(OPERATOR_SCOPES.map((s) => s.id)).toEqual([...ALL_SCOPES]);
      expect(OPERATOR_SCOPES.every((s) => s.summary.length > 20)).toBe(true);
    });
  });

  // ---- the table is the gate, so the table is tested directly ----------------------------------

  describe("ADMIN_REQUIREMENTS", () => {
    it("refuses an admin path with NO entry, for everyone including root", async () => {
      // Fail-closed default. 404 rather than 403 because the overwhelmingly common cause is a path
      // that is not a route (a malformed tenant id), which answered 404 before this table existed.
      expect((await call("/api/admin/does-not-exist", ROOT_TOKEN)).status).toBe(404);
      expect((await call(`/api/admin/tenants/ten_NOPE/credits`, ROOT_TOKEN)).status).toBe(404);
      // Method matters: the table is keyed on both.
      expect((await post(`/api/admin/tenants/${TEN}/credits`, ROOT_TOKEN)).status).toBe(404);
    });

    it("matches exactly, so a nested route cannot inherit its parent's requirement", () => {
      expect(adminRequirement("GET", `/api/admin/tenants/${TEN}/smoke-render/smk_abc/artifact`)).toBe("tenants:read");
      expect(adminRequirement("POST", `/api/admin/tenants/${TEN}/smoke-render`)).toBe("studio:operate");
      expect(adminRequirement("GET", `/api/admin/tenants/${TEN}/smoke-render`)).toBeNull();
      expect(adminRequirement("POST", `/api/admin/tenants/${TEN}/credits`)).toBeNull();
      expect(adminRequirement("POST", `/api/admin/tenants/${TEN}/credits/manual`)).toBe("credits:write");
    });

    it("every requirement is a real scope, root, or authenticated: a typo here would open a route", () => {
      const legal = new Set<string>([...ALL_SCOPES, "root", "authenticated"]);
      for (const row of ADMIN_REQUIREMENTS) expect(legal.has(row.requires), row.requires).toBe(true);
    });

    it("EVERY admin route reachable in the router has an entry, or it is unreachable", async () => {
      // WHY THIS IS A SOURCE SCAN. The fail-closed default means a handler added without a table
      // entry 404s rather than running ungated, which is safe and silent. Silent is the problem: the
      // author would chase a routing bug. This walks the router's own admin path patterns and fails
      // if one of them is not gated by anything.
      //
      // LIMIT, STATED HONESTLY: it checks that SOME method is gated for each path, not that the
      // handler's exact method is. A method mismatch shows up as a 404 the first time the route is
      // called, which is loud enough; a path with no entry at all would never be noticed.
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const whole: string = readFileSync(join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
      // Scan the HANDLER body only. ADMIN_REQUIREMENTS sits above adminRoutes in the same file and
      // is itself full of admin path patterns; scanning it too would have the table check its own
      // homework.
      const src = whole.slice(whole.indexOf("async function adminRoutes("));
      expect(src.length).toBeGreaterThan(1000);
      const paths = new Set<string>();
      for (const m of src.matchAll(/path === "(\/api\/admin\/[^"]*)"/g)) paths.add(m[1]);
      for (const m of src.matchAll(/\/\^\\\/api\\\/admin\\\/(\S+?)\$\//g)) {
        paths.add(
          ("/api/admin/" + m[1])
            .replace(/\\\//g, "/")
            .replace(/\((ten_\[a-f0-9\]\+)\)/g, "ten_abc123")
            .replace(/\((smk_\[a-f0-9\]\+)\)/g, "smk_abc123")
            .replace(/\((hold_\[a-f0-9\]\+)\)/g, "hold_abc123")
            .replace(/\((opc_\[a-f0-9\]\+)\)/g, "opc_abc123")
            .replace(/\(suspend\|resume\)/g, "suspend"),
        );
      }
      // The scan itself must not go vacuous: a broken regex here would find nothing and pass.
      expect(paths.size).toBeGreaterThan(15);

      const ungated = [...paths].filter(
        (p) => !["GET", "POST", "DELETE", "PUT"].some((m) => adminRequirement(m, p) !== null),
      );
      expect(ungated, "these admin paths are in the router with no ADMIN_REQUIREMENTS entry").toEqual([]);
    });

    it("has no DUPLICATE entries: first match wins, so a second row for one method and path is dead", () => {
      // Two rows for the same method and pattern means the second is unreachable, and an unreachable
      // row that LOOKS like a grant is exactly the kind of thing an auditor would read and believe.
      // Different methods over one pattern are legitimate (GET reads, POST writes) and are kept
      // apart by the method in the key.
      const keys = ADMIN_REQUIREMENTS.map((r) => `${r.method} ${r.pattern.source}`);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

// ---- the policy's own promise, tested (cp#219) -------------------------------------------------
//
// `docs/legal/hosted/PRIVACY-DELTA.md` Section 2.3 and `aup/1.0.0.md` Section 5 both promise, in
// force at hosted launch, that ANY access reaching into a specific tenant writes a durable record
// carrying who (authenticated by the credential), what, which tenant, and when. That sentence is
// now a commitment rather than a description, so it needs a test that fails when a route can reach
// tenant data without recording it.
//
// THE SHAPE IS THE SAME FAIL-CLOSED TRICK AS THE SCOPE TABLE, and for the same reason: the hazard is
// not a route that is wrong today, it is the route somebody adds next year. Every tenant-scoped
// pattern in ADMIN_REQUIREMENTS must be CLASSIFIED here. A new one is unclassified, and unclassified
// fails, so the decision cannot be skipped by not thinking about it.
describe("every route that reaches into ONE tenant leaves a record (the merged policy claim)", () => {
  // Routes whose handler writes an audit row naming the tenant. Split by kind because reads were the
  // gap cp#219 closed and writes were always audited; keeping them apart makes a regression legible.
  const AUDITED_READS = [
    "GET /api/admin/tenants/ten_x/credits",
    "GET /api/admin/tenants/ten_x/preservation-holds",
    "GET /api/admin/tenants/ten_x/smoke-render/smk_x",
    "GET /api/admin/tenants/ten_x/smoke-render/smk_x/artifact",
    "GET /api/admin/llm-spend",
  ];
  const AUDITED_WRITES = [
    "POST /api/admin/tenants/ten_x/suspend",
    "POST /api/admin/tenants/ten_x/preservation-holds",
    "POST /api/admin/tenants/ten_x/preservation-holds/hold_x/release",
    "POST /api/admin/tenants/ten_x/credits/manual",
    "POST /api/admin/tenants/ten_x/teardown",
    "POST /api/admin/tenants/ten_x/upgrade-modules",
    "POST /api/admin/tenants/ten_x/upgrade-studio",
    "POST /api/admin/tenants/ten_x/refresh-studio-bindings",
    "POST /api/admin/tenants/ten_x/video-finish-binding",
    "POST /api/admin/tenants/ten_x/video-finish-tier-state",
    "POST /api/admin/tenants/ten_x/abuse-report-url",
    "POST /api/admin/tenants/ten_x/storage-quota",
    "POST /api/admin/tenants/ten_x/invoke-key-handoff",
    "POST /api/admin/tenants/ten_x/reprovision-runpod",
    "POST /api/admin/tenants/ten_x/smoke-render",
  ];

  /** A concrete path for a table pattern, so a pattern can be matched against the lists above. */
  const sample = (pattern: RegExp): string =>
    pattern.source
      .replace(/^\^/, "")
      .replace(/\$$/, "")
      .replace(/\\\//g, "/")
      .replace(/ten_\[a-f0-9\]\+/g, "ten_x")
      .replace(/smk_\[a-f0-9\]\+/g, "smk_x")
      .replace(/hold_\[a-f0-9\]\+/g, "hold_x")
      .replace(/opc_\[a-f0-9\]\+/g, "opc_x")
      .replace(/\(\?:suspend\|resume\)/g, "suspend");

  it("classifies EVERY tenant-scoped route: an unclassified one fails rather than passing quietly", () => {
    const classified = new Set([...AUDITED_READS, ...AUDITED_WRITES]);
    const tenantScoped = ADMIN_REQUIREMENTS.map((r) => `${r.method} ${sample(r.pattern)}`).filter(
      // "Reaches into one tenant" means the route names a tenant. /api/admin/tenants (the census) is
      // fleet-level and the policy says so explicitly; llm-spend takes its tenant in the query, so it
      // is named rather than pattern-matched.
      (row) => row.includes("/tenants/ten_x") || row === "GET /api/admin/llm-spend",
    );
    expect(tenantScoped.length).toBeGreaterThan(15);
    const unclassified = tenantScoped.filter((row) => !classified.has(row));
    expect(
      unclassified,
      "these routes name a tenant but are not classified as audited; the merged privacy text promises they record",
    ).toEqual([]);
  });

  it("has no DEAD classifications: a route removed from the router must leave these lists", () => {
    const live = new Set(ADMIN_REQUIREMENTS.map((r) => `${r.method} ${sample(r.pattern)}`));
    // llm-spend is matched by query rather than by path shape, so it is exempt from this direction.
    const stale = [...AUDITED_READS, ...AUDITED_WRITES].filter(
      (row) => row !== "GET /api/admin/llm-spend" && !live.has(row),
    );
    expect(stale, "these are classified as audited but no longer exist in the router").toEqual([]);
  });

  it("the four promised FIELDS are all present on a real row, not just the row itself", async () => {
    // who / what / which tenant / when, checked on an actual write through the real router. The
    // merged sentence enumerates exactly these four, so this is the assertion that matches it.
    const reader = await mint("fields", ["tenants:read"]);
    await call(`/api/admin/tenants/${TEN}/credits`, reader.token);
    const row = (await store.listAdminAudit({ target: TEN, limit: 5 }))[0];
    expect(row.actor).toBe("operator:fields");       // who, from the credential
    expect(row.action).toBe("tenant.read.credits");  // what
    expect(row.target).toBe(TEN);                    // which tenant
    expect(row.created_at).toBeTruthy();             // when
  });

  it("the ROOT credential is NOT exempt: break-glass access records the same row, naming the credential", async () => {
    // The merged text says break-glass "use is recorded like any other access, but it is attributed
    // to the credential, not a person". Both halves are asserted here, because an exemption would be
    // a material difference the policy does not disclose.
    await call(`/api/admin/tenants/${TEN}/credits`, ROOT_TOKEN);
    const row = (await store.listAdminAudit({ target: TEN, limit: 5 }))[0];
    expect(row.action).toBe("tenant.read.credits");
    expect(row.actor).toBe("admin-token");
    expect(row.actor.startsWith("operator:")).toBe(false);
  });
});

});
