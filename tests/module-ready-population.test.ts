// THE LAUNCH BLOCKER: at any STUDIO_RELEASE >= vivijure-cf v1.14.0, no tenant could complete an
// invoke-key install, in any mode.
//
// HOW IT HAPPENED, and it is worth stating because nothing in either repo's suite could see it.
// awaitTenantModulesReady probed the WHOLE catalog. classifyReadyResponse enforces this contract's
// one question -- can the version the edge serves read its RUNPOD credential (cf#114) -- by
// requiring boolean `runpod_api_key` and `runpod_endpoint_id`. `plan-enhance` reaches Anthropic
// through the AI Gateway, submits no RunPod job, and answers with `gateway_id` / `cf_aig_token`.
// Neither required field, so `misconfigured`, which is explicitly non-retryable and THROWS.
//
// It was ARMED BY AN IMPROVEMENT. vivijure-cf#308 extended GET /ready from 6 modules to 26. Before
// it, plan-enhance had no /ready, answered 404 and classified `unverifiable` -- recorded and benign.
// After it, the same module answers 200 in a shape this contract rejects. A COVERAGE IMPROVEMENT
// CONVERTED A BENIGN 404 INTO A FATAL VERDICT on the critical path of every tenant going live.
// Each half is correct on its own; only the cross-repo pair is wrong (cf#403).
//
// The fix is the POPULATION, not the classifier. Teaching classifyReadyResponse a second body shape
// would make the plane parse a union and leave the cross-repo contract exactly as fragile.

import { describe, it, expect, vi } from "vitest";
import {
  awaitTenantModulesReady,
  classifyReadyResponse,
  reachesRunpod,
  tenantModuleScriptName,
  TENANT_MODULE_CATALOG,
  type TenantModuleDeps,
} from "../src/tenant-modules";

const TENANT = "ten_blocker";
const ALL = TENANT_MODULE_CATALOG.map((s) => s.module);
/** DERIVED, never re-listed (cp#314). This catalog went 6 -> 15 in one day. */
const REACHERS = TENANT_MODULE_CATALOG.filter(reachesRunpod).map((s) => s.module);
const NON_REACHERS = TENANT_MODULE_CATALOG.filter((s) => !reachesRunpod(s)).map((s) => s.module);

/** The body a RunPod-reaching module actually serves. */
const runpodReadyBody = (module: string, key = true, endpoint = true) =>
  JSON.stringify({ ok: key && endpoint, module, credentials: { runpod_api_key: key, runpod_endpoint_id: endpoint } });

/** VERBATIM from vivijure-cf@v1.20.0 modules/plan-enhance/src/index.ts:290-294. Not a paraphrase:
 *  a fixture that drifts from the shape production serves is a fixture that stopped standing in for
 *  its subject, and this whole defect lives in the gap between two repos' idea of one contract. */
const gatewayReadyBody = (module: string) =>
  JSON.stringify({ ok: true, module, credentials: { gateway_id: true, cf_aig_token: true } });

function fleet(answer: (module: string) => { status: number; text: string }) {
  const asked: string[] = [];
  const deps = {
    callTenantModule: async (script: string) => {
      const module = ALL.find((m) => script === tenantModuleScriptName(TENANT, m)) ?? script;
      asked.push(module);
      return answer(module);
    },
    log: vi.fn(),
  } as unknown as TenantModuleDeps;
  return { deps, asked };
}

/** Every module answers the way the PINNED release really answers. */
const realWorld = (module: string) =>
  reachesRunpod(TENANT_MODULE_CATALOG.find((s) => s.module === module)!)
    ? { status: 200, text: runpodReadyBody(module) }
    : { status: 200, text: gatewayReadyBody(module) };

// ---- 0. CONTROLS -------------------------------------------------------------------------------

describe("CONTROLS", () => {
  it("the two populations are non-empty and partition the catalog", () => {
    expect(REACHERS.length).toBeGreaterThan(0);
    expect(NON_REACHERS.length).toBeGreaterThan(0);
    expect(REACHERS.length + NON_REACHERS.length).toBe(ALL.length);
    console.log(`catalog=${ALL.length} reachers=${REACHERS.length} nonReachers=${JSON.stringify(NON_REACHERS)}`);
  });

  it("THE DEFECT ITSELF: the gateway-shaped body really does classify misconfigured", () => {
    // The reason this fix is a population change and not a classifier change. If this ever stops
    // being true the fix below is solving a problem that moved.
    for (const m of NON_REACHERS) {
      expect(classifyReadyResponse(200, gatewayReadyBody(m), m), m).toBe("misconfigured");
    }
    // POSITIVE CONTROL: the same classifier on the same day returns `ready` for a RunPod body, so
    // the line above is a fact about the SHAPE and not about a classifier stuck on one answer.
    expect(classifyReadyResponse(200, runpodReadyBody("keyframe"), "keyframe")).toBe("ready");
  });
});

