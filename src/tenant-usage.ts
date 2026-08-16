// Operator view: what one tenant used. GPU / public-slug i2v / LLM.
// Assembled from rows the plane already writes. Pure once the rows are in hand.

import { MICRO_PER_USD } from "./credits";
import { priceRunpodJob, type SpendPricebook } from "./spend-pricebook";
import type { TenantLlmEvent, TenantRunpodJob } from "./store";

export interface UsageJob {
  kind: "runpod";
  job_id: string;
  module: string | null;
  endpoint_id: string | null;
  outcome: string | null;
  execution_ms: number | null;
  cost_micro_usd: number | null;
  priced_as: string;
  submitted_at: number | null;
  source: string | null;
}

export interface UsageLlm {
  kind: "llm";
  source_id: string;
  model: string | null;
  cost_micro_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  occurred_at: string;
}

export interface ModuleRollup {
  module: string;
  jobs: number;
  execution_ms: number;
  cost_micro_usd: number | null;
  unpriced: number;
}

export interface TenantUsage {
  tenant_id: string;
  runpod: UsageJob[];
  llm: UsageLlm[];
  by_module: ModuleRollup[];
  totals: {
    runpod_jobs: number;
    runpod_execution_ms: number;
    runpod_cost_micro_usd: number | null;
    runpod_unpriced: number;
    llm_requests: number;
    llm_cost_micro_usd: number | null;
    llm_unpriced: number;
    cost_micro_usd: number | null;
  };
}

export function assembleTenantUsage(args: {
  tenantId: string;
  jobs: TenantRunpodJob[];
  llm: TenantLlmEvent[];
  book: SpendPricebook;
}): TenantUsage {
  const runpod: UsageJob[] = args.jobs.map((j) => {
    const priced = priceRunpodJob(args.book, {
      endpointId: j.endpoint_id,
      outcome: j.status_raw ?? j.outcome,
      executionMs: j.execution_ms,
    });
    return {
      kind: "runpod",
      job_id: j.job_id,
      module: j.module,
      endpoint_id: j.endpoint_id,
      outcome: j.outcome,
      execution_ms: j.execution_ms,
      cost_micro_usd: priced.cost_micro_usd,
      priced_as: priced.priced_as,
      submitted_at: j.submitted_at,
      source: j.source,
    };
  });
  const llm: UsageLlm[] = args.llm.map((e) => ({
    kind: "llm",
    source_id: e.source_id,
    model: e.model,
    cost_micro_usd: e.cost_micro_usd,
    tokens_in: e.tokens_in,
    tokens_out: e.tokens_out,
    occurred_at: e.occurred_at,
  }));

  const byMod = new Map<string, ModuleRollup>();
  for (const j of runpod) {
    const key = j.module || "(unlabeled)";
    let row = byMod.get(key);
    if (!row) {
      row = { module: key, jobs: 0, execution_ms: 0, cost_micro_usd: 0, unpriced: 0 };
      byMod.set(key, row);
    }
    row.jobs += 1;
    row.execution_ms += j.execution_ms ?? 0;
    if (j.cost_micro_usd == null) row.unpriced += 1;
    else row.cost_micro_usd = (row.cost_micro_usd ?? 0) + j.cost_micro_usd;
  }
  const by_module = [...byMod.values()].map((r) => ({
    ...r,
    cost_micro_usd: r.unpriced === r.jobs ? null : r.cost_micro_usd,
  }));

  let rpCost = 0;
  let rpUnpriced = 0;
  let rpMs = 0;
  for (const j of runpod) {
    rpMs += j.execution_ms ?? 0;
    if (j.cost_micro_usd == null) rpUnpriced += 1;
    else rpCost += j.cost_micro_usd;
  }
  let llmCost = 0;
  let llmUnpriced = 0;
  for (const e of llm) {
    if (e.cost_micro_usd == null) llmUnpriced += 1;
    else llmCost += e.cost_micro_usd;
  }

  const runpodPriced = runpod.length - rpUnpriced;
  const llmPriced = llm.length - llmUnpriced;
  return {
    tenant_id: args.tenantId,
    runpod,
    llm,
    by_module,
    totals: {
      runpod_jobs: runpod.length,
      runpod_execution_ms: rpMs,
      runpod_cost_micro_usd: runpodPriced === 0 && runpod.length > 0 ? null : rpCost,
      runpod_unpriced: rpUnpriced,
      llm_requests: llm.length,
      llm_cost_micro_usd: llmPriced === 0 && llm.length > 0 ? null : llmCost,
      llm_unpriced: llmUnpriced,
      cost_micro_usd:
        rpUnpriced === runpod.length && llmUnpriced === llm.length && (runpod.length + llm.length) > 0
          ? null
          : rpCost + llmCost,
    },
  };
}

export function formatUsdFromMicro(micro: number | null): string | null {
  if (micro == null) return null;
  return (micro / MICRO_PER_USD).toFixed(6);
}
