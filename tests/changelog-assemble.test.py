#!/usr/bin/env python3
"""
Drives scripts/changelog-assemble.py against synthetic fixtures (cp#358).

THE FIXTURE IS THE POINT, same discipline as tests/changelog-entry-required.test.py. This asserts
the assembler's output BYTE-FOR-BYTE against a written expectation, including the migration case
where a fragment and a hand-edited `## Unreleased` body are BOTH populated at once (the guard in
scripts/changelog-entry-required.py accepts either form, so a release can genuinely see both).

It also proves the fixture the pilot's proof requirement names explicitly: after assembling and
tagging, scripts/changelog-released-immutable.py must still pass against the result.
"""
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
import importlib.util

repo_root = pathlib.Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(
        name.replace("-", "_"), str(repo_root / "scripts" / (name + ".py"))
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ca = load("changelog-assemble")

failures = []
passes = []


def check(name, cond):
    (passes if cond else failures).append(name)
    print(("  ok   " if cond else "  FAIL ") + name)


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=True)


print("changelog-assemble:")

# -------------------------------------------------------------------------------------------
# (d) PROOF: pure assemble() output, byte-for-byte, against a written expectation.
# -------------------------------------------------------------------------------------------

BASE = (
    "# Changelog\n\n"
    "All notable changes.\n\n"
    "## Unreleased\n\n"
    "## v1.0.0 -- 2026-01-01\n\n"
    "### old release\n"
)

# Fragment-only case: no legacy Unreleased body, two fragments.
ok, out = ca.assemble(
    BASE,
    ["100-a.md", "200-b.md"],
    ["### feat(x): a (cp#100)\n\nbody a.", "### fix(y): b (cp#200)\n\nbody b."],
    "v1.1.0",
    "2026-08-07",
)
expected_fragment_only = (
    "# Changelog\n\n"
    "All notable changes.\n\n"
    "## Unreleased\n\n"
    "## v1.1.0 -- 2026-08-07\n\n"
    "### feat(x): a (cp#100)\n\nbody a.\n\n### fix(y): b (cp#200)\n\nbody b.\n\n"
    "## v1.0.0 -- 2026-01-01\n\n"
    "### old release\n"
)
check("(d) PROOF: fragment-only assembly is byte-correct against a written fixture",
      ok and out == expected_fragment_only)

# Legacy-only case (pure migration-window PR, no fragments at all): output must equal today's
# hand-promotion behaviour -- the legacy body carried through unchanged.
legacy_only_base = (
    "# Changelog\n\n"
    "## Unreleased\n\n"
    "### direct edit, no fragment\n\nprose.\n\n"
    "## v1.0.0 -- 2026-01-01\n\n### old\n"
)
ok, out = ca.assemble(legacy_only_base, [], [], "v1.1.0", "2026-08-07")
expected_legacy_only = (
    "# Changelog\n\n"
    "## Unreleased\n\n"
    "## v1.1.0 -- 2026-08-07\n\n"
    "### direct edit, no fragment\n\nprose.\n\n"
    "## v1.0.0 -- 2026-01-01\n\n### old\n"
)
check("(d) PROOF: legacy-Unreleased-only assembly is byte-correct (no fragments touched at all)",
      ok and out == expected_legacy_only)

# (d) THE MIGRATION CASE: BOTH sources populated in the same release -- a fragment PR and a
# direct-edit PR both merged before this release cut. Legacy body first (predates fragments),
# fragments after in filename-sorted order.
ok, out = ca.assemble(
    legacy_only_base,
    ["050-earlier-issue.md"],
    ["### feat(z): fragment entry (cp#50)\n\nfragment prose."],
    "v1.1.0",
    "2026-08-07",
)
expected_both = (
    "# Changelog\n\n"
    "## Unreleased\n\n"
    "## v1.1.0 -- 2026-08-07\n\n"
    "### direct edit, no fragment\n\nprose.\n\n"
    "### feat(z): fragment entry (cp#50)\n\nfragment prose.\n\n"
    "## v1.0.0 -- 2026-01-01\n\n### old\n"
)
check("(d) PROOF: BOTH-SOURCES-POPULATED migration case is byte-correct "
      "(legacy body first, fragment after)",
      ok and out == expected_both)

# Empty release: no fragments, no legacy body. Still produces a valid, minimal heading.
empty_base = "# Changelog\n\n## Unreleased\n\n## v1.0.0 -- 2026-01-01\n\n### old\n"
ok, out = ca.assemble(empty_base, [], [], "v1.1.0", "2026-08-07")
check("(d) PROOF: an empty release (nothing to assemble) still succeeds and writes a bare heading",
      ok and "## v1.1.0 -- 2026-08-07" in out and "## v1.0.0 -- 2026-01-01" in out)

# -------------------------------------------------------------------------------------------
# IDEMPOTENT-SAFE: refuses rather than duplicating a heading that already exists.
# -------------------------------------------------------------------------------------------
already_released = "# Changelog\n\n## Unreleased\n\n## v1.1.0 -- 2026-08-01\n\n### already there\n"
ok, msg = ca.assemble(already_released, ["100-a.md"], ["### new"], "v1.1.0", "2026-08-07")
check("REFUSES when the version heading already exists (no tag needed to trigger this)",
      not ok and "already appears as a heading" in msg)

