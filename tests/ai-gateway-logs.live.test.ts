// LIVE verification of the SHIPPING AI Gateway log reader (cp#185). Opt-in, like every other
// .live.test.ts here: it runs only when a read token and an account id are present, so it stays out
// of CI.
//
//   AI_GATEWAY_READ_TOKEN=<token> CF_ACCOUNT_ID=<id> npx vitest run tests/ai-gateway-logs.live.test.ts
//
// WHY IT EXISTS, stated plainly because it is the whole argument of this file: every other test in
// this lane drives a fake, and a fake agrees with my own assumptions about my own requests. A stub
// proves the decision path; it never proves the shipped artifact. The facts this reader is built on
// (ascending order is supported, per_page caps at 50, created_at gt is SECOND-granular, the
// metadata dimensions are ANDed independently, a nonexistent gateway answers 200/total_count 0) are
// vendor behaviour. Vendor behaviour drifts, and a reader built from a recorded sample is only as
// fresh as the sample. This is the regression test for the sample.
//
// READ-ONLY. It lists log rows and asserts on their SHAPE and on the API's own refusals. It creates
// nothing, deletes nothing, and costs nothing.

import { describe, it, expect } from "vitest";
import {
  AiGatewayLogsError,
  aiGatewayLogReader,
  buildLogsUrl,
  parseLogsResponse,
} from "../src/ai-gateway-logs";
import { runRollup } from "../src/llm-spend-rollup";

declare const process: { env: Record<string, string | undefined> };

const TOKEN = process.env.AI_GATEWAY_READ_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
// vivijure-hosted is the hosted-tenant gateway. NEVER skyphusion-llm, which is prism.
const GATEWAY = process.env.TENANT_AI_GATEWAY_ID ?? "vivijure-hosted";
const LIVE = Boolean(TOKEN && ACCOUNT);

const reader = LIVE
  ? aiGatewayLogReader({
      accountId: ACCOUNT as string,
      gatewayId: GATEWAY,
      token: TOKEN as string,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    })
  : null;

