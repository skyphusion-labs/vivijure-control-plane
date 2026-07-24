import { describe, expect, it } from "vitest";

import {
  rotateWarning,
  revokeWarning,
  revealNotice,
  safeStudioUrl,
  snippets,
  summaryLine,
  tokenErrorCopy,
  tokenView,
  whenLabel,
  type TokenPayload,
} from "../public/api-token-checks.js";

// The tenant programmatic-token panel (cf#94). Everything here decides what a
// tenant is told about a credential of theirs, so the failure modes get the tests:
// an unreadable payload must REFUSE rather than default to a cheerful "no token
// yet" (which would render a Create button), and no code path may put a plaintext
// token into a copyable snippet.

describe("tokenView", () => {
  it("reads the two states the backend actually reports", () => {
    expect(tokenView({ configured: true }).state).toBe("present");
    expect(tokenView({ configured: false }).state).toBe("absent");
  });

  it("refuses to collapse an unreadable payload into 'absent'", () => {
    // This is the load-bearing one. "absent" renders a Create button; "unknown"
    // must not. A null/garbage payload means we failed to read the state, NOT that
    // the tenant has no token, and minting against a reply we could not parse is
    // exactly the button-that-throws class.
    expect(tokenView(null).state).toBe("unknown");
    expect(tokenView(undefined).state).toBe("unknown");
    expect(tokenView({} as TokenPayload).state).toBe("unknown");
    expect(tokenView("nope" as never).state).toBe("unknown");
    expect(tokenView({ configured: "true" as never }).state).toBe("unknown");
  });

  it("projects custody rather than assuming the ruling", () => {
    expect(tokenView({ configured: true, custody: "separate" }).custody).toBe("separate");
    expect(tokenView({ configured: true, custody: "shared" }).custody).toBe("shared");
    // An unrecognized custody is null, not silently treated as the safe one.
    expect(tokenView({ configured: true, custody: "weird" }).custody).toBeNull();
    expect(tokenView({ configured: true }).custody).toBeNull();
  });

  it("carries only the masked display the backend sent", () => {
    expect(tokenView({ configured: true, display: "vjs_...9f2c" }).display).toBe("vjs_...9f2c");
    expect(tokenView({ configured: true }).display).toBe("");
    expect(tokenView({ configured: true, display: 42 as never }).display).toBe("");
  });
});

describe("rotateWarning: the honest cost of the button", () => {
  it("tells a separate-custody tenant their browser session survives", () => {
    const copy = rotateWarning("separate");
    expect(copy).toContain("NOT affected");
  });

  it("gets HARSHER, not quieter, if the backend ever reports shared custody", () => {
    // The ruling is separate-token, so this branch should never fire in production.
    // It is kept and tested because a UI that assumes a ruling it did not read is
    // how a warning goes stale after someone changes the backend.
    const copy = rotateWarning("shared");
    expect(copy).toContain("WARNING");
    expect(copy).toContain("signs you out");
  });

  it("does not claim safety when custody is unknown", () => {
    const copy = rotateWarning(null);
    expect(copy).not.toContain("NOT affected");
    expect(copy).toContain("cannot tell");
  });

  it("says revoking is irreversible", () => {
    expect(revokeWarning()).toContain("cannot get this one back");
  });

  it("states reveal-once plainly", () => {
    const copy = revealNotice();
    expect(copy).toContain("only time");
    expect(copy).toContain("never written to a log");
  });
});

describe("safeStudioUrl: these strings get pasted into a shell", () => {
  it("accepts a plain https origin and strips path/query", () => {
    expect(safeStudioUrl("https://acme.studio.vivijure.com/planner?x=1")).toBe(
      "https://acme.studio.vivijure.com",
    );
  });

  it("refuses anything that is not plain https", () => {
    expect(safeStudioUrl("http://acme.studio.vivijure.com")).toBeNull();
    expect(safeStudioUrl("javascript:alert(1)")).toBeNull();
    expect(safeStudioUrl("data:text/html,x")).toBeNull();
    expect(safeStudioUrl("not a url")).toBeNull();
    expect(safeStudioUrl(null)).toBeNull();
    expect(safeStudioUrl("")).toBeNull();
  });

  it("refuses embedded credentials", () => {
    expect(safeStudioUrl("https://user:pw@acme.studio.vivijure.com")).toBeNull();
  });
});

