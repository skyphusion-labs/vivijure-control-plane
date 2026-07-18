// cf#114 (c): the control plane proves a tenant module actually SERVES its freshly-installed key
// before the tenant is promoted to live.
//
// The property under test is not "does it wait". It is: THE RETRY CAN NEVER LAUNDER A REAL
// MISCONFIGURATION INTO A SUCCESS. Every test below exists to pin one edge of that line, and the
// true-negative cases (a key that is never written, an endpoint id that is missing, a garbage 200)
// matter more than the happy path -- a probe that only proves the happy path is how you ship a gate
// that says PASS over a broken tenant.

import { describe, it, expect, vi } from "vitest";
import {
  awaitTenantModulesReady,
  classifyReadyResponse,
  tenantModuleScriptName,
  TENANT_MODULE_CATALOG,
  MODULE_READY_PROBE_DEADLINE_MS,
  type TenantModuleDeps,
} from "../src/tenant-modules";

const TENANT = "ten_abc123";
const ALL = TENANT_MODULE_CATALOG.map((s) => s.module);

const readyBody = (module: string, key: boolean, endpoint = true) =>
  JSON.stringify({ ok: key && endpoint, module, credentials: { runpod_api_key: key, runpod_endpoint_id: endpoint } });

/** Virtual clock: the deadline behaviour is asserted without burning real seconds, and every sleep
 *  is RECORDED so a test can prove the probe respected its budget rather than trusting that it did. */
function fakeTiming() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    timing: {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    },
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A module fleet whose /ready answer is a function of (module, attempt number). */
function fleet(answer: (module: string, attempt: number) => { status: number; text: string }) {
  const calls: { script: string; path: string }[] = [];
  const attempts = new Map<string, number>();
  const deps = {
    callTenantModule: async (script: string, path: string) => {
      calls.push({ script, path });
      const module = ALL.find((m) => script === tenantModuleScriptName(TENANT, m)) ?? script;
      const n = (attempts.get(module) ?? 0) + 1;
      attempts.set(module, n);
      return answer(module, n);
    },
    log: vi.fn(),
  } as unknown as TenantModuleDeps;
  return { deps, calls };
}

describe("classifyReadyResponse: the retryable shape, and ONLY it", () => {
  it("both credentials visible -> ready", () => {
    expect(classifyReadyResponse(200, readyBody("keyframe", true, true), "keyframe")).toBe("ready");
  });

  it("endpoint present + key absent -> not_visible_yet (the ONE propagation shape)", () => {
    expect(classifyReadyResponse(200, readyBody("keyframe", false, true), "keyframe")).toBe("not_visible_yet");
  });

  it("endpoint ABSENT is a real defect, never a wait: the endpoint id is bound at UPLOAD", () => {
    // This is the case a lazy implementation would lump in with propagation and retry. It cannot
    // resolve by waiting -- if the endpoint id is missing the upload was wrong.
    expect(classifyReadyResponse(200, readyBody("keyframe", false, false), "keyframe")).toBe("misconfigured");
    expect(classifyReadyResponse(200, readyBody("keyframe", true, false), "keyframe")).toBe("misconfigured");
  });

  it("404 -> unverifiable: nothing answered, and we do NOT get to guess which reason", () => {
    expect(classifyReadyResponse(404, "not found", "keyframe")).toBe("unverifiable");
  });

  it("any other status is a hard failure, not a race", () => {
    for (const status of [400, 401, 403, 429, 500, 502, 503]) {
      expect(classifyReadyResponse(status, "boom", "keyframe")).toBe("misconfigured");
    }
  });

  it("a 200 that is not the contract envelope is refused, never read optimistically", () => {
    expect(classifyReadyResponse(200, "not json", "keyframe")).toBe("misconfigured");
    expect(classifyReadyResponse(200, "{}", "keyframe")).toBe("misconfigured");
    expect(classifyReadyResponse(200, JSON.stringify({ ok: true }), "keyframe")).toBe("misconfigured");
    // ok:true with no credentials block must NOT be believed: a module could claim ready without
    // reporting what it actually read.
    expect(classifyReadyResponse(200, JSON.stringify({ ok: true, module: "keyframe", credentials: {} }), "keyframe")).toBe("misconfigured");
    // Non-boolean credential fields (a truthy string) must not slip through as "true".
    expect(
      classifyReadyResponse(
        200,
        JSON.stringify({ module: "keyframe", credentials: { runpod_api_key: "yes", runpod_endpoint_id: "yes" } }),
        "keyframe",
      ),
    ).toBe("misconfigured");
  });
});

