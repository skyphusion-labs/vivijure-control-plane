#!/usr/bin/env bash
#
# Negative tests for scripts/render-wrangler.sh -- the config-render fail-closed guards.
#
# WHY THIS EXISTS: every guard here is watched FAILING before it is trusted. A guard that has only
# ever been observed passing is not a verified guard, it is an assumption with a green checkmark.
# There is also a POSITIVE CONTROL, because a suite of negative tests over a broken script passes
# unanimously: if the script errored on everything, every "expect failure" case would go green and
# the suite would report health while proving nothing.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
render="$here/scripts/render-wrangler.sh"
tmp="$(mktemp -d)"
trap "rm -rf $tmp" EXIT

pass=0
fail=0

# A complete, valid environment, matching how the repo is ACTUALLY configured.
#
# Note what is deliberately NOT set here: the four SSO ids. They are absent as GitHub Actions
# variables (the API 422s an empty variable value), and empty is their intended meaning -- a
# provider is offered only when both halves are present. The base environment mirrors production
# rather than a tidier hypothetical, so the positive control proves the REAL configuration renders.
set_full_env() {
  unset GOOGLE_OAUTH_CLIENT_ID GITHUB_OAUTH_CLIENT_ID APPLE_TEAM_ID APPLE_SERVICES_ID
  export CLOUDFLARE_ACCOUNT_ID="0123456789abcdef0123456789abcdef"
  export CONTROL_PLANE_D1_ID="11111111-2222-3333-4444-555555555555"
  export TENANT_DISPATCH_NAMESPACE="vivijure-tenants"
  export TENANT_MODULE_NAMESPACE="vivijure-tenant-modules"
  export STUDIO_RELEASES_BUCKET="vivijure-studio-releases"
  export STUDIO_RELEASE="v1.2.0"
  export CONTROL_PLANE_HOST="studio.example.com"
  export CONTROL_PLANE_ZONE_NAME="example.com"
  export AUP_VERSION="1.0.0"
  export AUP_URL="https://raw.githubusercontent.com/o/r/8a5d96b4225d6154dceb3906d45d2ad0fb1a1841/aup.md"
  export POSTERN_SEND_URL="https://mail.example.com/api/send"
}

check() {
  local name="$1" expect="$2"
  if [ "$expect" = "pass" ]; then
    if "$render" "$tmp/out.toml" >"$tmp/log" 2>&1; then
      echo "  ok   $name (rendered as expected)"; pass=$((pass + 1))
    else
      echo "  FAIL $name -- expected a successful render, got:"; sed "s/^/       /" "$tmp/log"; fail=$((fail + 1))
    fi
  else
    if "$render" "$tmp/out.toml" >"$tmp/log" 2>&1; then
      echo "  FAIL $name -- expected the guard to REFUSE, but the render succeeded"; fail=$((fail + 1))
    else
      echo "  ok   $name (guard refused, as it must)"; pass=$((pass + 1))
    fi
  fi
}

echo "render-wrangler guards:"

# POSITIVE CONTROL. Without this, a script that failed unconditionally would pass every case below.
set_full_env
check "positive control: the real production shape renders" pass

# EVERY required value, each broken one at a time, unset AND empty. The earlier cut of this script
# guarded only a hand-picked few, which left the rest silently defaultable to empty -- an empty
# TENANT_DISPATCH_NAMESPACE would have rendered a broken binding and deployed clean.
for v in CLOUDFLARE_ACCOUNT_ID CONTROL_PLANE_D1_ID TENANT_DISPATCH_NAMESPACE TENANT_MODULE_NAMESPACE STUDIO_RELEASES_BUCKET STUDIO_RELEASE CONTROL_PLANE_HOST CONTROL_PLANE_ZONE_NAME AUP_VERSION AUP_URL POSTERN_SEND_URL; do
  set_full_env; unset "$v"
  check "unset $v is refused" fail
  set_full_env; export "$v"=""
  check "empty $v is refused" fail
done

