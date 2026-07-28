// cp#185: the concrete AI Gateway log reader.
//
// Every guard here is watched FAILING on planted bad input before it is trusted passing, and every
// block of negative tests carries a POSITIVE CONTROL. A suite of refusals over an implementation
// that refuses EVERYTHING passes unanimously and proves nothing, which is the exact shape this
// lane's hazards keep taking.

import { describe, it, expect } from "vitest";
import {
  AiGatewayLogsError,
  PRISM_GATEWAY_ID,
  aiGatewayLogReader,
  buildLogsUrl,
  parseLogsResponse,
} from "../src/ai-gateway-logs";
import { MAX_PER_PAGE } from "../src/llm-spend-rollup";

const CFG = {
  accountId: "acct123",
  gatewayId: "vivijure-hosted",
  token: "tok-not-a-real-token",
};

/** A fetch that records what it was asked for and answers a canned envelope. */
function recordingFetch(bodies: unknown[], status = 200) {
  const calls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  let i = 0;
  const f = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: f as unknown as typeof fetch, calls, headers };
}

const envelope = (rows: unknown[], total: number | null = rows.length) => ({
  success: true,
  errors: null,
  result: rows,
  result_info: total === null ? {} : { count: rows.length, page: 1, per_page: 50, total_count: total },
});

const logRow = (over: Record<string, unknown> = {}) => ({
  id: "01KYGZH3ZBMJ7W9X3YCX9SAKH1",
  created_at: "2026-07-27T05:07:31.543Z",
  model: "claude-opus-4-8",
  cost: 0.000145,
  metadata: { tenant_id: "ten_abc", slug: "acme" },
  ...over,
});

describe("buildLogsUrl", () => {
  // ASCENDING is not cosmetic. The default order is descending, so a row arriving mid-walk shifts
  // every older row one position later, and a page-by-page walk then re-reads one and SKIPS one.
  it("always walks ASCENDING by created_at", () => {
    const u = new URL(buildLogsUrl({ ...CFG, page: 1, perPage: 50 }));
    expect(u.searchParams.get("order_by")).toBe("created_at");
    expect(u.searchParams.get("order_by_direction")).toBe("asc");
  });

  it("targets the gateway logs path for the configured account", () => {
    const u = new URL(buildLogsUrl({ ...CFG, page: 3, perPage: 50 }));
    expect(u.pathname).toBe("/client/v4/accounts/acct123/ai-gateway/gateways/vivijure-hosted/logs");
    expect(u.searchParams.get("page")).toBe("3");
    expect(u.searchParams.get("per_page")).toBe("50");
  });

  // The filter shape is exact: a dotted key is rejected live with a hard 7001, and the value is an
  // ARRAY even for a single scalar.
  it("encodes the watermark as a created_at gt filter with an array value", () => {
    const u = new URL(buildLogsUrl({ ...CFG, page: 1, perPage: 50, after: "2026-07-27T05:00:00Z" }));
    expect(JSON.parse(u.searchParams.get("filters") as string)).toEqual([
      { key: "created_at", operator: "gt", value: ["2026-07-27T05:00:00Z"] },
    ]);
  });

  // NEGATIVE CONTROL for the above: with no watermark there must be NO filter at all. A filter that
  // is always present would silently narrow the first (backfill) run.
  it("sends no filter when there is no watermark", () => {
    const u = new URL(buildLogsUrl({ ...CFG, page: 1, perPage: 50 }));
    expect(u.searchParams.get("filters")).toBeNull();
  });

  // THE FILTER PROVEN NOT TO BE A METADATA FILTER. Live, the metadata dimensions are ANDed
  // INDEPENDENTLY (metadata.key eq "tenant_id" AND metadata.value eq "rollins-e2e" returns the row
  // whose tenant_id is ten_de43..., because rollins-e2e is the SLUG's value). A per-tenant filter
  // can therefore return another tenant's row, so the walk must never send one.
  it("NEVER sends a metadata filter, at any page, with or without a watermark", () => {
    for (const after of [undefined, "2026-07-27T05:00:00Z"]) {
      const raw = new URL(buildLogsUrl({ ...CFG, page: 1, perPage: 50, after })).searchParams.get(
        "filters",
      );
      expect(raw ?? "").not.toContain("metadata");
    }
  });
});

describe("parseLogsResponse", () => {
  it("CONTROL: a well-formed success envelope parses", () => {
    const page = parseLogsResponse(200, envelope([logRow()], 7));
    expect(page.rows).toHaveLength(1);
    expect(page.totalCount).toBe(7);
  });

  // The whole reason this throws instead of returning an empty page: runRollup records a throw as
  // `failed` and bills nothing, but an empty page it records as a real observation of no rows.
  it("THROWS on a non-2xx rather than returning an empty page", () => {
    expect(() => parseLogsResponse(401, { success: false })).toThrow(AiGatewayLogsError);
    expect(() => parseLogsResponse(500, envelope([]))).toThrow(/HTTP 500/);
  });

  it("THROWS on success:false, carrying the API's own error text", () => {
    expect(() =>
      parseLogsResponse(200, {
        success: false,
        errors: [{ code: 7001, message: "Number must be less than or equal to 50" }],
      }),
    ).toThrow(/7001/);
  });

  it("THROWS when there is no result array", () => {
    expect(() => parseLogsResponse(200, { success: true, result: null })).toThrow(/no result array/);
  });

  // A missing total must be UNKNOWN, never zero: runRollup reads a null total as a FAILED positive
  // control, and reading it as 0 would do the same thing here but for the wrong reason -- reading
  // it as a number would be the bug, and only this asserts it is not.
  it("reports a missing total_count as NULL, not 0", () => {
    expect(parseLogsResponse(200, envelope([logRow()], null)).totalCount).toBeNull();
    expect(parseLogsResponse(200, { success: true, result: [], result_info: { total_count: "12" } }).totalCount).toBeNull();
  });
});

