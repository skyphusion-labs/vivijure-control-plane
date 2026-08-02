import { describe, expect, it } from "vitest";
import {
  PUBLIC_ENDPOINT_ALLOWLIST,
  buildUpstreamSubmitBody,
  callbackUrlFor,
  isAllowedEndpoint,
  isBillable,
  mintWebhookToken,
  outcomeForStatus,
  terminalFactsFromStatus,
  tokensMatch,
} from "../src/runpod-proxy";

describe("allow-list", () => {
  // POSITIVE CONTROL FIRST, then the claim. A membership test that has never been shown to return
  // true for a real member cannot be trusted when it returns false.
  it("admits a pool endpoint id supplied as data", () => {
    expect(isAllowedEndpoint("t9wcvlxh8rc5la", ["t9wcvlxh8rc5la"])).toBe(true);
  });

  it("admits every hard-coded public slug", () => {
    for (const slug of PUBLIC_ENDPOINT_ALLOWLIST) {
      expect(isAllowedEndpoint(slug, [])).toBe(true);
    }
  });

  // The count is asserted so that dropping an entry fails LOUDLY rather than shipping a cost door
  // with a missing door. The published ruling first listed six; the measured population is eight,
  // and the two that were lost (alibaba-wan, alibaba-wan-lora) fail as a refused submit, which is
  // quiet. This test is the thing that makes it not quiet.
  it("carries exactly the eight measured public endpoints", () => {
    expect(PUBLIC_ENDPOINT_ALLOWLIST).toHaveLength(8);
    expect(PUBLIC_ENDPOINT_ALLOWLIST).toContain("wan-2-6-i2v");
    expect(PUBLIC_ENDPOINT_ALLOWLIST).toContain("wan-2-2-t2v-720-lora");
    // narration-gen's slug: reachable only by a statement-level matcher upstream, since the module
    // builds its URL by concatenation. Named here so the coverage is explicit.
    expect(PUBLIC_ENDPOINT_ALLOWLIST).toContain("minimax-speech-02-hd");
  });

  it("REFUSES an endpoint in neither set", () => {
    expect(isAllowedEndpoint("some-endpoint-nobody-priced", [])).toBe(false);
    expect(isAllowedEndpoint("", [])).toBe(false);
  });

  it("refuses a pool id that belongs to a DIFFERENT tenant's pool", () => {
    expect(isAllowedEndpoint("tenant-b-endpoint", ["tenant-a-endpoint"])).toBe(false);
  });
});

describe("submit body rewrite", () => {
  it("injects the webhook", () => {
    const out = buildUpstreamSubmitBody({ input: { a: 1 } }, "https://plane/cb/tok");
    expect(out.webhook).toBe("https://plane/cb/tok");
    expect(out.input).toEqual({ a: 1 });
  });

  // A tenant must not be able to redirect our own terminal notification, nor point it at a third
  // party. Overwrite, never merge.
  it("OVERWRITES a tenant-supplied webhook rather than honouring it", () => {
    const out = buildUpstreamSubmitBody(
      { input: {}, webhook: "https://attacker.example/collect" },
      "https://plane/cb/tok",
    );
    expect(out.webhook).toBe("https://plane/cb/tok");
  });

  it("leaves policy untouched when no clamp value is configured (the seam ships UNSET)", () => {
    const out = buildUpstreamSubmitBody({ input: {} }, "https://plane/cb/tok");
    expect(out.policy).toBeUndefined();
  });

  it("clamps DOWNWARD only: a tenant may ask for less, never for more", () => {
    const lower = buildUpstreamSubmitBody({ input: {}, policy: { executionTimeout: 5_000 } }, "u", 60_000);
    expect((lower.policy as Record<string, unknown>).executionTimeout).toBe(5_000);
    const higher = buildUpstreamSubmitBody({ input: {}, policy: { executionTimeout: 999_000 } }, "u", 60_000);
    expect((higher.policy as Record<string, unknown>).executionTimeout).toBe(60_000);
  });

  it("refuses a non-object body", () => {
    expect(() => buildUpstreamSubmitBody("nope", "u")).toThrow(/JSON object/);
    expect(() => buildUpstreamSubmitBody([1, 2], "u")).toThrow(/JSON object/);
  });
});

