#!/usr/bin/env python3
"""
THE ACTUAL CLAIM of cp#358, proven with a real `git merge`, not reasoned about (cp#358 says a
green CI run is not evidence for it -- this drives git itself).

Two PRs each adding a DIFFERENT fragment file under changelog.d/ must merge into main WITHOUT a
conflict. The CONTROL is required and is the whole point: the same two PRs, if they instead both
edited the shared `## Unreleased` anchor the old way, must conflict on that merge -- otherwise
"fragments don't conflict" would be true of any two small edits and would say nothing about the
shared-anchor problem cp#358 exists to fix.
"""
import pathlib
import subprocess
import sys
import tempfile

failures = []
passes = []


def check(name, cond):
    (passes if cond else failures).append(name)
    print(("  ok   " if cond else "  FAIL ") + name)


def git(root, *args, check_rc=True):
    return subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=check_rc
    )


def new_repo():
    root = pathlib.Path(tempfile.mkdtemp())
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "t@example.com")
    git(root, "config", "user.name", "t")
    return root


def commit_all(root, msg):
    git(root, "add", "-A")
    git(root, "commit", "-qm", msg)


def merge_two_branches(root, branch_a, branch_b):
    """Merge branch_a into main (fast-forward), then attempt to merge branch_b into main.
    Returns the SECOND merge's completed process (the one that can conflict), and leaves the
    repo in whatever state git left it -- caller aborts if needed."""
    git(root, "checkout", "-q", "main")
    git(root, "merge", "-q", "--no-ff", "-m", "merge " + branch_a, branch_a)
    return subprocess.run(
        ["git", "-C", str(root), "merge", "--no-ff", "-m", "merge " + branch_b, branch_b],
        capture_output=True, text=True,
    )


print("changelog-fragment-merge (cp#358, the actual claim):")

# -------------------------------------------------------------------------------------------
# THE CLAIM: two PRs, each adding a DIFFERENT changelog.d/ fragment off the same base, merge
# into main cleanly, in either order.
# -------------------------------------------------------------------------------------------
root = new_repo()
(root / "CHANGELOG.md").write_text("# Changelog\n\n## Unreleased\n")
d = root / "changelog.d"
d.mkdir()
(d / ".gitkeep").write_text("")
(root / "src").mkdir()
(root / "src" / "shared.ts").write_text("export const x = 1;\n")
commit_all(root, "base")

git(root, "checkout", "-qb", "pr-a")
(d / "100-a.md").write_text("### feat(a): PR A (cp#100)\n\nchanged a.")
commit_all(root, "pr-a: add fragment")

git(root, "checkout", "-q", "main")
git(root, "checkout", "-qb", "pr-b")
(d / "200-b.md").write_text("### feat(b): PR B (cp#200)\n\nchanged b.")
commit_all(root, "pr-b: add fragment")

result = merge_two_branches(root, "pr-a", "pr-b")
check("THE CLAIM: two PRs adding DIFFERENT fragment files merge cleanly (no conflict)",
      result.returncode == 0 and "CONFLICT" not in result.stdout)

merged_dir = sorted(p.name for p in (root / "changelog.d").iterdir())
check("both fragment files are present on main after both merges",
      merged_dir == [".gitkeep", "100-a.md", "200-b.md"])

# -------------------------------------------------------------------------------------------
# THE CONTROL: the SAME two PRs, but editing the shared `## Unreleased` anchor the old way
# instead of adding a fragment, MUST conflict. Without this half, a clean fragment merge proves
# only that two unrelated small edits don't conflict -- not that the shared-anchor problem is
# what got fixed. Built from a FRESH base so the two scenarios cannot contaminate each other.
# -------------------------------------------------------------------------------------------
root2 = new_repo()
(root2 / "CHANGELOG.md").write_text("# Changelog\n\n## Unreleased\n")
(root2 / "src").mkdir()
(root2 / "src" / "shared.ts").write_text("export const x = 1;\n")
commit_all(root2, "base")

git(root2, "checkout", "-qb", "pr-a")
(root2 / "CHANGELOG.md").write_text(
    "# Changelog\n\n## Unreleased\n\n### feat(a): PR A (cp#100)\n\nchanged a.\n"
)
commit_all(root2, "pr-a: edit Unreleased directly (the old way)")

git(root2, "checkout", "-q", "main")
git(root2, "checkout", "-qb", "pr-b")
(root2 / "CHANGELOG.md").write_text(
    "# Changelog\n\n## Unreleased\n\n### feat(b): PR B (cp#200)\n\nchanged b.\n"
)
commit_all(root2, "pr-b: edit Unreleased directly (the old way)")

result2 = merge_two_branches(root2, "pr-a", "pr-b")
check(
    "CONTROL: the SAME two PRs editing the shared ## Unreleased anchor DO conflict",
    result2.returncode != 0 and "CONFLICT" in result2.stdout,
)
# Leave no half-merged state behind for the temp dir cleanup.
git(root2, "merge", "--abort", check_rc=False)

print("")
print("  %d passed, %d failed" % (len(passes), len(failures)))
sys.exit(1 if failures else 0)
