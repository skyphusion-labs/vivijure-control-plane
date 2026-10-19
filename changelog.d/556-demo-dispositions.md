### fix(tenant-env): remove the eight DEMO_* dispositions, now that the pinned release no longer declares them

The public demo was removed entirely and its Cloudflare resources deleted, but the eight `DEMO_*` entries in `TENANT_STUDIO_VAR_DISPOSITION` had to stay: `assertDispositionCoversContract` runs on every provision and every upgrade against the vars the PINNED studio release declares, and deleting a disposition while the pin still declares its var throws on both paths. That ordering constraint is now satisfied.

The deployed plane carries `STUDIO_RELEASE=v1.37.1` as a binding, verified by reading the live Worker's bindings rather than the Actions variable. Those are different surfaces: `scripts/render-wrangler.sh` interpolates the variable into `[vars]` at deploy time and `deploy.yml` fires on a `v*` tag only, so the variable is a proposal about a future deploy and the binding is what the running plane consumes. The binding read `v1.35.0` for three weeks while the variable read `v1.37.1`.

`v1.37.1`'s built `manifest.json` declares 19 `required_vars` and zero `DEMO_*`, so the guard can no longer be handed one.

The pinned-release snapshot in `tests/tenant-studio-env-contract.test.ts` is re-sampled from `v1.12.0` (taken 2026-07-27) to `v1.37.1`, derived from the published manifest rather than retyped. That is a WIDER assertion than the one it replaces, not merely a newer one: it drops the eight `DEMO_*` names and adds seven vars the old sample never checked (`AUDIO_BEAT_SYNC_URL`, `AUDIO_MASTER_URL`, `AUDIO_MIX_URL`, `FINISH_BLENDER_DOORS`, `FINISH_UPSCALE_DOORS`, `IMAGE_PREP_URL`, `VIDEO_FINISH_URL`). A snapshot that only ever shrinks is a gate quietly relaxing, so the direction is recorded in the file.

The guard was watched failing before it was satisfied: with the dispositions deleted and the old `v1.12.0` snapshot still in place, the contract test went red with `the pinned studio release declares 8 var(s) with no disposition`, which is the regression this snapshot exists to catch. It passes on the re-sampled list, and the `SOME_FUTURE_VAR` negative case still throws, so the other half of the assertion is intact rather than disarmed.
