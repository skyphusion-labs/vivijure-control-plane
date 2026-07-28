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

# --------------------------------------------------------------------------------------------
# The injected values, split into REQUIRED and ALLOWED-EMPTY.
#
# This is an ALLOWLIST, and the direction matters. envsubst turns an unset variable into an empty
# string, so "empty" and "misspelled the variable name" and "forgot to set it" all render
# identically and all look fine. Guarding a hand-picked few (as the first cut of this script did)
# leaves every unguarded value silently defaultable to empty -- an empty TENANT_DISPATCH_NAMESPACE
# would have rendered a broken binding and deployed.
#
# So: everything is required unless it appears in ALLOW_EMPTY below, with a stated reason.
# --------------------------------------------------------------------------------------------
REQUIRED_VARS="CLOUDFLARE_ACCOUNT_ID CONTROL_PLANE_D1_ID TENANT_DISPATCH_NAMESPACE TENANT_MODULE_NAMESPACE STUDIO_RELEASES_BUCKET STUDIO_RELEASE CONTROL_PLANE_HOST CONTROL_PLANE_ZONE_NAME AUP_VERSION AUP_URL POSTERN_SEND_URL"

# ALLOW_EMPTY -- empty is a MEANINGFUL, intended value for exactly these four, not an oversight.
#
# Each is half of an SSO provider pair. A provider is OFFERED only when both its id and its secret
# are present, so an unconfigured provider is ABSENT rather than broken -- that is the designed
# behaviour, and empty is how it is expressed. They are additionally absent (not empty) as GitHub
# Actions repository variables, because the API rejects an empty variable value with a 422, so the
# workflow cannot even set them to the empty string it wants.
#
# Do NOT extend this list to silence a failing deploy. Adding a name here says "empty is correct
# for this value", which for anything above is false.
# cf#56 adds two more, and both meet the bar this list sets rather than being parked here to
# quiet a deploy:
#   TENANT_AI_GATEWAY_ID -- empty means this plane names no AI Gateway, so plan-enhance runs on the
#     free local Workers AI provider. The provisioner binds NEITHER GATEWAY_ID nor CF_AIG_TOKEN when
#     either is missing, so empty is a coherent working state and not a half-configured one.
#   R2_USAGE_ALERT_BYTES -- empty means no threshold, and the admin usage surface reports a
#     `no_threshold` verdict. An operator who has not chosen a number has not asked to be alerted.
#   TENANT_LLM_SPEND_ALLOWANCE_MICRO_USD (cp#195) -- empty means no allowance has been chosen, and
#     the settlement run reports every tenant UNBILLABLE rather than billing from the first
#     micro-USD. An unset knob is the absence of a decision, not a decision of zero.
#   TENANT_R2_STORAGE_QUOTA_MODE (cp#195) -- empty means "deny", the conservative posture and
#     today's behaviour. Deliberately the OPPOSITE default from the BYTES knob, where empty is OFF.
#   TENANT_R2_STORAGE_QUOTA_BYTES (cp#183) -- empty means no per-tenant storage ceiling, the same
#     state a self-hosted studio has by default. It meets the bar for the same reason as the two
#     above: an operator who has not chosen a byte count has not chosen a cap, and the plane binds
#     nothing rather than binding a number nobody picked. A non-empty MALFORMED value is a different
#     matter and is refused at the write paths, not here.
#   CREDITS_ENFORCING (cp#192) -- empty means COUNTING MODE: the credit ledger records and refuses
#     nothing. It meets the bar in the strongest way on this list, because empty is not merely
#     tolerable here, it is the ruled default: there is no purchase door yet, so no tenant can hold a
#     positive balance, and an enforcing default would refuse every submission. The read API reports
#     which mode produced every answer, so the state is observable rather than inferred.
#   MANUAL_CREDIT_CEILING_MICRO_USD (cp#193) -- empty means the documented default (USD 100) applies.
#     It meets the bar because the fallback is a real, safe, documented value rather than "no limit":
#     an unset ceiling still bounds a stray keystroke, which is the entire point of the knob.
ALLOW_EMPTY="GOOGLE_OAUTH_CLIENT_ID GITHUB_OAUTH_CLIENT_ID APPLE_TEAM_ID APPLE_SERVICES_ID TENANT_AI_GATEWAY_ID R2_USAGE_ALERT_BYTES TENANT_R2_STORAGE_QUOTA_BYTES CREDITS_ENFORCING MANUAL_CREDIT_CEILING_MICRO_USD TENANT_SPEND_DAILY_CEILING STUDIO_TOKEN_KEK_ENCRYPT_SLOT SMOKE_RENDER_COOLDOWN_SECONDS SMOKE_RENDER_DAILY_CAP SMOKE_RENDER_INFLIGHT_SECONDS TENANT_LLM_SPEND_ALLOWANCE_MICRO_USD TENANT_R2_STORAGE_QUOTA_MODE"

