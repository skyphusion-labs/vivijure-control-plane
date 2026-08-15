#!/usr/bin/env python3
"""Refuse a PR body that carries a GitHub issue-linking keyword (cp#246 / cp#255 fallout).

WHY THIS EXISTS, and it is not pedantry.

The estate rule is that merge is not ship: a PR never closes an issue, the lead closes it by hand
against artifact evidence. On 2026-08-01 two PRs closed their issues anyway, at the instant they
merged, and **the sentences that fired were the DISCLAIMERS WRITTEN TO HONOUR THE RULE**:

    PR #257:  "Closes nothing by itself; the lead closes #246 against artifact evidence."
    PR #258:  "The lead closes #255 against artifact evidence; this does not close it."

GitHub matches `keyword #N` as a SUBSTRING and ignores every surrounding word. "does not close it"
is prose to a human and invisible to the parser; what fired was `closes #246` and `closes #255`.

cp#246 was closed at merge, and every piece of evidence that actually settled it -- the ancestry
probe, Run A, the accidental true positive -- arrived afterwards. The PR that closed it said in its
own body that it proved shape only.

THE SPLIT IS THE FINDING. A sweep of 112 artifacts by the author found the rule held in all 20
commit messages, where it was being applied deliberately, and broke only in PR bodies, where it was
being EXPLAINED. **The more carefully you word the denial, the more likely it is to fire**, because
a careful denial names the issue number, and naming the issue number next to the keyword is the
whole trigger.

SO THERE IS NO DENIAL CARVE-OUT HERE, DELIBERATELY. This guard does not try to tell "closes #1" from
"does not close #1", because context-sensitivity is precisely what GitHub lacks and precisely what
made the denial fire. Any linking keyword adjacent to an issue reference is refused, in any form,
however the sentence reads. Write `Refs #N` and describe what remains.

A LIVE HAZARD worth naming rather than leaving to be rediscovered: PR #65 carries `Closes #62` and
was closed UNMERGED, so it never fired. It would fire if anyone reopened and merged it.

EXIT CODES, and 2 is never a pass:
    0  clean
    1  a linking keyword was found
    2  the check could not be PERFORMED (the body was never supplied), because a guard that cannot
       see its input must not report that its input is fine. Same doctrine as
       scripts/check-satellite-pins.mjs.
"""
import os
import re
import sys

# GitHub's documented linking keywords, every accepted form.
KEYWORDS = r"clos(?:e|es|ed)|fix(?:|es|ed)|resolv(?:e|es|ed)"

# The reference forms GitHub accepts after a keyword:
#   #123                         same repo
#   owner/repo#123               cross repo  (a real hazard here: this estate writes
#                                             `vivijure-cf#279` in prose constantly)
#   GH-123                       legacy
#   https://github.com/o/r/issues/123
REFERENCE = (
    r"(?:"
    r"(?:[\w.-]+/)?[\w.-]*#\d+"
    r"|GH-\d+"
    r"|https?://github\.com/[\w.-]+/[\w.-]+/issues/\d+"
    r")"
)

PATTERN = re.compile(rf"\b(?:{KEYWORDS})\b\s*:?\s*{REFERENCE}", re.IGNORECASE)

# Fenced blocks first, so a fence is removed whole before the inline pass ever sees what is inside
# it; inline spans second. GitHub does not auto-close from either (cp#387), so a keyword+reference
# QUOTED in code is describing the string, not asserting a link -- categorically different from the
# same text in prose. Replaced with a space, not deleted, so a keyword on one side of a span and a
# reference on the other stay separated rather than fusing into an accidental match.
CODE_FENCE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE = re.compile(r"`[^`\n]*`")


def strip_code(text: str) -> str:
    """Blank out fenced code blocks and inline code spans before the pattern ever runs."""
    text = CODE_FENCE.sub(" ", text)
    text = INLINE_CODE.sub(" ", text)
    return text


def find_hits(body: str):
    """Every linking-keyword occurrence outside code, with context to see the sentence it hid in."""
    scrubbed = strip_code(body)
    hits = []
    for m in PATTERN.finditer(scrubbed):
        start = max(0, m.start() - 70)
        end = min(len(scrubbed), m.end() + 30)
        hits.append((m.group(0), scrubbed[start:end].replace("\n", " ").strip()))
    return hits


def main() -> int:
    # PRESENCE, not truthiness. An empty PR body is legal and clean; an ABSENT env var means the
    # workflow wiring is broken, and those two must not share an answer. This is the same failure
    # this whole guard is about: a check that cannot distinguish two states reporting the
    # reassuring one.
    if "PR_BODY" not in os.environ:
        print("pr-body-guard: PR_BODY is not set at all, so the body was never supplied.")
        print("pr-body-guard: refusing to report a pass on an input this check never saw.")
        return 2

    body = os.environ["PR_BODY"]
    hits = find_hits(body)
    if not hits:
        print(f"pr-body-guard: ok -- no issue-linking keyword in {len(body)} bytes of PR body.")
        return 0

    print(f"pr-body-guard: REFUSED -- {len(hits)} issue-linking keyword(s) in this PR body.")
    print("")
    for text, context in hits:
        print(f"  found: {text!r}")
        print(f"    in: ...{context}...")
        print("")
    print("In this estate merge is NOT ship: the lead closes issues by hand against artifact")
    print("evidence. GitHub matches these as a substring and ignores the surrounding sentence, so a")
    print("DENIAL fires exactly like an assertion -- that is how cp#246 and cp#255 were closed by the")
    print("very sentences written to say they would not be.")
    print("")
    print("Use `Refs #N` and describe what remains.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
