/**
 * The control planes own version. This repository versions and deploys
 * independently of vivijure-cf: a v* tag HERE deploys the control plane; a v*
 * tag in vivijure-cf deploys the Studio panel.
 *
 * Kept in lockstep with package.json by tests/version.test.ts, so cutting a tag
 * without bumping the manifest fails the gate instead of shipping a lie.
 */
export const CONTROL_PLANE_VERSION = "1.2.1";
