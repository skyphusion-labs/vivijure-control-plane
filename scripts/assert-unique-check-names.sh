#!/usr/bin/env bash
#
# assert-unique-check-names.sh -- cp#372
#
# A commit must draw at most ONE check run per check name PER PRODUCER. When two producers
# emit the same name on the same commit, every name-keyed view (the PR checks list, a
# required-context, any script matching on .name) collapses them into one line, so a red leg
# is indistinguishable from its green twin. That is the defect this asserts against.
#
# THE KEY IS THE PRODUCER, AND GETTING THE KEY WRONG IS THE WHOLE TRAP.
#
#   * .app does NOT work. On this estate both CodeQL producers report
#     app.slug = github-actions, app.id = 15368, so an app-keyed check would reproduce the
#     very failure it is meant to catch, one layer down.
#   * .check_suite.id does NOT work either, and this one reads correct until you measure it.
#     A single workflow re-invoked on an unchanged head opens a NEW check suite every time.
#     Measured 2026-08-15: skyphusion-labs/search-mcp drew 37 check runs named "sync" on one
#     commit from 97 runs of ONE workflow (corpus-sync.yml, repository_dispatch). A
#     suite-keyed check calls that 37 producers. It is one.
#   * The key that works is the WORKFLOW the check run came from: join the check runs to
#     the Actions runs on the same head sha through check_suite_id, and read .path. Rows with
#     no Actions run behind them (Dependabot, the advanced-security CodeQL aggregate) are
#     keyed by their app slug instead, which is the correct producer identity for those.
#
# Usage:
#   ./scripts/assert-unique-check-names.sh              # current default-branch head, live
#   TARGET_REF=<sha> ./scripts/assert-unique-check-names.sh
#   NORM_FILE=<file> ./scripts/assert-unique-check-names.sh   # offline, on a normalized payload
#   ./scripts/assert-unique-check-names.sh --selftest   # run the built-in controls only
#
# Exit: 0 pass, 1 collision found, 2 the check could not be trusted (refusal).

set -euo pipefail