describe("awaitTenantModulesReady: happy path", () => {
  it("returns verified once every module reports both credentials, probing /ready on each script", async () => {
    const { deps, calls } = fleet((m) => ({ status: 200, text: readyBody(m, true) }));
    const { timing } = fakeTiming();
    const r = await awaitTenantModulesReady(deps, TENANT, timing);

    expect(r.verified.sort()).toEqual([...ALL].sort());
    expect(r.unverified).toEqual([]);
    expect(r.unconfirmed).toEqual([]);
    expect(r.attempts).toBe(1);
    expect(calls).toHaveLength(ALL.length);
    expect(calls.every((c) => c.path === "/ready")).toBe(true);
    // Tenant-prefixed script names: probing the wrong script would be a silent false pass.
    for (const m of ALL) {
      expect(calls.map((c) => c.script)).toContain(tenantModuleScriptName(TENANT, m));
    }
  });

  it("retries the not-visible-yet shape and succeeds when the key becomes visible", async () => {
    const { deps, calls } = fleet((m, attempt) => ({ status: 200, text: readyBody(m, attempt >= 3) }));
    const { timing, sleeps } = fakeTiming();
    const r = await awaitTenantModulesReady(deps, TENANT, timing);

    expect(r.verified.sort()).toEqual([...ALL].sort());
    expect(r.attempts).toBe(3);
    expect(calls).toHaveLength(ALL.length * 3);
    expect(sleeps).toEqual([250, 500]); // backoff, and it stopped as soon as it was satisfied
  });

  it("a module that goes ready early is NOT re-probed while a slower one catches up", async () => {
    // Budget hygiene: five modules under ONE deadline means the fast ones must drop out of the loop.
    const slow = ALL[0];
    const { deps, calls } = fleet((m, attempt) => ({
      status: 200,
      text: readyBody(m, m === slow ? attempt >= 3 : true),
    }));
    const { timing } = fakeTiming();
    await awaitTenantModulesReady(deps, TENANT, timing);
    const slowScript = tenantModuleScriptName(TENANT, slow);
    expect(calls.filter((c) => c.script === slowScript)).toHaveLength(3);
    expect(calls.filter((c) => c.script !== slowScript)).toHaveLength(ALL.length - 1);
  });
});

