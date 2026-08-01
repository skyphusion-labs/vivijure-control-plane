// LIVE verification of the RunPod port (#54) against the SCRATCH account. Opt-in:
//
//   RUNPOD_API_KEY=<key> RUNPOD_LIVE=1 npx vitest run tests/runpod.live.test.ts
//
// This repo is PUBLIC, so the env contract is named here and the place the credential is kept is
// not. Operators know where their own credentials live; a public file naming the path tells
// everyone else.
//
// WHY: runpod.test.ts fakes RunPod, so it proves the plan and the quota PARSER and nothing about
// whether RunPod actually says what I think it says. The quota sentence in particular is the ONLY
// source of the account's real quota (not queryable; introspection disabled), so a parser that
// works against my own fixture and not against RunPod would be worthless in exactly the way that
// matters.
//
// SAFETY, in this order and non-negotiable:
//   1. ACCOUNT-IDENTITY GUARD runs FIRST and every other test is skipped unless it passes. Creating
//      anything on prod from this lane is the one unrecoverable mistake available here.
//   2. Everything is named vivijure-livetest-* and torn down in afterAll.
//   3. ZERO GPU spend: template + endpoint creation is free, and nothing is ever invoked.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { PROVISION_PLAN, RunPodClient, preflightQuota, parseQuotaError, templateEnv } from "../src/runpod";
import { imageRef } from "../src/satellite-pins";

declare const process: { env: Record<string, string | undefined> };

const KEY = process.env.RUNPOD_API_KEY;
const LIVE = Boolean(KEY && process.env.RUNPOD_LIVE);

/** The prod endpoint id. If this is ever visible, we are pointed at the wrong account: abort. */
const PROD_TELL = "t9wcvlxh8rc5la";

const stamp = `vivijure-livetest-${Date.now().toString(36)}`;
const client = LIVE ? new RunPodClient(KEY!) : (null as unknown as RunPodClient);
const made: { templates: string[]; endpoints: string[] } = { templates: [], endpoints: [] };
let scratchConfirmed = false;

beforeAll(async () => {
  if (!LIVE) return;
  const endpoints = await client.listEndpoints();
  scratchConfirmed = !endpoints.some((e) => e.id === PROD_TELL);
});

afterAll(async () => {
  if (!LIVE) return;
  for (const id of made.endpoints) {
    try {
      await client.deleteEndpoint(id);
    } catch (e) {
      console.warn(`LEFTOVER endpoint ${id}: ${String(e).slice(0, 120)}`);
    }
  }
  for (const id of made.templates) {
    try {
      await client.deleteTemplate(id);
    } catch (e) {
      console.warn(`LEFTOVER template ${id}: ${String(e).slice(0, 120)}`);
    }
  }
});

describe.skipIf(!LIVE)("RunPod port against the real API (scratch account)", () => {
  it("GUARD: this key reaches the SCRATCH account, not prod", async () => {
    const endpoints = await client.listEndpoints();
    expect(endpoints.map((e) => e.id), "PROD TELL PRESENT -- wrong account").not.toContain(PROD_TELL);
    expect(scratchConfirmed).toBe(true);
  });

  it("reads the account's REAL worker quota out of RunPod's own refusal", async () => {
    // The claim the whole preflight rests on: the refusal text is deterministic and parseable, and
    // the published balance table is stale. A $50 account reading quota 10 is the #60 finding.
    if (!scratchConfirmed) throw new Error("guard failed; refusing to probe");
    const reading = await preflightQuota(client);
    console.log(`  live quota reading: quota=${reading.quota} atMost=${reading.atMost} fits=${reading.fits}`);
    expect(reading.quota, `RunPod's sentence changed: ${reading.raw}`).toBeGreaterThan(0);
    expect(reading.fits).toBe(true);
  });

  it("the quota parser matches what RunPod ACTUALLY says today, not my fixture", async () => {
    if (!scratchConfirmed) throw new Error("guard failed; refusing to probe");
    const reading = await preflightQuota(client);
    expect(reading.raw).toBeTruthy();
    // Re-parse RunPod's live sentence through the same parser the fixture exercises.
    expect(parseQuotaError(reading.raw!).quota).toBe(reading.quota);
  });

  it("creates a template + a scale-to-zero endpoint with max_workers PINNED ($0: never invoked)", async () => {
    if (!scratchConfirmed) throw new Error("guard failed; refusing to create");
    const spec = PROVISION_PLAN.find((p) => p.key === "upscale")!;
    const name = `${stamp}-upscale`;

    const tpl = await client.createTemplate(
      name,
      // The SAME call production provisions with (cp#126): a literal here would let the live gate
      // pass while the plane creates tenants on a different image.
      imageRef(spec.key),
      templateEnv(spec.key, {
        endpoint: "https://example.r2.cloudflarestorage.com",
        accessKeyId: "livetest-not-a-real-key",
        secretAccessKey: "livetest-not-a-real-secret",
        bucket: "livetest",
      }),
    );
    made.templates.push(tpl.id);
    expect(tpl.id).toBeTruthy();

    // Ask RunPod what it STORED. Our own create payload is not evidence about the pinned image.
    const readBack = await client.getTemplate(tpl.id);
    expect(readBack.imageName, "template did not land on the pinned image").toBe(imageRef(spec.key));
    console.log(`  template pin as RunPod holds it: ${readBack.imageName}`);

    const ep = await client.createEndpoint({
      name,
      templateId: tpl.id,
      gpuTypeIds: spec.gpuTypeIds,
      workersMax: spec.maxWorkers,
    });
    made.endpoints.push(ep.id);
    expect(ep.id).toBeTruthy();
  });

  it("the created endpoint really is scale-to-zero with the workers we pinned", async () => {
    // Ask RunPod what it BUILT rather than trusting our own create payload.
    const endpoints = await client.listEndpoints();
    const mine = endpoints.find((e) => e.id === made.endpoints[0]);
    expect(mine, "endpoint missing right after create").toBeTruthy();
    expect(mine!.workersMax).toBe(PROVISION_PLAN.find((p) => p.key === "upscale")!.maxWorkers);
  });

  it("reports the endpoint's configured capacity (REST has NO worker list -- verified, not assumed)", async () => {
    // The teardown-verification ask was "list WORKERS, not just endpoints". REST cannot:
    // GET /v1/endpoints/{id}/workers 400s with "that path ... does not exist in the specification",
    // and the detail carries only the configured numbers. So this asserts what REST can honestly
    // answer -- capacity, i.e. "can this scale up and spend?" -- and the real worker list needs the
    // legacy GraphQL API. Said plainly rather than asserted against a path that does not exist.
    const detail = await client.getEndpoint(made.endpoints[0]);
    console.log(`  configured: workersMin=${detail.workersMin} workersMax=${detail.workersMax}`);
    expect(detail.workersMin).toBe(0); // scale-to-zero: idle costs nothing
    expect(detail.workersMax).toBe(PROVISION_PLAN.find((p) => p.key === "upscale")!.maxWorkers);
  });
});