# Accepts a version passed WITHOUT the leading 'v', normalizing before the duplicate check and
# the write -- so the guard cannot be bypassed by spelling the version differently.
ok, msg = ca.assemble(already_released, [], [], "1.1.0", "2026-08-07")
check("REFUSES the un-prefixed spelling too ('1.1.0' normalizes to 'v1.1.0')",
      not ok and "v1.1.0" in msg)

# No '## Unreleased' heading at all: refuse rather than guess where to insert.
no_unreleased = "# Changelog\n\n## v1.0.0 -- 2026-01-01\n\n### old\n"
ok, msg = ca.assemble(no_unreleased, [], [], "v1.1.0", "2026-08-07")
check("REFUSES when CHANGELOG.md has no '## Unreleased' heading to promote from",
      not ok and "Unreleased" in msg)

# -------------------------------------------------------------------------------------------
# Filesystem-level: fragments are read sorted by filename and DELETED on success; a failed
# (refused) run touches nothing on disk.
# -------------------------------------------------------------------------------------------
with tempfile.TemporaryDirectory() as root:
    root = pathlib.Path(root)
    (root / "CHANGELOG.md").write_text(BASE)
    d = root / "changelog.d"
    d.mkdir()
    (d / ".gitkeep").write_text("")
    (d / "200-later.md").write_text("### later\n\nlater body.")
    (d / "050-earlier.md").write_text("### earlier\n\nearlier body.")

    proc = subprocess.run(
        [sys.executable, str(repo_root / "scripts" / "changelog-assemble.py"), "v1.1.0", "2026-08-07"],
        cwd=root, capture_output=True, text=True,
    )
    check("main(): exits 0 on a real fixture directory", proc.returncode == 0)

    remaining = sorted(p.name for p in d.iterdir())
    check("main(): consumed fragments are DELETED from changelog.d/, .gitkeep survives",
          remaining == [".gitkeep"])

    written = (root / "CHANGELOG.md").read_text()
    check("main(): fragments were read in FILENAME-sorted order (050 before 200), not directory order",
          written.index("earlier body") < written.index("later body"))

    # A second run for the SAME version, against the file main() already wrote, must refuse and
    # must not touch the tree (there is nothing left to delete anyway, but assert no traceback).
    proc2 = subprocess.run(
        [sys.executable, str(repo_root / "scripts" / "changelog-assemble.py"), "v1.1.0", "2026-08-07"],
        cwd=root, capture_output=True, text=True,
    )
    check("main(): a second run for the same version REFUSES (idempotent-safe end to end)",
          proc2.returncode == 1 and "already appears as a heading" in proc2.stderr)

# -------------------------------------------------------------------------------------------
# The stated proof requirement: after assembling and TAGGING, changelog-released-immutable.py
# must still pass. This is a real git repo with a real tag, not a string comparison.
# -------------------------------------------------------------------------------------------
with tempfile.TemporaryDirectory() as root:
    root = pathlib.Path(root)
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "t@example.com")
    git(root, "config", "user.name", "t")
    (root / "CHANGELOG.md").write_text(BASE)
    d = root / "changelog.d"
    d.mkdir()
    (d / ".gitkeep").write_text("")
    (d / "100-a.md").write_text("### feat(x): a (cp#100)\n\nbody a.")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "base with one fragment")

    proc = subprocess.run(
        [sys.executable, str(repo_root / "scripts" / "changelog-assemble.py"), "v1.1.0", "2026-08-07"],
        cwd=root, capture_output=True, text=True,
    )
    check("release fixture: assemble succeeds", proc.returncode == 0)
    git(root, "add", "-A")
    git(root, "commit", "-qm", "chore(release): v1.1.0")
    git(root, "tag", "v1.1.0")

    immutable = subprocess.run(
        [sys.executable, str(repo_root / "scripts" / "changelog-released-immutable.py"), str(root)],
        capture_output=True, text=True,
    )
    check("PROOF: scripts/changelog-released-immutable.py STILL PASSES against the assembled + "
          "tagged output",
          immutable.returncode == 0)

    # CONTROL: the immutable check is not vacuous here -- hand-editing the released section AFTER
    # the tag must make it fail, or the pass above proves nothing.
    text = (root / "CHANGELOG.md").read_text()
    (root / "CHANGELOG.md").write_text(text.replace("body a.", "body a. TAMPERED"))
    immutable_tampered = subprocess.run(
        [sys.executable, str(repo_root / "scripts" / "changelog-released-immutable.py"), str(root)],
        capture_output=True, text=True,
    )
    check("CONTROL: the immutable check is not vacuous -- a hand-edit to the tagged section fails it",
          immutable_tampered.returncode == 1)

print("")
print("  %d passed, %d failed" % (len(passes), len(failures)))
sys.exit(1 if failures else 0)
