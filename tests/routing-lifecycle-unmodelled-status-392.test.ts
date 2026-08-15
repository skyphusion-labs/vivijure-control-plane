import { afterEach, describe, expect, it, vi } from "vitest";
import { tenantRefusal } from "../src/routing.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// cp#392: an ABSENT status must render as an absent key, never as the string "undefined".
// String(undefined) yields "undefined", a normal-looking JSON value indistinguishable from a
// status column that genuinely holds those six characters. The event exists to be the only
// signal on this path, so it must not lie about presence. Companion to cp#390
// (routing-lifecycle-failclosed-390.test.ts), which proves the refusal direction; this file
// proves the LOGGED PAYLOAD is honest about absence, on both the status key and the tenant key.
const base = {
  id: "ten_test", slug: "t", deleted_at: null, suspended_at: null,
} as unknown as Parameters<typeof tenantRefusal>[0];

describe("routing.lifecycle_unmodelled logs absence honestly (cp#392)", () => {
  it("a fixture with no status key omits the status key entirely, not the string undefined", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = { ...base } as Record<string, unknown>;
    delete fixture.status;
    const r = tenantRefusal(fixture as never);
    expect(r).not.toBeNull();
    expect(r!.status).toBe(404);
    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect("status" in parsed).toBe(false);
    spy.mockRestore();
  });

  it("a present unmodelled status is logged verbatim, unchanged", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = tenantRefusal({ ...base, status: "archived" } as never);
    expect(r).not.toBeNull();
    expect(r!.status).toBe(404);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.status).toBe("archived");
    spy.mockRestore();
  });

  it("a fixture with no id key also omits the tenant key, unchanged JSON.stringify behaviour", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = { ...base, status: "archived" } as Record<string, unknown>;
    delete fixture.id;
    const r = tenantRefusal(fixture as never);
    expect(r).not.toBeNull();
    expect(r!.status).toBe(404);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect("tenant" in parsed).toBe(false);
    spy.mockRestore();
  });
});
