// Operator price book for tenant usage. Config, not hardcoded rates.
//
// The plane already records every hosted RunPod /run (runpod_job_index) and every
// attributed AI Gateway row (llm_spend_events). This file turns execution_ms into
// micro-USD so an operator can SEE what a tenant used. It does not refuse submits.
//
// SPEND_PRICEBOOK is JSON:
//   {
//     "default_usd_per_second": 0.001765,
//     "endpoints": { "t9wcvlxh8rc5la": { "usd_per_second": 0.001765 },
//                    "zqb7tougbqfkqa": { "usd_per_second": 0.001881 },
//                    "kling-v2-1-i2v-pro": { "usd_per_job": 0.08 } }
//   }
// Unset book: we still report jobs and ms; cost_micro_usd is null (unknown, never 0).

import type { MicroUsd } from "./credits";
import { MICRO_PER_USD } from "./credits";

export interface EndpointPrice {
  usd_per_second?: number;
  usd_per_job?: number;
}

export interface SpendPricebook {
  default_usd_per_second: number | null;
  endpoints: Record<string, EndpointPrice>;
}

export function parseSpendPricebook(raw: string | undefined | null): SpendPricebook {
  const empty: SpendPricebook = { default_usd_per_second: null, endpoints: {} };
  if (!raw || !raw.trim()) return empty;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const def = parsed.default_usd_per_second;
    const endpoints: Record<string, EndpointPrice> = {};
    const ep = parsed.endpoints;
    if (ep && typeof ep === "object" && !Array.isArray(ep)) {
      for (const [k, v] of Object.entries(ep as Record<string, unknown>)) {
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        const row = v as Record<string, unknown>;
        const out: EndpointPrice = {};
        if (typeof row.usd_per_second === "number" && Number.isFinite(row.usd_per_second)) {
          out.usd_per_second = row.usd_per_second;
        }
        if (typeof row.usd_per_job === "number" && Number.isFinite(row.usd_per_job)) {
          out.usd_per_job = row.usd_per_job;
        }
        endpoints[k] = out;
      }
    }
    return {
      default_usd_per_second:
        typeof def === "number" && Number.isFinite(def) ? def : null,
      endpoints,
    };
  } catch {
    return empty;
  }
}

/** Price one closed job. NULL cost means we cannot price it (never write 0 for unknown). */
export function priceRunpodJob(
  book: SpendPricebook,
  args: { endpointId: string | null; outcome: string | null; executionMs: number | null },
): { cost_micro_usd: MicroUsd | null; priced_as: string } {
  const ep = args.endpointId ? book.endpoints[args.endpointId] : undefined;
  if (ep?.usd_per_job != null) {
    if (args.outcome && args.outcome !== "COMPLETED" && args.outcome !== "completed") {
      return { cost_micro_usd: 0, priced_as: "per_job_failed_free" };
    }
    return {
      cost_micro_usd: Math.round(ep.usd_per_job * MICRO_PER_USD),
      priced_as: "per_job",
    };
  }
  const rate = ep?.usd_per_second ?? book.default_usd_per_second;
  if (rate == null) return { cost_micro_usd: null, priced_as: "unpriced" };
  if (args.executionMs == null) return { cost_micro_usd: null, priced_as: "unpriced_no_ms" };
  return {
    cost_micro_usd: Math.round((args.executionMs / 1000) * rate * MICRO_PER_USD),
    priced_as: ep?.usd_per_second != null ? "per_second_endpoint" : "per_second_default",
  };
}