# evaluate <normalized json file>
# normalized form: [ {"name": "<check name>", "producer": "<workflow path or app:slug>"}, ... ]
evaluate() {
  local f="$1" rows names dupes
  rows=$(jq 'length' "$f")
  echo "  denominator: ${rows} check run(s)"

  if [ "$rows" -eq 0 ]; then
    echo "  REFUSE: zero check runs. An empty set has no duplicate names and would pass for the wrong reason." >&2
    return 2
  fi

  names=$(jq '[.[].name] | unique | length' "$f")
  dupes=$(jq -r '
    group_by(.name)
    | map({name: .[0].name, producers: ([.[].producer] | unique)})
    | map(select((.producers | length) > 1))
    | .[]
    | "    " + .name + "  <- emitted by " + ((.producers | length) | tostring) + " producers: " + (.producers | join(", "))
  ' "$f")

  if [ -n "$dupes" ]; then
    echo "  FAIL: ${names} distinct check name(s); the following are emitted by more than one producer:" >&2
    printf "%s\n" "$dupes" >&2
    return 1
  fi

  echo "  PASS: each of the ${names} distinct check name(s) is emitted by exactly one producer."
  return 0
}

# normalize <check-runs payload> <actions-runs payload> -> normalized json on stdout
normalize() {
  jq -n --slurpfile cr "$1" --slurpfile wr "$2" '
    (($wr[0].workflow_runs // []) | map({key: (.check_suite_id | tostring), value: .path}) | from_entries) as $map
    | ($cr[0].check_runs // [])
    | map({
        name: .name,
        producer: ($map[(.check_suite.id | tostring)] // ("app:" + (.app.slug // "unknown")))
      })
  '
}

selftest() {
  # A control of the control. The assertion is only worth running if it can still go red, and
  # a repo with one producer passes it for the wrong reason. Prove every direction on
  # synthetic payloads before believing anything about a live commit.
  local dir rc
  dir=$(mktemp -d)
  trap "rm -rf \"$dir\"" RETURN

  # two producers, same name -> MUST fail
  printf '%s' '[{"name":"Analyze (python)","producer":".github/workflows/codeql.yml"},{"name":"Analyze (python)","producer":"dynamic/github-code-scanning/codeql"},{"name":"ci","producer":".github/workflows/ci.yml"}]' > "$dir/dirty.json"
  # distinct names -> MUST pass
  printf '%s' '[{"name":"CodeQL scan (python)","producer":".github/workflows/codeql.yml"},{"name":"Analyze (python)","producer":"dynamic/github-code-scanning/codeql"},{"name":"ci","producer":".github/workflows/ci.yml"}]' > "$dir/clean.json"
  # ONE producer, many runs, same name -> MUST pass. This is the false positive a
  # check-suite-keyed version of this script had, measured on a real repo.
  printf '%s' '[{"name":"sync","producer":".github/workflows/corpus-sync.yml"},{"name":"sync","producer":".github/workflows/corpus-sync.yml"},{"name":"sync","producer":".github/workflows/corpus-sync.yml"}]' > "$dir/rerun.json"
  # empty -> MUST refuse, not pass
  printf '%s' '[]' > "$dir/empty.json"

  echo "selftest 1/4 -- two producers under one name MUST fail:"
  rc=0; evaluate "$dir/dirty.json" || rc=$?
  [ "$rc" -eq 1 ] || { echo "SELFTEST BROKEN: collision not detected (rc=$rc)" >&2; return 2; }

  echo "selftest 2/4 -- distinct names MUST pass:"
  rc=0; evaluate "$dir/clean.json" || rc=$?
  [ "$rc" -eq 0 ] || { echo "SELFTEST BROKEN: clean payload rejected (rc=$rc)" >&2; return 2; }

  echo "selftest 3/4 -- one producer re-run many times MUST pass:"
  rc=0; evaluate "$dir/rerun.json" || rc=$?
  [ "$rc" -eq 0 ] || { echo "SELFTEST BROKEN: re-runs of one workflow read as a collision (rc=$rc)" >&2; return 2; }

  echo "selftest 4/4 -- an empty payload MUST refuse, not pass:"
  rc=0; evaluate "$dir/empty.json" || rc=$?
  [ "$rc" -eq 2 ] || { echo "SELFTEST BROKEN: empty payload not refused (rc=$rc)" >&2; return 2; }

  echo "selftest: all four controls behaved."
  return 0
}

main() {
  echo "== self-test (the assertion must be able to go red, and to stay green on re-runs) =="
  selftest || exit 2

  if [ "${1:-}" = "--selftest" ]; then
    exit 0
  fi

  local norm ref repo branch rc crf wrf total returned
  norm="${NORM_FILE:-}"
  if [ -n "$norm" ]; then
    echo "== evaluating normalized payload ${norm} =="
    rc=0; evaluate "$norm" || rc=$?
    exit "$rc"
  fi

  repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
  ref="${TARGET_REF:-}"
  if [ -z "$ref" ]; then
    branch=$(gh api "repos/${repo}" --jq .default_branch)
    ref=$(gh api "repos/${repo}/commits/${branch}" --jq .sha)
  fi

  crf=$(mktemp); wrf=$(mktemp); norm=$(mktemp)
  gh api "repos/${repo}/commits/${ref}/check-runs?per_page=100" > "$crf"

  total=$(jq -r '.total_count' "$crf")
  returned=$(jq -r '.check_runs | length' "$crf")
  if [ "$total" -gt "$returned" ]; then
    echo "REFUSE: check-run listing truncated (${returned} of ${total}). A truncated window cannot prove uniqueness." >&2
    exit 2
  fi

  gh api "repos/${repo}/actions/runs?head_sha=${ref}&per_page=100" --paginate --slurp \
    | jq '{total_count: .[0].total_count, workflow_runs: ([.[].workflow_runs] | add)}' > "$wrf"

  total=$(jq -r '.total_count' "$wrf")
  returned=$(jq -r '.workflow_runs | length' "$wrf")
  if [ "$total" -gt "$returned" ]; then
    echo "REFUSE: workflow-run listing truncated (${returned} of ${total}). The producer map would be incomplete, which turns a real collision into a pass." >&2
    exit 2
  fi
  echo "  producer map: ${returned} workflow run(s) of ${total} reported"

  normalize "$crf" "$wrf" > "$norm"
  echo "== evaluating ${repo} @ ${ref} =="
  rc=0; evaluate "$norm" || rc=$?
  rm -f "$crf" "$wrf" "$norm"
  exit "$rc"
}

main "$@"
