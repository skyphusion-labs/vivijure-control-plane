/**
 * Reading settings-backed platform switches.
 *
 * A switch is DISABLED unless the stored value explicitly enables it. `null` (the row was never
 * written), an empty string, whitespace, and any value that is not a recognised affirmative all
 * read as disabled, so the ABSENCE of a stored decision is never taken for a decision to enable.
 *
 * `getSetting` returns `string | null`, and comparing that against a single negative literal makes
 * every value except that one literal mean enabled, including `null` and including a value written
 * with the wrong case. Comparing against the affirmative set instead makes the unset and malformed
 * cases land on the same side, which is the side that requires no assumption about what an operator
 * meant.
 *
 * Deliberately the same shape as `parseEnforcing` in `credits.ts` rather than a second dialect for
 * the same job: one rule for reading an operator boolean, written once, used at every call site.
 */
export function settingEnabled(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1";
}