const raw = async (url: string) => {
  const res = await fetch(url, { headers: { authorization: "Bearer " + TOKEN } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe.skipIf(!LIVE)("AI Gateway logs, live", () => {
  it("the credential can read the hosted gateway at all (the precondition for everything below)", async () => {
    const probed = await reader!.probe();
    // total may legitimately be 0 on a quiet gateway; what must NOT happen is a throw, which is how
    // a dead or wrongly-scoped credential shows up. Judged on the CALL SUCCEEDING, never on the
    // presence of rows.
    expect(probed).toHaveProperty("total");
  });

  it("a page comes back in the SHAPE the parser is built for", async () => {
    const page = await reader!.list({ page: 1, perPage: 5 });
    expect(Array.isArray(page.rows)).toBe(true);
    if (page.rows.length === 0) {
      // Honest skip rather than a silent pass: a gateway with no rows cannot prove a row's shape,
      // and pretending otherwise is exactly the empty-result-read-as-evidence failure this lane is
      // about.
      console.warn("live: gateway holds no rows; per-row shape assertions could not run");
      return;
    }
    const row = page.rows[0];
    expect(typeof row.id).toBe("string");
    expect(typeof row.created_at).toBe("string");
    // CF computes cost natively; we never price tokens ourselves for the Opus class.
    expect(["number", "undefined"]).toContain(typeof row.cost);
  });

  it("STILL walks ascending: the first row of page 1 is the oldest, not the newest", async () => {
    const page = await reader!.list({ page: 1, perPage: 50 });
    if (page.rows.length < 2) {
      console.warn("live: fewer than 2 rows; ordering could not be proven");
      return;
    }
    const times = page.rows.map((r) => r.created_at);
    expect([...times].sort()).toEqual(times);
  });

  it("STILL caps per_page at 50, and the cap is the API's, not only ours", async () => {
    // Our own guard first...
    await expect(reader!.list({ page: 1, perPage: 51 })).rejects.toThrow(AiGatewayLogsError);
    // ...then the API's, bypassing our guard, so we learn if the vendor cap ever moves.
    const url = buildLogsUrl({ accountId: ACCOUNT as string, gatewayId: GATEWAY, page: 1, perPage: 51 });
    const res = await raw(url);
    expect(res.body.success).toBe(false);
    expect(JSON.stringify(res.body.errors)).toContain("50");
  });

  // THE FACT THE WATERMARK'S SAFETY RESTS ON. `gt` compares at SECOND granularity, so the whole
  // second containing the watermark is re-delivered and no row is ever skipped. If this ever
  // becomes strict at millisecond precision, a row sharing the watermark's exact millisecond starts
  // being skipped silently, which is a permanent under-count. That is worth one live assertion.
  it("STILL treats created_at gt as second-granular, so a watermark never skips a row", async () => {
    const page = await reader!.list({ page: 1, perPage: 50 });
    if (page.rows.length === 0) {
      console.warn("live: no rows; gt granularity could not be proven");
      return;
    }
    const oldest = page.rows[0].created_at;
    const afterItself = await reader!.list({ page: 1, perPage: 50, after: oldest });
    expect(afterItself.rows.some((r) => r.created_at === oldest)).toBe(true);
    // CONTROL: the next whole second DOES exclude it, so the filter is a real filter and not a
    // no-op that would make the assertion above pass for the wrong reason.
    const nextSecond = new Date(Math.floor(Date.parse(oldest) / 1000) * 1000 + 1000).toISOString();
    const afterNext = await reader!.list({ page: 1, perPage: 50, after: nextSecond });
    expect(afterNext.rows.some((r) => r.created_at === oldest)).toBe(false);
  });

  // THE HAZARD THE POSITIVE CONTROL EXISTS FOR. If this ever starts 404ing, the control becomes
  // unnecessary; while it answers 200 with a zero, the control is load-bearing.
  it("STILL answers 200 / success:true / total_count 0 for a gateway that does not exist", async () => {
    const url = buildLogsUrl({
      accountId: ACCOUNT as string,
      gatewayId: "this-gateway-does-not-exist-xyzzy-9999",
      page: 1,
      perPage: 1,
    });
    const res = await raw(url);
    expect(res.status).toBe(200);
    const page = parseLogsResponse(res.status, res.body);
    expect(page.totalCount).toBe(0);
    expect(page.rows).toEqual([]);
  });

  // Proves the correction recorded in ai-gateway-logs.ts is still true: the metadata dimensions are
  // ANDed INDEPENDENTLY, so a per-tenant filter can return a row belonging to another tenant. It is
  // why the walk sends no metadata filter. Runs only when a row with both keys exists.
  it("STILL evaluates metadata.key and metadata.value as INDEPENDENT dimensions", async () => {
    const page = await reader!.list({ page: 1, perPage: 50 });
    const witness = page.rows.find((r) => {
      const m = r.metadata as Record<string, unknown> | null | undefined;
      return m && typeof m.tenant_id === "string" && typeof m.slug === "string" && m.tenant_id !== m.slug;
    });
    if (!witness) {
      console.warn("live: no row carrying distinct tenant_id and slug; filter semantics not re-proven");
      return;
    }
    const m = witness.metadata as Record<string, string>;
    // key = tenant_id, value = the SLUG's value. A pair-matched filter returns nothing here.
    const url = new URL(
      buildLogsUrl({ accountId: ACCOUNT as string, gatewayId: GATEWAY, page: 1, perPage: 50 }),
    );
    url.searchParams.set(
      "filters",
      JSON.stringify([
        { key: "metadata.key", operator: "eq", value: ["tenant_id"] },
        { key: "metadata.value", operator: "eq", value: [m.slug] },
      ]),
    );
    const crossed = parseLogsResponse(...(Object.values(await raw(url.toString())) as [number, unknown]));
    expect(
      crossed.rows.length,
      "a metadata filter returned a row whose tenant_id is not the filtered value: the dimensions " +
        "are independent, so this filter must never be used for attribution",
    ).toBeGreaterThan(0);
  });

  // The whole decision path over the REAL reader. Not a billing run: nothing is written.
  it("runRollup over the LIVE reader passes its positive control and attributes off the row", async () => {
    const result = await runRollup(reader!, undefined, 4);
    expect(result.status).not.toBe("failed");
    if (!result.controlPassed) {
      console.warn("live: gateway is empty, so the positive control failed as designed");
      expect(result.note).toContain("POSITIVE CONTROL FAILED");
      return;
    }
    expect(result.events.length).toBeGreaterThan(0);
    for (const e of result.events) {
      expect(e.source).toBe("ai_gateway");
      expect(typeof e.sourceId).toBe("string");
      // Integer micro-USD or an honest null. NEVER a float, never a coerced zero.
      expect(e.costMicroUsd === null || Number.isInteger(e.costMicroUsd)).toBe(true);
    }
  });
});
