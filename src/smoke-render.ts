// The operator verification route (cp#45).
//
// THE HOLE THIS CLOSES. Our release standard is that nothing is verified until someone has looked
// at the actual output. For a hosted tenant nobody could: the only credential that drives a tenant
// studio is tenants.studio_token_enc, decryptable only inside this worker, so an operator holding
// D1 read access holds ciphertext and nothing usable. Every hosted module release to date rested on
// install-and-probe evidence -- the module ANSWERED -- and never on observed pixels.
//
// THE SHAPE, ruled by Conrad 2026-07-19 (option (b) over option (a)): the plane already holds the
// KEK and already dispatches to tenants, so the PLANE submits a canonical smoke render on an
// operator request and hands back the artifact. NO CREDENTIAL LEAVES THE WORKER. That is the entire
// reason (b) beat (a): option (a) would have created a standing credential class able to drive a
// customer studio, to be custodied forever, for something we do a few times per release.
//
// RENDERING THROUGH A NON-TENANT DOOR IS REJECTED AND STAYS REJECTED. Every call below goes through
// THIS tenant's own studio script, over its own dispatch binding, with its own token, into its own
// module workers and its own R2. An artifact produced any other way proves the modules render
// somewhere, which is a different question and worse than an honest hole.
//
// WHAT THE CLIENT SEAM DELIBERATELY IS NOT: a generic "dispatch this path to that tenant" helper.
// It is four typed calls with canonical paths and no caller-supplied path, because a general
// primitive here would be an operator-driven proxy into every customer studio, which is a much
// larger thing than the verification this issue asked for.

import type { ControlPlaneStore, SmokeRender, SmokeRenderBounds, Tenant } from "./store";

/**
 * WHAT A PASSING SMOKE RENDER PROVES, AND WHAT IT DOES NOT.
 *
 * Returned on every response from these routes, verbatim, because the failure this issue documents
 * is a claim outrunning its proof. A green tick that does not state its own limits becomes, two
 * releases later, evidence for something nobody verified.
 */
export const SMOKE_RENDER_COVERAGE = {
  proves: [
    "this tenant's own studio script accepted an authenticated submit over the dispatch binding",
    "this tenant's own keyframe module ran on RunPod under this tenant's own invoke key",
    "the resulting bytes were FETCHED back through this worker, sized and hashed, not inferred",
    "the pixels came from the module bytes recorded in modules_release on the smoke render row",
  ],
  does_not_prove: [
    "that any OTHER module renders: this exercises the keyframe hook only",
    "the motion, dialogue, speech, finish, assemble, master or mux stages of a full film",
    "anything about image quality: the artifact is measured (bytes, sha256, mime), never judged",
    "that a tenant's own end-to-end film submit works, which has more moving parts than this",
  ],
} as const;

/**
 * THE CANONICAL SMOKE RENDER, and it is canonical rather than operator-supplied on purpose.
 *
 * This is the first and largest half of the spend guard: the route takes a tenant id and NOTHING
 * ELSE. There is no scene count, no duration, no quality tier, and no model knob an operator could
 * turn, accidentally or otherwise, into a real film's worth of GPU. One scene, keyframes only, the
 * smallest submission the studio will accept that still puts a GPU module to work.
 *
 * It is also canonical so that two runs are COMPARABLE: same prompt, same shape, so a change in the
 * outcome is a change in the tenant, not in what we asked for.
 */
export const SMOKE_SHOT_ID = "smoke1";
export const SMOKE_PROJECT_NAME = "control-plane-smoke";
export const SMOKE_SCENE_SECONDS = 4;
export const SMOKE_PROMPT = "a single red apple on a plain white table, soft daylight, sharp focus";

/**
 * A StoryboardValidated as the studio's bundle route expects it (vivijure-cf hBundle ->
 * assembleBundle). Hand-authored rather than derived: the control plane does not import studio core
 * (they are separate Workers with disjoint deps by design), so this is a FIXTURE against a contract.
 *
 * DRIFT IS HANDLED HONESTLY, NOT PREVENTED: if a future studio release changes this shape, the
 * bundle route answers 400 with its own validation errors and the smoke render is recorded FAILED
 * carrying them. That is a loud, legible failure of the verification, never a false pass -- which is
 * the only property that actually matters for a fixture we cannot typecheck against.
 *
 * Scene id is set explicitly because the bundle assembler keys shots on `s.id` when present and
 * falls back to a positional `shot_NN`; naming it is what lets the submit below reference the shot.
 */
