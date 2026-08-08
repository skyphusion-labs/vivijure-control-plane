#!/usr/bin/env python3
"""Refuse PR commit messages that carry a GitHub issue-linking keyword (cp#265).

WHY THIS EXISTS (and why the PR-body guard alone is not enough).

The estate rule is that merge is not ship: a PR never closes an issue; the lead closes it by
hand against artifact evidence. #263 gated the PR body. That is the surface a human reads, and
it is where the two real incidents were authored (cp#246 / cp#255).

But on squash merge, **the squash commit body IS the original commit message**. The PR body does
not land on the default branch at all. GitHub auto-closes by reading the merge commit that lands
on main, so the commit-message path is the one that actually fires. Measured with a probe that
could match (cp#265): the squash body carries the commit message, not the PR body.

This driver reuses `scripts/pr-body-guard.py` (same matcher, same exit codes). Two matchers
wearing one name is the drift the guards:config change existed to prevent. Only the CALLER
differs: enumerate every commit on the PR and run the shared matcher over each message.

EXIT CODES, and 2 is never a pass:
    0  every commit message is clean
    1  at least one commit carries a linking keyword
    2  the check could not be PERFORMED (range unset, git failed, or ZERO commits in range).
       A zero-commit answer and a clean answer must not share an exit code.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GUARD = HERE / "pr-body-guard.py"


def _run_guard(message: str) -> tuple[int, str]:
    """Drive the shared matcher with the message as PR_BODY (env, never shell-interpolated)."""
    env = dict(os.environ)
    env["PR_BODY"] = message
    p = subprocess.run(
        [sys.executable, str(GUARD)],
        capture_output=True,
        text=True,
        env=env,
    )
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        capture_output=True,
        text=True,
    )


def main() -> int:
    # PRESENCE of both ends of the range. Absent means the workflow never supplied the PR tips,
    # and that must not read as "every commit is fine".
    if "PR_BASE_SHA" not in os.environ or "PR_HEAD_SHA" not in os.environ:
        print("commit-message-guard: PR_BASE_SHA and/or PR_HEAD_SHA is not set.")
        print("commit-message-guard: refusing to report a pass on a range this check never saw.")
        return 2

    base = os.environ["PR_BASE_SHA"].strip()
    head = os.environ["PR_HEAD_SHA"].strip()
    if not base or not head:
        print("commit-message-guard: PR_BASE_SHA / PR_HEAD_SHA is empty.")
        print("commit-message-guard: refusing to report a pass on an empty range.")
        return 2

    # merge-base so a base tip that moved ahead of the PR still yields the PR's own commits.
    mb = _git("merge-base", base, head)
    if mb.returncode != 0 or not mb.stdout.strip():
        print("commit-message-guard: git merge-base failed for the supplied range.")
        print(f"  base={base!r} head={head!r}")
        if mb.stderr:
            print(mb.stderr.strip())
        print("commit-message-guard: refusing to report a pass on a range git cannot resolve.")
        return 2
    merge_base = mb.stdout.strip()

    listed = _git("rev-list", "--reverse", f"{merge_base}..{head}")
    if listed.returncode != 0:
        print("commit-message-guard: git rev-list failed.")
        if listed.stderr:
            print(listed.stderr.strip())
        return 2

    shas = [line.strip() for line in listed.stdout.splitlines() if line.strip()]
    # ZERO commits must not share an exit code with a clean pass. An empty PR, a range that
    # collapsed, or a checkout that cannot see the commits all land here.
    if not shas:
        print(
            f"commit-message-guard: zero commits in {merge_base[:12]}..{head[:12]} "
            f"(base={base[:12]})."
        )
        print("commit-message-guard: refusing to report a pass on an empty commit list.")
        return 2

    print(f"commit-message-guard: checking {len(shas)} commit(s) in the PR range.")
    refused = 0
    for sha in shas:
        msg_p = _git("log", "-1", "--format=%B", sha)
        if msg_p.returncode != 0:
            print(f"commit-message-guard: could not read message for {sha}.")
            return 2
        message = msg_p.stdout
        # Subject line for the log only; the full body is what the matcher sees.
        subject = message.splitlines()[0] if message.strip() else "(empty message)"
        rc, out = _run_guard(message)
        if rc == 0:
            print(f"  ok   {sha[:12]}  {subject}")
            continue
        if rc == 2:
            # The shared guard could not see its input. That is a wiring defect, not a clean commit.
            print(f"  FAIL {sha[:12]}  guard could not see input (rc=2)")
            print(out)
            return 2
        refused += 1
        print(f"  REFUSED {sha[:12]}  {subject}")
        for line in out.splitlines():
            print(f"    {line}")

    if refused:
        print("")
        print(
            f"commit-message-guard: REFUSED -- {refused} of {len(shas)} commit message(s) "
            "carry an issue-linking keyword."
        )
        print("On squash merge the commit message IS what lands on main, and that is what GitHub")
        print("auto-closes from. Use `Refs #N` and describe what remains.")
        return 1

    print(f"commit-message-guard: ok -- {len(shas)} commit message(s) clean.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
