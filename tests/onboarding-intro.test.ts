import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  REPRESENTATIVE_PLAN,
  costCeilingUsd,
  formatUsd,
  planWorkerTotal,
} from "../public/onboarding-checks.js";

// THE SIGNED-OUT INTRO must never 401 (cp, follow-on to the demo-surface walk).
//
// The bug: onboarding.js fetched /api/tenant/provision-plan at load to fill the
// intro. That route needs a session, so a signed-out visitor -- every first
// visitor, and every visitor at all while signups are off -- got a 401 painted
// RED into the plan box and a cost line stuck forever on "loading a real
// example". The landing page of the hosted product looked broken to exactly the
// audience it exists to win.
//
// The fix: the intro renders a clearly-labelled REPRESENTATIVE example
// synchronously, with no network call; the real numbers for the account are
// fetched later, behind the sign-in, for the Review step.
//
// WHY THIS IS A DATA + SOURCE TEST, NOT A jsdom RENDER TEST. onboarding.js is an
// IIFE of DOM code and the repo has no jsdom harness (that gap is tracked in
// #29). So the render itself is not asserted here. Instead this proves the two
// things that MAKE the render safe: (1) the representative data exists and
// resolves to real, non-empty content, so nothing can render blank or stuck;
// and (2) the intro path renders it WITHOUT a plan fetch, so nothing can 401.
// Together those are the failure mode, closed from both ends.

const HERE = dirname(fileURLToPath(import.meta.url));
const readAsset = (name: string) => readFileSync(join(HERE, "..", "public", name), "utf8");

// The slice of onboarding.js that runs on page load. init() is the last function
// before the DOMContentLoaded wiring, so it bounds cleanly.
function initBody(src: string): string {
  const start = src.indexOf("function init()");
  const end = src.indexOf("if (document.readyState", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function fnBody(src: string, decl: string): string {
  const start = src.indexOf(decl);
  expect(start).toBeGreaterThan(-1);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces after " + decl);
}

describe("intro: there is a representative example to render with no fetch", () => {
  it("REPRESENTATIVE_PLAN carries the four product endpoints", () => {
    expect(Array.isArray(REPRESENTATIVE_PLAN.endpoints)).toBe(true);
    expect(REPRESENTATIVE_PLAN.endpoints.length).toBe(4);
  });

  it("every representative row has the fields the plan renderer reads, so no row is blank", () => {
    // renderPlan reads label/key, gpu, max_workers, purpose. A row missing these
    // would render empty -- the same "looks broken" outcome by another route.
    REPRESENTATIVE_PLAN.endpoints.forEach((ep) => {
      expect(typeof (ep.label || ep.key)).toBe("string");
      expect((ep.label || ep.key).length).toBeGreaterThan(0);
      expect(typeof ep.purpose).toBe("string");
      expect(ep.purpose.length).toBeGreaterThan(0);
      expect(typeof ep.max_workers).toBe("number");
      expect(typeof ep.gpu).toBe("string");
    });
  });

  it("the representative worker total is real, so the intro is never an empty plan", () => {
    expect(planWorkerTotal(REPRESENTATIVE_PLAN.endpoints)).toBeGreaterThan(0);
  });
});

describe("intro: the cost line resolves to a real dollar amount, never a stuck spinner", () => {
  const ex = REPRESENTATIVE_PLAN.cost_example;

  it("has the fields the cost sentence needs", () => {
    expect(typeof ex.wall_clock_ms).toBe("number");
    expect(typeof ex.gpu_hourly_usd).toBe("number");
    expect(typeof ex.description).toBe("string");
    expect(typeof ex.gpu_label).toBe("string");
    expect(typeof ex.rendered_on).toBe("string");
  });

  it("costCeilingUsd + formatUsd produce a non-empty dollar amount", () => {
    // renderCostExample blanks the line when formatUsd returns falsy. If that
    // happened the customer would see an EMPTY cost callout -- another silent
    // "looks broken". A real number here means the line always has content.
    const ceiling = costCeilingUsd(ex.wall_clock_ms, ex.gpu_hourly_usd);
    expect(typeof ceiling).toBe("number");
    expect(ceiling as number).toBeGreaterThan(0);
    const money = formatUsd(ceiling);
    expect(money).toBeTruthy();
    expect(String(money).startsWith("$")).toBe(true);
  });
});

describe("intro: the page-load path renders the representative example and does NOT fetch the plan", () => {
  const src = readAsset("onboarding.js");

  it("init() renders the representative example", () => {
    expect(initBody(src)).toContain("renderRepresentativePlan()");
  });

  it("init() does NOT load the plan on the intro -- that is the 401 this fix removes", () => {
    const body = initBody(src);
    expect(body).not.toContain("loadPlan(");
    expect(body).not.toContain("PlatformApi.plan(");
  });

  it("renderRepresentativePlan itself makes no network call", () => {
    const body = fnBody(src, "function renderRepresentativePlan()");
    expect(body).not.toContain("PlatformApi.");
    expect(body).not.toContain("await");
    expect(body).toContain("REPRESENTATIVE_PLAN");
  });

  it("the real plan is fetched only once the flow LEAVES the intro", () => {
    expect(src).toContain("async function loadPlan()");
    expect(src).toMatch(/from === "what"[^\n]*loadPlan\(\)/);
  });

  it("CONTROL: the init scan can actually fail", () => {
    const fetchingInit = "function init() {\n  loadPlan();\n}\n";
    expect(fetchingInit).toContain("loadPlan(");
  });
});

describe("intro: the placeholders are not spinners", () => {
  const html = readAsset("onboarding.html");

  it("the old loading text is gone", () => {
    expect(html).not.toContain("loading a real example");
    expect(html).not.toMatch(/id="plan-preview"[^>]*>loading/);
  });

  it("the intro labels the example as representative", () => {
    expect(html).toContain("representative example");
  });

  it("CONTROL: the loading-text scan can fail", () => {
    expect("<p>loading a real example...</p>").toContain("loading a real example");
  });
});