describe("awaitTenantModulesReady: TRUE NEGATIVES (the retry must never launder a real defect)", () => {
  // control-plane#17 CHANGED THIS CONTRACT, deliberately. A key that is not visible yet is
  // INDISTINGUISHABLE from a key that was never written -- both answer endpoint-present/key-absent --
  // so the probe cannot honestly call it a failure. It now returns a SOFT unconfirmed outcome.
  //
  // The SAFETY property is unchanged and is what these tests now pin: an unconfirmed module is NEVER
  // reported verified, so the caller can never flip the tenant live on it. A never-written key
  // therefore still cannot reach a customer render; it just gets an honest "retry" instead of an
  // opaque failure.
  it("a key that is NEVER written returns UNCONFIRMED, never verified", async () => {
    const { deps } = fleet((m) => ({ status: 200, text: readyBody(m, false) }));
    const { timing } = fakeTiming();
    const r = await awaitTenantModulesReady(deps, TENANT, timing);

    expect(r.unconfirmed.sort()).toEqual([...ALL].sort());
    // THE LINE THAT MATTERS: nothing was laundered into verified.
    expect(r.verified).toEqual([]);
    expect(r.unverified).toEqual([]);
    expect(r.attempts).toBeGreaterThan(1);
    expect(r.elapsedMs).toBeGreaterThan(0);
  });

  it("names exactly the modules that never came up, leaving the others verified", async () => {
    const stuck = ALL[1];
    const { deps } = fleet((m) => ({ status: 200, text: readyBody(m, m !== stuck) }));
    const { timing } = fakeTiming();
    const r = await awaitTenantModulesReady(deps, TENANT, timing);

    expect(r.unconfirmed).toEqual([stuck]);
    expect(r.verified.sort()).toEqual(ALL.filter((m) => m !== stuck).sort());
    expect(r.verified).not.toContain(stuck);
  });

  it("a MISSING endpoint id fails IMMEDIATELY -- it is a provisioning defect, not a race", async () => {
    const { deps, calls } = fleet((m) => ({ status: 200, text: readyBody(m, false, false) }));
    const { timing, sleeps } = fakeTiming();
    await expect(awaitTenantModulesReady(deps, TENANT, timing)).rejects.toThrow(/not retryable/);
    expect(sleeps).toEqual([]); // never waited on it
    expect(calls).toHaveLength(ALL.length); // one round, then stop
  });

  it("a 500 fails IMMEDIATELY, without spending the window", async () => {
    const { deps } = fleet(() => ({ status: 500, text: "internal error" }));
    const { timing, sleeps } = fakeTiming();
    await expect(awaitTenantModulesReady(deps, TENANT, timing)).rejects.toThrow(/not retryable/);
    expect(sleeps).toEqual([]);
  });

  it("stays INSIDE its budget: it never sleeps past the deadline", async () => {
    const { deps } = fleet((m) => ({ status: 200, text: readyBody(m, false) }));
    const { timing, sleeps } = fakeTiming();
    await awaitTenantModulesReady(deps, TENANT, timing);
    const slept = sleeps.reduce((a, b) => a + b, 0);
    expect(slept).toBeLessThan(MODULE_READY_PROBE_DEADLINE_MS);
  });

  it("a module that goes ready only AFTER the deadline is NOT counted (no late pass)", async () => {
    const { deps } = fleet((m, attempt) => ({ status: 200, text: readyBody(m, attempt > 50) }));
    const { timing } = fakeTiming();
    const r = await awaitTenantModulesReady(deps, TENANT, timing);
    expect(r.verified).toEqual([]);
    expect(r.unconfirmed.sort()).toEqual([...ALL].sort());
  });

  // The soft path must NOT swallow a real misconfiguration. This is the boundary control: the same
  // deadline machinery, but one module misconfigured -> still a hard throw, no soft outcome.
  it("BOUNDARY: a misconfigured module still THROWS even while others are merely not-visible-yet", async () => {
    const bad = ALL[2];
    const { deps } = fleet((m) =>
      m === bad
        ? { status: 200, text: readyBody(m, false, false) } // endpoint id absent = real defect
        : { status: 200, text: readyBody(m, false) },       // benign propagation
    );
    const { timing } = fakeTiming();
    await expect(awaitTenantModulesReady(deps, TENANT, timing)).rejects.toThrow(/not retryable/);
  });
});