# The D1 id is shape-checked, because a wrong-but-present id migrates a stranger database.
set_full_env; export CONTROL_PLANE_D1_ID="not-a-uuid"
check "malformed CONTROL_PLANE_D1_ID is refused" fail

# AUP_URL immutable-ref guard (the standing rule from Ernst).
set_full_env; export AUP_URL="https://raw.githubusercontent.com/o/r/main/docs/aup/1.0.0.md"
check "AUP_URL on a moving ref (/main/) is refused" fail

set_full_env; export AUP_URL="https://raw.githubusercontent.com/o/r/refs/heads/release/aup.md"
check "AUP_URL on a moving ref (/refs/heads/) is refused" fail

# The gaps a 16-case corpus found that reading the glob did not (Joan, 2026-07-18). Every one of
# these was ACCEPTED by the first version of the guard, which looked correct to two readers.
# Reproduced against the real script before patching, and watched flip from accepted to refused.
set_full_env; export AUP_URL="https://raw.githubusercontent.com/o/r/raw/develop/aup.md"
check "AUP_URL on a moving ref (/develop/) is refused" fail

set_full_env; export AUP_URL="https://github.com/o/r/blob/trunk/aup.md"
check "AUP_URL on a moving ref (/trunk/) is refused" fail

set_full_env; export AUP_URL="https://github.com/o/r/blob/head/aup.md"
check "AUP_URL on a moving ref (lowercase /head/) is refused" fail

# Case variants: a branch ref is the same moving ref whatever its casing, and the original glob
# was case-sensitive, so /Main/ and /HEAD/ sailed through while /main/ was caught.
set_full_env; export AUP_URL="https://github.com/o/r/blob/Main/aup.md"
check "AUP_URL case variant (/Main/) is refused" fail

set_full_env; export AUP_URL="https://github.com/o/r/blob/HEAD/aup.md"
check "AUP_URL case variant (/HEAD/) is refused" fail

# ...and the shapes that MUST still be allowed, or the guard is just breaking deployments. A
# self-hoster runs their own plane and hosts their own policy text wherever they like; the rule is
# immutability, not a prescribed host.
set_full_env; export AUP_URL="https://example.com/policies/aup-1.0.0.md"
check "a self-hosted immutable AUP_URL is allowed" pass

# The widened glob must not have started eating legitimate pins. Allow-side control for the
# develop/trunk/head additions specifically: a guard that refuses everything passes every refusal
# case above and is worthless.
set_full_env; export AUP_URL="https://github.com/o/r/blob/v1.2.3/docs/aup.md"
check "a TAG-pinned AUP_URL is allowed" pass

set_full_env; export AUP_URL="https://raw.githubusercontent.com/o/r/8a5d96b4225d6154dceb3906d45d2ad0fb1a1841/docs/legal/hosted/aup/1.0.0.md"
check "the live SHA-pinned AUP_URL is still allowed" pass

# THE ALLOWLIST, both directions. These four are the ONLY values where empty is correct.
set_full_env; export GOOGLE_OAUTH_CLIENT_ID="" GITHUB_OAUTH_CLIENT_ID="" APPLE_TEAM_ID="" APPLE_SERVICES_ID=""
check "explicitly-empty SSO ids are allowed (provider simply not offered)" pass

set_full_env; export GOOGLE_OAUTH_CLIENT_ID="g-client" GITHUB_OAUTH_CLIENT_ID="gh-client"
check "populated SSO ids are allowed" pass

