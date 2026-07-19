// The operator verification route (cp#45).
//
// WHAT THIS SUITE IS AND IS NOT. It drives the shipped route and the shipped smoke-render logic
// over a MemoryStore and a fake tenant studio, so it proves DECISION PATHS: which refusals fire,
// what gets recorded, and -- the load-bearing one -- that a studio saying COMPLETED is not enough
// to call anything verified. It proves NOTHING about the SQL (see store-d1-sql.test.ts, where the
// spend guard's conditional INSERT is exercised against real SQLite) and NOTHING about whether the
// canonical fixture is accepted by a real studio release, which only a live run can answer.
//
// Every assertion here was made to FAIL on purpose once before being believed.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ControlPlaneDeps, ProvisionerWiring } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import { handle } from "../src/index";
import {
  advanceSmokeRender,
  DEFAULT_SMOKE_BOUNDS,
  resolveSmokeRenderBounds,
  startSmokeRender,
  type SmokeRenderDeps,
  type StudioBytes,
  type StudioReply,
  type TenantStudioSmokeClient,
} from "../src/smoke-render";
import type { Tenant } from "../src/store";
import { MemoryStore, recordingStore } from "./memory-store";

const ROOT_HOST = "studio.vivijure.com";
const ORIGIN = `https://${ROOT_HOST}`;
const ADMIN_TOKEN = "admin-secret";
const TENANT_ID = "ten_aaaa1111";

/** The tenant STUDIO_API_TOKEN, in plaintext, so the leak assertions have something to hunt for. */
const STUDIO_TOKEN = "studio-token-that-must-never-escape";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
/** sha256 of PNG above, computed by the same primitive the route uses. Asserted, not assumed. */
async function sha(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const env = (over: Partial<ControlPlaneEnv> = {}): ControlPlaneEnv =>
  ({
    ASSETS: { fetch: async () => new Response("ui") } as unknown as Fetcher,
    CP_DB: {} as D1Database,
    AUP_VERSION: "2026-07-01",
    AUP_URL: `${ORIGIN}/aup`,
    CONTROL_PLANE_HOST: ROOT_HOST,
    CONTROL_PLANE_ADMIN_TOKEN: ADMIN_TOKEN,
    ...over,
  }) as ControlPlaneEnv;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const adminReq = (path: string, method = "GET") =>
  new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, authorization: `Bearer ${ADMIN_TOKEN}` } });

/**
 * A fake tenant studio. Every leg is independently overridable so each failure mode below is
 * reachable, and every call is COUNTED so "we refused before dispatching" is an assertion about
 * calls that did not happen rather than a hope.
 */
function fakeStudio(over: Partial<TenantStudioSmokeClient> = {}) {
  const calls = { bundle: 0, submit: 0, poll: 0, artifact: 0 };
  const client: TenantStudioSmokeClient = {
    async putCanonicalBundle(): Promise<StudioReply> {
      calls.bundle++;
      return { status: 201, text: JSON.stringify({ ok: true, bundleKey: "bundles/smoke.tar.gz" }) };
    },
    async submitKeyframeRender(): Promise<StudioReply> {
      calls.submit++;
      return { status: 201, text: JSON.stringify({ jobId: "film-123" }) };
    },
    async pollRender(): Promise<StudioReply> {
      calls.poll++;
      return {
        status: 200,
        text: JSON.stringify({
          jobId: "film-123",
          status: "COMPLETED",
          output: { mode: "keyframes-only", keyframes: [{ shot_id: "smoke1", key: "clips/smoke1_keyframe.png" }] },
        }),
      };
    },
    async fetchArtifact(): Promise<StudioBytes> {
      calls.artifact++;
      return { status: 200, bytes: PNG.slice().buffer, contentType: "image/png" };
    },
    ...over,
  };
  return { client, calls };
}

let store: MemoryStore;
let studio: ReturnType<typeof fakeStudio>;
let deps: ControlPlaneDeps;
let tenant: Tenant;

function smokeDeps(bounds = DEFAULT_SMOKE_BOUNDS): SmokeRenderDeps {
  return { store, studio: studio.client, bounds, log: () => {} };
}

