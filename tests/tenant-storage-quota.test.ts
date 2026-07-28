// cp#183: the plane SETS the per-tenant storage ceiling the tenant studio ENFORCES.
//
// WHAT THIS SUITE IS FOR. vivijure-core v1.3.0 shipped the enforcement (core#52) and this plane
// wrote the var NOWHERE, so every hosted tenant ran uncapped while the feature read as shipped.
// The discriminating tests below assert what the plane SENT -- to the provision upload (in
// provisioner.test.ts), to the studio-upgrade upload (in studio-upgrade.test.ts) and to the
// settings patch (here) -- because that is the claim that fails against the behaviour cp#183 filed.
// A test that only read final state would pass against a plane that writes nothing, as long as
// something else had put the binding there.
//
// METHOD, kept from cp#136 and cp#164 because it is what makes these worth running: every claim
// about what the plane does or does not send is made with a RECORDING PROXY over the write call,
// and each negative claim is paired with a POSITIVE CONTROL asserting the proxy records at all.
//
// WHAT THESE CANNOT PROVE, stated so a green run is not over-read: the CfApi here is a fake, so
// these prove decision paths (what is sent, through which credential, what is refused, what a short
// readback or an absent reader does). The end-to-end claim -- a live tenant answering
// GET /api/storage/usage with the ceiling and then DENYING a submit over it -- is an ARTIFACT check
// against the testbed, recorded on the PR, and it is the only thing that proves the tenant is
// actually capped.

import { describe, expect, it, beforeEach, vi } from "vitest";
import type { CfApi, WorkerBinding } from "../src/cf-api";
import type { ControlPlaneEnv } from "../src/env";
import type { ProvisionDeps } from "../src/provisioner";
import type { Tenant } from "../src/store";
import { encryptStudioToken, kekRing } from "../src/token-crypto";
import {
  QUOTA_READBACK_BUDGET_MS,
  resolveStorageQuota,
  tenantStorageQuotaOverride,
  STORAGE_QUOTA_VAR,
  STORAGE_USAGE_PATH,
  applyStorageQuota,
  preflightStorageQuota,
  storageQuotaBindings,
  tenantStorageQuota,
  withStorageQuota,
  tenantStorageQuotaMode,
} from "../src/tenant-storage-quota";
import { assertDispositionCoversContract } from "../src/tenant-studio-env";
import { MemoryStore } from "./memory-store";

const KEK = btoa("0123456789abcdef0123456789abcdef");
const RING = kekRing(KEK);
const SCRIPT = "tenant-hero-studio";
/** 100 GiB. A number, not a ruling: the plane's value lives in deploy config, never in code. */
const QUOTA = "107374182400";

const LIVE_BINDINGS = [
  { type: "assets", name: "ASSETS" },
  { type: "d1", name: "DB" },
  { type: "dispatch_namespace", name: "MODULE_DISPATCH" },
  { type: "plain_text", name: "AUTH_MODE" },
  { type: "plain_text", name: "R2_S3_BUCKET" },
  { type: "r2_bucket", name: "R2_RENDERS" },
  { type: "ratelimit", name: "SPEND_RATE_LIMITER" },
  { type: "secret_text", name: "R2_S3_SECRET_ACCESS_KEY" },
  { type: "secret_text", name: "STUDIO_API_TOKEN" },
];
const LIVE_SECRETS = ["R2_S3_SECRET_ACCESS_KEY", "RUNPOD_API_KEY", "STUDIO_API_TOKEN"];

let store: MemoryStore;
/** THE RECORDING PROXY: every settings patch the plane issued, and through which credential. */
let patched: { via: "cf" | "scriptUpload"; bindings: WorkerBinding[] }[];
/** What the fake studio answers for GET /api/storage/usage, one entry per read. */
let readings: ({ quota: number | null; used: number } | "no_reader" | "dead")[];

interface Census {
  before: { type: string; name: string }[];
  after: { type: string; name: string }[];
  secretsBefore: string[];
  secretsAfter: string[];
}