export function canonicalStoryboard(): Record<string, unknown> {
  return {
    title: "Control Plane Smoke Render",
    projectName: SMOKE_PROJECT_NAME,
    full_prompt: SMOKE_PROMPT,
    duration_seconds: SMOKE_SCENE_SECONDS,
    clip_seconds: SMOKE_SCENE_SECONDS,
    style_prefix: "",
    style_category: "",
    style_preset: "",
    use_characters: [],
    cast_rules: "",
    scenes: [{ id: SMOKE_SHOT_ID, prompt: SMOKE_PROMPT, target_seconds: SMOKE_SCENE_SECONDS }],
  };
}

/**
 * DEFAULT BOUNDS. Operator-tunable through env (see resolveSmokeRenderBounds), but never absent:
 * an unset var means the default applies, not that the bound is off.
 */
export const DEFAULT_SMOKE_BOUNDS: SmokeRenderBounds = {
  // Long enough that "run it again" is a decision rather than a reflex, short enough that a real
  // release verification is not obstructed.
  cooldownSeconds: 30 * 60,
  // The blast-radius bound: even if every tenant is smoke-tested in one sitting, the platform
  // cannot exceed this many operator-initiated renders in a rolling day.
  dailyCap: 20,
  // Comfortably longer than a keyframe render, so it never races a live one, and finite so a smoke
  // render whose poll never came back cannot wedge the route for that tenant forever.
  inFlightSeconds: 20 * 60,
};

/**
 * Parse an operator override. A malformed or negative value is IGNORED, never treated as zero.
 *
 * THE BLANK CASE IS NOT PEDANTRY. Number("") is 0, and a var declared in wrangler.toml but left
 * empty arrives as "" rather than undefined -- so the obvious version of this function silently
 * turns an unfilled config line into "this bound is off". On a route that costs GPU that is a hole,
 * not a rounding error. A blank means ABSENT; only a real number turns a bound off, and then only
 * because somebody typed the zero.
 */
function boundFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function resolveSmokeRenderBounds(env: {
  SMOKE_RENDER_COOLDOWN_SECONDS?: string;
  SMOKE_RENDER_DAILY_CAP?: string;
  SMOKE_RENDER_INFLIGHT_SECONDS?: string;
}): SmokeRenderBounds {
  return {
    cooldownSeconds: boundFrom(env.SMOKE_RENDER_COOLDOWN_SECONDS, DEFAULT_SMOKE_BOUNDS.cooldownSeconds),
    dailyCap: boundFrom(env.SMOKE_RENDER_DAILY_CAP, DEFAULT_SMOKE_BOUNDS.dailyCap),
    inFlightSeconds: boundFrom(env.SMOKE_RENDER_INFLIGHT_SECONDS, DEFAULT_SMOKE_BOUNDS.inFlightSeconds),
  };
}

/** A raw studio answer. Text, not parsed, so a non-JSON error body survives into the record. */
export interface StudioReply {
  status: number;
  text: string;
}

/** Bytes pulled back through this worker. `bytes` is null when the fetch did not return a body. */
export interface StudioBytes {
  status: number;
  bytes: ArrayBuffer | null;
  contentType: string;
}

/**
 * The four typed calls a smoke render needs against ONE tenant's studio. No caller-supplied path,
 * no caller-supplied body: every payload below is built here from the canonical fixture.
 *
 * The implementation (deps.ts) is where the KEK lives; it decrypts the tenant token per call and
 * the token never crosses this interface, which is what makes "no credential leaves the worker"
 * a property of the seam rather than a rule someone has to remember.
 */
export interface TenantStudioSmokeClient {
  putCanonicalBundle(tenant: Tenant): Promise<StudioReply>;
  submitKeyframeRender(tenant: Tenant, bundleKey: string): Promise<StudioReply>;
  pollRender(tenant: Tenant, studioJobId: string): Promise<StudioReply>;
  fetchArtifact(tenant: Tenant, key: string): Promise<StudioBytes>;
}

export interface SmokeRenderDeps {
  store: ControlPlaneStore;
  studio: TenantStudioSmokeClient;
  bounds: SmokeRenderBounds;
  log(event: string, fields: Record<string, unknown>): void;
}

