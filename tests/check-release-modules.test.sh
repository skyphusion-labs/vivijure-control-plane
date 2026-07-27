#!/usr/bin/env bash
# Self-test for scripts/check-release-modules.py (cp#187).
#
# Same discipline as tests/render-wrangler.test.sh: the gate is exercised POSITIVELY (a well-formed
# release passes) and NEGATIVELY (each failure mode is watched to FAIL). A gate that has only ever
# been seen to pass is not known to gate anything.
#
# SYNTHETIC repo roots on purpose. An earlier version parsed the REAL src/ tree, which couples this
# suite to whatever transient defect the repo happens to carry. While this gate was being written,
# main genuinely was missing a disposition, so the positive case would have failed for a reason
# having nothing to do with the gate logic. Fixtures here; real artifacts in the manual verification
# recorded on the PR.
#
# The fixture SHAPE is not invented. It mirrors the live v1.12.0 artifact: the module manifest key
# is module (not name), worker carries {path, sha256, size}, and the top-level manifest carries tag
# plus required_vars. An earlier draft asserted a name field that exists in no real release; it
# passed a hand-written fixture and failed every genuine artifact. The sha256 here is COMPUTED from
# the bytes written, so the fixture cannot drift into self-consistency with a wrong hash.
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
gate="$here/scripts/check-release-modules.py"
fails=0
ok()  { printf "PASS  %s\n" "$1"; }
bad() { printf "FAIL  %s\n" "$1"; fails=$((fails+1)); }

# mkrepo <dir> <catalog-csv> <disposition-csv>
mkrepo() {
  python3 - "$@" <<"PY"
import pathlib, sys
root, cat, disp = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
(root / "src").mkdir(parents=True, exist_ok=True)
rows = "\n".join("  { module: \"%s\", endpointKey: \"e\" }," % m for m in cat.split(",") if m)
(root / "src" / "tenant-modules.ts").write_text(
    "export const TENANT_MODULE_CATALOG: readonly TenantModuleSpec[] = [\n%s\n];\n" % rows)
drows = "\n".join("  %s: { disposition: \"provisioned\", why: \"x\" }," % v
                  for v in disp.split(",") if v)
(root / "src" / "tenant-studio-env.ts").write_text(
    "export const TENANT_STUDIO_VAR_DISPOSITION: Record<string, X> = {\n%s\n};\n" % drows)
PY
}

# mkbucket <dir> <tag> <modules-csv> <required-vars-csv>
mkbucket() {
  python3 - "$@" <<"PY"
import hashlib, json, pathlib, sys
root, tag, mods, req = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
base = root / "studio-releases" / tag
(base / "modules").mkdir(parents=True, exist_ok=True)
(base / "manifest.json").write_text(json.dumps({
    "tag": tag, "required_vars": [v for v in req.split(",") if v]}))
for m in [x for x in mods.split(",") if x]:
    d = base / "modules" / m
    d.mkdir(parents=True, exist_ok=True)
    b = ("export default {};// %s\n" % m).encode()
    (d / "worker.js").write_bytes(b)
    (d / "manifest.json").write_text(json.dumps({
        "module": m, "main_module": "worker.js",
        "compatibility_date": "2026-06-01", "compatibility_flags": ["nodejs_compat"],
        "worker": {"path": "worker.js", "sha256": hashlib.sha256(b).hexdigest(), "size": len(b)}}))
PY
}

MODS="keyframe,plan-enhance"
VARS="AUTH_MODE,SPEND_DAILY_CEILING"

# ------------------------------------------------------------------ POSITIVE
r1="$(mktemp -d)"; b1="$(mktemp -d)"
mkrepo "$r1" "$MODS" "$VARS"; mkbucket "$b1" v1.12.0 "$MODS" "$VARS"
if python3 "$gate" "$r1" --release v1.12.0 --from-dir "$b1" >/dev/null 2>&1; then
  ok "a complete release passes"
else
  bad "a complete release should pass but did not"
  python3 "$gate" "$r1" --release v1.12.0 --from-dir "$b1" 2>&1 | sed "s/^/    /"
fi

# ------------------------- A: the cp#184 near-miss -- catalog module absent from the release
r2="$(mktemp -d)"; b2="$(mktemp -d)"
mkrepo "$r2" "$MODS" "$VARS"; mkbucket "$b2" v1.12.0 "keyframe" "$VARS"
if python3 "$gate" "$r2" --release v1.12.0 --from-dir "$b2" >/dev/null 2>&1; then
  bad "a release MISSING a catalog module was accepted"
else
  ok "A: a release missing a catalog module is refused"
fi

# ------------------------- A: manifest promises worker bytes that are absent
r3="$(mktemp -d)"; b3="$(mktemp -d)"
mkrepo "$r3" "$MODS" "$VARS"; mkbucket "$b3" v1.12.0 "$MODS" "$VARS"
rm -f "$b3/studio-releases/v1.12.0/modules/keyframe/worker.js"
if python3 "$gate" "$r3" --release v1.12.0 --from-dir "$b3" >/dev/null 2>&1; then
  bad "a manifest promising ABSENT worker bytes was accepted"
else
  ok "A: a manifest promising absent worker bytes is refused"
fi

# ------------------------- A: worker bytes do not match the pinned hash
r4="$(mktemp -d)"; b4="$(mktemp -d)"
mkrepo "$r4" "$MODS" "$VARS"; mkbucket "$b4" v1.12.0 "$MODS" "$VARS"
printf "//tampered\n" >> "$b4/studio-releases/v1.12.0/modules/keyframe/worker.js"
if python3 "$gate" "$r4" --release v1.12.0 --from-dir "$b4" >/dev/null 2>&1; then
  bad "TAMPERED worker bytes were accepted (integrity check is not working)"
