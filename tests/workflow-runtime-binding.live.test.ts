// Does `env.X.create()` work when the Workflow RESOURCE does not exist? (cp#537, cp#526)
//
//   CF_PROVISIONER_TOKEN=<token> CF_ACCOUNT_ID=<id> npx vitest run tests/workflow-runtime-binding.live.test.ts
//
// This repo is PUBLIC, so the env contract is named here and the place the credential is kept is
// not.
//
// WHY THIS EXISTS. cp#537 established that the Workflows API cannot address a script inside a
// dispatch namespace: 500 `10001 internal_server`, identical to a script that does not exist, while
// an ACCOUNT-level script answers 200 and a malformed body answers 400. If a Workflow resource is
// REQUIRED for a binding to work, that is a hard block on the hosted dialogue and cf-* doors. If it
// is NOT required -- if the binding's own `class_name` + `script_name` are enough at runtime --
// there is no second half to the emitter and cp#537 becomes a documentation note.
//
// IT IS TESTED ON AN ACCOUNT-LEVEL SCRIPT ON PURPOSE. That isolates the RUNTIME question from the
// ADDRESSING question: a namespace script cannot be reached over HTTP at all without a Worker
// holding a dispatch_namespace binding, so testing there means standing up a second instrument and
// two unknowns at once. **STATE THE LIMIT WITH THE RESULT: account-level and namespace scripts may
// resolve bindings differently, so a PASS here is strong evidence and NOT proof for the namespace
// case.** Confirming it for a namespace script is a separate, larger instrument.
//
// SAFETY: prod account (the only one with WfP). Everything `strummer-verify-` prefixed and torn
// down in afterAll, including the workers.dev route, which exists only for the seconds this runs.
// The probe worker is bearer-guarded so a passer-by cannot make it create Workflow instances. Zero
// GPU spend, no tenant touched.

import { describe, it, expect, afterAll } from "vitest";

declare const process: { env: Record<string, string | undefined> };

const TOKEN = process.env.CF_PROVISIONER_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const LIVE = Boolean(TOKEN && ACCOUNT);

const stamp = `strummer-verify-${Date.now().toString(36)}`;
const CLASS = "ProbeWorkflow";
const BINDING = "PROBE_WORKFLOW";

/** Per-run bearer, generated here, never persisted, never logged. Same discipline as the e2e harness. */
function randomBearer(): string {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const BEARER = LIVE ? randomBearer() : "";

// The probe worker. It does ONE thing and reports what happened rather than throwing, because the
// interesting outcome is the ERROR TEXT on the failure path.
const WORKER = `
import { WorkflowEntrypoint } from "cloudflare:workers";
export class ${CLASS} extends WorkflowEntrypoint {
  async run(event, step) { return await step.do("noop", async () => "ok"); }
}
export default {
  async fetch(request, env) {
    if (request.headers.get("x-probe-bearer") !== env.PROBE_BEARER) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }
    if (!env.${BINDING}) {
      return new Response(JSON.stringify({ bound: false }), { headers: { "content-type": "application/json" } });
    }
    try {
      const instance = await env.${BINDING}.create();
      return new Response(JSON.stringify({ bound: true, created: true, id: instance.id }), {
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ bound: true, created: false, error: String(e).slice(0, 300) }), {
        headers: { "content-type": "application/json" },
      });
    }
  },
};
`;

const state: { scripts: string[]; workflows: string[] } = { scripts: [], workflows: [] };

async function cfFetch(
  path: string,
  init: RequestInit = {},
  cap = 600,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string>) },
  });
  return { status: res.status, body: (await res.text()).slice(0, cap) };
}