describe("awaitTenantModulesReady: nothing answers /ready at a script (404)", () => {
  it("does not hang and does not retry: it reports UNVERIFIABLE, honestly and by name", async () => {
    const old = ALL[2];
    const { deps, calls } = fleet((m) =>
      m === old ? { status: 404, text: "not found" } : { status: 200, text: readyBody(m, true) },
    );
    const { timing, sleeps } = fakeTiming();
    const r = await awaitTenantModulesReady(deps, TENANT, timing);

    expect(sleeps).toEqual([]);
    expect(calls).toHaveLength(ALL.length);
    expect(r.verified).not.toContain(old);
    expect(r.unverified).toEqual([
      {
        module: old,
        reason: "unverifiable",
        script: tenantModuleScriptName(TENANT, old),
        detail: expect.stringContaining("did not answer GET /ready"),
      },
    ]);
    // The honest part: it is NOT reported as verified, so the caller cannot mistake it for proven.
    expect(r.verified.sort()).toEqual(ALL.filter((m) => m !== old).sort());
  });

  it("an ENTIRELY pre-/ready fleet returns all-unverified rather than a false all-clear", async () => {
    const { deps } = fleet(() => ({ status: 404, text: "not found" }));
    const { timing } = fakeTiming();
    const r = await awaitTenantModulesReady(deps, TENANT, timing);
    expect(r.verified).toEqual([]);
    expect(r.unverified.map((u) => u.module).sort()).toEqual([...ALL].sort());
  });
});

// The module ECHO is the only thing standing between "this module is ready" and "SOME module is
// ready". Script names are tenant-prefixed and derived, so a naming bug reads a healthy neighbour as
// proof about the wrong module unless the echo is checked.
describe("classifyReadyResponse: the module echo must MATCH (wrong-script defence)", () => {
  it("a perfectly healthy answer from the WRONG module is a hard failure, not a pass", () => {
    expect(classifyReadyResponse(200, readyBody("own-gpu", true, true), "keyframe")).toBe("misconfigured");
  });

  it("a missing or non-string echo is refused rather than assumed to be the right module", () => {
    expect(
      classifyReadyResponse(200, JSON.stringify({ credentials: { runpod_api_key: true, runpod_endpoint_id: true } }), "keyframe"),
    ).toBe("misconfigured");
    expect(
      classifyReadyResponse(200, JSON.stringify({ module: 7, credentials: { runpod_api_key: true, runpod_endpoint_id: true } }), "keyframe"),
    ).toBe("misconfigured");
  });

  it("POSITIVE CONTROL: the same body with the RIGHT echo passes, so the check is not vacuous", () => {
    expect(classifyReadyResponse(200, readyBody("keyframe", true, true), "keyframe")).toBe("ready");
  });
});

