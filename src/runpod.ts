// RunPod endpoint provisioning (#54): the TS port of scripts/runpod-provision.py's PROVEN shapes.
//
// The python script stays untouched (its DEFAULT_IMAGE_TAG=0.4.4 is a known footgun, frozen by
// ruling). This is a port of the shapes, not of the script: the pin here is explicit config,
// reviewed at release (Q4 golden-gate), and nothing is pinned until both panels are golden.
//
// TWO-KEY CUSTODY (binding): the key passed in here is KEY A -- the tenant's transient, graphql
// Read/Write key. It is used ONCE, to create these endpoints, and is never stored anywhere: not in
// D1, not in a log, not on the tenant's studio. What the studio eventually stores is KEY B, an
// invoke-only key scoped to exactly the endpoints created here, which the tenant must mint in the
// RunPod console AFTER these exist (RunPod has no key-creation API, and a key cannot be scoped to
// endpoints that do not exist yet -- which is what forces two-phase onboarding).

import { SATELLITE_PINS, type SatelliteKey, imageRef } from "./satellite-pins";

const RUNPOD_API = "https://rest.runpod.io/v1";

/** GPU classes for the render backend. Same-class (sm_90+) only; see runpod-provision.py section 4. */
const BACKEND_GPUS = ["NVIDIA H200", "NVIDIA B200"];
/** The finish satellites are CPU-light GPU work; RTX 6000 Pro class, as live-verified 2026-07-15. */
const SATELLITE_GPUS = ["NVIDIA RTX 6000 Ada Generation", "NVIDIA L40S"];

/**
 * A capability in the plan is satisfied EITHER by a RunPod endpoint we provision, OR by hardware
 * we already own and run ourselves. Modelled as a discriminated union rather than a boolean flag
 * so the compiler enumerates every site that assumed an endpoint id exists (cp#396-adjacent
 * reasoning: make the wrong state unrepresentable rather than guarded).
 *
 * WHY THIS EXISTS. The shared invoke key is endpoint-scoped, and Conrad minted it with
 * vivijure-video-upscale and vivijure-audio-upscale set to NO ACCESS: those two run as long-lived
 * serve containers on our own boxes, so the plane must not be able to reach a RunPod endpoint for
 * them even if a config named one. That ruling now lives in the CREDENTIAL. Until this split, it
 * did not live in the CODE, and the two disagreed in a way nothing could report:
 * SHARED_RUNPOD_ENDPOINTS is all-or-nothing across every plan key, so the correct JSON could not
 * be written at all -- four keys demanded, two of which must not exist.
 *
 * Own iron carries no maxWorkers and no endpointVar, on purpose and not as an omission. There is
 * no RunPod quota to spend and no endpoint id to bind, and a nullable field here would let an
 * empty string reach the studio as an endpoint id, which fails at the tenant FIRST RENDER rather
 * than at provision -- the failure shape this file already warns about for templateEnv.
 */
interface PlannedCapabilityBase {
  /** Stable key the UI and the studio secrets use. */
  key: SatelliteKey;
  label: string;
  /**
   * Image repo + pinned tag, RESOLVED from `satellite-pins.ts` -- never written here. A literal in
   * this file is what let the pins rot six releases behind production (cp#126), so the plan carries
   * the pin it was built from rather than declaring one.
   */
  imageRepo: string;
  tag: string;
}

/** A capability we provision as a RunPod serverless endpoint. */
export interface PlannedEndpoint extends PlannedCapabilityBase {
  backing: "runpod";
  /**
   * Pinned EXPLICITLY on every endpoint, never left to RunPod default of 3.
   * Why it matters: the quota is ACCOUNT-WIDE and enforced at CONFIG time against the sum of
   * workersMax across all endpoints (#60). Four endpoints at the default 3 = 12, which fails at
   * create time on the later endpoints.
   */
  maxWorkers: number;
  gpuTypeIds: string[];
  /** The studio secret that carries this endpoint id. */
  endpointVar: string;
}
/**
 * A capability served by hardware we own and operate, reached by the tenant studio over a
 * Workers VPC service binding rather than through RunPod.
 *
 * IT IS NOT DROPPED FROM PROVISIONING, it changes TRANSPORT. A shared tenant keeps the full
 * capability and reaches our iron instead of a RunPod endpoint, so it consumes no RunPod quota,
 * needs no pool entry, and carries no endpointVar.
 */
