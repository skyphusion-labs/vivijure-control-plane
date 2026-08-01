// THE COMMITTED PRE-DEPLOY SMOKE (cp#255). Run it before every prod deployment, every time.
//
//   CF_PROVISIONER_TOKEN=<token> CF_ACCOUNT_ID=<id> STUDIO_RELEASE=<pinned tag> \
//     PRE_DEPLOY_SMOKE_WORKERS_DEV_SUBDOMAIN=<account>.workers.dev \
//     PRE_DEPLOY_SMOKE=1 SMOKE_REQUIRED=1 npm run smoke:predeploy
//
// This repo is PUBLIC, so the env contract is named here and the place the credential is kept is
// not. Operators know where their own credentials live; a public file naming the path tells
// everyone else.
//
// WHAT IT ASSERTS: that a tenant module upload performed by THIS TREE'S code results in TELEMETRY_DB
// actually RESOLVED in the RUNNING worker, as reported by the version the edge serves. Not that the
// API accepted a binding; that the worker can see it.
//
// WHY A LIVE SUITE AND NOT A UNIT TEST. tests/module-telemetry-binding.test.ts already proves the
// uploader ASKS for the binding, which is the decision path. It cannot prove the platform HONOURED
// the ask, and the two are different claims: the first cp#248 attempt failed on
// "binding TELEMETRY_DB of type d1 failed to generate" with a request that was, by every unit test
// in this repo, perfectly correct. A stubbed input encodes our own assumption; only the real box
// says whether the binding generated.
//
// THE POSITIVE AND THE NEGATIVE ARE BOTH REQUIRED, and this is the difference between this suite and
// the v1.20.0 scratch run it replaces. That run compared two CODE TREES (v1.19.0 uploads, reads
// false; main uploads, reads true), which was the right evidence for that one change and is the
// wrong shape for a standing gate, because next release there is no interesting older tree to
// compare against. A standing gate needs a control it can watch FAIL in the same run:
//
//   POSITIVE  the catalog uploaded by this tree      -> every recording module settles job_log TRUE
//   NEGATIVE  ONE module re-uploaded WITHOUT the D1  -> that module settles job_log FALSE
//   CONTROL   uploadTenantModules with a null D1 id  -> REFUSES, writing nothing
//
// Without the negative, a green proves only that something answered true, which a hardcoded `true`
// in a module bundle would also produce.
//
// READS CONVERGE, EVERY READ IS PRINTED, AND THE TWO LEGS USE DIFFERENT CRITERIA. cp#254 is why a
// read taken soon after a version REPLACES another can be answered by an isolate still serving the
// previous version, so a single shot is a coin toss that reports as a measurement.
//
// THE FIRST VERSION OF THIS FILE GOT THE SECOND HALF WRONG, and it was caught in use rather than in
// review. Both legs polled until `need` consecutive identical readings. That proves STABILITY, and
// A STALE ISOLATE IS PERFECTLY STABLE. Measured on the negative control, one night, three runs:
//
//     run 1  reads TFTFFF  -> false   run 2  reads FTFFF  -> false   run 3  reads TTT -> TRUE
//
// Runs 1 and 2 reached the truth by LUCK OF THE INTERLEAVING: the flapping kept resetting the
// streak until the new version won. Run 3 drew a stale isolate that answered consistently for the
// whole window, and the gate reported the regression it exists to catch as the expected answer.
//
// So the legs are asymmetric now, because the paths are:
//
//   POSITIVE leg, a FIRST upload onto script names that never existed. Nothing stale can answer, so
//   any settled reading is honest and `settle()` is the right instrument.
//
//   NEGATIVE leg, a REPLACE. `false` can only come from the NEW version, since the version being
//   replaced HAD the binding. `true` is ambiguous between a stale isolate and a broken module and
//   no amount of repetition resolves it. So the wait is for `false` specifically: reached (pass) or
//   deadline-without-it (fail, UNCONVERGED), and `true` never terminates it.
//
// Both criteria are pure functions in settle-criterion.ts, unit-tested against those three real
// sequences in settle-criterion.test.ts. The loops here call exactly those functions, so the tested
// logic is the shipped logic rather than a copy of it. An unconverged read is a FAILURE, never a
// value.
//
// SPEND AND BLAST RADIUS. No tenant, no GPU, no RunPod call, no invoke key. A throwaway dispatch
// namespace, a throwaway D1, and one ephemeral dispatcher worker, all named `cpsmoke-<run>` and all
// deleted, with teardown verified by LISTING the account rather than by trusting the delete calls.
// The harness dispatcher's BOTH namespace bindings point at this run's throwaway namespace, so
// unlike the provision e2e harness it cannot reach a production tenant script even in principle.
//
// WHERE IT RUNS: a manual/dispatch gate before tagging, NOT a step in deploy.yml. That is a
// capability fact, not a preference: it has not been verified that the deploy token can create a
// dispatch namespace, and putting an unverified permission into the deploy path converts a smoke
// into an outage. Promoting it is a one-line change once someone confirms that scope (cp#256).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CfApi } from "../src/cf-api";
import {
  TENANT_MODULE_CATALOG,
  TenantModuleError,
  probeTenantModuleReadiness,
  tenantModuleScriptName,
  tenantModuleScriptPrefix,
  uploadTenantModules,
  type TenantModuleDeps,
} from "../src/tenant-modules";
import type { TenantEndpoint } from "../src/provisioner";
import { deployHarnessDispatcher, type HarnessDispatcher } from "./e2e-harness-dispatcher";
import { localModuleBundleSource } from "./module-bundle-local";
import { fetchStudioRelease, type FetchedStudioRelease } from "./studio-release-fetch";
import {
  NO_ANSWER,
  reached,
  render,
  settledValue,
  type Reading,
} from "./settle-criterion";
import {
  SMOKE_PREFIX,
  missingSmokeEnv,
  preDeploySmokeEnv,
  preDeploySmokeLive,
  smokeRequired,
} from "./pre-deploy-smoke-env";