const census = (over: Partial<Census> = {}): Census => ({
  before: LIVE_BINDINGS,
  // The AFTER census is what Cloudflare returns once the patch has landed, so by default it carries
  // the var. A fixture whose after-state equalled its before-state would make every green result in
  // this file unreachable and the readback assertions vacuous.
  after: [...LIVE_BINDINGS, { type: "plain_text", name: STORAGE_QUOTA_VAR }],
  secretsBefore: LIVE_SECRETS,
  secretsAfter: LIVE_SECRETS,
  ...over,
});

/** Answers the FIRST census with `before` and the second with `after`. */
function fakeCf(via: "cf" | "scriptUpload", c: Census): CfApi {
  let bindingReads = 0;
  let secretReads = 0;
  return {
    getScriptBindings: vi.fn(async () => {
      bindingReads += 1;
      return bindingReads === 1 ? c.before : c.after;
    }),
    getScriptSecretNames: vi.fn(async () => {
      secretReads += 1;
      return secretReads === 1 ? c.secretsBefore : c.secretsAfter;
    }),
    patchScriptSettings: vi.fn(async (_ns: string, _script: string, bindings: WorkerBinding[]) => {
      patched.push({ via, bindings });
    }),
    uploadUserWorker: vi.fn(async () => {
      throw new Error("cp#183 must not re-upload the studio: no bytes, no release change");
    }),
  } as unknown as CfApi;
}

/** A studio that answers GET /api/storage/usage from `readings`, one entry per call. */
function studio(): ProvisionDeps["callTenantStudio"] {
  let call = 0;
  return vi.fn(async (_s: string, init: { path: string }) => {
    if (init.path !== STORAGE_USAGE_PATH) return { status: 200, text: "{}" };
    const r = readings[Math.min(call, readings.length - 1)];
    call += 1;
    if (r === "no_reader") return { status: 404, text: "not found" };
    if (r === "dead") return { status: 503, text: "unavailable" };
    return {
      status: 200,
      text: JSON.stringify({ used_bytes: r.used, objects: 3, quota_bytes: r.quota, over: false }),
    };
  }) as unknown as ProvisionDeps["callTenantStudio"];
}

/** A clock the sleep MOVES, so the readback retry budget is exercised without a real wait. */
let clock: number;

function deps(c: Census = census(), over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    store,
    // The write credential is DELIBERATELY a different object from `cf` (cf#118): the readback must
    // go through the reader, and a test sharing one object could not tell them apart.
    cf: fakeCf("cf", c),
    scriptUploadCf: fakeCf("scriptUpload", c),
    namespace: "vivijure-tenants",
    kek: RING,
    storageQuota: { bytes: QUOTA, invalid: null },
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    log: () => undefined,
    callTenantStudio: studio(),
    ...over,
  } as unknown as ProvisionDeps;
}

async function seedTenant(over: Partial<Tenant> = {}): Promise<Tenant> {
  await store.createAccount("acct_1", "a@b.com");
  const t = await store.createTenant("ten_1", "hero", "acct_1", "provisioning");
  await store.setTenantStudioToken(t.id, await encryptStudioToken(RING, "the-studio-token"));
  await store.setTenantScript(t.id, SCRIPT, "v1.12.0");
  await store.setTenantStatus(t.id, "live");
  const row = (await store.getTenantById(t.id)) as Tenant;
  return { ...row, ...over };
}

const sentVar = (b: WorkerBinding[]) => b.find((x) => x.name === STORAGE_QUOTA_VAR);
const env = (raw?: string): ControlPlaneEnv =>
  ({ TENANT_R2_STORAGE_QUOTA_BYTES: raw }) as unknown as ControlPlaneEnv;

