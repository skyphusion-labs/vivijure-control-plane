#!/usr/bin/env bash
# Run ONE live suite and refuse a pass that did not run (cp#536).
#
#   bash scripts/run-live-suite.sh tests/<name>.live.test.ts
#
# Every live suite gates itself with describe.skipIf(!LIVE). With a secret or an opt-in variable
# missing, vitest skips every test and exits 0, so a gate step reads green having measured nothing.
# This wrapper keeps vitest's own output and also writes its JSON report, then exits 1 unless the
# suite ran at least one test, skipped none and failed none. A skip is "could not measure", which
# is never a pass.
set -uo pipefail
suite="${1:?usage: run-live-suite.sh tests/<name>.live.test.ts}"
[ -f "$suite" ] || { echo "::error::live suite $suite does not exist"; exit 1; }
base="$(basename "$suite" .ts)"
report="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/live-suite-${base}.json"
rm -f "$report"
npx vitest run "$suite" --reporter=default --reporter=json --outputFile.json="$report"
rc=$?
python3 - "$report" "$suite" "$rc" <<'PY'
import json, sys
path, suite, rc = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    r = json.load(open(path))
except Exception as e:
    print("::error::%s wrote no readable JSON report (%s); cannot tell whether it ran" % (suite, type(e).__name__))
    sys.exit(1)
total = int(r.get("numTotalTests") or 0)
passed = int(r.get("numPassedTests") or 0)
failed = int(r.get("numFailedTests") or 0)
skipped = int(r.get("numPendingTests") or 0) + int(r.get("numTodoTests") or 0)
print("@live-suite %s rc=%d total=%d passed=%d failed=%d skipped=%d" % (suite, rc, total, passed, failed, skipped))
bad = []
if rc != 0: bad.append("vitest exited %d" % rc)
if total == 0: bad.append("no test ran")
if skipped: bad.append("%d test(s) skipped: a missing secret or opt-in variable reads as could-not-measure, never a pass" % skipped)
if failed: bad.append("%d test(s) failed" % failed)
if passed != total - skipped - failed: bad.append("counts do not add up")
if bad:
    print("::error::%s: %s" % (suite, "; ".join(bad)))
    sys.exit(1)
PY
