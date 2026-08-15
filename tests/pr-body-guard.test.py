#!/usr/bin/env python3
"""Drive scripts/pr-body-guard.py, watching it REFUSE before anything trusts it.

THE PROBE IS A MEMBER OF THE CLASS, NOT MERELY SOMETHING THE GUARD DISLIKES.

That distinction is an estate rule paid for hours before this file existed. Proving `check:pins`
belonged on the deploy path, the first probe planted a satellite tag of "9.9.9-probe" and `npm test`
went red -- which reads as coverage. It was not: the suite caught the FORMAT
(/^\\d+\\.\\d+\\.\\d+$/), not the existence. A pin that is well-formed and simply absent passes every
other gate. **A guard that fires on your probe has not necessarily fired on your class.**

So the fixtures here are not invented strings the guard happens to hate. Every REFUSE fixture is a
string GitHub would genuinely auto-close on, and the two headline ones are the VERBATIM sentences
that actually closed cp#246 and cp#255 at merge.

And there is a POSITIVE CONTROL, because a guard only ever seen refusing is indistinguishable from
one that refuses everything.
"""
import os
import subprocess
import sys
import pathlib

HERE = pathlib.Path(__file__).resolve().parent.parent
GUARD = HERE / "scripts" / "pr-body-guard.py"

passed = 0
failed = 0


def run(body, *, supply=True):
    env = dict(os.environ)
    env.pop("PR_BODY", None)
    if supply:
        env["PR_BODY"] = body
    p = subprocess.run([sys.executable, str(GUARD)], capture_output=True, text=True, env=env)
    return p.returncode, p.stdout + p.stderr


def expect(name, body, want_rc, *, supply=True):
    global passed, failed
    rc, out = run(body, supply=supply)
    if rc == want_rc:
        print(f"  ok   {name}")
        passed += 1
    else:
        print(f"  FAIL {name} -- wanted rc={want_rc}, got rc={rc}")
        for line in out.splitlines()[:6]:
            print(f"       {line}")
        failed += 1


print("pr-body-guard:")

# ---- POSITIVE CONTROLS. Without these a guard that refuses everything passes every case below. ---
expect("POSITIVE CONTROL: a `Refs #N` body is ACCEPTED", "Refs #1. Describes what remains.", 0)
expect(
    "POSITIVE CONTROL: a realistic clean body is ACCEPTED",
    "## What changed\n\nMoved the guard suite onto the deploy path.\n\nRefs #246, #260.\n"
    "Evidence: run 30681068615. See vivijure-cf#279 for the sibling.",
    0,
)
expect("POSITIVE CONTROL: an empty body is legal and ACCEPTED", "", 0)

# ---- THE TWO THAT ACTUALLY FIRED, verbatim. These are the whole reason this guard exists. --------
expect(
    "the VERBATIM PR #257 disclaimer is REFUSED",
    "Closes nothing by itself; the lead closes #246 against artifact evidence.",
    1,
)
expect(
    "the VERBATIM PR #258 disclaimer is REFUSED",
    "The lead closes #255 against artifact evidence; this does not close it.",
    1,
)

# ---- THE DENIAL FORM GENERALLY. No carve-out, deliberately: context-sensitivity is exactly what
# ---- GitHub lacks and exactly what let the disclaimers fire. -------------------------------------
expect("a denial phrased as `does not close #N` is REFUSED", "This does not close #12.", 1)
expect("a denial phrased as `will not fix #N` is REFUSED", "This will not fix #12 by itself.", 1)

# ---- Every keyword, every accepted reference form. Members of the class, not lookalikes. ---------
for kw in ("close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"):
    expect(f"bare `{kw} #1` is REFUSED", f"{kw} #1", 1)

expect("capitalised `Closes #1` is REFUSED", "Closes #1", 1)
expect("colon form `Closes: #1` is REFUSED", "Closes: #1", 1)
expect("CROSS-REPO `closes owner/repo#1` is REFUSED", "closes skyphusion-labs/vivijure-cf#279", 1)
expect("bare cross-repo `closes vivijure-cf#279` is REFUSED", "closes vivijure-cf#279", 1)
expect("legacy `closes GH-1` is REFUSED", "closes GH-1", 1)
expect(
    "full-URL form is REFUSED",
    "closes https://github.com/skyphusion-labs/vivijure-control-plane/issues/246",
    1,
)
expect("mid-sentence, buried in prose, is REFUSED", "The work here fixes #99 and nothing else.", 1)

# ---- NEAR MISSES that must NOT be refused, or the guard becomes noise nobody can satisfy. --------
expect("a bare issue reference with no keyword is ACCEPTED", "Refs #1 and vivijure-cf#279.", 0)
expect("the word `closed` with no reference is ACCEPTED", "The issue was closed by hand earlier.", 0)
expect(
    "prose ABOUT closing, with the number elsewhere, is ACCEPTED",
    "The lead closes issues by hand. Refs #246.",
    0,
)

# ---- CODE SPANS (cp#387). GitHub does not auto-close from fenced or inline code, so a keyword+
# ---- reference QUOTED in either is describing the string, not asserting a link. -------------------
expect(
    "the exact cp#387 trap -- a keyword+ref inside backticks, describing the fix -- is ACCEPTED",
    "1. `Closes #48` -> `Refs #48`, which is what the shipped commit-message-guard.py requires",
    0,
)
expect(
    "an unquoted keyword+ref inside a FENCED code block is ACCEPTED",
    "Before:\n\n```\nCloses #48\n```\n\nAfter the rename above.",
    0,
)
# ASSUMPTION, stated rather than silently changed: GitHub does not autolink `#N` inside inline code,
# so a keyword left in prose with only the REFERENCE fenced strips to a keyword with no reference
# left adjacent, and is accepted. Not exercised by the trap above (there the whole phrase is quoted);
# recorded here so the behaviour is a decision, not a surprise discovered later.
expect(
    "a keyword in prose with only the `#N` inside backticks is ACCEPTED (reference stripped)",
    "Closes `#48` once the rename lands.",
    0,
)

# ---- THE VACUOUS-PASS GUARD. An absent input must not read as a clean input. ---------------------
expect("an UNSUPPLIED body is rc=2, never a pass", "", 2, supply=False)

print("")
print(f"  {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
