#!/usr/bin/env python3
"""
Structural guards on .github/workflows/deploy.yml.

WHY THIS EXISTS: the dry run was originally a STEP that called `exit 0`. That ends the step, not
the job, so a dry_run dispatch ran straight on into migrate + deploy and did the exact thing it was
asked not to do. The guard read as safe and was not, and no test would have noticed, because the
defect lives in the workflow structure rather than in any code a suite executes.

So these assertions are about SHAPE: every operation that writes to the live control plane must sit
inside the one job that carries the dry-run condition. A future contributor adding a deploy step to
the wrong job fails here instead of discovering it against production.
"""
import sys, pathlib, yaml

root = pathlib.Path(__file__).resolve().parent.parent
wf = yaml.safe_load((root / ".github/workflows/deploy.yml").read_text())

failures = []
checks = 0


def check(name, ok, detail=""):
    global checks
    checks += 1
    if ok:
        print("  ok   " + name)
    else:
        print("  FAIL " + name + (" -- " + detail if detail else ""))
        failures.append(name)


jobs = wf.get("jobs", {})
check("deploy.yml defines a guarded `release` job", "release" in jobs)
check("deploy.yml defines a `preflight` job", "preflight" in jobs)

release = jobs.get("release", {})
preflight = jobs.get("preflight", {})

# The condition itself. Written loosely so a reformat does not fail it, strictly enough that
# deleting the dry-run term does.
cond = str(release.get("if", ""))
check("release job carries a dry_run condition", "dry_run" in cond and "workflow_dispatch" in cond,
      "if: " + cond)
check("release condition is a negation (skips ON dry run, not because of it)", "!" in cond,
      "if: " + cond)
check("release runs only after preflight", release.get("needs") == "preflight",
      "needs: " + str(release.get("needs")))


def steps_of(job):
    return job.get("steps", []) or []


def run_text(step):
    return str(step.get("run", "") or "")


# The operations that MUTATE the live plane. Anything matching these outside the guarded job is the
# bug this file exists to prevent.
WRITE_MARKERS = ["wrangler deploy", "migrations apply", "d1 execute", "wrangler secret"]

for job_name, job in jobs.items():
    if job_name == "release":
        continue
    for step in steps_of(job):
        text = run_text(step)
        for marker in WRITE_MARKERS:
            check(
                "job `" + job_name + "` step `" + str(step.get("name", "?")) + "` does not write to the live plane (" + marker + ")",
                marker not in text,
                "a write outside the guarded job runs even on a dry run",
            )

# POSITIVE CONTROL. If the markers stopped matching (a wrangler rename, a refactor to a script),
# every assertion above would pass vacuously while the real protection quietly disappeared. This
# asserts the guarded job genuinely still contains the writes we think it does.
release_text = "\n".join(run_text(s) for s in steps_of(release))
check("release job actually applies migrations", "migrations apply" in release_text)
check("release job actually deploys the worker", "wrangler deploy" in release_text)

# The preflight job must still REPORT, or a dry run proves nothing at all.
preflight_text = "\n".join(run_text(s) for s in steps_of(preflight))
check("preflight reports pending migrations (read-only)", "migrations list" in preflight_text)
check("preflight renders the config, so a dry run validates the secrets",
      "render-wrangler.sh" in preflight_text)


# ------------------------------------------------------------------------------------------------
# cp#246. THE GUARD SUITE HAS TO BE ON THE DEPLOY PATH, AND ONE DEFINITION HAS TO SERVE BOTH CALLERS.
#
# Observed on the v1.19.0 tag: `Deploy control plane` succeeded while `CI` failed on the same tag,
# because `Config render guards` lived only in ci.yml. The deploy could not fail for the class of
# defect those guards catch. On that occasion the red was a control correctly firing on a guard
# weakness and the deploy was genuinely safe. Next time the same silence covers a real one.
#
# These are SHAPE assertions, like everything else in this file. That a red guard actually blocks
# the deploy is proven by dispatching deploy.yml with the suite deliberately broken and watching
# `release` skip; a structural test cannot prove that and does not claim to.
check("preflight runs the config guard suite", "guards:config" in preflight_text,
      "preflight run text: " + preflight_text[:300])

# The same definition, not a copy. A second literal `bash tests/render-wrangler.test.sh` in a
# workflow is how two callers become two guards wearing one name.
ci_wf = yaml.safe_load(open(".github/workflows/ci.yml"))
ci_job = ci_wf.get("jobs", {}).get("ci", {})
ci_text = "\n".join(run_text(s) for s in steps_of(ci_job))
check("ci runs the SAME config guard suite by npm script", "guards:config" in ci_text)
check("no workflow calls the guard script directly, bypassing the one definition",
      "render-wrangler.test.sh" not in ci_text and "render-wrangler.test.sh" not in preflight_text,
      "a direct call re-splits the definition")

