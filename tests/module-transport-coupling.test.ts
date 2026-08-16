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
        expect(asAny.doorsUrlVar, capability.key).toBeUndefined();
        expect(asAny.tokens, capability.key).toBeUndefined();
      } else {
        expect(capability.backing, capability.key).toBe("door");
        expect(typeof asAny.doorsUrlVar, capability.key).toBe("string");
        expect(String(asAny.doorsUrlVar), capability.key).toMatch(/_DOORS$/);
        expect(Array.isArray(asAny.tokens), capability.key).toBe(true);
        expect(capability.tokens.length, capability.key).toBeGreaterThan(0);
        for (const tok of capability.tokens) {
          expect(typeof tok.bindingName, capability.key).toBe("string");
          expect(typeof tok.envVar, capability.key).toBe("string");
          expect(tok.envVar, capability.key).not.toMatch(/VPC_SERVICE_ID/);
        }
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
    expect(byKey.upscale.doorsUrlVar).toBe("FINISH_UPSCALE_DOORS");
    expect(byKey.upscale.tokens.map((tok) => tok.bindingName)).toEqual([
      "FINISH_DOOR_TOKEN",
      "FINISH_DOOR_TOKEN_PROPAGANDHI",
    ]);
    expect(byKey["audio-upscale"].doorsUrlVar).toBe("SPEECH_UPSCALE_DOORS");
    expect(byKey["audio-upscale"].tokens.map((tok) => tok.bindingName)).toEqual([
      "SPEECH_DOOR_TOKEN",
      "SPEECH_DOOR_TOKEN_PROPAGANDHI",
    ]);
  });

  it("ORDER IS LOAD-BEARING: the first token is the legacy bearer, later ones are per-host", () => {
    for (const c of vpcBackedPlan()) {
      expect(c.tokens.length, c.key).toBeGreaterThan(0);
      const legacy = c.tokens[0];
      expect(legacy.bindingName, c.key).not.toMatch(/_PROPAGANDHI$/);
      for (const other of c.tokens.slice(1)) {
        expect(other.bindingName, c.key).toMatch(/_PROPAGANDHI$/);
      }
    }
  });
});
