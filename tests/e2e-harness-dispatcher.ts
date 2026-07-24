// EPHEMERAL, TENANT-SCOPED dispatch door for the live provision e2e (#4).
//
// WHY THIS EXISTS AT ALL: there is no out-of-worker HTTP path into a Workers-for-Platforms dispatch
// namespace. The first live run proved it the hard way -- the previous helper fetched
// `<script>.<namespace>.<subdomain>.workers.dev`, and `*.workers.dev` TLS covers exactly ONE label,
// so the two-label form dies at the handshake (curl 35) while the one-label form 404s because WfP
// user Workers are not published there. That URL shape was written to look right and never
// exercised. The ONLY way into a dispatch namespace is a Worker holding a `dispatch_namespace`
// binding, which is precisely what the control plane is in production.
//
// So the harness deploys one, and then takes it away again:
//
//   - it is created in `beforeAll` and DELETED in `afterAll`, verified from outside. Its lifetime is
//     one test run, so it is never a standing surface on the account.
//   - it is named `e2e-harness-dispatcher-<ts>`, unambiguous on purpose: any orphan on the account
//     is instantly identifiable as a leaked test artifact rather than something anyone must reason
//     about.
//
// TWO INDEPENDENT GUARDS, because one is not defence in depth (ruled, sprint vivijure-cf#215):
//
//   1. a per-run bearer, generated here, never persisted, never logged;
//   2. a TENANT SCOPE baked into the worker's own env at deploy time. Both dispatch namespaces are
//      SHARED with production tenants -- the module namespace held 30 scripts across 6 real tenant
//      groups when this was written -- so a bearer alone would mean a door that could reach any
//      customer's studio if it leaked during the window. The scope makes that structurally
//      impossible: the worker refuses any script name outside this run's own throwaway prefixes,
//      and it cannot be talked out of it, because the prefixes are baked into the deployed artifact
//      rather than passed per request.
//
// Both prefixes end in "-" for the same reason `tenantModuleScriptPrefix` does: a bare prefix can
// match a DIFFERENT tenant whose id merely starts with these characters, and tenant ids are hex, so
// "ten-e2e" is a live collision risk against a real `ten_e2e...` tenant, not a theoretical one.

export interface HarnessDispatcherConfig {
  accountId: string;
  cfToken: string;
  /** Script name; carries the run timestamp so an orphan is self-identifying. */
  name: string;
  studioNamespace: string;
  moduleNamespace: string;
  /** Only script names starting with these may be dispatched to. Both MUST end in "-". */
  studioPrefix: string;
  modulePrefix: string;
  /** Account workers.dev suffix, e.g. `skyphusion.workers.dev`. */
  workersDevSubdomain: string;
}

export interface HarnessDispatcher {
  baseUrl: string;
  call(req: {
    ns: "studio" | "module";
    script: string;
    path: string;
    method: string;
    authorization?: string;
    body?: string;
  }): Promise<{ status: number; text: string }>;
  /** Delete the deployed worker. Safe to call twice. */
  destroy(): Promise<void>;
  /** Read the account back to prove the script is gone. Outside verification, not our own opinion. */
  existsOnAccount(): Promise<boolean>;
}

/**
 * The deployed worker, as source. Kept as a string deliberately: it is not part of the control
 * plane, must never be importable from `src/`, and compiles against no shared types.
 *
 * It speaks ONE verb (POST + JSON envelope) rather than mirroring HTTP through headers, because
 * header mirroring is how the tenant's own `authorization` collides with the harness bearer -- the
 * envelope keeps the two credentials in separate fields where they cannot be confused.
 */
const HARNESS_WORKER_SOURCE = `
export default {
  async fetch(request, env) {
    const json = (status, obj) =>
      new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

    if (request.method !== "POST") return json(405, { error: "post_only" });
    if (request.headers.get("x-harness-bearer") !== env.HARNESS_BEARER) return json(403, { error: "forbidden" });

    let req;
    try {
      req = await request.json();
    } catch {
      return json(400, { error: "bad_envelope" });
    }

    const script = String(req.script || "");
    const ns = req.ns === "module" ? "module" : req.ns === "studio" ? "studio" : null;
    if (ns === null) return json(400, { error: "bad_ns" });

    // THE SCOPE GUARD. Baked into this artifact at deploy; nothing in the request can widen it.
    const prefix = ns === "module" ? env.SCOPE_MODULE_PREFIX : env.SCOPE_STUDIO_PREFIX;
    if (!prefix || !script.startsWith(prefix)) return json(403, { error: "out_of_scope", script: script });

    const binding = ns === "module" ? env.MODULE_NS : env.STUDIO_NS;
    let stub;
    try {
      stub = binding.get(script);
    } catch (e) {
      return json(404, { error: "no_such_script", detail: String(e).slice(0, 200) });
    }

    const headers = new Headers();
    if (req.authorization) headers.set("authorization", req.authorization);
    if (req.body !== undefined && req.body !== null) headers.set("content-type", "application/json");

    const method = String(req.method || "GET").toUpperCase();
    const init = { method, headers };
    if (method !== "GET" && method !== "HEAD" && req.body !== undefined && req.body !== null) {
      init.body = req.body;
    }

    let res;
    try {
      res = await stub.fetch(new Request("https://tenant.internal" + String(req.path || "/"), init));
    } catch (e) {
      return json(502, { error: "dispatch_failed", detail: String(e).slice(0, 200) });
    }
    return json(200, { status: res.status, text: await res.text() });
  },
};
`;

