### test(runpod): guard the downstream backend-label copies against a training clause (cp#367)

The backend endpoint purpose/label was hand-copied in three downstream places besides its source
in `PROVISION_PLAN` (`src/runpod.ts`): `public/onboarding-checks.js`, `public/onboarding-api.js`,
and `docs/hosted-tier.md`. Only the source was guarded (`tests/runpod.test.ts`), so a re-added
training clause in any downstream copy stayed green.

`src/runpod.ts` now exports `NO_TRAINING_CLAUSE = /lora|train/i`, single-sourcing what was an
inline literal in that test file. A new `tests/backend-label-copies-no-training-367.test.ts`
asserts each downstream copy against the same pattern, reading each purpose/label field through
the module data itself (never a whole-file text scan, which would wrongly flag the `cp#303`
comments that document the invariant and contain the word training), plus a test pinning the
count of downstream copies found.
