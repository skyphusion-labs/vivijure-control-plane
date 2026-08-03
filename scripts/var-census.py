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

# ---------------------------------------------------------------------------
# cp#218: the OTHER half of the drift class, and the one that actually shipped.
#
# Everything above anchors on the placeholders in wrangler.toml.example, so it can only compare
# lists that ALREADY mention a var. A field typed in src/env.ts and read in code but named in NO
# list is invisible to it: all four lists agree, by all omitting it. CREDITS_ENFORCING shipped in
# v1.17.0 exactly that way and never reached the Worker.
#
# So census src/env.ts itself. Every field of ControlPlaneEnv must resolve to exactly one of:
# a declared var (a key in the [vars] table), a declared-exempt secret, or a declared-exempt
# binding. The exemptions are DECLARED INTENT (ENV_SECRETS / ENV_BINDINGS in env.ts), never a guess
# from the type: flagging a secret as a missing var would invite someone to "fix" it by putting a
# credential name into a tracked deploy list, and flagging bindings would make this noisy enough to
# be ignored.
#
# A field in none of the three is a FAILURE. Silence is the bug.

env_src = (root / "src" / "env.ts").read_text()


def _fatal(msg):
    print("var-census: " + msg)
    sys.exit(1)


def _strip_comments(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    return re.sub(r"(?m)//.*$", "", s)


env_code = _strip_comments(env_src)


def _interface_fields(name, seen=None):
    """Field names of `name`, following `extends`. Comments are stripped first, so brace balance
    cannot be thrown off by a JSDoc block."""
    seen = set() if seen is None else seen
    if name in seen:
        return set()
    seen.add(name)
    m = re.search(r"export interface\s+%s\b([^{]*)\{" % re.escape(name), env_code)
    if m is None:
        _fatal(
            "src/env.ts declares no interface %s. This script cannot census what it cannot find, "
            "so it refuses rather than reporting a clean run over nothing." % name
        )
    i, depth = m.end(), 1
    while i < len(env_code) and depth:
        depth += 1 if env_code[i] == "{" else -1 if env_code[i] == "}" else 0
        i += 1
    body = env_code[m.end() : i - 1]
    fields = set(re.findall(r"(?m)^\s*([A-Z][A-Z0-9_]*)\??\s*:", body))
    ext = re.search(r"extends\s+([^{]+)", m.group(1))
    if ext:
        for parent in (p.strip() for p in ext.group(1).split(",")):
            if parent:
                fields |= _interface_fields(parent, seen)
    return fields


def _declared_list(name):
    m = re.search(r"export const\s+%s\s*=\s*\[(.*?)\]" % re.escape(name), env_code, re.S)
    if m is None:
        _fatal(
            "src/env.ts no longer exports %s. That list is the declared intent this census reads; "
            "without it every field would look unclassified, so this refuses rather than guessing."
            % name
        )
    return set(re.findall(r"\"([A-Z0-9_]+)\"", m.group(1)))


env_fields = _interface_fields("ControlPlaneEnv")
# A parse that silently found nothing would report a clean census over an empty set, which is the
# same disease this check exists to cure, one layer up. 20 is a floor, not a count.
if len(env_fields) < 20:
    _fatal(
        "parsed only %d fields out of ControlPlaneEnv. The interface has not shrunk that far, so "
        "the parser is broken; refusing to report a pass it did not earn." % len(env_fields)
    )

# These two sets hold FIELD NAMES, never values, and the identifiers say so on purpose. A human
# reading `secrets` here reasonably wonders, and a name-based scanner cannot tell the difference
# at all: CodeQL py/clear-text-logging-sensitive-data flagged the print at the bottom of this
# script as high severity purely because a variable called `secrets` reached it.
out_of_band_fields = _declared_list("ENV_SECRETS")
binding_fields = _declared_list("ENV_BINDINGS")

# The [vars] table is the anchor for env.ts, NOT the placeholder set: a var reaches the Worker as a
# KEY there, and the key and its placeholder deliberately differ in places (CF_ACCOUNT_ID is fed by
# ${CLOUDFLARE_ACCOUNT_ID}). Comparing against placeholders would false-flag exactly those.
_vm = re.search(r"(?m)^\[vars\]\s*$", tpl)
if _vm is None:
    _fatal("wrangler.toml.example has no [vars] table; the env census has no anchor to read.")
_rest = tpl[_vm.end() :]
_end = re.search(r"(?m)^\[", _rest)
vars_block = _rest[: _end.start()] if _end else _rest
declared_vars = dict(re.findall(r"(?m)^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$", vars_block))

both = out_of_band_fields & binding_fields
for v in sorted(both):
    problems.append(
        "%s is declared in BOTH ENV_SECRETS and ENV_BINDINGS in src/env.ts. It is delivered one "
        "way; two claims mean nobody knows which." % v
    )
for v in sorted((out_of_band_fields | binding_fields) - env_fields):
    problems.append(
        "%s is exempted in src/env.ts but is not a field of ControlPlaneEnv. The exemption is dead "
        "and reads as coverage it does not provide." % v
    )

for v in sorted(env_fields - out_of_band_fields - binding_fields):
    if v not in declared_vars:
        problems.append(
            "%s is typed in src/env.ts and declared in NO list -- not [vars], not ENV_SECRETS, not "
            "ENV_BINDINGS. Code can read it, the deploy will never set it, and nothing else here "
            "would say so. Declare it as a var in all four lists, or classify it in env.ts." % v
        )
    # Either quoting style counts as a placeholder. TOML has two string forms and the choice is
    # forced by the VALUE: SHARED_RUNPOD_ENDPOINTS carries JSON, whose own double quotes terminate a
    # basic string, so it must be a LITERAL string (single quotes). Matching only the double-quoted
    # form would flag a correctly-quoted placeholder as frozen config (cp#285). The backreference is
    # deliberate: it accepts \'${X}\' and "${X}" and rejects a mismatched \'${X}" .
    elif not re.fullmatch(r"([\"'])\$\{[A-Z0-9_]+\}\1", declared_vars[v].strip()):
        # The VALUE is deliberately not echoed. It is one line away in a tracked file, so printing
        # it buys nothing, and it is the only path by which this script could ever put a value on
        # stdout at all. Naming the var is the whole message.
        problems.append(
            "[vars] %s is set to a LITERAL rather than a ${PLACEHOLDER}. The rendered config is "
            "built by envsubst, so a literal here is config frozen into a public template and "
            "invisible to the four-list check above." % v
        )

for v in sorted(out_of_band_fields):
    where = []
    if v in declared_vars:
        where.append("the [vars] table")
    if v in placeholders:
        where.append("a wrangler.toml.example placeholder")
    if v in allowed:
        where.append("the render-wrangler.sh allowlist")
    if where:
        problems.append(
            "%s is declared a SECRET in src/env.ts but appears in %s. Worker secrets are installed "
            "out of band with `wrangler secret put`; a credential name in a tracked deploy list is "
            "the wrong direction to fix a census failure." % (v, " and ".join(where))
        )

for v in sorted(binding_fields):
    if v in declared_vars:
        problems.append(
            "%s is declared a BINDING in src/env.ts but is also a [vars] key. A binding is "
            "delivered by its own table ([[d1_databases]] and friends), never as a var." % v
        )

for v in sorted(set(declared_vars) - env_fields):
    problems.append(
        "[vars] declares %s but src/env.ts types no such field. Either the Env lost it, or the "
        "template is shipping a var nothing reads." % v
    )

if problems:
    for p in problems:
        print("var-census: " + p)
    sys.exit(1)
sys.exit(0)
