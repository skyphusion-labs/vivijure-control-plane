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
 * A plan capability is satisfied EITHER by a RunPod endpoint we provision, OR by hardware we
 * already own and run ourselves. Modelled as a DISCRIMINATED UNION rather than a nullable field,
 * so the compiler enumerates every site that assumed an endpoint id exists.
 *
 * WHY THE SPLIT EXISTS AT ALL. The shared invoke key is endpoint-scoped, and it was minted with NO
 * access to vivijure-video-upscale or vivijure-audio-upscale: those two run as long-lived serve
 * containers on our own GPU boxes. SHARED_RUNPOD_ENDPOINTS is all-or-nothing across plan keys, so
 * before this split the correct pool config could not be WRITTEN AT ALL -- four keys demanded, two
 * of which must not exist. The ruling lived in the credential and not in the code, and nothing
 * could report the disagreement.
 *
 * A CAPABILITY IS NEVER REMOVED FROM A TENANT, ONLY RE-ROUTED. A shared tenant keeps the full
 * upscale capability and reaches our iron instead of RunPod, so it consumes no RunPod quota, needs
 * no pool entry, and carries no endpoint id.
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
   * workersMax across all endpoints (#60).
   */
  maxWorkers: number;
  gpuTypeIds: string[];
  /** The studio secret that carries this endpoint id. */
  endpointVar: string;
}

/**
 * ONE DOOR onto one GPU box. A vpc-backed capability has a POOL of these, one per box that serves
 * it, because that is what the module reads: vivijure-cf builds `doorPool([...])` from a candidate
 * per box and round-robins with `pickDoor`.
 *
 * The FIRST entry is the LEGACY door and its ordering is load-bearing, not cosmetic. Its binding
 * carries the bare `DOOR_ROUTE_NAME`, which is what an in-flight poll token carries, and
 * `resolveDoor` is a LOOKUP by name rather than a pick -- polling any door but the one that minted
 * a job reports a live job as GONE. So the legacy door must keep its position and its name.
 */
export interface PlannedDoor {
  /** The vpc_service binding name the MODULE worker reads. */
  bindingName: string;
  /** The secret binding name this door bearer is read from. */
  doorTokenBinding: string;
  /** Plane env var holding the Connectivity Directory service id for this door. */
  serviceIdVar: string;
  /** Plane env var holding this door bearer (the container LOCAL_FINISH_TOKEN). */
  doorTokenVar: string;
}

/**
 * A capability served by hardware we own and operate, reached by the tenant MODULE WORKER over a
 * Workers VPC service binding instead of RunPod.
 *
 * THE BINDING GOES ON THE MODULE, NOT ON THE STUDIO, and that is the whole contract. Upscale is a
 * module capability: the studio dispatches to a module worker, and the module worker is what talks
 * to RunPod or to a door. A binding attached to the studio under a name nothing reads would upload
 * clean and change nothing.
 *
 * The names are NOT ours to choose. They are what vivijure-cf modules already declare (cf#480,
 * present in the pinned v1.28.0), and at that tag BOTH modules build a POOL rather than a single
 * route:
 *
 *   modules/finish-upscale   FINISH_UPSCALE_VPC + FINISH_DOOR_TOKEN            (legacy, fatmike)
 *                            FINISH_UPSCALE_VPC_PROPAGANDHI + _TOKEN_PROPAGANDHI
 *   modules/speech-upscale   SPEECH_UPSCALE_VPC + SPEECH_DOOR_TOKEN            (legacy, fatmike)
 *                            SPEECH_UPSCALE_VPC_PROPAGANDHI + _TOKEN_PROPAGANDHI
 *
 * modules/_shared/finish-door.ts branches on the pool being NON-EMPTY, never on RunPod failing: a
 * door-to-RunPod failover would silently re-rent the GPU this change exists to stop renting, with
 * every signal still green. Same rule as the cp#288 proxy pair.
 *
 * NO maxWorkers AND NO endpointVar, on purpose rather than by omission. There is no RunPod quota to
 * spend and no endpoint id to bind, and a nullable field here would let an empty string reach a
 * module as an endpoint id, which fails at the tenant FIRST RENDER instead of at provision.
 */
export interface PlannedVpcCapability extends PlannedCapabilityBase {
  backing: "vpc";
  /** Every door onto this capability, legacy first. At least one must be configured to provision. */
  doors: PlannedDoor[];
}

export type PlannedCapability = PlannedEndpoint | PlannedVpcCapability;

/** One door, RESOLVED: the module binding names from the plan plus the values that fill them.
 *  Lives here beside PlannedDoor rather than in deps.ts, so provisioner and tenant-modules can name
 *  it without importing the wiring module and creating a cycle. */
export interface ResolvedDoor {
  bindingName: string;
  doorTokenBinding: string;
  serviceId: string;
  token: string;
}

