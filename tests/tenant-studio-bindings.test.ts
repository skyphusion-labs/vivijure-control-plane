// cp#112: an EXISTING tenant receives the cf#118 video-finish binding.
//
// What these tests can and cannot prove, stated up front because a green run here is easy to
// over-read: every assertion below runs against a FAKE CfApi, so they prove the DECISION PATHS (what
// is sent, through which credential, what is refused, what a short readback does). They prove
// nothing about what Cloudflare does with the request. That half was settled separately and is not
// assumed: a live probe (2026-07-25, recorded on cp#112) established that the endpoint takes
// multipart rather than JSON, that `inherit` preserves a `secret_text` binding, and that an omitted
// binding is dropped. The wire shape has its own test in tests/cf-api-settings-patch.test.ts.
//
// The property that matters most is #2: this route must never handle a secret VALUE, because two of
// a tenant studio secrets cannot be reproduced by the plane at all.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { CfApiError, type CfApi, type WorkerBinding } from "../src/cf-api";
import type { ProvisionDeps } from "../src/provisioner";
import {
  detachTenantStudioBinding,
  preflightStudioBindingDetach,
  preflightStudioBindings,
  refreshTenantStudioBindings,
  StudioBindingError,
  VIDEO_FINISH_BINDING,
} from "../src/tenant-studio-bindings";
import { MemoryStore } from "./memory-store";
import type { Tenant } from "../src/store";
import { VIDEO_FINISH_TIER_STATE_VAR } from "../src/video-finish-tier-state";

const SERVICE_ID = "019ecbe6-9fc1-70a0-9946-14bbec0f51bc";
const SCRIPT = "tenant-hero-studio";

/**
 * The REAL binding census of the live tenant studio, read off the Cloudflare API 2026-07-25
 * (18 bindings, no VIDEO_FINISH_VPC). Using the real shape rather than a two-item invention is what
 * makes "every existing binding is carried forward" mean something.
 */
