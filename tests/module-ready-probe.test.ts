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
    expect(classifyReadyResponse(200, readyBody("keyframe", true, true))).toBe("ready");
  });

  it("endpoint present + key absent -> not_visible_yet (the ONE propagation shape)", () => {
    expect(classifyReadyResponse(200, readyBody("keyframe", false, true))).toBe("not_visible_yet");
  });

  it("endpoint ABSENT is a real defect, never a wait: the endpoint id is bound at UPLOAD", () => {
    // This is the case a lazy implementation would lump in with propagation and retry. It cannot
    // resolve by waiting -- if the endpoint id is missing the upload was wrong.
    expect(classifyReadyResponse(200, readyBody("keyframe", false, false))).toBe("misconfigured");
    expect(classifyReadyResponse(200, readyBody("keyframe", true, false))).toBe("misconfigured");
  });

  it("404 -> no_ready_route (a module image that predates /ready), not a wait and not a pass", () => {
    expect(classifyReadyResponse(404, "not found")).toBe("no_ready_route");
  });

  it("any other status is a hard failure, not a race", () => {
    for (const status of [400, 401, 403, 429, 500, 502, 503]) {
      expect(classifyReadyResponse(status, "boom")).toBe("misconfigured");
    }
  });

  it("a 200 that is not the contract envelope is refused, never read optimistically", () => {
    expect(classifyReadyResponse(200, "not json")).toBe("misconfigured");
    expect(classifyReadyResponse(200, "{}")).toBe("misconfigured");
    expect(classifyReadyResponse(200, JSON.stringify({ ok: true }))).toBe("misconfigured");
    // ok:true with no credentials block must NOT be believed: a module could claim ready without
    // reporting what it actually read.
    expect(classifyReadyResponse(200, JSON.stringify({ ok: true, credentials: {} }))).toBe("misconfigured");
    // Non-boolean credential fields (a truthy string) must not slip through as "true".
    expect(
      classifyReadyResponse(200, JSON.stringify({ credentials: { runpod_api_key: "yes", runpod_endpoint_id: "yes" } })),
    ).toBe("misconfigured");
  });
});

describe("awaitTenantModulesReady: happy path", () => {
  it("returns verified once every module reports both credentials, probing /ready on each script", async () => {
    const { deps, calls } = fleet(() => ({ status: 200, text: readyBody("m", true) }));
    const { timing } = fakeTiming();
    const r = await awaitTenantModulesReady(deps, TENANT, timing);

    expect(r.verified.sort()).toEqual([...ALL].sort());
    expect(r.unverified).toEqual([]);
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
  it("a key that is NEVER written fails LOUDLY at the deadline, with attempts and elapsed", async () => {
    // The exact misconfiguration the retry could hide. It must reach the deadline and then SHOUT.
    const { deps } = fleet((m) => ({ status: 200, text: readyBody(m, false) }));
    const { timing } = fakeTiming();
    await expect(awaitTenantModulesReady(deps, TENANT, timing)).rejects.toThrow(
      /never became visible.*gave up after \d+ attempts, \d+ms/s,
    );
  });

  it("the deadline failure names the modules that never came up", async () => {
    const stuck = ALL[1];
    const { deps } = fleet((m) => ({ status: 200, text: readyBody(m, m !== stuck) }));
    const { timing } = fakeTiming();
    await expect(awaitTenantModulesReady(deps, TENANT, timing)).rejects.toThrow(new RegExp(stuck));
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
    await expect(awaitTenantModulesReady(deps, TENANT, timing)).rejects.toThrow();
    const slept = sleeps.reduce((a, b) => a + b, 0);
    expect(slept).toBeLessThan(MODULE_READY_PROBE_DEADLINE_MS);
  });

  it("a module that answers ready only AFTER the deadline still fails (no late pass)", async () => {
    const { deps } = fleet((m, attempt) => ({ status: 200, text: readyBody(m, attempt > 50) }));
    const { timing } = fakeTiming();
    await expect(awaitTenantModulesReady(deps, TENANT, timing)).rejects.toThrow(/never became visible/);
  });
});

describe("awaitTenantModulesReady: a module image that predates /ready (404)", () => {
  it("does not hang and does not retry: it reports UNVERIFIED, honestly and by name", async () => {
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
      { module: old, reason: "no_ready_route", detail: expect.stringContaining("predates cf#114") },
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
