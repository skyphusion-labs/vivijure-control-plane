import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// THE PUBLIC ABUSE-REPORT PATH (cp#130).
//
// Enforcement here is REPORT-DRIVEN by ruling: we run no scanning, so a report from a person is the
// entire detection surface. That makes the intake path a load-bearing part of the product rather
// than a legal footnote, and it had no placement outside a markdown file in the repo and an AUP
// served behind the signup gate. The person most likely to report is a stranger who came across a
// hosted render, and a stranger cannot read either of those.
//
// These tests read the SHIPPED markup, not a copy of it, and every "the page says X" assertion is
// paired with a positive control so an empty or renamed file cannot pass by matching nothing.
const HERE = dirname(fileURLToPath(import.meta.url));
const readAsset = (name: string) => readFileSync(join(HERE, "..", "public", name), "utf8");

const ABUSE_ADDRESS = "abuse@skyphusion.org";

describe("the report-abuse page exists and carries what a reporter needs", () => {
  const page = readAsset("report-abuse.html");

  it("is not empty, which is the control every assertion below depends on", () => {
    expect(page.length).toBeGreaterThan(2000);
    expect(page).toContain("<title>");
  });

  it("names the address a report actually goes to", () => {
    expect(page).toContain(ABUSE_ADDRESS);
    expect(page).toContain(`mailto:${ABUSE_ADDRESS}`);
  });

  it("tells a CSAM reporter to go to NCMEC directly rather than waiting for us to relay", () => {
    // The relay is the slow path and we are not the only recipient who matters. Losing this line
    // would make the page technically complete and practically worse than the markdown it mirrors.
    expect(page).toContain("report.cybertip.org");
    expect(page).toMatch(/do not wait for us/i);
  });

  it("keeps the do-NOT-attach warning, verbatim in substance", () => {
    // Forwarding suspected CSAM creates a legal problem for the reporter and for us. This warning
    // is the one line on the page whose absence could actively harm the person following it.
    expect(page).toMatch(/do not attach/i);
    expect(page).toMatch(/describe it and tell us where it is/i);
  });

  it("promises ORDERING, which we control, and never LATENCY, which we do not", () => {
    // Ernst caught this in review of the first draft, and the bad line came from the source doc:
    // the page said serious reports jump the queue "at any hour". Per cp#115 there is no alerting,
    // no webhook, no on-call rota and no out-of-hours path; the mailbox is monitored when somebody
    // looks. Ordering is a real commitment. Round-the-clock latency would be a promise we cannot
    // keep, on the one page a person reaches while something urgent is happening.
    expect(page).toMatch(/jump every other queue/);
    expect(page).not.toMatch(/at any hour|24\/7|around the clock|any time of day/i);
    // And the honest consequence has to be stated, not merely omitted: if it is urgent, do not wait
    // on us. That is the same parallel-reporting advice the page gives at the top.
    expect(page).toMatch(/not a\s+24-hour desk/i);
    expect(page).toMatch(/rather than waiting on us/i);
  });

  it("says plainly what we CANNOT reach, so a report is not wasted on us", () => {
    expect(page).toMatch(/own hardware/i);
    expect(page).toMatch(/RunPod/);
  });

  it("collects nothing: no form, no script, no third-party call", () => {
    // A reporter should not have to run our JavaScript or be counted to tell us something is wrong.
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toMatch(/<form/i);
    // Only our own stylesheet and the NCMEC/INHOPE hotlines are reachable from here.
    const externalHrefs = [...page.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    expect(externalHrefs.sort()).toEqual(["https://report.cybertip.org", "https://www.inhope.org"]);
  });
});

describe("every front-door page carries the path, from every state", () => {
  // A reporter lands wherever a link took them, and the front door swaps its MAIN content per state
  // (signed out, provisioning, suspended, deleted, unknown). A link inside one of those panels
  // would exist only for readers in that state, which is why this asserts the persistent footer.
  for (const page of ["index.html", "onboarding.html"]) {
    it(`${page} links to the report-abuse page in a persistent footer`, () => {
      const html = readAsset(page);
      expect(html.length).toBeGreaterThan(1000); // control: the file was actually read
      expect(html).toContain("class=\"site-foot\"");
      expect(html).toContain("href=\"/report-abuse.html\"");
    });
  }

  it("the footer sits OUTSIDE the state-swapped main content", () => {
    // The failure this forbids: someone moves the link into <main>, where the shell hides and shows
    // panels per state, and the intake path silently disappears for the states that matter most.
    for (const page of ["index.html", "onboarding.html"]) {
      const html = readAsset(page);
      const mainEnd = html.indexOf("</main>");
      const foot = html.indexOf("class=\"site-foot\"");
      expect(mainEnd, page).toBeGreaterThan(0);
      expect(foot, page).toBeGreaterThan(mainEnd);
    }
  });
});
