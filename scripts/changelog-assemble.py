#!/usr/bin/env python3
"""
Assembles changelog.d/ fragments (plus any legacy `## Unreleased` body) into a new released
section at RELEASE time (cp#358).

WHY FRAGMENTS. Every changelog entry used to land at the same `## Unreleased` anchor, so the
moment ANY PR merged, main's `## Unreleased` moved and re-conflicted every other open PR touching
it -- measured 2026-08-07: 20 mechanical conflicts resolved, cp#342 merged, and within seconds the
queue was back to 5 DIRTY with 16 more recomputing. One fragment file per PR under `changelog.d/`
removes the shared anchor: two PRs adding two DIFFERENT fragment files never touch the same file,
so the conflict class disappears rather than being made cheaper. See
scripts/changelog-entry-required.py (the merge-time guard) and tests/changelog-fragment-merge.test.py
(the proof that two fragments merge clean where two `## Unreleased` edits would not).

WHAT THIS SCRIPT DOES, in order:
  1. reads every changelog.d/*.md fragment, sorted by FILENAME (deterministic; `.gitkeep` excluded)
  2. ALSO reads whatever is still sitting under `## Unreleased` -- the migration window means the
     guard accepts EITHER a fragment OR a direct edit, so both sources can be populated at once
  3. emits a `## <version> -- <date>` section, in the same heading format
     scripts/changelog-released-immutable.py already expects (`## vX.Y.Z -- YYYY-MM-DD`), placed
     directly below the (now empty) `## Unreleased` heading -- i.e. at the top of the released
     body, exactly where a hand-promoted section already goes today
  4. deletes the consumed fragment files and leaves `## Unreleased` empty

ORDERING, stated because nothing else in the repo can recover true merge order across two
different input channels: the legacy `## Unreleased` body (if any) comes FIRST, in whatever order
it was already in, because it predates fragments existing at all; the fragments follow, in
filename-sorted order, which is issue-number order by the naming convention in CONTRIBUTING.md.

IDEMPOTENT-SAFE. Refuses loudly, and writes nothing, when `<version>` already appears as a heading
anywhere in CHANGELOG.md -- released or not. Re-running this script for a version already promoted
would otherwise silently duplicate the heading, which is exactly what
scripts/changelog-released-immutable.py's duplicate-heading check exists to catch after the fact;
this refuses BEFORE creating it. Run scripts/changelog-released-immutable.py after this script as
part of the release step; it must still pass, because the section this script writes for an
ALREADY-TAGGED version (a re-run after tagging) is checked byte-for-byte against the tag.
"""
import pathlib
import sys

FRAGMENT_DIR = "changelog.d"


def normalize_version(v):
    """Accept 'v1.23.0' or '1.23.0'; the file always spells it with the leading 'v'."""
    return v if v.startswith("v") else "v" + v


def section_bounds(lines, heading_text):
    """(start, end) line indices for the FIRST `## <heading_text>` section, end exclusive at the
    next `## ` heading or EOF. None if the heading is not present at all."""
    start = None
    for i, line in enumerate(lines):
        if line == "## " + heading_text:
            start = i
            break
    if start is None:
        return None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if lines[j].startswith("## "):
            end = j
            break
    return start, end


def version_heading_present(lines, version):
    """Is there already a '## <version>' heading, whether or not it carries a date suffix
    ('## v1.1.0' as written by hand, or '## v1.1.0 -- 2026-08-07' as this script writes it)?
    Prefix-matched with a word-boundary check so 'v1.1.0' cannot false-positive against a real
    heading for 'v1.1.0-rc1' or 'v1.1.01'."""
    needle = "## " + version
    for line in lines:
        if line == needle:
            return True
        if line.startswith(needle) and line[len(needle) : len(needle) + 1] in (" ", "\t"):
            return True
    return False


def read_fragments(root):
    """Fragment BODIES, sorted by filename, `.gitkeep` and non-.md files excluded. Each fragment's
    content is exactly the `### ...` block an author would have added under `## Unreleased` --
    no new syntax, so this is a plain read-and-strip, never a parse."""
    d = root / FRAGMENT_DIR
    if not d.is_dir():
        return [], []
    names = sorted(
        p.name for p in d.iterdir()
        if p.is_file() and p.name.endswith(".md") and p.name != ".gitkeep"
    )
    bodies = [(d / n).read_text().strip() for n in names]
    return names, bodies


def assemble(text, fragments_names, fragments_bodies, version, date):
    """Pure: returns (ok, new_text_or_message). Takes CHANGELOG.md's current text and the fragment
    bodies already read from disk, and returns the fully-updated text -- so this is testable
    without touching a filesystem, matching the style of verdict() in
    scripts/changelog-entry-required.py."""
    lines = text.split("\n")
    version = normalize_version(version)

    if version_heading_present(lines, version):
        return False, (
            "refusing: '## " + version + "' already appears as a heading in CHANGELOG.md. "
            "Re-running this script for a version already promoted would duplicate the heading, "
            "which scripts/changelog-released-immutable.py can only catch AFTER the fact. Nothing "
            "was written."
        )

    bounds = section_bounds(lines, "Unreleased")
    if bounds is None:
        return False, (
            "refusing: CHANGELOG.md has no '## Unreleased' heading to promote from. Add one before "
            "running this script."
        )
    start, end = bounds
    legacy_body = "\n".join(lines[start + 1 : end]).strip()

    parts = []
    if legacy_body:
        parts.append(legacy_body)
    parts.extend(fragments_bodies)
    content = "\n\n".join(parts).strip()

    new_section = ["## " + version + " -- " + date, ""]
    if content:
        new_section.append(content)
    new_section.append("")  # exactly one blank line before whatever heading follows

    new_lines = (
        lines[: start + 1]  # up to and including "## Unreleased"
        + [""]              # Unreleased left empty
        + new_section
        + lines[end:]        # the rest of the file, untouched
    )
    return True, "\n".join(new_lines)


def main(argv):
    if len(argv) != 3:
        print("usage: changelog-assemble.py <version> <date>", file=sys.stderr)
        return 2
    version, date = argv[1], argv[2]
    root = pathlib.Path(".")
    changelog_path = root / "CHANGELOG.md"
    text = changelog_path.read_text()

    names, bodies = read_fragments(root)
    ok, result = assemble(text, names, bodies, version, date)
    if not ok:
        print("changelog-assemble: " + result, file=sys.stderr)
        return 1

    changelog_path.write_text(result)
    for name in names:
        (root / FRAGMENT_DIR / name).unlink()

    summary = "consumed " + str(len(names)) + " fragment(s)"
    if names:
        summary += ": " + ", ".join(names)
    print("changelog-assemble: wrote '## " + normalize_version(version) + " -- " + date + "', " + summary)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