const CF_API = "https://api.cloudflare.com/client/v4";

async function cf(
  token: string,
  path: string,
  init: { method: string; body?: BodyInit; contentType?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (init.contentType) headers["content-type"] = init.contentType;
  const res = await fetch(`${CF_API}${path}`, { method: init.method, headers, body: init.body });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

/** 256 bits of bearer. Generated per run, held only in this process, never written down. */
function randomBearer(): string {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function deployHarnessDispatcher(config: HarnessDispatcherConfig): Promise<HarnessDispatcher> {
  // Refuse a prefix that cannot do its job. A scope guard that admits a sibling tenant is worse
  // than none, because it reads as protection.
  for (const [label, value] of [
    ["studioPrefix", config.studioPrefix],
    ["modulePrefix", config.modulePrefix],
  ] as const) {
    if (!value.endsWith("-")) throw new Error(`harness ${label} must end with "-" (got "${value}")`);
    if (value.length < 8) throw new Error(`harness ${label} is too short to scope anything: "${value}"`);
  }

  const bearer = randomBearer();
  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-06-01",
    bindings: [
      { type: "dispatch_namespace", name: "STUDIO_NS", namespace: config.studioNamespace },
      { type: "dispatch_namespace", name: "MODULE_NS", namespace: config.moduleNamespace },
      { type: "secret_text", name: "HARNESS_BEARER", text: bearer },
      { type: "plain_text", name: "SCOPE_STUDIO_PREFIX", text: config.studioPrefix },
      { type: "plain_text", name: "SCOPE_MODULE_PREFIX", text: config.modulePrefix },
    ],
  };

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("index.js", new Blob([HARNESS_WORKER_SOURCE], { type: "application/javascript+module" }), "index.js");

  const up = await cf(config.cfToken, `/accounts/${config.accountId}/workers/scripts/${config.name}`, {
    method: "PUT",
    body: form,
  });
  if (!up.ok) throw new Error(`harness dispatcher upload failed (${up.status}): ${up.body.slice(0, 400)}`);

  const sub = await cf(config.cfToken, `/accounts/${config.accountId}/workers/scripts/${config.name}/subdomain`, {
    method: "POST",
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
    contentType: "application/json",
  });
  if (!sub.ok) throw new Error(`harness dispatcher subdomain enable failed (${sub.status}): ${sub.body.slice(0, 400)}`);

  const baseUrl = `https://${config.name}.${config.workersDevSubdomain}`;

  const dispatcher: HarnessDispatcher = {
    baseUrl,
    async call(req) {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-harness-bearer": bearer },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      if (res.status !== 200) throw new Error(`harness dispatcher returned ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text) as { status: number; text: string };
    },
    async destroy() {
      await cf(config.cfToken, `/accounts/${config.accountId}/workers/scripts/${config.name}`, { method: "DELETE" });
    },
    async existsOnAccount() {
      const res = await cf(config.cfToken, `/accounts/${config.accountId}/workers/scripts/${config.name}`, {
        method: "GET",
      });
      // 404 is the honest gone. Anything else, treat as still present rather than assume success --
      // a delete verifier that reads an ambiguous answer as "gone" is the exact false-negative this
      // whole suite exists to avoid.
      return res.status !== 404;
    },
  };

  // READINESS + THE GUARD'S OWN NEGATIVE TEST, in one probe.
  //
  // workers.dev routes take a moment to become resolvable, so something must wait. Waiting on an
  // IN-scope call would prove only that the door opens. This waits on an OUT-of-scope call and
  // requires it to be REFUSED, so the same poll that proves the harness is live also proves the
  // scope guard is armed on the deployed artifact -- watched failing before anything trusts it.
  // If it ever answers 200 here, the guard is not doing its job and the run must not continue.
  const deadline = Date.now() + 60_000;
  let lastErr = "never probed";
  for (;;) {
    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-harness-bearer": bearer },
        body: JSON.stringify({ ns: "studio", script: "tenant-not-mine-studio", path: "/", method: "GET" }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      if (res.status === 403 && text.includes("out_of_scope")) break;
      if (res.status === 200) {
        await dispatcher.destroy();
        throw new Error(
          `harness SCOPE GUARD IS NOT ARMED: an out-of-scope dispatch was served. Refusing to run. Body: ${text.slice(0, 300)}`,
        );
      }
      lastErr = `status ${res.status}: ${text.slice(0, 200)}`;
    } catch (e) {
      if (String(e).includes("SCOPE GUARD IS NOT ARMED")) throw e;
      lastErr = String(e).slice(0, 200);
    }
    if (Date.now() > deadline) {
      await dispatcher.destroy();
      throw new Error(`harness dispatcher never became ready at ${baseUrl}: ${lastErr}`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  return dispatcher;
}
