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
export const KEY_PREFIX: string;

export function keyShapeHint(raw: string | null | undefined): KeyShapeHint;
export function slugHint(raw: string | null | undefined): SlugHint;
export const SLUG_RESERVED: string[];
export function scopeVerdict(probe: ScopeProbe | null | undefined): ScopeVerdict;
export const REJECTION_COPY: Record<string, string>;

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