beforeEach(() => {
  store = new MemoryStore();
  clock = Date.parse("2026-07-27T12:00:00.000Z");
  patched = [];
  // Default: a v1.11.0-or-later studio with no ceiling yet, which then reports what the plane bound.
  readings = [
    { quota: null, used: 5_000 },
    { quota: Number(QUOTA), used: 5_000 },
  ];
});

describe("the knob: plane config -> a number, or an honest refusal", () => {
  it("reads a positive integer byte count", () => {
    expect(tenantStorageQuota(env(QUOTA))).toMatchObject({ bytes: QUOTA, invalid: null });
  });

  it("treats unset and blank as NO ceiling, with no invented default", () => {
    // The whole reason this ships with no fallback: the number prices what an operator is willing
    // to carry, and a default here would be a pricing decision hidden in a config read.
    expect(tenantStorageQuota(env(undefined))).toMatchObject({ bytes: null, invalid: null });
    expect(tenantStorageQuota(env(""))).toMatchObject({ bytes: null, invalid: null });
    expect(tenantStorageQuota(env("   "))).toMatchObject({ bytes: null, invalid: null });
  });

  it("REFUSES a set-but-malformed value instead of rounding it down to off", () => {
    // THE DISCRIMINATING CASE. core parses "100GB" and "" identically: quota off. That is right for
    // the studio and dangerous for the plane, because it makes a typo and a deliberate no-ceiling
    // the same outcome while the operator believes they are capped.
    for (const bad of ["100GB", "10 GiB", "1.5", "-1", "0", "lots", "1_000"]) {
      expect(tenantStorageQuota(env(bad))).toMatchObject({ bytes: null, invalid: bad });
    }
  });

  it("normalizes what it accepts, so the studio reads what the operator meant", () => {
    expect(tenantStorageQuota(env("  1000  "))).toMatchObject({ bytes: "1000", invalid: null });
    expect(tenantStorageQuota(env("1e3"))).toMatchObject({ bytes: "1000", invalid: null });
  });
});

describe("the projection: plane config -> studio var", () => {
  it("binds the var as plain_text with the byte count", () => {
    expect(storageQuotaBindings(QUOTA)).toEqual([{ type: "plain_text", name: STORAGE_QUOTA_VAR, text: QUOTA }]);
  });

  it("binds NOTHING when there is no ceiling: absent IS the state core reads as off", () => {
    // There is no value meaning "unlimited". Binding "0" would deny every submit, which is the
    // opposite of the intent.
    expect(storageQuotaBindings(null)).toEqual([]);
  });

  it("RE-DERIVES rather than inheriting, so a LIFTED quota is actually lifted", () => {
    // An omitted non-secret binding is dropped (cp#112 live probe), so omitting IS the clear. If
    // this travelled as `inherit`, a plane that removed its ceiling could never remove it from a
    // live tenant, and the quota would be a one-way door.
    const carried: WorkerBinding[] = [
      { type: "inherit", name: "AUTH_MODE" },
      { type: "inherit", name: STORAGE_QUOTA_VAR },
      { type: "inherit", name: "DB" },
    ];
    expect(withStorageQuota(carried, null).map((b) => b.name)).toEqual(["AUTH_MODE", "DB"]);
    expect(sentVar(withStorageQuota(carried, QUOTA))).toEqual({
      type: "plain_text",
      name: STORAGE_QUOTA_VAR,
      text: QUOTA,
    });
  });
});