declare const process: { env: Record<string, string | undefined> };

const LIVE = preDeploySmokeLive();
const env = LIVE ? preDeploySmokeEnv() : null;

const RUN = Date.now().toString(36).slice(-6);
const RUN_PREFIX = `${SMOKE_PREFIX}${RUN}`;
const NAMESPACE = RUN_PREFIX;
// The tenant id IS the run prefix, so module script names derive to `cpsmoke-<run>-<module>`.
// Real tenant ids are `ten_<hex>`, so a smoke script name can never collide with a tenant's.
const TENANT_ID = RUN_PREFIX;
const MODULE_SCRIPT_PREFIX = tenantModuleScriptPrefix(TENANT_ID);
const HARNESS_NAME = `${RUN_PREFIX}-dispatcher`;
const D1_PROBE_SCRIPT = `${RUN_PREFIX}-d1probe`;
// The module the negative control re-uploads without a database. Any recording module would do.
const NEGATIVE_MODULE = "keyframe";

const RECORDING = TENANT_MODULE_CATALOG.filter((s) => s.recordsRunpodJobs).map((s) => s.module);

const cf = LIVE ? new CfApi(env!.cfAccountId, env!.cfToken) : (null as unknown as CfApi);

const state: {
  namespace?: string;
  d1?: string;
  harness?: HarnessDispatcher;
  release?: FetchedStudioRelease;
  uploaded: string[];
} = { uploaded: [] };

const say = (line: string) => console.log(line);

const CF_API = "https://api.cloudflare.com/client/v4";

