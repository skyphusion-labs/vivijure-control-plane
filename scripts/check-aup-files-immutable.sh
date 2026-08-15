#!/usr/bin/env bash
#
# check-aup-files-immutable.sh -- every AUP version file in this repo must still hash to the value
# recorded for it in SHA256SUMS.
#
# WHY (cp#396). The first-serve rule says a served version file freezes, and the rule was broken
# three times in this repository without anyone noticing, because nothing checked. aup/1.0.0.md
# was edited in place at ca9bf69a, 20fd5105 and d0533987; the last two landed AFTER serving had
# begun. The edits were invisible precisely because the file was never the artifact anyone was
# served, so no runtime behaviour changed and no test had an opinion.
#
# This is the check that would have caught all three, and it is deliberately the cheapest possible
# one: no network, no deploy, just hash the file and compare. A recorded version whose file has
# drifted is refused; a file with no recorded sha is refused too, because an unrecorded policy
# document is exactly what should not be sitting in the directory the gate serves from.
#
# Usage: scripts/check-aup-files-immutable.sh [aup-dir]
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="${1:-$here/docs/legal/hosted/aup}"
manifest="$dir/SHA256SUMS"

[ -f "$manifest" ] || { echo "::error::no manifest at $manifest" >&2; exit 1; }

# EXACT-STRING lookup, not a regex (ernst, cp#414 review). Interpolating a version into a regex
# makes its dots wildcards, so 1.0.0 would also match 1x0x0, and a pathological label could
# cross-match a neighbouring line. This compares field 1 as a STRING, so the lookup means what it
# says. Cosmetic at this manifest size, and exactly the kind of thing that stops being cosmetic
# once the manifest grows.
#
# It also removes the set -e hazard the first draft carried: grep exits 1 on no match, which under
# set -e killed the script at the assignment before it could say why. A read loop cannot do that.
# tests/aup-pin-gate.test.sh case 4 still asserts the MESSAGE rather than the exit code, so a
# silent refusal cannot come back by another route.
lookup_sha() {
  local want="$1" file="$2" v h rest
  while read -r v h rest; do
    case "$v" in "#"*|"") continue ;; esac
    if [ "$v" = "$want" ]; then printf %s "$h"; return 0; fi
  done < "$file"
  return 0
}

bad=0
seen=0
for f in "$dir"/*.md; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  ver="${base%.md}"
  seen=$((seen + 1))
  expected="$(lookup_sha "$ver" "$manifest")"
  actual="$(sha256sum "$f" | cut -d" " -f1)"
  if [ -z "$expected" ]; then
    echo "::error::$base has no sha recorded in SHA256SUMS (found $actual)" >&2
    bad=1
  elif [ "$expected" != "$actual" ]; then
    echo "::error::$base has CHANGED since it was recorded" >&2
    echo "  recorded: $expected" >&2
    echo "  on disk : $actual" >&2
    echo "  A served version file is frozen. A correction ships as a NEW version file, never as an" >&2
    echo "  edit to this one -- otherwise every acceptance record pointing at it silently starts" >&2
    echo "  referring to text nobody agreed to. See docs/legal/hosted/README.md." >&2
    bad=1
  fi
done

# A zero-file run must not pass. An empty directory and a clean one are otherwise identical, and
# the reassuring reading is the one that would survive a bad path argument.
if [ "$seen" -eq 0 ]; then
  echo "::error::no AUP version files found under $dir -- refusing to report a clean run over nothing" >&2
  exit 1
fi

[ "$bad" -eq 0 ] || exit 1
echo "AUP files immutable: $seen file(s) match their recorded sha256"
