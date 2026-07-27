#!/usr/bin/env python3
"""
Blast-radius confinement for the cp#209 mirror check.

WHY THIS FILE EXISTS AND WHY IT IS NOT OPTIONAL.

The credential the mirror check runs under is ACCOUNT-WIDE R2 read. It could not be scoped to a
single bucket on the API path used to mint it, so the token can read ANY R2 object in the account,
including TENANT buckets. This project states plainly that it does not monitor tenant content; a CI
job holding that reach must therefore have its blast radius bounded by CODE, not by intent, not by
review, and not by the fact that today the gate happens to only ask for release objects.

scripts/check-release-modules.py routes EVERY object name through mirror_key(), which refuses any
segment that could escape studio-releases/. This drives that refusal directly, in both directions:
the allowed shape is built correctly, and every escape attempt raises rather than returning a key
somebody would then hand to wrangler.

A confinement check that only ever ran the happy path would prove nothing -- it would pass
identically against a mirror_key() that did no validation at all.
"""
import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("gate", ROOT / "scripts" / "check-release-modules.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

passed = 0
failed = []


def ok(msg):
    global passed
    passed += 1
    print("  ok   " + msg)


def bad(msg):
    failed.append(msg)
    print("  FAIL " + msg)


# ------------------------------------------------------------------ the allowed shape
try:
    k = gate.mirror_key("v1.12.0", "modules", "keyframe", "worker.js")
    if k == "studio-releases/v1.12.0/modules/keyframe/worker.js":
        ok("builds the expected key for a normal release object")
    else:
        bad("unexpected key for a normal release object: " + k)
except Exception as e:
    bad("refused a legitimate key: %s" % e)

try:
    k = gate.mirror_key("v1.12.0", "manifest.json")
    ok("builds the top-level manifest key") if k == "studio-releases/v1.12.0/manifest.json" \
        else bad("unexpected top-level key: " + k)
except Exception as e:
    bad("refused the top-level manifest key: %s" % e)

# ------------------------------------------------------------------ escapes MUST raise
# Each of these, if it returned a string, would be handed to wrangler and could name an object
# outside studio-releases/ -- including a tenant bucket path.
ESCAPES = [
    ("parent traversal", ("..",)),
    ("traversal inside a segment", ("v1.12.0", "..", "secrets")),
    ("embedded traversal", ("v1.12.0/../..",)),
    ("slash in a segment", ("v1.12.0", "modules/keyframe")),
    ("absolute-looking segment", ("/etc",)),
    ("leading slash", ("/v1.12.0",)),
    ("backslash", ("v1.12.0", "modules\\keyframe")),
    ("empty segment", ("",)),
    ("none segment", (None,)),
    ("bucket-hop attempt", ("..", "..", "tenant-bucket")),
    ("leading dot", (".hidden",)),
    ("space injection", ("v1 .12",)),
]
for label, segs in ESCAPES:
    try:
        k = gate.mirror_key(*segs)
        bad("ACCEPTED an escape (%s) and produced %r -- the credential is not confined" % (label, k))
    except gate.UnsafeKey:
        ok("refuses %s" % label)
    except Exception as e:  # a TypeError is still a refusal, but say so plainly
        ok("refuses %s (via %s)" % (label, type(e).__name__))

# ------------------------------------------------------------------ structural invariant
# Whatever it accepts, it must be under the one prefix. This is the property that actually bounds
# the blast radius; the individual cases above are how it is reached.
SAFE_INPUTS = [
    ("v1.12.0", "manifest.json"),
    ("v0.0.1-rc.1", "modules", "plan-enhance", "worker.js"),
    ("v9.9.9", "modules", "own-gpu", "manifest.json"),
]
bad_prefix = []
for segs in SAFE_INPUTS:
    try:
        k = gate.mirror_key(*segs)
        if not k.startswith("studio-releases/"):
            bad_prefix.append(k)
    except Exception:
        pass
if bad_prefix:
    bad("accepted keys outside studio-releases/: %r" % bad_prefix)
else:
    ok("every accepted key is under studio-releases/")

print()
if failed:
    print("mirror-key confinement: %d FAILURE(S)" % len(failed))
    sys.exit(1)
print("mirror-key confinement: %d checks passed" % passed)
