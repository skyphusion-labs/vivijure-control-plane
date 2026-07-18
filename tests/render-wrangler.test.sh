#!/usr/bin/env bash
#
# Negative tests for scripts/render-wrangler.sh -- the config-render fail-closed guards.
#
# WHY THIS EXISTS: every guard here is watched FAILING before it is trusted. A guard that has only
# ever been observed passing is not a verified guard, it is an assumption with a green checkmark.
# There is also a POSITIVE CONTROL (the happy path), because a suite of negative tests over a
# broken script would pass unanimously: if the script errored on everything, every "expect failure"
# case would go green and the suite would report health while proving nothing.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
render="$here/scripts/render-wrangler.sh"
tmp="$(mktemp -d)"
trap "rm -rf $tmp" EXIT

pass=0
fail=0

# A complete, valid environment. Individual cases below break exactly ONE thing.
set_full_env() {
  export CLOUDFLARE_ACCOUNT_ID="0123456789abcdef0123456789abcdef"
  export CONTROL_PLANE_D1_ID="11111111-2222-3333-4444-555555555555"
  export TENANT_DISPATCH_NAMESPACE="vivijure-tenants"
  export TENANT_MODULE_NAMESPACE="vivijure-tenant-modules"
  export STUDIO_RELEASES_BUCKET="vivijure-studio-releases"
  export STUDIO_RELEASE="v1.0.0"
  export CONTROL_PLANE_HOST="studio.example.com"
  export CONTROL_PLANE_ZONE_NAME="example.com"
  export AUP_VERSION="1.0.0"
  export AUP_URL="https://example.com/aup"
  export POSTERN_SEND_URL="https://mail.example.com/api/send"
  export GOOGLE_OAUTH_CLIENT_ID="g-client"
  export GITHUB_OAUTH_CLIENT_ID="gh-client"
  export APPLE_TEAM_ID=""
  export APPLE_SERVICES_ID=""
}

check() {
  local name="$1" expect="$2"
  if [ "$expect" = "pass" ]; then
    if "$render" "$tmp/out.toml" >"$tmp/log" 2>&1; then
      echo "  ok   $name (rendered as expected)"; pass=$((pass + 1))
    else
      echo "  FAIL $name -- expected a successful render, got:"; sed "s/^/       /" "$tmp/log"; fail=$((fail + 1))
    fi
  else
    if "$render" "$tmp/out.toml" >"$tmp/log" 2>&1; then
      echo "  FAIL $name -- expected the guard to REFUSE, but the render succeeded"; fail=$((fail + 1))
    else
      echo "  ok   $name (guard refused, as it must)"; pass=$((pass + 1))
    fi
  fi
}

echo "render-wrangler guards:"

# POSITIVE CONTROL. Without this, a script that failed unconditionally would pass every case below.
set_full_env
check "positive control: a complete environment renders" pass

# The uuid-shape guard: the one standing between a typo and migrating a stranger database.
set_full_env; unset CONTROL_PLANE_D1_ID
check "missing CONTROL_PLANE_D1_ID is refused" fail

set_full_env; export CONTROL_PLANE_D1_ID="not-a-uuid"
check "malformed CONTROL_PLANE_D1_ID is refused" fail

# Empty-but-substituted: the case that sails past a placeholder scan.
set_full_env; export AUP_VERSION=""
check "empty AUP_VERSION is refused" fail

set_full_env; export CONTROL_PLANE_HOST=""
check "empty CONTROL_PLANE_HOST is refused" fail

set_full_env; export STUDIO_RELEASE=""
check "empty STUDIO_RELEASE is refused" fail

# AUP_URL immutable-ref guard (Ernst standing rule). The live value at extraction time was
# SHA-pinned and verified byte-identical to its advertised sha256; this keeps it that way.
set_full_env; export AUP_URL=""
check "empty AUP_URL is refused" fail

set_full_env; export AUP_URL="https://raw.githubusercontent.com/skyphusion-labs/vivijure-control-plane/main/docs/legal/aup/1.0.0.md"
check "AUP_URL on a moving ref (/main/) is refused" fail

set_full_env; export AUP_URL="https://raw.githubusercontent.com/o/r/refs/heads/release/aup.md"
check "AUP_URL on a moving ref (/refs/heads/) is refused" fail

# ...and the shapes that MUST still be allowed, or the guard is just breaking deployments. A
# self-hoster runs their own plane and hosts their own policy text wherever they like; the rule is
# immutability, not a prescribed host.
set_full_env; export AUP_URL="https://raw.githubusercontent.com/skyphusion-labs/vivijure-cf/8a5d96b4225d6154dceb3906d45d2ad0fb1a1841/docs/legal/hosted/aup/1.0.0.md"
check "SHA-pinned AUP_URL is allowed (the live value)" pass

set_full_env; export AUP_URL="https://example.com/policies/aup-1.0.0.md"
check "a self-hosted immutable AUP_URL is allowed" pass

echo ""
echo "  ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