// ---- 1. THE BLOCKER, GONE ----------------------------------------------------------------------

describe("a tenant on the pinned release can complete an invoke-key install", () => {
  it("does NOT throw when the non-RunPod module answers its real gateway-shaped body", async () => {
    // Pre-fix this threw TenantModuleError("verify") and the route answered 503 modules_not_ready.
    const { deps } = fleet(realWorld);
    const r = await awaitTenantModulesReady(deps, TENANT);
    expect(r.verified.sort()).toEqual([...REACHERS].sort());
    expect(r.unconfirmed).toEqual([]);
  });

  it("never ASKS the modules that carry no RunPod credential", async () => {
    const { deps, asked } = fleet(realWorld);
    await awaitTenantModulesReady(deps, TENANT);
    for (const m of NON_REACHERS) expect(asked, m).not.toContain(m);
    // Control on the same recorder: it definitely DID ask the reachers, so the absence above is a
    // fact about the population rather than about a recorder that captured nothing.
    for (const m of REACHERS) expect(asked, m).toContain(m);
  });

  it("REPORTS the exclusion rather than hiding it, and the counts reconstruct the catalog", async () => {
    const { deps } = fleet(realWorld);
    const r = await awaitTenantModulesReady(deps, TENANT);
    expect(r.notProbed.sort()).toEqual([...NON_REACHERS].sort());
    expect(r.verified.length + r.unverified.length + r.unconfirmed.length + r.notProbed.length).toBe(ALL.length);
  });
});

// ---- 2. THE GUARD IS NOT WEAKENED --------------------------------------------------------------
// The obvious wrong fix is to make `misconfigured` non-fatal, which would launder a real broken
// tenant into a pass. These pin that the gate still bites on the population it still covers.

describe("a RunPod-reaching module that is genuinely misconfigured STILL fails hard", () => {
  it("throws when a reacher reports its endpoint id missing", async () => {
    const { deps } = fleet((m) =>
      m === "keyframe" ? { status: 200, text: runpodReadyBody(m, true, false) } : realWorld(m),
    );
    await expect(awaitTenantModulesReady(deps, TENANT)).rejects.toThrow(/keyframe/);
  });

  it("throws when a reacher answers a body that is not the contract envelope", async () => {
    const { deps } = fleet((m) => (m === "own-gpu" ? { status: 200, text: "{}" } : realWorld(m)));
    await expect(awaitTenantModulesReady(deps, TENANT)).rejects.toThrow(/own-gpu/);
  });

  it("a reacher answering the GATEWAY shape is still misconfigured -- the exclusion is by PREDICATE, not by body", async () => {
    // The exclusion must not become "any module whose body lacks the fields is fine", which would
    // re-open the hole for a real RunPod module that regressed its /ready.
    const { deps } = fleet((m) => (m === "kling" ? { status: 200, text: gatewayReadyBody(m) } : realWorld(m)));
    await expect(awaitTenantModulesReady(deps, TENANT)).rejects.toThrow(/kling/);
  });
});

// ---- 3. THE FLOOR ------------------------------------------------------------------------------

describe("an empty probed population is a failure, never a clean pass", () => {
  it("refuses rather than reporting readiness for a tenant nothing was asked about", async () => {
    // If the predicate ever excluded every row, the old code would return a spotless readiness
    // having probed nothing -- a green that cannot go red, inside the probe that exists to stop
    // exactly that. THE POPULATION HAD NO SEAM, which is a finding about the code and not an
    // inconvenience in the test, so the catalog is now injectable exactly as `timing` already was.
    const { deps, asked } = fleet(realWorld);
    const onlyNonReachers = TENANT_MODULE_CATALOG.filter((s) => !reachesRunpod(s));
    await expect(
      awaitTenantModulesReady(deps, TENANT, undefined, undefined, onlyNonReachers),
    ).rejects.toThrow(/refusing to report readiness/);
    // It refused BEFORE asking anything, which is the point: no spend, no partial probe.
    expect(asked).toEqual([]);
  });

  it("CONTROL on the floor: the same seam with a real population does NOT refuse", async () => {
    // Without this, the refusal above is satisfied by a function that throws on every input.
    const { deps } = fleet(realWorld);
    const r = await awaitTenantModulesReady(deps, TENANT, undefined, undefined, TENANT_MODULE_CATALOG);
    expect(r.verified.length).toBe(REACHERS.length);
  });
});
