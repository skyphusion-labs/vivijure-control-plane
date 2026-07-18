# Changelog

All notable changes to the Vivijure control plane. Versions are SemVer; a `v*` tag on this
repository deploys the control plane (a `v*` tag in `vivijure-cf` deploys the Studio panel, which
is a separate product on a separate cadence).

## Unreleased

MINOR: the plane stops promoting a tenant to live on a credential whose propagation nothing has
observed, and finally answers "what is running" (cf#114; vivijure-control-plane#13).

### Module readiness probe

`installInvokeKey` writes key B to the studio and all five module scripts. A `200` from that PUT
means the secret is STORED; it does not mean the version the edge serves can read it. A tenant that
had just reported `live` failed its first render citing a credential that was demonstrably present,
and the identical payload succeeded 45s later (cf#99 finale, run 5).

- **New `TENANT_MODULE_DISPATCH` binding** so the plane can reach tenant module scripts, which carry
  no public route. Typed OPTIONAL: a deploy predating it reports UNVERIFIED, never a false pass.
  **Deploy prerequisite:** the namespace must exist before deploying with the binding present (it is
  created lazily by the provisioner, so a fresh account may not have it yet).
- **`awaitTenantModulesReady`** probes `GET /ready` on all five module scripts after the key-B
  fan-out and BEFORE the tenant flips live. Retryable ONLY on the not-visible-yet shape (endpoint id
  present, key absent); a missing endpoint id, a malformed envelope, or any other status fails
  immediately. A genuinely absent credential fails LOUDLY at the deadline with attempts and elapsed,
  which is what stops the retry from laundering a real misconfiguration into a success. A throw
  leaves the tenant at `awaiting_invoke_key`.
- **Budget-aware (cf#112 / cf#113):** one 10s deadline across ALL FIVE modules, probed concurrently
  per round, because this runs in a route a customer is waiting on. Not five sequential deadlines.
- **A 404 is reported `unverifiable`, not failed and not passed, and the cause is NOT guessed.**
  Hard-failing would mean a tenant on an older pin could no longer install a key at all. But a 404
  means "nothing answered here", which is a stale module image OR a missing script, and those are
  indistinguishable from the control plane; the detail states both rather than asserting the
  flattering one. The invoke-key response carries `modules_ready` / `modules_verified` /
  `modules_unverified`, per module with its script, never collapsed into one summary.
- **The `module` echo is checked** against the module being probed. Script names are tenant-prefixed
  and derived, so without it a naming bug lets a healthy NEIGHBOUR answer and be read as proof about
  the wrong module. A mismatch is a hard failure.

### `GET /api/platform/version`

`CONTROL_PLANE_VERSION` was referenced by nothing at runtime, so confirming which release was live
meant reading a patched line off a fetched asset. Now a one-line answer, from the same constant the
lockstep gate pins to `package.json`. Its own route, not a field on `/api/platform/config`: that one
is a policy projection with a UI contract, and deploy identity does not belong in it.

## v1.0.1 -- 2026-07-18

**Security PATCH.** Closes a polynomial ReDoS (CodeQL `js/polynomial-redos`, high) in the email
sanity check on the login door. Ships minutes behind v1.0.0 because the defect was live in the plane
before the extraction too; v1.0.0 neither introduced nor worsened it.

### The defect

`looksLikeEmail` ran on **unauthenticated** input at the login-start door, and it ran **before** the
rate limiter, so anything quadratic in it was reachable by anyone with no throttle in front of it.
It came across from `vivijure-cf` with the extraction; the extraction is simply what first put a
scanner on it.

Measured rather than assumed. The blow-up needs a FAILING match: a trailing `@` the segment class
cannot consume, which forces backtracking across every split of the repeated run.

| input | before | after |
| --- | --- | --- |
| `"a@" + "b.".repeat(10000) + "@"` | ~90ms | ~1ms |
| `"a@" + "b.".repeat(40000) + "@"` | ~1371ms | ~1ms |
| `"a@" + "b.".repeat(80000) + "@"` | ~5517ms | ~1ms |

Clean quadratic. 5.5 seconds of CPU from one request body is a denial of service on a Worker with a
CPU budget.

### Two fixes, redundant on purpose

- **Ordering.** The 254-character cap was checked AFTER the regex (`RE.test(e) && e.length <= 254`).
  `&&` short-circuits left to right, so the regex ran on UNBOUNDED input and the cap protected
  nothing. Length is checked first now, bounding the work whatever the pattern does. This was a real
  defect on its own, not just scanner appeasement.
- **Ambiguity.** The domain part was `[^\s@]+\.[^\s@]+`, where `[^\s@]` also matches a dot. That
  overlap between the segment class and the separator IS the backtracking. The segment classes now
  exclude the dot, so every character has exactly one role and the match is linear.

### Behaviour change, stated rather than slipped in

The stricter domain rejects consecutive dots (`a@b..c`), which the old pattern accepted. That
address is not deliverable, so rejecting it is correct, and the endpoint answers 202 for every
outcome regardless (it must not become an account-enumeration oracle), so nothing user-visible
moves. Pinned by a test.

### Tests

18 added; there were none. The file records what they can and cannot prove: the regex fix IS
isolated (exercised against `EMAIL_RE` directly, on input the length cap would otherwise reject), but
the ordering fix is NOT independently observable, because with a linear pattern the ordering makes no
difference and the end-to-end timing test only fails if BOTH regress. Said plainly in the test rather
than left to imply a guarantee that does not exist.

### Same class, second site: the AUP tag matcher (#11)

Found by Joan checking her own files after the first finding rather than assuming the scanner had
covered them -- it had passed her earlier PRs without flagging this.

`TAG_RE` in `public/onboarding-checks.js` had a `\d+` followed by a class that also matches digits,
so a long digit run could be split many ways and a failing match cost O(n^2). Measured on
`"v1.1." + "1".repeat(n) + "!"`: doubling n quadrupled the time (2000 -> 1.60ms, 16000 -> 99.55ms).
Fixed by forbidding the tail to start with a digit, which makes the digit run maximal and removes the
ambiguity. Differential-tested over 400k randomized strings: zero behaviour change.

**Severity LOW, and not dressed up.** That input is the ref parsed out of `AUP_URL`, which is
operator-set deploy config, not user input -- nobody reaches it without already controlling the
deploy. It rides this patch because it is the same defect class and the fix is cheap and proven, not
because it is urgent. `SHA_RE` and the slug matcher in the same file measured flat and are untouched.

### The AUP_URL moving-ref guard accepted four branch refs (#12)

Joan drove the REAL render script with a 16-case corpus instead of reading the glob, and found the
guard accepting `/raw/develop/`, `/blob/trunk/`, `/blob/head/` (HEAD was covered, lowercase was not)
and `/blob/Main/` (the glob was case-sensitive). It refused `/main/` and `/master/` correctly, which
is exactly why it read as working.

Each one is a branch ref, and a branch ref as `AUP_URL` means the policy text an account accepted can
change afterwards while the recorded `sha256` still claims to describe it -- the precise failure the
guard exists to prevent. Each case was reproduced as accepted BEFORE the patch, then watched flip to
refused.

This has to ride a tagged release rather than sit on main: `deploy.yml` checks out the TAG, so the
guard only takes effect once tagged.

### CI: the CodeQL language pin never applied (#10)

Not a runtime change, recorded because it explains why two ReDoS defects sat unflagged. The workflow
passed `language` (singular) to `codeql-action/init`, which takes `languages`. Actions does not fail
on an unknown input, so the pin was silently ignored and auto-detection ran instead. It happened to
find MORE than the pin claimed, so there was no coverage gap, no failing check, and nothing to
notice. Now stated correctly, with `actions` and `python` declared alongside
`javascript-typescript` rather than narrowed away.

## v1.0.0 -- 2026-07-18

The hosted control plane becomes its own product, in its own repository, serving from its own
tagged release.

Before this, the control plane lived inside `vivijure-cf` and was deployed by hand. That meant
anyone who wanted to self-host Vivijure Studio carried the machinery for running a hosted service
they had no intention of offering, and it meant the live plane ran an untagged working state rather
than a release. Both are fixed here.

### The extraction

- Extracted from `vivijure-cf` at commit `59b3fb38` (vivijure-cf#85). Pre-extraction history stays
  in `vivijure-cf`; no history was rewritten in either repository. See `NOTICE`.
- `vivijure-cf` remains a complete, self-hostable Studio with no requirement to operate a hosted
  service. Nothing in this repository is needed to run Studio yourself.
- The two repositories are coupled ONLY through the published Studio release artifact -- the
  versioned bundle contract, pinned by `{tag, manifest_sha256}`. There are no source-level imports
  across the boundary, and there must never be.
- Studio release pin floor: **v1.3.1**.

### Tag semantics, split

Each repository now versions and deploys its own product. The shared-tag double duty is gone:

| tag | deploys |
| --- | --- |
| `v*` here | the control plane |
| `v*` in `vivijure-cf` | the Studio panel |

### Migrations apply on deploy (vivijure-cf#80)

Schema now reaches the live control-plane D1 through the deploy pipeline or not at all. No
hand-applied schema, ever.

This closes a defect that produced two live provisioning failures in a single evening. The live
database had been built by hand: `0001` applied raw, `0002` skipped entirely, `0003` applied after
the fact, and no `d1_migrations` ledger to notice any of it. The symptoms were an AUP acceptance
returning 500 on a missing `aup_sha256` column, and a provision dying at `r2_token` on
`no such column: r2_token_id`.

- migrations are applied **before** the worker deploys, so new code never runs against old schema
- a separate verify step re-lists migrations afterwards and fails the deploy if any remain pending,
  because `apply` exiting 0 proves only that it did not error
- migrations must be additive; a destructive or narrowing change needs expand/contract across two
  releases (`CONTRIBUTING.md`)

### Deploy pipeline

- `v*` tag only, never a push to `main` -- an ordinary merge must not redeploy the live plane
- the tag must match the declared version, so a build cannot ship reporting a version it is not
- config is rendered from `wrangler.toml.example` at deploy time and fails closed: every injected
  value is required unless explicitly allowlisted, the D1 id is checked by shape rather than mere
  presence, and `AUP_URL` is refused if it points at a moving ref
- a `workflow_dispatch` dry run validates configuration and reports pending migrations without
  writing anything; the writes live in a separate job so a dry run skips them by construction

### Also here

- `zone-security/` -- the vivijure.com zone WAF as code, moved from `vivijure-cf`, in log mode.
  The flip to enforce is a separate launch gate.
- Born at the full aviation-grade standard: `main` requires PRs, blocks force-push and deletion,
  and gates on `ci` / `coverage` / `CodeQL`.
