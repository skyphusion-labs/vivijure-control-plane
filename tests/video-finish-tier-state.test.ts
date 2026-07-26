// cp#136: the plane WRITES the finish-tier state the panel READS.
//
// WHAT THIS SUITE IS FOR. Before this change nothing in the plane ever wrote VIDEO_FINISH_TIER_STATE,
// so the panel `unprovisionable` state could not occur in production at all. The first test below is
// the DISCRIMINATING one: it fails against that never-written behaviour, because it asserts the var
// is in the payload the plane actually SENT.
//
// A NOTE ON METHOD, because it is the difference between proving the shipped artifact and proving a
// fixture. Every claim about what the plane does or does not send is made with a RECORDING PROXY
// over the write call, and each negative claim is paired with a POSITIVE CONTROL asserting the proxy
// records at all. A negative assertion over a call that never happened passes vacuously, which is
// exactly the shape that has burned this estate before (and is the shape of the bug this issue
// files: a var nobody wrote, guarded by tests that only ever read final state).
//
// WHAT THESE TESTS CANNOT PROVE, stated up front so a green run is not over-read: the CfApi here is
// a fake, so these prove the decision paths (what is sent, through which credential, what is
// refused, what a short readback does). They prove nothing about what Cloudflare does with the
// request. The wire shape of the settings PATCH is measured separately in
// tests/cf-api-settings-patch.test.ts, and the live-probe facts it rests on (inherit preserves a
// secret_text binding; an omitted non-secret binding is DROPPED) were established on cp#112.

import { describe, expect, it, beforeEach, vi } from "vitest";
import type { CfApi, WorkerBinding } from "../src/cf-api";
import type { ProvisionDeps } from "../src/provisioner";
import type { Tenant } from "../src/store";
import { encryptStudioToken, kekRing } from "../src/token-crypto";
import {
  applyVideoFinishTierState,
  preflightVideoFinishTierState,
  videoFinishTierStateBindings,
  withVideoFinishTierState,
  VIDEO_FINISH_CAPABILITY_KEY,
  VIDEO_FINISH_TIER_STATE_VAR,
  VIDEO_FINISH_UNPROVISIONABLE,
} from "../src/video-finish-tier-state";
import { MemoryStore } from "./memory-store";

const KEK = btoa("0123456789abcdef0123456789abcdef");
const RING = kekRing(KEK);
const SCRIPT = "tenant-hero-studio";

/**
 * The sentence vivijure-cf serves for this capability when the tier is absent. Held here ONLY as a
 * fixture for the fake studio to answer with: the plane never compares against it, because the copy
 * belongs to the panel and a second copy here would be a drift source with no owner.
 */
const PROVISIONABLE_SENTENCE =
  "Video finishing is not yet provisioned for this studio; finished renders deliver as per-shot clips.";
const UNPROVISIONABLE_SENTENCE =
  "Video finishing is not available for this studio and cannot be turned on for it; finished " +
  "renders deliver as per-shot clips.";

/** A real tenant binding census, including secrets the plane cannot reproduce. */
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
const LIVE_SECRETS = ["R2_S3_SECRET_ACCESS_KEY", "STUDIO_API_TOKEN"];

let store: MemoryStore;
/** THE RECORDING PROXY: every settings patch the plane issued, and through which credential. */
let patched: { via: "cf" | "scriptUpload"; bindings: WorkerBinding[] }[];
let served: (string | null)[];

interface Census {
  before: { type: string; name: string }[];
  after: { type: string; name: string }[];
  secretsBefore: string[];
  secretsAfter: string[];
}

const census = (over: Partial<Census> = {}): Census => ({
  before: LIVE_BINDINGS,
  after: LIVE_BINDINGS,
  secretsBefore: LIVE_SECRETS,
  secretsAfter: LIVE_SECRETS,
  ...over,
});

/** Answers the FIRST census with `before` and the second with `after`, so a short readback is expressible. */
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
      throw new Error("cp#136 must not re-upload the studio: no bytes, no release change");
    }),
  } as unknown as CfApi;
}

/**
 * A studio that answers /api/modules with the sentences in `served`, one per call. Sequenced rather
 * than constant so the BEFORE and AFTER reads can differ, which is what makes the reader-side
 * evidence (served_reason_changed) provable rather than assumed.
 */
function studio(): ProvisionDeps["callTenantStudio"] {
  let call = 0;
  return vi.fn(async (_s: string, init: { path: string }) => {
    if (init.path !== "/api/modules") return { status: 200, text: "{}" };
    const reason = served[Math.min(call, served.length - 1)];
    call += 1;
    const host = reason === null ? {} : { hooks_unavailable: { [VIDEO_FINISH_CAPABILITY_KEY]: reason } };
    return { status: 200, text: JSON.stringify({ host }) };
  }) as unknown as ProvisionDeps["callTenantStudio"];
}

