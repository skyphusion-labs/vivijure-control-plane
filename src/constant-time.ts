// Constant-time equality, as a LEAF module (cp#290).
//
// WHY IT IS ITS OWN FILE, which is the only interesting thing about 20 lines of loop. The poll half
// of the RunPod proxy is required to be structurally incapable of metering: runpod-proxy-poll.ts
// imports nothing from the metering half and holds no store, and tests/runpod-proxy-poll.test.ts
// asserts that import graph. The poll ROUTE has to authenticate its caller, and authentication
// needs a constant-time compare -- which already existed, exported from runpod-proxy.ts, the file
// that imports the store.
//
// Importing it from there would have reconnected the graph THROUGH a helper: the direct-import
// assertion would still pass (the specifier is `./runpod-proxy`, and the test would in fact catch
// that one) while a transitive path to the store came back. Duplicating the twenty lines would pass
// every test and leave two copies to drift.
//
// So it moves DOWN instead of sideways. Both halves depend on a leaf that depends on nothing, the
// separation stays a property of the module graph rather than of anyone's care, and there is still
// exactly one implementation. runpod-proxy.ts re-exports `tokensMatch` from here so its own callers
// and tests are untouched.

/**
 * Compare two strings in time that does not depend on WHERE they first differ.
 *
 * The loop runs over the full length and accumulates, so an attacker cannot recover a secret one
 * byte at a time from response timing. The LENGTH check short-circuits deliberately: a length
 * difference is not a secret worth protecting here (every value compared through this function is a
 * fixed-width hex string), and treating it as one would mean padding, which is more code to get
 * wrong than it saves.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
