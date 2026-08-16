// The pure credit-surface helpers (cp#194), under plain Node with no DOM.
//
// These assets are vanilla JS by deliberate choice and are not in tsc, so this suite plus
// `node --check` is the whole gate on them. The decisions tested here are the ones that can be
// silently wrong on a money surface: whether to render at all, and what a number means.

import { describe, expect, it } from "vitest";

import {
  formatUsd,
  isEmpty,
  panelState,
  projectActivity,
  projectLine,
  topUpState,
} from "../public/credits-checks.js";

const USD = (n: number) => n * 1_000_000;

describe("formatting", () => {
  it("formats integer micro-USD as USD", () => {
    expect(formatUsd(USD(10))).toBe("USD 10.00");
    expect(formatUsd(1_420_000)).toBe("USD 1.42");
    expect(formatUsd(-3_500_000)).toBe("-USD 3.50");
  });

  it("refuses to format a non-number rather than printing NaN at a tenant", () => {
    for (const bad of [undefined, null, "10", NaN, Infinity]) {
      expect(formatUsd(bad as unknown as number)).toBeNull();
    }
  });

  it("isEmpty asks the NUMBER, never the formatted string", () => {
    // A sub-cent balance formats as "USD 0.00" while being genuinely non-zero. Anything that
    // branches on "is there anything left" must not read the display, or a rounding rule for humans
    // silently becomes a business rule.
    expect(formatUsd(1_765)).toBe("USD 0.00");
    expect(isEmpty(1_765)).toBe(false);
    expect(isEmpty(0)).toBe(true);
    expect(isEmpty(-1)).toBe(true);
  });
});

describe("whether the panel renders at all", () => {
  it("renders NOTHING when credits do not apply to this studio", () => {
    // A studio we do not bill, and the whole reason the flag exists: their balance is legitimately
    // zero forever, and showing it would invent a billing relationship they never entered into.
    expect(panelState({ credits_apply: false, complete: true }).show).toBe(false);
  });

  it("renders NOTHING on a payload that does not mention the flag at all", () => {
    // An older plane, or a partial response. Absent is treated as false: a money surface does not
    // appear because a field was missing.
    expect(panelState({ complete: true }).show).toBe(false);
    expect(panelState(null).show).toBe(false);
    expect(panelState(undefined).show).toBe(false);
  });

  it("CONTROL: it DOES render when the plane says credits apply", () => {
    // Without this, every test above passes against a panel that can never render.
    expect(panelState({ credits_apply: true, complete: true })).toEqual({ show: true, reason: "ok" });
  });

  it("renders the honest-unreadable state rather than a number, when the balance is incomplete", () => {
    expect(panelState({ credits_apply: true, complete: false })).toEqual({
      show: true,
      reason: "unreadable",
    });
  });
});

describe("the top-up control has three states, not two", () => {
  it("is hidden entirely when credits do not apply", () => {
    expect(topUpState({ credits_apply: false, topup_available: true })).toBe("hidden");
  });

  it("says not-open-yet rather than offering a door that goes nowhere", () => {
    expect(topUpState({ credits_apply: true, topup_available: false })).toBe("not_open_yet");
    // Absent reads the same as false: we do not advertise a purchase door on a maybe.
    expect(topUpState({ credits_apply: true })).toBe("not_open_yet");
  });

  it("CONTROL: it offers the door when the plane says there is one", () => {
    expect(topUpState({ credits_apply: true, topup_available: true })).toBe("available");
  });
});

describe("activity lines", () => {
  it("carries the no-charge reason through, because that IS the policy being explained", () => {
    const line = projectLine({
      id: "hld_1",
      kind: "no_charge_failed",
      delta_micro_usd: 0,
      job_ref: "film_1",
      occurred_at: "2026-07-27T10:00:00.000Z",
      no_charge_reason: "this job did not complete, so you were not charged for it",
    });
    expect(line).toMatchObject({ label: "Not charged", job_ref: "film_1" });
    expect(line?.note).toContain("not charged");
  });

  it("shows NO money on a zero-delta line rather than 'USD 0.00'", () => {
    // "USD 0.00" beside a failed render reads as a charge that happened to be free, which is a
    // different claim from "we did not charge you".
    const line = projectLine({ id: "hld_1", kind: "no_charge_failed", delta_micro_usd: 0 });
    expect(line?.amount).toBeNull();
  });

  it("CONTROL: a real charge DOES show its money", () => {
    const line = projectLine({ id: "led_1", kind: "charge", delta_micro_usd: -USD(4) });
    expect(line?.amount).toBe("-USD 4.00");
    expect(line?.label).toBe("Film rendered");
  });

  it("labels an unknown kind rather than dropping the line", () => {
    // Same rule as the auth-method projection: a line we do not recognise is still a thing that
    // happened to the tenant's money, and hiding it is worse than labelling it plainly.
    const line = projectLine({ id: "x", kind: "something_new", delta_micro_usd: -1 });
    expect(line?.label).toBe("Activity");
  });

  it("survives a malformed activity list without throwing at the tenant", () => {
    expect(projectActivity({ activity: [null, 3, "x"] })).toEqual([]);
    expect(projectActivity({})).toEqual([]);
    expect(projectActivity(null)).toEqual([]);
  });
});
