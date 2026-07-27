// cp#185: the LLM spend roll-up.
//
// The assertions here are shaped by ONE proven hazard: the AI Gateway logs endpoint answers
// HTTP 200, success=true, total_count=0 for a gateway id THAT DOES NOT EXIST. So an empty read is
// indistinguishable from wrong-gateway, wrong-account, no-permission, and rows aged out. A meter
// that reports that zero as zero spend UNDER-BILLS US, not the tenant. Every test below that could
// pass against an inert implementation carries a control saying so.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { freshMigratedDb } from "./sqlite-d1";
import {
  toMicroUsd, parseLogRow, newestOccurredAt, collectSince, runRollup, MAX_PER_PAGE,
  type GatewayLogRow, type GatewayLogReader,
} from "../src/llm-spend-rollup";

const row = (over: Partial<GatewayLogRow> = {}): GatewayLogRow => ({
  id: "log_1",
  created_at: "2026-07-27T09:00:00Z",
  model: "claude-opus-4-8",
  cost: 0.000145,
  tokens_in: 9,
  tokens_out: 4,
  cached: false,
  metadata: { tenant_id: "ten_abc", slug: "acme-films" },
  ...over,
});

function readerOf(
  pages: GatewayLogRow[][],
  total: number | null = 2,
  oldest: string | null = null,
): GatewayLogReader {
  return {
    async list({ page, perPage }) {
      return { rows: pages[page - 1] ?? [], totalCount: total };
    },
    async probe() {
      return { total, oldest };
    },
  };
}

describe("toMicroUsd", () => {
  it("converts the native float cost at one fixed point", () => {
    expect(toMicroUsd(0.000145)).toBe(145);
    expect(toMicroUsd(0)).toBe(0);
    expect(toMicroUsd(1)).toBe(1_000_000);
  });

  // A NaN silently becoming 0 is an UNDER-COUNT, which is the failure this whole lane guards.
  it("REFUSES rather than coercing anything non-finite or negative", () => {
    for (const bad of [NaN, Infinity, -0.001, "0.5", null, undefined, {}]) {
      expect(toMicroUsd(bad as never), String(bad)).toBeNull();
    }
  });
});

describe("parseLogRow", () => {
  it("reads attribution OFF THE ROW", () => {
    const e = parseLogRow(row())!;
    expect(e.tenantId).toBe("ten_abc");
    expect(e.slug).toBe("acme-films");
    expect(e.costMicroUsd).toBe(145);
    expect(e.cached).toBe(0);
  });

  // The natural negative control that exists in the live gateway: a call made without the header
  // logs metadata=null. That money is real and attributable to nobody.
  it("marks a row with NO metadata as UNATTRIBUTED rather than dropping it", () => {
    const e = parseLogRow(row({ metadata: null }))!;
    expect(e).not.toBeNull();
    expect(e.tenantId).toBeNull();
    expect(e.costMicroUsd).toBe(145);
  });

  it("does NOT invent a tenant from a slug alone", () => {
    const e = parseLogRow(row({ metadata: { slug: "acme-films" } }))!;
    expect(e.tenantId).toBeNull();
    expect(e.slug).toBe("acme-films");
  });

  it("drops a row only when it cannot be KEYED (no id, no timestamp)", () => {
    expect(parseLogRow(row({ id: "" }))).toBeNull();
    expect(parseLogRow(row({ created_at: "" }))).toBeNull();
  });

  // Ruled 2026-07-27. Dropping an unpriced row is the same silent under-count as writing it as 0,
  // one layer up: the request happened and the money moved whether or not we can put a number on
  // it. Recorded, visible and unbillable beats absent.
  it("KEEPS a row with an unusable cost, with a NULL cost rather than 0 or a drop", () => {
    for (const bad of [undefined, NaN, -1, "x"]) {
      const e = parseLogRow(row({ cost: bad as never }));
      expect(e, String(bad)).not.toBeNull();
      expect(e!.costMicroUsd, String(bad)).toBeNull();
      expect(e!.costMicroUsd, String(bad)).not.toBe(0);
    }
  });

  // POSITIVE CONTROL for the above: a priced row really does carry a number, so "null" is a
  // property of the unpriced case and not of the parser always returning null.
  it("CONTROL: a priced row still yields a number", () => {
    expect(parseLogRow(row({ cost: 0.000145 }))!.costMicroUsd).toBe(145);
    expect(parseLogRow(row({ cost: 0 }))!.costMicroUsd).toBe(0);
  });
});

