#!/usr/bin/env bash
#
# check-aup-pin.sh -- refuse a deploy whose AUP LABEL and AUP POINTER disagree.
#
# THE DEFECT THIS EXISTS FOR (cp#396). AUP_VERSION names a document and AUP_URL points at one,
# and nothing tied the two together. On 2026-08-14 AUP_URL was repointed at a DIFFERENT document
# while AUP_VERSION stayed 1.0.0. The change sat staged in the repository variables, invisible at
# runtime, armed to swap the accepted text behind four existing acceptances on the next deploy of
# this Worker for ANY unrelated reason. Nobody had to intend it.
#
# WHY THE ENDPOINT CANNOT SELF-CHECK. GET /api/aup/current returns a sha256, and it looks exactly
# like the control that would catch this. It is not one. src/index.ts computes it at request time
# from the bytes it has just fetched (fetchAupSha256), so it agrees with what it serves by
# construction and has nothing to disagree WITH. A checksum computed downstream of the thing it
# guards is a receipt, not a control. This script supplies the independent value: the sha recorded
# in the repository at docs/legal/hosted/aup/SHA256SUMS, written when the version was cut.
#
# WHAT IT ENFORCES, mechanically, so that no step depends on somebody remembering it:
#   bump AUP_VERSION and forget to re-pin AUP_URL  -> fetched bytes are the OLD document -> REFUSE
#   re-point AUP_URL under an unchanged AUP_VERSION -> bytes do not match the record   -> REFUSE
#   both moved together, correctly                  -> pass
#
# FAILS CLOSED on an unrecorded version. A version with no line in the manifest is refused rather
# than waved through: the whole point is that an unrecorded document cannot be verified, and
# treating unverifiable as acceptable is how the pointer drifted for a month in the first place.
#
# Usage: AUP_VERSION=... AUP_URL=... scripts/check-aup-pin.sh [manifest-path]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="${1:-$here/docs/legal/hosted/aup/SHA256SUMS}"
ver="${AUP_VERSION:-}"
url="${AUP_URL:-}"

[ -n "$ver" ] || { echo "::error::AUP_VERSION is unset or empty -- cannot verify the AUP pin" >&2; exit 1; }
[ -n "$url" ] || { echo "::error::AUP_URL is unset or empty -- cannot verify the AUP pin" >&2; exit 1; }
[ -f "$manifest" ] || { echo "::error::AUP manifest not found: $manifest" >&2; exit 1; }

# NOTE the trailing || true. grep exits 1 on no match, and under set -e a failing command
# substitution in an assignment kills the script THERE -- refusing correctly but printing
# nothing, so an unrecorded version would fail silently instead of saying why. Caught by
# tests/aup-pin-gate.test.sh case 4 and finding rc=1 with an empty message.
expected="$(grep -v "^#" "$manifest" | grep -E "^$ver " | head -1 | cut -d" " -f2 || true)"
if [ -z "$expected" ]; then
  echo "::error::no sha256 recorded for AUP_VERSION $ver in $manifest" >&2
  echo "  A version with no recorded hash cannot be verified, and this gate refuses what it" >&2
  echo "  cannot verify. Cut the version properly: add the file, record its sha, then deploy." >&2
  exit 1
fi

tmp="$(mktemp)"
trap "rm -f \"$tmp\"" EXIT
if ! curl -fsSL --max-time 30 -o "$tmp" "$url"; then
  echo "::error::AUP_URL is not fetchable: $url" >&2
  echo "  An unreachable policy pointer is a launch blocker, not a warning: the signup gate" >&2
  echo "  shows this document to every account before it can be accepted." >&2
  exit 1
fi

actual="$(sha256sum "$tmp" | cut -d" " -f1)"
if [ "$actual" != "$expected" ]; then
  echo "::error::AUP pin MISMATCH -- refusing to deploy" >&2
  echo "  AUP_VERSION : $ver" >&2
  echo "  AUP_URL     : $url" >&2
  echo "  recorded    : $expected" >&2
  echo "  served      : $actual" >&2
  echo "  The label and the bytes disagree. Either the pointer was moved without cutting a new" >&2
  echo "  version, or a new version was cut and the pointer was never re-pinned. Both change what" >&2
  echo "  an account is shown; neither is a deploy-time decision." >&2
  exit 1
fi

echo "AUP pin OK: $ver -> $url ($actual)"
