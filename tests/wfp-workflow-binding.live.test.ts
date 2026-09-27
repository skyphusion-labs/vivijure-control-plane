// LIVE proof that a Workers for Platforms user Worker CAN carry a `workflow` binding (cp#526, and
// the unlock for the hosted `dialogue` door, cp#524).
//
//   CF_PROVISIONER_TOKEN=<token> CF_ACCOUNT_ID=<id> npx vitest run tests/wfp-workflow-binding.live.test.ts
//
// This repo is PUBLIC, so the env contract is named here and the place the credential is kept is
// not. Operators know where their own credentials live; a public file naming the path tells
// everyone else.
//
// WHY IT EXISTS, and it is the whole point of the change it verifies. Adding a variant to the
// `WorkerBinding` union makes it TYPECHECK, which is the writing client's opinion of its own
// request. The `ai` and `vpc_service` variants in cf-api.ts are documented as live-proven for
// exactly this reason: an upload response echoes no bindings, so `success: true` proves only that
// the request was accepted, never that the binding is attached. The READBACK is the proof.
//
// FIRST GREEN RUN: dispatch 36343598466, 2026-09-27T19:14Z, branch feat/526-workflow-binding-variant.
// Three readings that nothing in this estate had ever taken are PINNED below as assertions rather
// than left as prose, because each one is a vendor behaviour an emitter will be built on, and the
// day Cloudflare changes any of them is a day this has to go red:
//
//   1. A script exporting a WorkflowEntrypoint uploads fine with NO workflow binding. That settles
//      cp#526's open A-vs-B as A: the four catalogued `cf-*` doors provision, look installed, pass
//      /ready, and throw at the first invoke -- after the keyframe pass is already spent. There is
//      no refusal at modules_upload to catch it.
//   2. The upload does NOT create the account-scoped Workflow. The binding attaches to a resource
//      that does not exist and the API says nothing.
//   3. A SECOND script may claim the SAME workflow_name, with a different class, and the API
//      accepts that too. So nothing outside this plane will ever warn about a cross-tenant name
//      collision; tenant-prefixing is on us, exactly as it is for the script name.
//
// SAFETY: this hits the PROD account (the only one with WfP enabled). Every resource is prefixed
// `strummer-verify-` and torn down in afterAll; it creates nothing outside that prefix and touches
// nothing pre-existing. Zero GPU spend, no tenant touched, no existing script read or written.

import { describe, it, expect, afterAll } from "vitest";
import { CfApi } from "../src/cf-api";

declare const process: { env: Record<string, string | undefined> };

const TOKEN = process.env.CF_PROVISIONER_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const LIVE = Boolean(TOKEN && ACCOUNT);

const stamp = `strummer-verify-${Date.now().toString(36)}`;
const cf = LIVE ? new CfApi(ACCOUNT!, TOKEN!) : (null as unknown as CfApi);

/** The binding variable the module code would read as `env.PROBE_WORKFLOW`. */
const BINDING = "PROBE_WORKFLOW";
/** The ACCOUNT-scoped Workflow resource name. Stamped, so it cannot collide with a real one. */
const WORKFLOW = `${stamp}-wf`;
const CLASS = "ProbeWorkflow";
/** Cloudflare's code for "no such Workflow" (read off the live 404, not off a docs page). */
const CF_WORKFLOW_NOT_FOUND = 10200;

const SCRIPT_UNBOUND = "tenant-verify-wf-unbound";
const SCRIPT_BOUND = "tenant-verify-wf-bound";
const SCRIPT_COLLIDE = "tenant-verify-wf-collide";

// A real module worker: it EXPORTS a WorkflowEntrypoint class, exactly as every cf-* door and both
// dialogue providers do. A worker without that export would make the unbound measurement below
// meaningless, because the question is specifically about a script whose code declares a Workflow.
const WORKER = [
  'import { WorkflowEntrypoint } from "cloudflare:workers";',
  `export class ${CLASS} extends WorkflowEntrypoint {`,
  "  async run(_event, step) { return await step.do(\"noop\", async () => \"ok\"); }",
  "}",
  'export default { async fetch() { return new Response("ok"); } };',
].join("\n");

const state: {
  ns?: string;
  scripts: string[];
  createdWorkflow?: boolean;
  createdControlWorkflow?: string;
  plainScript?: string;
  qualifiedWorkflows: string[];
} = { scripts: [], qualifiedWorkflows: [] };

