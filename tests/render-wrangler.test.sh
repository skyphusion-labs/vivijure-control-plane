#!/usr/bin/env bash
#
# Negative tests for scripts/render-wrangler.sh -- the config-render fail-closed guards.
#
# WHY THIS EXISTS: every guard here is watched FAILING before it is trusted. A guard that has only
# ever been observed passing is not a verified guard, it is an assumption with a green checkmark.
# There is also a POSITIVE CONTROL, because a suite of negative tests over a broken script passes
# unanimously: if the script errored on everything, every "expect failure" case would go green and
# the suite would report health while proving nothing.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
render="$here/scripts/render-wrangler.sh"
tmp="$(mktemp -d)"
trap "rm -rf $tmp" EXIT

pass=0
fail=0

# A complete, valid environment, matching how the repo is ACTUALLY configured.
#
# Note what is deliberately NOT set here: the four SSO ids. They are absent as GitHub Actions
# variables (the API 422s an empty variable value), and empty is their intended meaning -- a
# provider is offered only when both halves are present. The base environment mirrors production
# rather than a tidier hypothetical, so the positive control proves the REAL configuration renders.
set_full_env() {
  unset GOOGLE_OAUTH_CLIENT_ID GITHUB_OAUTH_CLIENT_ID APPLE_TEAM_ID APPLE_SERVICES_ID
  export CLOUDFLARE_ACCOUNT_ID="0123456789abcdef0123456789abcdef"
  export CONTROL_PLANE_D1_ID="11111111-2222-3333-4444-555555555555"
  export TENANT_DISPATCH_NAMESPACE="vivijure-tenants"
  export TENANT_MODULE_NAMESPACE="vivijure-tenant-modules"
  export STUDIO_RELEASES_BUCKET="vivijure-studio-releases"
  export STUDIO_RELEASE="v1.2.0"
  export CONTROL_PLANE_HOST="studio.example.com"
  export CONTROL_PLANE_ZONE_NAME="example.com"
  export AUP_VERSION="1.0.0"
  export AUP_URL="https://raw.githubusercontent.com/o/r/8a5d96b4225d6154dceb3906d45d2ad0fb1a1841/aup.md"
  export POSTERN_SEND_URL="https://mail.example.com/api/send"
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
check "positive control: the real production shape renders" pass

# EVERY required value, each broken one at a time, unset AND empty. The earlier cut of this script
# guarded only a hand-picked few, which left the rest silently defaultable to empty -- an empty
# TENANT_DISPATCH_NAMESPACE would have rendered a broken binding and deployed clean.
for v in CLOUDFLARE_ACCOUNT_ID CONTROL_PLANE_D1_ID TENANT_DISPATCH_NAMESPACE TENANT_MODULE_NAMESPACE STUDIO_RELEASES_BUCKET STUDIO_RELEASE CONTROL_PLANE_HOST CONTROL_PLANE_ZONE_NAME AUP_VERSION AUP_URL POSTERN_SEND_URL; do
  set_full_env; unset "$v"
  check "unset $v is refused" fail
  set_full_env; export "$v"=""
  check "empty $v is refused" fail
done

# The D1 id is shape-checked, because a wrong-but-present id migrates a stranger database.
set_full_env; export CONTROL_PLANE_D1_ID="not-a-uuid"
check "malformed CONTROL_PLANE_D1_ID is refused" fail

# AUP_URL immutable-ref guard (the standing rule from Ernst).
set_full_env; export AUP_URL="https://raw.githubusercontent.com/o/r/main/docs/aup/1.0.0.md"
check "AUP_URL on a moving ref (/main/) is refused" fail

set_full_env; export AUP_URL="https://raw.githubusercontent.com/o/r/refs/heads/release/aup.md"
check "AUP_URL on a moving ref (/refs/heads/) is refused" fail

# The gaps a 16-case corpus found that reading the glob did not (Joan, 2026-07-18). Every one of
# these was ACCEPTED by the first version of the guard, which looked correct to two readers.
# Reproduced against the real script before patching, and watched flip from accepted to refused.
set_full_env; export AUP_URL="https://raw.githubusercontent.com/o/r/raw/develop/aup.md"
check "AUP_URL on a moving ref (/develop/) is refused" fail

set_full_env; export AUP_URL="https://github.com/o/r/blob/trunk/aup.md"
check "AUP_URL on a moving ref (/trunk/) is refused" fail

set_full_env; export AUP_URL="https://github.com/o/r/blob/head/aup.md"
check "AUP_URL on a moving ref (lowercase /head/) is refused" fail

# Case variants: a branch ref is the same moving ref whatever its casing, and the original glob
# was case-sensitive, so /Main/ and /HEAD/ sailed through while /main/ was caught.
set_full_env; export AUP_URL="https://github.com/o/r/blob/Main/aup.md"
check "AUP_URL case variant (/Main/) is refused" fail

set_full_env; export AUP_URL="https://github.com/o/r/blob/HEAD/aup.md"
check "AUP_URL case variant (/HEAD/) is refused" fail

# ...and the shapes that MUST still be allowed, or the guard is just breaking deployments. A
# self-hoster runs their own plane and hosts their own policy text wherever they like; the rule is
# immutability, not a prescribed host.
set_full_env; export AUP_URL="https://example.com/policies/aup-1.0.0.md"
check "a self-hosted immutable AUP_URL is allowed" pass

# The widened glob must not have started eating legitimate pins. Allow-side control for the
# develop/trunk/head additions specifically: a guard that refuses everything passes every refusal
# case above and is worthless.
set_full_env; export AUP_URL="https://github.com/o/r/blob/v1.2.3/docs/aup.md"
check "a TAG-pinned AUP_URL is allowed" pass

set_full_env; export AUP_URL="https://raw.githubusercontent.com/o/r/8a5d96b4225d6154dceb3906d45d2ad0fb1a1841/docs/legal/hosted/aup/1.0.0.md"
check "the live SHA-pinned AUP_URL is still allowed" pass

# THE ALLOWLIST, both directions. These four are the ONLY values where empty is correct.
set_full_env; export GOOGLE_OAUTH_CLIENT_ID="" GITHUB_OAUTH_CLIENT_ID="" APPLE_TEAM_ID="" APPLE_SERVICES_ID=""
check "explicitly-empty SSO ids are allowed (provider simply not offered)" pass

set_full_env; export GOOGLE_OAUTH_CLIENT_ID="g-client" GITHUB_OAUTH_CLIENT_ID="gh-client"
check "populated SSO ids are allowed" pass

echo ""
echo "  ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
