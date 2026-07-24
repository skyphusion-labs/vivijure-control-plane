// Slug rules (#52). A slug is both a DNS label and a WfP script name, so it is validated once.

import { describe, it, expect } from "vitest";
import { tenantEndpointIds, tenantView, validateSlug } from "../src/tenants";
import type { Tenant } from "../src/store";

const tenant = (over: Partial<Tenant> = {}): Tenant => ({
  id: "ten_abc",
  slug: "hero",
  account_id: "acct_1",
  status: "live",
  script_name: null,
  d1_database_id: null,
  r2_bucket_name: null,
  endpoints_json: null,
  r2_token_id: null,
  studio_release: null,
  modules_release: null,
  studio_token_enc: null,
  created_at: "t",
  live_at: null,
  suspended_at: null,
  suspended_reason: null,
  deleted_at: null,
  reclaim_lease_until: null,
  reclaim_lease_token: null,
  teardown_at: null,
  teardown_failures: null,
  ...over,
});

describe("validateSlug", () => {
  it("accepts normal slugs", () => {
    for (const s of ["abc", "my-studio", "a1b2c3", "x".repeat(32)]) {
      expect(validateSlug(s).ok, s).toBe(true);
    }
  });

  it("REFUSES shapes that are not a legal DNS label or script name", () => {
    const bad: [string, string][] = [
      ["ab", "too_short"],
      ["x".repeat(33), "too_long"],
      ["-lead", "bad_shape"],
      ["trail-", "bad_shape"],
      ["Upper", "bad_shape"],
      ["under_score", "bad_shape"],
      ["dot.ted", "bad_shape"],
      ["spa ce", "bad_shape"],
    ];
    for (const [slug, reason] of bad) {
      const r = validateSlug(slug);
      expect(r.ok, slug).toBe(false);
      if (!r.ok) expect(r.reason, slug).toBe(reason);
    }
  });

  it("REFUSES reserved labels that would impersonate a platform surface", () => {
    for (const s of ["www", "api", "admin", "demo", "studio", "mcp", "auth", "billing", "vivijure"]) {
      const r = validateSlug(s);
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.reason).toBe("reserved");
    }
  });
});

describe("tenantView", () => {
  it("exposes a URL only once the studio is live", () => {
    expect(tenantView(tenant({ status: "live" }), ".studio.vivijure.com").url).toBe(
      "https://hero.studio.vivijure.com",
    );
    for (const status of ["pending", "provisioning", "awaiting_invoke_key", "failed"] as const) {
      expect(tenantView(tenant({ status }), ".studio.vivijure.com").url, status).toBeNull();
    }
  });

  it("projects suspension over the lifecycle and pulls the URL", () => {
    const view = tenantView(tenant({ status: "live", suspended_at: "now", suspended_reason: "abuse" }), ".studio.vivijure.com");
    expect(view).toMatchObject({ status: "suspended", url: null, suspended_reason: "abuse" });
  });

  // cp#43: modules_release was written, load-bearing, and projected by NOTHING, so the only way to
  // read it was prod D1 with a separately minted credential. These two assertions are the pair that
  // keeps that from recurring: one names the field, one pins the whole key set so the next field
  // added to Tenant cannot slip past the projection unnoticed in either direction.
  it("projects the release PAIR, because withholding one half is what made NULL unreadable", () => {
    const view = tenantView(tenant({ studio_release: "v1.3.0", modules_release: "v1.1.0" }), ".studio.vivijure.com");
    expect(view.studio_release).toBe("v1.3.0");
    expect(view.modules_release).toBe("v1.1.0");
  });

  it("reports modules_release even when it is NULL: that value IS the answer, not a missing one", () => {
    // NULL means "consult the job row" (0006_module_upgrade.sql), which a caller can only act on if
    // it can tell NULL from a field that was never sent.
    const view = tenantView(tenant({ modules_release: null }), ".studio.vivijure.com");
    expect("modules_release" in view).toBe(true);
    expect(view.modules_release).toBeNull();
  });

  it("projects EXACTLY the agreed key set, in both directions", () => {
    expect(Object.keys(tenantView(tenant({}), ".studio.vivijure.com")).sort()).toEqual([
      "created_at", "id", "live_at", "modules_release", "slug", "status", "studio_release",
      "suspended_reason", "url",
    ]);
  });

  it("keeps modules_release readable on a SUSPENDED tenant (a release is a fact, not a link)", () => {
    // url is withheld under suspension because a dead link is a lie. A release is not a link: it is
    // what is installed, and it is most needed exactly when something is wrong.
    const view = tenantView(
      tenant({ status: "live", suspended_at: "now", suspended_reason: "abuse", modules_release: "v1.1.0" }),
      ".studio.vivijure.com",
    );
    expect(view.url).toBeNull();
    expect(view.modules_release).toBe("v1.1.0");
  });

  it("does not leak internal provisioning ids to the front door", () => {
    const view = tenantView(
      tenant({ d1_database_id: "db-secret", r2_bucket_name: "bucket-secret", script_name: "script" }),
      ".studio.vivijure.com",
    );
    expect(JSON.stringify(view)).not.toContain("secret");
    expect(JSON.stringify(view)).not.toContain("script");
  });
});

describe("tenantEndpointIds", () => {
  it("reads the provisioner's endpoint list (the CreatedEndpoint[] shape it actually stores)", () => {
    const stored = JSON.stringify([
      { key: "backend", label: "Render", id: "ep_backend", name: "vivijure-hero-backend" },
      { key: "upscale", label: "Video upscale", id: "ep_upscale", name: "vivijure-hero-upscale" },
    ]);
    expect(tenantEndpointIds(tenant({ endpoints_json: stored }))).toEqual(["ep_backend", "ep_upscale"]);
  });
  it("tolerates a bare string-id array too", () => {
    expect(tenantEndpointIds(tenant({ endpoints_json: '["a","b"]' }))).toEqual(["a", "b"]);
  });
  it("treats absent or malformed json as no endpoints, never as a crash", () => {
    expect(tenantEndpointIds(tenant({ endpoints_json: null }))).toEqual([]);
    expect(tenantEndpointIds(tenant({ endpoints_json: "{not json" }))).toEqual([]);
    expect(tenantEndpointIds(tenant({ endpoints_json: '"a string"' }))).toEqual([]);
    expect(tenantEndpointIds(tenant({ endpoints_json: '[1,2]' }))).toEqual([]);
  });
});
