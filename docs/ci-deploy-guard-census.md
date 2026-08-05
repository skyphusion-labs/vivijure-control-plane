# CI vs deploy guard census (cp#260)

Standing structural fact: which executable guard assets exist in this tree, where each one
runs, and what the CI/deploy divergence actually is. Filed so the measurement does not live only
in an issue body.

**Measured 2026-08-05** (re-check of the #260 filing after pins and PR-body guard landed). Re-measure
when workflows change; do not treat this table as eternally true.

## The question this asks (and does not)

Not "what does `ci.yml` do that `deploy.yml` does not". That framing is blind by construction: it
cannot see anything **neither** workflow does. Enumerate every executable guard asset in the tree,
attribute where each runs, then read the gap.

## Method

Attribution is built on the **parsed `run:` text of each step**, with `npm run X` resolved to its
`package.json` script. A raw grep of the workflow files gets this wrong both ways:

- **It counts COMMENTS as calls.** `ci.yml` may name a script in a comment explaining that it no
  longer calls it directly.
- **It misses indirection.** `npm run check:pins` is `node scripts/check-satellite-pins.mjs`.

Shell-script-calls-script indirection is corrected by hand: `scripts/var-census.py` and
`scripts/changelog-released-immutable.py` run from `tests/render-wrangler.test.sh` (`npm run
guards:config`), not as top-level workflow steps.

## The census

| asset | executed by |
| --- | --- |
| `scripts/check-release-modules.py` | ci, deploy:preflight |
| `tests/render-wrangler.test.sh` (`npm run guards:config`) | ci, deploy:preflight |
| `scripts/var-census.py` | transitive via `guards:config` |
| `scripts/changelog-released-immutable.py` | transitive via `guards:config` (when invoked from that shell) |
| `scripts/render-wrangler.sh` | deploy:preflight, deploy:release |
| `scripts/smoke-human-surface.sh` | deploy:release |
| `scripts/changelog-entry-required.py` | changelog.yml (PR-scoped) |
| `scripts/check-satellite-pins.mjs` (`npm run check:pins`) | **ci and deploy** (pins moved onto deploy after the original filing) |
| `scripts/resolve-guard.mjs` (`npm run guard:resolve`) | **ci only** |
| `scripts/pr-body-guard.py` | **ci only** (added after original filing; self-test of PR body rules) |
| `tests/changelog-entry-required.test.py` | **ci only** |
| `tests/check-release-modules.test.sh` | **ci only** |
| `tests/mirror-key-confinement.test.py` | **ci only** |
| `tests/workflow-guards.test.py` | **ci only** |
| `tests/pr-body-guard.test.py` | **ci only** |
| `scripts/reconcile-runpod.mjs` | nothing (operator tool, not a guard) |

**CI-only residual (not on deploy):** resolve-guard, pr-body-guard (+ its test), and the four
guard self-tests (`changelog-entry-required.test`, `check-release-modules.test`,
`mirror-key-confinement`, `workflow-guards`). That is the deliberate PR-scoped set plus one
unclassified heuristic (`resolve-guard`).

## Classification

### Bucket 1 -- gates deployed config (belongs on the deploy path)

- **`tests/render-wrangler.test.sh` / `guards:config`.** On both paths (cp#246 / #257).
- **`scripts/check-satellite-pins.mjs`.** Pins point out of this repo (GHCR); a tag can land without a
  PR. Now on **both** ci and deploy. Original filing left this as "needs a decision"; the decision
  was to run it at deploy too.

### Bucket 2 -- legitimately PR-scoped

Self-tests of a guard, not gates on what ships: "does our guard still work" when the guard code
changes.

- `tests/check-release-modules.test.sh` -- logic of the cp#187 gate; the real gate already runs at
  deploy.
- `tests/mirror-key-confinement.test.py` -- mirror path confinement; property of the code.
- `tests/changelog-entry-required.test.py` -- guards `changelog.yml`; deploy has no PR entry.
- `tests/workflow-guards.test.py` -- asserts the shape of `deploy.yml`; runs where that shape changes.
- `scripts/pr-body-guard.py` + test -- PR body rules (Refs vs Closes, etc.); no deploy surface.

### Bucket 3 -- unclassified (needs a call)

- **`scripts/resolve-guard.mjs`.** Heuristic over front-door pages (call to a function nobody
  defines). Neither pure self-test nor config gate. Left on ci only pending a call on whether deploy
  should fail on a heuristic.

## Guards that ought to exist and do not (INFERENCE, not measurement)

None of these is a finding; each is a question with no current owner.

1. **Nothing asks whether the pinned `STUDIO_RELEASE` can USE the bindings the plane attaches.**
   `check-release-modules.py` asks whether every catalog module has a bundle that HASHES -- a
   different question. Highest-value gap when a pin predates a binding the plane already injects.
2. **Nothing detects a live suite silently skipping in a release context.** `SMOKE_REQUIRED` fails
   one suite when credentials are absent; other live suites can still skip silently.
3. **Nothing stops a public file naming a credential FILE PATH.** Secret *names* are deliberately
   public; operator *paths* in live-test comments are not. A grep guard is cheap.

## Related

- Issue cp#260 (this census)
- cp#246 / #257 (config render guards on deploy)
- cp#255 (`SMOKE_REQUIRED`)
- `docs/deploy.md`, `docs/control-plane.md`