else
  ok "A: worker bytes not matching the pinned sha256 are refused"
fi

# ------------------------- CONTROL: pin points at differently-tagged bytes
r5="$(mktemp -d)"; b5="$(mktemp -d)"
mkrepo "$r5" "$MODS" "$VARS"; mkbucket "$b5" v1.12.0 "$MODS" "$VARS"
mv "$b5/studio-releases/v1.12.0" "$b5/studio-releases/v9.9.9"
if python3 "$gate" "$r5" --release v9.9.9 --from-dir "$b5" >/dev/null 2>&1; then
  bad "a release whose manifest tag disagrees with the pin was accepted"
else
  ok "CONTROL: a pin pointing at differently-tagged bytes is refused"
fi

# ------------------------- CONTROL: an ABSENT release is reported as absent, not as missing modules
# A read that SUCCEEDED and found nothing is a release problem, and says so.
r6="$(mktemp -d)"
mkrepo "$r6" "$MODS" "$VARS"
out="$(python3 "$gate" "$r6" --release v1.12.0 --from-dir "$(mktemp -d)" 2>&1)"
if echo "$out" | grep -q "not a studio release"; then
  ok "CONTROL: a fetch that SUCCEEDS but finds no manifest is a release verdict, not CANNOT VERIFY"
else
  bad "a fetched-but-empty release was not reported as a release problem"
  printf "    %s\n" "$out"
fi

# ------------------------- CONTROL: a FAILED fetch is CANNOT VERIFY and NAMES the cause
# The three outcomes present / absent / could-not-find-out must stay distinct. An earlier version
# collapsed all three into one bare None, and a live dry run could only list three possible causes
# because the code had discarded the one fact that would have named which. This drives the REAL
# fetch path against a tag that has no release, rather than stubbing it.
#
# Network-dependent by design: the gate itself downloads the release, so a CI environment that
# cannot reach GitHub cannot run the gate at all. The assertion holds either way -- an unreachable
# host and a 404 both have to produce CANNOT VERIFY plus a named cause.
r6b="$(mktemp -d)"
mkrepo "$r6b" "$MODS" "$VARS"
out="$(python3 "$gate" "$r6b" --release v0.0.0-no-such-release 2>&1)"
if echo "$out" | grep -q "CANNOT VERIFY"; then
  if echo "$out" | grep -qiE "http|download|404|resolve|urlopen"; then
    ok "CONTROL: a failed fetch reports CANNOT VERIFY and names the underlying cause"
  else
    bad "CANNOT VERIFY was reported but the underlying cause was swallowed"
    printf "    %s\n" "$out"
  fi
else
  bad "a failed fetch did not report CANNOT VERIFY"
  printf "    %s\n" "$out"
fi

# ------------------------- B: THE LIVE DEFECT -- a required_var with no disposition
# The v1.12.0 flip shipped required_vars including R2_STORAGE_QUOTA_BYTES with no disposition on
# the plane. assertDispositionCoversContract threw at provision AND upgrade: deploy green, entire
# tenant lifecycle dead. This is that exact pair.
r7="$(mktemp -d)"; b7="$(mktemp -d)"
mkrepo "$r7" "$MODS" "$VARS"
mkbucket "$b7" v1.12.0 "$MODS" "$VARS,R2_STORAGE_QUOTA_BYTES"
if python3 "$gate" "$r7" --release v1.12.0 --from-dir "$b7" >/dev/null 2>&1; then
  bad "a required_var with NO disposition was accepted (the live-outage shape is still open)"
else
  ok "B: a required_var with no disposition is refused"
fi

# ------------------------- B: a manifest carrying no required_vars at all
r8="$(mktemp -d)"; b8="$(mktemp -d)"
mkrepo "$r8" "$MODS" "$VARS"; mkbucket "$b8" v1.12.0 "$MODS" ""
if python3 "$gate" "$r8" --release v1.12.0 --from-dir "$b8" >/dev/null 2>&1; then
  bad "a manifest carrying NO required_vars was accepted (bundle-r2 refuses it at provision)"
else
  ok "B: a manifest with no required_vars is refused"
fi

# ------------------------- VACUITY: a parser miss must never pass
r9="$(mktemp -d)"; b9="$(mktemp -d)"
mkrepo "$r9" "" "$VARS"; mkbucket "$b9" v1.12.0 "$MODS" "$VARS"
if python3 "$gate" "$r9" --release v1.12.0 --from-dir "$b9" >/dev/null 2>&1; then
  bad "a catalog that parses to NOTHING was treated as a pass"
else
  ok "VACUITY: a catalog parsing to nothing is a failure, not a vacuous pass"
fi

r10="$(mktemp -d)"; b10="$(mktemp -d)"
mkrepo "$r10" "$MODS" ""; mkbucket "$b10" v1.12.0 "$MODS" "$VARS"
if python3 "$gate" "$r10" --release v1.12.0 --from-dir "$b10" >/dev/null 2>&1; then
  bad "a disposition map that parses to NOTHING was treated as a pass"
else
  ok "VACUITY: a disposition map parsing to nothing is a failure, not a vacuous pass"
fi

if [ "$fails" -ne 0 ]; then
  printf "\ncheck-release-modules self-test: %d failure(s)\n" "$fails"
  exit 1
fi
printf "\ncheck-release-modules self-test: all checks passed\n"
