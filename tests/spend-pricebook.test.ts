import { describe, expect, it } from "vitest";
import { parseSpendPricebook, priceRunpodJob } from "../src/spend-pricebook";
import { assembleTenantUsage } from "../src/tenant-usage";

describe("parseSpendPricebook", () => {
  it("empty is unpriced, never a baked rate", () => {
    const b = parseSpendPricebook(undefined);
    expect(b.default_usd_per_second).toBeNull();
    expect(b.endpoints).toEqual({});
  });
  it("reads endpoints and default from JSON", () => {
    const b = parseSpendPricebook(
      JSON.stringify({
        default_usd_per_second: 0.001765,
        endpoints: { zqb7tougbqfkqa: { usd_per_second: 0.001881 }, "kling-v2-1-i2v-pro": { usd_per_job: 0.08 } },
      }),
    );
    expect(b.default_usd_per_second).toBe(0.001765);
    expect(b.endpoints["kling-v2-1-i2v-pro"]?.usd_per_job).toBe(0.08);
  });
});

describe("priceRunpodJob", () => {
  const book = parseSpendPricebook(
    JSON.stringify({
      default_usd_per_second: 0.001,
      endpoints: { slug: { usd_per_job: 0.5 } },
    }),
  );
  it("null ms is unknown, not zero", () => {
    const p = priceRunpodJob(book, { endpointId: "t9", outcome: "COMPLETED", executionMs: null });
    expect(p.cost_micro_usd).toBeNull();
    expect(p.priced_as).toBe("unpriced_no_ms");
  });
  it("per-second from default", () => {
    const p = priceRunpodJob(book, { endpointId: "t9", outcome: "COMPLETED", executionMs: 2000 });
    expect(p.cost_micro_usd).toBe(2000);
  });
  it("per-job slug; failed is free", () => {
    expect(priceRunpodJob(book, { endpointId: "slug", outcome: "COMPLETED", executionMs: 1 }).cost_micro_usd).toBe(500000);
    expect(priceRunpodJob(book, { endpointId: "slug", outcome: "FAILED", executionMs: 1 }).cost_micro_usd).toBe(0);
  });
});

describe("assembleTenantUsage", () => {
  it("rolls up gpu jobs and llm rows", () => {
    const book = parseSpendPricebook(JSON.stringify({ default_usd_per_second: 0.001 }));
    const u = assembleTenantUsage({
      tenantId: "ten_abc",
      book,
      jobs: [
        {
          job_id: "j1",
          tenant_slug: "conrad",
          module: "kling",
          endpoint_id: "kling-v2-1-i2v-pro",
          outcome: "COMPLETED",
          status_raw: "COMPLETED",
          execution_ms: 1000,
          delay_ms: 0,
          submitted_at: 1,
          terminal_at: 2,
          source: "proxy",
        },
      ],
      llm: [
        {
          source_id: "gw1",
          model: "opus",
          cost_micro_usd: 100,
          tokens_in: 10,
          tokens_out: 20,
          occurred_at: "2026-08-16T00:00:00Z",
        },
      ],
    });
    expect(u.totals.runpod_jobs).toBe(1);
    expect(u.totals.llm_requests).toBe(1);
    expect(u.by_module[0].module).toBe("kling");
    expect(u.totals.llm_cost_micro_usd).toBe(100);
  });
});