/** Upload an account-level worker carrying a workflow binding, and publish it on workers.dev. */
async function deployProbe(name: string, workflowName: string): Promise<void> {
  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-06-01",
    bindings: [
      { type: "secret_text", name: "PROBE_BEARER", text: BEARER },
      { type: "workflow", name: BINDING, workflow_name: workflowName, class_name: CLASS },
    ],
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("index.js", new Blob([WORKER], { type: "application/javascript+module" }), "index.js");
  const up = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${name}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  if (!up.ok) throw new Error(`probe upload failed ${up.status}: ${(await up.text()).slice(0, 300)}`);
  state.scripts.push(name);

  const sub = await cfFetch(`/workers/scripts/${name}/subdomain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
  });
  if (sub.status >= 400) throw new Error(`subdomain enable failed ${sub.status}: ${sub.body}`);
}

/** Call the probe. A fresh workers.dev route takes a moment to serve, so this waits, bounded. */
async function callProbe(name: string, subdomain: string): Promise<Record<string, unknown>> {
  const url = `https://${name}.${subdomain}.workers.dev/`;
  const deadline = Date.now() + 30_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: { "x-probe-bearer": BEARER },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      // A route that is not serving yet answers with Cloudflare's own error page, not our JSON.
      if (res.status === 200 || res.status === 403) return JSON.parse(text) as Record<string, unknown>;
      last = `HTTP ${res.status} ${text.slice(0, 200)}`;
    } catch (e) {
      last = String(e).slice(0, 200);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`probe never served within 30s: ${last}`);
}

afterAll(async () => {
  if (!LIVE) return;
  const drop = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      console.warn(`LEFTOVER ${what}: ${String(e).slice(0, 200)}`);
    }
  };
  // Scripts first: deleting the script takes its workers.dev route with it.
  for (const s of state.scripts) {
    await drop(`script ${s}`, async () => {
      const r = await cfFetch(`/workers/scripts/${s}?force=true`, { method: "DELETE" });
      if (r.status >= 400) throw new Error(`HTTP ${r.status} ${r.body}`);
    });
  }
  for (const w of state.workflows) {
    await drop(`workflow ${w}`, async () => {
      const r = await cfFetch(`/workflows/${w}`, { method: "DELETE" });
      if (r.status >= 400) throw new Error(`HTTP ${r.status} ${r.body}`);
    });
  }
});

describe.skipIf(!LIVE)("does a workflow binding need its Workflow to exist?", () => {
  let subdomain = "";

  it("reads the account's workers.dev subdomain, which the probes are served on", async () => {
    const r = await cfFetch(`/workers/subdomain`);
    expect(r.status).toBe(200);
    subdomain = (JSON.parse(r.body).result as { subdomain: string }).subdomain;
    expect(subdomain.length).toBeGreaterThan(0);
  });

  it("POSITIVE CONTROL: with the Workflow CREATED, env.X.create() succeeds", async () => {
    // Without this, a failure in the next case is indistinguishable from a broken probe worker, a
    // bad bearer, or a route that never served. This is the case that proves the instrument can
    // report success at all.
    const name = `${stamp}-ctl`;
    const wf = `${name}-wf`;
    await deployProbe(name, wf);
    const created = await cfFetch(`/workflows/${wf}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ class_name: CLASS, script_name: name }),
    });
    expect(created.status, created.body).toBe(200);
    state.workflows.push(wf);

    const answer = await callProbe(name, subdomain);
    console.log("CONTROL (workflow exists):", JSON.stringify(answer));
    expect(answer.bound).toBe(true);
    expect(answer.created, JSON.stringify(answer)).toBe(true);
  });

  it("MEASURES env.X.create() when the Workflow resource does NOT exist", async () => {
    // THE QUESTION. If this succeeds, the resource is not required at runtime and cp#537's
    // addressing limit stops blocking the hosted door. If it fails, the resource IS required and
    // cp#537 is a hard block that needs Cloudflare's answer or a module redesign.
    const name = `${stamp}-abs`;
    const absent = `${stamp}-absent-wf`;
    await deployProbe(name, absent);

    // The binding names it; nothing created it. Proven absent through the API before invoking, so
    // the reading cannot be about a Workflow that quietly existed.
    const before = await cfFetch(`/workflows/${absent}`);
    expect(before.status, before.body).toBe(404);

    const answer = await callProbe(name, subdomain);
    console.log("MEASURED (workflow absent):", JSON.stringify(answer));
    expect(answer.bound, JSON.stringify(answer)).toBe(true);

    // Unpinned on this run by design: the answer is the finding. Pinned in the same PR once read.
    const after = await cfFetch(`/workflows/${absent}`);
    console.log("MEASURED (was it created as a side effect?):", after.status);
  });
});
