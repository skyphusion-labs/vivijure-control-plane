// The routing seam's status projection (#52/#55), per the integration ruling.
//
// The ruling: the 7-state lifecycle backed by the table is canonical; routing gets a FAIL-CLOSED
// projection down to its four values. So the tests that matter are the ones proving a tenant is
// NOT routable, and proving suspension beats everything.

import { describe, it, expect } from "vitest";
import { D1TenantResolver, routingStatusFor } from "../src/tenant-resolver";
import type { Tenant, TenantLifecycle } from "../src/store";
import { MemoryStore } from "./memory-store";

const t = (over: Partial<Tenant> = {}): Tenant => ({
  id: "ten_1", slug: "hero", account_id: "acct_1", status: "live",
  script_name: "tenant-hero-studio", d1_database_id: null, r2_bucket_name: null,
  endpoints_json: null, r2_token_id: null, studio_release: null, modules_release: null, studio_token_enc: null,
  created_at: "t", live_at: null, suspended_at: null, suspended_reason: null, deleted_at: null,
  reclaim_lease_until: null, reclaim_lease_token: null,
  ...over,
});

describe("routingStatusFor", () => {
  it("serves ONLY a genuinely live tenant (the positive control)", () => {
    expect(routingStatusFor(t({ status: "live" }))).toBe("live");
  });

  it("reports provisioning so the dispatcher can say 'not yet' rather than 404", () => {
    expect(routingStatusFor(t({ status: "provisioning" }))).toBe("provisioning");
  });

  it("makes every non-routable lifecycle 'unknown' (fail closed)", () => {
    const unroutable: TenantLifecycle[] = ["pending", "awaiting_invoke_key", "failed", "deleting", "deleted"];
    for (const status of unroutable) {
      expect(routingStatusFor(t({ status })), status).toBe("unknown");
    }
  });

  it("keeps awaiting_invoke_key DARK even though its worker exists", () => {
    // The worker is uploaded and would serve, but it cannot render without key B, and key B is
    // pasted on the control-plane front door, not here. Serving a studio that cannot render is not
    // honest, so it stays dark until it is genuinely live.
    expect(routingStatusFor(t({ status: "awaiting_invoke_key", script_name: "tenant-hero-studio" }))).toBe("unknown");
  });

  it("SUSPENSION BEATS EVERYTHING, whatever the lifecycle says", () => {
    const every: TenantLifecycle[] = ["pending", "provisioning", "awaiting_invoke_key", "live", "failed", "deleting", "deleted"];
    for (const status of every) {
      expect(routingStatusFor(t({ status, suspended_at: "now" })), status).toBe("suspended");
    }
  });

  it("a suspended, never-provisioned tenant can NEVER present as routable (the #52 regression)", () => {
    expect(routingStatusFor(t({ status: "pending", suspended_at: "now" }))).toBe("suspended");
  });
});

describe("D1TenantResolver", () => {
  it("resolves a live tenant to its script name", async () => {
    const store = new MemoryStore();
    await store.createAccount("acct_1", "a@b.com");
    await store.createTenant("ten_1", "hero", "acct_1", "live");
    await store.setTenantScript("ten_1", "tenant-hero-studio", "v1.0.0");

    expect(await new D1TenantResolver(store).resolve("hero")).toEqual({
      slug: "hero", status: "live", script_name: "tenant-hero-studio",
    });
  });

  it("returns null for an unknown slug (routing 404s, no existence oracle)", async () => {
    expect(await new D1TenantResolver(new MemoryStore()).resolve("nope")).toBeNull();
  });

  it("projects suspension for the dispatcher's kill-switch check", async () => {
    const store = new MemoryStore();
    await store.createAccount("acct_1", "a@b.com");
    await store.createTenant("ten_1", "hero", "acct_1", "live");
    await store.setTenantScript("ten_1", "tenant-hero-studio", "v1.0.0");
    await store.suspendTenant("ten_1", "abuse");

    expect((await new D1TenantResolver(store).resolve("hero"))?.status).toBe("suspended");
  });
});
