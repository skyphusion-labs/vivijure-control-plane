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
// It also answers, against the running API rather than by reading a docs page, the question cp#526
// left open because nothing had ever run it: does a script that EXPORTS a WorkflowEntrypoint upload
// at all when no workflow binding is sent? That is the state the four catalogued `cf-*` doors are
// in today, and A (accepted, throws at invoke) versus B (refused at modules_upload) is the
// difference between a silent door and a loud one.
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

const state: { ns?: string; scripts: string[]; workflows: string[] } = { scripts: [], workflows: [] };

/** Measurements this run TAKES rather than asserts. Printed, and pinned as assertions once read. */
const measured: Record<string, string> = {};

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
  // A Workflow is an ACCOUNT resource, so it outlives the script and the namespace. Dropping it is
  // part of the teardown, not an afterthought: a leftover here is estate debris under my name.
  for (const w of state.workflows) {
    await drop(`workflow ${w}`, async () => {
      const r = await cfFetch(`/workflows/${w}`, { method: "DELETE" });
      if (r.status >= 400) throw new Error(`HTTP ${r.status} ${r.body}`);
    });
  }
  if (state.ns) {
    await drop("namespace", async () => {
      const r = await cfFetch(`/workers/dispatch/namespaces/${state.ns}`, { method: "DELETE" });
      if (r.status >= 400) throw new Error(`HTTP ${r.status} ${r.body}`);
    });
  }
  if (Object.keys(measured).length) console.log("MEASURED:", JSON.stringify(measured, null, 2));
});

describe.skipIf(!LIVE)("a WfP user Worker and the `workflow` binding", () => {
  it("creates the throwaway dispatch namespace", async () => {
    await cf.createDispatchNamespace(stamp);
    state.ns = stamp;
    expect(await cf.listDispatchNamespaces()).toContain(stamp);
  });

  // MEASUREMENT, not an assertion yet: this is cp#526's open A-vs-B question, and nothing in this
  // estate has ever run it. Pinned as an assertion in the same PR once the first live run reads it.
  it("MEASURES whether a script exporting a WorkflowEntrypoint uploads with NO workflow binding", async () => {
    let verdict = "accepted";
    try {
      await cf.uploadUserWorker({
        namespace: state.ns!,
        scriptName: SCRIPT_UNBOUND,
        mainModule: "index.js",
        moduleText: WORKER,
        compatibilityDate: "2026-06-01",
        // The plain_text is the readback CONTROL for the negative assertion below: without a
        // binding that IS present, "no PROBE_WORKFLOW" cannot be told apart from "readback broken".
        bindings: [{ type: "plain_text", name: "PROBE_CONTROL", text: "present" }],
      });
      state.scripts.push(SCRIPT_UNBOUND);
    } catch (e) {
      verdict = `refused: ${String(e).slice(0, 200)}`;
    }
    measured.unbound_upload_with_exported_workflow_class = verdict;
    console.log("MEASURED unbound upload:", verdict);
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
    state.workflows.push(WORKFLOW);

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
    if (!state.scripts.includes(SCRIPT_UNBOUND)) {
      // The unbound upload was REFUSED, which is itself the answer to cp#526 and leaves this
      // control with no subject. Fail rather than skip: a silent skip here is a control that
      // reports green while measuring nothing.
      expect(measured.unbound_upload_with_exported_workflow_class).toMatch(/^refused/);
      return;
    }
    const back = await cf.getScriptBindings(state.ns!, SCRIPT_UNBOUND);
    expect(back.find((b) => b.name === "PROBE_CONTROL"), JSON.stringify(back)).toBeDefined();
    expect(back.find((b) => b.name === BINDING)).toBeUndefined();
  });

  // MEASUREMENT: does the upload PROVISION the account-scoped Workflow, or must it pre-exist?
  // An emitter that has to create the Workflow first is a different change from one that does not.
  it("MEASURES whether the Workflow resource now exists on the account", async () => {
    const r = await cfFetch(`/workflows/${WORKFLOW}`);
    measured.workflow_resource_after_upload = `HTTP ${r.status} ${r.body}`;
    console.log("MEASURED workflow resource:", measured.workflow_resource_after_upload);
  });

  // MEASUREMENT: the multi-tenant hazard. Every tenant's copy of a module lands in ONE shared
  // dispatch namespace on ONE account, so if the emitter used the module's own wrangler name, two
  // tenants would name the same Workflow. This reads what the API does when they do.
  it("MEASURES a SECOND script binding the SAME workflow_name with a different class", async () => {
    let verdict = "accepted";
    try {
      await cf.uploadUserWorker({
        namespace: state.ns!,
        scriptName: SCRIPT_COLLIDE,
        mainModule: "index.js",
        moduleText: WORKER.replace(CLASS, "OtherProbeWorkflow"),
        compatibilityDate: "2026-06-01",
        bindings: [{ type: "workflow", name: BINDING, workflow_name: WORKFLOW, class_name: "OtherProbeWorkflow" }],
      });
      state.scripts.push(SCRIPT_COLLIDE);
    } catch (e) {
      verdict = `refused: ${String(e).slice(0, 200)}`;
    }
    const after = await cfFetch(`/workflows/${WORKFLOW}`);
    measured.same_workflow_name_from_a_second_script = verdict;
    measured.workflow_owner_after_collision = `HTTP ${after.status} ${after.body}`;
    console.log("MEASURED collision:", verdict, "|", measured.workflow_owner_after_collision);
  });
});