describe("terminal facts: NULL is not zero", () => {
  // The load-bearing one. MEASURED 2026-08-02: a CANCELLED job's terminal payload carries NO
  // executionTime and NO delayTime. A zero would read as a real measurement of a job that took no
  // time and would under-count the ledger silently.
  it("stores NULL, not 0, when RunPod reports no timings (the observed CANCELLED shape)", () => {
    const facts = terminalFactsFromStatus("job-1", {
      id: "job-1",
      status: "CANCELLED",
      input: { anything: true },
      webhook: "https://plane/cb/tok",
    });
    expect(facts).toBeDefined();
    expect(facts!.outcome).toBe("cancelled");
    expect(facts!.executionMs).toBeNull();
    expect(facts!.delayMs).toBeNull();
    // The distinction the whole test exists for.
    expect(facts!.executionMs).not.toBe(0);
  });

  it("keeps a real zero distinguishable from absence", () => {
    const facts = terminalFactsFromStatus("job-2", { status: "COMPLETED", executionTime: 0, delayTime: 0 });
    expect(facts!.executionMs).toBe(0);
    expect(facts!.delayMs).toBe(0);
  });

  it("reads the observed FAILED envelope", () => {
    const facts = terminalFactsFromStatus("job-3", {
      id: "job-3",
      status: "FAILED",
      delayTime: 11904,
      executionTime: 81,
      output: { ok: false },
      error: "input needs presigned audio_url + output_url",
    });
    expect(facts!.outcome).toBe("failed");
    expect(facts!.executionMs).toBe(81);
    expect(facts!.delayMs).toBe(11904);
  });

  // NEGATIVE CONTROL: a non-terminal status must produce no terminal write at all, or a poll-time
  // read would close a row that is still open.
  it("returns undefined for non-terminal and unknown statuses", () => {
    expect(terminalFactsFromStatus("j", { status: "IN_QUEUE" })).toBeUndefined();
    expect(terminalFactsFromStatus("j", { status: "IN_PROGRESS" })).toBeUndefined();
    expect(terminalFactsFromStatus("j", { status: "SOMETHING_NEW" })).toBeUndefined();
    expect(terminalFactsFromStatus("j", {})).toBeUndefined();
    expect(terminalFactsFromStatus("j", null)).toBeUndefined();
  });
});

describe("deduct-on-success", () => {
  it("bills COMPLETED only", () => {
    expect(isBillable(outcomeForStatus("COMPLETED"))).toBe(true);
  });

  // Conrad's ruling: never deduct on failures. A cancelled job that already did the work and wrote
  // its artifact still bills nothing -- observed live upstream, and it is the correct behaviour
  // under the ruling. It must be COUNTED though, which is why it still gets a row.
  it("bills nothing on FAILED, CANCELLED or TIMED_OUT", () => {
    for (const s of ["FAILED", "CANCELLED", "TIMED_OUT"]) {
      expect(isBillable(outcomeForStatus(s))).toBe(false);
    }
  });

  it("bills nothing on a status we do not model", () => {
    expect(isBillable(outcomeForStatus("IN_QUEUE"))).toBe(false);
    expect(isBillable(undefined)).toBe(false);
  });
});

describe("webhook token", () => {
  it("mints 64 hex chars from 32 random bytes", () => {
    const t = mintWebhookToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintWebhookToken()));
    expect(seen.size).toBe(200);
  });

  it("compares equal for equal, unequal for unequal", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "ab")).toBe(false);
    expect(tokensMatch("", "")).toBe(true);
  });

  // The token is the LAST path segment so a proxy or log that truncates a query string cannot
  // silently strip the credential.
  it("puts the token in the path, not the query string", () => {
    const url = callbackUrlFor("https://plane.example/api/runpod/webhook", "deadbeef");
    expect(url).toBe("https://plane.example/api/runpod/webhook/deadbeef");
    expect(url).not.toContain("?");
  });

  it("tolerates a trailing slash on the configured base", () => {
    expect(callbackUrlFor("https://plane.example/cb/", "tok")).toBe("https://plane.example/cb/tok");
  });
});
