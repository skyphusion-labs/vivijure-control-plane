// Types for the onboarding transport seam in onboarding-api.js. Hand-authored
// (the project has no build step) so tests/onboarding-transport.test.ts
// typechecks under the CI tsc gate. Runtime stays plain vanilla JS.

import type { InvokeKeyResponseBody, PlannedEndpoint } from "./onboarding-checks.js";

/** The ONE seam. A test replaces this and nothing else; every other input to
 *  createPlatformApi is real configuration the browser also passes. */
export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface PlatformApiOptions {
  /** "" (or omitted) means same-origin, which is the normal case. */
  apiBase?: string;
  /** EXPLICIT preview opt-in. Never inferred, never a fallback. */
  useMock?: boolean;
  /** Omitted in the browser. When omitted, fetch resolves through globalThis on
   *  every call, so stubbing the global after construction still works. */
  fetchImpl?: FetchImpl;
}

/** The transport-only invoke-key result: the REAL status and the parsed body,
 *  interpreted by checks.invokeKeyVerdict and by nothing here. */
export interface InvokeKeyTransportResult {
  status: number;
  body: InvokeKeyResponseBody;
}

export interface AcceptAupResult {
  ok: boolean;
  stale?: boolean;
  current?: string | null;
  error?: string | null;
  status?: number;
}

export interface PlatformConfig {
  signups_enabled?: boolean;
  aup_version?: string;
  auth_methods?: string[];
  tenant_domain_suffix?: string;
  /**
   * cp#439. True when this deploy can provision a tenant with NO RunPod key.
   *
   * When true the key input is OPTIONAL and a blank one must still be allowed to advance and to
   * submit: the provision route refuses a keyless provision only when this is false. A key that
   * IS supplied stays honoured either way (the BYO dedicated path).
   *
   * Absent from an older plane, so treat absent as false rather than as unknown.
   */
  shared_tier_available?: boolean;
}

export interface TenantEndpoint {
  key: string;
  label?: string;
  id?: string;
  name?: string;
}

export interface TenantView {
  id: string;
  slug: string;
  status: string;
  url?: string;
  endpoints?: TenantEndpoint[];
  /**
   * cp#439. Which render tier this tenant is on, or null while that is not yet decided.
   *
   * The two tiers need different screens. A SHARED tenant has no RunPod account and no key to
   * paste: its invoke-key install succeeds only on an EMPTY-bodied POST, and a posted key is
   * refused with invoke_key_not_accepted. A DEDICATED tenant must paste one.
   *
   * NULL means the tier is not settled yet, NOT dedicated. Treating null as dedicated is exactly
   * the bug cp#439 fixes. Optional here because an older plane does not send the field at all, so
   * absent and null must be handled the same way.
   */
  runpod_mode?: "shared" | "dedicated" | null;
}

export interface MeResponse {
  account?: { id: string; email: string };
  aup?: { required_version?: string; accepted?: boolean };
  tenant?: TenantView | null;
}

export interface AupCurrent {
  version?: string;
  url?: string;
  summary?: string;
}

export interface CostExample {
  job_id: string;
  rendered_on: string;
  description: string;
  wall_clock_ms: number;
  gpu_hourly_usd: number;
  gpu_label: string;
  rate_checked_on: string;
}

export interface ProvisionPlan {
  endpoints: PlannedEndpoint[];
  cost_example?: CostExample;
}

export interface CapacityResponse {
  quota: number | null;
  existing_worker_sum: number | null;
}

export interface ProvisionStarted {
  tenant_id: string;
  job_id: string;
}

/** The job payload as the route reports it (cp#43). `step`, `steps_done` and
 *  `error_step` carry the provisioner OWN step names, never a UI vocabulary. */
export interface JobStatus {
  kind?: string;
  status: string;
  step?: string | null;
  steps_done?: string[];
  error_step?: string | null;
  error_message?: string | null;
  from_release?: string | null;
  to_release?: string | null;
  finished_at?: string | null;
}

/** An error thrown by json(): carries the REAL status and parsed body so the
 *  caller can branch on them (409 runpod_key_required, for one). */
export interface PlatformApiError extends Error {
  status?: number;
  body?: Record<string, unknown>;
}

export interface PlatformApi {
  json(path: string, init?: RequestInit): Promise<Record<string, unknown>>;
  config(): Promise<PlatformConfig>;
  me(): Promise<MeResponse>;
  aup(): Promise<AupCurrent | null>;
  acceptAup(version: string | null): Promise<AcceptAupResult>;
  slugAvailable(slug: string): Promise<{ available: boolean; reason?: string }>;
  plan(): Promise<ProvisionPlan>;
  capacity(key: string): Promise<CapacityResponse>;
  provision(slug: string, key: string): Promise<ProvisionStarted>;
  job(tenantId: string): Promise<JobStatus>;
  retry(tenantId: string, key?: string): Promise<{ job_id: string }>;
  invokeKey(tenantId: string, key: string): Promise<InvokeKeyTransportResult>;
}

export function createPlatformApi(opts?: PlatformApiOptions): PlatformApi;

/** The preview-only responses. Exported so tests can assert the mock shapes
 *  match the shapes the routes actually serve, rather than drifting quietly. */
export const mockResponses: {
  config(): PlatformConfig;
  me(): MeResponse;
  slugAvailable(slug: string): { available: boolean; reason?: string };
  plan(): ProvisionPlan;
  capacity(): CapacityResponse;
  provision(): ProvisionStarted;
  job(): JobStatus;
  invokeKey(): InvokeKeyTransportResult;
};

export const mockTenant: TenantView;