beforeEach(async () => {
  store = new MemoryStore();
  studio = fakeStudio();
  await store.createAccount("acct_1", "a@b.com");
  tenant = await store.createTenant(TENANT_ID, "hero", "acct_1", "live");
  // A LIVE, addressable tenant: a studio script and a stored (encrypted) token. The route refuses
  // without both, so the fixture has to carry them for anything past the gate to be reachable.
  Object.assign(tenant, {
    script_name: "tenant-hero-studio",
    studio_token_enc: `enc(${STUDIO_TOKEN})`,
    modules_release: "v1.5.0",
  });
  store.tenants.set(TENANT_ID, tenant);
  deps = {
    store,
    mailer: { send: async () => {} },
    fetch: vi.fn() as unknown as typeof fetch,
    now: () => 1_750_000_000_000,
    provisioner: { smokeClient: studio.client } as unknown as ProvisionerWiring,
  };
});

// ---- the spend guard ---------------------------------------------------------------------------

describe("the spend guard", () => {
  it("refuses a second smoke render while one is IN FLIGHT, and dispatches nothing", async () => {
    const first = await startSmokeRender(smokeDeps(), tenant, "smk_1");
    expect(first.ok).toBe(true);
    const before = { ...studio.calls };

    const second = await startSmokeRender(smokeDeps(), tenant, "smk_2");
    expect(second.ok).toBe(false);
    expect(second).toMatchObject({ code: "spend_guard" });
    expect((second as { message: string }).message).toContain("already running");
    // THE POINT: a refusal costs nothing. Not one extra call reached the studio.
    expect(studio.calls).toEqual(before);
    expect(store.smokeRenders.size).toBe(1);
  });

  it("refuses inside the COOLDOWN even after the first render finished", async () => {
    await startSmokeRender(smokeDeps(), tenant, "smk_1");
    await store.finishSmokeRender("smk_1", { status: "failed", error: "done for the purposes of this test" });

    const again = await startSmokeRender(smokeDeps(), tenant, "smk_2");
    expect(again).toMatchObject({ ok: false, code: "spend_guard" });
    expect((again as { message: string }).message).toContain("cooldown");
  });

  it("allows a new render once the cooldown has ELAPSED (the bound is a delay, not a lockout)", async () => {
    await startSmokeRender(smokeDeps(), tenant, "smk_1");
    await store.finishSmokeRender("smk_1", { status: "failed", error: "x" });
    store.ageSmokeRender("smk_1", DEFAULT_SMOKE_BOUNDS.cooldownSeconds + 60);

    expect(await startSmokeRender(smokeDeps(), tenant, "smk_2")).toMatchObject({ ok: true });
  });

  it("refuses at the PLATFORM-WIDE daily cap, across different tenants", async () => {
    const bounds = { ...DEFAULT_SMOKE_BOUNDS, cooldownSeconds: 0, inFlightSeconds: 0, dailyCap: 2 };
    const other = await store.createTenant("ten_bbbb2222", "other", "acct_1", "live");
    Object.assign(other, { script_name: "tenant-other-studio", studio_token_enc: `enc(${STUDIO_TOKEN})` });

    expect(await startSmokeRender(smokeDeps(bounds), tenant, "smk_1")).toMatchObject({ ok: true });
    expect(await startSmokeRender(smokeDeps(bounds), other, "smk_2")).toMatchObject({ ok: true });
    // The cap is about the PLATFORM's GPU bill, so a fresh tenant does not get a fresh allowance.
    const third = await startSmokeRender(smokeDeps(bounds), other, "smk_3");
    expect(third).toMatchObject({ ok: false, code: "spend_guard" });
    expect((third as { message: string }).message).toContain("cap of 2");
  });

  it("keeps a bound when its env override is MALFORMED, rather than reading it as zero", () => {
    const bounds = resolveSmokeRenderBounds({
      SMOKE_RENDER_COOLDOWN_SECONDS: "not-a-number",
      SMOKE_RENDER_DAILY_CAP: "-5",
      SMOKE_RENDER_INFLIGHT_SECONDS: "",
    });
    expect(bounds).toEqual(DEFAULT_SMOKE_BOUNDS);
  });

  it("honours a WELL-FORMED override, including a deliberate zero", () => {
    expect(resolveSmokeRenderBounds({ SMOKE_RENDER_DAILY_CAP: "0", SMOKE_RENDER_COOLDOWN_SECONDS: "60" })).toEqual({
      ...DEFAULT_SMOKE_BOUNDS,
      cooldownSeconds: 60,
      dailyCap: 0,
    });
  });
});