export type SmokeRenderStart =
  | { ok: true; smoke: SmokeRender }
  | { ok: false; code: "spend_guard"; message: string }
  | { ok: false; code: "studio_refused"; smoke: SmokeRender; message: string };

/**
 * Open a smoke render and drive it as far as the studio's own submit -- bundle, then render submit.
 *
 * Both legs are cheap and synchronous (the studio answers 201 with a job id and does the GPU work
 * behind it), so they run inline: a submit failure is then a DIRECT answer to the operator rather
 * than a row they have to poll to discover. The GPU half is what the poll route drives.
 */
export async function startSmokeRender(
  deps: SmokeRenderDeps,
  tenant: Tenant,
  id: string,
): Promise<SmokeRenderStart> {
  // THE WRITE IS THE GATE. Nothing above this line has cost anything, and nothing below it runs
  // unless this INSERT landed, so a refusal here has dispatched nothing and burned nothing.
  const smoke = await deps.store.openSmokeRender(id, tenant.id, tenant.modules_release, deps.bounds);
  if (!smoke) {
    const why = await deps.store.describeSmokeRenderRefusal(tenant.id, deps.bounds);
    return {
      ok: false,
      code: "spend_guard",
      // Never a bare "denied": the operator has to be able to tell a cooldown from a cap.
      message: why ?? "the smoke-render spend guard refused this submit",
    };
  }

  const bundle = await deps.studio.putCanonicalBundle(tenant);
  const bundleKey = readBundleKey(bundle);
  if (!bundleKey) {
    const message = `the tenant studio would not build the smoke bundle (HTTP ${bundle.status}): ${truncate(bundle.text)}`;
    await deps.store.finishSmokeRender(smoke.id, { status: "failed", error: message });
    deps.log("smoke_render.bundle_failed", { tenant: tenant.id, smoke: smoke.id, status: bundle.status });
    return { ok: false, code: "studio_refused", smoke, message };
  }

  const submit = await deps.studio.submitKeyframeRender(tenant, bundleKey);
  const studioJobId = readJobId(submit);
  if (!studioJobId) {
    const message = `the tenant studio would not accept the smoke render (HTTP ${submit.status}): ${truncate(submit.text)}`;
    await deps.store.finishSmokeRender(smoke.id, { status: "failed", error: message });
    deps.log("smoke_render.submit_failed", { tenant: tenant.id, smoke: smoke.id, status: submit.status });
    return { ok: false, code: "studio_refused", smoke, message };
  }

  await deps.store.setSmokeRenderSubmitted(smoke.id, studioJobId, bundleKey);
  deps.log("smoke_render.submitted", {
    tenant: tenant.id,
    smoke: smoke.id,
    studio_job: studioJobId,
    modules_release: tenant.modules_release,
  });
  const updated = await deps.store.getSmokeRender(smoke.id);
  return { ok: true, smoke: updated ?? smoke };
}

/**
 * Drive a running smoke render one step, and record a TERMINAL outcome only when it is observed.
 *
 * THE LOAD-BEARING PART: a studio job reporting COMPLETED is NOT a pass. This fetches the artifact
 * bytes back through the worker and records their size, mime and sha256; a COMPLETED job with no
 * keyframe key, an unfetchable key, or a zero-byte body is recorded FAILED. phase=done being
 * treated as proof is the exact hole cp#45 exists to close, so it is closed here rather than
 * documented as a caveat.
 */