# MEASURED 2026-08-01, and this is the assertion that keeps the step honest rather than merely
# present: the guard suite copies .git and resolves released CHANGELOG sections by matching
# `## vX.Y.Z` against git TAGS. On a shallow, tagless checkout it reports 6 failures out of 53.
# A preflight that checked out shallow would fail every deploy for a reason that has nothing to do
# with the config, which is worse than not running the guard at all: a red nobody believes is a red
# nobody reads.
pf_checkouts = [s for s in steps_of(preflight) if str(s.get("uses", "")).startswith("actions/checkout")]
check("preflight checks out full history and tags, which the guard suite needs",
      bool(pf_checkouts) and all(str((s.get("with") or {}).get("fetch-depth")) == "0" for s in pf_checkouts),
      "checkout with: " + str([s.get("with") for s in pf_checkouts]))

# cp#260 bucket 1, second and last member: satellite image pins.
#
# The pins point OUT of this repo, so no unit test can prove the tags exist, and a tag can point at
# any commit. MEASURED, and the obvious negative test is a FALSE LEAD worth recording: a pin at
# "9.9.9-probe" fails vitest, but on a FORMAT assertion rather than on existence, so stopping there
# concludes the suite already covers this. A pin at "1.0.99" -- well-formed, never pushed -- passes
# typecheck, all 1467 tests and the config guards, and is caught ONLY by check:pins.
check("preflight resolves satellite image pins", "check:pins" in preflight_text,
      "preflight run text: " + preflight_text[:300])
check("ci resolves satellite image pins too", "check:pins" in ci_text)

# The REGISTRY mode, not the production one. `check:pins:prod` needs a prod RunPod key that this
# workflow does not hold and should not; wiring it here would fail every deploy on a missing
# credential, and a gate that always refuses is a gate somebody disables.
check("the deploy path uses the credential-free REGISTRY mode, not --prod",
      "check:pins:prod" not in preflight_text and "--prod" not in preflight_text,
      "preflight must not require a production RunPod key")

# ------------------------------------------------------------------------------------------------
# cp#319. PR CI AND THE PROVISIONER MUST AGREE ON WHICH SOURCE THEY GATE.
#
# The provisioner reads R2 (module-bundle-r2.ts has no fallback). check-release-modules.py can
# validate the GitHub release alone, or the release PLUS the R2 mirror via --mirror-bucket.
# Deploy always spans both. Until cp#319, PR CI validated GitHub only: a release that was perfect
# on GitHub but never mirrored passed every PR and failed only at deploy (or at first provision).
#
# SHAPE assertions, not a live R2 read (this suite is credential-free):
#   1. deploy preflight still passes --mirror-bucket (the provisioner path stays gated on tag).
#   2. ci.yml's pin step ALSO carries a --mirror-bucket path (same-repo PRs with the R2 token).
#   3. That ci path is not silent-when-missing: a notice names the residual when the secret is
#      absent (forks), so a green cannot be misread as "mirror verified".
#
# A future editor that drops --mirror-bucket from ci while leaving the GitHub half fails (2).
# One that drops the notice on the no-secret branch fails (3). One that drops deploy's mirror
# fails (1). That is the class: the two sources cannot disagree without a gate naming it.
check("deploy pin check verifies the R2 mirror (--mirror-bucket)",
      "--mirror-bucket" in preflight_text,
      "deploy preflight must span the source the provisioner reads")
check("ci pin check carries a --mirror-bucket path (cp#319)",
      "--mirror-bucket" in ci_text,
      "PR CI must be able to verify the same R2 path as deploy, not only GitHub")
check("ci pin check uses the R2 read token secret (same grant as deploy)",
      "STUDIO_RELEASES_R2_TOKEN" in str(ci_wf),
      "without the token the --mirror-bucket path is dead code")
# ANCHOR ON THE EMITTED STRING, NOT ON ITS VOCABULARY. The first version of this assertion
# asked only that "mirror" and "notice" each appear somewhere in ci_text -- and both are
# supplied by UNRELATED text: "mirror" by the `--mirror-bucket` flag that assertion (2)
# already covers, "notice" by the fork-PR STUDIO_RELEASE notice. Measured: deleting the
# executable R2-mirror notice left the suite fully green, so the one assertion whose job is
# "a green without mirror coverage must say so out loud" could not fail. The exact line is
# emitted once and appears in no comment, so anchoring on it is precise.
MIRROR_ABSENT_NOTICE = "::notice::R2 mirror credentials not available"
check("ci pin check names the residual when mirror credentials are absent",
      MIRROR_ABSENT_NOTICE in ci_text,
      "a green without mirror coverage must say so out loud")

