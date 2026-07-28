// cp#185 part two: one roll-up run, persisted.
//
// The claims under test are about ORDER and about the watermark, because those are the two things
// that can turn a survivable failure into a silent permanent under-count. A recording store is used
// rather than a real database so the SEQUENCE is assertable; the same paths are then re-proven
// against a real SQL engine in llm-spend-store.test.ts, because a recording double agrees with
// whatever the code did.

import { describe, it, expect } from "vitest";
import { ingestLlmSpend, type LlmSpendStore, type RollupPeriodWrite } from "../src/llm-spend-ingest";
import type { GatewayLogReader, GatewayLogRow, SpendEvent } from "../src/llm-spend-rollup";

const row = (over: Partial<GatewayLogRow> = {}): GatewayLogRow => ({
  id: "log_1",
  created_at: "2026-07-27T09:00:00.000Z",
  model: "claude-opus-4-8",
  cost: 0.000145,
  metadata: { tenant_id: "ten_abc", slug: "acme" },
  ...over,
});

function readerOf(pages: GatewayLogRow[][], total: number | null = 2, oldest: string | null = null): GatewayLogReader {
  return {
    async list({ page }) {
      return { rows: pages[page - 1] ?? [], totalCount: total };
    },
    async probe() {
      return { total, oldest };
    },
  };
}

/** Records the ORDER of every call, which is the property under test. */
function recordingStore(opts: { watermark?: string | null; lastEnd?: string | null; failOn?: string } = {}) {
  const order: string[] = [];
  const state = {
    periods: [] as RollupPeriodWrite[],
    events: [] as SpendEvent[],
    closed: [] as Array<{ id: string; rows: number; at: string }>,
    watermark: opts.watermark ?? null,
    advanced: [] as string[],
  };
  const trip = (name: string) => {
    order.push(name);
    if (opts.failOn === name) throw new Error("planted failure at " + name);
  };
  const store: LlmSpendStore = {
    async readLlmWatermark() {
      order.push("readWatermark");
      return state.watermark;
    },
    async readLastPeriodEnd() {
      order.push("readLastPeriodEnd");
      return opts.lastEnd ?? null;
    },
    async openLlmRollupPeriod(p) {
      trip("open");
      state.periods.push(p);
    },
    async writeLlmSpendEvents(_periodId, events) {
      trip("writeEvents");
      state.events.push(...events);
      return events.length;
    },
    async closeLlmRollupPeriod(id, rows, at) {
      trip("close");
      state.closed.push({ id, rows, at });
    },
    async advanceLlmWatermark(_source, lastSeenAt) {
      trip("advance");
      state.advanced.push(lastSeenAt);
      state.watermark = lastSeenAt;
    },
  };
  return { store, order, state };
}

let clock = Date.parse("2026-07-28T10:00:00.000Z");
const deps = (store: LlmSpendStore, reader: GatewayLogReader) => ({
  store,
  reader,
  now: () => clock,
  newId: () => "llmp_fixed",
});

describe("ingestLlmSpend write order", () => {
  // Die anywhere and the record must be honestly WORSE than the truth, never better. The reverse
  // order would produce the one shape we cannot tolerate: a finished period claiming a count it
  // never wrote, or a watermark past rows nobody stored.
  it("opens the period, writes events, closes it, THEN advances the watermark", async () => {
    const rec = recordingStore();
    await ingestLlmSpend(deps(rec.store, readerOf([[row()]])));
    expect(rec.order).toEqual([
      "readWatermark",
      "readLastPeriodEnd",
      "open",
      "writeEvents",
      "close",
      "advance",
    ]);
  });

  it("opens the period with finished_at unset and closes it with the TRUE written count", async () => {
    const rec = recordingStore();
    const out = await ingestLlmSpend(deps(rec.store, readerOf([[row({ id: "a" }), row({ id: "b" })]])));
    expect(rec.state.closed).toEqual([{ id: "llmp_fixed", rows: 2, at: new Date(clock).toISOString() }]);
    expect(out.eventsWritten).toBe(2);
  });

  // The count that gets recorded is what the ENGINE wrote, not what we offered it. They differ
  // exactly when INSERT OR IGNORE suppressed a duplicate, which is the NORMAL case: the gateway's
  // created_at filter is second-granular, so the whole second holding the watermark is re-read
  // every run.
  it("records the count the STORE reports, not the count it was handed", async () => {
    const rec = recordingStore();
    rec.store.writeLlmSpendEvents = async () => 1; // engine ignored one duplicate
    const out = await ingestLlmSpend(deps(rec.store, readerOf([[row({ id: "a" }), row({ id: "b" })]])));
    expect(out.eventsWritten).toBe(1);
    expect(rec.state.closed[0].rows).toBe(1);
  });

  it("crashing mid-write leaves the period OPEN and the watermark UNMOVED", async () => {
    const rec = recordingStore({ watermark: "2026-07-27T08:00:00.000Z", failOn: "writeEvents" });
    await expect(ingestLlmSpend(deps(rec.store, readerOf([[row()]])))).rejects.toThrow(/planted/);
    expect(rec.state.periods).toHaveLength(1);
    expect(rec.state.closed).toHaveLength(0);
    expect(rec.state.advanced).toEqual([]);
    expect(rec.state.watermark).toBe("2026-07-27T08:00:00.000Z");
  });
});

