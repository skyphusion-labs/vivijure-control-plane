// THE COUPLING GUARD: every module capability must have a transport (cp#396).
//
// WHY THIS FILE EXISTS, and it is not hypothetical. The first attempt at the transport split
// trimmed PROVISION_PLAN and shipped typecheck-clean with a full green suite, while KILLING EVERY
// PROVISION -- shared and dedicated alike -- at modules_upload. TENANT_MODULE_CATALOG still claimed
// finish-upscale needed an `upscale` ENDPOINT, uploadTenantModules throws unconditionally when a
// declared endpointKey has no endpoint, and nothing connected the two lists.
//
// NOTHING IN THE SUITE COULD SEE IT. The provisioner fixtures are hand-written four-entry endpoint
// literals rather than values derived from the plan, so they passed by asserting a shape the code
// could no longer produce. That is the same defect class as requiredPoolKeys() deriving from the
// plan, inverted: A FIXTURE THAT HARDCODES WHAT IT SHOULD DERIVE CANNOT FAIL WHEN THE SOURCE OF
// TRUTH MOVES.
//
// So this guard reads BOTH real lists and asks the one question neither list can answer alone.

import { describe, it, expect } from "vitest";
import { TENANT_MODULE_CATALOG } from "../src/tenant-modules";
import { PROVISION_PLAN, endpointBackedPlan, vpcBackedPlan } from "../src/runpod";

const planKeys = (): Set<string> => new Set(PROVISION_PLAN.map((c) => c.key));

describe("every catalog endpointKey has a transport in the plan (cp#396)", () => {
  it("THE GUARD: no module declares an endpointKey the plan does not carry", () => {
    // Names the offenders rather than asserting a count, so the failure says which module to fix.
    const known = planKeys();
    const orphans = TENANT_MODULE_CATALOG.filter((s) => s.endpointKey && !known.has(s.endpointKey));
    expect(orphans.map((s) => s.module)).toEqual([]);
  });

  it("CONTROL: the guard can FAIL -- a catalog naming an unknown key is caught", () => {
    // Without this, the assertion above would also pass if the filter were broken, which is the
    // exact vacuous shape that let the real defect through. Same computation, seeded offender.
    const known = planKeys();
    const seeded = [...TENANT_MODULE_CATALOG, { module: "not-a-real-module", endpointKey: "nonesuch" }];
    const orphans = seeded.filter((s) => s.endpointKey && !known.has(s.endpointKey));
    expect(orphans.map((s) => s.module)).toContain("not-a-real-module");
  });

  it("CONTROL: the populations are DISJOINT and both non-empty, so neither filter is trivially all", () => {
    // A guard comparing against the FULL plan says nothing if the split is degenerate. If either
    // half were empty, or they overlapped, the transport distinction would not exist and every
    // assertion built on it would be vacuously true.
    const backed = endpointBackedPlan().map((c) => c.key);
    const vpc = vpcBackedPlan().map((c) => c.key);
    expect(backed.length).toBeGreaterThan(0);
    expect(vpc.length).toBeGreaterThan(0);
    expect(backed.filter((k) => vpc.includes(k))).toEqual([]);
    expect([...backed, ...vpc].sort()).toEqual([...planKeys()].sort());
  });

  it("EXACTLY ONE TRANSPORT per plan capability, never both and never neither", () => {
    // The union makes this true by construction today. Asserted anyway, because the property the
    // rest of the system leans on is the EXCLUSIVITY, and a future edit adding an optional
    // endpointVar to a vpc entry would break it silently everywhere else.
    for (const capability of PROVISION_PLAN) {
      const asAny = capability as unknown as Record<string, unknown>;
      if (capability.backing === "runpod") {
        expect(typeof asAny.endpointVar, capability.key).toBe("string");
        expect(asAny.doors, capability.key).toBeUndefined();
        expect(asAny.doors, capability.key).toBeUndefined();
      } else {
        // A vpc capability carries a non-empty door POOL and no endpoint fields at all.
        expect(Array.isArray(asAny.doors), capability.key).toBe(true);
        expect(capability.doors.length, capability.key).toBeGreaterThan(0);
        for (const d of capability.doors) {
          expect(typeof d.bindingName, capability.key).toBe("string");
          expect(typeof d.doorTokenBinding, capability.key).toBe("string");
          expect(typeof d.serviceIdVar, capability.key).toBe("string");
          expect(typeof d.doorTokenVar, capability.key).toBe("string");
        }
        // The two fields whose ABSENCE is the safety property: no quota to spend, no id to bind.
        expect(asAny.endpointVar, capability.key).toBeUndefined();
        expect(asAny.maxWorkers, capability.key).toBeUndefined();
      }
    }
  });

  it("the vpc binding names are the ones vivijure-cf ACTUALLY declares (cf#480)", () => {
    // Pinned as literals ON PURPOSE. These names live in another repo, so nothing in this one can
    // catch a typo -- and a wrong binding name is SILENT: it uploads clean and the module simply
    // never sees a door. Sourced from modules/finish-upscale and modules/speech-upscale Env
    // declarations at v1.28.0, the pinned STUDIO_RELEASE, where BOTH build a doorPool of two.
    const byKey = Object.fromEntries(vpcBackedPlan().map((c) => [c.key, c]));
    expect(byKey.upscale.doors.map((d) => d.bindingName)).toEqual([
      "FINISH_UPSCALE_VPC",
      "FINISH_UPSCALE_VPC_PROPAGANDHI",
    ]);
    expect(byKey.upscale.doors.map((d) => d.doorTokenBinding)).toEqual([
      "FINISH_DOOR_TOKEN",
      "FINISH_DOOR_TOKEN_PROPAGANDHI",
    ]);
    expect(byKey["audio-upscale"].doors.map((d) => d.bindingName)).toEqual([
      "SPEECH_UPSCALE_VPC",
      "SPEECH_UPSCALE_VPC_PROPAGANDHI",
    ]);
    expect(byKey["audio-upscale"].doors.map((d) => d.doorTokenBinding)).toEqual([
      "SPEECH_DOOR_TOKEN",
      "SPEECH_DOOR_TOKEN_PROPAGANDHI",
    ]);
  });

  it("ORDER IS LOAD-BEARING: the LEGACY door is first and keeps the bare binding name", () => {
    // vivijure-cf gives the first candidate the bare DOOR_ROUTE_NAME, and resolveDoor is a LOOKUP
    // by that name rather than a pick -- polling any door but the one that MINTED a job reports a
    // live job as GONE. So reordering this array silently breaks in-flight polls, which is exactly
    // the kind of change that looks like tidying.
    for (const c of vpcBackedPlan()) {
      expect(c.doors.length, c.key).toBeGreaterThan(0);
      const legacy = c.doors[0];
      // The legacy names carry no box suffix; every later door does.
      expect(legacy.bindingName, c.key).not.toMatch(/_PROPAGANDHI$/);
      for (const other of c.doors.slice(1)) {
        expect(other.bindingName, c.key).toMatch(/_PROPAGANDHI$/);
      }
    }
  });
});