# ---------------------------------------------------------------------------
# SHARED_RUNPOD_ENDPOINTS carries JSON, and JSON carries quotes (cp#285).
#
# WHY THIS BLOCK DID NOT EXIST AND SHOULD HAVE: the base environment above never sets this var. It
# is ALLOW_EMPTY, so it rendered as an empty string, which parses fine. The suite already had a
# tomllib parser in assert_toml and was ALREADY parsing the rendered file -- the instrument was
# fully capable and was simply never pointed at the hazardous value. So the gap was not a missing
# tool, it was a missing FIXTURE, which is the harder kind to notice: every check was green and the
# only thing absent was an input nobody had written.
#
# The defect it missed: the template rendered this into a BASIC string, so the value's own double
# quotes terminated it and the document did not parse. The render step still exited 0, and the
# failure surfaced three steps downstream as a message about a missing R2 object.
POOL_JSON='{"backend":{"id":"aaa111","name":"vivijure-backend"},"upscale":{"id":"bbb222","name":"vivijure-video-upscale"},"lipsync":{"id":"ccc333","name":"vivijure-musetalk"},"audio-upscale":{"id":"ddd444","name":"vivijure-audio-upscale"}}'

set_full_env; export SHARED_RUNPOD_ENDPOINTS="$POOL_JSON"
check "a JSON pool value renders (this exact case was RED before cp#285)" pass

# THE NEW GUARD, WATCHED FAILING. A TOML literal string cannot contain a single quote at all, so
# this is the residual the quoting fix cannot express -- and it is precisely why the post-render
# PARSE assertion exists rather than trusting the quote choice. Refused at the point of production,
# named, instead of three steps downstream wearing another step's name.
set_full_env; export SHARED_RUNPOD_ENDPOINTS="{\"backend\":{\"id\":\"a'\''b\",\"name\":\"x\"}}"
check "a value carrying a single quote is REFUSED by the parse guard" fail

# ALLOW-SIDE CONTROL for the guard: it must not have started refusing the shipped default. Empty is
# the intended value for a plane that offers no shared tier, and a guard that refuses everything
# would pass every refusal case above while breaking every real deploy.
set_full_env; export SHARED_RUNPOD_ENDPOINTS=""
check "an empty pool value still renders (no shared tier is a valid config)" pass

# ---------------------------------------------------------------------------
# STRUCTURAL guard: the rendered config must actually BIND what we think it binds.
#
# Every check above asks "did the render succeed?". None of them ask "is the result the config we
# meant?" -- and on 2026-07-19 that gap cost us three days of production with no user-visitable
# page. `assets` is a BARE key, so TOML binds it to the table header above it. It sat below
# `[observability]` and was silently parsed as `observability.assets`: the ASSETS binding was never
# created, env.ASSETS.fetch() threw on undefined, and `/` plus every HTML path 500'd while the JSON
# routes stayed green and every test passed. wrangler's only protest was a scroll-past WARNING.
#
# A render that succeeds is not a render that is CORRECT. This asserts the shape.
assert_toml() {
  local name="$1" expr="$2" want="$3" file="${4:-$tmp/out.toml}"
  local got
  got="$(python3 -c "
import sys, tomllib
d = tomllib.load(open('$file','rb'))
print($expr)
" 2>&1)" || { echo "  FAIL $name -- could not parse: $got"; fail=$((fail + 1)); return; }
  if [ "$got" = "$want" ]; then
    echo "  ok   $name"; pass=$((pass + 1))
  else
    echo "  FAIL $name -- expected '$want', got '$got'"; fail=$((fail + 1))
  fi
}

set_full_env
"$render" "$tmp/out.toml" >"$tmp/log" 2>&1 || { echo "  FAIL structural: base render failed"; fail=$((fail + 1)); }

assert_toml "assets is a TOP-LEVEL key, not nested under a table" "'assets' in d" "True"
assert_toml "the ASSETS binding is named" "d.get('assets',{}).get('binding')" "ASSETS"
assert_toml "run_worker_first survives the render" "d.get('assets',{}).get('run_worker_first')" "True"
assert_toml "no stray assets key under [observability]" "'assets' in d.get('observability',{})" "False"

