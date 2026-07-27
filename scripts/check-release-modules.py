#!/usr/bin/env python3
"""
Release compatibility gate (cp#187): does the pinned STUDIO_RELEASE demand anything -- a module
bundle OR a studio var -- that this plane cannot satisfy? Answered before deploy AND on every PR,
rather than at the first provision.

TWO assertion families over ONE downloaded artifact, in one gate rather than two. They share the
input, and an operator reading two separate gates would reasonably assume one implies the other.
Both failures have the same shape -- the pinned release makes a demand the plane cannot answer --
and both otherwise surface at PROVISION time, which is the worst place to find out.

WHY THIS EXISTS -- one near-miss and one LIVE outage, the same shape one assertion apart.

ASSERTION A (modules). cp#184 added plan-enhance to TENANT_MODULE_CATALOG while STUDIO_RELEASE was
still pinned at v1.9.0, whose release carries no plan-enhance bundle. Deploying that pair fails
EVERY provision at modules_upload: loud, but every one, and only after a tenant hits it. Caught by
a human reading a diff before tagging.

ASSERTION B (vars). The STUDIO_RELEASE flip to v1.12.0 shipped a manifest whose required_vars
include R2_STORAGE_QUOTA_BYTES, for which TENANT_STUDIO_VAR_DISPOSITION had no entry.
assertDispositionCoversContract threw in provisioner.ts and tenant-studio-upgrade.ts, and the plane
could provision and upgrade NOTHING while the deploy sat green.

WHICH COPY THIS READS, and why it is not a proxy.

The GITHUB RELEASE, not R2. studio-release.yml is explicit: the GitHub release is the "PUBLIC
source of truth" and R2 is a "CACHE/MIRROR only, never the source of truth". So gating on the
release is gating on the canonical artifact; gating on R2 would be gating on the copy.

An earlier version of this gate read R2 and could not run at all: the control-plane deploy token
has no R2 API read and never needed any, because the plane reaches releases through the
STUDIO_RELEASES *binding*. That gate refused every deploy while being unable to say why, and a gate
that always refuses is a gate somebody disables.

Reading the release instead is credential-free, which buys the property that matters most: this can
run on EVERY PULL REQUEST, including from forks. The var gap above would have been caught at PR
time instead of taking the plane down. One download covers every module, every byte and every hash.

WHAT THIS DOES NOT COVER, stated because it is a real gap and not a rounding error: the provisioner
reads R2, and src/module-bundle-r2.ts has no fallback, so a release that is internally perfect but
never mirrored still fails at provision. That check needs an R2 read grant and is tracked
separately. The v1.12.0 mirror was verified complete and hash-matching by hand on 2026-07-27; that
is a dated point-in-time check, NOT a control.

ORDER OF OPERATIONS, and it matters:

  1. The catalog and disposition parse to NON-EMPTY lists. A parser that silently matches nothing
     would make every check below pass vacuously, which is the exact failure shape this gate exists
     to prevent. An empty parse is a failure, never a pass.
  2. CONTROL: the release artifact downloads and its manifest tag equals the pin. This separates
     "the release is wrong" from "we could not fetch anything". If the fetch itself fails we say
     CANNOT VERIFY and name the underlying error, rather than reporting every module as missing and
     sending someone hunting a problem that does not exist.
  3. ASSERTION B: every required_var has a disposition. Runs BEFORE the per-module work, because an
     undecided var kills every provision AND every upgrade -- strictly wider blast radius than one
     missing bundle. If both are broken, the var is what an operator should read first.
  4. ASSERTION A: every catalog module has a bundle manifest declaring that module, whose promised
     worker bytes are present and hash to the pinned sha256. Mirrors src/module-bundle-r2.ts.

The module manifest field is `module`, not `name`, and `worker` carries {path, sha256, size}. Both
were read off the LIVE artifact rather than assumed: an earlier draft asserted a `name` field that
exists in no real release, and it passed a hand-written fixture while failing every genuine one.
A gate written against an invented shape is worse than no gate.
"""
import argparse
import hashlib
import io
import json
import os
import pathlib
import re
import sys
import tarfile
import urllib.error
import urllib.request

