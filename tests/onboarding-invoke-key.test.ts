import { afterEach, describe, expect, it, vi } from "vitest";

import { invokeKeyVerdict } from "../public/onboarding-checks.js";
import {
  LIVE_PROVEN,
  LIVE_UNVERIFIED,
  MESSAGE_MUST_SAY,
  MODULES_NOT_READY,
  NOT_PROVISIONED,
  REJECTED,
  UNCONFIRMED,
} from "./invoke-key-shapes";

// WHAT THE CUSTOMER IS TOLD after pasting their render key (control-plane#20,
// client side). These exist because their absence shipped a defect that told a
// customer whose studio had JUST GONE LIVE: "That key was not accepted, and we
// have not stored it." Every assertion below is on the STRING a stranger reads,
// not on an internal.
//
// The fixtures are imported, never hand-written here. routes.test.ts asserts
// the route actually serves these same shapes with an exact key-set check, so a
// server-side change cannot leave this suite green against a fiction. That
// coupling IS the test; without it these are just my assumptions, restated.

describe("invoke-key: 200, live and fully proven", () => {
  const v = invokeKeyVerdict(200, LIVE_PROVEN);

  it("tells the customer they are LIVE, and opens the gate", () => {
    expect(v.live).toBe(true);
    expect(v.ok).toBe(true);
    expect(v.message).toMatch(/live/i);
    expect(v.tone).toBe("good");
  });

  it("NEVER says the key was refused -- the defect this fix exists for", () => {
    const shown = [v.message, ...v.notes, ...v.failures].join(" ");
    expect(shown).not.toMatch(/not accepted/i);
    expect(shown).not.toMatch(/have not stored/i);
    expect(v.failures).toEqual([]);
  });

  it("keeps the key: nothing was refused", () => {
    expect(v.clearKey).toBe(false);
    expect(v.keyStored).toBe(true);
  });
});

describe("invoke-key: 200, LIVE BUT NOT PROVEN (the subtle one)", () => {
  const v = invokeKeyVerdict(200, LIVE_UNVERIFIED);

  it("is a success and the tenant IS live", () => {
    expect(v.live).toBe(true);
    expect(v.ok).toBe(true);
    expect(v.message).toMatch(/live/i);
  });

  it("does NOT read as an unqualified success, and NAMES the unproven modules", () => {
    // 200 means LIVE. modules_ready means PROVEN. Flattening the two is exactly
    // what the removed ok field did, and what cf#114 closed. If this assertion
    // is ever relaxed, that swallow is back.
    expect(v.tone).not.toBe("good");
    expect(v.tone).toBe("warn");
    const shown = [v.message, ...v.notes].join(" ");
    expect(shown).toMatch(/could not confirm/i);
    expect(shown).toContain("lipsync");
    expect(shown).toContain("audio-upscale");
    // The tripwire. This assertion already read correctly and still passed while the
    // page rendered "([object Object], [object Object])" -- because the FIXTURE carried
    // strings and the route emits objects, so "lipsync" was present for the wrong reason.
    // Stringified objects reaching a customer is the failure; name it explicitly so a
    // future shape change cannot make this test pass vacuously again.
    expect(shown).not.toContain("[object Object]");
  });

  it("does not blame the customer or their key for an old module image", () => {
    const shown = [v.message, ...v.notes].join(" ");
    expect(shown).not.toMatch(/not accepted/i);
    expect(v.clearKey).toBe(false);
  });
});

