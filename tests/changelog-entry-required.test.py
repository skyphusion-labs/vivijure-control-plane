#!/usr/bin/env python3
"""
Drives scripts/changelog-entry-required.py against a SYNTHETIC repository shaped exactly like the
situation that produced the false pass on #242.

THE FIXTURE IS THE POINT. If it cannot reproduce the old bug, the fix is unproven, so this asserts
BOTH directions on the same repository: two-dot passes (the bug) and three-dot refuses (the fix).

cp#358 EXTENSION. `changelog.d/` fragments (one file per PR, assembled into CHANGELOG.md at
release) are the fix for the PR queue being quadratic on a shared `## Unreleased` anchor -- see
scripts/changelog-assemble.py. The guard's job barely changes: it must accept a fragment file
touch exactly as it already accepts a `CHANGELOG.md` touch, during the migration window where
both forms are legal. These checks watch the pre-fix `verdict()` REFUSE a fragment-only PR before
the fix lands, so the fix is proven rather than assumed (per the file's own opening paragraph).
"""
import os
import subprocess
import sys
import tempfile
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[0] / ".." / "scripts"))
import importlib.util

spec = importlib.util.spec_from_file_location(
    "cer", str(pathlib.Path(__file__).resolve().parents[1] / "scripts" / "changelog-entry-required.py")
)
cer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cer)

failures = []
passes = []


def check(name, cond):
    (passes if cond else failures).append(name)
    print(("  ok   " if cond else "  FAIL ") + name)


def git(root, *args):
    return subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, check=True)


def build_repo(root):
    """main advances with SOMEBODY ELSE PR touching CHANGELOG.md; our branch touches src/ only."""
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "t@example.com")
    git(root, "config", "user.name", "t")
    (pathlib.Path(root) / "CHANGELOG.md").write_text("# Changelog\n\n## Unreleased\n")
    os.makedirs(os.path.join(root, "src"), exist_ok=True)
    (pathlib.Path(root) / "src" / "a.ts").write_text("export const a = 1;\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "base")
    base = git(root, "rev-parse", "HEAD").stdout.strip()

    # OUR branch: touches src/ and NOTHING else. This is #242.
    git(root, "checkout", "-qb", "pr")
    (pathlib.Path(root) / "src" / "a.ts").write_text("export const a = 2;\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "pr: src only, no changelog entry")
    head = git(root, "rev-parse", "HEAD").stdout.strip()

    # MAIN moves: somebody else PR lands and touches CHANGELOG.md. This is #233.
    git(root, "checkout", "-q", "main")
    (pathlib.Path(root) / "CHANGELOG.md").write_text("# Changelog\n\n## Unreleased\n\n### someone else\n")
    (pathlib.Path(root) / "src" / "b.ts").write_text("export const b = 1;\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "other PR: touches CHANGELOG.md")
    moved_base = git(root, "rev-parse", "HEAD").stdout.strip()
    return base, head, moved_base


print("changelog-entry-required:")
with tempfile.TemporaryDirectory() as root:
    base, head, moved_base = build_repo(root)

    # CONTROL: the fixture must REPRODUCE the false pass, or the fix below proves nothing.
    two_dot = cer.changed_files(root, moved_base, head, two_dot=True)
    ok_two, _ = cer.verdict(two_dot)
    check(
        "CONTROL: the fixture reproduces the bug (two-dot against a MOVED base passes vacuously)",
        ok_two and "CHANGELOG.md" in two_dot and "src/a.ts" in two_dot,
    )

    # THE FIX: three-dot sees only what this PR did, so the missing entry is caught.
    three_dot = cer.changed_files(root, moved_base, head)
    ok_three, msg = cer.verdict(three_dot)
    check(
        "three-dot REFUSES a src-only PR whose base merely happens to carry a changelog change",
        (not ok_three) and "CHANGELOG.md" not in three_dot and "src/a.ts" in three_dot,
    )
    check("and the refusal explains itself", "neither CHANGELOG.md nor a changelog.d/ fragment" in msg)

    # A PR that DOES carry its own entry still passes, so the fix is not simply "always refuse".
    git(root, "checkout", "-q", "pr")
    (pathlib.Path(root) / "CHANGELOG.md").write_text("# Changelog\n\n## Unreleased\n\n### ours\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "pr: add our own entry")
    head2 = git(root, "rev-parse", "HEAD").stdout.strip()
    ok_own, _ = cer.verdict(cer.changed_files(root, moved_base, head2))
    check("a PR carrying its OWN entry still passes", ok_own)

# The pure decision, with no repository at all.
check("a docs-only PR needs no entry", cer.verdict(["docs/x.md", "tests/y.ts"])[0])
check("the no-changelog label is still a loud escape hatch",
      cer.verdict(["src/a.ts"], ["no-changelog"])[0])
check("CONTROL: without the label that same PR is refused",
      not cer.verdict(["src/a.ts"])[0])

# ---------------------------------------------------------------------------------------------
# cp#358: fragment-per-PR is a SECOND way to satisfy the same requirement, not a replacement.
# ---------------------------------------------------------------------------------------------

# (a) PROOF: the guard FAILS on src/ with neither a CHANGELOG.md edit nor a fragment. This is the
# same list as the CONTROL two lines up, restated here so the fragment feature's own proof block
# is self-contained and does not depend on reading the rest of the file.
ok_neither, msg_neither = cer.verdict(["src/a.ts"])
check("(a) PROOF: src/ change with NEITHER CHANGELOG.md NOR a changelog.d/ fragment is refused",
      not ok_neither)
check("(a) and the refusal names both accepted forms",
      "changelog.d/" in msg_neither and "CHANGELOG.md" in msg_neither)

# (b) PROOF: a changelog.d/ fragment alone is accepted -- the new form.
ok_fragment, _ = cer.verdict(["src/a.ts", "changelog.d/358-fragment-format.md"])
check("(b) PROOF: src/ change with a changelog.d/ fragment ONLY is accepted", ok_fragment)

# (b) PROOF, restated: CHANGELOG.md alone is STILL accepted -- the migration-window form, so the
# fix is additive and does not break every currently-open PR that already carries an Unreleased
# edit (cp#358's own stated constraint).
ok_changelog_only, _ = cer.verdict(["src/a.ts", "CHANGELOG.md"])
check("(b) PROOF: src/ change with a CHANGELOG.md edit ONLY is still accepted (migration window)",
      ok_changelog_only)

# Negative control on the fragment form: a file merely inside changelog.d/ that is NOT a markdown
# fragment (the tracked .gitkeep) must not satisfy the guard -- otherwise the check degenerates to
# "did you touch this directory at all", which any accidental touch would satisfy.
ok_gitkeep, _ = cer.verdict(["src/a.ts", "changelog.d/.gitkeep"])
check("CONTROL: touching changelog.d/.gitkeep alone does NOT satisfy the guard",
      not ok_gitkeep)

print("")
print("  %d passed, %d failed" % (len(passes), len(failures)))
sys.exit(1 if failures else 0)