export async function advanceSmokeRender(
  deps: SmokeRenderDeps,
  tenant: Tenant,
  smoke: SmokeRender,
): Promise<SmokeRender> {
  if (smoke.status !== "running") return smoke;

  const reread = async (): Promise<SmokeRender> => (await deps.store.getSmokeRender(smoke.id)) ?? smoke;
  const fail = async (message: string): Promise<SmokeRender> => {
    await deps.store.finishSmokeRender(smoke.id, { status: "failed", error: message });
    deps.log("smoke_render.failed", { tenant: tenant.id, smoke: smoke.id, reason: message });
    return await reread();
  };

  if (!smoke.studio_job_id) {
    return await fail("no studio job was ever recorded for this smoke render; the submit did not land");
  }

  // Bounded rather than eternal, for the same reason a provision job is (#112): a render nothing
  // will ever finish must become an honest failure, not a permanent spinner holding the guard.
  if (ageSeconds(smoke.created_at) > deps.bounds.inFlightSeconds) {
    return await fail(
      `the smoke render did not finish within ${deps.bounds.inFlightSeconds}s; giving up rather than ` +
        "reporting a render nothing observed complete",
    );
  }

  const poll = await deps.studio.pollRender(tenant, smoke.studio_job_id);
  if (poll.status !== 200) {
    // NOT terminal: a transient dispatch or studio blip must not condemn a render that may well be
    // running. The in-flight bound above is what stops this from looping forever.
    deps.log("smoke_render.poll_unavailable", { tenant: tenant.id, smoke: smoke.id, status: poll.status });
    return smoke;
  }

  const view = parseJson(poll.text) as { status?: unknown; error?: unknown; output?: unknown } | null;
  const runpodStatus = typeof view?.status === "string" ? view.status : "";
  if (runpodStatus === "FAILED" || runpodStatus === "CANCELLED" || runpodStatus === "TIMED_OUT") {
    const detail = typeof view?.error === "string" && view.error ? view.error : "no error detail given";
    return await fail(`the tenant studio reported the render ${runpodStatus}: ${truncate(detail)}`);
  }
  if (runpodStatus !== "COMPLETED") return smoke;

  const key = readKeyframeKey(view?.output);
  if (!key) {
    return await fail(
      "the tenant studio reported COMPLETED but named no keyframe artifact; a completed job with " +
        "nothing to look at is not a pass",
    );
  }

  const got = await deps.studio.fetchArtifact(tenant, key);
  if (got.status !== 200 || !got.bytes || got.bytes.byteLength === 0) {
    return await fail(
      `the render reported COMPLETED but its artifact could not be fetched (key ${key}, HTTP ` +
        `${got.status}, ${got.bytes?.byteLength ?? 0} bytes). The artifact is the evidence; without ` +
        "it there is nothing verified.",
    );
  }

  const artifact = {
    key,
    bytes: got.bytes.byteLength,
    sha256: await sha256Hex(got.bytes),
    contentType: got.contentType,
  };
  await deps.store.finishSmokeRender(smoke.id, { status: "succeeded", artifact });
  deps.log("smoke_render.succeeded", {
    tenant: tenant.id,
    smoke: smoke.id,
    artifact_key: key,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
  });
  return await reread();
}

// ---- readers ----------------------------------------------------------------------------------
//
// Each one parses the MINIMAL invariant it needs (a key, an id) rather than asserting a whole
// studio response shape. A parser that over-asserts turns an unrelated additive change in the
// studio into a failed verification, which trains people to ignore the verification.

function readBundleKey(reply: StudioReply): string | null {
  if (reply.status !== 201 && reply.status !== 200) return null;
  const body = parseJson(reply.text) as { ok?: unknown; bundleKey?: unknown } | null;
  if (body?.ok !== true) return null;
  return typeof body.bundleKey === "string" && body.bundleKey ? body.bundleKey : null;
}

function readJobId(reply: StudioReply): string | null {
  if (reply.status !== 201 && reply.status !== 200) return null;
  const body = parseJson(reply.text) as { jobId?: unknown } | null;
  return typeof body?.jobId === "string" && body.jobId ? body.jobId : null;
}

/** keyframes-only output carries `keyframes: [{ shot_id, key }]`. We want the first real key. */
function readKeyframeKey(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const frames = (output as { keyframes?: unknown }).keyframes;
  if (!Array.isArray(frames)) return null;
  for (const f of frames) {
    const key = (f as { key?: unknown } | null)?.key;
    if (typeof key === "string" && key) return key;
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Studio error bodies can be long. Keep the record readable; the log has the rest. */
function truncate(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** created_at is SQLite's "YYYY-MM-DD HH:MM:SS", always UTC. Unparseable reads as age 0 (do not
 *  condemn a render because we could not read a timestamp). */
function ageSeconds(createdAt: string): number {
  // D1 writes "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker; anything already carrying a T and a
  // zone is parsed as-is. Handling both is not defensive padding: the memory store used by the
  // logic tests writes one shape and D1 writes the other, and a parser that silently returned 0 for
  // one of them would make the deadline untestable in exactly the suite that tests it.
  const direct = Date.parse(createdAt);
  const t = Number.isFinite(direct) && /[Tt].*([Zz]|[+-]\d{2}:?\d{2})$/.test(createdAt)
    ? direct
    : Date.parse(`${createdAt.replace(" ", "T")}Z`);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / 1000);
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