function deps(c: Census = census(), over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    store,
    // The write credential is DELIBERATELY a different object from `cf` (cf#118): the readback must
    // go through the reader, and a test sharing one object could not tell them apart.
    cf: fakeCf("cf", c),
    scriptUploadCf: fakeCf("scriptUpload", c),
    namespace: "vivijure-tenants",
    kek: RING,
    now: () => Date.parse("2026-07-26T12:00:00.000Z"),
    log: () => undefined,
    callTenantStudio: studio(),
    ...over,
  } as unknown as ProvisionDeps;
}

async function seedTenant(over: Partial<Tenant> = {}): Promise<Tenant> {
  await store.createAccount("acct_1", "a@b.com");
  const t = await store.createTenant("ten_1", "hero", "acct_1", "provisioning");
  await store.setTenantStudioToken(t.id, await encryptStudioToken(RING, "the-studio-token"));
  await store.setTenantScript(t.id, SCRIPT, "v1.9.0");
  await store.setTenantStatus(t.id, "live");
  const row = (await store.getTenantById(t.id)) as Tenant;
  return { ...row, ...over };
}

const MARK = { unreachable: true, reason: "the CF account holding this studio is gone" };
const CLEAR = { unreachable: false, reason: null };

const sentVar = (b: WorkerBinding[]) => b.find((x) => x.name === VIDEO_FINISH_TIER_STATE_VAR);

beforeEach(() => {
  store = new MemoryStore();
  patched = [];
  // Default: a studio that CAN read the var (it serves the capability key), and whose sentence
  // changes once the var is set. That is a v1.9.0-or-later bundle with the tier unbound.
  served = [PROVISIONABLE_SENTENCE, UNPROVISIONABLE_SENTENCE];
});

describe("the projection: record -> studio var", () => {
  it("binds the var, with the one value the plane ever writes, for a DECLARED tenant", () => {
    expect(videoFinishTierStateBindings({ video_finish_unreachable: 1 })).toEqual([
      { type: "plain_text", name: VIDEO_FINISH_TIER_STATE_VAR, text: VIDEO_FINISH_UNPROVISIONABLE },
    ]);
  });

  it("binds NOTHING for a reachable tenant: absent IS the state, not a value meaning absent", () => {
    expect(videoFinishTierStateBindings({ video_finish_unreachable: 0 })).toEqual([]);
  });

  it("RE-DERIVES the var from the record, dropping a carried one when the record was cleared", () => {
    // The stale-label case, and the reason `inherit` alone is wrong here: the studio is carrying the
    // var, the plane no longer believes it, and the next write must un-say it. An omitted non-secret
    // binding is DROPPED (cp#112 live probe), so omitting IS the clear.
    const carried: WorkerBinding[] = [
      { type: "inherit", name: "AUTH_MODE" },
      { type: "inherit", name: VIDEO_FINISH_TIER_STATE_VAR },
      { type: "inherit", name: "DB" },
    ];
    const out = withVideoFinishTierState(carried, { video_finish_unreachable: 0 });
    expect(out.map((b) => b.name)).toEqual(["AUTH_MODE", "DB"]);
  });

  it("re-states it as plain_text rather than inheriting it, so the VALUE comes from the record", () => {
    const carried: WorkerBinding[] = [
      { type: "inherit", name: "AUTH_MODE" },
      { type: "inherit", name: VIDEO_FINISH_TIER_STATE_VAR },
    ];
    const out = withVideoFinishTierState(carried, { video_finish_unreachable: 1 });
    expect(out).toEqual([
      { type: "inherit", name: "AUTH_MODE" },
      { type: "plain_text", name: VIDEO_FINISH_TIER_STATE_VAR, text: VIDEO_FINISH_UNPROVISIONABLE },
    ]);
  });
});