describe("mixed fleets: every unproven module is named individually", () => {
  it("names EACH unverified module, not a single summary, when several do not answer", async () => {
    const silent = [ALL[1], ALL[3]];
    const { deps } = fleet((m) =>
      silent.includes(m) ? { status: 404, text: "not found" } : { status: 200, text: readyBody(m, true) },
    );
    const { timing } = fakeTiming();
    const r = await awaitTenantModulesReady(deps, TENANT, timing);

    expect(r.unverified.map((u) => u.module).sort()).toEqual([...silent].sort());
    expect(r.verified.sort()).toEqual(ALL.filter((m) => !silent.includes(m)).sort());
    // Each entry carries its OWN module, its OWN script, and its own detail naming that script --
    // an operator has to be able to act per module, not on a collapsed summary string.
    for (const u of r.unverified) {
      expect(u.script).toBe(tenantModuleScriptName(TENANT, u.module));
      expect(u.detail).toContain(u.script);
    }
    expect(new Set(r.unverified.map((u) => u.detail)).size).toBe(silent.length);
  });

  it("is HONEST that a 404 has several indistinguishable causes, and asserts none of them", async () => {
    // The wording is load-bearing. From here we cannot tell "predates /ready" from "no such script"
    // from "the probe never left the control plane", so the detail must not assert any one of them.
    const { deps } = fleet(() => ({ status: 404, text: "not found" }));
    const { timing } = fakeTiming();
    const r = await awaitTenantModulesReady(deps, TENANT, timing);
    for (const u of r.unverified) {
      expect(u.reason).toBe("unverifiable");
      expect(u.detail).toMatch(/predates \/ready/);
      expect(u.detail).toMatch(/the probe could not reach it/);
      expect(u.detail).toMatch(/control plane cannot dispatch to the module namespace/);
      // The detail must also tell the operator what to DO, and what a PERSISTENT 404 then means --
      // naming the causes without saying how to tell them apart leaves the diagnosis unfinished.
      expect(u.detail).toMatch(/re-provision against a release that carries \/ready/);
      expect(u.detail).toMatch(/if it still 404s the script is missing, not stale/);
    }
  });

  // THE CASE THAT WOULD HAVE MISLED. deps.callTenantModule synthesises a 404 carrying
  // "TENANT_MODULE_DISPATCH not bound" when the control plane has no module dispatch binding. The
  // verdict is correctly unverifiable, but if the detail asserts a release-pin cause, the operator
  // goes and re-provisions tenants while the real defect sits in the CP deploy. So the raw response
  // has to SURVIVE classification and reach the report.
  it("surfaces the raw response, so an unbound-binding 404 names ITSELF instead of blaming the pin", async () => {
    const { deps } = fleet(() => ({ status: 404, text: "TENANT_MODULE_DISPATCH not bound" }));
    const { timing } = fakeTiming();
    const r = await awaitTenantModulesReady(deps, TENANT, timing);

    expect(r.unverified).toHaveLength(ALL.length);
    for (const u of r.unverified) {
      expect(u.detail).toContain("TENANT_MODULE_DISPATCH not bound");
      // And it must still point the operator at the response rather than at a re-provision.
      expect(u.detail).toMatch(/if it names a missing binding the defect is in the control plane deploy/);
    }
  });

  it("carries the response text for ANY 404 cause, and says (empty) rather than nothing", async () => {
    const { deps } = fleet(() => ({ status: 404, text: "" }));
    const { timing } = fakeTiming();
    const r = await awaitTenantModulesReady(deps, TENANT, timing);
    for (const u of r.unverified) {
      expect(u.detail).toContain("Response: (empty)");
    }
  });

  it("caps the carried response text so a huge body cannot bloat the report", async () => {
    const { deps } = fleet(() => ({ status: 404, text: "x".repeat(5000) }));
    const { timing } = fakeTiming();
    const r = await awaitTenantModulesReady(deps, TENANT, timing);
    for (const u of r.unverified) {
      expect(u.detail).toContain("x".repeat(200));
      expect(u.detail).not.toContain("x".repeat(201));
    }
  });
});

describe("unverified is STRUCTURALLY distinguishable from verified", () => {
  it("no consumer can conflate the two by truthiness or by shape", async () => {
    const old = ALL[0];
    const { deps } = fleet((m) =>
      m === old ? { status: 404, text: "not found" } : { status: 200, text: readyBody(m, true) },
    );
    const { timing } = fakeTiming();
    const r = await awaitTenantModulesReady(deps, TENANT, timing);

    // Different containers, different element TYPES. verified is a list of plain module names;
    // unverified is a list of objects. A consumer cannot accidentally treat one as the other, and
    // an unverified module can never appear in the verified list.
    expect(r.verified.every((v) => typeof v === "string")).toBe(true);
    expect(r.unverified.every((u) => typeof u === "object" && u !== null)).toBe(true);
    expect(r.verified).not.toContain(old);
    expect(r.verified.some((v) => r.unverified.some((u) => u.module === v))).toBe(false);

    // And the truthiness trap specifically: a non-empty unverified list is TRUTHY, so any consumer
    // testing "did anything go unproven" gets the right answer without inspecting elements.
    expect(Boolean(r.unverified.length)).toBe(true);
    expect(r.verified.length + r.unverified.length).toBe(ALL.length);
  });

  it("a fully-proven fleet reports an EMPTY unverified list, never a placeholder entry", async () => {
    const { deps } = fleet((m) => ({ status: 200, text: readyBody(m, true) }));
    const { timing } = fakeTiming();
    const r = await awaitTenantModulesReady(deps, TENANT, timing);
    expect(r.unverified).toEqual([]);
    expect(Boolean(r.unverified.length)).toBe(false);
  });
});