describe("invoke-key: 202, installed but unconfirmed", () => {
  const v = invokeKeyVerdict(202, UNCONFIRMED);

  it("is NOT painted as a failure", () => {
    expect(v.tone).toBe("pending");
    expect(v.tone).not.toBe("bad");
    expect(v.pending).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it("shows the SERVER message verbatim rather than inventing a second copy", () => {
    // The server knows how many times it probed and for how long. A parallel
    // client-side wording of this drifts from it the moment either changes.
    expect(v.message).toBe(UNCONFIRMED.message);
    MESSAGE_MUST_SAY.forEach((claim) => expect(v.message).toMatch(claim));
  });

  it("KEEPS the key in the field -- the contradiction this fix removes", () => {
    // The old client cleared the input on every non-success, so it wiped the
    // key out from under a message reading "Do not re-paste your key", causing
    // the exact re-paste that copy exists to prevent.
    expect(v.clearKey).toBe(false);
    expect(v.keyStored).toBe(true);
  });

  it("does NOT open the gate: unconfirmed is not live", () => {
    expect(v.live).toBe(false);
    expect(v.ok).toBe(false);
  });
});

describe("invoke-key: real failures still carry a real diagnostic", () => {
  it("400 invoke_key_rejected shows the reason copy AND clears the refused key", () => {
    const v = invokeKeyVerdict(400, REJECTED);
    expect(v.tone).toBe("bad");
    expect(v.live).toBe(false);
    // graphql_capable has dedicated copy; the customer is told what to change.
    expect(v.message).toMatch(/account access/i);
    expect(v.failures.length).toBeGreaterThan(0);
    // A refused key is the ONE case we blank the field.
    expect(v.clearKey).toBe(true);
    expect(v.keyStored).toBe(false);
  });

  it("503 modules_not_ready surfaces the REAL diagnostic, never a blank refusal", () => {
    // DELIBERATE branch, not a fallthrough: this response carries {step, message}
    // and the customer must see which module and why. cp#17 exists because this
    // once reached a customer as a bare internal_error.
    const v = invokeKeyVerdict(503, MODULES_NOT_READY);
    expect(v.tone).toBe("bad");
    expect(v.message).toContain("ten-abc123-keyframe");
    expect(v.message).toContain("not retryable");
    // NOT the customer key at fault, so the field is not blanked.
    expect(v.clearKey).toBe(false);
  });

  it("409 not_provisioned explains itself and keeps the key", () => {
    const v = invokeKeyVerdict(409, NOT_PROVISIONED);
    expect(v.message).toMatch(/not fully provisioned/i);
    expect(v.clearKey).toBe(false);
  });

  it("an unknown failure NEVER invents a friendly lie", () => {
    const v = invokeKeyVerdict(500, { error: "internal_error" });
    expect(v.ok).toBe(false);
    expect(v.live).toBe(false);
    expect(v.message.length).toBeGreaterThan(0);
    expect(v.message).not.toMatch(/live/i);
    expect(v.message).not.toMatch(/success/i);
  });

  it("a body-less response still produces something honest to show", () => {
    const v = invokeKeyVerdict(502, null);
    expect(v.ok).toBe(false);
    expect(v.message.length).toBeGreaterThan(0);
    expect(v.failures.length).toBeGreaterThan(0);
  });
});

// CONTROL: proves the assertions above can actually FAIL. A suite that cannot
// go red is decoration. This drives the OLD, defective logic through the same
// go-live response and asserts it produces the lie we shipped -- so if someone
// reintroduces a 204-style success branch, the difference is visible here.
describe("CONTROL: the defect this replaced", () => {
  it("the old 204-contract client turned a LIVE studio into a blank refusal", () => {
    const oldClient = (status: number, body: Record<string, unknown>) => {
      if (status === 204) return { ok: true, installed: true, message: "" };
      return {
        ok: false,
        installed: false,
        message: (body.message as string) || "That key was not accepted, and we have not stored it.",
      };
    };
    const old = oldClient(200, LIVE_PROVEN);
    expect(old.installed).toBe(false);
    expect(old.message).toMatch(/not accepted/i);

    // The fixed client, same response, opposite (and true) answer.
    const fixed = invokeKeyVerdict(200, LIVE_PROVEN);
    expect(fixed.live).toBe(true);
    expect(fixed.message).not.toMatch(/not accepted/i);
  });
});

// The TRANSPORT seam. invokeKey() in onboarding.js is an IIFE and cannot be
// imported, so this reimplements its three lines against a stubbed fetch to
// prove the request shape and the status-plus-body handoff. It is a MIRROR, not
// the shipped function: see the coverage note in the PR. What it genuinely
// catches is a response the client cannot parse at all.
describe("invoke-key transport: status and body reach the verdict intact", () => {
  afterEach(() => vi.unstubAllGlobals());

  const transport = async (tenantId: string, key: string) => {
    const r = await fetch("https://cp.example/api/tenant/" + encodeURIComponent(tenantId) + "/invoke-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runpod_invoke_key: key }),
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: r.status, body };
  };

  it("POSTs the key under the name the route reads, and hands 202 through unflattened", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(UNCONFIRMED), { status: 202 }));
    vi.stubGlobal("fetch", spy);

    const res = await transport("ten_abc123", "rpa_secret");
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/tenant/ten_abc123/invoke-key");
    expect(init.method).toBe("POST");
    // The route reads body.runpod_invoke_key; any other name is a silent 400.
    expect(JSON.parse(String(init.body))).toEqual({ runpod_invoke_key: "rpa_secret" });

    expect(res.status).toBe(202);
    const v = invokeKeyVerdict(res.status, res.body);
    expect(v.pending).toBe(true);
    expect(v.clearKey).toBe(false);
  });

  it("a non-JSON body degrades to an honest failure, not a crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })));
    const res = await transport("ten_abc123", "rpa_secret");
    const v = invokeKeyVerdict(res.status, res.body);
    expect(v.ok).toBe(false);
    expect(v.message.length).toBeGreaterThan(0);
  });
});