describe("two tenant classes: the plane number is a DEFAULT, not the answer (cp#173)", () => {
  const row = (mode: string | null, bytes: string | null = null) => ({
    r2_storage_quota_override: mode,
    r2_storage_quota_bytes: bytes,
  });
  const plane = { bytes: QUOTA, invalid: null };

  it("inherits the plane default when the tenant records nothing", () => {
    expect(resolveStorageQuota(plane, row(null))).toEqual({ bytes: QUOTA, source: "plane", blocked: null });
  });

  it("lets a tenant record its OWN ceiling, beating the plane default", () => {
    expect(resolveStorageQuota(plane, row("set", "500"))).toEqual({ bytes: "500", source: "tenant", blocked: null });
  });

  it("lets a tenant be DELIBERATELY uncapped while the plane default is set", () => {
    // THE cp#173 CASE, and the one a single global number could not express. A prepaid tenant is
    // bounded by their credit balance; binding the hard cap would deny them at exactly the byte
    // where charged overage begins, and refuse service to somebody holding credits.
    expect(resolveStorageQuota(plane, row("none"))).toEqual({ bytes: null, source: "tenant_none", blocked: null });
  });

  it("keeps 'no per-tenant value' and 'deliberately uncapped' DISTINGUISHABLE", () => {
    // Both bind nothing today, and they are not the same fact: the day an operator sets the plane
    // default, one tenant gets a hard cap and the other must not. A single nullable number would
    // spell these identically, which is how a prepaid tenant silently inherits a cap.
    const unset = { bytes: null, invalid: null };
    const inheriting = resolveStorageQuota(unset, row(null));
    const uncapped = resolveStorageQuota(unset, row("none"));
    expect(inheriting.bytes).toBeNull();
    expect(uncapped.bytes).toBeNull();
    expect(inheriting.source).toBe("plane_unset");
    expect(uncapped.source).toBe("tenant_none");
    // ...and here is the day it matters:
    expect(resolveStorageQuota(plane, row(null)).bytes).toBe(QUOTA);
    expect(resolveStorageQuota(plane, row("none")).bytes).toBeNull();
  });

  it("does NOT let a malformed plane var block a tenant that overrode it", () => {
    // That tenant was never going to use the plane value, so a broken deploy var must not take
    // them down with it. It DOES block a tenant that would have inherited it.
    const broken = { bytes: null, invalid: "100GB" };
    expect(resolveStorageQuota(broken, row("none")).blocked).toBeNull();
    expect(resolveStorageQuota(broken, row("set", "500")).blocked).toBeNull();
    expect(resolveStorageQuota(broken, row(null)).blocked).toMatch(/100GB/);
  });

  it("REFUSES an unreadable tenant record instead of guessing which way it should fail", () => {
    // Both guesses are wrong in opposite directions: inheriting caps a tenant nobody capped,
    // defaulting to none uncaps one somebody did.
    expect(tenantStorageQuotaOverride(row("whatever"))).toBe("corrupt");
    expect(tenantStorageQuotaOverride(row("set", "100GB"))).toBe("corrupt");
    expect(tenantStorageQuotaOverride(row("set", null))).toBe("corrupt");
    expect(resolveStorageQuota(plane, row("set", "-5")).blocked).toMatch(/unreadable/);
  });
});

describe("preflight refuses BEFORE anything is written", () => {
  it("refuses a studio whose bundle predates the core#52 reader, and does not write", async () => {
    // THE REASON THIS VAR GETS A PRE-WRITE PROBE AND ABUSE_REPORT_URL COULD NOT. A studio carrying
    // the reader serves quota_bytes whether or not a quota is set, so a 404 on this route PROVES
    // the reader is absent. Binding the var on such a studio is the silent no-op family
    // (cf#98 / cf#118 / cp#112): a tenant carrying a ceiling nothing enforces.
    readings = ["no_reader"];
    const d = deps();
    const res = await preflightStorageQuota(d, await seedTenant());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.refusal.code).toBe("studio_predates_quota_reader");
    expect(res.refusal.status).toBe(409);
    expect(patched).toEqual([]);
  });

  it("CONTROL: the same fixture with a reader present passes preflight", async () => {
    // Without this the refusal above could pass for the boring reason (a preflight that refuses
    // everything), which is exactly the vacuous-negative class this repo keeps catching.
    const res = await preflightStorageQuota(deps(), await seedTenant());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.context.bytes).toBe(QUOTA);
    expect(res.context.servedBefore).toBeNull();
    expect(res.context.usedBefore).toBe(5_000);
  });

  it("refuses a studio that cannot be read at all, which is NOT the same as no reader", async () => {
    readings = ["dead"];
    const res = await preflightStorageQuota(deps(), await seedTenant());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.refusal.code).toBe("studio_not_serving");
  });

  it("refuses while the PLANE's own value is malformed, naming the raw value", async () => {
    const d = deps(census(), { storageQuota: { bytes: null, invalid: "100GB" } });
    const res = await preflightStorageQuota(d, await seedTenant());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.refusal.code).toBe("plane_quota_malformed");
    expect(res.refusal.message).toContain("100GB");
    expect(patched).toEqual([]);
  });

  it("refuses a tenant with no studio script, and a deleted tenant", async () => {
    const row = await seedTenant();
    const noScript = { ...row, script_name: null } as Tenant;
    const gone = { ...row, deleted_at: 1 } as unknown as Tenant;
    const a = await preflightStorageQuota(deps(), noScript);
    const b = await preflightStorageQuota(deps(), gone);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (a.ok || b.ok) throw new Error("unreachable");
    expect(a.refusal.code).toBe("not_provisioned");
    expect(b.refusal.code).toBe("tenant_deleted");
  });
});