describe("the write: declaring a tenant unreachable", () => {
  it("SENDS the var to the studio -- the state stops being unreachable in production", async () => {
    // THE DISCRIMINATING TEST. It asserts what was PASSED to the write call, not what a later read
    // returned, and it is the assertion that fails against the behaviour this issue filed: a plane
    // that never wrote the var at all.
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightVideoFinishTierState(d, t, MARK);
    expect(pre.ok, JSON.stringify(pre)).toBe(true);
    if (!pre.ok) return;
    await applyVideoFinishTierState(d, t, pre.context, MARK);

    expect(patched).toHaveLength(1);
    expect(sentVar(patched[0].bindings)).toEqual({
      type: "plain_text",
      name: VIDEO_FINISH_TIER_STATE_VAR,
      text: VIDEO_FINISH_UNPROVISIONABLE,
    });
    // Through the UPLOAD credential, not the reader: same split as cf#118.
    expect(patched[0].via).toBe("scriptUpload");
  });

  it("CONTROL: the same proxy records a patch with NO var when the tenant is being cleared", async () => {
    // The positive control for the assertion above. Without it, "the var is in the payload" could
    // pass because the harness always puts it there, and "no var in the payload" (below) could pass
    // because nothing was ever recorded.
    const t = await seedTenant();
    const d = deps(census({ before: [...LIVE_BINDINGS, { type: "plain_text", name: VIDEO_FINISH_TIER_STATE_VAR }] }));
    const pre = await preflightVideoFinishTierState(d, t, CLEAR);
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    await applyVideoFinishTierState(d, t, pre.context, CLEAR);

    expect(patched).toHaveLength(1);
    expect(patched[0].bindings.length).toBeGreaterThan(0);
    expect(sentVar(patched[0].bindings)).toBeUndefined();
  });

  it("writes the RECORD, all three columns together, and clears all three together", async () => {
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightVideoFinishTierState(d, t, MARK);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    await applyVideoFinishTierState(d, t, pre.context, MARK);

    let row = (await store.getTenantById(t.id)) as Tenant;
    expect(row.video_finish_unreachable).toBe(1);
    expect(row.video_finish_unreachable_reason).toBe(MARK.reason);
    expect(row.video_finish_unreachable_at).toBe("2026-07-26T12:00:00.000Z");

    patched = [];
    const d2 = deps();
    const pre2 = await preflightVideoFinishTierState(d2, row, CLEAR);
    if (!pre2.ok) throw new Error("preflight refused: " + pre2.refusal.code);
    await applyVideoFinishTierState(d2, row, pre2.context, CLEAR);
    row = (await store.getTenantById(t.id)) as Tenant;
    expect(row.video_finish_unreachable).toBe(0);
    // A reason left standing under a cleared flag is a label outliving its cause.
    expect(row.video_finish_unreachable_reason).toBeNull();
    expect(row.video_finish_unreachable_at).toBeNull();
  });

  it("carries every other binding forward, and never handles a secret VALUE", async () => {
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightVideoFinishTierState(d, t, MARK);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    await applyVideoFinishTierState(d, t, pre.context, MARK);

    const sent = patched[0].bindings;
    // Nothing censused is missing from the patch: an omitted non-secret binding is DROPPED, so a
    // patch that forgot one would strand a live tenant.
    for (const b of LIVE_BINDINGS) {
      expect(sent.find((x) => x.name === b.name), "missing " + b.name).toEqual({ type: "inherit", name: b.name });
    }
    // The ONLY binding carrying a value is ours, and its value is the one constant. Two of a tenant
    // secrets cannot be reproduced by this plane at all, so a payload holding a secret VALUE is the
    // failure this shape exists to make impossible.
    const withText = sent.filter((b) => "text" in b) as { name: string; text: string }[];
    expect(withText.map((b) => b.name)).toEqual([VIDEO_FINISH_TIER_STATE_VAR]);
    expect(withText[0].text).toBe(VIDEO_FINISH_UNPROVISIONABLE);
  });

  it("reports what the STUDIO now serves, which is the reader half of the evidence", async () => {
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightVideoFinishTierState(d, t, MARK);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    const result = await applyVideoFinishTierState(d, t, pre.context, MARK);

    expect(result.ok).toBe(false); // the fake census does not gain the var; see the next test
    expect(result.served_reason_before).toBe(PROVISIONABLE_SENTENCE);
    expect(result.served_reason_after).toBe(UNPROVISIONABLE_SENTENCE);
    expect(result.served_reason_changed).toBe(true);
    // The plane reports the sentence and never asserts its words: that copy belongs to vivijure-cf.
  });

  it("is ok ONLY when the readback carries the var, and 409-worthy when it does not", async () => {
    const t = await seedTenant();
    const good = deps(census({ after: [...LIVE_BINDINGS, { type: "plain_text", name: VIDEO_FINISH_TIER_STATE_VAR }] }));
    const pre = await preflightVideoFinishTierState(good, t, MARK);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    const ok = await applyVideoFinishTierState(good, t, pre.context, MARK);
    expect(ok.ok).toBe(true);
    expect(ok.var_present_before).toBe(false);
    expect(ok.var_present_after).toBe(true);

    // And the short readback: the write reported success, the var is not there. Never a 200.
    const bad = deps();
    const pre2 = await preflightVideoFinishTierState(bad, t, MARK);
    if (!pre2.ok) throw new Error("preflight refused: " + pre2.refusal.code);
    const short = await applyVideoFinishTierState(bad, t, pre2.context, MARK);
    expect(short.ok).toBe(false);
  });

  it("reports a binding that went MISSING across the patch, rather than reporting success", async () => {
    const t = await seedTenant();
    const lost = LIVE_BINDINGS.filter((b) => b.name !== "AUTH_MODE");
    const d = deps(census({ after: [...lost, { type: "plain_text", name: VIDEO_FINISH_TIER_STATE_VAR }] }));
    const pre = await preflightVideoFinishTierState(d, t, MARK);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    const result = await applyVideoFinishTierState(d, t, pre.context, MARK);
    expect(result.missing_bindings).toEqual(["AUTH_MODE"]);
    expect(result.ok).toBe(false);
  });

  it("writes the RECORD before the projection, so a failed patch leaves the plane converging", async () => {
    // Which half-failure is safe is a decision, so it is tested rather than left to reading. Record
    // first: the next write to that studio converges it, and the failure is loud. The other order
    // would leave a studio displaying a sentence the plane has no memory of.
    const t = await seedTenant();
    const d = deps();
    (d.scriptUploadCf as unknown as { patchScriptSettings: unknown }).patchScriptSettings = vi.fn(async () => {
      throw new Error("cloudflare said no");
    });
    const pre = await preflightVideoFinishTierState(d, t, MARK);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    await expect(applyVideoFinishTierState(d, t, pre.context, MARK)).rejects.toThrow("cloudflare said no");
    const row = (await store.getTenantById(t.id)) as Tenant;
    expect(row.video_finish_unreachable).toBe(1);
  });
});

