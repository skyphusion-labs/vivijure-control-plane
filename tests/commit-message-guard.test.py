#!/usr/bin/env python3
"""Drive scripts/commit-message-guard.py before anything trusts it (cp#265).

Reuses the shared matcher (scripts/pr-body-guard.py) -- this suite watches the CALLER: range
presence, empty-list refusal, and that a linking keyword in a commit message is refused the same
way a PR body is. The body-guard fixtures stay in tests/pr-body-guard.test.py; this file does not
re-derive the keyword class.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import pathlib

HERE = pathlib.Path(__file__).resolve().parent.parent
GUARD = HERE / "scripts" / "commit-message-guard.py"

passed = 0
failed = 0


def expect(name: str, want_rc: int, *, env: dict | None = None, cwd: pathlib.Path | None = None) -> None:
    global passed, failed
    run_env = dict(os.environ)
    # Strip range vars so an absent case is really absent, then overlay the case.
    run_env.pop("PR_BASE_SHA", None)
    run_env.pop("PR_HEAD_SHA", None)
    if env:
        run_env.update(env)
    p = subprocess.run(
        [sys.executable, str(GUARD)],
        capture_output=True,
        text=True,
        env=run_env,
        cwd=str(cwd) if cwd else None,
    )
    if p.returncode == want_rc:
        print(f"  ok   {name}")
        passed += 1
    else:
        print(f"  FAIL {name} -- wanted rc={want_rc}, got rc={p.returncode}")
        for line in (p.stdout + p.stderr).splitlines()[:8]:
            print(f"       {line}")
        failed += 1


def git(cwd: pathlib.Path, *args: str) -> str:
    p = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=True,
    )
    return p.stdout.strip()


def init_repo() -> pathlib.Path:
    """A throwaway repo with an initial commit so merge-base has something to stand on."""
    d = pathlib.Path(tempfile.mkdtemp(prefix="cmg-"))
    git(d, "init", "-q")
    git(d, "config", "user.email", "guard@test.local")
    git(d, "config", "user.name", "guard-test")
    (d / "README").write_text("base\n")
    git(d, "add", "README")
    git(d, "commit", "-q", "-m", "initial")
    return d


print("commit-message-guard:")

# ---- VACUOUS-PASS GUARDS. Absent or empty range must never read as clean. --------------------
expect("absent PR_BASE_SHA/PR_HEAD_SHA is rc=2", 2)
expect("empty PR_BASE_SHA is rc=2", 2, env={"PR_BASE_SHA": "", "PR_HEAD_SHA": "abc"})

# ---- POSITIVE + NEGATIVE against a real commit range. ----------------------------------------
repo = init_repo()
base = git(repo, "rev-parse", "HEAD")

# Clean commit: Refs form, the estate rule.
(repo / "a.txt").write_text("clean\n")
git(repo, "add", "a.txt")
git(repo, "commit", "-q", "-m", "fix(ci): something safe\n\nRefs #1.")
head_clean = git(repo, "rev-parse", "HEAD")
expect(
    "POSITIVE CONTROL: a Refs commit message is ACCEPTED",
    0,
    env={"PR_BASE_SHA": base, "PR_HEAD_SHA": head_clean},
    cwd=repo,
)

# The class that actually fires: linking keyword adjacent to a reference.
(repo / "b.txt").write_text("bad\n")
git(repo, "add", "b.txt")
# Use a denial form deliberately -- same trap that closed cp#246 from a PR body.
git(repo, "commit", "-q", "-m", "fix(ci): does not close #12 by itself")
head_bad = git(repo, "rev-parse", "HEAD")
expect(
    "a commit message carrying `close #N` is REFUSED",
    1,
    env={"PR_BASE_SHA": base, "PR_HEAD_SHA": head_bad},
    cwd=repo,
)

# ZERO commits in range (base == head): must be rc=2, never a pass.
expect(
    "zero commits in range is rc=2, never a pass",
    2,
    env={"PR_BASE_SHA": head_clean, "PR_HEAD_SHA": head_clean},
    cwd=repo,
)

print("")
print(f"  {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
