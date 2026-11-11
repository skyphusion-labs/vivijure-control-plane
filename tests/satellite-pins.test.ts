import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GHCR_ORG, SATELLITE_PINS, imageRef, type SatelliteKey } from "../src/satellite-pins";
import { PROVISION_PLAN } from "../src/runpod";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNPOD_TS = readFileSync(join(HERE, "..", "src", "runpod.ts"), "utf8");
const keys = Object.keys(SATELLITE_PINS) as SatelliteKey[];

describe("satellite pins (cp#126)", () => {
  it("pins every endpoint the provisioning plan builds, and nothing else", () => {
    // 1:1 both ways: a plan entry with no pin cannot be provisioned, and an orphan pin is a pin
    // nobody verifies on a release.
    expect(new Set(PROVISION_PLAN.map((e) => e.key))).toEqual(new Set(keys));
  });

  it("gives the plan its image half from the pins, never from a literal", () => {
    for (const e of PROVISION_PLAN) {
      expect(e.imageRepo, e.key).toBe(SATELLITE_PINS[e.key].repo);
      expect(e.tag, e.key).toBe(SATELLITE_PINS[e.key].tag);
    }
  });

  it("keeps src/runpod.ts free of image literals", () => {
    // The guard that outlives us: the drift happened because a version literal sat in the
    // provisioning file where nobody looked. If a literal comes back, this fails.
    const plan = RUNPOD_TS.slice(RUNPOD_TS.indexOf("export const PROVISION_PLAN"));
    expect(plan).not.toMatch(/tag:\s*"/);
    expect(plan).not.toMatch(/imageRepo:\s*"/);
    expect(RUNPOD_TS).not.toContain("ghcr.io");
    // cp#396: the live gate that provisioned real endpoints is gone with the dedicated path, so    // there is no second file to check. The plan literal check above is now the whole guard, which    // is correct: PROVISION_PLAN is the only place an image reference could reach a tenant.
  });

  it("pins bare release tags only", () => {
    for (const key of keys) {
      const { tag } = SATELLITE_PINS[key];
      expect(tag, key).not.toBe("latest");
      // A git sha pin makes an endpoint untraceable to a release (the RunPod pin rule).
      expect(tag, key).not.toMatch(/^[0-9a-f]{7,40}$/);
      expect(tag, key).toMatch(/^(train-)?\d+\.\d+\.\d+$/);
      // The python provisioner's frozen footgun default, which must never reach a tenant.
      expect(tag, key).not.toBe("0.4.4");
    }
  });

  it("pins a digest beside every tag, so a tenant template is immutable (cp#601)", () => {
    for (const key of keys) {
      expect(SATELLITE_PINS[key].digest, key).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    // Distinct images carry distinct digests; a copy-pasted digest is a pin that verifies nothing.
    const ds = keys.map((k) => SATELLITE_PINS[k].digest);
    expect(new Set(ds).size).toBe(ds.length);
  });

  it("feeds the production tell of the provisioning e2e, so it cannot go stale again (cp#601)", () => {
    // The e2e refuses to provision when its RunPod key can see a production endpoint. A literal id
    // there went stale with the endpoint and turned the guard into a pass for any key.
    const e2e = readFileSync(join(HERE, "provision-e2e.live.test.ts"), "utf8");
    expect(e2e).toContain("Object.values(SATELLITE_PINS).map((p) => p.mirrors.endpointId)");
    expect(e2e).toContain("PROD_TELLS.includes(e.id)");
    expect(e2e).not.toMatch(/PROD_TELL\s*=\s*"/);
  });

  it("carries live provenance for every pin", () => {
    for (const key of keys) {
      const { mirrors } = SATELLITE_PINS[key];
      // The pin's authority is a production endpoint that was actually read, on a date.
      expect(mirrors.endpointId, key).toMatch(/^[a-z0-9]{10,}$/);
      expect(mirrors.readAt, key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // Distinct endpoints: two pins mirroring one endpoint would mean one of them is unverified.
    const ids = keys.map((k) => SATELLITE_PINS[k].mirrors.endpointId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("builds the image reference the templates are created with", () => {
    // tag@digest, the exact form production templates carry (cp#601), and what check:pins:prod
    // compares by string.
    expect(imageRef("backend")).toBe(
      `ghcr.io/${GHCR_ORG}/${SATELLITE_PINS.backend.repo}:${SATELLITE_PINS.backend.tag}@${SATELLITE_PINS.backend.digest}`,
    );
    expect(imageRef("backend")).toBe(
      "ghcr.io/skyphusion-labs/vivijure-backend:1.1.18@sha256:3ec3849279aa18e6c58ba0716bd768366162a70d8a6d61e9bdde2254ee4e049a",
    );
  });
});
