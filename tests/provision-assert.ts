// Narrowing helper for ProvisionOutcome (cf#85 extraction, fix-forward).
//
// WHY: ProvisionOutcome has TWO ok:false variants -- a real failure {step, message} and a
// ProvisionYielded {yielded:true, after} which is NOT a failure (budget ran out, progress persisted).
// `if (!res.ok)` therefore does NOT narrow to the failure, and every test that assumed it did was
// reading .step/.message off a union that may not carry them.
//
// This was invisible in vivijure-cf because its tsconfig `include` covered src/ but never tests/, so
// the control-plane suite was never typechecked. This repo typechecks tests, which is what surfaced it.

import type { ProvisionOutcome, ProvisionStep } from "../src/provisioner";

export interface ProvisionFailure {
  ok: false;
  step: ProvisionStep;
  message: string;
}

/** True only for a genuine failure, never for a budget yield. */
export function isProvisionFailure(res: ProvisionOutcome): res is ProvisionFailure {
  return res.ok === false && !("yielded" in res);
}

/** Asserts a real failure and returns it narrowed, so a yield can never masquerade as one. */
export function expectProvisionFailure(res: ProvisionOutcome): ProvisionFailure {
  if (!isProvisionFailure(res)) {
    throw new Error(
      `expected a provision FAILURE, got ${JSON.stringify(res)}` +
        ("yielded" in res ? " (this is a budget yield, not a failure)" : ""),
    );
  }
  return res;
}