describe("the reader floor: refusing to write something nobody can read", () => {
  it("REFUSES to mark a studio that does not serve the capability key, and writes NOTHING", async () => {
    // The failure family this refusal exists to leave: a change that looks applied and reaches
    // nobody (cf#98, cf#118, cp#112). The live tenant runs a v1.6.0 bundle and the reader first
    // shipped in v1.9.0, so the var would be a silent no-op there.
    served = [null];
    const t = await seedTenant();
    const d = deps();
    const pre = await preflightVideoFinishTierState(d, t, MARK);
    expect(pre.ok).toBe(false);
    if (pre.ok) return;
    expect(pre.refusal.code).toBe("studio_reader_absent");
    expect(pre.refusal.status).toBe(422);
    // The message must name BOTH causes, because the fix differs between them.
    expect(pre.refusal.message).toMatch(/BOUND/);
    expect(pre.refusal.message).toMatch(/v1\.9\.0/);
    // Nothing written: not the record, not the studio. A refusal that already changed something is
    // not a refusal.
    const row = (await store.getTenantById(t.id)) as Tenant;
    expect(row.video_finish_unreachable).toBe(0);
    expect(patched).toEqual([]);
  });

  it("POSITIVE CONTROL: the same path ACCEPTS a studio that does serve the key", async () => {
    // Without this, the refusal above could be passing because the preflight refuses everything.
    served = [PROVISIONABLE_SENTENCE];
    const t = await seedTenant();
    const pre = await preflightVideoFinishTierState(deps(), t, MARK);
    expect(pre.ok, pre.ok ? "" : pre.refusal.code + ": " + pre.refusal.message).toBe(true);
  });

  it("does NOT apply the floor to CLEARING: un-saying something must always be possible", async () => {
    // The asymmetry is deliberate. Marking a studio that cannot read the var writes something nobody
    // sees; clearing removes a label and converges a studio that may be carrying a stale one.
    served = [null];
    const t = await seedTenant();
    const pre = await preflightVideoFinishTierState(deps(), t, CLEAR);
    expect(pre.ok).toBe(true);
  });

  it("refuses when the studio cannot be READ at all, which is a different fact from an absent key", async () => {
    const t = await seedTenant();
    const d = deps(census(), {
      callTenantStudio: vi.fn(async () => ({ status: 503, text: "down" })) as unknown as ProvisionDeps["callTenantStudio"],
    });
    const pre = await preflightVideoFinishTierState(d, t, MARK);
    expect(pre.ok).toBe(false);
    if (pre.ok) return;
    expect(pre.refusal.code).toBe("studio_not_serving");
  });

  it("refuses a tenant with no studio, and a deleted one, before touching anything", async () => {
    const t = await seedTenant();
    const noScript = await preflightVideoFinishTierState(deps(), { ...t, script_name: null }, MARK);
    expect(noScript.ok).toBe(false);
    if (!noScript.ok) expect(noScript.refusal.code).toBe("not_provisioned");

    const deleted = await preflightVideoFinishTierState(deps(), { ...t, deleted_at: "2026-01-01" }, MARK);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.refusal.code).toBe("tenant_deleted");
    expect(patched).toEqual([]);
  });
});