describe("aiGatewayLogReader construction", () => {
  it("CONTROL: a fully configured reader is built", () => {
    expect(() => aiGatewayLogReader({ ...CFG, fetch: recordingFetch([]).fetch })).not.toThrow();
  });

  it("refuses without an account id, a gateway id, or a token", () => {
    const f = recordingFetch([]).fetch;
    expect(() => aiGatewayLogReader({ ...CFG, accountId: " ", fetch: f })).toThrow(/account id/);
    expect(() => aiGatewayLogReader({ ...CFG, gatewayId: "", fetch: f })).toThrow(/gateway id/);
    expect(() => aiGatewayLogReader({ ...CFG, token: "", fetch: f })).toThrow(/read token/);
  });

  // THE ONE MISCONFIGURATION THE POSITIVE CONTROL CANNOT CATCH. Every other wrong gateway id lands
  // on the proven 200/success:true/total_count:0 answer and the control fails. prism's gateway is
  // NOT empty (99,000 rows on 2026-07-28), so the control PASSES and every row is misattributed.
  it("refuses prism BY NAME, because the roll-up control would pass on it", () => {
    expect(() =>
      aiGatewayLogReader({ ...CFG, gatewayId: PRISM_GATEWAY_ID, fetch: recordingFetch([]).fetch }),
    ).toThrow(/that is prism/);
  });
});

describe("aiGatewayLogReader.list", () => {
  it("CONTROL: a page comes back with its rows and the gateway total", async () => {
    const rec = recordingFetch([envelope([logRow(), logRow({ id: "b" })], 2)]);
    const reader = aiGatewayLogReader({ ...CFG, fetch: rec.fetch });
    const page = await reader.list({ page: 1, perPage: 50 });
    expect(page.rows).toHaveLength(2);
    expect(page.totalCount).toBe(2);
    expect(rec.calls[0]).toContain("order_by_direction=asc");
  });

  it("sends the token as a bearer and NEVER in the URL", async () => {
    const rec = recordingFetch([envelope([])]);
    await aiGatewayLogReader({ ...CFG, fetch: rec.fetch }).list({ page: 1, perPage: 50 });
    expect(rec.headers[0].authorization).toBe("Bearer " + CFG.token);
    expect(rec.calls[0]).not.toContain(CFG.token);
  });

  // Mirrors the API's OWN hard refusal (7001 at per_page=51, verified live) rather than letting a
  // caller find out by burning a run on a request the gateway will not answer.
  it("refuses a per_page outside 1..50 and a non-positive page", async () => {
    const reader = aiGatewayLogReader({ ...CFG, fetch: recordingFetch([envelope([])]).fetch });
    await expect(reader.list({ page: 1, perPage: MAX_PER_PAGE + 1 })).rejects.toThrow(/per_page/);
    await expect(reader.list({ page: 1, perPage: 0 })).rejects.toThrow(/per_page/);
    await expect(reader.list({ page: 0, perPage: 50 })).rejects.toThrow(/page/);
    // CONTROL: the boundary value it is supposed to ACCEPT still works, so the guard is a range
    // check and not a blanket refusal.
    await expect(reader.list({ page: 1, perPage: MAX_PER_PAGE })).resolves.toBeTruthy();
  });

  it("propagates a body that is not JSON as an error, not as an empty page", async () => {
    const f = (async () => new Response("<html>gateway timeout</html>", { status: 504 })) as unknown as typeof fetch;
    await expect(aiGatewayLogReader({ ...CFG, fetch: f }).list({ page: 1, perPage: 50 })).rejects.toThrow(
      /not JSON/,
    );
  });
});

describe("aiGatewayLogReader.probe", () => {
  it("is UNFILTERED, so the total it reports is the gateway's and not a narrowed one", async () => {
    const rec = recordingFetch([envelope([logRow({ created_at: "2026-07-27T04:45:20.710Z" })], 9)]);
    const probed = await aiGatewayLogReader({ ...CFG, fetch: rec.fetch }).probe();
    expect(probed.total).toBe(9);
    // The live fact this defends: a metadata-filtered query returned total_count 1 against a
    // gateway total of 2, so a filtered probe would report the narrow count as the control.
    expect(rec.calls[0]).not.toContain("filters");
  });

  it("reads the OLDEST surviving row, which is what detects rows deleted unread", async () => {
    const rec = recordingFetch([envelope([logRow({ created_at: "2026-07-27T04:45:20.710Z" })], 9)]);
    const probed = await aiGatewayLogReader({ ...CFG, fetch: rec.fetch }).probe();
    expect(probed.oldest).toBe("2026-07-27T04:45:20.710Z");
    expect(rec.calls[0]).toContain("order_by_direction=asc");
    expect(rec.calls[0]).toContain("per_page=1");
  });

  // THE PROVEN HAZARD, end to end through the real parser: a gateway that DOES NOT EXIST answers
  // HTTP 200 / success:true / total_count:0, byte-identical in shape to a real empty gateway.
  it("reports the nonexistent-gateway answer as total 0 and oldest null, never as an error", async () => {
    const rec = recordingFetch([envelope([], 0)]);
    const probed = await aiGatewayLogReader({
      ...CFG,
      gatewayId: "this-gateway-does-not-exist-xyzzy-9999",
      fetch: rec.fetch,
    }).probe();
    // It is NOT this layer's job to decide that is suspicious; runRollup's positive control is.
    // This asserts the fact travels UP intact rather than being smoothed into an error or a guess.
    expect(probed).toEqual({ total: 0, oldest: null });
  });
});