const LIVE_BINDINGS: { type: string; name: string }[] = [
  { type: "assets", name: "ASSETS" },
  { type: "d1", name: "DB" },
  { type: "dispatch_namespace", name: "MODULE_DISPATCH" },
  { type: "plain_text", name: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { type: "plain_text", name: "AUTH_MODE" },
  { type: "plain_text", name: "MUSETALK_RUNPOD_ENDPOINT_ID" },
  { type: "plain_text", name: "R2_S3_BUCKET" },
  { type: "plain_text", name: "R2_S3_ENDPOINT" },
  { type: "plain_text", name: "RUNPOD_ENDPOINT_ID" },
  { type: "plain_text", name: "SPEND_DAILY_CEILING" },
  { type: "plain_text", name: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { type: "r2_bucket", name: "R2" },
  { type: "r2_bucket", name: "R2_RENDERS" },
  { type: "ratelimit", name: "SPEND_RATE_LIMITER" },
  { type: "secret_text", name: "R2_S3_ACCESS_KEY_ID" },
  { type: "secret_text", name: "R2_S3_SECRET_ACCESS_KEY" },
  { type: "secret_text", name: "RUNPOD_API_KEY" },
  { type: "secret_text", name: "STUDIO_API_TOKEN" },
];
const LIVE_SECRETS = ["R2_S3_ACCESS_KEY_ID", "R2_S3_SECRET_ACCESS_KEY", "RUNPOD_API_KEY", "STUDIO_API_TOKEN"];

let store: MemoryStore;
let patched: { via: "cf" | "scriptUpload"; bindings: WorkerBinding[] }[];
let readsVia: string[];

interface CensusState {
  before: { type: string; name: string }[];
  after: { type: string; name: string }[];
  secretsBefore: string[];
  secretsAfter: string[];
}

/**
 * A fake that answers the FIRST census with `before` and the second with `after`, so a readback that
 * differs from the write is expressible. Without that, a test suite can only ever see the state it
 * already assumed.
 */
function fakeCf(via: "cf" | "scriptUpload", census: CensusState, over: Partial<CfApi> = {}): CfApi {
  let bindingReads = 0;
  let secretReads = 0;
  return {
    getScriptBindings: vi.fn(async () => {
      readsVia.push(via);
      bindingReads += 1;
      return bindingReads === 1 ? census.before : census.after;
    }),
    getScriptSecretNames: vi.fn(async () => {
      secretReads += 1;
      return secretReads === 1 ? census.secretsBefore : census.secretsAfter;
    }),
    patchScriptSettings: vi.fn(async (_ns: string, _script: string, bindings: WorkerBinding[]) => {
      patched.push({ via, bindings });
    }),
    uploadUserWorker: vi.fn(async () => {
      throw new Error("cp#112 must not re-upload the studio: no bytes, no release change");
    }),
    ...over,
  } as unknown as CfApi;
}

function deps(census: CensusState, over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    store,
    cf: fakeCf("cf", census),
    scriptUploadCf: fakeCf("scriptUpload", census),
    videoFinishServiceId: SERVICE_ID,
    namespace: "vivijure-tenants",
    release: "v1.7.0",
    tenantScriptName: (slug: string) => `tenant-${slug}-studio`,
    log: () => undefined,
    ...over,
  } as unknown as ProvisionDeps;
}

const census = (over: Partial<CensusState> = {}): CensusState => ({
  before: LIVE_BINDINGS,
  after: [...LIVE_BINDINGS, { type: "vpc_service", name: VIDEO_FINISH_BINDING }],
  secretsBefore: LIVE_SECRETS,
  secretsAfter: LIVE_SECRETS,
  ...over,
});

async function tenant(over: Partial<Tenant> = {}): Promise<Tenant> {
  const t = await store.createTenant("ten_1", "hero", "acct_1", "live");
  t.script_name = SCRIPT;
  t.studio_release = "v1.6.0";
  Object.assign(t, over);
  return t;
}

const run = async (d: ProvisionDeps, t: Tenant) => await refreshTenantStudioBindings(d, t, SCRIPT, SERVICE_ID);

beforeEach(async () => {
  store = new MemoryStore();
  patched = [];
  readsVia = [];
  await store.createAccount("acct_1", "a@b.com");
});

describe("cp#112: refreshing an existing tenant studio bindings", () => {
  it("carries EVERY existing binding forward as inherit, and adds the vpc_service", async () => {
    const t = await tenant();
    await run(deps(census()), t);

    expect(patched.length).toBe(1);
    const sent = patched[0].bindings;
    // Exact set equality, not a subset match: the failure this guards against is a binding QUIETLY
    // MISSING from the desired set, which every subset assertion passes straight over.
    expect(new Set(sent.map((b) => b.name))).toEqual(
      new Set([...LIVE_BINDINGS.map((b) => b.name), VIDEO_FINISH_BINDING]),
    );
    expect(sent.filter((b) => b.type === "inherit").length).toBe(LIVE_BINDINGS.length);
    expect(sent.find((b) => b.name === VIDEO_FINISH_BINDING)).toEqual({
      type: "vpc_service",
      name: VIDEO_FINISH_BINDING,
      service_id: SERVICE_ID,
    });
  });

  it("sends NO binding value of any kind: every carried binding is exactly {type,name}", async () => {
    // THE PROPERTY THIS ROUTE EXISTS FOR. R2_S3_SECRET_ACCESS_KEY (SHA-256 of an R2 token value the
    // plane never stored) and RUNPOD_API_KEY (key B, transient by ruling) cannot be reproduced here,
    // so any code path that tries to restate them would strand the tenant. Asserted structurally --
    // the inherit entries must carry no third key at all -- rather than by grepping for a value,
    // because a value we cannot construct would show up as `undefined`, which greps clean.
    const t = await tenant();
    await run(deps(census()), t);
    const inherits = patched[0].bindings.filter((x) => x.type === "inherit");
    // The loop below passes VACUOUSLY over an empty list, which a mutation run proved: dropping the
    // inherits entirely left this test green. Count first, then inspect.
    expect(inherits.length).toBe(LIVE_BINDINGS.length);
    for (const b of inherits) {
      expect(Object.keys(b).sort()).toEqual(["name", "type"]);
    }
  });

  it("WRITES through the upload credential and READS BACK through the other one", async () => {
    // Both halves matter. The write needs Connectivity Directory access (cf#118), and the readback
    // must not be the writing client grading its own homework: the PATCH response echoes nothing,
    // and success:true is an opinion.
    const t = await tenant();
    await run(deps(census()), t);
    expect(patched[0].via).toBe("scriptUpload");
    expect(readsVia).toEqual(["cf", "cf"]);
  });

  it("never touches the studio bytes, the release, or the tenant status", async () => {
    // The uploadUserWorker fake THROWS, so a re-upload cannot pass silently; and both columns plus
    // the status are read back off the store rather than assumed from "we did not call setter X".
    const t = await tenant();
    await run(deps(census()), t);
    const after = await store.getTenantById("ten_1");
    expect(after?.status).toBe("live");
    expect(after?.studio_release).toBe("v1.6.0");
  });

  it("is idempotent by CONVERGENCE: an already-bound tenant is re-patched with the CONFIGURED id", async () => {
    // Skipping when the name is already present would leave a tenant pinned to a stale service id
    // after the plane is re-pointed, and report that as success. The CF endpoint does return
    // service_id (verified live 2026-07-25); our getScriptBindings wrapper does not surface it, so
    // the code here cannot see it and "already present" cannot mean "already correct".
    const t = await tenant();
    const already = census({
      before: [...LIVE_BINDINGS, { type: "vpc_service", name: VIDEO_FINISH_BINDING }],
    });
    const res = await run(deps(already), t);

    expect(res.already_present).toBe(true);
    expect(res.ok).toBe(true);
    expect(patched.length).toBe(1);
    // Exactly ONE VIDEO_FINISH_VPC entry in the desired set: the old one is replaced, not duplicated.
    expect(patched[0].bindings.filter((b) => b.name === VIDEO_FINISH_BINDING)).toEqual([
      { type: "vpc_service", name: VIDEO_FINISH_BINDING, service_id: SERVICE_ID },
    ]);
  });

  it("reports ok:false and NAMES what went missing when the readback comes back short", async () => {
    // The strand this route fears, made to happen on purpose: the patch lands and a secret is gone
    // afterwards. Watching this assertion FAIL (ok:true, missing_secrets empty) is what proves the
    // readback is load-bearing rather than decorative.
    const t = await tenant();
    const lost = census({
      after: [
        ...LIVE_BINDINGS.filter((b) => b.name !== "R2_S3_SECRET_ACCESS_KEY"),
        { type: "vpc_service", name: VIDEO_FINISH_BINDING },
      ],
      secretsAfter: LIVE_SECRETS.filter((n) => n !== "R2_S3_SECRET_ACCESS_KEY"),
    });
    const res = await run(deps(lost), t);

    expect(res.ok).toBe(false);
    expect(res.missing_secrets).toEqual(["R2_S3_SECRET_ACCESS_KEY"]);
    expect(res.missing_bindings).toEqual(["R2_S3_SECRET_ACCESS_KEY"]);
    // The census travels with the verdict so an operator does not have to go and re-read it.
    expect(res.bindings_before.length).toBe(LIVE_BINDINGS.length);
    expect(res.secrets_before).toEqual([...LIVE_SECRETS].sort());
  });

  it("reports ok:false when the binding it exists to add is NOT there afterwards", async () => {
    const t = await tenant();
    const noop = census({ after: LIVE_BINDINGS });
    const res = await run(deps(noop), t);
    expect(res.ok).toBe(false);
    expect(res.missing_bindings).toEqual([]);
  });

  it("POSITIVE CONTROL: the ordinary case really does report ok:true", async () => {
    // Without this, every ok:false assertion above could be passing because the function always
    // returns false.
    const res = await run(deps(census()), await tenant());
    expect(res.ok).toBe(true);
    expect(res.missing_bindings).toEqual([]);
    expect(res.missing_secrets).toEqual([]);
  });

  it("translates the CF VPC refusal into a message naming the PLANE credential", async () => {
    const t = await tenant();
    const refusing = fakeCf("scriptUpload", census(), {
      patchScriptSettings: vi.fn(async () => {
        throw new CfApiError("wfp.patchSettings", 403, [
          { code: 10196, message: "Workers VPC binding configuration failed because your credentials are not authorized" },
        ]);
      }) as unknown as CfApi["patchScriptSettings"],
    });
    await expect(run(deps(census(), { scriptUploadCf: refusing }), t)).rejects.toThrow(StudioBindingError);
    await expect(run(deps(census(), { scriptUploadCf: refusing }), t)).rejects.toThrow(/CF_WORKER_UPLOAD_TOKEN/);
  });

  it("does NOT swallow an unrelated CF failure into the VPC message", async () => {
    // A refusal that explains the wrong thing sends the operator to check a credential scope that
    // was never the problem.
    const t = await tenant();
    const broken = fakeCf("scriptUpload", census(), {
      patchScriptSettings: vi.fn(async () => {
        throw new CfApiError("wfp.patchSettings", 500, [{ code: 10021, message: "script not found" }]);
      }) as unknown as CfApi["patchScriptSettings"],
    });
    await expect(run(deps(census(), { scriptUploadCf: broken }), t)).rejects.toThrow(/script not found/);
    await expect(run(deps(census(), { scriptUploadCf: broken }), t)).rejects.not.toThrow(StudioBindingError);
  });
});

describe("cp#112 preflight: refuses before it writes", () => {
  it("refuses a tenant whose studio was never uploaded, and writes nothing", async () => {
    const t = await tenant({ script_name: null });
    const pre = preflightStudioBindings(deps(census()), t);
    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error("unreachable");
    expect(pre.refusal.code).toBe("not_provisioned");
    expect(pre.refusal.status).toBe(409);
    expect(patched).toEqual([]);
  });

  it("refuses when the plane runs no video-finish tier (cp#109 honest refusal)", async () => {
    const t = await tenant();
    const pre = preflightStudioBindings(deps(census(), { videoFinishServiceId: null }), t);
    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error("unreachable");
    expect(pre.refusal.code).toBe("video_finish_unconfigured");
    expect(pre.refusal.message).toMatch(/VIDEO_FINISH_VPC_SERVICE_ID/);
  });

  it("POSITIVE CONTROL: a provisioned tenant on a configured plane PASSES preflight", async () => {
    // The two refusals above are only meaningful next to a case that gets through.
    const pre = preflightStudioBindings(deps(census()), await tenant());
    expect(pre.ok).toBe(true);
    if (!pre.ok) throw new Error("unreachable");
    expect(pre.script).toBe(SCRIPT);
    expect(pre.serviceId).toBe(SERVICE_ID);
  });
});

// cp#136 criterion 3: the DETACH half, and the guard that keeps the two operator statements apart.
//
// WHY A DETACH IS TESTABLE AS A NEW FACT rather than a variation: before this, no writer in this
// plane could produce a payload WITHOUT the tier. The attach path appends it unconditionally, the
// provision path attaches it whenever the service id is set, and the upgrade path inherits it. The
// first test below asserts the sent payload omits exactly one binding and carries every other one,
// which is a payload no pre-existing code path could produce -- the attach assertions earlier in
// this file are its control, since both run through the same recording proxy.
describe("cp#136: detaching the video-finish tier from a live tenant", () => {
  const bound = () => census({ before: [...LIVE_BINDINGS, { type: "vpc_service", name: VIDEO_FINISH_BINDING }] });

  it("SENDS a payload that omits the tier and carries everything else", async () => {
    const t = await tenant();
    const d = deps(bound());
    const pre = preflightStudioBindingDetach(t);
    expect(pre.ok, JSON.stringify(pre)).toBe(true);
    if (!pre.ok) return;
    await detachTenantStudioBinding(d, t, pre.script);

    expect(patched).toHaveLength(1);
    const sent = patched[0].bindings;
    // CONTROL: a real payload was recorded, so the absence below is an omission rather than an
    // empty run.
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.find((b) => b.name === VIDEO_FINISH_BINDING)).toBeUndefined();
    for (const b of LIVE_BINDINGS) {
      expect(sent.find((x) => x.name === b.name), "dropped " + b.name).toEqual({ type: "inherit", name: b.name });
    }
    expect(patched[0].via).toBe("scriptUpload");
  });

  it("never handles a binding VALUE: the custody claim, on this path too", async () => {
    const t = await tenant();
    const d = deps(bound());
    const pre = preflightStudioBindingDetach(t);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    await detachTenantStudioBinding(d, t, pre.script);
    for (const b of patched[0].bindings as unknown as Record<string, unknown>[]) {
      expect(b.text).toBeUndefined();
      expect(b.service_id).toBeUndefined();
    }
  });

  it("is idempotent by CONVERGENCE: an already-absent tier is patched anyway and reported", async () => {
    const t = await tenant();
    // `after` stated explicitly: the shared census helper defaults it to the ATTACH outcome (the
    // tier PRESENT), which is the right default for every test above and the wrong one here.
    const d = deps(census({ after: LIVE_BINDINGS }));
    const pre = preflightStudioBindingDetach(t);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    const result = await detachTenantStudioBinding(d, t, pre.script);
    expect(result.already_absent).toBe(true);
    expect(patched).toHaveLength(1);
    expect(result.ok).toBe(true);
  });

  it("reports a binding that went MISSING across the patch instead of reporting success", async () => {
    const t = await tenant();
    const lost = LIVE_BINDINGS.filter((b) => b.name !== "AUTH_MODE");
    const d = deps(census({ before: [...LIVE_BINDINGS, { type: "vpc_service", name: VIDEO_FINISH_BINDING }], after: lost }));
    const pre = preflightStudioBindingDetach(t);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    const result = await detachTenantStudioBinding(d, t, pre.script);
    expect(result.missing_bindings).toEqual(["AUTH_MODE"]);
    expect(result.ok).toBe(false);
  });

  it("is NOT ok when the tier is still bound after the patch, even though the call returned", async () => {
    const t = await tenant();
    const d = deps(bound());
    const pre = preflightStudioBindingDetach(t);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    const result = await detachTenantStudioBinding(d, t, pre.script);
    expect(result.ok).toBe(false);
  });

  it("RE-DERIVES the cp#136 var rather than inheriting it, so a stale one is dropped here too", async () => {
    const t = await tenant();
    const d = deps(
      census({
        before: [
          ...LIVE_BINDINGS,
          { type: "vpc_service", name: VIDEO_FINISH_BINDING },
          { type: "plain_text", name: VIDEO_FINISH_TIER_STATE_VAR },
        ],
      }),
    );
    const pre = preflightStudioBindingDetach(t);
    if (!pre.ok) throw new Error("preflight refused: " + pre.refusal.code);
    await detachTenantStudioBinding(d, t, pre.script);
    expect(patched[0].bindings.find((b) => b.name === VIDEO_FINISH_TIER_STATE_VAR)).toBeUndefined();
  });
});

