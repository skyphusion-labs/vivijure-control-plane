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

print("")
print("  " + str(checks - len(failures)) + " passed, " + str(len(failures)) + " failed")
sys.exit(1 if failures else 0)
