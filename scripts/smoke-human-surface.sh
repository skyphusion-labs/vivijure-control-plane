#!/usr/bin/env bash
# Post-deploy human-surface smoke check.
#
# WHY THIS EXISTS: every automated check we run at deploy time hits a JSON route.
# The v1.3.1 outage shipped because a TOML bare key swallowed the ASSETS binding
# into [observability], so studio.vivijure.com served 500 on `/` and every HTML
# path for three days while those JSON routes stayed green. Nothing ever visited
# a human page. This asserts on the RENDERED result of a human-visited path so
# that class of regression turns the release run RED instead of sitting silent.
#
# It is DETECTION, not prevention: Workers deploys are atomic with no pre-switch
# slot, so a bad build is briefly live before this bites. The point is that the
# run goes red within seconds, not days.
#
# Usage: smoke-human-surface.sh <base-url> [path]
#   smoke-human-surface.sh https://studio.vivijure.com
#   smoke-human-surface.sh https://studio.vivijure.com /api/platform/version   # negative-test target
#
# Asserts on <base-url><path> (path defaults to /):
#   - HTTP status 200                     (catches the 500 we shipped)
#   - Content-Type contains text/html     (catches a 200 that returns JSON)
#   - body >= SMOKE_MIN_BYTES bytes AND is the front-door page (has a <title>
#     and the brand token "vivijure")     (catches a 200 text/html error shell)
#
# Tunables (env): SMOKE_MIN_BYTES (default 512), SMOKE_ATTEMPTS (default 5),
# SMOKE_SLEEP seconds between attempts (default 4). Retries absorb the brief
# post-deploy propagation window; every retry re-fetches, it never caches a miss.
#
# Dependency: curl only. No secrets are read or printed.
set -euo pipefail

BASE="${1:?usage: smoke-human-surface.sh <base-url> [path]}"
PATH_ARG="${2:-/}"
BASE="${BASE%/}"
case "$PATH_ARG" in /*) : ;; *) PATH_ARG="/$PATH_ARG" ;; esac
URL="${BASE}${PATH_ARG}"

MIN_BYTES="${SMOKE_MIN_BYTES:-512}"
ATTEMPTS="${SMOKE_ATTEMPTS:-5}"
SLEEP_SECS="${SMOKE_SLEEP:-4}"

attempt=1
while : ; do
  hdr="$(mktemp)"
  body="$(mktemp)"
  code="$(curl -sS -o "$body" -D "$hdr" -w "%{http_code}" --max-time 25 "$URL" || echo "000")"
  ctype="$(grep -i "^content-type:" "$hdr" | head -1 | tr -d "\r" | cut -d" " -f2- || true)"
  bytes="$(wc -c < "$body" | tr -d " ")"

  ok=1
  [ "$code" = "200" ] || ok=0
  printf "%s" "$ctype" | grep -qi "text/html" || ok=0
  [ "${bytes:-0}" -ge "$MIN_BYTES" ] || ok=0
  grep -qi "<title" "$body" || ok=0
  grep -qi "vivijure" "$body" || ok=0

  if [ "$ok" = "1" ]; then
    echo "human-surface OK: ${URL} -> ${code} ${ctype} ${bytes} bytes"
    rm -f "$hdr" "$body"
    exit 0
  fi

  echo "attempt ${attempt}/${ATTEMPTS}: ${URL} -> code=${code} ctype=\"${ctype}\" bytes=${bytes} (not yet healthy)"
  rm -f "$hdr" "$body"
  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "::error::human-surface smoke FAILED for ${URL}: last code=${code} content-type=\"${ctype}\" bytes=${bytes}; expected 200 + text/html + >=${MIN_BYTES}B front-door page (with <title> and \"vivijure\")"
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep "$SLEEP_SECS"
done
