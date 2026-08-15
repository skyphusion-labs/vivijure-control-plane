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

// cp#392 FOLLOW-UP, and the reason this section exists at all. The type gate above bought honest
// ABSENCE by dropping EVERY non-string, so a status that is PRESENT and holds 7 rendered exactly
// like a column that is not there: the event could no longer tell "no status column" from
// "status held 7". That is the same defect inverted, reassuring in the other direction. The gate
// is now PRESENCE, and the value keeps its JSON TYPE so 7 and "7" stay different.
//
// The merged change shipped with three tests and NOT ONE non-string case, which is precisely why
// it shipped. A fixture set drawn from the same assumption as the code cannot test that
// assumption.
function loggedFor(status: unknown, present = true): Record<string, unknown> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const fixture = { ...base } as Record<string, unknown>;
  if (present) fixture.status = status;
  else delete fixture.status;
  const r = tenantRefusal(fixture as never);
  expect(r).not.toBeNull();
  expect(r!.status).toBe(404);
  expect(spy).toHaveBeenCalledTimes(1);
  const parsed = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
  spy.mockRestore();
  return parsed;
}

describe("a PRESENT but non-string status still renders (cp#392 follow-up)", () => {
  it("the number 7 renders as the NUMBER 7: not a missing key, and not the string 7", () => {
    const parsed = loggedFor(7);
    expect("status" in parsed).toBe(true);
    expect(parsed.status).toBe(7);
    expect(parsed.status).not.toBe("7");
  });

  it("null renders as null, a present column holding nothing", () => {
    const parsed = loggedFor(null);
    expect("status" in parsed).toBe(true);
    expect(parsed.status).toBeNull();
  });

  it("a boolean renders as a boolean", () => {
    const parsed = loggedFor(true);
    expect("status" in parsed).toBe(true);
    expect(parsed.status).toBe(true);
  });

  it("an object renders as a bracketed type tag, not as [object Object]", () => {
    const parsed = loggedFor({ a: 1 });
    expect(parsed.status).toBe("[unloggable object]");
  });

  it("a key PRESENT and holding undefined is distinguishable from an absent key", () => {
    const parsed = loggedFor(undefined);
    expect("status" in parsed).toBe(true);
    expect(parsed.status).toBe("[unloggable undefined]");
  });

  it("NaN names itself rather than collapsing to null through JSON.stringify", () => {
    const parsed = loggedFor(Number.NaN);
    expect(parsed.status).toBe("[unloggable number NaN]");
  });

  // THE REFUSAL PATH MUST NOT THROW. JSON.stringify throws on a BigInt, so passing the raw value
  // through would turn a deliberate 404 into an unhandled error at the exact moment the system is
  // trying to report a problem. If this ever regresses, loggedFor() throws and this test reddens.
  it("a BigInt does not throw on the refusal path, it renders as a type tag", () => {
    const parsed = loggedFor(BigInt(7));
    expect(parsed.status).toBe("[unloggable bigint]");
  });

  // THE WHOLE POINT, as one assertion: the two states the gate must never merge.
  it("status 7 and no status column render as DIFFERENT payloads", () => {
    const withSeven = loggedFor(7);
    const withNone = loggedFor(undefined, false);
    expect("status" in withSeven).toBe(true);
    expect("status" in withNone).toBe(false);
    expect(JSON.stringify(withSeven)).not.toBe(JSON.stringify(withNone));
  });
});
