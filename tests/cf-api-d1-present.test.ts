// CfApi.d1Present: teardown asks it whether a D1 still exists after a failed job-log harvest. Only a 404
// may read as "gone"; any other answer must throw, because a wrong "gone" lets teardown delete past the
// interlock that protects the job log.
import { describe, expect, it } from "vitest";
import { CfApi } from "../src/cf-api";

function api(status: number, body: unknown) {
  const seen: { url: string; method: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { seen, cf: new CfApi("acct-1", "token-1", fetchImpl) };
}

describe("CfApi.d1Present", () => {
  it("true on 200, reading GET /d1/database/<id>", async () => {
    const { cf, seen } = api(200, { success: true, result: { uuid: "db-1" } });
    expect(await cf.d1Present("db-1")).toBe(true);
    expect(seen).toEqual([{ url: expect.stringMatching(/\/accounts\/acct-1\/d1\/database\/db-1$/), method: "GET" }]);
  });
  it("false on 404", async () => {
    const { cf } = api(404, { success: false, errors: [{ code: 7404, message: "database not found" }], result: null });
    expect(await cf.d1Present("db-1")).toBe(false);
  });
  for (const status of [401, 403, 500]) {
    it(`throws on ${status}: could not tell is never gone`, async () => {
      const { cf } = api(status, { success: false, errors: [{ code: 1, message: "x" }], result: null });
      await expect(cf.d1Present("db-1")).rejects.toThrow();
    });
  }
});