async function cfFetch(path: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string>) },
  });
  return { status: res.status, body: (await res.text()).slice(0, 400) };
}

afterAll(async () => {
  if (!LIVE) return;
  const drop = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      console.warn(`LEFTOVER ${what}: ${String(e).slice(0, 160)}`);
    }
  };
  for (const s of state.scripts) await drop(`script ${s}`, () => cf.deleteUserWorker(state.ns!, s));
  // A Workflow is an ACCOUNT resource, so it would outlive both the script and the namespace.
  // MEASURED not to be created by the upload (see below), so this only fires if that ever changes
  // -- which is exactly when a leftover would otherwise start accumulating unnoticed.
  const wf = await cfFetch(`/workflows/${WORKFLOW}`);
  if (wf.status < 400) {
    await drop(`workflow ${WORKFLOW}`, async () => {
      const r = await cfFetch(`/workflows/${WORKFLOW}`, { method: "DELETE" });
      if (r.status >= 400) throw new Error(`HTTP ${r.status} ${r.body}`);
    });
  }
  if (state.createdControlWorkflow) {
    await drop(`control workflow ${state.createdControlWorkflow}`, async () => {
      const r = await cfFetch(`/workflows/${state.createdControlWorkflow}`, { method: "DELETE" });
      if (r.status >= 400) throw new Error(`HTTP ${r.status} ${r.body}`);
    });
  }
  for (const w of state.qualifiedWorkflows) {
    await drop(`qualified workflow ${w}`, async () => {
      const r = await cfFetch(`/workflows/${w}`, { method: "DELETE" });
      if (r.status >= 400) throw new Error(`HTTP ${r.status} ${r.body}`);
    });
  }
  if (state.plainScript) {
    await drop(`account script ${state.plainScript}`, async () => {
      const r = await cfFetch(`/workers/scripts/${state.plainScript}`, { method: "DELETE" });
      if (r.status >= 400) throw new Error(`HTTP ${r.status} ${r.body}`);
    });
  }
  if (state.ns) {
    await drop("namespace", async () => {
      const r = await cfFetch(`/workers/dispatch/namespaces/${state.ns}`, { method: "DELETE" });
      if (r.status >= 400) throw new Error(`HTTP ${r.status} ${r.body}`);
    });
  }
});

