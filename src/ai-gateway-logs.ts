// cp#185: the CONCRETE GatewayLogReader. The one place a real AI Gateway is reached.
//
// llm-spend-rollup.ts holds the decision path and is pure, so it is unit tested without a network.
// This file is the un-stubbable seam under it: production wires exactly this, tests replace the
// whole thing, and there is no third code path.
//
// EVERY REQUEST-SHAPE FACT BELOW WAS READ OFF THE LIVE `vivijure-hosted` GATEWAY (rollins,
// 2026-07-28), not off documentation and not carried over from a prior design note. Where a
// previously recorded fact turned out to be coarser than reality it is corrected here with the
// probe that corrected it, because a confident stale fact mis-anchors whoever reads it next.

import type { GatewayLogReader, GatewayLogRow, GatewayPage } from "./llm-spend-rollup";
import { MAX_PER_PAGE } from "./llm-spend-rollup";

/**
 * prism. NOT ours to meter, and it is the ONE misconfiguration the roll-up positive control cannot
 * catch: this gateway carried 99,000 log rows when checked on 2026-07-28, so pointing the meter at
 * it PASSES the "an unfiltered probe returned a non-zero total" control while attributing another
 * product entirely. Every other wrong value (typo, deleted gateway, wrong account) lands on the
 * proven 200 / success:true / total_count:0 answer and the control catches it. This one it cannot,
 * so it is refused BY NAME at construction rather than trusted to a runbook.
 */
export const PRISM_GATEWAY_ID = "skyphusion-llm";

/** Anything the gateway told us that we will not build a meter on top of. */
export class AiGatewayLogsError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "AiGatewayLogsError";
  }
}

export interface AiGatewayLogsConfig {
  accountId: string;
  gatewayId: string;
  /** AI Gateway Read + Metadata Read. Never rendered, never logged, never returned. */
  token: string;
  /** Injected so the decision path above this is testable and so nothing here reaches global fetch. */
  fetch: typeof fetch;
}

const API_ROOT = "https://api.cloudflare.com/client/v4";

/**
 * The logs URL, pure so the request SHAPE is asserted in unit tests rather than only in a live run.
 *
 * ORDERING IS ASCENDING, DELIBERATELY. `order_by=created_at` with `order_by_direction=asc` is
 * supported (verified live; the design note that predates this file did not know it and assumed the
 * default). It matters: the default order is DESCENDING, so a request arriving mid-walk pushes every
 * older row one position later and a page-by-page walk then re-reads one row and SKIPS another. An
 * ascending walk from a watermark is stable under concurrent arrivals because new rows land at the
 * END, past where the walk is looking.
 *
 * THE WATERMARK FILTER IS SECOND-GRANULAR, AND THAT IS WHY IT IS SAFE. `created_at gt <ts>` does NOT
 * compare at the millisecond precision the timestamps are rendered in. Measured against the two live
 * rows (oldest 04:45:20.710Z):
 *
 *   gt 2026-07-27T04:45:20.710Z -> 2 rows   (the boundary row itself came back)
 *   gt 2026-07-27T04:45:20.999Z -> 2 rows
 *   gt 2026-07-27T04:45:21.000Z -> 1 row
 *
 * So the predicate behaves as floor_seconds(created_at) >= floor_seconds(filter). The consequence is
 * the one we want: a watermark NEVER skips a row, not even a row sharing its exact millisecond,
 * because the whole second containing the watermark is re-delivered. Re-delivery is free (writes are
 * INSERT OR IGNORE on (source, source_id)) whereas a skip would be a silent, permanent under-count,
 * which is the failure this entire lane exists to prevent.
 *
 * The bound that buys, stated rather than left to be discovered: a run cannot advance past a single
 * second holding more rows than one run can page (pageCap * perPage). At the Opus call rate this
 * meter exists for, that is not reachable.
 *
 * There is deliberately NO metadata filter. See the listing semantics in the reader below.
 */
export function buildLogsUrl(opts: {
  accountId: string;
  gatewayId: string;
  page: number;
  perPage: number;
  after?: string;
}): string {
  const url = new URL(
    API_ROOT +
      "/accounts/" +
      encodeURIComponent(opts.accountId) +
      "/ai-gateway/gateways/" +
      encodeURIComponent(opts.gatewayId) +
      "/logs",
  );
  url.searchParams.set("page", String(opts.page));
  url.searchParams.set("per_page", String(opts.perPage));
  url.searchParams.set("order_by", "created_at");
  url.searchParams.set("order_by_direction", "asc");
  if (opts.after) {
    url.searchParams.set(
      "filters",
      JSON.stringify([{ key: "created_at", operator: "gt", value: [opts.after] }]),
    );
  }
  return url.toString();
}

interface LogsEnvelope {
  success?: unknown;
  errors?: unknown;
  result?: unknown;
  result_info?: { total_count?: unknown } | null;
}

/**
 * Turn one HTTP answer into a page, or THROW.
 *
 * Throwing rather than returning an empty page is the whole point. runRollup records a throw as
 * `failed` and bills nothing; an empty page it would record as a real observation of no rows. Those
 * are different facts and this endpoint makes them easy to confuse: it answers HTTP 200,
 * success:true, total_count:0 for a gateway id that DOES NOT EXIST (re-verified 2026-07-28 against
 * this-gateway-does-not-exist-xyzzy-9999). So anything short of a well-formed success envelope is an
 * error here, never a zero.
 */
