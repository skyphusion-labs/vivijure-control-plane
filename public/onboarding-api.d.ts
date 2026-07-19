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

export interface JobStatus {
  status: string;
  step?: string;
  steps_done?: string[];
  error_step?: string;
  error_message?: string;
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