# ------------------------------------------------------------------------------------------------
# cf#372. THE PIN'S FRESHNESS, WHICH EVERY OTHER PIN GATE IS STRUCTURALLY BLIND TO.
#
# check-release-modules.py proves the pinned tag RESOLVES. render-wrangler.sh, the -z refusal in
# preflight, and deps.ts provisionerWiring all refuse an EMPTY pin. Not one of them can fire on a
# STALE pin, because a six-release-old pin is satisfiable and non-empty in exactly the way a current
# one is. That gap recurred three times and twice survived being "fixed" by bumping the value.
#
# These are SHAPE assertions: the freshness check is credential-free, but this suite does not reach
# the network, so what is asserted here is that the wiring exists and cannot quietly disappear.

drift_path = root / ".github/workflows/studio-pin-drift.yml"
check("the scheduled studio-pin drift workflow exists", drift_path.exists(),
      "the deploy gate cannot observe the window between a cf release and the next deploy")

drift_wf = yaml.safe_load(drift_path.read_text()) if drift_path.exists() else {}
drift_text = str(drift_wf)
drift_jobs = drift_wf.get("jobs", {})

check("preflight checks the studio pin is the latest published release",
      "check:studio-pin" in preflight_text,
      "preflight run text: " + preflight_text[:300])

# RELEASE mode on the deploy path, mirroring the check:pins/--prod split directly above. `--deployed`
# reads the LIVE binding, and during a deploy that binding is exactly what is about to change, so it
# would be red by construction on every release carrying a pin bump. A check that fires on normal
# operation is a check somebody mutes.
check("the deploy path uses RELEASE mode, never the deployed-binding read",
      "check:studio-pin:deployed" not in preflight_text and "--deployed" not in preflight_text,
      "preflight must not assert against a binding it is in the middle of replacing")

# The drift workflow's whole reason to exist is the surface deploy CANNOT check. If it dropped to
# release mode it would re-ask the question the deploy gate already answers and the runtime surface
# would go unmeasured again -- silently, and with a green tick.
check("the drift workflow reads the DEPLOYED binding, not just the variable",
      "check:studio-pin:deployed" in drift_text,
      "the repo variable is a proposal; the deployed binding is what a tenant receives")

check("the drift workflow runs on a schedule", bool((drift_wf.get(True) or drift_wf.get("on") or {}).get("schedule")),
      "a deploy-triggered check cannot observe a window in which nothing deploys")

check("the drift workflow runs on ubuntu-latest (public repo; fork-safe lane)",
      all(j.get("runs-on") == "ubuntu-latest" for j in drift_jobs.values()),
      "runs-on: " + str([j.get("runs-on") for j in drift_jobs.values()]))

# THE ONE EDIT THAT WOULD SILENTLY DISARM THE CHECKER. check-studio-pin.mjs lets its endpoint bases
# be redirected so the test suite can drive every refusal path locally. The script prints the
# redirection on every such run, but a workflow setting it would produce a green that measured
# nothing. Asserting its ABSENCE is what protects the deletion; sync-checking what remains does not.
for name, text in (("deploy.yml", str(wf)), ("studio-pin-drift.yml", drift_text)):
    check("no workflow redirects the pin checker's endpoints (" + name + ")",
          "CHECK_STUDIO_PIN_GH_API" not in text and "CHECK_STUDIO_PIN_CF_API" not in text,
          "a redirected run is not a measurement of the live estate")

# Anchored on the EMITTED string, for the reason recorded above the mirror-notice assertion: a
# vocabulary match is supplied by unrelated text. A skip here would be an absence reading as OK,
# and this job never runs from a fork, so an absent credential is a defect and not a fork condition.
DRIFT_CRED_REFUSAL = "::error::CLOUDFLARE_API_TOKEN is unset"
check("the drift workflow REFUSES on an absent credential instead of skipping",
      DRIFT_CRED_REFUSAL in drift_text,
      "an unperformed check must not look like a check that ran and found nothing")

print("")
print("  " + str(checks - len(failures)) + " passed, " + str(len(failures)) + " failed")
sys.exit(1 if failures else 0)