export interface PlannedVpcCapability extends PlannedCapabilityBase {
  backing: "vpc";
  bindingName: string;
  serviceIdVar: string;
}

export type PlannedCapability = PlannedEndpoint | PlannedVpcCapability;

/**
 * The narrowing every consumer that needs an endpoint id must go through.
 *
 * A type guard rather than a filter on a string field, so a caller cannot reach `endpointVar` on
 * an own-iron entry without the compiler objecting. That is the whole safety property here.
 */
export const isEndpointBacked = (c: PlannedCapability): c is PlannedEndpoint => c.backing === "runpod";

/** Only the entries a RunPod endpoint must exist for. */
export const endpointBackedPlan = (plan: PlannedCapability[] = PROVISION_PLAN): PlannedEndpoint[] =>
  plan.filter(isEndpointBacked);

/** Only the entries served by our own hardware. Exported so the UI can say so rather than omit them. */
export const vpcBackedPlan = (plan: PlannedCapability[] = PROVISION_PLAN): PlannedVpcCapability[] =>
  plan.filter((c): c is PlannedVpcCapability => c.backing === "vpc");

/**
 * THE PROVISIONING PLAN, as DATA.
 *
 * Joan's onboarding renders from this rather than hardcoding a list (the registry-projection rule),
 * so what the tenant is shown is what actually gets built. 2+1+1+1 = 5 workers.
 *
 * The IMAGE half of every entry comes from `SATELLITE_PINS` (cp#126); this file decides layout,
 * labels, GPU class and worker counts, and never decides a version.
 */
const pinned = (key: SatelliteKey) => ({
  key,
  imageRepo: SATELLITE_PINS[key].repo,
  tag: SATELLITE_PINS[key].tag,
});

// cp#367: single source for "this endpoint does not do cast-LoRA training" so every downstream
// copy of the backend purpose or label can be asserted against the same pattern the test in
// this file already uses, instead of a hand-duplicated literal that can silently drift.
export const NO_TRAINING_CLAUSE = /lora|train/i;

export const PROVISION_PLAN: PlannedCapability[] = [
  {
    ...pinned("backend"),
    backing: "runpod",
    // cp#303: cast LoRA training does NOT run on this endpoint. Training is fail-closed on its
    // own satellite (vivijure-wan-train / RUNPOD_WAN_TRAIN_ENDPOINT_ID) and never falls back
    // here. A training clause in this label was a tenant-visible lie and invited the wrong
    // inference that the shared pool already covers training because it covers backend.
    label: "Render (keyframes, video)",
    maxWorkers: 2,
    gpuTypeIds: BACKEND_GPUS,
    endpointVar: "RUNPOD_ENDPOINT_ID",
  },
  {
    ...pinned("upscale"),
    // VPC-BACKED, not dropped. Runs as a serve container on our own GPU boxes and is reached by
    // the tenant studio over a Workers VPC service binding, following the VIDEO_FINISH_VPC
    // precedent. A shared tenant keeps the FULL capability; only the TRANSPORT changes.
    backing: "vpc",
    label: "Video upscale",
    bindingName: "VIDEO_UPSCALE_VPC",
    serviceIdVar: "VIDEO_UPSCALE_VPC_SERVICE_ID",
  },
  {
    ...pinned("lipsync"),
    backing: "runpod",
    label: "Lip sync",
    maxWorkers: 1,
    gpuTypeIds: SATELLITE_GPUS,
    endpointVar: "MUSETALK_RUNPOD_ENDPOINT_ID",
  },
  {
    ...pinned("audio-upscale"),
    // OWN IRON, same ruling and same credential posture as the upscale entry above.
    backing: "vpc",
    label: "Audio upscale",
    bindingName: "AUDIO_UPSCALE_VPC",
    serviceIdVar: "AUDIO_UPSCALE_VPC_SERVICE_ID",
  },
];
export const planWorkerTotal = (plan: PlannedEndpoint[] = endpointBackedPlan()): number =>
  plan.reduce((n, e) => n + e.maxWorkers, 0);

