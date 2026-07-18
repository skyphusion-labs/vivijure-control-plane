#!/usr/bin/env bash
#
# Render the real wrangler.toml from wrangler.toml.example, injecting account-specific values from
# the environment. Used by .github/workflows/deploy.yml AND by tests/render-wrangler.test.sh.
#
# ONE SEAM, on purpose. If the workflow inlined this logic and the test re-implemented it, the test
# would prove the copy correct and the shipped path would be unverified. The thing under test is
# the thing that runs.
#
# Usage: scripts/render-wrangler.sh [output-path]   (default: wrangler.toml)
set -euo pipefail

out="${1:-wrangler.toml}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tpl="$here/wrangler.toml.example"

[ -f "$tpl" ] || { echo "::error::template not found: $tpl" >&2; exit 1; }

# Substitute ONLY our known placeholders. A bare envsubst would also eat any other dollar-brace the
# template legitimately contains.
VARS="\${CLOUDFLARE_ACCOUNT_ID} \${CONTROL_PLANE_D1_ID} \${TENANT_DISPATCH_NAMESPACE} \${TENANT_MODULE_NAMESPACE} \${STUDIO_RELEASES_BUCKET} \${STUDIO_RELEASE} \${CONTROL_PLANE_HOST} \${CONTROL_PLANE_ZONE_NAME} \${AUP_VERSION} \${AUP_URL} \${POSTERN_SEND_URL} \${GOOGLE_OAUTH_CLIENT_ID} \${GITHUB_OAUTH_CLIENT_ID} \${APPLE_TEAM_ID} \${APPLE_SERVICES_ID}"
envsubst "$VARS" < "$tpl" > "$out"

# FAIL CLOSED (1/2): an unsubstituted placeholder means a secret or variable is missing. wrangler
# would otherwise deploy the literal string as a database id, and the failure would surface much
# later somewhere confusing.
if grep -v "^[[:space:]]*#" "$out" | grep -qF "\${"; then
  echo "::error::unsubstituted placeholder in $out -- a required secret or variable is unset" >&2
  grep -nF "\${" "$out" | grep -v ":[[:space:]]*#" >&2 || true
  exit 1
fi

# FAIL CLOSED (2/2): empty-but-substituted is the nastier case. envsubst turns an UNSET variable
# into an empty string, which sails past the check above. A wrong-but-present D1 id would migrate a
# stranger database, so that one is checked by SHAPE, not merely non-emptiness.
grep -Eq "database_id = \"[0-9a-f-]{36}\"" "$out" || {
  echo "::error::CONTROL_PLANE_D1_ID did not render to a uuid -- refusing to migrate or deploy against an unknown database" >&2
  exit 1
}
grep -Eq "AUP_VERSION = \".+\"" "$out" || { echo "::error::AUP_VERSION empty after render" >&2; exit 1; }
grep -Eq "CONTROL_PLANE_HOST = \".+\"" "$out" || { echo "::error::CONTROL_PLANE_HOST empty after render" >&2; exit 1; }
grep -Eq "STUDIO_RELEASE = \".+\"" "$out" || { echo "::error::STUDIO_RELEASE empty after render -- provisioning would refuse 503 provisioner_unconfigured" >&2; exit 1; }
grep -Eq "AUP_URL = \".+\"" "$out" || { echo "::error::AUP_URL empty after render" >&2; exit 1; }

# AUP_URL must pin an IMMUTABLE ref (Ernst standing rule). An account accepts a SPECIFIC text and
# the plane records the sha256 it served; a URL that can change out from under an acceptance turns
# that record into an unverifiable claim.
#
# This refuses the unambiguously-moving refs rather than prescribing WHERE the AUP lives -- anyone
# running their own hosted plane hosts their own policy text, and a rule like "must be
# raw.githubusercontent with a 40-hex sha" would refuse legitimate deployments while catching no
# extra failure. A branch ref in the path is the actual defect.
aup_url="$(grep -E "^AUP_URL = " "$out" | head -1 | sed -E "s/^AUP_URL = \"(.*)\"$/\1/")"
case "$aup_url" in
  */main/*|*/master/*|*/refs/heads/*|*/HEAD/*)
    echo "::error::AUP_URL points at a MOVING ref ($aup_url) -- it must pin an immutable ref (commit SHA or tag), or an accepted policy text can change after acceptance" >&2
    exit 1
    ;;
esac

echo "$out rendered and validated."
