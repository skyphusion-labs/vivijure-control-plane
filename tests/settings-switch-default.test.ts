import { describe, it, expect, beforeEach, vi } from "vitest";
import { handle } from "../src/index";
import { settingEnabled } from "../src/settings";
import type { ControlPlaneDeps } from "../src/deps";
import type { ControlPlaneEnv } from "../src/env";
import { MemoryStore } from "./memory-store";

// A settings-backed switch is read from a store whose getter returns `string | null`, so the UNSET
// case is a value the reader has to have an answer for. This file pins that answer: unset and
// malformed both read as DISABLED, and only a recognised affirmative enables.
//
// WHY NO TEST COVERED THIS BEFORE, which is the more useful half: `tests/memory-store.ts` seeds
// `settings` with `["signups_enabled", "true"]`, so every existing test runs with the row PRESENT.
// The unset branch was not weakly covered, it was unreachable from the fixture. A fixture that
// always seeds a setting cannot observe what happens when nobody has set it.

const ROOT_HOST = "studio.vivijure.com";
const ORIGIN = `https://${ROOT_HOST}`;
const AUP = "2026-07-17";

let store: MemoryStore;
let deps: ControlPlaneDeps;

const env = (): ControlPlaneEnv =>
  ({
    ASSETS: { fetch: async () => new Response("ui", { status: 200 }) } as unknown as Fetcher,
    CP_DB: {} as D1Database,
    AUP_VERSION: AUP,
    AUP_URL: `${ORIGIN}/aup`,
    CONTROL_PLANE_HOST: ROOT_HOST,
    CP_RATE_LIMIT: { limit: async () => ({ success: true }) },
  }) as unknown as ControlPlaneEnv;

const ctx = {
  waitUntil: () => {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

const req = (path: string) => new Request(`${ORIGIN}${path}`, { headers: { origin: ORIGIN } });

beforeEach(() => {
  store = new MemoryStore();
  deps = {
    store,
    mailer: { send: async () => {} },
    fetch: vi.fn(async () => new Response("aup")) as unknown as typeof fetch,
    now: () => 1_750_000_000_000,
  } as unknown as ControlPlaneDeps;
});

/** What `/api/platform/config` projects for the switch right now. */
async function projected(): Promise<unknown> {
  const res = await handle(req("/api/platform/config"), env(), ctx, deps);
  expect(res.status, "the config projection did not answer").toBe(200);
  return ((await res.json()) as { signups_enabled?: unknown }).signups_enabled;
}

describe("settingEnabled: only a recognised affirmative enables a switch", () => {
  // Table-driven so the negative cases sit beside the positive ones and the denominator is visible.
  const CASES: Array<{ raw: string | null | undefined; want: boolean; why: string }> = [
    { raw: "true", want: true, why: "the canonical value the writer stores" },
    { raw: "TRUE", want: true, why: "case is normalised" },
    { raw: "  true  ", want: true, why: "surrounding whitespace is trimmed" },
    { raw: "1", want: true, why: "accepted affirmative, same set as parseEnforcing" },
    { raw: "false", want: false, why: "the canonical negative" },
    { raw: "False", want: false, why: "wrong case must not read as enabled" },
    { raw: "FALSE", want: false, why: "wrong case must not read as enabled" },
    { raw: "0", want: false, why: "numeric negative" },
    { raw: "", want: false, why: "empty string is not a decision" },
    { raw: "   ", want: false, why: "whitespace is not a decision" },
    { raw: "no", want: false, why: "unrecognised value is not an affirmative" },
    { raw: "yes", want: false, why: "not in the affirmative set; only true/1 are" },
    { raw: null, want: false, why: "NEVER WRITTEN: the absence of a decision is not a decision" },
    { raw: undefined, want: false, why: "absent for any other reason reads the same as null" },
  ];

  it(`decides all ${CASES.length} cases the way the table says`, () => {
    const wrong = CASES.filter((c) => settingEnabled(c.raw) !== c.want).map(
      (c) => `${JSON.stringify(c.raw)} -> ${settingEnabled(c.raw)}, want ${c.want} (${c.why})`,
    );
    expect(wrong, `denominator ${CASES.length} cases; disagreements listed`).toEqual([]);
    // Guard against a reader that simply returns false for everything.
    expect(CASES.filter((c) => c.want).length, "the table must contain affirmative cases").toBe(4);
  });
});

describe("the projected switch when nobody has stored a value", () => {
  // POSITIVE CONTROLS FIRST. Without them, "unset reads as disabled" is equally consistent with a
  // projection that reports false unconditionally, or a route that never ran.
  it("CONTROL: an explicitly stored true projects true", async () => {
    store.settings.set("signups_enabled", "true");
    expect(await projected()).toBe(true);
  });

  it("CONTROL: an explicitly stored false projects false", async () => {
    store.settings.set("signups_enabled", "false");
    expect(await projected()).toBe(false);
  });

  // THE CLAIM. Fails against a reader that compares the stored value against a single negative
  // literal, because `null` is not that literal.
  it("an UNSET switch projects false", async () => {
    store.settings.delete("signups_enabled");
    expect(
      store.settings.has("signups_enabled"),
      "arrange failed: the fixture still holds the row, so this proves nothing",
    ).toBe(false);
    expect(await projected()).toBe(false);
  });

  it("a MALFORMED stored value projects false rather than enabling on a typo", async () => {
    const seen: Array<[string, unknown]> = [];
    for (const raw of ["False", "FALSE", "0", "", "  ", "off", "no"]) {
      store.settings.set("signups_enabled", raw);
      seen.push([raw, await projected()]);
    }
    expect(seen.filter(([, v]) => v !== false), `malformed values that enabled: ${JSON.stringify(seen)}`).toEqual([]);
  });
});
