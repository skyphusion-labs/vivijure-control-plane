// cf#56 admin R2 usage aggregate. The decisions under test are the ones that can be SILENTLY wrong:
// a failed read counted as zero, and an "under threshold" verdict drawn from an incomplete total.

import { describe, it, expect } from "vitest";
import { buildR2UsageReport, parseThresholdBytes } from "../src/tenant-r2-usage";

const t = (id: string, slug: string, bucket: string | null) => ({ id, slug, r2_bucket_name: bucket });
const ok = (payloadBytes: number, objectCount = 1) => ({ payloadBytes, objectCount });

// A measurement is EITHER a reading or a failure. The Map must be typed as that union or TS infers
// it from the first entry and rejects the failure cases, which are the ones worth testing.
type Measurement = { payloadBytes: number; objectCount: number } | { error: string };
const mm = (entries: [string, Measurement][]): Map<string, Measurement> => new Map(entries);

describe("buildR2UsageReport", () => {
  it("totals the buckets it could read", () => {
    const r = buildR2UsageReport({
      tenants: [t("ten_1", "a", "b-a"), t("ten_2", "b", "b-b")],
      censusComplete: true,
      measurements: mm([["b-a", ok(100, 2)], ["b-b", ok(50, 3)]]),
      thresholdBytes: null,
    });
    expect(r.total_bytes).toBe(150);
    expect(r.total_objects).toBe(5);
    expect(r.buckets_read).toBe(2);
    expect(r.total_is_floor).toBe(false);
    expect(r.alert).toBe("no_threshold");
  });

  it("a FAILED read is null and unreadable, NEVER zero", () => {
    const r = buildR2UsageReport({
      tenants: [t("ten_1", "a", "b-a"), t("ten_2", "b", "b-b")],
      censusComplete: true,
      measurements: mm([["b-a", ok(100)], ["b-b", { error: "boom" }]]),
      thresholdBytes: null,
    });
    const failed = r.tenants.find((x) => x.bucket === "b-b");
    expect(failed?.payload_bytes).toBeNull();
    expect(failed?.payload_bytes).not.toBe(0);
    expect(failed?.error).toBe("boom");
    expect(r.buckets_unreadable).toBe(1);
    expect(r.total_is_floor).toBe(true);
  });

  it("a bucket MISSING from measurements is unreadable, not empty", () => {
    const r = buildR2UsageReport({
      tenants: [t("ten_1", "a", "b-a")],
      censusComplete: true,
      measurements: mm([]),
      thresholdBytes: null,
    });
    expect(r.buckets_unreadable).toBe(1);
    expect(r.tenants[0].payload_bytes).toBeNull();
    expect(r.total_is_floor).toBe(true);
  });

  // THE CORE HONESTY PROPERTY. An all-clear drawn from a floor is the defect this models away.
  it("refuses to say UNDER from a truncated census, says indeterminate", () => {
    const r = buildR2UsageReport({
      tenants: [t("ten_1", "a", "b-a")],
      censusComplete: false,
      measurements: mm([["b-a", ok(10)]]),
      thresholdBytes: 1000,
    });
    expect(r.total_bytes).toBe(10);
    expect(r.alert).toBe("indeterminate");
    expect(r.alert).not.toBe("under");
  });

  it("refuses to say UNDER when a bucket read failed", () => {
    const r = buildR2UsageReport({
      tenants: [t("ten_1", "a", "b-a"), t("ten_2", "b", "b-b")],
      censusComplete: true,
      measurements: mm([["b-a", ok(10)], ["b-b", { error: "x" }]]),
      thresholdBytes: 1000,
    });
    expect(r.alert).toBe("indeterminate");
  });

  // POSITIVE CONTROL: the same shape with nothing missing DOES reach "under", so the two
  // indeterminate assertions above are discriminating rather than passing vacuously.
  it("POSITIVE CONTROL: a complete, fully-read total does say under", () => {
    const r = buildR2UsageReport({
      tenants: [t("ten_1", "a", "b-a")],
      censusComplete: true,
      measurements: mm([["b-a", ok(10)]]),
      thresholdBytes: 1000,
    });
    expect(r.alert).toBe("under");
  });

  // A floor ABOVE the threshold is still definitely above it, so over is sound from incomplete data.
  it("says OVER from a floor, because a floor above the line is still above the line", () => {
    const r = buildR2UsageReport({
      tenants: [t("ten_1", "a", "b-a"), t("ten_2", "b", "b-b")],
      censusComplete: false,
      measurements: mm([["b-a", ok(5000)], ["b-b", { error: "x" }]]),
      thresholdBytes: 1000,
    });
    expect(r.total_is_floor).toBe(true);
    expect(r.alert).toBe("over");
  });

  it("counts tenants without a bucket instead of dropping them", () => {
    const r = buildR2UsageReport({
      tenants: [t("ten_1", "a", null), t("ten_2", "b", "b-b")],
      censusComplete: true,
      measurements: mm([["b-b", ok(1)]]),
      thresholdBytes: null,
    });
    expect(r.tenants_without_bucket).toBe(1);
    expect(r.tenants).toHaveLength(1);
  });

  it("sorts biggest first so the cause of a bill move is on line 1", () => {
    const r = buildR2UsageReport({
      tenants: [t("ten_1", "small", "b-s"), t("ten_2", "big", "b-b")],
      censusComplete: true,
      measurements: mm([["b-s", ok(1)], ["b-b", ok(999)]]),
      thresholdBytes: null,
    });
    expect(r.tenants[0].slug).toBe("big");
  });
});

describe("parseThresholdBytes", () => {
  it("parses a positive integer", () => {
    expect(parseThresholdBytes("1073741824")).toBe(1073741824);
  });
  it("unset, blank and malformed all mean NO threshold", () => {
    expect(parseThresholdBytes(undefined)).toBeNull();
    expect(parseThresholdBytes("")).toBeNull();
    expect(parseThresholdBytes("   ")).toBeNull();
    expect(parseThresholdBytes("1.5")).toBeNull();
    expect(parseThresholdBytes("10GB")).toBeNull();
    expect(parseThresholdBytes("-5")).toBeNull();
  });
  // 0 would pin the surface permanently to "over" and train the operator to ignore it.
  it("refuses 0 rather than alerting forever", () => {
    expect(parseThresholdBytes("0")).toBeNull();
  });
});
