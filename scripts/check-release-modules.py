#!/usr/bin/env python3
"""
Release-module gate (cp#187): every TENANT_MODULE_CATALOG entry must have a real bundle in the
pinned STUDIO_RELEASE, or the deploy is refused.

WHY THIS EXISTS. cp#184 added plan-enhance to TENANT_MODULE_CATALOG while the repo variable
STUDIO_RELEASE was still pinned at v1.9.0, whose release carries no plan-enhance bundle. Deploying
that pair would have failed EVERY provision at modules_upload: loud, but every one, and only after
a tenant hit it. It was caught by a human reading the diff before tagging.

Nothing in the deploy checked it. deploy.yml even ASSERTS the property in prose -- "the
studio-releases R2 bucket must exist AND hold the artifact for the pinned STUDIO_RELEASE tag" -- in
a step comment, while nothing verifies it. A comment is not a gate.

scripts/var-census.py closes the adjacent class (config lists agreeing with each other) but by
construction cannot look inside an artifact. This looks inside the artifact.

WHAT IT CHECKS, and the order matters:

  1. The catalog parses to a NON-EMPTY module list. A parser that silently matches nothing would
     make every check below pass vacuously, which is the exact failure shape this gate exists to
     prevent. An empty parse is an error, never a pass.
  2. CONTROL: the release top-level manifest reads, and its `tag` equals the pin. This separates
     "the modules are missing" from "credentials, bucket, or release are wrong". Without it, a bad
     token reports every module as missing and sends someone hunting a release problem that does
     not exist. If the control fails we say CANNOT VERIFY and refuse, rather than guessing.
  3. Each catalog module has a readable bundle manifest at
     studio-releases/<tag>/modules/<module>/manifest.json whose `module` field matches the module
     asked for, AND the worker bytes it promises are present and hash to the pinned sha256.

     The field is `module`, not `name`, and the integrity check mirrors src/module-bundle-r2.ts
     exactly. Both facts were read off the LIVE v1.12.0 artifact rather than assumed: an earlier
     draft of this gate checked a `name` field that does not exist, and it failed every real
     release while passing a hand-written fixture. A gate written against an invented shape is
     worse than no gate.

     Checking the bytes and not only the manifest matters because studio-release.yml can publish a
     manifest promising a worker that never uploaded; the provisioner fetches those bytes and
     verifies that hash, so the gate asserts what provisioning actually needs.

Note the top-level manifest does NOT enumerate modules (verified against the live v1.12.0
artifact: its keys are assets, assets_config, compatibility_date, compatibility_flags, main_module,
migrations, required_vars, tag, worker). So the module list cannot be read from it; each module is
probed at its own key, exactly as src/module-bundle-r2.ts does at provision time.

Fails closed and names every problem at once. Exit 0 and print a one-line summary when clean.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys

PREFIX = "studio-releases"


def parse_catalog(root):
    """The module names in TENANT_MODULE_CATALOG, read from the source of truth.

    Parsed rather than imported because the catalog is TypeScript and this repo carries no TS
    runner. Same tradeoff var-census.py makes. The non-empty assertion in main() is what keeps a
    parser miss from degrading into a silent pass.
    """
    src = (root / "src" / "tenant-modules.ts").read_text()
    m = re.search(
        r"TENANT_MODULE_CATALOG:\s*readonly\s+TenantModuleSpec\[\]\s*=\s*\[(.*?)\n\];",
        src,
        re.S,
    )
    if not m:
        return None
    return re.findall(r"\{\s*module:\s*\"([^\"]+)\"", m.group(1))


def wrangler_fetcher(bucket):
    """Read an object out of R2 via wrangler. Returns bytes, or None when the object is absent."""

    def fetch(key):
        out = pathlib.Path(
            subprocess.run(["mktemp"], capture_output=True, text=True, check=True).stdout.strip()
        )
        try:
            r = subprocess.run(
                ["npx", "wrangler", "r2", "object", "get", bucket + "/" + key,
                 "--file", str(out), "--remote"],
                capture_output=True, text=True,
            )
            if r.returncode != 0 or not out.exists() or out.stat().st_size == 0:
                return None
            return out.read_bytes()
        finally:
            out.unlink(missing_ok=True)

    return fetch


def dir_fetcher(base):
    """Read from a local directory laid out like the bucket. Used by the gate self-test."""

    def fetch(key):
        p = base / key
        return p.read_bytes() if p.is_file() else None

    return fetch


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--release", required=True, help="the pinned STUDIO_RELEASE tag")
    ap.add_argument("--bucket", help="the studio-releases R2 bucket (wrangler mode)")
    ap.add_argument("--from-dir", help="read from a local dir instead of R2 (self-test only)")
    a = ap.parse_args()

    root = pathlib.Path(a.root)
    release = a.release.strip()
    if not release:
        print("check-release-modules: STUDIO_RELEASE is empty; refusing to verify nothing.")
        return 1

    modules = parse_catalog(root)
    if modules is None:
        print("check-release-modules: could not locate TENANT_MODULE_CATALOG in src/tenant-modules.ts. "
              "The gate cannot verify what it cannot read; refusing rather than passing.")
        return 1
    if not modules:
        print("check-release-modules: TENANT_MODULE_CATALOG parsed to ZERO modules. That is either a "
              "parser regression or an empty catalog; either way every check below would pass "
              "vacuously, so this is a failure, not a pass.")
        return 1

    if a.from_dir:
        fetch = dir_fetcher(pathlib.Path(a.from_dir))
    else:
        if not a.bucket:
            print("check-release-modules: --bucket is required unless --from-dir is given.")
            return 1
        fetch = wrangler_fetcher(a.bucket)

    # CONTROL, before any per-module conclusion is drawn.
    base = PREFIX + "/" + release
    raw = fetch(base + "/manifest.json")
    if raw is None:
        print("check-release-modules: CANNOT VERIFY -- the release manifest at %s/manifest.json did not "
              "read at all. That is a credentials, bucket, or missing-release problem, NOT evidence "
              "about the modules. Refusing to deploy on an unverifiable pin." % base)
        return 1
    try:
        top = json.loads(raw.decode("utf-8"))
    except Exception as e:
        print("check-release-modules: CANNOT VERIFY -- release manifest at %s/manifest.json is not "
              "valid JSON (%s)." % (base, e))
        return 1
    if top.get("tag") != release:
        print("check-release-modules: release pin mismatch -- STUDIO_RELEASE is %s but the artifact at "
              "that key declares tag %r. The pin points at the wrong bytes." % (release, top.get("tag")))
        return 1

    problems = []
    for name in modules:
        key = base + "/modules/" + name + "/manifest.json"
        rawm = fetch(key)
        if rawm is None:
            problems.append(
                "%s is in TENANT_MODULE_CATALOG but the release %s publishes NO bundle for it (%s is "
                "absent). Every provision would fail at modules_upload." % (name, release, key)
            )
            continue
        try:
            mm = json.loads(rawm.decode("utf-8"))
        except Exception as e:
            problems.append("%s bundle manifest at %s is not valid JSON (%s)." % (name, key, e))
            continue
        if mm.get("module") != name:
            problems.append(
                "%s bundle manifest at %s declares module %r; the artifact under this key is a "
                "different module." % (name, key, mm.get("module"))
            )
            continue
        # The manifest can promise bytes that never uploaded. The provisioner fetches and hashes
        # them, so the gate does too, or it green-lights a release that dies at modules_upload.
        worker = mm.get("worker") or {}
        wpath = worker.get("path")
        if not wpath:
            problems.append("%s bundle manifest at %s names no worker path." % (name, key))
            continue
        wkey = base + "/modules/" + name + "/" + wpath
        wbytes = fetch(wkey)
        if wbytes is None:
            problems.append(
                "%s bundle manifest promises worker bytes at %s but that object is ABSENT. The "
                "manifest is a promise the release does not keep." % (name, wkey)
            )
            continue
        want = worker.get("sha256")
        got = hashlib.sha256(wbytes).hexdigest()
        if want and got != want:
            problems.append(
                "%s worker bytes at %s hash to %s but the manifest pins %s; the artifact is not "
                "what the release claims." % (name, wkey, got, want)
            )

    if problems:
        for p in problems:
            print("check-release-modules: " + p)
        return 1

    print("check-release-modules: OK -- release %s carries a bundle for all %d catalog modules (%s)."
          % (release, len(modules), ", ".join(modules)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
