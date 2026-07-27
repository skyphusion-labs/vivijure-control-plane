// The owner-facing handoff page helpers (cp#169). Pure logic, no DOM.
//
// The page hands a customer a sentence at the moment their studio is broken, so the assertions here
// are about the READER: that a dead link never reads as a rejected key (which would send them to
// re-make a credential that was fine), that an unseen error code still renders a sentence rather
// than an empty box, and that the endpoint list is never quietly short -- the verification requires
// ALL four, so dropping one from the display understates what they must tick.

import { describe, expect, it } from "vitest";
import {
  LINK_ERRORS,
  TOKEN_PARAM,
  endpointRows,
  expiryNote,
  linkErrorCopy,
  tokenFromSearch,
} from "../public/handoff-checks.js";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");

describe("reading the token off the URL", () => {
  it("finds it", () => {
    expect(tokenFromSearch(`?${TOKEN_PARAM}=abc123`)).toBe("abc123");
    expect(tokenFromSearch(`?other=1&${TOKEN_PARAM}=abc123&x=2`)).toBe("abc123");
  });

  it("returns an EMPTY STRING for absent, never the string 'null'", () => {
    // A caller that sent "null" to the plane would get an unknown-token refusal that reads like a
    // corrupted link rather than a missing one.
    expect(tokenFromSearch("")).toBe("");
    expect(tokenFromSearch("?nope=1")).toBe("");
    expect(tokenFromSearch(null)).toBe("");
    expect(tokenFromSearch(undefined)).toBe("");
  });

  it("trims, because a link pasted out of a chat client arrives with whitespace", () => {
    expect(tokenFromSearch(`?${TOKEN_PARAM}=%20abc%20`)).toBe("abc");
  });
});

describe("what a dead link says", () => {
  it("has a sentence for every refusal the plane can make about a LINK", () => {
    // CONTROL: the map is not empty, so the per-code assertions below mean something.
    expect(Object.keys(LINK_ERRORS).length).toBeGreaterThan(4);
    for (const code of [
      "handoff_unknown",
      "handoff_expired",
      "handoff_consumed",
      "handoff_tenant_missing",
      "handoff_endpoints_changed",
    ]) {
      expect(linkErrorCopy(code, null)).toBe(LINK_ERRORS[code]);
      expect(linkErrorCopy(code, null).length).toBeGreaterThan(20);
    }
  });

  it("tells an EXPIRED reader what to do, since they cannot fix it themselves", () => {
    expect(linkErrorCopy("handoff_expired", null)).toMatch(/ask/i);
  });

  it("tells a CONSUMED reader their key WAS installed, so they do not re-make one", () => {
    expect(linkErrorCopy("handoff_consumed", null)).toMatch(/installed/i);
  });

  it("falls back to the server's own message for a code it has never seen", () => {
    expect(linkErrorCopy("something_new", "the plane said this")).toBe("the plane said this");
  });

  it("still renders a sentence with neither a known code nor a message", () => {
    // An empty error box is the one outcome this must never produce.
    expect(linkErrorCopy(null, null).length).toBeGreaterThan(20);
    expect(linkErrorCopy(null, "   ").length).toBeGreaterThan(20);
  });
});

describe("the endpoint list", () => {
  it("normalises what the plane sends", () => {
    expect(
      endpointRows({
        endpoints: [{ id: "ep1", name: "vivijure-hero-backend", label: "Render" }],
      }),
    ).toEqual([{ id: "ep1", name: "vivijure-hero-backend", label: "Render" }]);
  });

  it("keeps a row that has an id but no name: the id is what the console shows", () => {
    // Dropping it would understate how many endpoints must be ticked, and the verification requires
    // every one of them, so the customer would fail with a key they believed was complete.
    expect(endpointRows({ endpoints: ["ep1", { id: "ep2" }] })).toEqual([
      { id: "ep1", name: null, label: null },
      { id: "ep2", name: null, label: null },
    ]);
  });

  it("drops only what has no id at all, and never throws on a shape it did not expect", () => {
    expect(endpointRows({ endpoints: [null, 7, { name: "no id" }, { id: "ep3" }] as unknown[] })).toEqual([
      { id: "ep3", name: null, label: null },
    ]);
    expect(endpointRows(null)).toEqual([]);
    expect(endpointRows({})).toEqual([]);
    expect(endpointRows({ endpoints: "not a list" })).toEqual([]);
  });
});

describe("how long the link is good for", () => {
  it("is coarse on purpose: days, then hours, then under an hour", () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(expiryNote(at(70 * 3600000), NOW)).toMatch(/about 3 days/);
    expect(expiryNote(at(5 * 3600000), NOW)).toMatch(/about 5 hours/);
    expect(expiryNote(at(1 * 3600000), NOW)).toMatch(/about 1 hour\./);
    expect(expiryNote(at(20 * 60000), NOW)).toMatch(/under an hour/);
  });

  it("says so when it has already expired", () => {
    expect(expiryNote(new Date(NOW - 1000).toISOString(), NOW)).toMatch(/expired/i);
  });

  it("says NOTHING rather than something wrong when the date is unreadable", () => {
    expect(expiryNote("not a date", NOW)).toBe("");
    expect(expiryNote(null, NOW)).toBe("");
  });
});