// ---- the submit legs ---------------------------------------------------------------------------

describe("submitting through the tenant's own door", () => {
  it("records the studio's OWN WORDS when it will not build the bundle, and never submits", async () => {
    studio = fakeStudio({
      putCanonicalBundle: async () => ({ status: 400, text: JSON.stringify({ ok: false, errors: ["scene 1 has no prompt"] }) }),
    });
    const out = await startSmokeRender(smokeDeps(), tenant, "smk_1");
    expect(out).toMatchObject({ ok: false, code: "studio_refused" });
    expect((out as { message: string }).message).toContain("scene 1 has no prompt");
    expect(studio.calls.submit).toBe(0);
    expect(store.smokeRenders.get("smk_1")).toMatchObject({ status: "failed" });
  });

  it("records a submit refusal on the row rather than throwing it away", async () => {
    studio = fakeStudio({
      submitKeyframeRender: async () => ({ status: 503, text: "no keyframe module installed" }),
    });
    const out = await startSmokeRender(smokeDeps(), tenant, "smk_1");
    expect(out).toMatchObject({ ok: false, code: "studio_refused" });
    expect(store.smokeRenders.get("smk_1")?.error_message).toContain("no keyframe module installed");
  });

  it("records the studio job id and the release the modules were at", async () => {
    const out = await startSmokeRender(smokeDeps(), tenant, "smk_1");
    expect(out).toMatchObject({ ok: true });
    expect(store.smokeRenders.get("smk_1")).toMatchObject({
      studio_job_id: "film-123",
      bundle_key: "bundles/smoke.tar.gz",
      // Without this the artifact answers "does it render", never "does THIS release render".
      modules_release: "v1.5.0",
    });
  });
});

// ---- phase=done is not a pass ------------------------------------------------------------------

describe("what counts as verified", () => {
  const start = async () => {
    await startSmokeRender(smokeDeps(), tenant, "smk_1");
    return (await store.getSmokeRender("smk_1"))!;
  };

  it("FETCHES the artifact and records its size, hash and mime", async () => {
    const advanced = await advanceSmokeRender(smokeDeps(), tenant, await start());
    expect(studio.calls.artifact).toBe(1);
    expect(advanced).toMatchObject({
      status: "succeeded",
      artifact_key: "clips/smoke1_keyframe.png",
      artifact_bytes: PNG.byteLength,
      artifact_sha256: await sha(PNG),
      artifact_content_type: "image/png",
    });
  });

  it("FAILS a COMPLETED render that names no artifact -- phase=done is never a pass", async () => {
    const row = await start();
    studio = fakeStudio({
      pollRender: async () => ({ status: 200, text: JSON.stringify({ status: "COMPLETED", output: { keyframes: [] } }) }),
    });
    const advanced = await advanceSmokeRender(smokeDeps(), tenant, row);
    expect(advanced.status).toBe("failed");
    expect(advanced.error_message).toContain("named no keyframe artifact");
  });

  it("FAILS a COMPLETED render whose artifact cannot be fetched", async () => {
    const row = await start();
    studio = fakeStudio({ fetchArtifact: async () => ({ status: 404, bytes: null, contentType: "" }) });
    const advanced = await advanceSmokeRender(smokeDeps(), tenant, row);
    expect(advanced.status).toBe("failed");
    expect(advanced.error_message).toContain("could not be fetched");
  });

  it("FAILS a COMPLETED render whose artifact is ZERO BYTES (an empty file is not pixels)", async () => {
    const row = await start();
    studio = fakeStudio({
      fetchArtifact: async () => ({ status: 200, bytes: new ArrayBuffer(0), contentType: "image/png" }),
    });
    const advanced = await advanceSmokeRender(smokeDeps(), tenant, row);
    expect(advanced.status).toBe("failed");
    expect(advanced.error_message).toContain("0 bytes");
  });

  it("records the studio's failure verbatim when the render FAILED", async () => {
    const row = await start();
    studio = fakeStudio({
      pollRender: async () => ({ status: 200, text: JSON.stringify({ status: "FAILED", error: "CUDA out of memory" }) }),
    });
    const advanced = await advanceSmokeRender(smokeDeps(), tenant, row);
    expect(advanced).toMatchObject({ status: "failed" });
    expect(advanced.error_message).toContain("CUDA out of memory");
  });

  it("does NOT condemn a render because one poll was unavailable", async () => {
    const row = await start();
    studio = fakeStudio({ pollRender: async () => ({ status: 502, text: "bad gateway" }) });
    expect((await advanceSmokeRender(smokeDeps(), tenant, row)).status).toBe("running");
  });

  it("gives up honestly on a render that outlived its deadline", async () => {
    const row = await start();
    store.ageSmokeRender("smk_1", DEFAULT_SMOKE_BOUNDS.inFlightSeconds + 60);
    const advanced = await advanceSmokeRender(smokeDeps(), tenant, (await store.getSmokeRender("smk_1"))!);
    expect(advanced.status).toBe("failed");
    expect(advanced.error_message).toContain("did not finish within");
    // It did not ask the studio again: the deadline decides before the dispatch.
    expect(studio.calls.poll).toBe(0);
  });

  it("is write-once: a late poll cannot overwrite a recorded outcome", async () => {
    const row = await start();
    await advanceSmokeRender(smokeDeps(), tenant, row);
    await store.finishSmokeRender("smk_1", { status: "failed", error: "a later poll disagreeing" });
    expect((await store.getSmokeRender("smk_1"))?.status).toBe("succeeded");
  });
});