# cp#48 SELFHOST-SKIP: default strip (self-host safe); KEEP_FLEET_ONLY=1 keeps tail_consumers.
set_full_env
unset KEEP_FLEET_ONLY
"$render" "$tmp/out.toml" >"$tmp/log" 2>&1 || { echo "  FAIL selfhost-skip default render failed"; fail=$((fail + 1)); }
assert_toml "default render STRIPS fleet tail_consumers (self-host safe)" "'tail_consumers' in d" "False"
set_full_env
export KEEP_FLEET_ONLY=1
"$render" "$tmp/out-fleet.toml" >"$tmp/log" 2>&1 || { echo "  FAIL fleet-only render failed"; fail=$((fail + 1)); }
assert_toml "KEEP_FLEET_ONLY keeps tail_consumers" "bool(d.get('tail_consumers'))" "True" "$tmp/out-fleet.toml"

# cp#285: rendering is not enough, the pool JSON has to SURVIVE the round trip. A quoting choice
# that silently mangled it would render green and hand the Worker a string parseSharedPool refuses
# at runtime -- the same silent-inert class, one layer further along. Placed here rather than with
# the other pool cases because assert_toml is defined in this section.
set_full_env; export SHARED_RUNPOD_ENDPOINTS="$POOL_JSON"
"$render" "$tmp/out.toml" >"$tmp/log" 2>&1
assert_toml "the pool JSON round-trips through TOML byte-for-byte" \
  "__import__('json').loads(d['vars']['SHARED_RUNPOD_ENDPOINTS'])['backend']['id']" "aaa111"
unset SHARED_RUNPOD_ENDPOINTS
set_full_env
"$render" "$tmp/out.toml" >"$tmp/log" 2>&1

# NEGATIVE CONTROL. The four assertions above would ALSO pass if assert_toml were broken, or if
# every key happened to exist for unrelated reasons. Re-run them against a config deliberately
# regressed to the 2026-07-19 shape (assets moved below [observability]) and require them to FAIL.
# A guard only observed passing is an assumption with a green checkmark.
python3 - "$tmp/out.toml" "$tmp/regressed.toml" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
line = re.search(r"^assets = \{.*\}$", src, re.M)
src = src.replace(line.group(0) + "\n", "")
src = src.replace("[observability]\n", "[observability]\n" + line.group(0) + "\n")
open(sys.argv[2], "w").write(src)
PY

# The control's inner assertion is EXPECTED to fail, so its output is captured rather than printed:
# a literal "FAIL" line in CI output is the exact string a human greps for, and a deliberate one
# trains people to ignore real ones.
before_fail=$fail
assert_toml "CONTROL" "'assets' in d" "True" "$tmp/regressed.toml" >/dev/null 2>&1
if [ "$fail" -gt "$before_fail" ]; then
  echo "  ok   CONTROL held: the guard catches the 2026-07-19 regression (assets under [observability])"
  fail=$before_fail; pass=$((pass + 1))
else
  echo "  FAILED CONTROL: the guard passed a config it must have caught -- it proves nothing"
  fail=$((fail + 1))
fi

# VAR CENSUS (cf#56). A [vars] entry only reaches the Worker if it appears in wrangler.toml.example,
# in one of the render allowlists, AND in BOTH deploy.yml render env blocks. Nothing connected those
# lists, so a var could be typed in env.ts, read in deps.ts, and never passed -- rendering empty and
# shipping the feature INERT while the deploy stayed green. Caught by review, not by the pipeline;
# this is the pipeline catching it. Detail: scripts/var-census.py.
echo ""
echo "var census:"
if python3 "$here/scripts/var-census.py" "$here"; then
  echo "  ok   every placeholder is allowlisted and supplied by BOTH deploy render blocks"
  pass=$((pass + 1))
else
  echo "  FAIL var census (messages above)"
  fail=$((fail + 1))
fi

