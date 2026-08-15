#!/usr/bin/env python3
"""
Structural guard on .github/workflows/ci.yml: cp#395.

WHY THIS EXISTS: the PR-body guard step used to read `${{ github.event.pull_request.body }}`, the
event payload frozen at whichever event queued the run. `gh run rerun` replays that stored payload
verbatim, so a body corrected after a refusal reran against the pre-edit text forever (measured on
cp#393: refused on `close cf#372`, fixed via `gh pr edit`, `gh run rerun --failed` refused again on
the OLD sentence, only an unrelated push cleared it). The fix reads the body live via `gh pr view` at
run time instead, so any rerun sees current state.

This is a SHAPE assertion, not a behaviour test (tests/pr-body-guard.test.py drives the matcher
itself): it exists so a future edit that reintroduces the frozen-payload read, or drops the fetch, or
drops the permission the fetch needs, fails here instead of surviving to the next cp#393.
"""
import sys, pathlib, yaml

root = pathlib.Path(__file__).resolve().parent.parent
wf = yaml.safe_load((root / ".github/workflows/ci.yml").read_text())

failures = []
checks = 0


def check(name, ok, detail=""):
    global checks
    checks += 1
    if ok:
        print("  ok   " + name)
    else:
        print("  FAIL " + name + (" -- " + detail if detail else ""))
        failures.append(name)


jobs = wf.get("jobs", {})
check("ci.yml defines the `ci` job", "ci" in jobs)

steps = (jobs.get("ci", {}) or {}).get("steps", []) or []
guard_steps = [s for s in steps if s.get("name") == "PR body carries no issue-linking keyword"]
check("the PR-body guard step exists", len(guard_steps) == 1, "found " + str(len(guard_steps)))

guard = guard_steps[0] if guard_steps else {}
env_text = str(guard.get("env", {}) or {})
run_text = str(guard.get("run", "") or "")
combined = env_text + "\n" + run_text

# THE FROZEN-PAYLOAD SOURCE MUST BE GONE, not just supplemented. A step that fetches live but also
# still assigns the event payload somewhere would silently prefer whichever ran last depending on
# how it is wired; asserting the string is absent closes that ambiguity outright.
check(
    "the guard step no longer reads the frozen event payload",
    "github.event.pull_request.body" not in combined,
    "combined env+run text: " + combined,
)

# THE LIVE FETCH MUST BE PRESENT. Absence-of-the-old-string alone would also pass if the step were
# deleted entirely or the body were dropped silently -- these two assert the replacement mechanism
# is actually there, not merely that the old one is gone.
check("the guard step fetches the PR via `gh pr view`", "gh pr view" in run_text, "run: " + run_text)
check("the guard step reads body as JSON (`--json body`)", "--json body" in run_text, "run: " + run_text)

# `gh pr view` needs read access to PR metadata; the ambient GITHUB_TOKEN is contents:read only
# unless the workflow grants more. Absent this, the live fetch fails on every fork PR and the guard
# silently degrades into whatever an auth failure produces -- which is not exit 2's "the check could
# not be performed" path, so it would misreport rather than refuse cleanly.
perms = wf.get("permissions", {}) or {}
check(
    "ci.yml grants `pull-requests: read` at the top level",
    perms.get("pull-requests") == "read",
    "permissions: " + str(perms),
)

print("")
print("  " + str(checks - len(failures)) + " passed, " + str(len(failures)) + " failed")
sys.exit(1 if failures else 0)
