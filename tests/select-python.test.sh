#!/usr/bin/env bash
#
# scripts/select-python.sh, driven with stub interpreters so the order and the
# refusal do not depend on whatever python3 this shell happens to resolve.
# Silent on success. A failure prints the case name and exits non-zero.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sel="$here/scripts/select-python.sh"
# Absolute path, captured before a case sets PATH to a stub dir that has no bash.
bash_bin="$(command -v bash)"
fail=0
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT

say() {
  echo "  FAIL $*" >&2
  fail=$((fail + 1))
}

# version is major.minor.patch. tomllib is "yes" or "no".
# flag, when set, is a file the stub appends to if it is executed at all.
make_py() {
  local path="$1" version="$2" tomllib="$3" flag="${4:-}"
  {
    echo '#!/bin/bash'
    if [ -n "$flag" ]; then
      printf 'echo called >> %q\n' "$flag"
    fi
    cat <<EOF
code=""
prev=""
for arg in "\$@"; do
  if [ "\$prev" = "-c" ]; then
    code="\$arg"
  fi
  prev="\$arg"
done
case "\$code" in
  *version_info*)
    printf '%s\n' '$version'
    exit 0
    ;;
  *tomllib*)
    if [ '$tomllib' = yes ]; then
      exit 0
    fi
    echo "ModuleNotFoundError: No module named 'tomllib'" >&2
    exit 1
    ;;
esac
echo "unhandled: \$code" >&2
exit 2
EOF
  } > "$path"
  chmod +x "$path"
}

expect_ok() {
  local name="$1" dir="$2" want="$3"
  local out err rc got
  out="$(mktemp)"
  err="$(mktemp)"
  PATH="$dir" "$bash_bin" "$sel" >"$out" 2>"$err"
  rc=$?
  got="$(cat "$out")"
  if [ "$rc" -ne 0 ] || [ "$got" != "$want" ] || [ -s "$err" ]; then
    say "$name"
    echo "    rc=$rc" >&2
    echo "    stdout=$(cat "$out")" >&2
    echo "    stderr=$(cat "$err")" >&2
  fi
  rm -f "$out" "$err"
}

expect_fail() {
  local name="$1" dir="$2"
  shift 2
  local out err rc err_txt needle
  out="$(mktemp)"
  err="$(mktemp)"
  PATH="$dir" "$bash_bin" "$sel" >"$out" 2>"$err"
  rc=$?
  err_txt="$(cat "$err")"
  if [ "$rc" -eq 0 ] || [ -s "$out" ]; then
    say "$name (expected non-zero and empty stdout, rc=$rc stdout=$(cat "$out"))"
    echo "    stderr=$err_txt" >&2
  fi
  for needle in "$@"; do
    if ! printf '%s' "$err_txt" | grep -q -F -- "$needle"; then
      say "$name missing [$needle]"
      echo "    stderr=$err_txt" >&2
    fi
  done
  rm -f "$out" "$err"
}

expect_untouched() {
  local name="$1" flag="$2"
  if [ -e "$flag" ]; then
    say "$name executed a later interpreter; that is a skip"
  fi
}

# 1. python3.12 wins, and the later names are not consulted.
d="$root/prefer-312"
mkdir -p "$d"
make_py "$d/python3.12" "3.12.1" yes
make_py "$d/python3.11" "3.11.0" yes "$d/called-311"
make_py "$d/python3" "3.9.6" no "$d/called-3"
expect_ok "prefers python3.12" "$d" "$d/python3.12"
expect_untouched "prefers python3.12" "$d/called-311"
expect_untouched "prefers python3.12" "$d/called-3"

# 2. No python3.12: python3.11, and python3 is not consulted.
d="$root/prefer-311"
mkdir -p "$d"
make_py "$d/python3.11" "3.11.4" yes
make_py "$d/python3" "3.9.6" no "$d/called-3"
expect_ok "uses python3.11 when python3.12 is absent" "$d" "$d/python3.11"
expect_untouched "uses python3.11 when python3.12 is absent" "$d/called-3"

# 3. python3.12 below the minimum is not selected; a later candidate that qualifies is.
d="$root/old-312"
mkdir -p "$d"
make_py "$d/python3.12" "3.9.0" no
make_py "$d/python3.11" "3.11.0" yes
expect_ok "python3.12 below 3.11 falls through to python3.11" "$d" "$d/python3.11"

# 4. python3.11 below the minimum falls through to a new enough python3.
d="$root/old-311"
mkdir -p "$d"
make_py "$d/python3.11" "3.10.9" no
make_py "$d/python3" "3.12.0" yes
expect_ok "python3.11 below 3.11 falls through to python3" "$d" "$d/python3"

# 5. Boundary: exactly 3.11.0 is enough.
d="$root/exact"
mkdir -p "$d"
make_py "$d/python3" "3.11.0" yes
expect_ok "python3 at 3.11.0 is accepted" "$d" "$d/python3"

# 6. Only Apple-shaped 3.9.6: non-zero, names that version and the minimum.
d="$root/only-39"
mkdir -p "$d"
make_py "$d/python3" "3.9.6" no
expect_fail "only Python 3.9.6" "$d" "3.9.6" "3.11" "python3" "tomllib"

# 7. New enough, but no tomllib: error, and do not skip onward to a later interpreter.
d="$root/no-tomllib"
mkdir -p "$d"
make_py "$d/python3.12" "3.12.0" no
make_py "$d/python3" "3.14.0" yes "$d/called-3"
expect_fail "python3.12 without tomllib" "$d" "3.12.0" "tomllib" "3.11" "not a skip"
expect_untouched "python3.12 without tomllib" "$d/called-3"

# 8. Nothing on PATH.
d="$root/none"
mkdir -p "$d"
expect_fail "no interpreter" "$d" "3.11" "python3.12" "no Python interpreter found"

# 9. Every candidate is too old: name each version found.
d="$root/all-old"
mkdir -p "$d"
make_py "$d/python3.12" "3.8.1" no
make_py "$d/python3" "3.9.6" no
expect_fail "all candidates below 3.11" "$d" "3.8.1" "3.9.6" "3.11"

# 10. The interpreter this shell would actually select is >= 3.11 and has tomllib.
out="$(mktemp)"
err="$(mktemp)"
"$bash_bin" "$sel" >"$out" 2>"$err"
rc=$?
got="$(cat "$out")"
if [ "$rc" -ne 0 ] || [ -z "$got" ] || [ -s "$err" ]; then
  say "ambient PATH selector failed rc=$rc stdout=$(cat "$out") stderr=$(cat "$err")"
else
  aver="$("$got" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
  amajor="${aver%%.*}"
  aminor="${aver#*.}"
  if [ -z "$amajor" ] || [ -z "$aminor" ] || [ "$amajor" -lt 3 ] || { [ "$amajor" -eq 3 ] && [ "$aminor" -lt 11 ]; }; then
    say "ambient selector returned $got at ${aver:-unknown}"
  fi
  if ! "$got" -c 'import tomllib' >/dev/null 2>&1; then
    say "ambient selector returned $got with no tomllib"
  fi
fi
rm -f "$out" "$err"

if [ "$fail" -ne 0 ]; then
  echo "select-python: $fail failed" >&2
  exit 1
fi
exit 0