# CONTROL: the census must be able to FAIL, or the pass above only proves the script ran. Feed it a
# tree whose template carries a placeholder nothing allowlists and confirm it objects.
#
# The tree carries src/env.ts as of cp#218: the census reads it now, and a control tree missing it
# would make the census die on a missing file. That still exits non-zero, so this control would go
# on printing "ok" while proving nothing about the check it names. A control that passes for the
# wrong reason is the disease, not the cure.
census_tmp="$(mktemp -d)"
mkdir -p "$census_tmp/scripts" "$census_tmp/.github/workflows" "$census_tmp/src"
cp "$here/scripts/render-wrangler.sh" "$census_tmp/scripts/"
cp "$here/.github/workflows/deploy.yml" "$census_tmp/.github/workflows/"
cp "$here/src/env.ts" "$census_tmp/src/"
{ cat "$here/wrangler.toml.example"; echo "CENSUS_CONTROL_VAR = \"\${CENSUS_CONTROL_VAR}\""; } > "$census_tmp/wrangler.toml.example"
if python3 "$here/scripts/var-census.py" "$census_tmp" >/dev/null 2>&1; then
  echo "  FAILED CONTROL: the census accepted an unlisted placeholder -- it proves nothing"
  fail=$((fail + 1))
else
  echo "  ok   CONTROL: the census refuses an unlisted placeholder"
  pass=$((pass + 1))
fi
rm -rf "$census_tmp"

# CONTROL (cp#218): the class the census used to be BLIND to. A var typed in src/env.ts and
# declared in NO list is invisible to a check anchored on the template, because all four lists agree
# by all omitting it. CREDITS_ENFORCING shipped in v1.17.0 that way and never reached the Worker.
#
# Plant exactly that shape and require the census to refuse AND to NAME the planted field. Bare
# non-zero is not enough: the census can exit 1 for a dozen unrelated reasons, and a control that
# accepts any failure would keep printing ok after the check it is guarding was deleted.
census_tmp="$(mktemp -d)"
mkdir -p "$census_tmp/scripts" "$census_tmp/.github/workflows" "$census_tmp/src"
cp "$here/scripts/render-wrangler.sh" "$census_tmp/scripts/"
cp "$here/.github/workflows/deploy.yml" "$census_tmp/.github/workflows/"
cp "$here/wrangler.toml.example" "$census_tmp/"
sed "s|^export interface ControlPlaneEnv extends SmokeRenderBoundEnv {|&\n  CENSUS_CONTROL_PLANTED_VAR?: string;|" \
  "$here/src/env.ts" > "$census_tmp/src/env.ts"
if grep -q "CENSUS_CONTROL_PLANTED_VAR" "$census_tmp/src/env.ts"; then
  census_out="$(python3 "$here/scripts/var-census.py" "$census_tmp" 2>&1)" && census_rc=0 || census_rc=1
  if [ "$census_rc" -ne 0 ] && printf "%s" "$census_out" | grep -q "CENSUS_CONTROL_PLANTED_VAR is typed in src/env.ts and declared in NO list"; then
    echo "  ok   CONTROL: the census refuses a var typed in env.ts and declared nowhere"
    pass=$((pass + 1))
  else
    echo "  FAILED CONTROL: the census accepted (or misreported) a var declared in NO list -- the cp#218 gap is open"
    fail=$((fail + 1))
  fi
else
  echo "  FAILED CONTROL: could not plant the field, so this control tested nothing"
  fail=$((fail + 1))
fi
rm -rf "$census_tmp"

# CONTROL (cp#218): the WRONG fix must also be refused. The tempting way to silence a census failure
# is to add the name to a deploy list, and for a secret that is exactly backwards -- it would put a
# credential name into a tracked file. Plant that and require a refusal that says so.
census_tmp="$(mktemp -d)"
mkdir -p "$census_tmp/scripts" "$census_tmp/.github/workflows" "$census_tmp/src"
cp "$here/.github/workflows/deploy.yml" "$census_tmp/.github/workflows/"
cp "$here/wrangler.toml.example" "$census_tmp/"
cp "$here/src/env.ts" "$census_tmp/src/"
sed "s|^ALLOW_EMPTY=\"|ALLOW_EMPTY=\"CF_PROVISIONER_TOKEN |" \
  "$here/scripts/render-wrangler.sh" > "$census_tmp/scripts/render-wrangler.sh"