describe("snippets", () => {
  const URL_OK = "https://acme.studio.vivijure.com";

  it("renders a curl example against the tenant's own origin", () => {
    const rows = snippets(URL_OK, { configured: true });
    expect(rows.map((r) => r.id)).toEqual(["curl"]);
    expect(rows[0].body).toContain(URL_OK + "/api/modules");
  });

  it("NEVER interpolates a token value into a copyable snippet", () => {
    // A snippet with the live secret baked in is a secret that ends up in a bug
    // report or a screenshot, and reveal-once would be a fiction. Feed a hostile
    // payload carrying token-shaped fields and assert none of them survive.
    const hostile = {
      configured: true,
      display: "vjs_...9f2c",
      token: "vjs_SUPERSECRETVALUE",
      plaintext: "vjs_ALSOSECRET",
    } as TokenPayload;
    const bodies = snippets(URL_OK, hostile).map((r) => r.body).join("\n");
    expect(bodies).not.toContain("SUPERSECRET");
    expect(bodies).not.toContain("ALSOSECRET");
    expect(bodies).not.toContain("9f2c");
    // CONTROL: the assertions above would also pass on an empty string, which
    // would make this test worthless. Prove the snippet really was produced and
    // really does carry the placeholder instead.
    expect(bodies).toContain("paste-your-token-here");
    expect(bodies).toContain("Authorization: Bearer");
  });

  it("advertises MCP only when the plane says MCP exists", () => {
    // Projection rule: a config block pointing at a hostname that does not serve
    // MCP is a button that throws.
    expect(snippets(URL_OK, { configured: true }).map((r) => r.id)).not.toContain("mcp");
    const withMcp = snippets(URL_OK, {
      configured: true,
      mcp_url: "https://acme-mcp.vivijure.com",
    });
    expect(withMcp.map((r) => r.id)).toContain("mcp");
    expect(withMcp.find((r) => r.id === "mcp")?.body).toContain("https://acme-mcp.vivijure.com");
  });

  it("emits nothing rather than a broken command when the studio URL is unusable", () => {
    expect(snippets(null, { configured: true })).toEqual([]);
    expect(snippets("http://insecure.example", { configured: true })).toEqual([]);
  });
});

describe("tokenErrorCopy", () => {
  it("explains the codes the plane actually returns", () => {
    expect(tokenErrorCopy("tenant_not_live")).toContain("not live yet");
    expect(tokenErrorCopy("kek_unavailable")).toContain("nothing about your token changed");
    expect(tokenErrorCopy("unauthorized")).toContain("Sign in again");
  });

  it("admits ignorance on an unknown code instead of guessing a diagnosis", () => {
    const copy = tokenErrorCopy("some_new_code_joan_never_saw");
    expect(copy).toContain("not going to guess");
    expect(copy).toContain("Nothing was changed");
  });

  it("returns null when there is no error at all", () => {
    expect(tokenErrorCopy(null)).toBeNull();
    expect(tokenErrorCopy("")).toBeNull();
  });
});

describe("summaryLine / whenLabel", () => {
  it("never invents a date it was not given", () => {
    expect(whenLabel(null)).toBe("");
    expect(whenLabel("not-a-date")).toBe("");
    expect(whenLabel("2026-07-25T10:11:12Z")).toBe("2026-07-25");
  });

  it("prefers the rotation date when there is one", () => {
    const view = tokenView({
      configured: true,
      display: "vjs_...9f2c",
      created_at: "2026-07-01T00:00:00Z",
      last_rotated_at: "2026-07-20T00:00:00Z",
    });
    expect(summaryLine(view)).toBe("vjs_...9f2c -- last rotated 2026-07-20");
  });

  it("falls back to creation, and is empty for a token that does not exist", () => {
    expect(summaryLine(tokenView({ configured: true, created_at: "2026-07-01T00:00:00Z" }))).toBe(
      "created 2026-07-01",
    );
    expect(summaryLine(tokenView({ configured: false }))).toBe("");
    expect(summaryLine(tokenView(null))).toBe("");
  });
});
