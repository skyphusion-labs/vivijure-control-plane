#!/usr/bin/env python3
"""
Var census (cf#56): the four lists that must agree, or a var ships INERT.

WHY THIS EXISTS. A [vars] entry only reaches the Worker if it appears in ALL of:
  1. wrangler.toml.example            -- as a ${PLACEHOLDER}
  2. scripts/render-wrangler.sh       -- in REQUIRED_VARS or ALLOW_EMPTY
  3. .github/workflows/deploy.yml     -- in BOTH render env blocks (dry-run AND release)

Nothing connected those lists. So a var could be typed in env.ts, read in deps.ts, and simply never
be passed: envsubst renders it EMPTY, the deploy goes green, every test passes, and the feature is
silently inert. That is precisely what happened to TENANT_AI_GATEWAY_ID and R2_USAGE_ALERT_BYTES,
and it was caught by a human reading the diff rather than by the pipeline.

The failure mode is the dangerous kind: it looks exactly like success. Hence a census rather than a
convention. Same discipline as the tenant-module list in the vivijure-cf release workflow, where the
same drift class was closed by resolving one list instead of recomputing three.

Exit 0 and print nothing when the lists agree; exit 1 and name every disagreement otherwise.
"""
import re
import sys
import pathlib

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
tpl = (root / "wrangler.toml.example").read_text()
sh = (root / "scripts" / "render-wrangler.sh").read_text()
wf = (root / ".github" / "workflows" / "deploy.yml").read_text()

placeholders = set(re.findall(r"\$\{([A-Z0-9_]+)\}", tpl))


def listed(name):
    m = re.search(name + r"=\"([^\"]*)\"", sh)
    return set(m.group(1).split()) if m else set()


allowed = listed("REQUIRED_VARS") | listed("ALLOW_EMPTY")

problems = []
for v in sorted(placeholders - allowed):
    problems.append(
        "${%s} is used in wrangler.toml.example but is in NEITHER REQUIRED_VARS nor ALLOW_EMPTY. "
        "It would render empty with no guard saying so." % v
    )
for v in sorted(allowed - placeholders):
    problems.append(
        "%s is allowlisted in render-wrangler.sh but no ${%s} placeholder uses it. "
        "Either the template lost it, or the allowlist is carrying a dead name." % (v, v)
    )
# BOTH blocks, not one: the dry-run render proves the Actions config, the release render is what
# actually deploys. A var supplied to only one of them passes the dry run and ships empty.
for v in sorted(placeholders):
    n = len(re.findall(r"^\s+%s:\s" % re.escape(v), wf, re.M))
    if n < 2:
        problems.append(
            "%s is supplied in %d of the 2 deploy.yml render env blocks; it must be in both, "
            "or it renders empty on the path that actually deploys." % (v, n)
        )

if problems:
    for p in problems:
        print("var-census: " + p)
    sys.exit(1)
sys.exit(0)