DEFAULT_RELEASE_REPO = "skyphusion-labs/vivijure-cf"
PREFIX = "studio-releases"


def parse_catalog(root):
    # The module names in TENANT_MODULE_CATALOG, read from the source of truth. Parsed rather than
    # imported because the catalog is TypeScript and this repo carries no TS runner; same tradeoff
    # scripts/var-census.py makes. The non-empty assertion in main() keeps a parser miss from
    # degrading into a silent pass.
    src = (root / "src" / "tenant-modules.ts").read_text()
    m = re.search(r"TENANT_MODULE_CATALOG:\s*readonly\s+TenantModuleSpec\[\]\s*=\s*\[(.*?)\n\];", src, re.S)
    if not m:
        return None
    return re.findall(r"\{\s*module:\s*\"([^\"]+)\"", m.group(1))


def parse_disposition(root):
    # The var names in TENANT_STUDIO_VAR_DISPOSITION. Same parse-not-import tradeoff, same guard.
    src = (root / "src" / "tenant-studio-env.ts").read_text()
    m = re.search(r"TENANT_STUDIO_VAR_DISPOSITION[^=]*=\s*\{(.*?)\n\};", src, re.S)
    if not m:
        return None
    return re.findall(r"^\s{2}([A-Z0-9_]+):\s*\{", m.group(1), re.M)


def github_release_source(repo, tag):
    # Download the release tarball ONCE and serve every lookup from it.
    #
    # The tarball is the whole artifact, so reading the manifest from inside it rather than from the
    # separately-published manifest.json asset guarantees the manifest and the bundles we check are
    # the same bytes. One request, internally consistent by construction.
    #
    # Anonymous HTTPS: vivijure-cf is public, so no token is required and this works on fork PRs.
    # An Authorization header is added only when a token happens to be in the environment, which
    # keeps it working if the repo is ever made private without becoming dependent on that.
    state = {}

    def _load():
        if state:
            return
        url = "https://github.com/%s/releases/download/%s/studio-release-%s.tar.gz" % (repo, tag, tag)
        req = urllib.request.Request(url, headers={"User-Agent": "vivijure-release-gate"})
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        if token:
            req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            state["err"] = ("download of %s returned HTTP %s %s. If this is 404 the release or its "
                            "artifact does not exist for that tag." % (url, e.code, e.reason))
            return
        except Exception as e:
            state["err"] = "download of %s failed: %s" % (url, e)
            return
        files = {}
        try:
            with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tf:
                for mem in tf.getmembers():
                    if not mem.isfile():
                        continue
                    name = mem.name[2:] if mem.name.startswith("./") else mem.name
                    f = tf.extractfile(mem)
                    if f is not None:
                        files[name] = f.read()
        except Exception as e:
            state["err"] = "reading the release tarball for %s failed: %s" % (tag, e)
            return
        state["files"] = files

    def get(path):
        _load()
        if "err" in state:
            return None, state["err"]
        return state["files"].get(path), None

    return get


