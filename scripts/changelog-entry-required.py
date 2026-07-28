#!/usr/bin/env python3
"""
A PR touching src/ or public/ needs a CHANGELOG.md entry OF ITS OWN (cp#147).

WHY THIS IS A SCRIPT AND NOT SIX LINES OF YAML. It used to be six lines of YAML, and it passed
VACUOUSLY: it compared `git diff BASE HEAD`, two-dot, against a base that MOVES. Two-dot asks "what
is different between these two commits", so once another PR merged to main it swept that PR files
into this PR changed list. #242 touched three files under src/ with no entry of its own and the
check went green, because somebody else merged PR had touched CHANGELOG.md.

Another PR entry satisfied this PR requirement. The check was right when it fired and wrong when it
passed, which is worse than absent: its green is load-bearing exactly when nobody looks.

THE FIX IS THREE-DOT. `BASE...HEAD` diffs from the MERGE BASE, so it sees only what this PR did.
Same family as the other vacuous passes found today: a view that cannot distinguish two cases will
still answer as if it can.

Logic lives here rather than in the workflow so it can be DRIVEN BY A TEST against a synthetic
repository, including a fixture that reproduces the exact false pass above. A guard whose fix cannot
be watched failing is a guard nobody has verified.

Deliberately narrow, and that has not changed: src/ and public/ only, touch rather than content, and
the `no-changelog` label is a loud recorded escape hatch.
"""
import json
import subprocess
import sys


def changed_files(root, base, head, two_dot=False):
    """Files this PR changed. THREE-dot by default: from the merge base, so a moving main cannot
    lend this PR somebody else edits. two_dot exists ONLY so the test can reproduce the old bug."""
    spec = [base, head] if two_dot else [base + "..." + head]
    out = subprocess.run(
        ["git", "-C", root, "diff", "--name-only", *spec],
        capture_output=True, text=True, check=True,
    )
    return [l for l in out.stdout.split("\n") if l.strip()]


def verdict(files, labels=()):
    """(ok, message). Pure, so the decision is testable without a repository at all."""
    if any(l == "no-changelog" for l in labels):
        return True, "no-changelog label present: deliberate skip, recorded on the PR."
    touches_code = any(f.startswith("src/") or f.startswith("public/") for f in files)
    if not touches_code:
        return True, "no src/ or public/ changes."
    if "CHANGELOG.md" in files:
        return True, "src/ or public/ changed and CHANGELOG.md was updated."
    return False, (
        "This PR touches src/ or public/ but CHANGELOG.md is unchanged. Add an entry under "
        "the `## Unreleased` heading, or apply the `no-changelog` label if this is a deliberate skip."
    )


def main(argv):
    root, base, head = argv[1], argv[2], argv[3]
    labels = []
    if len(argv) > 4 and argv[4].strip():
        try:
            labels = json.loads(argv[4])
        except json.JSONDecodeError:
            labels = []
    files = changed_files(root, base, head)
    print("Changed files (three-dot, from the merge base):")
    for f in files:
        print("  " + f)
    ok, message = verdict(files, labels)
    if not ok:
        print("::error::" + message)
        return 1
    print("OK: " + message)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
