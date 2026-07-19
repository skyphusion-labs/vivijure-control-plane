// Types for the pure onboarding helpers in onboarding-checks.js. Hand-authored
// (the project has no build step) so tests/onboarding-checks.test.ts typechecks
// under the CI tsc gate. Runtime stays plain vanilla JS.

export interface OnboardingStep {
  key: string;
  title: string;
}

export interface KeyShapeHint {
  level: "empty" | "warn" | "ok";
  message: string;
}

export interface SlugHint {
  level: "empty" | "warn" | "ok";
  valid: boolean;
  message: string;
}

/**
 * One endpoint in the provisioning plan. This is DATA from the control plane
 * (owned by the provisioner, #54), not a UI constant: the review screen renders
 * whatever rows the plan carries.
 */
export interface PlannedEndpoint {
  key: string;
  label: string;
  purpose: string;
  image: string;
  max_workers: number;
  gpu?: string;
}

export interface QuotaFit {
  fits: boolean;
  known: boolean;
  needed: number;
  available: number | null;
  quota: number | null;
  message: string;
  guidance: string[];
}

/**
 * The control plane's live scope probe of key B (#60-proven probes):
 * `health` maps each created endpoint id to whether GET /health succeeded, and
 * `graphql_denied` records that a graphql call was refused.
 */
export interface ScopeProbe {
  health?: Record<string, boolean>;
  graphql_denied?: boolean;
}

export interface ScopeVerdict {
  ok: boolean;
  failures: string[];
  message: string;
}

export interface OnboardingState {
  rulesAccepted?: boolean;
  keyPresent?: boolean;
  capacity?: QuotaFit | null;
  confirmed?: boolean;
  invokeVerified?: boolean;
  slugValid?: boolean;
  slugAvailable?: boolean;
}

export const STEPS: OnboardingStep[];

/** The dated, real render cited by the intro cost line. wall_clock_ms is a
 *  ceiling (see costCeilingUsd), and every field travels so the number can be
 *  audited. */
export interface RepresentativeCostExample {
  job_id: string;
  rendered_on: string;
  description: string;
  wall_clock_ms: number;
  gpu_hourly_usd: number;
  gpu_label: string;
  rate_checked_on: string;
}

/** The static, clearly-labelled example the INTRO renders with no network
 *  call. The real plan is fetched later, behind the sign-in, for the Review
 *  step. See REPRESENTATIVE_PLAN in onboarding-checks.js for why. */
export interface RepresentativePlan {
  endpoints: PlannedEndpoint[];
  cost_example: RepresentativeCostExample;
}
export const REPRESENTATIVE_PLAN: RepresentativePlan;
export const KEY_PREFIX: string;

export function keyShapeHint(raw: string | null | undefined): KeyShapeHint;
export function slugHint(raw: string | null | undefined): SlugHint;
export const SLUG_RESERVED: string[];
export function scopeVerdict(probe: ScopeProbe | null | undefined): ScopeVerdict;
export const REJECTION_COPY: Record<string, string>;

/** What the customer is told after an invoke-key attempt, derived PURELY from
 *  the HTTP status plus the real response body. See invokeKeyVerdict in
 *  onboarding-checks.js for why there is no summary field to branch on. */
export interface InvokeKeyVerdict {
  /** The go-live COMPLETED. False on 202 (installed, not yet live) -- which is
   *  not a failure; read `pending` to tell the two apart. */
  ok: boolean;
  /** good: live and fully proven. warn: live, readiness unproven. pending: 202.
   *  bad: a real failure. Drives the callout styling only. */
  tone: 'good' | 'warn' | 'pending' | 'bad';
  live: boolean;
  pending: boolean;
  /** Whether the control plane is holding the key. True on 200 AND on 202. */
  keyStored: boolean;
  /** Blank the key input? True ONLY when the KEY itself was refused. Never on
   *  202: clearing there causes the re-paste that response exists to prevent. */
  clearKey: boolean;
  message: string;
  notes: string[];
  failures: string[];
}

export interface InvokeKeyResponseBody {
  status?: string;
  verified_endpoints?: number;
  modules_ready?: boolean;
  modules_verified?: string[];
  modules_unconfirmed?: string[];
  /**
   * OBJECTS, not strings. The route spreads ModuleReadiness.unverified verbatim,
   * which is UnverifiedModule[] (src/tenant-modules.ts). Typing this as string[]
   * is what let `.join(", ")` ship "[object Object]" to a customer.
   */
  modules_unverified?: { module: string; reason?: string; detail?: string; script?: string }[];
  message?: string;
  error?: string;
  reason?: string;
  step?: string;
}

export function invokeKeyVerdict(
  httpStatus: number,
  body: InvokeKeyResponseBody | null | undefined,
): InvokeKeyVerdict;

export interface AupAcceptFailure {
  ok?: boolean;
  stale?: boolean;
  current?: string | null;
  error?: string | null;
  status?: number;
}
export function aupAcceptFailureCopy(res: AupAcceptFailure | null | undefined): string;

export interface AupUrlPinning {
  /** pinned: a commit SHA or version tag. moving: a branch that can change under a recorded
   *  acceptance. unverifiable: not a forge URL, cannot be judged client-side. missing: no URL. */
  state: "pinned" | "moving" | "unverifiable" | "missing";
  movingRef: string | null;
}
export function aupUrlPinning(url: string | null | undefined): AupUrlPinning;
export function aupPinningRefusalCopy(pinning: AupUrlPinning | null | undefined): string;
export function invokeRejectionCopy(
  reason: string | null | undefined,
  detail?: string | null,
): string;
export function planWorkerTotal(plan: PlannedEndpoint[] | null | undefined): number;
export function quotaFit(
  quota: number | null | undefined,
  existingWorkerSum: number | null | undefined,
  plan: PlannedEndpoint[] | null | undefined,
): QuotaFit;
export function costCeilingUsd(
  wallClockMs: number | null | undefined,
  hourlyRateUsd: number | null | undefined,
): number | null;
export function formatUsd(amount: number | null | undefined): string | null;
export function stepIndex(key: string): number;
export function canAdvance(key: string, state: OnboardingState | null | undefined): boolean;