/** Raw account call for the few things CfApi does not model (namespace delete, script census). */
async function cfRaw(method: string, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${CF_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${env!.cfToken}` },
  });
  return { status: res.status, body: await res.text() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A reading that never reached the module. See callModule.
 *
 * DELIBERATELY NOT A VALUE. It is a third thing alongside true/false/null, it resets the stability
 * streak, and it renders as `x` so a run with transport trouble is visible as transport trouble.
 * Folding it into `null` would say "the module reports no telemetry field" about a request the
 * module never saw, which is the same collapse this whole suite exists to refuse.
 */


/**
 * One GET through the ephemeral dispatch door, with a BOUNDED retry on TRANSPORT failure only.
 *
 * MEASURED 2026-08-01, and this is not defensive padding. A run died on the first module read with
 * Cloudflare's generic 404 HTML page: the workers.dev route for the dispatcher was resolvable at the
 * PoP that answered the harness readiness poll and not yet at the PoP that answered the next
 * request. `deployHarnessDispatcher.call` throws on any non-200, so that transport race aborted the
 * whole suite AND produced exit 1, which is the failure code the run was expecting for a completely
 * different reason. A gate that returns the right exit status for the wrong reason is worse than no
 * gate.
 *
 * THE RETRY CANNOT LAUNDER AN ANSWER. The harness worker wraps every module reply, including a 404
 * from the module itself, in a 200 JSON envelope. A raw non-200 therefore means the request never
 * reached the harness at all. This retries exactly that case and never a reply.
 *
 * NOTE FOR WHOEVER OWNS tests/e2e-harness-dispatcher.ts: the same exposure exists in
 * provision-e2e.live.test.ts, which calls `.call()` directly. Not changed here, because that is a
 * shared harness and widening its behaviour under another suite is not a drive-by.
 */
async function callModule(script: string, path: string): Promise<{ status: number; text: string } | null> {
  let lastErr = "never attempted";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await state.harness!.call({ ns: "module", script, path, method: "GET" });
    } catch (e) {
      lastErr = String(e).slice(0, 160);
      await sleep(5_000);
    }
  }
  say(`   TRANSPORT: no answer from the dispatch door for ${script} after 3 attempts: ${lastErr}`);
  return null;
}

/**
 * Read GET /ready on one module script until the answer STOPS CHANGING, and report the whole
 * sequence. See the file header and cp#254; this is the load-bearing part of the suite.
 *
 * Returns `settled: false` when the deadline passes without `need` consecutive identical reads. The
 * caller must treat that as a FAILURE and not as the last value seen: an unsettled read is not
 * evidence in either direction, which is the entire finding.
 */
async function settle(
  script: string,
  need = 3,
  gapMs = 10_000,
  deadlineMs = 240_000,
): Promise<{ value: boolean | null; seq: Reading[]; ms: number; settled: boolean }> {
  const seq: Reading[] = [];
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    // Cache-buster on the path: a settled answer has to come from the worker, not from anything
    // in between deciding it already knows.
    const r = await callModule(script, `/ready?cb=${Date.now()}`);
    let v: Reading;
    if (r === null) {
      v = NO_ANSWER;
    } else {
      let body: { telemetry?: { job_log?: unknown } } = {};
      try {
        body = JSON.parse(r.text) as typeof body;
      } catch {
        body = {};
      }
      v = typeof body.telemetry?.job_log === "boolean" ? body.telemetry.job_log : null;
    }
    seq.push(v);
    // Decided by the SHARED criterion, not by a copy of it. settledValue is unit-tested against the
    // three real measured sequences in settle-criterion.test.ts, including the run it gets wrong.
    const verdict = settledValue(seq, need);
    if (verdict.settled) return { value: verdict.value, seq, ms: Date.now() - start, settled: true };
    await sleep(gapMs);
  }
  return { value: null, seq, ms: Date.now() - start, settled: false };
}

/**
 * Poll until the reading REACHES a specific value and holds it, or fail as UNCONVERGED.
 *
 * THIS EXISTS BECAUSE settle() IS THE WRONG INSTRUMENT ON THE REPLACE PATH, and that was found the
 * hard way: settle() proves STABILITY, and a stale isolate is perfectly stable.
 *
 * Measured on the negative control, same suite, same release, same account, three runs in one
 * night. The whole argument is in these three sequences, which is why they live here rather than
 * in a chat log:
 *
 *     run 1   keyframe  job_log=false   (settled 50s, reads: TFTFFF)
 *     run 2   keyframe  job_log=false   (settled 40s, reads: FTFFF)
 *     run 3   keyframe  job_log=true    (settled 20s, reads: TTT)     <- accepted a LIE
 *
 * Runs 1 and 2 reached the truth BY LUCK OF THE INTERLEAVING: the flapping kept resetting the
 * consecutive-reads streak until the new version won. Run 3 drew a stale isolate that answered
 * consistently for the whole window, and a consistent liar is exactly what a settle loop is built
 * to trust. One run in three, a gate that exists to catch a regression would have reported the
 * regression as the expected answer.
 *
 * THE ASYMMETRY IS THE FIX. On a REPLACE the two values are not equally trustworthy:
 *
 *   - `false` can only come from the NEW version. The version being replaced HAD the binding and
 *     could never say false. So a false reading is proof the new bytes are being served.
 *   - `true` is ambiguous: a stale old isolate, or a genuinely broken new one. No amount of stable
 *     reading distinguishes them, so no amount of stable reading may be accepted as an answer.
 *
 * Hence: the only outcomes are REACHED (pass) and NOT REACHED BY THE DEADLINE (fail, unconverged).
 * The unwanted value never terminates the loop, however many times it repeats.
 *
 * Stability is still required AFTER the wanted value appears, because a single sighting mid-flap is
 * not convergence: run 1 read false at position 2 and then true again at position 3.
 *
 * NO_ANSWER (a transport failure) resets the streak exactly as it does in settle(), and can never
 * satisfy the wait.
 */
async function awaitReading(
  script: string,
  want: boolean,
  need = 3,
  gapMs = 10_000,
  deadlineMs = 300_000,
): Promise<{ reached: boolean; seq: Reading[]; ms: number }> {
  const seq: Reading[] = [];
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const r = await callModule(script, `/ready?cb=${Date.now()}`);
    let v: Reading;
    if (r === null) {
      v = NO_ANSWER;
    } else {
      let body: { telemetry?: { job_log?: unknown } } = {};
      try {
        body = JSON.parse(r.text) as typeof body;
      } catch {
        body = {};
      }
      v = typeof body.telemetry?.job_log === "boolean" ? body.telemetry.job_log : null;
    }
    seq.push(v);
    // Same shared criterion, same reason.
    if (reached(seq, want, need)) return { reached: true, seq, ms: Date.now() - start };
    await sleep(gapMs);
  }
  return { reached: false, seq, ms: Date.now() - start };
}

async function readyReport(phase: string): Promise<Map<string, { value: boolean | null; settled: boolean }>> {
  say("");
  say(`=== GET /ready  [${phase}] ===`);
  const out = new Map<string, { value: boolean | null; settled: boolean }>();
  for (const spec of TENANT_MODULE_CATALOG) {
    const script = tenantModuleScriptName(TENANT_ID, spec.module);
    const s = await settle(script);
    out.set(spec.module, { value: s.value, settled: s.settled });
    say(
      `   ${spec.module.padEnd(16)} job_log=${String(s.value)}  ` +
        `(${s.settled ? "stable" : "NEVER SETTLED"} after ${Math.round(s.ms / 1000)}s, reads: ${render(s.seq)})`,
    );
  }
  return out;
}

const endpoints: TenantEndpoint[] = [
  { key: "backend", label: "Backend", id: `${RUN_PREFIX}-ep-backend`, name: "n1", endpointVar: "RUNPOD_ENDPOINT_ID" },
  { key: "upscale", label: "Upscale", id: `${RUN_PREFIX}-ep-upscale`, name: "n2", endpointVar: "VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID" },
  { key: "lipsync", label: "Lipsync", id: `${RUN_PREFIX}-ep-lipsync`, name: "n3", endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID" },
  { key: "audio-upscale", label: "Audio", id: `${RUN_PREFIX}-ep-audio`, name: "n4", endpointVar: "AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID" },
];

function makeDeps(): TenantModuleDeps {
  return {
    cf,
    moduleNamespace: NAMESPACE,
    aiGatewayId: null,
    moduleBundle: localModuleBundleSource(state.release!.dir),
    release: env!.studioRelease,
    // Transport-retried, and a door that still will not answer becomes status 0 rather than an
    // exception. probeTenantModuleReadiness then records job_log null with a detail, which fails the
    // assertion that reads it. A transport failure must never pass and must never look like an
    // answer; those are two different requirements and this satisfies both.
    callTenantModule: async (script, path) =>
      (await callModule(script, path)) ?? { status: 0, text: "the ephemeral dispatch door did not answer" },
    // Nothing in this suite has a tenant studio. A stub that THROWS rather than one that returns a
    // plausible 200: an unexpected call to it is a wiring change nobody meant to make, and a
    // friendly stub would absorb it silently.
    callTenantStudio: async () => {
      throw new Error("pre-deploy smoke has no tenant studio; callTenantStudio must not be reached");
    },
    log: (event, fields) => say(`   log ${event} ${JSON.stringify(fields)}`),
  };
}

// ------------------------------------------------------------------------------------------------
// SMOKE_REQUIRED. This block ALWAYS runs, in every `npm test`, live or not.
// ------------------------------------------------------------------------------------------------
describe("pre-deploy smoke wiring", () => {
  it("SMOKE_REQUIRED=1 turns a credential-less run into a FAILURE, not a skip", () => {
    const missing = missingSmokeEnv();
    if (!smokeRequired()) {
      // Not the release gate. Say what would have run so a silent skip is at least a loud skip.
      if (missing.length > 0) {
        say(`pre-deploy smoke SKIPPED (cp#255). Absent: ${missing.join(", ")}. Set SMOKE_REQUIRED=1 to make this fail.`);
      }
      expect(true).toBe(true);
      return;
    }
    expect(missing, `SMOKE_REQUIRED=1 but the smoke cannot run; absent: ${missing.join(", ")}`).toEqual([]);
  });
});