describe.skipIf(!LIVE)("a WfP user Worker and the `workflow` binding", () => {
  it("creates the throwaway dispatch namespace", async () => {
    await cf.createDispatchNamespace(stamp);
    state.ns = stamp;
    expect(await cf.listDispatchNamespaces()).toContain(stamp);
  });

  it("A, not B: a script exporting a WorkflowEntrypoint uploads with NO workflow binding", async () => {
    // cp#526's open question, settled against the running API. `resolves` is the assertion: if
    // Cloudflare ever starts REFUSING this, the four cf-* rows stop being a silent door and become
    // a dead provision, and that is a change this repo must hear about on the day it happens.
    await expect(
      cf.uploadUserWorker({
        namespace: state.ns!,
        scriptName: SCRIPT_UNBOUND,
        mainModule: "index.js",
        moduleText: WORKER,
        compatibilityDate: "2026-06-01",
        // The plain_text is the readback CONTROL for the negative assertion below: without a
        // binding that IS present, "no PROBE_WORKFLOW" cannot be told apart from "readback broken".
        bindings: [{ type: "plain_text", name: "PROBE_CONTROL", text: "present" }],
      }),
    ).resolves.toBeUndefined();
    state.scripts.push(SCRIPT_UNBOUND);
  });

  it("accepts a workflow binding, and the API READS IT BACK", async () => {
    await cf.uploadUserWorker({
      namespace: state.ns!,
      scriptName: SCRIPT_BOUND,
      mainModule: "index.js",
      moduleText: WORKER,
      compatibilityDate: "2026-06-01",
      bindings: [
        { type: "plain_text", name: "PROBE_CONTROL", text: "present" },
        { type: "workflow", name: BINDING, workflow_name: WORKFLOW, class_name: CLASS },
      ],
    });
    state.scripts.push(SCRIPT_BOUND);

    const back = await cf.getScriptBindings(state.ns!, SCRIPT_BOUND);
    const wf = back.find((b) => b.name === BINDING);
    // The NAME alone would pass on a binding CF silently downgraded to something else, so the TYPE
    // is asserted too. That is the reading that says the variant is the one the runtime will honour.
    expect(wf, JSON.stringify(back)).toBeDefined();
    expect(wf!.type).toBe("workflow");
    expect(back.find((b) => b.name === "PROBE_CONTROL")).toBeDefined();
  });

  it("NEGATIVE CONTROL: the unbound script reads back WITHOUT it, so the readback can say no", async () => {
    // Without this, the assertion above passes against a readback that returns every binding name
    // anyone ever asked about. The control binding must be present on the SAME response, or a
    // readback that simply failed would look identical to an absent workflow binding.
    const back = await cf.getScriptBindings(state.ns!, SCRIPT_UNBOUND);
    expect(back.find((b) => b.name === "PROBE_CONTROL"), JSON.stringify(back)).toBeDefined();
    expect(back.find((b) => b.name === BINDING)).toBeUndefined();
  });

  it("the upload does NOT create the account-scoped Workflow: the binding points at nothing", async () => {
    // THE FINDING AN EMITTER IS BUILT ON. The binding attaches, is read back, and names a Workflow
    // that does not exist -- Cloudflare says nothing about the gap at upload time. So emitting the
    // binding is NOT the whole job: the Workflow has to be provisioned, or `env.X.create()` meets
    // a resource that was never there.
    const r = await cfFetch(`/workflows/${WORKFLOW}`);
    console.log("workflow resource after upload:", r.status, r.body);
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).errors[0].code).toBe(CF_WORKFLOW_NOT_FOUND);
  });

  it("a SECOND script may claim the SAME workflow_name, and the API does not object", async () => {
    // THE MULTI-TENANT HAZARD, pinned. Every tenant's copy of a module lands in ONE shared dispatch
    // namespace on ONE account, so an emitter using the module's own wrangler name would have two
    // tenants naming one Workflow. Nothing outside this plane will warn: the upload is accepted.
    await expect(
      cf.uploadUserWorker({
        namespace: state.ns!,
        scriptName: SCRIPT_COLLIDE,
        mainModule: "index.js",
        moduleText: WORKER.replace(CLASS, "OtherProbeWorkflow"),
        compatibilityDate: "2026-06-01",
        bindings: [{ type: "workflow", name: BINDING, workflow_name: WORKFLOW, class_name: "OtherProbeWorkflow" }],
      }),
    ).resolves.toBeUndefined();
    state.scripts.push(SCRIPT_COLLIDE);
    const after = await cfFetch(`/workflows/${WORKFLOW}`);
    console.log("workflow resource after collision:", after.status, after.body);
    expect(after.status).toBe(404);
  });

  // MEASUREMENT, unpinned until the first run reads it. The emitter has to CREATE the Workflow,
  // because the upload measured above does not -- and the open question is whether the Workflows
  // API will accept a `script_name` that lives in a DISPATCH NAMESPACE rather than on the account
  // directly. Nothing in the docs says either way, and every tenant module script is in a namespace,
  // so an emitter built on the assumption would fail at the one place it cannot be tested from.
  it("MEASURES whether a Workflow can be created against a DISPATCH-NAMESPACE script", async () => {
    const r = await cfFetch(`/workflows/${WORKFLOW}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ class_name: CLASS, script_name: SCRIPT_BOUND }),
    });
    console.log("MEASURED workflow create (namespace script):", r.status, r.body);
    const back = await cfFetch(`/workflows/${WORKFLOW}`);
    console.log("MEASURED workflow readback:", back.status, back.body);
    if (back.status < 400) state.createdWorkflow = true;

    // A second shape to distinguish "namespace scripts are not addressable" from "this script name
    // is wrong": the same call against a script name that exists NOWHERE. If both answer the same
    // way, the first reading says nothing about dispatch namespaces.
    const controlName = `${WORKFLOW}-control`;
    const ctl = await cfFetch(`/workflows/${controlName}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ class_name: CLASS, script_name: "no-such-script-cp526" }),
    });
    console.log("CONTROL workflow create (nonexistent script):", ctl.status, ctl.body);
    if (ctl.status < 400) state.createdControlWorkflow = controlName;
  });

  // The first run of the two above answered 500 `10001 workflows.api.error.internal_server` to BOTH,
  // so they are indistinguishable and that reading says NOTHING about dispatch namespaces. These
  // three separate the candidate causes: the credential, the request body, and the namespace.
  it("MEASURES the Workflows API from three other angles, to say what the 500 is about", async () => {
    // 1. CAN THIS CREDENTIAL SEE WORKFLOWS AT ALL, and does an operator `wrangler deploy` even
    //    register one as an account resource? Names only -- a Workflow name is not a secret, but
    //    nothing else from these rows is printed.
    const list = await cfFetch(`/workflows?per_page=50`);
    let names: string[] = [];
    try {
      names = ((JSON.parse(list.body).result ?? []) as { name?: string }[]).map((w) => w.name ?? "?");
    } catch { /* body truncated or not JSON; the status is the signal */ }
    console.log("MEASURED workflows list:", list.status, "count:", names.length, "names:", names.join(","));

    // 2. IS THE 500 ABOUT OUR BODY? A PUT with class_name missing entirely should be a 4xx from any
    //    API that validates input. If this 500s too, the endpoint 500s on everything and the
    //    earlier readings carry no information at all.
    const bad = await cfFetch(`/workflows/${WORKFLOW}-badbody`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script_name: SCRIPT_BOUND }),
    });
    console.log("MEASURED workflow create (malformed body):", bad.status, bad.body);

    // 3. IS IT THE NAMESPACE? Same call against an ACCOUNT-LEVEL script -- the one shape the
    //    Workflows API is documented for. This is the discriminator: if it succeeds here and fails
    //    for a dispatch-namespace script, the cause is named, and the hosted dialogue door needs a
    //    different answer than "the plane creates the Workflow".
    const plain = `${stamp}-plain`;
    const form = new FormData();
    form.append(
      "metadata",
      new Blob([JSON.stringify({ main_module: "index.js", compatibility_date: "2026-06-01", bindings: [] })], {
        type: "application/json",
      }),
    );
    form.append("index.js", new Blob([WORKER], { type: "application/javascript+module" }), "index.js");
    const up = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${plain}`,
      { method: "PUT", headers: { authorization: `Bearer ${TOKEN}` }, body: form },
    );
    console.log("MEASURED account-level script upload:", up.status);
    if (up.ok) {
      state.plainScript = plain;
      const wf = await cfFetch(`/workflows/${plain}-wf`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ class_name: CLASS, script_name: plain }),
      });
      console.log("MEASURED workflow create (ACCOUNT-level script):", wf.status, wf.body);
      if (wf.status < 400) state.createdControlWorkflow = `${plain}-wf`;

      // POSITIVE CONTROL FOR THE LIST above, which answered 200 with ZERO rows. An empty list from
      // a credential that cannot see the family looks exactly like an empty list from an account
      // that has none, and the difference matters: nine module wrangler.toml files in vivijure-cf
      // declare a [[workflows]] block, and the operator deploys those modules.
      const after = await cfFetch(`/workflows?per_page=50`);
      let n = -1;
      try { n = ((JSON.parse(after.body).result ?? []) as unknown[]).length; } catch { /* status is the signal */ }
      console.log("CONTROL workflows list AFTER a successful create:", after.status, "count:", n);
    } else {
      console.log("account-level upload refused, so angle 3 measured NOTHING:", (await up.text()).slice(0, 200));
    }
  });

  // Round 2 established that the Workflows API answers 200 for an ACCOUNT-level script and 500
  // `10001 internal_server` for a dispatch-namespace one -- identically to a script that does not
  // exist, and distinguishably from a malformed body (400 `10002`). So the API does validate, and a
  // namespace script simply is not addressable by bare name. This tries the one other shape a
  // caller could reasonably mean before that is reported as a platform gap.
  it("MEASURES whether a namespace script is addressable under a QUALIFIED script_name", async () => {
    for (const candidate of [`${state.ns}/${SCRIPT_BOUND}`, `${SCRIPT_BOUND}@${state.ns}`]) {
      const r = await cfFetch(`/workflows/${WORKFLOW}-q${Math.abs(candidate.length)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ class_name: CLASS, script_name: candidate }),
      });
      console.log(`MEASURED qualified script_name ${JSON.stringify(candidate)}:`, r.status, r.body);
      if (r.status < 400) state.qualifiedWorkflows.push(`${WORKFLOW}-q${Math.abs(candidate.length)}`);
    }
  });
});