/**
 * The narrowing every consumer that needs an endpoint id must go through. A type guard rather than
 * a filter on a string field, so a caller cannot reach `endpointVar` on an own-iron entry without
 * the compiler objecting. That is the safety property.
 */
export const isEndpointBacked = (c: PlannedCapability): c is PlannedEndpoint => c.backing === "runpod";

/** Only the entries a RunPod endpoint must exist for. */
export const endpointBackedPlan = (plan: PlannedCapability[] = PROVISION_PLAN): PlannedEndpoint[] =>
  plan.filter(isEndpointBacked);

/** Only the entries served by our own hardware. Exported so the UI can SAY so rather than omit them. */
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
    // OWN IRON (cp#396). Always-on serve containers on BOTH fatmike and propagandhi, reached by the
    // finish-upscale MODULE worker over a Workers VPC binding. NOT dropped: a tenant keeps the full
    // capability and only the TRANSPORT changes.
    //
    // TWO DOORS, legacy first. The tenant module pools them exactly as the operator studio does;
    // binding one would concentrate every tenant render on one box while the other idled, with no
    // signal attached to the difference.
    backing: "vpc",
    label: "Video upscale",
    doors: [
      {
        bindingName: "FINISH_UPSCALE_VPC",
        doorTokenBinding: "FINISH_DOOR_TOKEN",
        serviceIdVar: "FINISH_UPSCALE_VPC_SERVICE_ID",
        doorTokenVar: "FINISH_DOOR_TOKEN",
      },
      {
        bindingName: "FINISH_UPSCALE_VPC_PROPAGANDHI",
        doorTokenBinding: "FINISH_DOOR_TOKEN_PROPAGANDHI",
        serviceIdVar: "FINISH_UPSCALE_PROPAGANDHI_VPC_SERVICE_ID",
        doorTokenVar: "FINISH_DOOR_TOKEN_PROPAGANDHI",
      },
    ],
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
    ...pinned("wan-train"),
    backing: "runpod",
    label: "Cast LoRA training (Wan)",
    maxWorkers: 2,
    gpuTypeIds: BACKEND_GPUS,
    endpointVar: "RUNPOD_WAN_TRAIN_ENDPOINT_ID",
  },
  {
    ...pinned("audio-upscale"),
    // OWN IRON, same ruling, same credential posture and the same two boxes as the upscale entry.
    backing: "vpc",
    label: "Audio upscale",
    doors: [
      {
        bindingName: "SPEECH_UPSCALE_VPC",
        doorTokenBinding: "SPEECH_DOOR_TOKEN",
        serviceIdVar: "SPEECH_UPSCALE_VPC_SERVICE_ID",
        doorTokenVar: "SPEECH_DOOR_TOKEN",
      },
      {
        bindingName: "SPEECH_UPSCALE_VPC_PROPAGANDHI",
        doorTokenBinding: "SPEECH_DOOR_TOKEN_PROPAGANDHI",
        serviceIdVar: "SPEECH_UPSCALE_PROPAGANDHI_VPC_SERVICE_ID",
        doorTokenVar: "SPEECH_DOOR_TOKEN_PROPAGANDHI",
      },
    ],
  },
];

/**
 * The tenant-visible projection of PROVISION_PLAN (cp#474).
 *
 * The review step used to GET /api/tenant/provision-plan, a route this plane has never served,
 * so every walk of the wizard rendered an empty plan at the last stop before anything is created.
 * This is that route's body, derived from the same array the provisioner builds from: adding a
 * capability grows a review row with no second list to keep in step.
 *
 * max_workers is null on own-iron rows. There is no RunPod quota to spend there, and a zero would
 * look like a pin rather than an absence.
 */
export interface ProvisionPlanRow {
  key: string;
  label: string;
  backing: "runpod" | "vpc";
  image: string;
  max_workers: number | null;
  gpu: string;
}

export function provisionPlanView(plan: PlannedCapability[] = PROVISION_PLAN): ProvisionPlanRow[] {
  return plan.map((cap) => {
    if (isEndpointBacked(cap)) {
      return {
        key: cap.key,
        label: cap.label,
        backing: "runpod",
        image: imageRef(cap.key),
        max_workers: cap.maxWorkers,
        gpu: cap.gpuTypeIds.join(" / "),
      };
    }
    return {
      key: cap.key,
      label: cap.label,
      backing: "vpc",
      image: imageRef(cap.key),
      max_workers: null,
      gpu: "our hardware",
    };
  });
}


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

/**
 * The tenant-facing sentence. The two refusals get DIFFERENT text on purpose: they need different
 * actions from different people. "Too small" is the tenant's to fix (free up workers, fund, or ask
 * RunPod to raise it). "Unreadable" is OURS to look at, and telling the tenant to go fund their
 * account for it would be actively wrong advice.
 */

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