export interface TenantR2Creds {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/**
 * Template env, HANDLER-side names (runpod-provision.py finding F17).
 *
 * The asymmetry is real and load-bearing, not a typo: satellites read/write R2 directly and require
 * R2_ENDPOINT_URL, while the backend requires R2_ENDPOINT (+ HF_HUB_OFFLINE). Getting this wrong
 * does not fail at provision; it fails at the tenant's FIRST FULL RENDER with an R2-mode error
 * (finding F10), which is the worst possible time to find out.
 */
export function templateEnv(key: PlannedEndpoint["key"], r2: TenantR2Creds): Record<string, string> {
  if (key === "backend") {
    return {
      R2_ACCESS_KEY_ID: r2.accessKeyId,
      R2_SECRET_ACCESS_KEY: r2.secretAccessKey,
      R2_BUCKET: r2.bucket,
      R2_ENDPOINT: r2.endpoint,
      HF_HUB_OFFLINE: "1",
    };
  }
  return {
    R2_ENDPOINT_URL: r2.endpoint,
    R2_ACCESS_KEY_ID: r2.accessKeyId,
    R2_SECRET_ACCESS_KEY: r2.secretAccessKey,
    R2_BUCKET: r2.bucket,
  };
}

export class RunPodError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${operation}: ${detail}`);
    this.name = "RunPodError";
  }
}

/** What the account's REAL quota is, read from RunPod itself rather than from the docs. */
/**
 * Why a preflight refused. The distinction drives DIFFERENT tenant actions, so collapsing them into
 * one "cannot provision" would send people to the wrong remedy: an unreadable quota is our problem
 * to look at, a small quota is theirs to fund or raise.
 */
export type QuotaRefusal = "quota_too_small" | "quota_unreadable";

export interface QuotaReading {
  /** The account-wide worker quota, or null when RunPod did not tell us. */
  quota: number | null;
  /** The largest workersMax this endpoint could take right now, when RunPod said so. */
  atMost: number | null;
  /** True when the plan fits. */
  fits: boolean;
  /** Set only when fits === false. */
  refusal?: QuotaRefusal;
  /** RunPod's own sentence, for honest surfacing. */
  raw?: string;
}

/**
 * Parse RunPod's quota validation error.
 *
 * This is the ONLY source for the account's real quota: it is not exposed on any GraphQL field and
 * introspection is disabled (#60). The published balance table is STALE (a $50-funded account was
 * observed at quota 10, where the table says 5), so the table is never trusted.
 *
 * "Deterministic and machine-parseable" turned out to be doing a lot of work in that sentence. The
 * wording ALREADY DRIFTED between #60's probe and this port, live, within the same sprint:
 *
 *   #60 recorded: "...will exceed your worker quota of 10 ... to at most 9"
 *   observed live: "...must not exceed your workers quota (10) ... to at most 9."
 *
 * `worker quota of N` -> `workers quota (N)`. A parser pinned to either exact phrasing silently
 * reads null, and because the preflight fails CLOSED, null means NO TENANT CAN EVER PROVISION. So
 * this matches both shapes and stays loose about the connective: the number is what we need, and
 * the sentence around it is not ours to depend on. If RunPod rewords it again, the preflight
 * refuses honestly (quota_unreadable, "this one is on us") rather than guessing -- which is the
 * whole reason that refusal is distinguished.
 */
export function parseQuotaError(message: string): { quota: number | null; atMost: number | null } {
  // "worker quota of 10" | "workers quota (10)" | "workers quota: 10"
  const quota = /workers?\s+quota\s*(?:of\s+|\(|:\s*)(\d+)/i.exec(message);
  const atMost = /at most\s+(\d+)/i.exec(message);
  return {
    quota: quota ? Number(quota[1]) : null,
    atMost: atMost ? Number(atMost[1]) : null,
  };
}

export class RunPodClient {
  // Same detached-global-fetch fix as CfApi: calling this.fetchImpl(...) rebinds `this` to the
  // instance and workerd rejects the global fetch with "Illegal invocation" (miniflare is lax, so
  // it would only bite on the first live endpoint create). Normalize to a bare-call wrapper once.
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly key: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = (input, init) => fetchImpl(input, init);
  }

  private async call<T>(operation: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${RUNPOD_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.key}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      // RunPod's own words, verbatim: the quota sentence in particular has to survive to the tenant.
      throw new RunPodError(operation, res.status, text.slice(0, 500));
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Endpoint list. Also the account-identity check: never create against the wrong account. */
  async listEndpoints(): Promise<{ id: string; name: string; workersMax?: number }[]> {
    const res = await this.call<unknown>("endpoints.list", "GET", "/endpoints");
    return normalizeList(res, "endpoints");
  }

  async listTemplates(): Promise<{ id: string; name: string }[]> {
    const res = await this.call<unknown>("templates.list", "GET", "/templates");
    return normalizeList(res, "templates");
  }

  async createTemplate(name: string, imageName: string, env: Record<string, string>, diskGb = 20) {
    return await this.call<{ id: string }>("templates.create", "POST", "/templates", {
      name,
      imageName,
      isServerless: true,
      containerDiskInGb: diskGb,
      env,
    });
  }

  /**
   * Rewrite an EXISTING template's env (#83). The adopt path depends on this: a template created on
   * an earlier provision carries that provision's R2 credential, and every provision mints a fresh
   * one. Without this the tenant's containers authenticate with a dead credential and the first
   * render dies on R2 auth, which is exactly how this was found.
   *
   * The env passed here is the COMPLETE template env (templateEnv builds it), so a full overwrite is
   * correct: there is no partial-merge case where a key we do not set must survive.
   */
  async updateTemplateEnv(templateId: string, env: Record<string, string>) {
    return await this.call<{ id: string }>("templates.update", "PATCH", `/templates/${templateId}`, { env });
  }

  /**
   * Rewrite an EXISTING template's IMAGE (cp#137).
   *
   * WHY THIS IS SEPARATE FROM updateTemplateEnv, and why a re-provision needs it at all:
   * createTenantEndpoints adopts a template BY NAME and rewrites its env, never its image. On a
   * fresh provision that is invisible (the template was created moments earlier, by this code, at
   * this pin). On a LONG-LIVED tenant it is the cp#126 rot wearing different clothes: the testbed's
   * four templates were still on backend 1.0.2 / upscale 0.2.7 / musetalk 0.1.0 / audio-upscale
   * 0.1.0, six-plus releases behind the pins this file resolves, so an adopt-only rebuild would have
   * put the endpoints back on stale bytes and read as done.
   *
   * The endpoint does not have to be recreated for this to bite: an endpoint resolves its image
   * THROUGH its template, so converging the template is what moves the pin.
   */
  async updateTemplateImage(templateId: string, imageName: string) {
    return await this.call<{ id: string }>("templates.update_image", "PATCH", `/templates/${templateId}`, {
      imageName,
    });
  }

  async createEndpoint(args: {
    name: string;
    templateId: string;
    gpuTypeIds: string[];
    workersMax: number;
    idleTimeout?: number;
  }) {
    return await this.call<{ id: string }>("endpoints.create", "POST", "/endpoints", {
      name: args.name,
      templateId: args.templateId,
      computeType: "GPU",
      gpuTypeIds: args.gpuTypeIds,
      gpuCount: 1,
      // Scale-to-zero: idle costs nothing. The whole GPU-rationing thesis in one field.
      workersMin: 0,
      workersMax: args.workersMax,
      idleTimeout: args.idleTimeout ?? 5,
      scalerType: "QUEUE_DELAY",
      scalerValue: 4,
    });
  }

  async deleteEndpoint(id: string): Promise<void> {
    await this.call<unknown>("endpoints.delete", "DELETE", `/endpoints/${id}`);
  }

  /** Read a template back. The live gate uses it to verify the pin RunPod HOLDS, not the one we sent. */
  async getTemplate(templateId: string): Promise<{ id: string; imageName: string }> {
    return await this.call<{ id: string; imageName: string }>(
      "templates.get",
      "GET",
      `/templates/${templateId}`,
    );
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.call<unknown>("templates.delete", "DELETE", `/templates/${id}`);
  }

  /**
   * Endpoint detail: the closest thing REST gives us to a worker view.
   *
   * There is NO worker-list on the REST API. GET /v1/endpoints/{id}/workers 400s with "that path
   * ... does not exist in the specification" (verified live), and the detail payload carries only
   * workersMin/workersMax/workersStandby, not running workers. A real worker list needs the legacy
   * GraphQL API.
   *
   * This matters for teardown verification ("list WORKERS, not just endpoints"): what REST can
   * honestly tell us is the endpoint's CONFIGURED capacity, which answers "can this thing scale up
   * and spend?" but not "is something running right now". Stated rather than papered over; the
   * GraphQL worker list is tracked separately if we need the stronger check.
   */
  async getEndpoint(endpointId: string): Promise<{ id: string; workersMin?: number; workersMax?: number; workersStandby?: number }> {
    return await this.call("endpoints.get", "GET", `/endpoints/${endpointId}`);
  }
}

/** RunPod's list payloads vary in shape; accept both the bare array and the wrapped forms. */
function normalizeList<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const wrapped = (payload as Record<string, unknown>)[key];
    if (Array.isArray(wrapped)) return wrapped as T[];
    const data = (payload as Record<string, unknown>).data;
    if (Array.isArray(data)) return data as T[];
  }
  return [];
}

/**
 * Quota preflight: does this plan fit on this account, and if not, say exactly why.
 *
 * Deliberately attempt-and-read rather than compute-and-hope: we ask RunPod for something we know
 * the quota shape of, and read the REAL numbers out of its refusal. Trusting the docs table here is
 * how you ship a provisioner that breaks on the accounts it was supposed to serve.
 */
export async function preflightQuota(
  client: RunPodClient,
  slug?: string,
  plan: PlannedEndpoint[] = endpointBackedPlan(),
): Promise<QuotaReading> {
  const existing = await client.listEndpoints();
  const existingSum = existing.reduce((n, e) => n + (e.workersMax ?? 0), 0);
  // Only NET-NEW endpoints add workers. Endpoints that already exist by name will be ADOPTED
  // (idempotent-by-name), so their workers are ALREADY in existingSum; counting the whole plan on
  // top double-counts a re-provision's OWN endpoints and permanently blocks retry after a partial
  // failure -- the tenant's own endpoints counting against them (#40 e2e burn). Without a slug (the
  // unit path) there is nothing to match against, so the whole plan is treated as net-new.
  const existingNames = new Set(existing.map((e) => e.name));
  const needed =
    slug === undefined
      ? planWorkerTotal(plan)
      : plan
          .filter((pl) => !existingNames.has(tenantEndpointName(slug, pl.key)))
          .reduce((n, pl) => n + pl.maxWorkers, 0);

  // Probe with a deliberately impossible workersMax so RunPod tells us the real quota in its
  // refusal. Nothing is created: the request is rejected at validation, before any resource exists.
  try {
    await client.createEndpoint({
      name: `vivijure-quota-probe-${Date.now().toString(36)}`,
      templateId: "quota-probe-not-a-real-template",
      gpuTypeIds: ["NVIDIA H200"],
      workersMax: 9999,
    });
    // Should not happen; if it ever does, the probe created nothing usable but we must not claim a
    // reading we do not have.
    return { quota: null, atMost: null, fits: existingSum + needed <= 9999 };
  } catch (e) {
    const raw = e instanceof RunPodError ? e.detail : String(e);
    const { quota, atMost } = parseQuotaError(raw);
    if (quota === null) {
      // RunPod refused for some OTHER reason (a bad template id will do it). We learned nothing
      // about the quota, and saying "fits" here would be a guess dressed as a fact. Fail CLOSED:
      // over-provisioning on the tenant's card, at the tenant's expense, is the one direction we
      // never fail.
      return { quota: null, atMost: null, fits: false, refusal: "quota_unreadable", raw };
    }
    const fits = existingSum + needed <= quota;
    return { quota, atMost, fits, ...(fits ? {} : { refusal: "quota_too_small" as const }), raw };
  }
}

/**
 * The tenant-facing sentence. The two refusals get DIFFERENT text on purpose: they need different
 * actions from different people. "Too small" is the tenant's to fix (free up workers, fund, or ask
 * RunPod to raise it). "Unreadable" is OURS to look at, and telling the tenant to go fund their
 * account for it would be actively wrong advice.
 */
export function quotaGuidance(reading: QuotaReading, plan: PlannedEndpoint[] = endpointBackedPlan()): string {
  const needed = planWorkerTotal(plan);
  if (reading.fits) return `Your RunPod account has room for all ${plan.length} endpoints.`;
  if (reading.refusal === "quota_unreadable") {
    return (
      "We could not read your RunPod account's worker quota, so we stopped rather than guess and " +
      "risk creating endpoints you did not agree to pay for. Nothing was created. This one is on " +
      "us: please get in touch and we will look at it."
    );
  }
  return (
    `Your RunPod account's worker quota is ${reading.quota}, and this studio needs ${needed} ` +
    "workers across 4 endpoints. Free up workers on your existing endpoints, or ask RunPod support " +
    "to raise the quota, then try again. Nothing was created."
  );
}

