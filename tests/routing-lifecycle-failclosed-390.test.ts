import { describe, expect, it } from "vitest";
import { tenantRefusal } from "../src/routing.js";

// cp#390: `null` from tenantRefusal MEANS DISPATCH, so an unmodelled lifecycle must never
// produce null. The control runs FIRST: without it, a refusal for every input is equally
// consistent with a function that refuses unconditionally.
const base = {
  id: "ten_test", slug: "t", deleted_at: null, suspended_at: null,
} as unknown as Parameters<typeof tenantRefusal>[0];

describe("tenantRefusal fails CLOSED on an unmodelled lifecycle (cp#390)", () => {
  it("CONTROL: a live tenant still dispatches (null), so refusal is not unconditional", () => {
    expect(tenantRefusal({ ...base, status: "live" } as never)).toBeNull();
  });

  it("an unmodelled status REFUSES rather than dispatching", () => {
    const r = tenantRefusal({ ...base, status: "archived" } as never);
    expect(r).not.toBeNull();
    expect(r!.status).toBe(404);
  });

  it("a garbage status REFUSES", () => {
    const r = tenantRefusal({ ...base, status: "" } as never);
    expect(r).not.toBeNull();
    expect(r!.status).toBe(404);
  });

  it("CONTROL: a modelled non-live status still refuses with its own code", async () => {
    const r = tenantRefusal({ ...base, status: "provisioning" } as never);
    expect(r!.status).toBe(503);
  });
});
