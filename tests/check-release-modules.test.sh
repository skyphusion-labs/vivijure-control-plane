#!/usr/bin/env bash
# Self-test for scripts/check-release-modules.py (cp#187).
#
# Same discipline as tests/render-wrangler.test.sh: the gate is exercised POSITIVELY (a well-formed
# release passes) and NEGATIVELY (each failure mode is watched to FAIL). A gate that has only ever
# been seen to pass is not known to gate anything.
#
# The fixture shape here is not invented. It mirrors the LIVE v1.12.0 artifact: the module manifest
# key is `module` (not `name`), and `worker` carries {path, sha256, size}. An earlier draft of this
# gate asserted a `name` field that does not exist in any real release; it passed a hand-written
# fixture and failed every genuine artifact. The sha256 below is COMPUTED from the bytes written, so
# the fixture cannot drift into self-consistency with a wrong hash.
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
gate="$here/scripts/check-release-modules.py"
fails=0

note() { printf "  %s\n" "$1"; }
ok()   { printf "PASS  %s\n" "$1"; }
bad()  { printf "FAIL  %s\n" "$1"; fails=$((fails+1)); }

# Build a bucket-shaped tree holding every module the catalog declares.
build() {
  local root="$1" tag="$2"
  local base="$root/studio-releases/$tag"
  mkdir -p "$base/modules"
  printf "{\"tag\":\"%s\"}" "$tag" > "$base/manifest.json"
  local mods
  mods="$(python3 - "$here" <<"PY"
import re,sys,pathlib
src=(pathlib.Path(sys.argv[1])/"src"/"tenant-modules.ts").read_text()
m=re.search(r"TENANT_MODULE_CATALOG:\s*readonly\s+TenantModuleSpec\[\]\s*=\s*\[(.*?)\n\];",src,re.S)
print(" ".join(re.findall(r"\{\s*module:\s*\"([^\"]+)\"", m.group(1))))
PY
)"
  for m in $mods; do
    mkdir -p "$base/modules/$m"
    printf "export default {};// %s\n" "$m" > "$base/modules/$m/worker.js"
    python3 - "$base/modules/$m" "$m" <<"PY"
import hashlib,json,pathlib,sys
d=pathlib.Path(sys.argv[1]); name=sys.argv[2]
b=(d/"worker.js").read_bytes()
(d/"manifest.json").write_text(json.dumps({
  "module": name, "main_module": "worker.js",
  "compatibility_date": "2026-06-01", "compatibility_flags": ["nodejs_compat"],
  "worker": {"path":"worker.js","sha256":hashlib.sha256(b).hexdigest(),"size":len(b)},
}))
PY
  done
  echo "$mods"
}

# ---------------------------------------------------------------- POSITIVE
t="$(mktemp -d)"; build "$t" v1.12.0 >/dev/null
if python3 "$gate" "$here" --release v1.12.0 --from-dir "$t" >/dev/null 2>&1; then
  ok "a complete release passes"
else
  bad "a complete release should pass but did not"
  python3 "$gate" "$here" --release v1.12.0 --from-dir "$t" 2>&1 | sed "s/^/    /"
fi

# ------------------------------------------------- NEGATIVE: the cp#184 near-miss
# The catalog names a module the pinned release does not publish. This is the exact pair that would
# have failed EVERY provision at modules_upload.
t2="$(mktemp -d)"; mods="$(build "$t2" v1.12.0)"
last="$(echo "$mods" | tr " " "\n" | tail -1)"
rm -rf "$t2/studio-releases/v1.12.0/modules/$last"
if python3 "$gate" "$here" --release v1.12.0 --from-dir "$t2" >/dev/null 2>&1; then
  bad "a release MISSING module $last was accepted (the cp#187 gap is still open)"
else
  ok "a release missing a catalog module is refused"
fi

# ------------------------------------------------- NEGATIVE: manifest promises absent bytes
t3="$(mktemp -d)"; mods="$(build "$t3" v1.12.0)"
first="$(echo "$mods" | tr " " "\n" | head -1)"
rm -f "$t3/studio-releases/v1.12.0/modules/$first/worker.js"
if python3 "$gate" "$here" --release v1.12.0 --from-dir "$t3" >/dev/null 2>&1; then
  bad "a manifest promising ABSENT worker bytes was accepted"
else
  ok "a manifest promising absent worker bytes is refused"
fi

# ------------------------------------------------- NEGATIVE: worker bytes do not match the pin
t4="$(mktemp -d)"; mods="$(build "$t4" v1.12.0)"
first="$(echo "$mods" | tr " " "\n" | head -1)"
printf "//tampered\n" >> "$t4/studio-releases/v1.12.0/modules/$first/worker.js"
if python3 "$gate" "$here" --release v1.12.0 --from-dir "$t4" >/dev/null 2>&1; then
  bad "TAMPERED worker bytes were accepted (integrity check is not working)"
else
  ok "worker bytes that do not match the pinned sha256 are refused"
fi

# ------------------------------------------------- NEGATIVE: pin points at the wrong bytes
t5="$(mktemp -d)"; build "$t5" v1.12.0 >/dev/null
mv "$t5/studio-releases/v1.12.0" "$t5/studio-releases/v9.9.9"
if python3 "$gate" "$here" --release v9.9.9 --from-dir "$t5" >/dev/null 2>&1; then
  bad "a release whose manifest tag disagrees with the pin was accepted"
else
  ok "a pin pointing at bytes tagged differently is refused"
fi

# ------------------------------------------------- NEGATIVE: unreadable release is CANNOT VERIFY
# The distinction that matters operationally: a credentials or missing-release problem must not be
# reported as evidence about the modules.
out="$(python3 "$gate" "$here" --release v1.12.0 --from-dir "$(mktemp -d)" 2>&1)"
if echo "$out" | grep -q "CANNOT VERIFY"; then
  ok "an unreadable release reports CANNOT VERIFY, not a module verdict"
else
  bad "an unreadable release did not report CANNOT VERIFY"
  note "$out"
fi

# ------------------------------------------------- NEGATIVE: a parser miss must never pass
# If the catalog regex stops matching, every per-module check would pass vacuously. That has to be
# a failure, not a green.
t7="$(mktemp -d)"; mkdir -p "$t7/src"
printf "export const TENANT_MODULE_CATALOG = [];\n" > "$t7/src/tenant-modules.ts"
if python3 "$gate" "$t7" --release v1.12.0 --from-dir "$(mktemp -d)" >/dev/null 2>&1; then
  bad "a catalog the parser could not read was treated as a PASS"
else
  ok "a catalog that parses to nothing is a failure, not a vacuous pass"
fi

if [ "$fails" -ne 0 ]; then
  printf "\ncheck-release-modules self-test: %d failure(s)\n" "$fails"
  exit 1
fi
printf "\ncheck-release-modules self-test: all checks passed\n"