/** Deterministic per-tenant names. Idempotency (reuse-by-name) depends on these being stable. */
export const tenantEndpointName = (slug: string, key: string) => `vivijure-${slug}-${key}`;

export interface CreatedEndpoint {
  key: string;
  label: string;
  id: string;
  name: string;
  /** The studio env var that carries this endpoint id (spec.endpointVar). The provisioner wires it. */
  endpointVar: string;
}

/**
 * Create the tenant's 4 endpoints with THEIR key. Idempotent by name, exactly like
 * runpod-provision.py: an existing template/endpoint is REUSED, not duplicated, so a retry after a
 * partial failure does not litter the tenant's account with orphans.
 *
 * The key is a parameter and stays one: it is never captured in a field, never logged, never stored.
 */
export async function createTenantEndpoints(
  runpodApiKey: string,
  slug: string,
  r2: TenantR2Creds,
  plan: PlannedEndpoint[] = endpointBackedPlan(),
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedEndpoint[]> {
  const client = new RunPodClient(runpodApiKey, fetchImpl);

  // Fit-or-fail BEFORE creating anything: a half-provisioned RunPod account is the tenant's mess to
  // clean up, on their bill, so we refuse early with RunPod's real numbers instead of discovering
  // the wall on endpoint 3 of 4.
  const quota = await preflightQuota(client, slug, plan);
  if (!quota.fits) throw new RunPodError("quota.preflight", 400, quotaGuidance(quota, plan));

  const [templates, endpoints] = await Promise.all([client.listTemplates(), client.listEndpoints()]);
  const created: CreatedEndpoint[] = [];

  for (const spec of plan) {
    const name = tenantEndpointName(slug, spec.key);
    const env = templateEnv(spec.key, r2);
    const existingTemplate = templates.find((t) => t.name === name);
    const existingEndpoint = endpoints.find((e) => e.name === name);

    // THE TEMPLATE COMES FIRST, ALWAYS (#83). Previously an adopted endpoint short-circuited the
    // whole iteration and an adopted template was reused as-is, so the freshly-minted R2 credential
    // only ever reached a template we CREATED. Every provision mints a new credential, so an adopted
    // tenant rendered with a dead one and died at the first R2 read (401 HeadObject). Refreshing the
    // template before touching the endpoint means the fresh credential reaches every consumer BEFORE
    // anything can invalidate the old one.
    let templateId: string;
    if (existingTemplate) {
      await client.updateTemplateEnv(existingTemplate.id, env);
      templateId = existingTemplate.id;
    } else if (existingEndpoint) {
      // An endpoint we cannot trace to a template by name: we have nowhere to write the fresh
      // credential, so we CANNOT honestly claim this endpoint can render. Fail loudly rather than
      // hand back an endpoint that will 401 at the tenant's first render (the #83 failure mode).
      throw new RunPodError(
        "templates.refresh",
        409,
        `endpoint ${name} exists but no template named ${name} was found, so the freshly minted R2 ` +
          `credential cannot be written to it; refusing to report this endpoint as ready`,
      );
    } else {
      templateId = (
        await client.createTemplate(name, imageRef(spec.key), env)
      ).id;
    }

    if (existingEndpoint) {
      created.push({ key: spec.key, label: spec.label, id: existingEndpoint.id, name, endpointVar: spec.endpointVar });
      continue;
    }

    const endpoint = await client.createEndpoint({
      name,
      templateId,
      gpuTypeIds: spec.gpuTypeIds,
      // ALWAYS explicit. RunPod's default of 3 x 4 endpoints = 12 breaks provisioning outright.
      workersMax: spec.maxWorkers,
    });
    created.push({ key: spec.key, label: spec.label, id: endpoint.id, name, endpointVar: spec.endpointVar });
  }

  return created;
}

/**
 * The key-B console recipe for one tenant.
 *
 * WHY THIS IS CODE AND NOT UI COPY: the endpoint names and ids are DATA the provisioner just
 * created, and a human retyping them into a console is exactly where a wrong scope gets picked. The
 * recipe is generated from the tenant's actual endpoints so what someone is told to tick is what
 * was really built. Joan's phase-2 screen renders this; a human can also read it straight.
 *
 * This step exists because RunPod has no key-creation API and a key cannot be scoped to endpoints
 * that do not exist yet, which is what forces two-phase onboarding. It is the one irreducibly manual
 * step in the whole flow, so it had better be exact.
 */
export function invokeKeyRecipe(endpoints: CreatedEndpoint[]): {
  summary: string;
  steps: string[];
  endpoints: { key: string; label: string; id: string; name: string }[];
} {
  return {
    summary:
      "Create a second RunPod key that can ONLY run jobs on the 4 endpoints we just made for you. " +
      "This is the key your studio keeps.",
    steps: [
      "In the RunPod console, open Settings -> API Keys -> Create API Key.",
      "Set the key type to Restricted.",
      "Set api.runpod.io/graphql to None. (We will refuse a key that has GraphQL access: it can " +
        "create and delete anything on your whole account, and we will not store that.)",
      "Set api.runpod.ai to Restricted, then give Read/Write to EXACTLY these 4 endpoints and " +
        "nothing else:",
      ...endpoints.map((e) => `    - ${e.name}   (${e.label})`),
      "Create the key, copy it once, and paste it back here. We verify it against those 4 endpoints " +
        "before we store it; if it is wrong or too powerful, we reject it and tell you why.",
      "Then delete or rotate the FIRST key (the setup one) in the console. It has done its job and " +
        "we never kept it.",
    ],
    endpoints: endpoints.map((e) => ({ key: e.key, label: e.label, id: e.id, name: e.name })),
  };
}

/**
 * What converging ONE tenant template did. Reported per key so an operator SEES the pin move rather
 * than being told it was handled.
 */
export interface TemplateConvergence {
  key: SatelliteKey;
  name: string;
  /** null when no template of this name exists yet: the create path will make it AT the pin. */
  template_id: string | null;
  image_before: string | null;
  /** The pin this plane holds. On a change, this is what RunPod reported when READ BACK. */
  image_after: string;
  changed: boolean;
}

/**
 * Move a tenant's existing templates onto the pins the plane currently holds (cp#137).
 *
 * RUN BEFORE createTenantEndpoints, never after: the adopt path rewrites template ENV and reuses
 * whatever image the template already carried, so a template left un-converged silently decides what
 * the rebuilt endpoint runs.
 *
 * THE READ-BACK IS THE POINT. A PATCH answering 200 is the writing client's opinion of its own work;
 * what matters is the image RunPod HOLDS, which is what a worker actually pulls and what
 * `check:pins:prod` reads. A readback that disagrees THROWS rather than reporting a pin that did not
 * move.
 */
export async function convergeTenantTemplateImages(
  runpodApiKey: string,
  slug: string,
  plan: PlannedEndpoint[] = endpointBackedPlan(),
  fetchImpl: typeof fetch = fetch,
): Promise<TemplateConvergence[]> {
  const client = new RunPodClient(runpodApiKey, fetchImpl);
  const templates = (await client.listTemplates()) as { id: string; name: string; imageName?: string }[];
  const converged: TemplateConvergence[] = [];

  for (const spec of plan) {
    const name = tenantEndpointName(slug, spec.key);
    const want = imageRef(spec.key);
    const existing = templates.find((t) => t.name === name);

    if (!existing) {
      // Nothing to converge: createTenantEndpoints CREATES this template at imageRef(). Reported
      // rather than skipped silently, so an operator sees which half of the plan took which path.
      converged.push({ key: spec.key, name, template_id: null, image_before: null, image_after: want, changed: false });
      continue;
    }

    const before = existing.imageName ?? null;
    if (before === want) {
      converged.push({ key: spec.key, name, template_id: existing.id, image_before: before, image_after: want, changed: false });
      continue;
    }

    await client.updateTemplateImage(existing.id, want);
    const after = await client.getTemplate(existing.id);
    if (after.imageName !== want) {
      throw new RunPodError(
        "templates.converge",
        409,
        `template ${name} (${existing.id}) still reports image ${after.imageName} after being set to ` +
          `${want}; refusing to build an endpoint on a pin that did not move`,
      );
    }
    converged.push({ key: spec.key, name, template_id: existing.id, image_before: before, image_after: want, changed: true });
  }

  return converged;
}

/**
 * VPC service bindings for the vpc-backed plan capabilities (cp#396).
 *
 * Derived from PROVISION_PLAN, so adding a capability is a plan entry plus a deploy var, never an
 * edit here. A capability whose service id is absent binds NOTHING rather than an empty string: an
 * empty service_id uploads clean and fails at the tenant FIRST FINISH.
 */
export function vpcCapabilityBindings(serviceIds: Record<string, string | null>) {
  const out: { type: "vpc_service"; name: string; service_id: string }[] = [];
  for (const c of vpcBackedPlan()) {
    const id = serviceIds[c.serviceIdVar];
    if (id) out.push({ type: "vpc_service" as const, name: c.bindingName, service_id: id });
  }
  return out;
}