describe("newestOccurredAt", () => {
  it("returns the newest, not the last seen (arrival order is not time order)", () => {
    const es = [row({ id: "a", created_at: "2026-07-27T09:00:00Z" }),
                row({ id: "b", created_at: "2026-07-27T11:00:00Z" }),
                row({ id: "c", created_at: "2026-07-27T10:00:00Z" })].map((r) => parseLogRow(r)!);
    expect(newestOccurredAt(es)).toBe("2026-07-27T11:00:00Z");
  });
  it("returns null on an empty batch", () => expect(newestOccurredAt([])).toBeNull());
});

describe("collectSince", () => {
  it("stops when a short page proves exhaustion", async () => {
    const got = await collectSince(readerOf([[row({ id: "a" }), row({ id: "b" })]]), undefined, 10, 50);
    expect(got.exhausted).toBe(true);
    expect(got.events).toHaveLength(2);
  });

  it("counts unparseable rows as DROPPED rather than silently skipping them", async () => {
    const got = await collectSince(readerOf([[row({ id: "a" }), row({ id: "" })]]), undefined, 10, 50);
    expect(got.rowsSeen).toBe(2);
    expect(got.rowsDropped).toBe(1);
    expect(got.events).toHaveLength(1);
  });

  it("reports NOT exhausted when the page cap is hit", async () => {
    const full = Array.from({ length: 2 }, (_, i) => row({ id: "p" + i }));
    const got = await collectSince(readerOf([full, full, full]), undefined, 2, 2);
    expect(got.exhausted).toBe(false);
  });
});

describe("runRollup positive control", () => {
  it("passes the control and completes when the gateway reports rows", async () => {
    const r = await runRollup(readerOf([[row()]], 2), undefined);
    expect(r.controlPassed).toBe(true);
    expect(r.status).toBe("complete");
    expect(r.events).toHaveLength(1);
    expect(r.newWatermark).toBe("2026-07-27T09:00:00Z");
  });

  // THE ONE THAT MATTERS. A zero from this endpoint is not evidence of no spend.
  it("FAILS the control when the unfiltered probe reports zero, even though paging succeeded", async () => {
    const r = await runRollup(readerOf([[]], 0), undefined);
    expect(r.controlPassed).toBe(false);
    // Paging itself completed, so status is complete: the two facts are deliberately separate.
    expect(r.status).toBe("complete");
    expect(r.note).toContain("POSITIVE CONTROL FAILED");
    expect(r.note).toContain("UNBILLABLE");
  });

  it("records failed when the control itself throws", async () => {
    const reader: GatewayLogReader = {
      async list() { return { rows: [], totalCount: null }; },
      async probe(): Promise<never> { throw new Error("401 unauthorized"); },
    };
    const r = await runRollup(reader, undefined);
    expect(r.status).toBe("failed");
    expect(r.controlPassed).toBe(false);
    expect(r.note).toContain("401");
  });

  it("says PARTIAL out loud when the page cap truncates the window", async () => {
    const full = Array.from({ length: MAX_PER_PAGE }, (_, i) => row({ id: "x" + i }));
    const r = await runRollup(readerOf([full, full, full], 500), undefined, 2);
    expect(r.status).toBe("incomplete");
    expect(r.note).toContain("PARTIAL");
  });

  // HAVE NOT FINISHED READING versus THE ROWS ARE GONE. Retention is count-based, so a roll-up
  // that stops for long enough loses rows permanently; that is not resumable and wants a different
  // operator response from a page cap.
  it("detects a retention GAP and refuses to call the window complete", async () => {
    const r = await runRollup(
      readerOf([[row()]], 5, "2026-07-27T12:00:00Z"),
      "2026-07-27T09:00:00Z",
    );
    expect(r.gapDetected).toBe(true);
    expect(r.status).toBe("incomplete");
    expect(r.note).toContain("GAP");
    expect(r.note).toContain("deleted UNREAD");
  });

  // CONTROL: the gap flag is not simply always on. A first run has no watermark, so no gap.
  it("CONTROL: reports no gap when the oldest row predates the watermark, and none on a first run", async () => {
    const withHistory = await runRollup(
      readerOf([[row()]], 5, "2026-07-27T06:00:00Z"),
      "2026-07-27T09:00:00Z",
    );
    expect(withHistory.gapDetected).toBe(false);
    expect(withHistory.status).toBe("complete");

    const firstRun = await runRollup(readerOf([[row()]], 5, "2026-07-27T12:00:00Z"), undefined);
    expect(firstRun.gapDetected).toBe(false);
  });

  it("names unpriced rows so a NULL cost is visible rather than inferred", async () => {
    const r = await runRollup(readerOf([[row({ cost: undefined })]]), undefined);
    expect(r.note).toContain("NULL cost");
    expect(r.events[0].costMicroUsd).toBeNull();
  });

  it("counts and names unattributed rows", async () => {
    const r = await runRollup(readerOf([[row({ id: "a" }), row({ id: "b", metadata: null })]]), undefined);
    expect(r.note).toContain("UNATTRIBUTED");
    expect(r.events.filter((e) => e.tenantId === null)).toHaveLength(1);
  });
});