describe("cp#136: one truth at a time -- the declaration guard on BOTH directions", () => {
  const declared = async (): Promise<Tenant> => {
    const t = await tenant();
    await store.setTenantVideoFinishUnreachable(t.id, { reason: "the CF account is gone", at: "2026-07-26T12:00:00.000Z" });
    return { ...t, video_finish_unreachable: 1, video_finish_unreachable_reason: "the CF account is gone" };
  };

  it("ATTACH refuses while a declaration stands: attaching would make the record false", async () => {
    const pre = preflightStudioBindings(deps(census()), await declared());
    expect(pre.ok).toBe(false);
    if (pre.ok) return;
    expect(pre.refusal.code).toBe("video_finish_declared");
    expect(pre.refusal.status).toBe(409);
    expect(pre.refusal.message).toMatch(/video-finish-tier-state/);
  });

  it("POSITIVE CONTROL: the SAME preflight passes for an undeclared tenant", async () => {
    const pre = preflightStudioBindings(deps(census()), await tenant());
    expect(pre.ok, pre.ok ? "" : pre.refusal.code).toBe(true);
  });

  it("DETACH refuses while a declaration stands, and says which way to go", async () => {
    const pre = preflightStudioBindingDetach(await declared());
    expect(pre.ok).toBe(false);
    if (pre.ok) return;
    expect(pre.refusal.code).toBe("video_finish_declared");
  });

  it("POSITIVE CONTROL: detach preflight passes for an undeclared tenant", async () => {
    const pre = preflightStudioBindingDetach(await tenant());
    expect(pre.ok, pre.ok ? "" : pre.refusal.code).toBe(true);
  });

  it("detach needs NO service id, because it names none", async () => {
    // Deliberate asymmetry with the attach half: a plane that has lost its tier configuration must
    // still be able to take the tier OFF a tenant, which is the direction you want to be able to
    // move in when something is wrong.
    //
    // ONE tenant, reused: the memory store enforces the real UNIQUE(slug) constraint, so creating a
    // second `hero` here throws exactly as D1 would.
    const t = await tenant();
    expect(preflightStudioBindingDetach(t).ok).toBe(true);
    const attach = preflightStudioBindings(deps(census(), { videoFinishServiceId: null }), t);
    expect(attach.ok).toBe(false);
    if (!attach.ok) expect(attach.refusal.code).toBe("video_finish_unconfigured");
  });
});
