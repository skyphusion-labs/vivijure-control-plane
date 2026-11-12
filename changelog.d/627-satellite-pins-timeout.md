### fix(ci): a GHCR timeout in the satellite-pin check is could-not-perform, not drift

`scripts/check-satellite-pins.mjs` let a timed-out or failed request escape as an unhandled rejection. Node then exited 1, the drift band, and printed a raw stack, so a GHCR stall read as "a pin does not resolve" (seen on PR #626, 2026-11-12). A transport failure now exits 2 and names only the origin. This is the same handling cp#393 gave `check-studio-pin.mjs`.

Two test-only overrides, `CHECK_SATELLITE_PINS_GHCR` and `CHECK_SATELLITE_PINS_TIMEOUT_MS`, let `tests/check-satellite-pins.test.ts` drive the timeout and connection-refused arms against a local server. Any run that sets one prints that it is redirected, and `tests/workflow-guards.test.py` asserts that no workflow sets either.