census_out="$(python3 "$here/scripts/var-census.py" "$census_tmp" 2>&1)" && census_rc=0 || census_rc=1
if [ "$census_rc" -ne 0 ] && printf "%s" "$census_out" | grep -q "CF_PROVISIONER_TOKEN is declared a SECRET"; then
  echo "  ok   CONTROL: the census refuses a declared secret named in a tracked deploy list"
  pass=$((pass + 1))
else
  echo "  FAILED CONTROL: a credential name in a deploy list went unremarked"
  fail=$((fail + 1))
fi
rm -rf "$census_tmp"

# CHANGELOG IMMUTABILITY (the v1.18.0 incident). A released section records what that artifact
# actually contains, so an entry landing under a released heading makes the changelog assert
# something the tag does not have. That is what happened: the release promotion left no fresh
# `## Unreleased`, and the next three merges had nowhere else to go.
echo ""
echo "changelog immutability:"
if python3 "$here/scripts/changelog-released-immutable.py" "$here" >/dev/null 2>&1; then
  echo "  ok   every released section still says what it said at its tag"
  pass=$((pass + 1))
else
  echo "  FAIL changelog immutability (run scripts/changelog-released-immutable.py for detail)"
  fail=$((fail + 1))
fi

# A working copy of everything the guard reads: the tags, the changelog, AND the correction
# allowlist. Copying the allowlist is load-bearing (cp#245): with it absent the guard refuses every
# drift, so a control that forgot it would pass for a reason it was not testing.
mk_cl_copy() {
  cp -r "$here/.git" "$1/.git" 2>/dev/null || true
  cp "$here/CHANGELOG.md" "$1/CHANGELOG.md"
  mkdir -p "$1/scripts"
  cp "$here/scripts/changelog-corrections.txt" "$1/scripts/changelog-corrections.txt"
}

# Plant an extra entry inside the section of $2 in the changelog at $1.
plant_entry() {
  python3 - "$1" "$2" <<"PY"
import sys
path, tag = sys.argv[1], sys.argv[2]
lines = open(path).read().split("\n")
i = next(n for n, l in enumerate(lines) if l.startswith("## " + tag))
lines.insert(i + 2, "### feat(planted): an entry that landed under a released heading\n")
open(path, "w").write("\n".join(lines))
PY
}