describe.skipIf(!LIVE)("pre-deploy smoke: module telemetry binding, live", () => {
  beforeAll(async () => {
    // ---- LEFTOVER CENSUS. Reported LOUDLY, never deleted. Another session's throwaway namespace
    // may belong to a run that is still going, and deleting it would take that run down. -------
    const namespaces = await cf.listDispatchNamespaces();
    const strays = namespaces.filter((n) => n.startsWith(SMOKE_PREFIX));
    if (strays.length > 0) {
      say("");
      say(`!!! LEFTOVER cpsmoke- DISPATCH NAMESPACES ON THIS ACCOUNT: ${strays.join(", ")}`);
      say("!!! These are debris from a killed smoke run. NOT deleted here: one of them may belong to");
      say("!!! a run still in flight. Reap them by hand once you know no smoke is running.");
      say("");
    } else {
      say(`leftover census: no ${SMOKE_PREFIX} dispatch namespaces on the account.`);
    }

    say(`run ${RUN} | namespace ${NAMESPACE} | script prefix ${MODULE_SCRIPT_PREFIX} | release ${env!.studioRelease}`);

    state.release = await fetchStudioRelease(env!.releaseRepo, env!.studioRelease);
    say(`studio release ${state.release.tag} downloaded and its manifest declares that tag.`);

    await cf.createDispatchNamespace(NAMESPACE);
    state.namespace = NAMESPACE;

    const db = await cf.createD1(RUN_PREFIX);
    state.d1 = db.uuid;
    say(`throwaway D1 created: ${db.uuid}`);

    // ---- D1 BINDABILITY IS A PRECONDITION, WAITED ON SEPARATELY ---------------------------------
    // A D1 created seconds earlier is not yet bindable: the first cp#248 upload died on
    // "binding TELEMETRY_DB of type d1 failed to generate" and the IDENTICAL upload succeeded two
    // minutes later. This waits it out on a THROWAWAY PROBE SCRIPT, deliberately not by retrying the
    // assertion. A retry around the assertion would launder a transient into a pass, and the whole
    // reason this suite exists is that a green which cannot distinguish two states is worthless.
    // Production is covered by ordering rather than by luck: the studio upload binds this same
    // database several steps before the modules do.
    const probeSource = "export default { async fetch() { return new Response('d1probe'); } };";
    const deadline = Date.now() + 300_000;
    let lastErr = "never attempted";
    let bindable = false;
    for (;;) {
      try {
        await cf.uploadUserWorker({
          namespace: NAMESPACE,
          scriptName: D1_PROBE_SCRIPT,
          mainModule: "index.js",
          moduleText: probeSource,
          compatibilityDate: "2026-06-01",
          bindings: [{ type: "d1", name: "TELEMETRY_DB", id: db.uuid }],
        });
        bindable = true;
        break;
      } catch (e) {
        lastErr = String(e).slice(0, 200);
      }
      if (Date.now() > deadline) break;
      await sleep(15_000);
    }
    if (!bindable) {
      throw new Error(`throwaway D1 ${db.uuid} never became bindable within 300s: ${lastErr}`);
    }
    say("precondition: the throwaway D1 is bindable (probe script accepted the binding).");
    await cf.deleteUserWorker(NAMESPACE, D1_PROBE_SCRIPT).catch(() => undefined);

    // ---- the dispatch door. Both namespace bindings point at THIS RUN's throwaway namespace, so
    // this worker cannot reach a production tenant script even if its bearer leaked. ------------
    state.harness = await deployHarnessDispatcher({
      accountId: env!.cfAccountId,
      cfToken: env!.cfToken,
      name: HARNESS_NAME,
      studioNamespace: NAMESPACE,
      moduleNamespace: NAMESPACE,
      studioPrefix: `${RUN_PREFIX}-studio-`,
      modulePrefix: MODULE_SCRIPT_PREFIX,
      workersDevSubdomain: env!.workersDevSubdomain,
    });
    say(`dispatch door live at ${state.harness.baseUrl} with its scope guard proven armed.`);
  }, 900_000);

  afterAll(async () => {
    // Teardown that can fail silently strands a live surface. Every step is attempted, every
    // failure is NAMED, and the census below reads the account back rather than trusting any of it.
    const drop = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        say(`LEFTOVER ${what}: ${String(e).slice(0, 160)}`);
      }
    };

    if (state.harness) {
      await drop("dispatcher", () => state.harness!.destroy());
      const still = await state.harness.existsOnAccount().catch(() => true);
      say(`dispatcher ${HARNESS_NAME} still on account after delete: ${String(still)}`);
      expect(still, "the ephemeral dispatch door outlived the run").toBe(false);
    }
    if (state.namespace) {
      for (const script of new Set(state.uploaded)) {
        await drop(`script ${script}`, () => cf.deleteUserWorker(state.namespace!, script));
      }
      await drop("namespace", async () => {
        const r = await cfRaw("DELETE", `/accounts/${env!.cfAccountId}/workers/dispatch/namespaces/${state.namespace}`);
        if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 160)}`);
      });
    }
    if (state.d1) await drop("d1", () => cf.deleteD1(state.d1!));
    state.release?.cleanup();

    // OUTSIDE VERIFICATION. A delete call returning 200 is the delete's own opinion of itself.
    const namespaces = await cf.listDispatchNamespaces().catch(() => null);
    if (namespaces === null) {
      say("TEARDOWN CENSUS FAILED: could not list dispatch namespaces. State UNKNOWN, not assumed clean.");
    } else {
      const mine = namespaces.filter((n) => n === NAMESPACE);
      say(`teardown census: ${namespaces.length} dispatch namespaces, ${mine.length} of them this run's.`);
      expect(mine, "this run's dispatch namespace survived teardown").toEqual([]);
    }
  }, 300_000);

  // ----------------------------------------------------------------------------------------------
  it("CONTROL: the uploader REFUSES a null telemetry database id, writing nothing", async () => {
    // The shipped guard from cp#248, exercised against the real API surface rather than a stub. It
    // runs FIRST because a refusal has changed nothing, so a failure here costs no cleanup.
    await expect(
      uploadTenantModules(makeDeps(), TENANT_ID, "cpsmoke", endpoints, null),
    ).rejects.toBeInstanceOf(TenantModuleError);

    // And it really did write nothing: the namespace holds no module scripts yet.
    const scripts = await cf.listNamespaceScripts(NAMESPACE);
    expect(scripts.filter((s) => s.startsWith(MODULE_SCRIPT_PREFIX))).toEqual([]);
  }, 120_000);

  it("POSITIVE: modules uploaded by THIS TREE report TELEMETRY_DB resolved in the running worker", async () => {
    const uploaded = await uploadTenantModules(makeDeps(), TENANT_ID, "cpsmoke", endpoints, state.d1!);
    state.uploaded.push(...uploaded);
    expect(uploaded.length).toBe(TENANT_MODULE_CATALOG.length);

    const rows = await readyReport("POSITIVE, uploaded with the tenant D1");

    // Every read must have SETTLED. An unsettled read is not a value (cp#254).
    const unsettled = [...rows.entries()].filter(([, r]) => !r.settled).map(([m]) => m);
    expect(unsettled, "these modules never settled; their reads are not evidence in either direction").toEqual([]);

    // THREE VALUES, AND THEY GET THREE VERDICTS. Collapsing them re-creates the exact defect the
    // TenantModuleObservation contract exists to prevent, and it is not hypothetical here:
    //
    //   true   the binding resolved in the running worker. This is the only PASS.
    //   false  the binding did not resolve on a module that CAN report. A real defect in the plane.
    //   null   the module image reports no telemetry field at all, because it predates
    //          vivijure-cf#279. That is NOT a no, and it is NOT a pass. It means THIS GATE CANNOT
    //          MEASURE THE PROPERTY ON THIS PIN, which is a condition someone has to act on rather
    //          than a state to normalise. Reporting green here would be the decoration cp#255 was
    //          filed to end.
    //
    // MEASURED 2026-08-01, and it is why this branch is written rather than left as theory: the
    // pinned STUDIO_RELEASE was v1.12.0, whose seven module bundles contain ZERO occurrences of
    // `job_log` (v1.13.0's five recording modules contain two each, same matcher, same layout).
    const reportedNull = RECORDING.filter((m) => rows.get(m)?.value === null);
    expect(
      reportedNull,
      `the pinned studio release ${env!.studioRelease} reports no telemetry.job_log on these modules ` +
        `(the image predates vivijure-cf#279), so this gate CANNOT prove they will record. This is ` +
        `not a pass and not a plane defect; it means the pin cannot answer the question.`,
    ).toEqual([]);

    const reportedFalse = RECORDING.filter((m) => rows.get(m)?.value === false);
    expect(reportedFalse, "recording modules whose running worker could NOT resolve TELEMETRY_DB").toEqual([]);

    // plan-enhance submits no RunPod job and has no /ready route, so null is its correct answer.
    // Asserted separately so a 404 there never reads as a gap.
    expect(rows.get("plan-enhance")?.value, "plan-enhance is not endpoint-backed and must report null").toBe(null);
  }, 1_800_000);

  it("the shipped admin-route logic agrees with the settled reads", async () => {
    // probeTenantModuleReadiness is what GET /api/admin/tenants/:id/module-readiness returns. It is
    // a SINGLE-SHOT read by design (cp#254), so it is asserted here only AFTER the settle loop above
    // has established the answer is stable. Running it first would make it a coin toss.
    const obs = await probeTenantModuleReadiness(makeDeps(), TENANT_ID);
    for (const o of obs) {
      say(`   ${o.module.padEnd(16)} records=${String(o.records_runpod_jobs)} job_log=${String(o.job_log)} status=${o.status}`);
    }
    const unproven = obs.filter((o) => o.records_runpod_jobs && o.job_log !== true).map((o) => o.module);
    expect(unproven, "modules the admin route cannot prove will record").toEqual([]);
  }, 300_000);

  it("NEGATIVE CONTROL: the same module re-uploaded WITHOUT the database REACHES false", async () => {
    // THE POINT: without this, a green above proves only that something answered true, which a
    // hardcoded true in a module bundle would also produce. This removes exactly one binding from
    // exactly one script and requires the running worker to notice.
    //
    // It goes through cf.uploadUserWorker rather than uploadTenantModules because the uploader
    // REFUSES a null database id (asserted in the control above), which is the correct product
    // behaviour and the reason the negative cannot be driven through the shipped path.
    //
    // This is the REPLACE path, which is the measured-ambiguous one (cp#254): a version replacing
    // another can be answered by a stale isolate. That is what settle() is for, and an unsettled
    // read fails rather than being read as a value.
    const spec = TENANT_MODULE_CATALOG.find((s) => s.module === NEGATIVE_MODULE)!;
    const bundle = await localModuleBundleSource(state.release!.dir).fetch(env!.studioRelease, NEGATIVE_MODULE);
    const script = tenantModuleScriptName(TENANT_ID, NEGATIVE_MODULE);
    const endpoint = endpoints.find((e) => e.key === spec.endpointKey)!;

    await cf.uploadUserWorker({
      namespace: NAMESPACE,
      scriptName: script,
      mainModule: bundle.mainModule,
      moduleText: bundle.moduleText,
      compatibilityDate: bundle.compatibilityDate,
      compatibilityFlags: bundle.compatibilityFlags,
      bindings: [{ type: "plain_text", name: "RUNPOD_ENDPOINT_ID", text: endpoint.id }],
    });

    // Corroboration, not the proof: the API agrees no d1 binding is attached. The proof is what the
    // worker says about itself, below.
    const bindings = await cf.getScriptBindings(NAMESPACE, script);
    expect(bindings.map((b) => `${b.type}:${b.name}`)).not.toContain("d1:TELEMETRY_DB");

    // WAIT FOR false, never accept a settled true. See awaitReading for the three measured
    // sequences that forced this and for why stability was the wrong property.
    //
    // The old code called settle() here and took whatever stabilised. On one run in three that was
    // a stale isolate answering `true` consistently for the whole window, and the gate reported the
    // regression it exists to catch as the expected answer.
    const s = await awaitReading(script, false);
    say("");
    say(`=== NEGATIVE CONTROL [${NEGATIVE_MODULE}, no database] ===`);
    say(
      `   ${NEGATIVE_MODULE.padEnd(16)} ` +
        `${s.reached ? "REACHED false" : "NEVER REACHED false"} after ${Math.round(s.ms / 1000)}s, ` +
        `reads: ${render(s.seq)}`,
    );
    // ONE assertion, not two. "reached false" is the entire claim: the running worker, with no
    // TELEMETRY_DB attached, reported that it cannot record. Not reaching it is UNCONVERGED, which
    // is a failure and is deliberately not reported as "the module said true" -- we do not know
    // what the module says, we know the measurement did not converge.
    expect(
      s.reached,
      `the negative control never observed job_log=false in ${Math.round(s.ms / 1000)}s ` +
        `(reads: ${render(s.seq)}). UNCONVERGED: a stale isolate serving the previous version and a ` +
        `genuinely broken module are indistinguishable from here, so this is not evidence the module ` +
        `is wrong, and it is certainly not evidence it is right. Do not re-run for a green.`,
    ).toBe(true);
  }, 1_800_000);
});