describe("ingestLlmSpend watermark discipline", () => {
  it("CONTROL: a good run advances the watermark to the newest row it saw", async () => {
    const rec = recordingStore();
    const out = await ingestLlmSpend(
      deps(
        rec.store,
        readerOf([[row({ id: "a", created_at: "2026-07-27T09:00:00.000Z" }), row({ id: "b", created_at: "2026-07-27T11:00:00.000Z" })]]),
      ),
    );
    expect(rec.state.advanced).toEqual(["2026-07-27T11:00:00.000Z"]);
    expect(out.watermarkAfter).toBe("2026-07-27T11:00:00.000Z");
  });

  // A gateway that does not exist answers 200/success:true/total_count:0. A run against one has read
  // nothing and proved nothing, so moving the cursor would skip whatever really was there, forever.
  it("does NOT advance when the positive control failed", async () => {
    const rec = recordingStore({ watermark: "2026-07-27T08:00:00.000Z" });
    const out = await ingestLlmSpend(deps(rec.store, readerOf([[]], 0)));
    expect(out.controlPassed).toBe(false);
    expect(rec.state.advanced).toEqual([]);
    expect(out.watermarkAfter).toBe("2026-07-27T08:00:00.000Z");
    // ...and it still RECORDS the run, so the failure is visible rather than absent.
    expect(rec.state.periods).toHaveLength(1);
    expect(rec.state.closed).toHaveLength(1);
  });

  it("does NOT advance when the probe itself threw", async () => {
    const rec = recordingStore();
    const reader: GatewayLogReader = {
      async list() {
        return { rows: [], totalCount: null };
      },
      async probe(): Promise<never> {
        throw new Error("401 unauthorized");
      },
    };
    const out = await ingestLlmSpend(deps(rec.store, reader));
    expect(out.status).toBe("failed");
    expect(rec.state.advanced).toEqual([]);
  });

  // A page-capped run is INCOMPLETE but its walk is ASCENDING, so it read a contiguous prefix and
  // the newest row it saw is a true resume point. Refusing to advance here would wedge the meter on
  // any backlog bigger than one run.
  it("DOES advance on a page-capped run, because an ascending walk read a contiguous prefix", async () => {
    const rec = recordingStore();
    const full = Array.from({ length: 50 }, (_, i) =>
      row({ id: "p" + i, created_at: "2026-07-27T09:00:" + String(i).padStart(2, "0") + ".000Z" }),
    );
    const out = await ingestLlmSpend({ ...deps(rec.store, readerOf([full, full], 500)), pageCap: 1 });
    expect(out.status).toBe("incomplete");
    expect(rec.state.advanced).toEqual(["2026-07-27T09:00:49.000Z"]);
  });
});

describe("ingestLlmSpend period windows", () => {
  // Periods TILE off the previous run's recorded instant, not off a configured interval, so the
  // cron schedule and the ledger cannot disagree about where one window ended.
  it("starts this window where the last one ended", async () => {
    const rec = recordingStore({ lastEnd: "2026-07-28T09:45:00.000Z" });
    const out = await ingestLlmSpend(deps(rec.store, readerOf([[row()]])));
    expect(out.windowStart).toBe("2026-07-28T09:45:00.000Z");
    expect(out.windowEnd).toBe(new Date(clock).toISOString());
  });

  // A first run has nothing before it, so its window is zero-width. That is honest, not degenerate:
  // no billing window predating the meter may be called complete. The backfill it ingests is still
  // attributed to it, because assignment is by the instant window_end names.
  it("writes a ZERO-WIDTH window on the very first run", async () => {
    const rec = recordingStore({ lastEnd: null });
    const out = await ingestLlmSpend(deps(rec.store, readerOf([[row()]])));
    expect(out.windowStart).toBe(out.windowEnd);
  });
});