// ---- no credential leaves the worker -----------------------------------------------------------

describe("credential custody (the reason option (b) beat option (a))", () => {
  it("never PASSES the tenant studio token to the store, on any call", async () => {
    const rec = recordingStore(store);
    const recDeps: SmokeRenderDeps = { store: rec.store, studio: studio.client, bounds: DEFAULT_SMOKE_BOUNDS, log: () => {} };
    await startSmokeRender(recDeps, tenant, "smk_1");
    await advanceSmokeRender(recDeps, tenant, (await store.getSmokeRender("smk_1"))!);

    // CONTROL: the journal is actually recording. Without this the assertion below passes on an
    // empty journal, which is the "negative test over a dead capability" failure mode.
    expect(rec.journal.some((c) => c.startsWith("openSmokeRender("))).toBe(true);
    expect(rec.journal.some((c) => c.startsWith("finishSmokeRender("))).toBe(true);
    expect(rec.journal.join("\n")).not.toContain(STUDIO_TOKEN);
  });

  it("never puts the token, or its ciphertext, on an operator response", async () => {
    const started = await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render`, "POST"), env(), ctx, deps);
    const startedBody = await started.text();
    const id = (JSON.parse(startedBody) as { smoke_render_id: string }).smoke_render_id;
    const polled = await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render/${id}`), env(), ctx, deps);
    const polledBody = await polled.text();

    for (const body of [startedBody, polledBody]) {
      expect(body).not.toContain(STUDIO_TOKEN);
      expect(body).not.toContain(tenant.studio_token_enc);
    }
    // CONTROL: these responses are not empty, so "does not contain" means something.
    expect(startedBody).toContain("smoke_render_id");
    expect(polledBody).toContain("verified");
  });
});

// ---- the routes --------------------------------------------------------------------------------

