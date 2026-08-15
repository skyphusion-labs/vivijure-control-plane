#!/usr/bin/env bash
#
# Tests for scripts/check-aup-pin.sh -- the gate that stops the AUP LABEL and the AUP POINTER
# from moving independently (cp#396).
#
# WHY THIS EXISTS: the defect this gate prevents is one that already happened, silently, and sat
# armed for a day. So every refusal here is watched FAILING against a reconstruction of the real
# incident, not against a hypothetical. Case 2 IS the incident: same label, different bytes.
#
# There is a POSITIVE CONTROL first, and it is not a formality. A suite of expect-failure cases
# over a script that errors on everything passes unanimously and proves nothing. Case 1 is what
# makes the other five mean something.
#
# HERMETIC on purpose: every fixture is a local file and every URL is a file:// URL, so the suite
# does not depend on the network or on GitHub keeping an orphaned commit reachable.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gate="$here/scripts/check-aup-pin.sh"
tmp="$(mktemp -d)"
trap "rm -rf $tmp" EXIT

pass=0
fail=0

printf %s "the text of version one point zero" > "$tmp/1.0.0.md"
printf %s "the text of version one point one, with the shared-tier scoping" > "$tmp/1.1.0.md"
sha_100="$(sha256sum "$tmp/1.0.0.md" | cut -d" " -f1)"
sha_110="$(sha256sum "$tmp/1.1.0.md" | cut -d" " -f1)"
{
  echo "# fixture manifest"
  echo "1.0.0 $sha_100"
  echo "1.1.0 $sha_110"
} > "$tmp/SHA256SUMS"

# run <expect pass|fail> <description> <version> <url> [must-contain]
run() {
  local expect="$1" desc="$2" ver="$3" url="$4" needle="${5:-}"
  local out rc
  out="$(AUP_VERSION="$ver" AUP_URL="$url" bash "$gate" "$tmp/SHA256SUMS" 2>&1)" && rc=0 || rc=1
  local ok=1
  if [ "$expect" = "pass" ] && [ "$rc" -ne 0 ]; then ok=0; fi
  if [ "$expect" = "fail" ] && [ "$rc" -eq 0 ]; then ok=0; fi
  if [ -n "$needle" ] && ! printf %s "$out" | grep -qF "$needle"; then ok=0; fi
  if [ "$ok" -eq 1 ]; then
    echo "  ok   $desc"
    pass=$((pass + 1))
  else
    echo "  FAILED $desc (rc=$rc, expected $expect)"
    printf %s "$out" | sed "s/^/       /"
    fail=$((fail + 1))
  fi
}

echo "scripts/check-aup-pin.sh"

# 1. POSITIVE CONTROL. Without this, five green refusals below would also be produced by a gate
#    that refuses unconditionally.
run pass "CONTROL: label and pointer agree -- the gate lets a correct pin through" \
  "1.0.0" "file://$tmp/1.0.0.md" "AUP pin OK"

# 2. THE ACTUAL INCIDENT (cp#396): AUP_URL repointed at a different document while AUP_VERSION
#    stayed put, staged in repository variables and armed for the next unrelated deploy.
run fail "the real incident: pointer moved to other bytes under an unchanged label" \
  "1.0.0" "file://$tmp/1.1.0.md" "AUP pin MISMATCH"

# 3. The mirror-image mistake, and the one this cut is exposed to: cut a new version, forget to
#    re-pin the pointer at it.
run fail "label bumped, pointer never re-pinned" \
  "1.1.0" "file://$tmp/1.0.0.md" "AUP pin MISMATCH"

# 4. Fails CLOSED on a version nobody recorded -- AND SAYS WHY. The rc alone is not the assertion:
#    the first draft of this gate refused this case correctly and printed NOTHING, because grep
#    exits 1 on no match and set -e killed the script at the assignment. A silent refusal is a
#    gate nobody can act on, so the message is part of the contract.
run fail "an unrecorded version is refused, with a message naming the version" \
  "9.9.9" "file://$tmp/1.0.0.md" "no sha256 recorded for AUP_VERSION 9.9.9"

# 5. An unreachable policy pointer is a launch blocker, not a warning.
run fail "an unfetchable AUP_URL is refused" \
  "1.0.0" "file://$tmp/does-not-exist.md" "not fetchable"

# 6. Empty inputs must not read as agreement.
run fail "an empty AUP_VERSION is refused" "" "file://$tmp/1.0.0.md" "AUP_VERSION is unset"
run fail "an empty AUP_URL is refused" "1.0.0" "" "AUP_URL is unset"

echo ""
echo "  ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
