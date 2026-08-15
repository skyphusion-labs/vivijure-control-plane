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

// cp#435: the destructive-name warning must SHIP, not merely be computable.
//
// slugVerdict returning the right string proves the decision; it does not prove the page carries
// the block that decision is meant to reveal, or the checkbox the gate reads. Both bugs tonight
// were of exactly that shape: a correct pure function next to markup that dropped its answer.
describe("the reclaim warning ships in onboarding.html (cp#435)", () => {
  // Whitespace-collapsed: the copy is wrapped across lines in the markup, and a regex that breaks
  // on a line break would be asserting the formatting rather than the sentence.
  const raw = readFileSync(join(HERE, "..", "public", "onboarding.html"), "utf8");
  const page = raw.replace(/\s+/g, " ");

  it("CONTROL: the page and its name step are really there", () => {
    expect(page.length).toBeGreaterThan(2000);
    expect(page).toContain("data-step=\"name\"");
  });

  it("carries the block and the acknowledgement the gate reads", () => {
    expect(page).toContain("id=\"slug-reclaim\"");
    expect(page).toContain("id=\"slug-reclaim-ack\"");
  });

  it("names the consequence in words, rather than hinting at it", () => {
    // A person about to lose a studio needs the verb, not a euphemism.
    expect(page).toMatch(/deletes all of that and builds a new one/i);
    expect(page).toMatch(/not recoverable/i);
    // And it must not describe the destructive path as carrying on from where they left off.
    expect(page).toMatch(/does not carry on where it left off/i);
  });
});

// cp#446 review: THE RESET IS WIRED, and both halves of that are asserted against the shipped file.
//
// The gate itself no longer depends on the reset -- consent names its studio, so a carried tick
// cannot open a different name (tests/onboarding-checks.test.ts). But the DOM reset is still what
// stops a stale TICK sitting there next to a name it no longer applies to, and ernst caught that
// nothing failed if it were deleted. These read public/onboarding.js because the function lives
// inside the page IIFE and is not importable; the house pattern for that is to assert the shipped
// bytes, exactly as the abuse-report and front-door surfaces do.
describe("the reclaim acknowledgement is revoked, and revoked in the right ORDER (cp#446)", () => {
  const js = readFileSync(join(HERE, "..", "public", "onboarding.js"), "utf8");

  it("CONTROL: the script is really there and still checks the slug", () => {
    expect(js.length).toBeGreaterThan(2000);
    expect(js).toContain("async function checkSlug()");
  });

  it("clears BOTH the recorded consent and the box itself", () => {
    const start = js.indexOf("function resetReclaimAck()");
    expect(start).toBeGreaterThan(-1);
    const body = js.slice(start, js.indexOf("async function checkSlug()", start));
    // The flag the projection reads...
    expect(body).toContain("state.slugReclaimable = false");
    // ...the consent the GATE reads, which is the one that matters...
    expect(body).toContain("state.slugReclaimConfirmedFor = null");
    // ...and the control the PERSON reads, so the screen cannot disagree with the gate.
    expect(body).toMatch(/ack\.checked = false/);
  });

  it("resets BEFORE the request, so a late answer cannot leave a stale tick standing", () => {
    const start = js.indexOf("async function checkSlug()");
    const body = js.slice(start, start + 1200);
    const reset = body.indexOf("resetReclaimAck()");
    const fetched = body.indexOf("PlatformApi.slugAvailable");
    expect(reset).toBeGreaterThan(-1);
    expect(fetched).toBeGreaterThan(-1);
    // Order is the assertion. Resetting after the await would leave the old tick on screen for the
    // whole round trip, which is exactly the window somebody clicks Continue in.
    expect(reset).toBeLessThan(fetched);
  });
});

// cp#455: the boot branch must SHIP, and the fake loading state must be GONE.
describe("onboarding boots from the account rather than always at step 1 (cp#455)", () => {
  const html = readFileSync(join(HERE, "..", "public", "onboarding.html"), "utf8");
  const js = readFileSync(join(HERE, "..", "public", "onboarding.js"), "utf8");

  it("CONTROL: both assets are really there", () => {
    expect(html).toContain("data-step=\"invoke\"");
    expect(js).toContain("function init()");
  });

  it("reads the account on boot and lands on the resumed step", () => {
    expect(js).toContain("checks.resumeStep(");
    expect(js).toContain("resumeFromAccount()");
  });

  it("recovers the tenant id a fresh load never had", () => {
    // state.tenantId had exactly ONE assignment, inside runProvision, which is why a fresh
    // arrival POSTed to /api/tenant/null/invoke-key and was told its key was rejected (cp#447).
    const start = js.indexOf("async function resumeFromAccount");
    const body = js.slice(start, start + 2200);
    expect(body).toContain("state.tenantId = tenant.id");
    expect(body).toContain("state.createdEndpoints = tenant.endpoints");
  });

  it("ships NO fake loading state for the endpoint list (cp#449)", () => {
    // A spinner-shaped word implies work in progress, so the honest reading -- this page does
    // not know your endpoints -- is the one it hid. renderCreatedEndpoints says so itself when
    // it has nothing.
    // cp#427 SUBSUMED THIS. The fix was to stop shipping a fake loading state; the purge removed
    // the endpoint list outright, because those endpoints are OURS on the shared pool and naming
    // them to a tenant is neither useful nor theirs to act on. The stronger assertion replaces the
    // weaker one rather than sitting next to it.
    expect(html).not.toContain("created-endpoints");
  });

  it("refuses to start a wizard for a studio that is not in setup", () => {
    expect(html).toContain("data-step=\"not-in-setup\"");
    expect(html).toMatch(/not in setup/i);
  });
});

