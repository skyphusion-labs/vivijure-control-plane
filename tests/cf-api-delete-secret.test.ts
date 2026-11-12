// fleet-chezmoi#2048: CfApi.deleteScriptSecret. The wire shape, and a 404 counting as success.
import { describe, expect, it } from "vitest";
import { CfApi, CfApiError } from "../src/cf-api";

function api(status: number, seen: { url?: string; method?: string }) {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(input);
    seen.method = init?.method;
    const ok = status >= 200 && status < 300;
    return new Response(JSON.stringify({ success: ok, errors: ok ? [] : [{ code: status, message: "x" }], result: null }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return new CfApi("acct", "t", fetchImpl);
}

describe("CfApi.deleteScriptSecret", () => {
  it("DELETEs the named secret on the dispatch script", async () => {
    const seen: { url?: string; method?: string } = {};
    await api(200, seen).deleteScriptSecret("vivijure-tenants", "tenant-hero-studio", "RUNPOD_API_KEY");
    expect(seen.method).toBe("DELETE");
    expect(seen.url).toMatch(/\/accounts\/acct\/workers\/dispatch\/namespaces\/vivijure-tenants\/scripts\/tenant-hero-studio\/secrets\/RUNPOD_API_KEY$/);
  });

  it("treats a 404 as success: the secret is already absent", async () => {
    await expect(api(404, {}).deleteScriptSecret("ns", "s", "RUNPOD_API_KEY")).resolves.toBeUndefined();
  });

  it("throws on any other failure", async () => {
    await expect(api(500, {}).deleteScriptSecret("ns", "s", "RUNPOD_API_KEY")).rejects.toBeInstanceOf(CfApiError);
  });
});