describe("POST /api/admin/tenants/:id/smoke-render", () => {
  it("401s without the admin bearer -- and that 401 is NOT evidence the route exists", async () => {
    const res = await handle(
      new Request(`${ORIGIN}/api/admin/tenants/${TENANT_ID}/smoke-render`, { method: "POST", headers: { origin: ORIGIN } }),
      env(),
      ctx,
      deps,
    );
    expect(res.status).toBe(401);
    // The gate runs BEFORE path matching, so a route that does not exist answers identically. This
    // asserts that fact rather than relying on anyone remembering it.
    const bogus = await handle(
      new Request(`${ORIGIN}/api/admin/no-such-route-at-all`, { method: "POST", headers: { origin: ORIGIN } }),
      env(),
      ctx,
      deps,
    );
    expect(bogus.status).toBe(401);
  });

  it("503s when the provisioner is unconfigured (no wiring, no verification offered)", async () => {
    const res = await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render`, "POST"), env(), ctx, {
      ...deps,
      provisioner: undefined,
    });
    expect(res.status).toBe(503);
  });

  it("404s an unknown tenant", async () => {
    const res = await handle(adminReq("/api/admin/tenants/ten_ffff9999/smoke-render", "POST"), env(), ctx, deps);
    expect(res.status).toBe(404);
  });

  it("409s a tenant that is not live, naming the status", async () => {
    Object.assign(tenant, { status: "awaiting_invoke_key" });
    const res = await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render`, "POST"), env(), ctx, deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "tenant_not_live", status: "awaiting_invoke_key" });
    expect(studio.calls.bundle).toBe(0);
  });

  it("409s a SUSPENDED tenant (a kill switch that still renders is not a kill switch)", async () => {
    Object.assign(tenant, { suspended_at: "2026-07-19 00:00:00" });
    const res = await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render`, "POST"), env(), ctx, deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "tenant_suspended" });
    expect(studio.calls.bundle).toBe(0);
  });

  it("409s a tenant with no stored studio token (nothing to drive it with)", async () => {
    Object.assign(tenant, { studio_token_enc: null });
    const res = await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render`, "POST"), env(), ctx, deps);
    expect(await res.json()).toMatchObject({ error: "tenant_not_addressable" });
  });

  it("202s on accept, states its coverage, and does NOT claim anything is verified yet", async () => {
    const res = await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render`, "POST"), env(), ctx, deps);
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "running", verified: false, modules_release: "v1.5.0", artifact: null });
    // The limits ride on every response, on purpose.
    expect((body.coverage as { does_not_prove: string[] }).does_not_prove.join(" ")).toContain("keyframe hook only");
    expect(store.audit.some((a) => a.action === "tenant.smoke_render")).toBe(true);
  });

  it("429s when the spend guard refuses, and says which bound was hit", async () => {
    await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render`, "POST"), env(), ctx, deps);
    const res = await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render`, "POST"), env(), ctx, deps);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "smoke_render_rate_limited", bounds: DEFAULT_SMOKE_BOUNDS });
  });
});

describe("GET /api/admin/tenants/:id/smoke-render/:smokeId", () => {
  const startOne = async (): Promise<string> => {
    const res = await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render`, "POST"), env(), ctx, deps);
    return (await res.json() as { smoke_render_id: string }).smoke_render_id;
  };

  it("drives the render and reports verified with a place to LOOK at the artifact", async () => {
    const id = await startOne();
    const res = await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render/${id}`), env(), ctx, deps);
    expect(await res.json()).toMatchObject({
      status: "succeeded",
      verified: true,
      artifact: {
        key: "clips/smoke1_keyframe.png",
        bytes: PNG.byteLength,
        sha256: await sha(PNG),
        url: `/api/admin/tenants/${TENANT_ID}/smoke-render/${id}/artifact`,
      },
    });
  });

  it("404s a smoke render that belongs to a DIFFERENT tenant", async () => {
    const id = await startOne();
    await store.createTenant("ten_bbbb2222", "other", "acct_1", "live");
    const res = await handle(adminReq(`/api/admin/tenants/ten_bbbb2222/smoke-render/${id}`), env(), ctx, deps);
    expect(res.status).toBe(404);
  });

  it("serves the artifact BYTES, and proves they are still the verified ones", async () => {
    const id = await startOne();
    await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render/${id}`), env(), ctx, deps);
    const res = await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render/${id}/artifact`), env(), ctx, deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("409s if the stored object no longer matches the bytes that were verified", async () => {
    const id = await startOne();
    await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render/${id}`), env(), ctx, deps);
    // The object changed under us. Handing it over as "the verified artifact" would be a lie.
    const changed = new Uint8Array([9, 9, 9, 9]);
    deps.provisioner = {
      smokeClient: {
        ...studio.client,
        fetchArtifact: async () => ({ status: 200, bytes: changed.slice().buffer, contentType: "image/png" }),
      },
    } as unknown as ProvisionerWiring;
    const res = await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render/${id}/artifact`), env(), ctx, deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "artifact_changed", current_sha256: await sha(changed) });
  });

  it("409s the artifact route for a render that produced nothing", async () => {
    const id = await startOne();
    await store.finishSmokeRender(id, { status: "failed", error: "nope" });
    const res = await handle(adminReq(`/api/admin/tenants/${TENANT_ID}/smoke-render/${id}/artifact`), env(), ctx, deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "no_artifact" });
  });
});