def dir_source(base, tag):
    # Read from a local directory laid out like the release tree. Used by the gate self-test.
    # Same (data, error) contract; a local read has no third outcome.
    root = base / PREFIX / tag

    def get(path):
        p = root / path
        return (p.read_bytes(), None) if p.is_file() else (None, None)

    return get


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--release", required=True, help="the pinned STUDIO_RELEASE tag")
    ap.add_argument("--release-repo", default=DEFAULT_RELEASE_REPO)
    ap.add_argument("--from-dir", help="read from a local release tree instead (self-test only)")
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

    get = dir_source(pathlib.Path(a.from_dir), release) if a.from_dir \
        else github_release_source(a.release_repo, release)

    # CONTROL, before any per-module or per-var conclusion is drawn.
    raw, err = get("manifest.json")
    if err is not None:
        print("check-release-modules: CANNOT VERIFY -- the release artifact for %s could not be read, "
              "so nothing below is evidence about it. Underlying error: %s" % (release, err))
        print("check-release-modules: refusing to deploy on a pin we could not verify.")
        return 1
    if raw is None:
        print("check-release-modules: the release artifact for %s carries no manifest.json. "
              "STUDIO_RELEASE points at something that is not a studio release." % release)
        return 1
    try:
        top = json.loads(raw.decode("utf-8"))
    except Exception as e:
        print("check-release-modules: CANNOT VERIFY -- manifest.json in the %s artifact is not valid "
              "JSON (%s)." % (release, e))
        return 1
    if top.get("tag") != release:
        print("check-release-modules: release pin mismatch -- STUDIO_RELEASE is %s but the artifact "
              "declares tag %r. The pin points at the wrong bytes." % (release, top.get("tag")))
        return 1

    problems = []

    # ASSERTION B first: an undecided var kills every provision AND every upgrade.
    required = top.get("required_vars")
    if not isinstance(required, list) or not required:
        problems.append(
            "the release manifest carries no required_vars. src/bundle-r2.ts REFUSES such a manifest "
            "at provision time, so this release cannot be provisioned at all."
        )
    else:
        disposition = parse_disposition(root)
        if disposition is None:
            print("check-release-modules: could not locate TENANT_STUDIO_VAR_DISPOSITION in "
                  "src/tenant-studio-env.ts. The gate cannot verify what it cannot read; refusing.")
            return 1
        if not disposition:
            print("check-release-modules: TENANT_STUDIO_VAR_DISPOSITION parsed to ZERO entries. "
                  "Either every var would read as undecided or the check would pass vacuously; "
                  "either way that is a failure, not a pass.")
            return 1
        undecided = [v for v in required if v not in disposition]
        if undecided:
            problems.append(
                "the pinned release %s declares %d var(s) with NO disposition in "
                "src/tenant-studio-env.ts: %s. assertDispositionCoversContract throws on these at "
                "provision AND upgrade, so the plane deploys green and can then provision or upgrade "
                "NO tenant." % (release, len(undecided), ", ".join(undecided))
            )

    # ASSERTION A.
    for name in modules:
        key = "modules/%s/manifest.json" % name
        rawm, merr = get(key)
        if merr is not None:
            problems.append("%s could not be verified: %s" % (name, merr))
            continue
        if rawm is None:
            problems.append(
                "%s is in TENANT_MODULE_CATALOG but the release %s publishes NO bundle for it (%s is "
                "absent from the artifact). Every provision would fail at modules_upload."
                % (name, release, key)
            )
            continue
        try:
            mm = json.loads(rawm.decode("utf-8"))
        except Exception as e:
            problems.append("%s bundle manifest at %s is not valid JSON (%s)." % (name, key, e))
            continue
        if mm.get("module") != name:
            problems.append(
                "%s bundle manifest at %s declares module %r; the artifact under this path is a "
                "different module." % (name, key, mm.get("module"))
            )
            continue
        worker = mm.get("worker") or {}
        wpath = worker.get("path")
        if not wpath:
            problems.append("%s bundle manifest at %s names no worker path." % (name, key))
            continue
        wkey = "modules/%s/%s" % (name, wpath)
        wbytes, werr = get(wkey)
        if werr is not None:
            problems.append("%s worker bytes could not be verified: %s" % (name, werr))
            continue
        if wbytes is None:
            problems.append(
                "%s bundle manifest promises worker bytes at %s but that file is ABSENT from the "
                "artifact. The manifest is a promise the release does not keep." % (name, wkey)
            )
            continue
        want = worker.get("sha256")
        got = hashlib.sha256(wbytes).hexdigest()
        if want and got != want:
            problems.append(
                "%s worker bytes at %s hash to %s but the manifest pins %s; the artifact is not what "
                "the release claims." % (name, wkey, got, want)
            )

    if problems:
        for p in problems:
            print("check-release-modules: " + p)
        return 1

    print("check-release-modules: OK -- release %s carries a bundle for all %d catalog modules (%s), "
          "and all %d required_vars have a disposition."
          % (release, len(modules), ", ".join(modules), len(top.get("required_vars") or [])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