export function parseLogsResponse(status: number, body: unknown): GatewayPage {
  if (status < 200 || status >= 300) {
    throw new AiGatewayLogsError("AI Gateway logs answered HTTP " + status, status);
  }
  const envelope = (body ?? {}) as LogsEnvelope;
  if (envelope.success !== true) {
    // The error text is the API's own; it names the offending query path (a 7001 carries
    // path: ["query","per_page"]), which is what makes a misbuilt request diagnosable at all.
    throw new AiGatewayLogsError(
      "AI Gateway logs refused the request: " +
        JSON.stringify(envelope.errors ?? null).slice(0, 400),
      status,
    );
  }
  if (!Array.isArray(envelope.result)) {
    throw new AiGatewayLogsError("AI Gateway logs returned no result array", status);
  }
  const rawTotal = envelope.result_info?.total_count;
  return {
    rows: envelope.result as GatewayLogRow[],
    // A missing total is NULL, never 0. runRollup reads a null total as a FAILED positive control,
    // which is correct: not being told the total is not being told there is nothing.
    totalCount: typeof rawTotal === "number" && Number.isFinite(rawTotal) ? rawTotal : null,
  };
}

/**
 * Build the live reader. REFUSES at construction rather than at first use: a meter that discovers
 * its own misconfiguration on the first billing run has already written a period row.
 */
export function aiGatewayLogReader(cfg: AiGatewayLogsConfig): GatewayLogReader {
  const accountId = (cfg.accountId ?? "").trim();
  const gatewayId = (cfg.gatewayId ?? "").trim();
  if (!accountId) throw new AiGatewayLogsError("AI Gateway logs reader needs an account id");
  if (!gatewayId) throw new AiGatewayLogsError("AI Gateway logs reader needs a gateway id");
  if (!cfg.token) throw new AiGatewayLogsError("AI Gateway logs reader needs a read token");
  if (gatewayId === PRISM_GATEWAY_ID) {
    throw new AiGatewayLogsError(
      'refusing to meter gateway "' +
        PRISM_GATEWAY_ID +
        '": that is prism, not vivijure. Its logs are non-empty, so the roll-up positive control ' +
        "would PASS while attributing another product's spend to vivijure tenants. Point " +
        "TENANT_AI_GATEWAY_ID at the hosted gateway.",
    );
  }

  const get = async (url: string): Promise<GatewayPage> => {
    const res = await cfg.fetch(url, {
      headers: {
        // The only place this value is used. Never logged, never echoed into an error.
        authorization: "Bearer " + cfg.token,
        accept: "application/json",
      },
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      throw new AiGatewayLogsError(
        "AI Gateway logs answered HTTP " + res.status + " with a body that is not JSON",
        res.status,
      );
    }
    return parseLogsResponse(res.status, body);
  };

  return {
    /**
     * NO METADATA FILTER, AND THAT IS A CORRECTION RATHER THAN AN OMISSION.
     *
     * cp#221 recorded the metadata filter's pair-vs-independent semantics as unprovable against the
     * two rows that exist, and narrowed defensively. It IS provable with those two rows, and the
     * answer is the dangerous one. Live, 2026-07-28:
     *
     *   metadata.key eq "tenant_id" AND metadata.value eq "rollins-e2e"  ->  1 row
     *
     * where rollins-e2e is the value of `slug`, NOT of `tenant_id`. The two dimensions are ANDed
     * INDEPENDENTLY across the whole metadata map, so a per-tenant filter CAN return another
     * tenant's row. Control in the same result set: metadata.key eq "slug" with the same value also
     * returns 1, so the filter is not merely matching everything.
     *
     * A narrowing filter that can return the wrong tenant buys nothing here (attribution is read off
     * the row either way) and costs a permanent trap for the next reader, who would reasonably
     * assume a filtered result is already scoped. So the walk is unfiltered except by time.
     */
    async list({ after, page, perPage }) {
      if (!Number.isInteger(page) || page < 1) {
        throw new AiGatewayLogsError("page must be a positive integer, got " + page);
      }
      if (!Number.isInteger(perPage) || perPage < 1 || perPage > MAX_PER_PAGE) {
        // Mirrors the API's own hard refusal (7001 "Number must be less than or equal to 50",
        // verified live at per_page=51) rather than letting a caller discover it as a failed run.
        throw new AiGatewayLogsError(
          "per_page must be 1.." + MAX_PER_PAGE + ", got " + perPage,
        );
      }
      return await get(buildLogsUrl({ accountId, gatewayId, page, perPage, after }));
    },

    /**
     * The positive control AND the retention-gap read, in ONE request.
     *
     * UNFILTERED is load-bearing: total_count reflects the FILTER (a metadata-filtered query
     * returned total_count 1 against a gateway total of 2), so a filtered probe would report the
     * narrowed count and a genuinely broken read would still look like a real observation.
     *
     * Ascending with per_page=1 makes result[0] the OLDEST surviving row, which is what detects rows
     * deleted unread: retention is 10,000,000 rows DELETE_OLDEST with no time window, so an
     * oldest-surviving row NEWER than our watermark means the stretch between them is gone for good.
     */
    async probe() {
      const page = await get(buildLogsUrl({ accountId, gatewayId, page: 1, perPage: 1 }));
      const oldest = page.rows[0]?.created_at;
      return {
        total: page.totalCount,
        oldest: typeof oldest === "string" && oldest ? oldest : null,
      };
    },
  };
}
