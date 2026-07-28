#!/usr/bin/env python3
"""
A RELEASED changelog section is immutable (after the v1.18.0 incident).

WHY THIS EXISTS. #235 promoted `## Unreleased` to `## v1.18.0` without leaving a fresh empty
`## Unreleased` behind it. The tag was cut, and the next three PRs merged with their entries having
nowhere to land but under a heading that was already released. The result: CHANGELOG.md asserted
that v1.18.0 shipped cp#219, cp#223 and the cp#195 settlement trigger, and
`git merge-base --is-ancestor` says none of the three is in the tag.

Every one of those PRs was individually correct. The RELEASE PROCESS ate them, which is why the fix
is a check rather than a reminder: a convention that has already failed once is not a fix.

WHAT IT CHECKS, and note it is a property of the TREE rather than of a diff. For every `## vX.Y.Z`
heading that has a matching git tag, the section body here must be byte-identical to the same
section in CHANGELOG.md AT THAT TAG. No base ref, no diff parsing, no question of which lines this
PR touched: the released text either still says what it said when it shipped, or it does not.

That also catches the direction the incident actually produced, an entry ADDED under a released
heading, which no line-based "did you add a changelog entry" check would ever notice.

THE ONE EXCEPTION, and it is DECLARED rather than inferred. A released section may be corrected in
place when the original note was WRONG about what shipped, which this repo has already done once and
was right to: v1.17.0 said it contained two PRs when the tag carries four, and the fix was an
in-place correction that says so, on the reasoning that a release note is a claim about a diff and a
false claim is worth correcting legibly. A rule forbidding all edits would have forbidden exactly
that honesty.

So drift is permitted only in a section carrying the marker below, on its own line. Same shape as
the env-census exemptions: an explicit declaration a reviewer can see, never a guess from content.
An edit WITHOUT the marker is refused, which is the case the incident produced.

Exit 0 and print nothing when every released section is untouched; exit 1 and name each drift.
"""
import re
import subprocess
import sys
import pathlib

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
HEADING = re.compile(r"^## (v\d+\.\d+\.\d+)\b")

# The declared escape hatch. On its own line, inside the section being corrected.
CORRECTION_MARKER = "**CORRECTED AFTER PUBLICATION"


def sections(text):
    """Map version -> section body, for every released heading in a changelog."""
    lines = text.split("\n")
    starts = [(i, m.group(1)) for i, l in enumerate(lines) for m in [HEADING.match(l)] if m]
    out = {}
    for i, version in starts:
        end = len(lines)
        for j in range(i + 1, len(lines)):
            if lines[j].startswith("## "):
                end = j
                break
        out[version] = "\n".join(lines[i:end]).rstrip()
    return out


def git(*args):
    return subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=False
    )


text = (root / "CHANGELOG.md").read_text()
head = sections(text)
tags = set(git("tag", "--list", "v*").stdout.split())
problems = []
checked = 0

for version, body in head.items():
    if version not in tags:
        # Not released yet. Nothing to be immutable against.
        continue
    shown = git("show", version + ":CHANGELOG.md")
    if shown.returncode != 0:
        # A tag predating the changelog, or a clone without tag objects. Refusing would fail every
        # shallow CI checkout; staying silent would let this pass vacuously on a clone that can see
        # nothing. So it is reported as UNCHECKED rather than counted as a pass.
        print("changelog-immutable: cannot read CHANGELOG.md at " + version + "; NOT checked")
        continue
    at_tag = sections(shown.stdout).get(version)
    if at_tag is None:
        print("changelog-immutable: " + version + " has no section in its own tagged file; NOT checked")
        continue
    checked += 1
    if at_tag != body:
        if CORRECTION_MARKER in body:
            print(
                "changelog-immutable: " + version + " carries a declared post-publication "
                "correction; drift permitted"
            )
            continue
        problems.append(
            "the " + version + " section has CHANGED since the tag was cut. A released section "
            "records what that artifact actually contains, so editing it makes the changelog assert "
            "something the tag does not have. If this entry belongs to work merged AFTER " + version
            + ", it goes under the `## Unreleased` heading. If the original note was WRONG about "
            "what shipped, correct it in place AND mark the section with a line beginning "
            + CORRECTION_MARKER + ", which is the declared exception."
        )

# NOTHING TO CHECK AND EVERYTHING CHECKS OUT MUST NOT BE THE SAME OUTPUT.
#
# This script printed ok having compared ZERO sections, because a bare actions/checkout is shallow
# with no tags, so every `## vX.Y.Z` heading failed the "is it released" test and the loop did
# nothing. The guard was inert in CI while reading green, which is the same failure as a roll-up
# reporting rows_ingested 0 as success, or a meter reporting complete on a reading it never made.
#
# So an empty comparison is a REFUSAL. If this repo genuinely has no released version yet, that is a
# one-line allowance to add deliberately, not a silence to inherit.
if checked == 0:
    problems.append(
        "compared ZERO released sections, so this run proves nothing. Every version heading in "
        "CHANGELOG.md failed to match a git tag, which in CI almost always means the checkout is "
        "shallow and carries no tags: use `fetch-depth: 0` (or `fetch-tags: true`). Refusing "
        "rather than reporting a pass it did not earn."
    )

if "## Unreleased" not in text:
    problems.append(
        "CHANGELOG.md has no `## Unreleased` heading. Promoting it at release time without leaving "
        "a fresh empty one is exactly how the v1.18.0 entries ended up under a released heading: "
        "the next merge has nowhere to land."
    )

if problems:
    for p in problems:
        print("changelog-immutable: " + p)
    sys.exit(1)
sys.exit(0)
