// cp#195: the SHARED completeness vocabulary for every metered class.
//
// EXTRACTED RATHER THAN DUPLICATED, on mackaye's ruling (2026-07-28): the storage meter and the LLM
// meter must use the same field name with the same semantics, so nobody has to learn two
// vocabularies for the same idea. Two meters that each invented "did we actually see this window"
// is how one of them ends up meaning something subtly different, and the difference would only ever
// be discovered on a bill.
//
// THE IDEA, stated once here so neither meter has to restate it:
//
//   complete: true   we OBSERVED this window. The numbers are the whole truth for it. Bill them,
//                    including when they are zero, because an observed zero is a real zero.
//   complete: false  we did NOT fully observe this window. The numbers may be a floor, or may be
//                    nothing at all. UNBILLABLE. This is not "zero spend"; it is "we do not know".
//
// A meter that silently under-counts bills US, not the tenant, so a metered class must always be
// able to say "I do not know" and a consumer must always be able to tell that apart from a zero.

/**
 * The completeness half of any metered window. Both meters' result types extend this, so a consumer
 * can write ONE unbillable check that works for every class.
 */
export interface MeterWindow {
  /** ISO, inclusive. */
  window_start: string;
  /** ISO, exclusive, so consecutive windows PARTITION rather than overlap at the boundary. */
  window_end: string;
  complete: boolean;
  /** Why not, in the operator's words. NULL exactly when complete. Never an opaque code. */
  reason: string | null;
}

/**
 * The one unbillable check, so no consumer re-derives it and gets it subtly wrong.
 *
 * Deliberately NOT `!window.complete`: written out, a caller eventually writes `window.complete ===
 * false` somewhere and an undefined (a window from an older shape, a hand-built fixture) reads as
 * billable. This reads the flag as the assertion it is -- billable ONLY on an explicit true.
 */
export function isUnbillable(window: MeterWindow): boolean {
  return window.complete !== true;
}
