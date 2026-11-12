### ci(drift): the daily drift workflow stops reading a plane nobody operates

`studio-pin-drift.yml` is now `flagship-drift.yml`, and it no longer runs `npm run check:studio-pin:deployed`. That step read `STUDIO_RELEASE` off the deployed `vivijure-control-plane` Worker. Skyphusion does not operate that Worker: this repo is a reference implementation (cp#620), the plane went out of service on 2026-11-01 (cp#574), and the script is no longer on the account. So the step was red every day, first as drift and then as could-not-measure. It also failed before the flagship check, which therefore never ran.

The workflow keeps the flagship check (`npm run check:flagship-version`, cp#564). That check reads the deployed `vivijure-studio` bytes, which are live. `check:studio-pin:deployed` stays in `package.json` for whoever operates this plane. `tests/workflow-guards.test.py` now asserts the scheduled workflow does not read the plane binding, and that the old file is gone.
