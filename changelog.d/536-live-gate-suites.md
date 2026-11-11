### ci(live-gate): run the rest of the live suites, and refuse a skip as a pass (#536)

`live-release-gate.yml` now also runs `ai-gateway-logs` and `reconcile-runpod` (read-only), and `r2-credential`, `r2-empty`, `reclaim-teardown` and `wfp-upload` (scratch, self-cleaning). `wfp-upload` uses the newest published vivijure-cf studio release, checked against its separately published `manifest.json`. `provision-e2e` and `pre-deploy-smoke` stay off while the plane is out of service (#574); `shared-pool-key-scope` already runs on the deploy path.

Every live suite skips itself when its env is missing, and vitest then exits 0. Each gate step now runs through `scripts/run-live-suite.sh`, which exits 1 unless the suite ran, skipped nothing and failed nothing. `tests/workflow-guards.test.py` fails on a bare vitest step in the gate, and on a live suite that the gate neither runs nor names as left off.

`reconcile-runpod.live.test.ts` prints counts only by default, because this repo's Actions logs are public. Set `RECONCILE_PRINT_FULL=1` on an operator terminal for the full report.