// The idempotency property lives in the SCHEMA, so it is proven against a real engine rather than
// against a mock that would agree with whatever the code did.
describe("idempotency against real SQLite", () => {
  const insert = (db: DatabaseSync, id: string) =>
    db.prepare(
      "INSERT OR IGNORE INTO llm_spend_events " +
        "(source,source_id,tenant_id,slug,model,cost_micro_usd,occurred_at,inserted_at,period_id) " +
        "VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("ai_gateway", id, "ten_abc", "acme", "claude-opus-4-8", 145,
          "2026-07-27T09:00:00Z", "2026-07-27T09:05:00Z", "p1");

  const seedPeriod = (db: DatabaseSync) =>
    db.prepare(
      "INSERT INTO llm_rollup_periods (id,window_start,window_end,status,control_passed,rows_ingested,started_at) " +
        "VALUES (?,?,?,?,?,?,?)",
    ).run("p1", "2026-07-27T09:00:00Z", "2026-07-27T10:00:00Z", "complete", 1, 1, "2026-07-27T09:00:00Z");

  const count = (db: DatabaseSync) =>
    (db.prepare("SELECT COUNT(*) AS n FROM llm_spend_events").get() as { n: number }).n;

  it("a re-run over an already-written window writes nothing new", () => {
    const db = freshMigratedDb();
    seedPeriod(db);
    insert(db, "log_1");
    // POSITIVE CONTROL: the insert path genuinely works, so the no-op below is idempotency and not
    // a broken statement quietly writing nothing.
    expect(count(db)).toBe(1);
    insert(db, "log_1");
    insert(db, "log_1");
    expect(count(db)).toBe(1);
    // ...and a genuinely new id still lands, so the constraint is not simply rejecting everything.
    insert(db, "log_2");
    expect(count(db)).toBe(2);
  });

  it("CONTROL: the CHECK constraints actually reject bad data", () => {
    const db = freshMigratedDb();
    seedPeriod(db);
    expect(() =>
      db.prepare(
        "INSERT INTO llm_spend_events (source,source_id,cost_micro_usd,occurred_at,inserted_at,period_id) " +
          "VALUES (?,?,?,?,?,?)",
      ).run("ai_gateway", "neg", -1, "t", "t", "p1"),
    ).toThrow();
  });
});
