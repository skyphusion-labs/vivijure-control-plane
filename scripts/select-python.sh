#!/usr/bin/env bash
#
# Pick a Python >= 3.11 so tomllib (stdlib since 3.11) is available.
#
# Search order: python3.12, then python3.11, then python3. The first candidate
# whose version is at least 3.11 and that can import tomllib wins. A candidate
# that is new enough but has no tomllib is an error, not a reason to try the
# next name. If every candidate is older than 3.11, exit 1 and name the version
# that was found plus the minimum required. Never skip the check. No package
# install, and Apple's system python is not modified.
set -u

min="3.11"
below=""

for cmd in python3.12 python3.11 python3; do
  exe="$(command -v "$cmd" 2>/dev/null || true)"
  [ -n "$exe" ] || continue
  ver="$("$exe" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || true)"
  major="${ver%%.*}"
  rest="${ver#*.}"
  minor="${rest%%.*}"
  case "$major" in
    ''|*[!0-9]*) major="" ;;
  esac
  case "$minor" in
    ''|*[!0-9]*) minor="" ;;
  esac
  if [ -z "$major" ] || [ -z "$minor" ]; then
    shown="${ver:-nothing}"
    below="${below:+$below; }$cmd ($exe) did not report a numeric version (got '$shown')"
    continue
  fi
  if [ "$major" -lt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -lt 11 ]; }; then
    below="${below:+$below; }$cmd is Python $ver ($exe)"
    continue
  fi
  if ! "$exe" -c 'import tomllib' >/dev/null 2>&1; then
    echo "::error::$cmd is Python $ver ($exe) but has no tomllib. Need Python >= $min. A missing tomllib is an error, not a skip." >&2
    exit 1
  fi
  printf '%s\n' "$exe"
  exit 0
done

if [ -n "$below" ]; then
  echo "::error::$below. Need Python >= $min for tomllib. Looked for python3.12, python3.11, then python3." >&2
else
  echo "::error::no Python interpreter found. Need Python >= $min for tomllib. Looked for python3.12, python3.11, then python3." >&2
fi
exit 1