// cp#439: BOTH tier branches must SHIP, not merely be computable.
//
// keyRequirement and invokeRequirement returning the right string proves the decision. It does not
// prove the page carries the controls those decisions reveal, and the whole wall was a correct
// plane next to a UI that offered no way to send the request it accepts.
describe("the BYOK surface is GONE from the wizard (cp#427)", () => {
  const raw = readFileSync(join(HERE, "..", "public", "onboarding.html"), "utf8");
  const page = raw.replace(/\s+/g, " ");
  const js = readFileSync(join(HERE, "..", "public", "onboarding.js"), "utf8");

  it("CONTROL: the wizard is really there and still has its go-live step", () => {
    expect(page).toContain("data-step=\"invoke\"");
    expect(js).toContain("function init()");
  });

  it("has no setup-key step and no capacity step", () => {
    // Removed rather than hidden. cp#427 retired the path; the capacity step additionally POSTed
    // to a route that has never existed (cp#467), and removing only the key gate would have moved
    // everybody from the first wall onto the second.
    expect(page).not.toContain("data-step=\"key\"");
    expect(page).not.toContain("data-step=\"capacity\"");
    expect(page).not.toContain("id=\"runpod-key\"");
  });

  it("asks for no key anywhere, and keeps no code to read one", () => {
    expect(page).not.toContain("id=\"invoke-key\"");
    expect(js).not.toContain("runpodKey");
    expect(js).not.toContain("state.keyPresent");
    // The dead route call goes with the step that made it.
    expect(js).not.toContain("PlatformApi.capacity(");
  });

  it("still offers the ONE action that works, and says what the other two states are", () => {
    expect(page).toContain("id=\"go-live\"");
    // ACROSS A LINE BREAK ON PURPOSE. The collapse above is the instrument, and an assertion
    // that only ever matches within one line cannot tell a working collapse from a dead one.
    // This file shipped the dead variant TWICE; the second time it was written beside its own
    // correct twin. Make the instrument fail loudly rather than trusting the character.
    expect(page).toMatch(/do not provision that way any more/i);
    expect(page).toContain("id=\"invoke-undecided\"");
    expect(page).toContain("id=\"invoke-unsupported\"");
    // And a plane that cannot provision says so up front rather than at the end.
    expect(page).toContain("id=\"no-shared-capacity\"");
  });

  it("clears the key BEFORE submitting, so the go-live POST carries none", () => {
    const start = js.indexOf("#go-live");
    const body = js.slice(start, start + 700);
    const cleared = body.indexOf("invokeKey = \"\"");
    const submitted = body.indexOf("runInvokeKeyCheck()");
    expect(cleared).toBeGreaterThan(-1);
    expect(cleared).toBeLessThan(submitted);
  });

  it("projects the plane capability and the tenant tier from the payloads", () => {
    expect(js).toContain("checks.planCanProvision(");
    expect(js).toContain("checks.invokeRequirement(");
  });
});

// cp#448: the classifier must be WIRED, and the destructive advice must be GONE.
//
// provisionFailureCopy returning the right strings proves the decision. It does not prove the
// handler uses it, and the original defect was a correct plane next to a client that dropped its
// message and offered advice pointing at a teardown.
describe("the failure screen reads the plane rather than the status (cp#448)", () => {
  const js = readFileSync(join(HERE, "..", "public", "onboarding.js"), "utf8");

  it("CONTROL: the handler is really there", () => {
    expect(js).toContain("function handleProvisionError");
  });

  it("classifies on the code, not on the status", () => {
    expect(js).toContain("checks.provisionFailureCopy(err)");
    // The exact expression that made every 409 a key problem.
    expect(js).not.toContain("err.status === 409");
  });

  it("NEVER advises re-provisioning the same name from a failure screen", () => {
    // That advice is the cp#435 teardown, and it appeared as INSTRUCTIONS in cases where
    // destruction was not the answer. Under cp#427 there is also no key left to re-paste.
    expect(js).not.toMatch(/destroys the partial environment/i);
    expect(js).not.toMatch(/paste it again to start over/i);
    expect(js).not.toMatch(/Setup needs your key again/i);
  });

  it("has no control that says Back and goes forward (cp#447)", () => {
    // A data-next button relabelled "Back to the key step" advanced BY INDEX into the render-key
    // step, past its own gate, with none of the state that step needs. The step it named no longer
    // exists either.
    // Asserted on the ASSIGNMENT, not the phrase: the comment explaining why the control was
    // removed legitimately names the old label, and a test that forbade the words would have
    // deleted the explanation to stay green.
    expect(js).not.toMatch(/textContent\s*=\s*"Back/);
    const html = readFileSync(join(HERE, "..", "public", "onboarding.html"), "utf8");
    expect(html).not.toContain("build-continue");
  });
});
