// The pre-install studio-token liveness gate (#108).
//
// WHAT THIS PROVES: that a freshly-uploaded STUDIO_API_TOKEN which is not yet being served is WAITED
// for, and that a genuinely wrong token is NOT. The second half is the one that matters: a retry
// loop around an auth check is exactly the shape that quietly turns a real credential failure into a
// long pause and then a confusing error, so the negative case is tested as hard as the positive one.
//
// The fake studio models the ONE behaviour the defect turned on: for N calls it serves a PREVIOUS
// version that does not hold the new token (403), then it starts serving the new one (200).

import { describe, it, expect, vi } from "vitest";
import {
  awaitStudioTokenLive,
  installTenantModules,
  TENANT_MODULE_CATALOG,
  TenantModuleError,
  STUDIO_TOKEN_PROBE_DEADLINE_MS,
  type ProbeTiming,
  type TenantModuleDeps,
} from "../src/tenant-modules";

const GOOD = "the-freshly-uploaded-token";

/** A clock that only moves when the code sleeps, so a 60s window costs no real time. */
function fakeTiming(): ProbeTiming & { elapsed(): number } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    elapsed: () => t,
  };
}

/**
 * staleFor: how many probe calls are answered by the OLD version (403) before the new one serves.
 * servedToken: what the studio ultimately accepts. A presented token that never matches gets 403
 * forever, which is the genuinely-bad-credential case.
 */
function fakeDeps(opts: { staleFor?: number; servedToken?: string; installStatus?: number } = {}) {
  const staleFor = opts.staleFor ?? 0;
  const servedToken = opts.servedToken ?? GOOD;
  const installStatus = opts.installStatus ?? 201;
  let calls = 0;
  const logs: { event: string; fields: Record<string, unknown> }[] = [];

  // The stale version rejects EVERYTHING, not just the probe: that is what an old serving version
  // actually does. So removing the probe makes a real install 403, which is the live failure.
  const callTenantStudio = vi.fn(
    async (_script: string, init: { method: string; path: string; studioApiToken: string }) => {
      calls += 1;
      if (calls <= staleFor) return { status: 403, text: '{"error":"bad API token"}' };
      if (init.studioApiToken !== servedToken) return { status: 403, text: '{"error":"bad API token"}' };
      if (init.path === "/api/modules/installed") return { status: 200, text: JSON.stringify({ modules: [] }) };
      return { status: installStatus, text: installStatus === 201 ? "{}" : '{"error":"nope"}' };
    },
  );

  const deps = {
    callTenantStudio,
    log: (event: string, fields: Record<string, unknown>) => void logs.push({ event, fields }),
  } as unknown as TenantModuleDeps;

  return { deps, callTenantStudio, logs, calls: () => calls };
}

describe("awaitStudioTokenLive", () => {
  it("CONTROL: the fake really does 403 a stale version (else every wait test is vacuous)", async () => {
    const { deps } = fakeDeps({ staleFor: 1 });
    const first = await deps.callTenantStudio("studio", {
      method: "GET",
      path: "/api/modules/installed",
      studioApiToken: GOOD,
    });
    expect(first.status).toBe(403);
  });

  it("returns immediately when the studio already serves the token", async () => {
    const { deps, callTenantStudio } = fakeDeps();
    const t = fakeTiming();

    const res = await awaitStudioTokenLive(deps, "studio", GOOD, t);

    expect(res.attempts).toBe(1);
    expect(t.elapsed()).toBe(0);
    expect(callTenantStudio).toHaveBeenCalledTimes(1);
  });

  it("THE #108 GATE: waits out a stale serving version and then succeeds", async () => {
    // Exactly the live failure: the adopted script serves the previous version for a while.
    const { deps } = fakeDeps({ staleFor: 3 });
    const t = fakeTiming();

    const res = await awaitStudioTokenLive(deps, "studio", GOOD, t);

    expect(res.attempts).toBe(4);
    expect(t.elapsed()).toBeGreaterThan(0);
  });

  it("NEGATIVE: a genuinely wrong token exhausts the window and fails loudly, never silently passes", async () => {
    // The retry must not be able to launder a real auth failure into success.
    const { deps } = fakeDeps({ servedToken: "some-other-token" });
    const t = fakeTiming();

    await expect(awaitStudioTokenLive(deps, "studio", "WRONG", t)).rejects.toThrow(
      /studio never served the uploaded STUDIO_API_TOKEN/,
    );
  });

  it("NEGATIVE: the give-up error carries attempts and elapsed, so the failure is diagnosable", async () => {
    const { deps } = fakeDeps({ servedToken: "some-other-token" });
    const t = fakeTiming();

    const err = await awaitStudioTokenLive(deps, "studio", "WRONG", t).catch((e) => e as Error);

    expect(err).toBeInstanceOf(TenantModuleError);
    expect((err as Error).message).toMatch(/gave up after \d+ attempts/);
    expect((err as Error).message).toMatch(/\d+ms/);
  });

  it("NEGATIVE: bounded -- it gives up within the deadline instead of retrying forever", async () => {
    const { deps } = fakeDeps({ servedToken: "some-other-token" });
    const t = fakeTiming();

    await awaitStudioTokenLive(deps, "studio", "WRONG", t).catch(() => undefined);

    expect(t.elapsed()).toBeLessThanOrEqual(STUDIO_TOKEN_PROBE_DEADLINE_MS);
  });

  it("does NOT retry a non-403: a real error fails at once rather than burning the window", async () => {
    const deps = {
      callTenantStudio: vi.fn(async () => ({ status: 500, text: "boom" })),
      log: () => undefined,
    } as unknown as TenantModuleDeps;
    const t = fakeTiming();

    await expect(awaitStudioTokenLive(deps, "studio", GOOD, t)).rejects.toThrow(/not retryable/);
    expect(t.elapsed()).toBe(0);
  });
});

describe("installTenantModules", () => {
  it("probes BEFORE the first install, so a stale version cannot fail the run", async () => {
    const { deps, callTenantStudio } = fakeDeps({ staleFor: 2 });
    const t = fakeTiming();

    const installed = await installTenantModules(deps, "ten_abc", "studio", GOOD, t);

    // Without the probe the first install would have hit the stale version and taken a 403, which
    // is exactly the live cf#108 failure. Succeeding here IS the fix working.
    expect(installed).toEqual(TENANT_MODULE_CATALOG.map((s) => s.module));
    expect(callTenantStudio.mock.calls[0][1].path).toBe("/api/modules/installed");
  });

  it("keeps per-module installs SINGLE-attempt: a failing install still fails the step", async () => {
    // The probe must not have turned the install loop into a retry loop.
    const { deps, callTenantStudio } = fakeDeps({ installStatus: 500 });
    const t = fakeTiming();

    await expect(installTenantModules(deps, "ten_abc", "studio", GOOD, t)).rejects.toThrow(/install keyframe/);
    const installCalls = callTenantStudio.mock.calls.filter(([, i]) => i.path === "/api/modules/install");
    expect(installCalls).toHaveLength(1);
  });
});
