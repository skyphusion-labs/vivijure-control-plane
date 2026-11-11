// public/auth-callback.js: the sign-in link's token travels in the URL fragment, which no request
// carries. The page script moves it into the confirm form and strips it from the address bar.
import { describe, expect, it } from "vitest";
import { tokenFromHash, wire } from "../public/auth-callback.js";

const TOKEN = "a".repeat(64);

describe("tokenFromHash", () => {
  it("reads #token=<value>", () => {
    expect(tokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash(`token=${TOKEN}`)).toBe(TOKEN);
  });
  for (const bad of ["", "#", "#token=", "#other=x", `#token=${"a".repeat(8)}`, `#token=${TOKEN}%22%3E`, 7, null]) {
    it(`gives "" for ${JSON.stringify(bad)}`, () => {
      expect(tokenFromHash(bad)).toBe("");
    });
  }
});

function page() {
  const els: Record<string, { value?: string; disabled?: boolean; hidden?: boolean }> = {
    "magic-link-token": { value: "" },
    "magic-link-continue": { disabled: true },
    "magic-link-missing": { hidden: true },
  };
  const replaced: string[] = [];
  return {
    els,
    replaced,
    doc: { getElementById: (id: string) => els[id] ?? null },
    hist: { replaceState: (_d: unknown, _u: string, url: string) => void replaced.push(url) },
  };
}

describe("wire", () => {
  it("fills the form, enables Continue, and strips the fragment", () => {
    const p = page();
    expect(wire(p.doc, { hash: `#token=${TOKEN}`, pathname: "/auth/email/callback" }, p.hist)).toBe(true);
    expect(p.els["magic-link-token"].value).toBe(TOKEN);
    expect(p.els["magic-link-continue"].disabled).toBe(false);
    expect(p.els["magic-link-missing"].hidden).toBe(true);
    expect(p.replaced).toEqual(["/auth/email/callback"]);
  });
  it("with no token: Continue stays disabled and the page says the link is incomplete", () => {
    const p = page();
    expect(wire(p.doc, { hash: "", pathname: "/auth/email/callback" }, p.hist)).toBe(false);
    expect(p.els["magic-link-token"].value).toBe("");
    expect(p.els["magic-link-continue"].disabled).toBe(true);
    expect(p.els["magic-link-missing"].hidden).toBe(false);
    expect(p.replaced).toEqual([]);
  });
  it("a bad fragment is stripped too, and fills nothing", () => {
    const p = page();
    expect(wire(p.doc, { hash: "#token=short", pathname: "/auth/email/callback" }, p.hist)).toBe(false);
    expect(p.els["magic-link-token"].value).toBe("");
    expect(p.replaced).toEqual(["/auth/email/callback"]);
  });
});
