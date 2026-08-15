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



# ernst, cp#414: the manifest lookup must be an EXACT STRING match on the version field.
#
# This case is what makes that claim checkable rather than asserted. The decoy label 1x0x0 differs
# from 1.0.0 only where a regex dot is a wildcard, and it is placed BEFORE the real line, so a
# lookup built on grep -E "^$ver " plus head -1 returns the DECOY sha and the gate then compares
# the real document against a hash nobody recorded. Expected PASS: with a string comparison the
# decoy is simply a different label. This case goes red against the old lookup and green against
# the new one, which is the only reason it is worth having.
decoy="$tmp/SHA256SUMS.decoy"
{
  echo "# fixture with a regex-crossmatching decoy FIRST"
  echo "1x0x0 0000000000000000000000000000000000000000000000000000000000000000"
  echo "1.0.0 $sha_100"
} > "$decoy"
decoy_out="$(AUP_VERSION=1.0.0 AUP_URL="file://$tmp/1.0.0.md" bash "$gate" "$decoy" 2>&1)" && decoy_rc=0 || decoy_rc=1
if [ "$decoy_rc" -eq 0 ] && printf %s "$decoy_out" | grep -qF "AUP pin OK"; then
  echo "  ok   a decoy label a regex would cross-match is not used for 1.0.0"
  pass=$((pass + 1))
else
  echo "  FAILED the manifest lookup matched a decoy label (regex, not exact string)"
  printf %s "$decoy_out" | sed "s/^/       /"
  fail=$((fail + 1))
fi

# ---- scripts/check-aup-files-immutable.sh -------------------------------------------------
#
# The in-repo half. The gate above catches a POINTER that stopped matching its label; this catches
# a version FILE edited in place, which is what actually happened three times in this repository
# and what nothing detected, because the file was never the artifact anyone was served.

echo ""
echo "scripts/check-aup-files-immutable.sh"

imm="$here/scripts/check-aup-files-immutable.sh"
idir="$tmp/aupdir"
mkdir -p "$idir"
printf %s "frozen text" > "$idir/1.0.0.md"
{ echo "# fixture"; echo "1.0.0 $(sha256sum "$idir/1.0.0.md" | cut -d" " -f1)"; } > "$idir/SHA256SUMS"

icheck() {
  local expect="$1" desc="$2" needle="${3:-}"
  local out rc
  out="$(bash "$imm" "$idir" 2>&1)" && rc=0 || rc=1
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

# POSITIVE CONTROL first, same reason as above.
icheck pass "CONTROL: a file matching its recorded sha passes" "match their recorded sha256"

# THE DEFECT THAT ACTUALLY HAPPENED: a served version file edited in place.
printf %s "frozen text, quietly amended" > "$idir/1.0.0.md"
icheck fail "a version file edited in place is refused" "has CHANGED since it was recorded"
printf %s "frozen text" > "$idir/1.0.0.md"

# A policy document nobody recorded must not sit in the directory unnoticed.
printf %s "a version nobody recorded" > "$idir/2.0.0.md"
icheck fail "an unrecorded version file is refused" "no sha recorded in SHA256SUMS"
rm -f "$idir/2.0.0.md"

# A clean run over NOTHING reads identically to a clean run over everything, and a wrong directory
# argument is exactly how this check would silently stop checking.
mkdir -p "$tmp/emptydir"
cp "$idir/SHA256SUMS" "$tmp/emptydir/SHA256SUMS"
empty_out="$(bash "$imm" "$tmp/emptydir" 2>&1)" && empty_rc=0 || empty_rc=1
if [ "$empty_rc" -ne 0 ] && printf %s "$empty_out" | grep -qF "refusing to report a clean run over nothing"; then
  echo "  ok   a directory with no version files is refused, not reported clean"
  pass=$((pass + 1))
else
  echo "  FAILED an empty directory was reported clean"
  fail=$((fail + 1))
fi

# And the REAL repository, because a fixture proves the script and only the repo proves the repo.
real_out="$(bash "$imm" 2>&1)" && real_rc=0 || real_rc=1
if [ "$real_rc" -eq 0 ]; then
  echo "  ok   the real docs/legal/hosted/aup files match their recorded shas"
  pass=$((pass + 1))
else
  echo "  FAILED the real AUP files do not match SHA256SUMS"
  printf %s "$real_out" | sed "s/^/       /"
  fail=$((fail + 1))
fi

echo ""
echo "  ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