describe("the converge: patch, then PROVE the studio enforces it", () => {
  it("patches the ceiling through the upload credential and never re-uploads bytes", async () => {
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightStorageQuota(d, t);
    if (!pre.ok) throw new Error("preflight refused");
    const result = await applyStorageQuota(d, t, pre.context);

    // CONTROL: the proxy records at all, so the assertions below are about a patch that happened.
    expect(patched).toHaveLength(1);
    expect(patched[0].via).toBe("scriptUpload");
    expect(sentVar(patched[0].bindings)).toEqual({ type: "plain_text", name: STORAGE_QUOTA_VAR, text: QUOTA });
    // Everything else travels as inherit: the plane cannot reproduce two of the four secrets.
    for (const b of LIVE_BINDINGS) {
      const carried = patched[0].bindings.find((x) => x.name === b.name);
      expect(carried).toBeDefined();
      expect(carried?.type).toBe("inherit");
    }
    expect(result.ok).toBe(true);
    expect(result.enforced).toBe(true);
    expect(result.served_quota_before).toBeNull();
    expect(result.served_quota_after).toBe(Number(QUOTA));
    expect(result.over_on_arrival).toBe(false);
  });

  it("is NOT green until the STUDIO reports the number, however happy Cloudflare was", async () => {
    // The point of the whole file. The census can come back perfect and the tenant still be
    // uncapped, because a binding accepted is not a ceiling enforced. A studio that never reports
    // the new number ends at ok:false / enforced:false -- the 202 "bound, not yet observed" path.
    readings = [{ quota: null, used: 5_000 }];
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightStorageQuota(d, t);
    if (!pre.ok) throw new Error("preflight refused");
    const result = await applyStorageQuota(d, t, pre.context);

    expect(result.var_present_after).toBe(true);
    expect(result.missing_bindings).toEqual([]);
    expect(result.enforced).toBe(false);
    expect(result.ok).toBe(false);
    // It RETRIED rather than giving up on the first read, and stayed inside the budget.
    expect(result.readback_attempts).toBeGreaterThan(1);
    expect(result.readback_elapsed_ms).toBeLessThanOrEqual(QUOTA_READBACK_BUDGET_MS);
  });

  it("converges DOWNWARD: a plane that lifted its quota lifts it on the tenant", async () => {
    // The direction that makes this a knob rather than a trap. The var is omitted from the patch,
    // and the studio reporting quota_bytes:null is what proves the tenant is uncapped again.
    readings = [
      { quota: Number(QUOTA), used: 5_000 },
      { quota: null, used: 5_000 },
    ];
    const c = census({ after: LIVE_BINDINGS });
    const t = await seedTenant();
    const d = deps(c, { storageQuota: { bytes: null, invalid: null } });
    const pre = await preflightStorageQuota(d, t);
    if (!pre.ok) throw new Error("preflight refused");
    const result = await applyStorageQuota(d, t, pre.context);

    expect(patched).toHaveLength(1);
    expect(sentVar(patched[0].bindings)).toBeUndefined();
    // CONTROL: the rest of the set still travelled, so this is one omission and not a lost patch.
    for (const b of LIVE_BINDINGS) expect(patched[0].bindings.some((x) => x.name === b.name)).toBe(true);
    expect(result.quota_bytes).toBeNull();
    expect(result.served_quota_after).toBeNull();
    expect(result.enforced).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("reports a STRAND loudly: a binding present before and absent after is never ok", async () => {
    const c = census({ after: [{ type: "plain_text", name: STORAGE_QUOTA_VAR }] });
    const t = await seedTenant();
    const d = deps(c);
    const pre = await preflightStorageQuota(d, t);
    if (!pre.ok) throw new Error("preflight refused");
    const result = await applyStorageQuota(d, t, pre.context);

    expect(result.missing_bindings).toContain("DB");
    expect(result.ok).toBe(false);
  });

  it("says when the tenant is ALREADY over the ceiling it was just given", async () => {
    // Not an error: the tenant keeps every byte, and only the next submit denies. An operator
    // lowering a ceiling under a heavy tenant should see that in the answer, not discover it from
    // a support ticket.
    readings = [
      { quota: null, used: 900 },
      { quota: 500, used: 900 },
    ];
    const t = await seedTenant();
    const d = deps(census(), { storageQuota: { bytes: "500", invalid: null } });
    const pre = await preflightStorageQuota(d, t);
    if (!pre.ok) throw new Error("preflight refused");
    const result = await applyStorageQuota(d, t, pre.context);

    expect(result.enforced).toBe(true);
    expect(result.used_bytes).toBe(900);
    expect(result.over_on_arrival).toBe(true);
  });

  it("writes the RECORD before the studio, and only after the preflight let it through", async () => {
    // Ordering, both directions, and both were chosen rather than fallen into: writing the record
    // before the preflight would leave the plane remembering a decision it could not deliver
    // (the cp#136 lesson), and writing it after the patch would leave a studio enforcing a number
    // the record does not know about, which the next upgrade would silently revert.
    const t = await seedTenant();
    const d = deps();
    const order: string[] = [];
    const realSet = d.store.setTenantStorageQuota.bind(d.store);
    d.store.setTenantStorageQuota = async (id, override) => {
      order.push("record");
      return realSet(id, override);
    };
    const before = d.scriptUploadCf.patchScriptSettings.bind(d.scriptUploadCf);
    d.scriptUploadCf.patchScriptSettings = async (...args: Parameters<typeof before>) => {
      order.push("studio");
      return before(...args);
    };

    const pre = await preflightStorageQuota(d, t, { mode: "set", bytes: "500" });
    if (!pre.ok) throw new Error("preflight refused");
    // Nothing is written by a preflight, ever.
    expect(order).toEqual([]);

    readings = [
      { quota: null, used: 5_000 },
      { quota: 500, used: 5_000 },
    ];
    const result = await applyStorageQuota(d, t, pre.context);
    expect(order).toEqual(["record", "studio"]);
    expect(result.record_written).toBe(true);
    expect(result.quota_source).toBe("tenant");
    const row = await d.store.getTenantById(t.id);
    expect(row?.r2_storage_quota_override).toBe("set");
    expect(row?.r2_storage_quota_bytes).toBe("500");
  });

  it("a converge with NO intent does not touch the record", async () => {
    // A re-run pushes the record onto the studio; it must not rewrite the decision. Asserted as
    // "was never CALLED" rather than "the row looks the same", because a write-then-write-back
    // would pass the second and fail the first.
    const t = await seedTenant();
    const d = deps();
    const writes: unknown[] = [];
    d.store.setTenantStorageQuota = async (_id, override) => {
      writes.push(override);
    };

    const pre = await preflightStorageQuota(d, t);
    if (!pre.ok) throw new Error("preflight refused");
    const result = await applyStorageQuota(d, t, pre.context);

    expect(writes).toEqual([]);
    expect(result.record_written).toBe(false);
    expect(result.quota_source).toBe("plane");
    // CONTROL: the recorder DOES record when an intent is present, so the emptiness above is a
    // decision not taken rather than a proxy that never fires.
    const pre2 = await preflightStorageQuota(d, t, { mode: "none" });
    if (!pre2.ok) throw new Error("preflight refused");
    readings = [{ quota: null, used: 0 }];
    await applyStorageQuota(d, t, pre2.context);
    expect(writes).toEqual([{ mode: "none" }]);
  });

  it("UNCAPS a tenant on intent 'none' even though the plane configures a ceiling", async () => {
    // The prepaid class end to end: the record says none, the patch omits the var, and the studio
    // reporting quota_bytes:null is what proves the tenant is not capped.
    readings = [
      { quota: Number(QUOTA), used: 5_000 },
      { quota: null, used: 5_000 },
    ];
    const t = await seedTenant();
    const d = deps(census({ after: LIVE_BINDINGS }));
    const pre = await preflightStorageQuota(d, t, { mode: "none" });
    if (!pre.ok) throw new Error("preflight refused");
    const result = await applyStorageQuota(d, t, pre.context);

    expect(sentVar(patched[0].bindings)).toBeUndefined();
    expect(result.quota_source).toBe("tenant_none");
    expect(result.served_quota_after).toBeNull();
    expect(result.ok).toBe(true);
    const row = await d.store.getTenantById(t.id);
    expect(row?.r2_storage_quota_override).toBe("none");
  });

  it("refuses a quota_bytes that is not a byte count, before touching the record", async () => {
    const t = await seedTenant();
    const d = deps();
    const writes: unknown[] = [];
    d.store.setTenantStorageQuota = async (_id, o) => {
      writes.push(o);
    };
    const res = await preflightStorageQuota(d, t, { mode: "set", bytes: "100GB" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.refusal.code).toBe("invalid_quota_bytes");
    expect(res.refusal.status).toBe(400);
    expect(writes).toEqual([]);
    expect(patched).toEqual([]);
  });

  it("converges an EXISTING value rather than skipping it, so a raised ceiling actually moves", async () => {
    readings = [
      { quota: 500, used: 100 },
      { quota: Number(QUOTA), used: 100 },
    ];
    const t = await seedTenant();
    // The BEFORE census carries the var, because this is a tenant that already has a ceiling.
    const d = deps(census({ before: [...LIVE_BINDINGS, { type: "plain_text", name: STORAGE_QUOTA_VAR }] }));
    const pre = await preflightStorageQuota(d, t);
    if (!pre.ok) throw new Error("preflight refused");
    const result = await applyStorageQuota(d, t, pre.context);

    expect(result.already_present).toBe(true);
    expect(patched).toHaveLength(1);
    expect(sentVar(patched[0].bindings)).toEqual({ type: "plain_text", name: STORAGE_QUOTA_VAR, text: QUOTA });
    expect(result.served_quota_before).toBe(500);
    expect(result.served_quota_after).toBe(Number(QUOTA));
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------- cp#195: the enforcement MODE

describe("the enforcement mode: what the ceiling MEANS", () => {
  const modeEnv = (v?: string) => ({ TENANT_R2_STORAGE_QUOTA_MODE: v }) as unknown as ControlPlaneEnv;

  it("unset is NOT a misconfiguration: nothing bound, core default deny", () => {
    for (const v of [undefined, "", "   "]) {
      expect(tenantStorageQuotaMode(modeEnv(v))).toEqual({ mode: null, invalid: null });
    }
  });

  it("binds ONLY meter, because deny is core default and binding it changes nothing", () => {
    expect(tenantStorageQuotaMode(modeEnv("meter"))).toEqual({ mode: "meter", invalid: null });
    expect(tenantStorageQuotaMode(modeEnv("  METER "))).toEqual({ mode: "meter", invalid: null });
    // Explicit deny is VALID and binds nothing: the studio already behaves that way, so spending a
    // var slot to restate it would leave a studio that never asked for metering non-identical to
    // one that did not have the var at all.
    expect(tenantStorageQuotaMode(modeEnv("deny"))).toEqual({ mode: null, invalid: null });
    expect(tenantStorageQuotaMode(modeEnv("Deny"))).toEqual({ mode: null, invalid: null });
  });

  it("REFUSES a set-but-unrecognised mode rather than falling back the way core does", () => {
    // core normalises an unrecognised mode to deny and warns, which is right for a STUDIO. On the
    // PLANE it would make "typed metre" and "wants a hard cap" the same outcome, on a tenant the
    // operator believes is metered, and the divergence only shows up on a bill.
    for (const bad of ["metre", "off", "true", "METERED"]) {
      expect(tenantStorageQuotaMode(modeEnv(bad))).toEqual({ mode: null, invalid: bad });
    }
  });

  it("rides on the config object, so provision and converge read one resolution", () => {
    const env = {
      TENANT_R2_STORAGE_QUOTA_BYTES: "1024",
      TENANT_R2_STORAGE_QUOTA_MODE: "meter",
    } as unknown as ControlPlaneEnv;
    expect(tenantStorageQuota(env)).toMatchObject({ bytes: "1024", mode: "meter", invalidMode: null });
  });

  // The mode is bound INDEPENDENTLY of the ceiling: meter with no ceiling is a coherent state
  // (nothing included, everything overage) and must stay expressible.
  it("binds the mode with or without a ceiling, and nothing when neither is set", () => {
    expect(storageQuotaBindings(null, null)).toEqual([]);
    expect(storageQuotaBindings(null, "meter")).toEqual([
      { type: "plain_text", name: "R2_STORAGE_QUOTA_MODE", text: "meter" },
    ]);
    expect(storageQuotaBindings("1024", "meter")).toEqual([
      { type: "plain_text", name: "R2_STORAGE_QUOTA_BYTES", text: "1024" },
      { type: "plain_text", name: "R2_STORAGE_QUOTA_MODE", text: "meter" },
    ]);
  });

  it("withStorageQuota RE-DERIVES the mode, so lifting metering reaches a live tenant", () => {
    const carried = [
      { type: "inherit" as const, name: "R2_STORAGE_QUOTA_BYTES" },
      { type: "inherit" as const, name: "R2_STORAGE_QUOTA_MODE" },
      { type: "inherit" as const, name: "SOMETHING_ELSE" },
    ];
    // A plane that stopped metering must DROP the var, not carry it forward, or a tenant keeps a
    // mode nobody configures any more. Same reason the ceiling is re-derived rather than inherited.
    const dropped = withStorageQuota(carried, "1024", null);
    expect(dropped.some((b) => b.name === "R2_STORAGE_QUOTA_MODE")).toBe(false);
    expect(dropped.some((b) => b.name === "SOMETHING_ELSE")).toBe(true);

    const readded = withStorageQuota(carried, "1024", "meter");
    expect(readded).toContainEqual({ type: "plain_text", name: "R2_STORAGE_QUOTA_MODE", text: "meter" });
  });

  // The disposition entry is what lets the cf release declare this var without refusing every
  // provision. It must exist BEFORE that release is pinned; this pins that it exists at all.
  it("has a disposition, so the cf release that declares it cannot break provisioning", () => {
    expect(() => assertDispositionCoversContract(["R2_STORAGE_QUOTA_MODE"])).not.toThrow();
    // CONTROL: the assert can still fail, so the pass above is not vacuous.
    expect(() => assertDispositionCoversContract(["NO_SUCH_STUDIO_VAR"])).toThrow(/no disposition/);
  });
});
