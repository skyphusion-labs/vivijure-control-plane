/**
 * The control plane's RELEASE version. This repository versions and deploys
 * independently of vivijure-cf: a v* tag HERE deploys the control plane; a v*
 * tag in vivijure-cf deploys the Studio panel.
 *
 * Kept in lockstep with package.json by tests/version.test.ts, so cutting a tag
 * without bumping the manifest fails the gate instead of shipping a lie.
 *
 * RELEASE vs BUILD (cp#289): this constant answers "which release". It does NOT
 * answer "which build". Two deploys at the same tag share this string; distinguish
 * them via CF_VERSION_METADATA on GET /api/platform/version (`build.id` /
 * `build.timestamp`), or via the Worker artifact (`modified_on`).
 */
export const CONTROL_PLANE_VERSION = "1.29.0";