latest_tag="$(git -C "$here" tag --list "v*" --sort=-v:refname | head -1)"
# The first version in the allowlist: the one section that IS allowed to drift. Read from the file
# rather than hardcoded, so these controls follow the allowlist instead of drifting from it.
allowed_tag="$(grep -vE "^[[:space:]]*(#|$)" "$here/scripts/changelog-corrections.txt" | head -1 | awk "{print \$1}")"

# CONTROL: plant an entry under a RELEASED heading and require a refusal that NAMES the version.
# Bare non-zero is not enough -- this script exits 1 for a missing Unreleased heading too, so a
# control accepting any failure would keep printing ok after the immutability check was removed.
cl_tmp="$(mktemp -d)"
git -C "$here" worktree list >/dev/null 2>&1
mk_cl_copy "$cl_tmp"
plant_entry "$cl_tmp/CHANGELOG.md" "$latest_tag"
cl_out="$(python3 "$here/scripts/changelog-released-immutable.py" "$cl_tmp" 2>&1)" && cl_rc=0 || cl_rc=1
if [ "$cl_rc" -ne 0 ] && printf "%s" "$cl_out" | grep -q "the ${latest_tag} section has CHANGED"; then
  echo "  ok   CONTROL: an entry planted under a released heading is refused, by name"
  pass=$((pass + 1))
else
  echo "  FAILED CONTROL: a planted entry under ${latest_tag} went unremarked"
  fail=$((fail + 1))
fi
rm -rf "$cl_tmp"

# CONTROL (cp#245, THE REGRESSION): a section that MENTIONS the marker in prose must still be
# checked. This is the defect exactly: the waiver was a substring test, a v1.19.0 entry DOCUMENTED
# the mechanism with the marker quoted inside backticks, and that section waived immutability for
# itself. The guard found the planted drift and then permitted it, silently, for six days.
mention_tmp="$(mktemp -d)"
mk_cl_copy "$mention_tmp"
python3 - "$mention_tmp/CHANGELOG.md" "$latest_tag" <<"PY"
import sys
path, tag = sys.argv[1], sys.argv[2]
lines = open(path).read().split("\n")
i = next(n for n, l in enumerate(lines) if l.startswith("## " + tag))
# Prose ABOUT the hatch: indented and backticked, exactly the shape that broke it.
lines.insert(i + 2, "  `**CORRECTED AFTER PUBLICATION`. Declared, never inferred.\n")
open(path, "w").write("\n".join(lines))
PY
plant_entry "$mention_tmp/CHANGELOG.md" "$latest_tag"
men_out="$(python3 "$here/scripts/changelog-released-immutable.py" "$mention_tmp" 2>&1)" && men_rc=0 || men_rc=1
if [ "$men_rc" -ne 0 ] && printf "%s" "$men_out" | grep -q "the ${latest_tag} section has CHANGED"; then
  echo "  ok   CONTROL: a section that MENTIONS the marker in prose is still checked"
  pass=$((pass + 1))
else
  echo "  FAILED CONTROL: prose mentioning the marker disarmed the check again (cp#245)"
  fail=$((fail + 1))
fi
rm -rf "$mention_tmp"

# CONTROL: CONTENT CANNOT WAIVE. Even a correctly-formed declaration, at column 0, in the section
# being corrected, waives nothing on its own -- the version has to be in the allowlist, which is a
# file no changelog entry can reach. Without this control the fix would be one anchored substring
# away from the same class of defect.
undeclared_tmp="$(mktemp -d)"
mk_cl_copy "$undeclared_tmp"
python3 - "$undeclared_tmp/CHANGELOG.md" "$latest_tag" <<"PY"
import sys
path, tag = sys.argv[1], sys.argv[2]
lines = open(path).read().split("\n")
i = next(n for n, l in enumerate(lines) if l.startswith("## " + tag))
lines.insert(i + 2, "**CORRECTED AFTER PUBLICATION (planted).** A declaration with no allowlist row.\n")
open(path, "w").write("\n".join(lines))
PY
und_out="$(python3 "$here/scripts/changelog-released-immutable.py" "$undeclared_tmp" 2>&1)" && und_rc=0 || und_rc=1
if [ "$und_rc" -ne 0 ] && printf "%s" "$und_out" | grep -q "does not list it"; then
  echo "  ok   CONTROL: a declaration alone does not waive; the allowlist is required"
  pass=$((pass + 1))
else
  echo "  FAILED CONTROL: changelog content waived immutability by itself"
  fail=$((fail + 1))
fi
rm -rf "$undeclared_tmp"

# POSITIVE CONTROL: the hatch still OPENS. Every control above is a refusal, and a guard that simply
# refused everything would pass all of them while making a legitimate in-place correction
# impossible. The allowlisted section already declares its correction, so planting drift there must
# be PERMITTED.
hatch_tmp="$(mktemp -d)"
mk_cl_copy "$hatch_tmp"
plant_entry "$hatch_tmp/CHANGELOG.md" "$allowed_tag"
hatch_out="$(python3 "$here/scripts/changelog-released-immutable.py" "$hatch_tmp" 2>&1)" && hatch_rc=0 || hatch_rc=1
if [ "$hatch_rc" -eq 0 ] && printf "%s" "$hatch_out" | grep -q "${allowed_tag} is an allowlisted post-publication correction"; then
  echo "  ok   POSITIVE CONTROL: an allowlisted, declared correction is still permitted"
  pass=$((pass + 1))
else
  echo "  FAILED CONTROL: the hatch no longer opens, so a legitimate correction is now impossible"
  fail=$((fail + 1))
fi
rm -rf "$hatch_tmp"

# CONTROL: the other half. Allowlisted but with the reader-facing declaration REMOVED must refuse:
# the allowlist is for this script, the marker is for the person reading the changelog, and a
# correction nobody is told about is the record lying by omission.
silent_tmp="$(mktemp -d)"
mk_cl_copy "$silent_tmp"
python3 - "$silent_tmp/CHANGELOG.md" <<"PY"
import sys
path = sys.argv[1]
lines = open(path).read().split("\n")
open(path, "w").write("\n".join(l for l in lines if not l.startswith("**CORRECTED AFTER PUBLICATION")))
PY
plant_entry "$silent_tmp/CHANGELOG.md" "$allowed_tag"
sil_out="$(python3 "$here/scripts/changelog-released-immutable.py" "$silent_tmp" 2>&1)" && sil_rc=0 || sil_rc=1
if [ "$sil_rc" -ne 0 ] && printf "%s" "$sil_out" | grep -q "carries no line BEGINNING"; then
  echo "  ok   CONTROL: an allowlisted section that does not SAY it was corrected is refused"
  pass=$((pass + 1))
else
  echo "  FAILED CONTROL: a silent correction passed on the allowlist alone"
  fail=$((fail + 1))
fi
rm -rf "$silent_tmp"

# CONTROL: "nothing to check" must not read as "everything checks out". The guard printed ok having
# compared ZERO sections in CI, because a bare actions/checkout is shallow and carries no tags, so
# every version heading failed the is-it-released test and the loop did nothing. Its own control
# caught that; this pins the refusal so the silence cannot come back if the guard moves to another
# job that also lacks tags.
vac_tmp="$(mktemp -d)"
if git clone -q --depth 1 --no-tags "file://$here/.git" "$vac_tmp/r" 2>/dev/null; then
  cp "$here/scripts/changelog-released-immutable.py" "$here/CHANGELOG.md" "$vac_tmp/r/"
  vac_out="$(cd "$vac_tmp/r" && python3 changelog-released-immutable.py . 2>&1)" && vac_rc=0 || vac_rc=1
  if [ "$vac_rc" -ne 0 ] && printf "%s" "$vac_out" | grep -q "compared ZERO released sections"; then
    echo "  ok   CONTROL: a tagless checkout is REFUSED, not reported as a pass"
    pass=$((pass + 1))
  else
    echo "  FAILED CONTROL: the guard reported a pass with no tags to compare against"
    fail=$((fail + 1))
  fi
else
  echo "  FAILED CONTROL: could not build a tagless clone, so this control tested nothing"
  fail=$((fail + 1))
fi
rm -rf "$vac_tmp"

# CONTROL: a DUPLICATED released heading must be refused, not silently half-checked. A dict keyed by
# version keeps the LAST occurrence, so a changelog carrying `## v1.18.0` twice had one section
# compared and the other ignored entirely. A bad merge produced exactly that, twice, and the guard
# reported ok because the section it happened to look at matched its tag.
dup_tmp="$(mktemp -d)"
cp -r "$here/.git" "$dup_tmp/.git"
python3 - "$here/CHANGELOG.md" "$dup_tmp/CHANGELOG.md" <<"PY"
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
i = s.index("## v1.18.0")
open(dst, "w").write(s[:i] + "## v1.18.0 -- 2026-07-28\n\n### a stray section from a bad merge\n\n" + s[i:])
PY
dup_out="$(python3 "$here/scripts/changelog-released-immutable.py" "$dup_tmp" 2>&1)" && dup_rc=0 || dup_rc=1
if [ "$dup_rc" -ne 0 ] && printf "%s" "$dup_out" | grep -q "MORE THAN ONCE"; then
  echo "  ok   CONTROL: a duplicated released heading is refused, not half-checked"
  pass=$((pass + 1))
else
  echo "  FAILED CONTROL: a duplicated released heading was silently half-checked"
  fail=$((fail + 1))
fi
rm -rf "$dup_tmp"

echo ""
echo "  ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