# Fail BEFORE rendering, so the error names the missing variable instead of surfacing later as a
# malformed toml the reader has to reverse-engineer.
missing=""
for v in $REQUIRED_VARS; do
  if [ -z "${!v:-}" ]; then
    missing="$missing $v"
  fi
done
if [ -n "$missing" ]; then
  echo "::error::required deploy value(s) unset or empty:$missing" >&2
  echo "  these are repository secrets or variables; see docs/deploy.md" >&2
  exit 1
fi

# Materialise the allowlisted ones as empty so the substitution is explicit rather than relying on
# envsubst treating unset as empty.
for v in $ALLOW_EMPTY; do
  export "$v"="${!v:-}"
done

# Substitute ONLY our known placeholders. A bare envsubst would also eat any other dollar-brace the
# template legitimately contains.
subst_list=""
for v in $REQUIRED_VARS $ALLOW_EMPTY; do
  subst_list="$subst_list \${$v}"
done
envsubst "$subst_list" < "$tpl" > "$out"

# Post-render: an unsubstituted placeholder means a name in the template that this script does not
# know about -- a template edit that never reached REQUIRED_VARS/ALLOW_EMPTY.
if grep -v "^[[:space:]]*#" "$out" | grep -qF "\${"; then
  echo "::error::unsubstituted placeholder in $out -- the template references a value this script does not inject" >&2
  grep -nF "\${" "$out" | grep -v ":[[:space:]]*#" >&2 || true
  exit 1
fi

# The D1 id is checked by SHAPE, not merely non-emptiness: a wrong-but-present id would migrate a
# stranger database, which is the one mistake here with no undo.
grep -Eq "database_id = \"[0-9a-f-]{36}\"" "$out" || {
  echo "::error::CONTROL_PLANE_D1_ID did not render to a uuid -- refusing to migrate or deploy against an unknown database" >&2
  exit 1
}

# AUP_URL must pin an IMMUTABLE ref (Ernst standing rule). An account accepts a SPECIFIC text and
# the plane records the sha256 it served; a URL that can change out from under an acceptance turns
# that record into an unverifiable claim.
#
# This refuses the unambiguously-moving refs rather than prescribing WHERE the AUP lives -- anyone
# running their own hosted plane hosts their own policy text, and a rule like "must be
# raw.githubusercontent with a 40-hex sha" would refuse legitimate deployments while catching no
# extra failure. A branch ref in the path is the actual defect.
aup_url="$(grep -E "^AUP_URL = " "$out" | head -1 | sed -E "s/^AUP_URL = \"(.*)\"$/\1/")"
# nocasematch because branch refs are not case-sensitive in practice: /blob/Main/ and /blob/HEAD/
# are the same moving ref as /blob/main/, and a case-sensitive glob waves them straight through.
# Found by driving this script with a 16-case corpus rather than reading the glob (Joan, 2026-07-18),
# which is the only way this class of gap surfaces -- every one of these LOOKED covered.
shopt -s nocasematch
case "$aup_url" in
  */main/*|*/master/*|*/head/*|*/develop/*|*/trunk/*|*/refs/heads/*)
    shopt -u nocasematch
    echo "::error::AUP_URL points at a MOVING ref ($aup_url) -- it must pin an immutable ref (commit SHA or tag), or an accepted policy text can change after acceptance" >&2
    exit 1
    ;;
esac
shopt -u nocasematch

# KNOWN AND ACCEPTED LIMITATION: a directory literally NAMED after a branch, sitting under an
# otherwise-pinned ref (.../<sha>/develop/aup.md), is refused too. That is a false positive and it
# fails CLOSED and LOUDLY -- the operator sees the error and renames the path. Refusing a safe URL
# is recoverable in seconds; accepting a moving one silently rewrites what an account agreed to.
# Not fixed, deliberately: distinguishing the two needs URL-shape parsing per forge, which is more
# machinery and more ways to be wrong than the case it would rescue.

echo "$out rendered and validated."
