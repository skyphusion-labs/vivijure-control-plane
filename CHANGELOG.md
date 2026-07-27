# Changelog

All notable changes to the Vivijure control plane. Versions are SemVer; a `v*` tag on this
repository deploys the control plane (a `v*` tag in `vivijure-cf` deploys the Studio panel, which
is a separate product on a separate cadence).

## Unreleased

### feat(credits): the tenant-facing credit surface (cp#194)

- New `public/credits-checks.js` (pure, no DOM, `node --check` plus a unit suite) and a credit panel
  on the live-studio route of `public/index.html`, wired in `public/front-door.js`. Vanilla JS, no
  framework, no build step.
- **The surface ships DARK, deliberately.** It renders only when the plane says `credits_apply`, and
  that is false for every tenant today because the tenant class which would make it true
  (`tenants.compute_mode`) is designed in `docs/managed-compute.md` and lands with cp#191. The
  alternative was showing every existing BYOK tenant a USD 0.00 balance, which would invent a billing
  relationship they never entered into on a product whose current pitch is that there is no paid tier.
- **Applicability is never inferred from the numbers.** A BYOK tenant and a prepaid tenant who has not
  topped up both read zero; guessing from the shape of the payload is how the first gets told they owe
  us money. The API states it (`credits_apply`, `topup_available`, both always present even when
  false) and the surface renders from the statement.
- An unreadable balance shows an honest sentence and NO figure, because this is the number a tenant
  uses to decide whether they can start work. Counting mode is stated on the panel rather than left to
  be inferred from nothing being refused. Held is shown only when something is held.
- The top-up control has THREE states (hidden / not-open-yet / available), so an unprovisioned rail
  renders as a sentence and never as a control that invites a click.
- Failed jobs appear as explicit no-charge lines carrying their reason, and a zero-delta line shows no
  money at all rather than "USD 0.00" (which reads as a charge that happened to be free, a different
  claim from "we did not charge you").

### fix(deploy): declare CREDITS_ENFORCING, which shipped in v1.17.0 as a knob that could not be turned

- `CREDITS_ENFORCING` (cp#192, released in v1.17.0) was typed in `env.ts` and read by both credit
  routes, but declared in **none** of `wrangler.toml.example`, `scripts/render-wrangler.sh`, or
  either `deploy.yml` render block. It therefore never reached the Worker. The DEFAULT behaviour was
  still correct, because absent reads as counting mode and that is the ruled default, so nothing was
  broken in production. **What was broken is the ability to change it**: setting the repo variable
  would have done nothing, and every surface would have kept reporting `enforcing: false` while an
  operator believed they had switched enforcement on.
- That matters beyond tidiness: flipping this knob is a named acceptance criterion of cp#193, and its
  closing evidence is a live read showing `enforcing: true`. A knob that cannot be turned makes that
  criterion unmeetable, and the failure would have surfaced at the worst moment, next to a live
  purchase door.
- Now declared in all four lists as `ALLOW_EMPTY`, on merit: empty is not merely tolerated here, it
  is the ruled default.

**The census did not catch this, and the reason is worth recording.** `scripts/var-census.py` starts
from the placeholders in `wrangler.toml.example` and asserts the other three lists agree with it. A
var that appears in NONE of the four is invisible to it: the lists agree by all omitting it. So the
census closes the drift class where a var is declared in some places and not others, and cannot see
the class where a var is declared nowhere and read anyway, which is the original cf#56 shape. Closing
that would mean censusing `src/env.ts` against the deploy lists, which needs a vars-vs-secrets-vs-
bindings distinction the current script does not make. Filed rather than bolted on here.
### feat(hosted): bind TENANT_ID and TENANT_SLUG for per-tenant Opus attribution (cp#185)

The plane side of the per-tenant Opus meter. vivijure-cf#271 made `plan-enhance` EMIT
`cf-aig-metadata` when these two vars are bound; nothing bound them, so that half shipped inert.

Why a second mechanism exists at all: the AI Gateway records `authentication` as a BOOLEAN. It logs
THAT a request was authenticated, never WHICH token did it, so the per-tenant `CF_AIG_TOKEN` is an
access and revocation boundary carrying ZERO attribution. `cf-aig-metadata` is the entire
attribution mechanism, and Cloudflare computes `cost` natively so we never price Opus ourselves.

- Bound as `plain_text` (neither value is a secret) and scoped to `needsAiGateway` catalog specs.
- Bound UNCONDITIONALLY for such a module, NOT gated on the token pair: with the trio unconfigured
  the module runs on the free local provider and never makes a gateway call, so the vars are simply
  unread. Gating them on the token would couple two unrelated things.
- The slug is threaded through `uploadTenantModules` as a REQUIRED parameter. Attribution keys on
  the tenant id, so a missing slug is not a correctness bug, which is exactly why an optional
  parameter would rot: the compiler catches an omission instead of a human finding a blank label
  months later.

PARITY: a self-hosted install gets neither var, sends no header, and emits byte-identical requests
to before. A self-hoster bills their own account and has nothing to attribute.

ORDERING: metadata only flows once BOTH this and a studio release carrying the vivijure-cf#271
plan-enhance bundle are pinned. Each half alone is inert but harmless, so they can land in either
order.


## v1.17.0 -- 2026-07-27

MINOR: the per-tenant cost-bound lane. The prepaid credit ledger primitive (inert by design) and the
per-tenant R2 storage ceiling, which also RESTORES provisioning: the pinned vivijure-cf v1.12.0
manifest declares `R2_STORAGE_QUOTA_BYTES`, this plane had no disposition for it, and
`assertDispositionCoversContract` was therefore refusing EVERY provision and EVERY studio upgrade
against that pin.

**Carries TWO migrations, and both reach the live plane on this deploy** (verified against
`migrations/`, `git diff v1.16.0..HEAD`, not assumed from any one PR): `0013_credit_ledger.sql`
(new `credit_ledger` + `credit_holds` tables) and `0014_tenant_storage_quota.sql` (two new nullable
columns on `tenants`). Both are purely additive -- no table or column is dropped, altered or
backfilled -- so an older Worker keeps running against the newer schema, which is what makes the
migrate-before-deploy ordering safe here. Stated explicitly rather than discovered, given the cf#80
history recorded in `deploy.yml`.

Contains two merged PRs: #198, #199.

### feat(credits): balance and usage read API (cp#192)

- `GET /api/tenant/:id/credits` (owner session) and `GET /api/admin/tenants/:id/credits` (admin
  bearer). Both are served by ONE reader and differ only in what is projected, so an operator can
  never be looking at a different balance from the one a tenant was refused against.
- **Holds are projected beside ledger rows.** Under completed-only billing a failed job leaves a
  released hold and NO ledger row, so a statement built from money rows alone would show a tenant
  nothing where their failed render should be. Released and expired carry DIFFERENT reasons: "your
  job did not complete" and "your job never reported back" are different facts.
- Money crosses the wire as integer micro-USD and is formatted only at the edge. An unreadable
  balance is **503**, never 200 with zeros; an unwired credit store is **503 credits_unconfigured**,
  mirroring the existing `provisioner` precedent.
- The admin projection adds the cost side. `price_to_cost` is **NULL** when cost is unknown or zero,
  never a fabricated 1.0, and price is summed only over rows whose cost is KNOWN; unmeasured rows are
  counted (`charges_missing_cost`), not hidden. The tenant view never carries the cost side.
- `complete` (about the aggregates) and `activity_truncated` (about the feed) are separate flags, so
  `complete` does not go false on every active tenant and get ignored.
- New var `CREDITS_ENFORCING`. Enforcement mode is reported on every response.
- Fixed in passing: `MemoryStore.recordAupAcceptance` declared 4 parameters against the interface's
  5. TypeScript permits the narrower implementation, so it compiled while dropping `userAgent` and
  made a correct 5-argument call a type error. Caught by `npm run typecheck`, NOT by the suite, since
  vitest never typechecks.

### feat(credits): the prepaid credit ledger primitive (cp#189, under cp#173)

- **Schema change.** New migration `0013_credit_ledger.sql` adds `credit_holds` and `credit_ledger`.
  Nothing reads or writes them yet: no route consults a balance until the dispatch proxy lands
  (cp#191), so this ships inert by design.
- **Unit is integer micro-USD (1e-6 USD)** throughout, never a float and never cents. Conrad ruled in
  USD (USD 10 minimum top-up, USD 3-5 per film), and the measured cost basis carries USD 0.001765
  line items (`docs/cost-basis.md`), which cents cannot represent without rounding away every
  reconciliation.
- **Two tables, deliberately.** `credit_ledger` is money that MOVED: append-only, never updated, a
  correction is a new row. `credit_holds` is a RESERVATION whose lifecycle is genuinely mutable, so it
  is one keyed row updated by conditional UPDATE. Balance is a SUM over rows and never a stored
  running total.
- **Holds exist because billing is COMPLETED-ONLY** (Conrad, 2026-07-27): a failed render costs the
  tenant nothing and we eat the GPU. A charge that lands only at completion cannot refuse anything at
  submit on its own, so a tenant with USD 0.50 available could otherwise start a USD 4 film.
- **The guarantees are the database's, not the caller's:** one debit per hold ever (`idem_ref` IS the
  hold id, under a unique index); a released hold can never become a debit (the capture INSERT
  requires `status='captured'`, so completed-only billing is a WHERE clause); one capturer wins
  (conditional UPDATE on `meta.changes`); a debit cannot carry a positive sign (CHECK constraint);
  settle and charge cannot come apart (one D1 batch).
- `cost_micro_usd` sits beside the price and is **NULL when unmeasured, never 0**, so the
  cost-recovery claim is auditable per tenant rather than asserted.
- **Counting mode is the default** (`CREDITS_ENFORCING` unset = record everything, refuse nothing).
  Deliberately not fail-closed: no purchase door exists yet, so no tenant can hold a positive balance
  and enforcing by default would refuse every submission the instant the migration lands. Flipping
  enforcement on is a named acceptance criterion of the payment rail (cp#193).
- Testing: the pure decisions run with no store at all, and everything that is a property of the SQL
  runs against a real engine built from the real migrations (the node:sqlite harness gains `batch()`
  as a real transaction). There is deliberately **no fake ledger**. Every guard was watched FAILING
  under mutation before being trusted.

### feat(quota): bind R2_STORAGE_QUOTA_BYTES per tenant, at provision and at converge (cp#183)

- **Restores a broken capability, not merely a new knob.** vivijure-cf v1.12.0 declares
  `R2_STORAGE_QUOTA_BYTES` in its release manifest; this plane had no disposition for it; so
  `assertDispositionCoversContract` threw on **every provision** (`provisioner.ts`) and **every
  studio upgrade** (`tenant-studio-upgrade.ts`) against the pinned release. Found by pulling
  `studio-releases/v1.12.0/manifest.json` out of R2 (the object the deployed plane fetches), not
  from memory. The guard was right; nothing on this side answered it.
- vivijure-core v1.3.0 shipped the per-tenant storage ceiling (core#52) and vivijure-cf v1.11.0
  wired the reader, and **this plane wrote the var nowhere** (repo-wide grep: zero hits), so hosted
  shipped the enforcement bound to nobody. `SPEND_DAILY_CEILING` caps what a tenant spends in a day;
  nothing capped what a tenant ACCUMULATES, which is the bill that keeps arriving after the
  rendering stops and the one we inherit when a tenant leaves.
- **Three write paths**, because one door leaves the estate split: the provision upload, the studio
  upgrade (re-derived, never inherited, so a raised or lifted ceiling actually moves), and
  `POST /api/admin/tenants/:id/storage-quota` for tenants already live.
- **PER-TENANT overridable, including unset** (cp#173, found by joan against live core source before
  this shipped). The core knob is a submit-time DENY, so it is a hard cap: right for BYOK and
  self-host, who pay us nothing for GPU while their R2 sits on our bill, and wrong for a PREPAID
  tenant bounded by their credit balance, who would be denied at exactly the byte where charged
  overage begins. `migrations/0013` therefore keeps THREE states -- inherit / `set` / `none` -- because
  "no per-tenant value" and "deliberately uncapped" bind the same thing today and diverge the day a
  default is set. One resolution seam (`resolveStorageQuota`) serves all three write paths.
- **No default in code**, on either host: unset = no ceiling, the same posture as
  `R2_USAGE_ALERT_BYTES`. The number prices what an operator is willing to carry per tenant, which
  is policy this repo does not get to invent. It lives in the deploy variable
  `TENANT_R2_STORAGE_QUOTA_BYTES` (var census honored: template, render allowlist, BOTH deploy env
  blocks; `var-census.py` watched to FAIL with one block missing).
- **A set-but-malformed value REFUSES rather than rounding down to off.** core parses `100GB` and
  `""` identically (quota off), which makes "typed it wrong" and "wants no ceiling" the same outcome
  while an operator believes tenants are capped. It blocks a tenant who would INHERIT the value and
  deliberately does not block one who overrode it.
- **The reader floor is a PRE-write probe**, unlike cp#164: a studio carrying the core#52 reader
  serves `GET /api/storage/usage` whether or not a quota is set, so a 404 proves the reader is
  absent and the converge refuses before writing a ceiling nothing would enforce. Measured against a
  real running studio (200, `quota_bytes: null` with the quota off), not assumed.
- **Green means the STUDIO said so**: bounded-retry readback of the enforced number, 200 enforced /
  202 bound-but-not-yet-observed / 409 strand, with `ok` and `enforced` both false on the 202.
  `quota_source` and `record_written` travel in the response and the audit row.
- Carries a schema change: `migrations/0014_tenant_storage_quota.sql`.

## v1.16.0 -- 2026-07-27

MINOR: the cf#56 hosted-glue lane. Per-tenant AI Gateway credential on plan-enhance, the admin R2
usage surface, and the deploy-var activation that makes both of them actually reach the Worker.
Carries **NO schema change** (verified against `migrations/`: the v1.15.1..v1.16.0 range touches no
migration file, not assumed from the absence of a migration in any one PR).

Contains four merged PRs: #181, #182, #184, #186.

### docs: measured per-job-class compute cost basis (cp#180)

- Adds `docs/cost-basis.md` (237 lines, docs only, no code path touched). A MEASUREMENT of
  per-job-class compute cost, not a pricing design; every number carries a provenance tag
  (MEASURED / CITED RATE / DERIVED) and an untagged number is defined as a bug in the document.
  Feeds the prepaid credit design (cp#173) and the per-tenant meter (vivijure-cf#56).

### fix(deploy): activate TENANT_AI_GATEWAY_ID and R2_USAGE_ALERT_BYTES, and census the var lists (cf#56)

- Both vars were typed in `env.ts` and read in `deps.ts` but declared in **no** deploy config, so
  they rendered EMPTY and shipped their features **INERT** while every test and every deploy stayed
  green. `TENANT_AI_GATEWAY_ID` unset meant the per-tenant AI Gateway token was never bound (the
  both-or-neither guard correctly turned it into a safe no-op); `R2_USAGE_ALERT_BYTES` unset meant
  the admin usage surface could never alert. Now declared in `wrangler.toml.example`, allowlisted in
  `render-wrangler.sh`, and supplied in **both** deploy.yml render env blocks.
- Both are `ALLOW_EMPTY` on merit, not to quiet a deploy: empty gateway = `plan-enhance` runs on the
  free local Workers AI provider (a coherent working state, since the provisioner binds neither
  `GATEWAY_ID` nor `CF_AIG_TOKEN` when either is missing); empty threshold = `no_threshold`, because
  an operator who has not chosen a number has not asked to be alerted.
- **`scripts/var-census.py` closes the drift class that caused this.** A `[vars]` entry only reaches
  the Worker if it appears in the template, in a render allowlist, AND in BOTH deploy env blocks;
  nothing connected those four lists. The census asserts they agree, runs inside
  `tests/render-wrangler.test.sh` (already wired into CI), and ships with a control proving it can
  fail. Mutation-verified in both directions: dropping a var from one deploy block, and adding an
  unlisted placeholder, are each caught.

**ACTIVATION IS NOT COMPLETE AT MERGE.** Two repository VARIABLES must be set, and one of them is a
release decision, not a config nit:

- `STUDIO_RELEASE` is **v1.9.0**, and **v1.9.0 does not contain plan-enhance** (verified against the
  release tarballs: v1.9.0 ships 6 modules without it, v1.12.0 ships 7 with it). Deploying the
  plan-enhance catalog entry against a v1.9.0 pin fails **every** provision at `modules_upload`.
  It must move to **v1.12.0 or later** BEFORE the control plane carrying that entry is deployed.
- `TENANT_AI_GATEWAY_ID` must be set to `vivijure-hosted`, or the feature stays inert.

### feat(hosted): per-tenant AI Gateway token on plan-enhance (cf#56)

- `plan-enhance` joins `TENANT_MODULE_CATALOG`, so hosted tenants get the Opus director pass on OUR
  unified billing through the DEDICATED `vivijure-hosted` gateway, with a per-tenant `CF_AIG_TOKEN`
  making that spend attributable and revocable one tenant at a time.
- **`TenantModuleSpec.endpointKey` is now optional.** plan-enhance is not RunPod-backed, and an absent
  key is the honest encoding rather than a sentinel endpoint existing only to satisfy a type. A spec
  that DOES declare an endpointKey the tenant lacks still fails loudly, unchanged and tested.
- **Bindings are BOTH or NEITHER.** `pickProvider` returns `opus` only when `GATEWAY_ID` and
  `CF_AIG_TOKEN` are both present, so a half-bound module is a silent permanent fallback to the free
  local provider, not a partial feature. `AI` is bound unconditionally because the local fallback
  needs it too. The unconfigured case logs `module.ai_gateway_unconfigured`.
- **Revocation is wired on every path:** revoke-then-mint at provision AND at upgrade/converge (an
  existing tenant GAINS the module on converge, and a module shipped without its credential is one
  that quietly runs on the wrong provider), plus revoke at teardown. By deterministic NAME, so no
  migration and no new column: unlike the R2 credential, whose id doubles as the S3 access key id,
  this token id is only ever needed in order to revoke.
- **`TENANT_AI_GATEWAY_ID`** names the gateway. Unset = no gateway, and plan-enhance degrades to the
  free local Workers AI provider, which is a genuine working fallback. Never point it at
  `skyphusion-llm`; that is prism gateway and sharing it would defeat per-tenant attribution.
- Fixed while adding the catalog entry: the module-upgrade preflight derived its required-endpoint
  set from the whole catalog, so an endpoint-less spec would have refused EVERY upgrade with
  "missing the endpoint(s) needed by: plan-enhance". Now only endpoint-backed specs are checked.
- **Live-proven, not assumed:** an `ai` binding attaches to a Workers-for-Platforms user worker
  (uploaded into a throwaway namespace, read BACK off the API as `AI [ai]`, torn down); the
  provisioner credential mints an `AI Gateway Run` token (group id read off the API, never guessed);
  `vivijure-hosted` ENFORCES it (valid token 200, bogus token 401 at the gateway, no header 401);
  and revocation genuinely stops access, with a **~8-16s propagation lag**.
- **KILL-SWITCH RUNBOOK FACT:** revoking a tenant token is real but NOT instant (~8-16s). An operator
  pulling it during an incident must not read the first success as failure; re-check, bounded. Same
  family as the cf#114 edge-propagation lesson.

**DEPLOY ORDERING (this is load-bearing):** the catalog entry is only safe once a studio release
actually PUBLISHES the plan-enhance bundle (vivijure-cf#56, PR #270). `moduleBundle.fetch` throws on
an older release, and while that failure is loud rather than silent, it would fail EVERY provision.
Merge vivijure-cf#270, cut a studio release, and only then deploy this pinned at that tag or later.

### feat(admin): aggregate per-tenant R2 usage with an honest alert verdict (cf#56)

- `GET /api/admin/r2-usage` returns per-tenant bucket usage, an aggregate, and an alert verdict
  against an operator-set threshold (`R2_USAGE_ALERT_BYTES`). **Reads only**, and records no audit
  row for the same reason `/api/admin/reconcile/runpod` records none: nothing changes, and a write
  would let the pass alter what it measures.
- **Hosted-only and correctly so:** it measures OUR bill and cannot reach a tenant studio. The
  per-tenant storage QUOTA stays a studio-core operator knob (vivijure-core#52) so self-host gets the
  identical feature rather than a hosted-only enforcement path.
- **A number we could not read is `null`, never `0`.** A failed bucket read and an empty bucket are
  different facts; collapsing them makes the total under-report and the alert under-fire.
- **An under-threshold verdict requires a COMPLETE total.** `listTenants` pages at
  `TENANT_PAGE_LIMIT`, so a truncated census or any failed read makes the total a FLOOR. The verdict
  is three-state: `over` is sound from a floor, `under` requires completeness, `indeterminate` is the
  honest answer in between. `parseThresholdBytes` refuses `0` (a permanent alert is ignored).
- **Live-verified, not stubbed:** Cloudflare returns these counters as STRINGS, so a client assuming
  numbers would feed `NaN` into the aggregate. Asserted against the real API with a negative control
  proving a nonexistent bucket throws rather than reporting zero usage.
- Fix-forward: the `CANNOT mint an R2 token` live negative control mints with a BOGUS permission-group
  id, so it is refused under any credential and passed vacuously under the full token. Now skipped
  under `CF_PROVISIONER_FULL`, active under the reduced token where its premise holds.
- Fix-forward: `SPEND_DAILY_CEILING` was documented as bound only when an operator configures a
  ceiling; `productionDeps` supplies a `25` fallback, so it is bound on every provision here.
  Confirmed live on the testbed tenant studio (cf#56 item 4, no code needed).

## v1.15.1 -- 2026-07-27

PATCH: the cp#164 converge route reported a SUCCESSFUL converge as a failure, because its readback raced edge propagation. Found by running the cp#164 acceptance against the live testbed, hours after v1.15.0 shipped it. Carries NO schema change (verified against `migrations/`, not assumed).

### fix(hosted): the abuse-report-url readback raced edge propagation (cp#164)

- **Found by running the cp#164 acceptance, not by reading code.** The first live converge on the
  testbed bound the var cleanly (19 bindings to 20, nothing stranded, all four secrets intact) and
  the studio served no `host.abuse_report_url`, so the route answered **409 and told the operator to
  move the studio bytes**. Sixty seconds later the same call returned `reader_live: true` with the
  URL, twice in a row. Nothing about the studio had changed: the settings PATCH had not reached the
  isolate answering the next dispatch.
- That is the cf#114 lesson arriving from a new direction ("the secrets PUT returning 200 does NOT
  mean the edge serves the key yet"), and the first cut of this route did not apply it to its own
  readback. The cost ran the wrong way: an operator following that 409 would move a live tenant onto
  a new release to fix a problem that did not exist.
- The confirm is now **bounded-retried** (`READBACK_PROBE_MS` 2500 / `READBACK_BUDGET_MS` 15000), the
  first read still happens immediately so a current studio stays instant, and the response carries
  `readback_attempts` and `readback_elapsed_ms` as numbers rather than as a sentence.
- **Three outcomes now:** 200 bound and observed; **202** bound, nothing stranded, not yet observed;
  409 a genuine strand only. The 202 names both possible causes (the edge has not caught up, or the
  bundle predates the vivijure-cf v1.10.0 reader) because from the plane they are indistinguishable,
  and says re-run first since the route is idempotent. `ok` and `reader_live` stay false there, so
  nothing machine-readable claims an unobserved success. 202 is the shape the invoke-key route
  already uses for "stored, not yet proven".
- `docs/open-the-doors-checklist.md`: the hosted tenant-studio abuse-link row flips to **DONE**,
  riding three artifacts and carrying no residual: the converge readback (`reader_live: true`), the
  tenant serving `host.abuse_report_url` back on its own `GET /api/modules`, and the rendered panel
  eyeballed by the account owner on the testbed studio (2026-07-27). That last one is owner-side by
  construction rather than a gap: the panel is `AUTH_MODE=token` with a dispatcher-injected owner
  credential, so nobody else has a clean door to it.
- Carries NO schema change.

## v1.15.0 -- 2026-07-27

MINOR: the two ends of a hosted tenant that a human has to reach. A tenant studio can finally show a reporter where to go (cp#164), and an operator repair can finally be finished rather than stranding at a route only the account owner can call (cp#169). Two new admin routes, two new owner-facing surfaces, and new tenant-visible behaviour, hence MINOR.

**CARRIES A SCHEMA CHANGE:** migration `0012_invoke_key_handoff.sql` (new table `invoke_key_handoffs`). Additive `CREATE TABLE`, so the deploy workflow's migrate-then-deploy order is safe, but this tag DOES apply a migration on deploy.

### feat(hosted): operator-initiated, owner-completed invoke-key handoff (cp#169)

- **The strand.** A cp#137 reprovision rebuilds a tenant's four RunPod endpoints; new endpoints get
  new ids, so the stored key B is scoped to ids that no longer exist and every repair ends at
  "install a fresh invoke key" -- on a SESSION-gated route. The operator who performed the repair
  could not finish it, and the tenant sat at `awaiting_invoke_key` until the account owner signed
  in. Observed live during the cp#137 remediation.
- **Conrad's ruling: PATH 3.** The INITIATIVE moves to the operator, the CREDENTIAL DECISION stays
  with the owner. An admin-gated install (option 2) was declined deliberately: it would let an
  operator credential place a RunPod key on a customer studio.
- A successful reprovision now mints a one-time link in the same response that reports the repair,
  bound to the endpoints THAT run created; `POST /api/admin/tenants/:id/invoke-key-handoff` mints one
  on demand for a tenant stranded before this existed. The owner opens `/install-key?t=...`, reads
  what happened and which four endpoints to scope, and pastes their own key. No email integration in
  this pass (parked); the operator hands the link over through their support channel.
- **The verification is unrelaxed and unduplicated.** `verifyInvokeKeyScope` runs exactly as on the
  session route because there is now exactly ONE install implementation and both routes call it. A
  key that can reach graphql is still refused, and all four endpoint ids are still probed.
- **What a leaked link can do is bounded by RunPod, not by our clock:** the key offered must reach
  the tenant's own endpoints, which live on the TENANT's RunPod account, so the link alone installs
  nothing.
- Storage is hash-only (`invoke_key_handoffs`, migration 0012), the rule `login_tokens` and
  `sessions` already follow. Issuance AND consumption are audited, correlated by a handoff id that
  is not part of the secret; neither row carries the token or the key.
- **Single use burns on a COMPLETED install only.** A rejected key must not burn the link (a typo
  would re-strand the customer), and neither must the 202 path, whose own message says to retry.
- A handoff made STALE by a later reprovision is refused rather than honoured: installing a key
  scoped to dead endpoints would re-enter the state the handoff exists to repair.
- A link that cannot be minted does not undo a repair that already happened: the refusal is reported
  on the response and the standalone mint route is the retry.
- Schema: migration 0012 adds `invoke_key_handoffs`. Additive (`CREATE TABLE`), safe under the
  workflow's migrate-then-deploy order.

### feat(hosted): the plane sets ABUSE_REPORT_URL on tenant studios, on both doors (cp#164)

- **The reader shipped and had nothing to read.** vivijure-cf v1.10.0 validates `ABUSE_REPORT_URL`
  and projects `host.abuse_report_url` onto `GET /api/modules`, which `public/abuse-link.js` renders
  from as its sole signal. This plane wrote that var nowhere (repo-wide grep: zero hits), so no
  hosted tenant studio could show a reporter where to go -- on the surface where hosted content is
  actually seen, under an enforcement model that is report-driven by ruling and therefore has intake
  as its entire detection surface.
- **The value is DERIVED, never configured.** The intake page is served by this Worker out of
  `public/report-abuse.html` at `CONTROL_PLANE_HOST`, so the URL is a fact of the deploy: it comes
  through `publicOrigin()` like `PUBLIC_ORIGIN` and the tenant domain suffix. A second env var beside
  it could disagree with the page we actually serve. Canonical path `/report-abuse`, verified live
  (200 direct; `/report-abuse.html` 307s to it), not read off the markup.
- **HOSTED-ONLY, structurally rather than by policy.** The value is computed from control-plane env,
  inside the control plane, and the studio bytes uploaded to a tenant are the published release
  unmodified, so nothing on this path can reach the bundle a self-hoster installs. Their unset var
  renders nothing, which is correct because we are not their provider and cannot act on their
  content -- and it stays correct mid-rollout for a hosted tenant not yet converged.
- **THREE write paths, because one door leaves the estate split** (the cp#112 / cp#136 lesson): the
  provision upload reaches new tenants, `upgradeTenantStudio` reaches any tenant whose bytes move,
  and the new `POST /api/admin/tenants/:id/abuse-report-url` reaches a tenant already LIVE without
  moving bytes. A binding patch, not a re-upload: no bytes, no release, no status, everything else
  carried as `inherit` so no secret value is handled. Re-derived at every write rather than
  inherited, so a studio carrying a URL from a plane that no longer publishes that page is converged
  rather than left advertising a dead one.
- **The reader floor is a READBACK, not a version compare.** Setting the var on a studio whose
  bundle predates v1.10.0 is a silent no-op, the cf#98 / cp#112 failure family. cp#136's PRE-write
  capability probe is unavailable here: the panel emits `host.abuse_report_url` only when the var is
  already set, so its absence beforehand proves nothing. The route therefore writes, then asks the
  studio what it serves; `reader_live: false` answers 409, and the fix is to move the studio bytes,
  not to set the var again.
- `ABUSE_REPORT_URL` is `conditional` rather than `provisioned` in `src/tenant-studio-env.ts`,
  deliberately: `provisioned` joins `REQUIRED_TENANT_STUDIO_VARS`, which the MODULE upgrade
  re-checks in a verify census on a path that never touches studio bindings, so requiring it would
  fail an unrelated module upgrade on every tenant not yet converged. A studio without the var is
  fully functional.
- Carries NO schema change.

## v1.14.0 -- 2026-07-27

MINOR: two corrections that came out of running the cp#137 remediation end to end on the live testbed. The rebuild route now names WHO installs the invoke key (the account owner, not the operator, whose admin token that route refuses); and the cp#45 smoke render fixture no longer names a project the studio never assigned, which is what stopped the only renderability proof we have from passing against a backend that enforces bundle-key tenancy. Carries NO schema change.

### fix(hosted): the smoke render fixture named a project the studio never assigned (cp#137, cp#45)

- **The cp#45 smoke render could not pass against a current-pinned backend, and nobody knew.** The
  canonical storyboard shipped `title: "Control Plane Smoke Render"` with
  `projectName: "control-plane-smoke"`. The studio does not accept a caller-supplied projectName at
  all: `validateStoryboard` DERIVES it from the title and discards the field, then names the bundle
  `bundles/<projectName>-<contenthash>.tar.gz`. The render submit separately named
  `project: "control-plane-smoke"`, and backend >= 1.0.11 validates that the bundle key BELONGS to
  the submitted project (`check_bundle_key_for_project`). Bundle under the TITLE, submit under the
  PROJECT, refused before any GPU work.
- **It was masked by a stale image, not by luck.** Backend 1.0.2 had no tenancy check, and the
  standing testbed was still running 1.0.2, so this fixture has never once been exercised against a
  backend that enforces the rule. It surfaced the moment cp#137 moved that tenant onto the pin the
  plane actually holds -- which is the converge step doing exactly its job.
- Title and project are now the SAME string, chosen to be NORMALIZATION-STABLE (no whitespace, no
  `/`) so it is a fixed point of the studio's transform. Deliberately not a re-derivation: mirroring
  another repo's normalization in shipping code is only correct until they change it, whereas a value
  their transform leaves unchanged needs no mirror. The test asserts the fixed-point property and
  carries a control proving the previous title was NOT one.
- **No product exposure.** The real panel submits the projectName the studio itself returned from
  validation, so live renders were always self-consistent. This was a fixture-only defect.

### fix(hosted): the reprovision next_step names WHO installs the invoke key (cp#137, cp#169)

- The rebuild route ended by telling its caller to "POST it to `/api/tenant/<id>/invoke-key`". That
  route is OWNER-authenticated (the admin bearer is honoured only under `/api/admin/`; every other
  `/api/` path resolves a session), so the operator who just ran the repair gets a 401 there. Observed
  live during the cp#137 remediation. The text now names the ACCOUNT OWNER and says plainly that an
  operator holding the admin token cannot complete the step -- an instruction the system will not
  honour is the same defect class cp#137 exists to end.
- Wording only: no behaviour, no route, no custody change. Whether an operator SHOULD be able to
  finish a repair they started is a real custody question and is filed as cp#169, to be ruled with
  Conrad rather than patched in flight.


## v1.13.0 -- 2026-07-27

MINOR: the remediation half of cp#137. A live tenant's four RunPod endpoints can now be rebuilt through a plane mechanism rather than a hand-edit of D1, and the tenant's satellite templates are walked onto the pins this plane holds before anything is rebuilt on them. Carries NO schema change. The new route is admin-gated and takes the tenant's own RunPod key A as a transient parameter; the plane still stores no RunPod credential, so the custody boundary is unchanged.

### feat(hosted): rebuild a tenant RunPod endpoints through a plane mechanism (cp#137)

- **A live tenant can now have its four RunPod endpoints rebuilt without a hand-edit of D1.**
  `POST /api/admin/tenants/:id/reprovision-runpod` (admin-gated, `confirm_slug` required) converges
  the tenant's templates onto the pins the plane holds, revoke-then-mints a fresh bucket credential,
  rebuilds the endpoints idempotently by name, re-points the studio bindings and the module scripts
  at the new ids, and writes `awaiting_invoke_key`. Key A is a parameter: never stored, never logged,
  never on a response. This is the remediation half of cp#137, whose detection half shipped in
  v1.11.0 and proved the standing testbed reads `live` while all four endpoints it names are 404.
- **The status write comes FIRST, deliberately.** From the moment the pass begins, the studio's
  wiring is being replaced and the stored key B is scoped to endpoints about to be superseded;
  leaving `live` in place would be exactly the record-presenting-a-capability defect cp#137 exists to
  end. A failure at any step therefore leaves an honest status rather than one somebody must repair.
  `failed` is never written: the studio still exists, still serves, and its data is untouched.
- **A fresh R2 credential is forced, not chosen.** The satellite templates carry the tenant's R2
  credential in their env, and the plane stored only the token id -- the S3 secret is the SHA-256 of
  a value deliberately never kept. There is no path by which the old credential reaches new
  templates, so the mint is part of the repair and the studio secrets are re-stated in the same pass.
- **`convergeTenantTemplateImages` (new, `src/runpod.ts`): adopt-by-name kept a STALE IMAGE.**
  `createTenantEndpoints` adopts a template by name and rewrites its `env`, never its `imageName`.
  Invisible on a fresh provision; on a long-lived tenant it is cp#126 rot -- the testbed's templates
  were still on backend 1.0.2 / upscale 0.2.7 / musetalk 0.1.0 / audio-upscale 0.1.0 against pins of
  1.0.11 / 1.0.4 / 1.0.5 / 1.0.7. The new call moves them and READS BACK what RunPod holds; a pin
  that did not move throws. Scoped to the rebuild path, not to the shared customer provision path.
- **Every message leaving the module is scrubbed** (`redactSecrets`) before it reaches a caller, an
  audit row, or a log line: RunPod error text is passed through verbatim by design, and an upstream
  is quite capable of quoting the request back at us.


### fix(provisioner): honest leases at both ends -- yield hand-back, upgrade heartbeat, no claim before the first driver (cp#158, cp#132)

- **The yield left a lease nobody was holding (cp#158).** A driver that yields is out of invocation
  budget with work left, and its last `mark()` had just re-armed `lease_until` for a full 60s, so the
  job was un-drivable for up to a minute in which nothing was driving it. `releaseJobLease` lets the
  driver that knows it is leaving clear its own lease, and the next poll claims immediately. It
  leaves `updated_at` alone (a yield is not progress) and refuses a terminal job, exactly as the
  cp#148 heartbeat does. The heartbeat is stopped BEFORE the release, or a queued beat re-arms what
  was just cleared.
- **The studio-upgrade driver now heartbeats too (cp#158).** It marked only at step boundaries and
  its steps are unbounded remote work (a migration set, an asset upload session, the script PUT), so
  a slow leg made a live upgrade read as driverless. Nothing poll-driven claims that job kind, so no
  job is stolen; what breaks is the ONE-WRITER guard, since the route refuses a second upgrade on
  `jobHasLiveDriver`. A lapsed lease there admits a second driver PUTting different bytes into the
  same LIVE studio script. It takes the same exported `startLeaseHeartbeat`, not a second copy.
- **A poll may not claim a job no driver has taken yet (cp#132, the server half of cp#124).** Every
  job is INSERTed `queued` with a NULL lease and its driver is dispatched under `waitUntil` in the
  same request; the cp#148 heartbeat cannot cover that window because it opens before the first beat.
  An early poller -- a second tab, a script, an operator rehearsal -- won `claimJob` outright and ran
  `continueProvisionJob`, whose pre-`wfp_upload` refusal writes `finishJob(failed)` +
  `setTenantStatus(failed)` + a rollback that DELETES the D1, bucket and token the real driver is
  still creating. The claim also made the driver own `setJobRunning` miss its predicate, so the row
  never recorded that a driver arrived. `driveJobIfNeeded` now declines a `queued` job: report it,
  drive nothing, write nothing. A `running` job with a lapsed lease is still claimed, because since
  cp#148 that state honestly means the driver is gone.
- **The cost, named:** a job whose driver never arrives is now ended by the existing 10-minute
  lost-driver rule rather than by a poll racing it. A slow honest refusal costs a wait; a fast wrong
  one costs a customer their half-built studio.
- Docs: `docs/control-plane.md` (the provision job lease section carries all three).

## v1.12.0 -- 2026-07-26

MINOR: the operator action that was missing under cp#136 -- a studio could be TOLD the video-finish tier is unreachable, but no writer in this plane could make one tier-absent, so the state could not be displayed on a live tenant. Carries NO schema change; migration 0011 shipped with v1.11.0.

### feat(hosted): detach and reattach the video-finish tier binding (cp#136, criterion 3)

- **The gap, found by running the drill rather than by reading the code.** cp#136 made the
  `unprovisionable` state writable, but no studio could DISPLAY it: every binding writer in this
  plane either attaches the tier or preserves it (provision attaches when the service id is set,
  `refresh-studio-bindings` always appends, the studio upgrade inherits). A tenant that HAS the tier
  could never be returned to the tier-absent state the sentence describes, so the acceptance
  criterion (a human READS it on a live studio) had no honest path. The testbed proved it: the mark
  refused with `studio_reader_absent` because the studio serves `{}`, tier bound and observed
  available, correctly.
- **`POST /api/admin/tenants/:id/video-finish-binding`** with `{"attached": false|true}`,
  admin-gated, inline, one tenant per call. No bytes, no release, no status write.
- **Not a hand patch, and that is the whole point.** A settings PATCH omitting a binding DROPS it,
  which is the failure the attach path exists to prevent, so the detach runs through the SAME
  census-then-inherit-everything machinery with the same readback through the other credential. The
  only difference from attach is which single binding is left out.
- **Attach IS the cp#112 call**, not a second implementation, which makes "reattach restores exactly
  what a refresh produces" true by identity rather than by imitation.
- **Detach deliberately requires no `VIDEO_FINISH_VPC_SERVICE_ID`:** it names no service id, so a
  plane that has lost its tier configuration can still take the tier off a tenant. That is the
  direction you want to move in when something is wrong.
- **One truth at a time.** Both directions refuse `video_finish_declared` (409) while a cp#136
  declaration stands. The ATTACH guard is the load-bearing one (attaching would make the record false
  the moment it succeeded, and the panel would never surface it because an observation beats a
  label), and it lives in the SHARED preflight so `refresh-studio-bindings` inherits it too. The
  detach guard is symmetry rather than rescue: the reader floor already makes declaring a bound
  studio impossible.
- Tests: the discriminating one asserts a sent payload that omits exactly one binding and carries
  every other, which no pre-existing writer in this plane could produce; plus the custody claim on
  this path, convergence on an already-absent tier, a short-readback failure, the var re-derived
  rather than inherited, and both guards with positive controls. Two test bugs were caught by the
  fakes themselves (the shared census helper defaults to the ATTACH outcome; the memory store
  enforces the real UNIQUE(slug) constraint), which is the stubs doing their job.
- Docs: `docs/control-plane.md`, "Taking the tier OFF a studio (cp#136, criterion 3)".

## v1.11.0 -- 2026-07-26

MINOR: three operator capabilities that were each missing a half -- a record that could not be compared to reality (cp#137), a lease that expired under a driver still working (cp#148), and a panel state nothing could write (cp#136). Carries a schema change: migration 0011, additive.

### feat(hosted): reconcile a tenant record against live RunPod state, read-only (cp#137)

- **The defect:** the plane records tenant endpoints in `tenants.endpoints_json` and nothing ever
  compared that record to RunPod. The standing testbed read `status=live` while all four endpoints it
  names returned 404. `status` means "provisioning completed once", never "renders today".
- **`POST /api/admin/reconcile/runpod`**, admin-gated, DETECTION ONLY. It writes nothing, not even an
  audit row: a pass that can alter what it measures is not a measurement. Remediation is separate,
  lead-approved work.
- **The operator brings the RunPod half**, gathered with their own key via
  `scripts/reconcile-runpod.mjs`. The plane holds no credential that can read the RunPod account of a
  tenant (key A used once and never stored, key B invoke-only), so it cannot poll RunPod and a
  background reconciler is not buildable without breaking that custody boundary on purpose.
- **Both debris layers, always.** Deleting an endpoint does not delete the template underneath it
  (cp#117), so records are compared against the endpoint list AND the template list; an
  endpoint-only sweep removes half the debris while reading as complete.
- **An unprovable check never reads as a clean one.** The snapshot must state `complete` explicitly,
  the plane marks its own census incomplete on a full `listTenants` page, and any finding resting on
  a census that was not proven whole is reported `unproven` rather than asserted.

### fix(provisioner): the job lease means A DRIVER IS ALIVE, not A STEP BOUNDARY HAPPENED RECENTLY (cp#148)

- **The defect:** `provision_jobs.lease_until` was written only by `setJobRunning` and by each step
  `mark()`, so ANY unmarked stretch longer than the 60s lease expired it under a healthy driver. Two
  stretches are long enough in practice: `runpod_endpoints` (one uninterrupted call, four endpoints)
  and the stretch from that mark to `wfp_upload` (studio assets plus the worker script). A poll then
  won the now-free claim and ran `continueProvisionJob`, which refuses anything short of
  `wfp_upload`, and that refusal wrote `finishJob(failed)` plus `setTenantStatus(failed)` plus a
  destructive rollback. The invocation never "ended at `runpod_endpoints`"; the job was taken from a
  driver that was still working.
- **Confirmed against prod D1**, not just against the constants: the cp#117 rehearsal job
  (`job_1cc93d7e8d7cf62a78d79441`) has `steps_done` running THROUGH `runpod_endpoints` with
  `error_step` = `wfp_upload`, which is `inferStep` over those five steps. So the driver survived the
  ~87s RunPod call and recorded it, and the poll that killed the job arrived during the STUDIO UPLOAD
  that followed. The fatal window was the second long stretch, which is why the fix is a general
  heartbeat rather than anything specific to `runpod_endpoints`.
- **The fix:** a live driver heartbeats its own lease every 20s for as long as its invocation lives
  (`renewJobLease`), so an expired lease means a dead driver and nothing else. The `wfp_upload`
  boundary is now reachable at ANY prefix duration instead of only a fast one.
- The heartbeat renews `lease_until` and NOT `updated_at`: liveness and progress are different facts,
  and bumping both would make a live-but-wedged driver immortal against the lost-driver rule.
- `updateJobProgress` and `renewJobLease` now both refuse a TERMINAL job. A driver that lost its job
  runs on to the end of its invocation, and its late mark used to overwrite the terminal step and
  re-arm the lease on a failed row.
- Repaired for free, same column: `claimReclaim`, `beginTeardown` and `jobHasLiveDriver` were reading
  that lease to refuse acting under a live provision driver, and during a slow `runpod_endpoints` a
  reclaim could have blanked the tenant resource columns underneath it.
- The first-poll constant is deliberately NOT touched: a later poll changes discovery time, not
  outcome, and an earlier one would have made the old race MORE likely.
- Docs: `docs/control-plane.md`, "The provision job lease, and why a driver heartbeats it".
### feat(hosted): the plane WRITES the finish-tier state the panel reads (cp#136)

- **The gap:** `vivijure-cf` resolves three states for the video-finish tier and reads the third off
  the studio var `VIDEO_FINISH_TIER_STATE`. Nothing in this plane ever wrote it, so
  `unprovisionable` could not occur in production and the sentence written for it (cf#243) shipped
  into a state no studio could enter. This is the writer, and it unblocks `vivijure-cf` PR #244.
- **It is a DECLARATION, not a derivation, and that was the decision the issue asked for.** No
  plane-side condition computes unreachability: with `VIDEO_FINISH_VPC_SERVICE_ID` set the studio
  resolves `available` by observation, and with it unset an operator can still reach the studio
  through `refresh-studio-bindings`, so every derived writer writes `provisionable` forever. The
  tempting nearby wiring is worse: the tier being DOWN is transient and the panel sentence ("cannot
  be turned on for it") is permanent, so an outage-driven writer would tell every tenant the tier can
  never be turned on and keep saying it afterwards.
- **One writer, one source of truth.** `tenants.video_finish_unreachable` (migration 0011, with its
  mandatory reason and timestamp) is the record; the studio var is a PROJECTION re-derived at every
  write to the studio: the provision upload, the studio-upgrade re-upload, and the new route.
  Re-derived rather than carried, because `inherit` PRESERVES a var: without this a cleared
  declaration would survive the next bytes move and keep displaying a sentence the plane no longer
  believes. Omitting a non-secret binding DROPS it, so omission is how a clear reaches the studio.
- **What clears it, stated because a label that cannot be removed becomes a lie:** the route
  explicitly, and the binding arriving implicitly (the panel lets a bound tier beat any var).
- **`POST /api/admin/tenants/:id/video-finish-tier-state`**, admin-gated, inline (the answer IS the
  evidence), one tenant per call. Changes no bytes, no release, no status; the tenant keeps serving.
  A reason is mandatory to declare and meaningless to clear.
- **THE READER FLOOR IS A REFUSAL.** Setting the var on a studio whose bundle predates the reader
  (`vivijure-cf` `ba61789`, first tagged v1.9.0) is a silent no-op, which is the cf#98 / cf#118 /
  cp#112 failure family. The route asks the STUDIO what it serves and refuses unless
  `capability:video-finish` is present in `host.hooks_unavailable`; a served field is the tenant
  assertion about itself, where a release number is only our claim about it. The floor gates
  DECLARING only: un-saying something is always allowed.
- **The readback carries the reader half:** `served_reason_before` / `served_reason_after` /
  `served_reason_changed`, verbatim and never compared against a local copy of the panel copy. The
  plane can prove it bound a var; only the studio can prove the panel projection changed. A readback
  that disagrees with the intent answers 409, not 200.
- Tests: the discriminating one asserts what was PASSED to the write call (recording proxy) and was
  watched FAILING against the never-written behaviour, with a positive control proving the proxy
  records; the reader-floor refusal was watched failing with a positive control that the same path
  accepts a reader-capable studio; the upgrade drop-guard covers both directions and was watched
  failing without the reconcile; plus a real-SQLite round trip over migration 0011.
- **Not done, and tracked rather than implied:** no live studio is in the state yet, and cp#136
  stays open for that leg. The bundle half of the precondition is already met (the live tenant is at
  v1.9.0 since cf#248), so what remains is a studio with the tier UNBOUND plus the sentence read by a
  human. A studio that HAS the binding cannot display the sentence by construction, because the panel
  lets an observation beat a label, and this route refuses to declare on one rather than writing an
  inert var.
- Docs: `docs/control-plane.md`, "Declaring a studio UNREACHABLE for the video-finish tier".

## v1.10.0 -- 2026-07-26

MINOR: the studio bytes-move capability (cp#139) -- the operation that was missing between `refresh-studio-bindings` (bindings, never bytes) and `upgrade-modules` (module bytes, never the studio).

### feat(hosted): `studio_upgrade` -- move a LIVE tenant onto a newer studio release (cp#139)

- **The gap:** no operation in this plane moved a live tenant's studio bytes. `runProvisionJob`
  uploads once at creation, `continueProvisionJob` refuses anything short of `wfp_upload`,
  `upgradeTenantModules` deliberately never touches the studio, `refreshStudioBindings` (cp#112)
  changes bindings and explicitly not bytes, and teardown deletes. A tenant could therefore be handed
  the BINDING for a feature and never the CODE that projects it.
- **The custody objection was measured away, not argued away.** cp#112 refused a re-upload because a
  live studio carries secrets the plane cannot reproduce. Probes settled three facts: `inherit` works
  on the UPLOAD endpoint (new bytes land, `secret_text` survives, the caller never holds the value); a
  non-secret binding OMITTED from an upload is DROPPED while a `secret_text` one survives; and new
  assets coexist with `inherit` bindings on the same PUT. Hence census-then-inherit-everything, which
  is correctness rather than caution.
- **`POST /api/admin/tenants/:id/upgrade-studio`**, admin-gated, one tenant per call, explicit
  required release with NO default to the plane pin (the same refusal the module upgrade makes, for
  the same reason). New `studio_upgrade` job kind on the existing release-pair columns.
- **Migrations run BEFORE the bytes**, tracked per-migration and idempotent. Not theoretical: the
  v1.6.0 -> v1.8.0 move adds `0012_wan_lora_keys.sql`, so bytes-without-schema would have been a
  defect on the first real upgrade.
- **NEVER writes `tenants.status`,** on any path. A live tenant stays live and keeps serving; progress
  and failure live on the job row. `studio_release` is CLEARED before the first write and set only on
  full success, so a partial move cannot leave a tag standing that claims it finished.
- **The result is a readback, not a success flag:** bindings/secrets before and after, anything
  missing, the required-vars re-check, the sha256 of the bytes shipped, and the served `/api/modules`
  host keys before and after. A short readback FAILS the job even though every call returned 200.
- In place only, no automatic rollback (rollback is a re-run at `from_release`), and a same-release
  convergence run is allowed and honestly reports `served_shape_changed: false`.
- Docs: `docs/control-plane.md`, "Moving a LIVE tenant onto a newer STUDIO release".

## v1.9.0 -- 2026-07-25

MINOR: the KEK rotation capability (cp#95), and the studio release pin advanced off a release that
predates the hooks channel (cf#243 Lane S).

### feat(hosted): KEK rotation capability with a dual-read window (cp#95)

- **The gap:** `tenants.studio_token_enc` is the only customer credential this plane stores as a
  usable value, and the key protecting it could not be changed at all. Rotation was an incident
  rather than maintenance, a lost key had no migration path, and the absence distorted a real
  decision during the 2026-07-25 recovery: re-key looked expensive because the capability did not
  exist.
- **A two-key RING.** Reads try BOTH installed keys, always, so a row opens whether it was written
  before, during, or after a rotation and dispatcher-injected auth keeps serving through the window.
  Writes use exactly ONE key, named by `STUDIO_TOKEN_KEK_ENCRYPT_SLOT`.
- **The write slot is config, not runtime state**, for two load-bearing reasons: the sweep and the
  live provision path must write under the same key or the sweep is outrun by provisions forever;
  and flipping the write direction of every stored customer credential should be a reviewable deploy
  rather than a toggle. A slot naming `next` with no next key installed REFUSES to encrypt; it never
  falls back to the primary, because that would write live credentials under a key the operator
  believes is retired.
- **Two admin routes:** `GET /api/admin/kek/status` (census) and `POST /api/admin/kek/reencrypt`
  (sweep; idempotent, resumable, compare-and-set so a mid-sweep re-mint wins and is reported as
  `raced`). The sweep answers 200 only when a FRESH census says the outgoing key can be dropped.
- **The census is three buckets** because AES-GCM cannot distinguish a wrong key from a corrupt one:
  `on_target` / `needs_rotation` / `unreadable`, and an unreadable row holds `safe_to_promote` false
  rather than being retried forever as if it were work.
- **Operationally inert on this deploy.** With no `STUDIO_TOKEN_KEK_NEXT` installed the ring is a
  ring of one and the write slot is `primary`, which is byte-for-byte the previous behaviour.
  Nothing rotates until an operator starts a rotation.
- Escrow companion shipped in `crew-secrets` (#222): escrow the new key BEFORE installing it.
  Procedure: `docs/deploy.md`, "Rotating `STUDIO_TOKEN_KEK`".

### chore(hosted): STUDIO_RELEASE advanced v1.6.0 -> v1.9.0

- **The defect this closes:** the plane shipped studio **v1.6.0** to every tenant it provisioned.
  The hooks channel (`hooks_unavailable`) first appears in vivijure-cf **v1.8.0**, so every tenant
  was born unable to report which hooks it cannot serve, permanently, and no copy change could
  reach them. Found during the cf#243 live-tenant parity work: the one live tenant carries the
  `VIDEO_FINISH_VPC` binding but emits no hooks channel at all.
- **Why it mattered beyond one tenant:** with signups closed the estate is a single testbed, so this
  read as a per-tenant curiosity. It is not. Every FUTURE tenant would have arrived the same way,
  which breaks the three-population reach model at the source rather than at the edges.
- The target bundle was read back from the `vivijure-studio-releases` mirror before the pin moved
  (worker.js 530770 bytes, manifest, 48 assets, 6 modules including `finish-rife`, which v1.6.0
  lacks entirely). A pin pointing at an absent or partial bundle fails every future provision at
  `wfp_upload`, so the read-back is a prerequisite and not a formality.
- **NOTE, two version lines:** this is control-plane v1.9.0 pinning vivijure-cf v1.9.0. The
  coincidence is not a relationship; the repos version independently and the numbers will diverge
  again.

### feat(abuse): a public report-abuse page on the hosted front door (cp#130)

- **The gap:** enforcement here is report-driven by ruling, so intake is the ENTIRE detection
  surface -- and it had no placement a stranger could reach. It lived in
  `docs/legal/hosted/REPORT-ABUSE.md` (a file in a repo) and in the AUP served behind the signup
  gate. The person most likely to report is someone who came across a hosted render and has no
  account; they can read neither.
- `/report-abuse.html` on the front door, unauthenticated by construction (only `/api/*` is gated;
  pages fall through to `ASSETS`), plus a persistent footer link on both front-door pages.
- **Deliberately static:** no script tag, no form, no analytics, no third-party asset. A reporter
  should not have to run our JavaScript, or be counted, to tell us something is wrong.
- **The only outbound links are the NCMEC CyberTipline (`report.cybertip.org`) and INHOPE
  (`www.inhope.org`)**, asserted as the complete external set.
- **Promises ordering, not latency** (Ernst's cp#115-consistent wording): the page commits to what
  happens and in what order, not to a response time we have no staffed clock behind.
- **Ships with this worker deploy** because its `public/` assets ride the bundle. Documented here
  rather than left to be discovered after the tag.

### docs

- `docs/legal/hosted/PRESERVATION-PATH.md` acceptance criterion 7 quote closed (cp#117).
- Abuse intake latency promise corrected (cp#130).
- Served-surface census done by enumeration rather than by grep (cp#130).

## v1.8.1 -- 2026-07-25

PATCH: the tenant satellite pins and the mechanism that keeps them honest (cp#126), plus the
onboarding poll-boundary fix (cp#124) -- its `public/` assets ship with this worker deploy, so
it is documented here rather than left under Unreleased while the tag deploys it.

### fix(hosted): tenant satellite pins have ONE source of truth (cp#126)

- **The defect:** the provisioner pinned backend 1.0.2 / upscale 0.2.7 / musetalk 0.1.0 /
  audio-upscale 0.1.0 while production rendered on 1.0.11 / 1.0.4 / 1.0.5 / 1.0.7, so every hosted
  tenant was provisioned onto images several release lines behind anything the estate verifies.
  Nobody was careless: "pin BOTH panels on a release" never grew a third leg for the plane, and
  there was no place a wrong pin could be SEEN. Found live during the vivijure-cf#240 verify render.
- **The pins now mirror production, not the newest tag.** All four move to what the production
  endpoints actually run (read off `t9wcvlxh8rc5la`, `4q8idwbk6tyqbq`, `zw6pt4lymf69pk`,
  `sj0btgpjdtswa7` on 2026-07-25), and each pin records the endpoint it mirrors and the date it was
  read. Deliberately NOT the newest published tags: production had not adopted them, and musetalk
  1.0.6 carries an HTTP serve path production has never run. A paying tenant is not where that gets
  discovered.
- `src/satellite-pins.ts` is the one place a version lives; `src/runpod.ts` decides layout, labels,
  GPU class and worker counts, and a test keeps image literals out of it.
- **Drift is loud now.** `npm run check:pins` (creds-free GHCR resolution by image name) runs in CI
  on every PR, so a pin at a tag nobody pushed cannot merge. `npm run check:pins:prod` compares the
  pins to the live production endpoints and is the third leg of a satellite release. Exit 2 (check
  could not be performed) is never treated as a pass.
- Docs: the release rule, and what a pin change does NOT reach -- a live tenant keeps the pins it
  was provisioned with, because the plane holds no key that could repin it (KEY A is used once and
  never stored). Plus the cycle-the-workers requirement after any repin.

No behavior change for existing tenants; this changes what a NEW tenant is provisioned onto.

### fix(onboarding): the build screen waits out the provision poll boundary (cp#124)

- **The defect:** the page started polling the job immediately after `POST /api/tenant/provision`.
  A poll before the plane records `wfp_upload` cannot drive the provision (the RunPod setup key is
  never stored, so the keyless continuation refuses by design, cp#18); the only thing it can do is
  win the job lease and write that refusal, which marks a HEALTHY in-flight provision `failed` and
  rolls the half-built tenant back, leaving a customer to reclaim out of it. Seen live on
  2026-07-25 (vivijure-cf#240): attempt 1 polled immediately and declared the failure, attempt 2
  waited about 90 seconds past the boundary and completed 9/9.
- **The fix, in two halves.** The first poll waits `PROVISION_FIRST_POLL_MS` (90s, the cadence
  proven live) behind a counting-down wait row that says why the screen is quiet; the wait is the
  page own clock and is labelled as such, never a claim that a step is done. After that the cadence
  comes from the JOB, not from a timer: slow (15s) while `steps_done` has not recorded the boundary
  step, fast (2.5s) once the poll genuinely is the engine. A clock says what we hoped happened,
  `steps_done` says what did.
- **Also fixed, same screen:** the build rows matched on `d1`, `r2`, `runpod`, `studio`, `verify`,
  and a real job reports `d1_create, d1_migrate, r2_bucket, r2_token, runpod_endpoints, wfp_upload,
  modules_upload, modules_install, verify`. Only the last one ever matched, so a live provision
  rendered as five untouched rows and then a tick. Rows now map onto the real step names, and the
  test pins that set against `PROVISION_STEPS` imported from `src/provisioner.ts`, so a renamed or
  added step fails CI instead of quietly rendering as a row that never lights up. The preview mock
  reported the same invented vocabulary and now carries the real payload shape.
- **A failure the screen cannot place is no longer dropped:** an error on a PRECONDITION step
  (`bundle_fetch`, which is exactly what a bad release pin produces) gets its own row.
- Server-side behaviour is UNCHANGED: this is the client half. The plane can still be walked into
  the same refusal by any other caller that polls early (recorded on cp#124).

## v1.8.0 -- 2026-07-25

MINOR: two feature-class changes (cp#112, cp#118).

### feat(hosted): an operator can give an EXISTING tenant a studio binding (cp#112)

- `POST /api/admin/tenants/:id/refresh-studio-bindings`: admin-gated, per-tenant, inline, and
  idempotent by convergence. Closes the gap where cf#118 could reach only tenants provisioned after
  the knob was set, because the studio upload happens in exactly one place (`runProvisionJob`).
- **Bindings only, on purpose.** It sends a settings PATCH carrying `{ "type": "inherit", "name" }`
  for everything it keeps, so it handles no binding VALUE at all. A re-upload cannot: two of a
  tenant studio four secrets (`R2_S3_SECRET_ACCESS_KEY`, `RUNPOD_API_KEY`) are unreproducible by
  this plane by design, and restating the binding set without them would stop the tenant rendering.
  Studio bytes, `studio_release` and `tenants.status` are untouched; a live tenant serves throughout.
- **Refuses before it writes:** `not_provisioned`, `video_finish_unconfigured` (cp#109 honest
  refusal), `job_in_progress` (no racing a provision that owns the binding set), and a named
  `vpc_binding_unauthorized` that points at `CF_WORKER_UPLOAD_TOKEN` rather than at the tenant.
- **Answers with a READBACK, not a success flag,** taken through a different credential than the one
  that wrote; a binding or secret missing afterwards answers 409 with the names.
- **The CF contract is measured, and measuring it caught a defect.** Live probe against a throwaway
  script: the endpoint takes multipart (a JSON body is refused `10001`), so the first implementation
  would have failed on every call; `inherit` does preserve a `secret_text` binding; and a binding
  omitted from the patch is DROPPED, which is undocumented and is why the full desired set is sent
  every time. The wire shape now has its own regression test.
### feat(abuse): interlock teardown against an open preservation hold (#118)

- **New `preservation_holds` table (migration 0010) + three admin routes**, and teardown refuses the
  whole pass while any hold on the tenant is open. Before this, nothing in the code stopped an
  irreversible teardown of a tenant under an open abuse report; the control was an operator
  remembering ABUSE-RESPONSE-RUNBOOK.md Section 5.2. Suspend stays the lever for an open incident.
- **A table, not a column, because two statutory clocks can run at once on one tenant:**
  `ncmec_2258a_h` (1 year, 18 U.S.C. 2258A(h)(1) as amended by Pub. L. 118-59) and `le_2703_f`
  (90 days, renewable, 2703(f)); 2258A(h)(4) says they do not limit each other. `internal` covers a
  report that has not started either clock.
- **An elapsed clock does NOT release a hold.** The interlock keys on `released_at IS NULL` alone:
  `expires_at` is the floor of the duty (2258A(h)(5) permits longer, 2258B(c) puts destruction on a
  law-enforcement request). Releasing is an explicit, single-use, audited human act with a mandatory
  reason.
- The refusal uses the referential-guard vocabulary, so the teardown route reports it under
  `refused` rather than `failed` -- the interlock working, with nothing to retry. If the store
  cannot answer whether a hold is open, teardown fails closed.

## v1.7.1 -- 2026-07-25

PATCH: fix/deploy class, no feature surface.

### fix(teardown): a 404 worker delete is success-equivalent, so the column blanks (#110)

- A delete that answers *not found* reached its goal earlier, by something else. Teardown now blanks
  that column exactly as it would on a delete it performed, so the row can reach provably-reaped and
  a re-run can clear a stale entry. Previously the two already-gone rows a guarded sweep met kept a
  `teardown_failures` entry no re-run could ever clear, over a worker that does not exist.
- **Narrow by construction:** the classifier requires HTTP 404 **and** CF code 10007 together, and
  that shape was live-probed against both dispatch namespaces rather than read off a docs page. A
  403, a 500, or a 404 with no code stays a failure (a missing namespace is a config fault, not an
  absent script). CF prose is never matched.
- **Recorded, not swallowed:** a new `absent` list on the teardown outcome, surfaced in the
  `POST /api/admin/tenants/{id}/teardown` body and in the admin-action audit row, plus
  `teardown.worker_absent` / `teardown.module_absent` log lines. `reaped` is still read back off the
  row and cannot carry the distinction, which is why absence is reported beside it.
- Same treatment on the module-script sweep, where it is a list-then-delete race rather than the
  common case; the census remains the witness that nothing is left resident.

## v1.7.0 -- 2026-07-25

MINOR: the cf#118 tenant-side binding (#109) is feature-class.

### feat(hosted): tenant studios carry the video-finish binding (vivijure-cf#118)

- `VIDEO_FINISH_VPC_SERVICE_ID` set -> every tenant studio is provisioned with the `vpc_service`
  binding, so assemble and mux work for tenants instead of degrading to per-shot clips. Unset ->
  no binding and the honest degrade, exactly as before.
- **Second credential, by constraint not preference:** `CF_WORKER_UPLOAD_TOKEN` owns tenant script
  upload (the call that attaches bindings), because CF will not let an API-created token mint one
  carrying Connectivity Directory scope. Optional; absent it falls back to the provisioner
  credential and nothing changes. The asset-upload session runs on the same credential as the
  script PUT that redeems its JWT.
- **Refuses honestly:** a configured tier that cannot be attached FAILS the provision at
  `wfp_upload` with a message naming the plane's credential. It never drops the binding and
  continues -- that would ship a tenant silently missing a tier the operator configured.
- Isolation on the shared tier documented as what it is: the container never receives a credential
  (per-object presigned URLs), so it is by construction, not by policy.

## v1.6.0 -- 2026-07-25

MINOR: the teardown production caller (#103) is feature-class. Entry moved OUT of the
v1.5.0 section it was mistakenly filed under -- the v1.5.0 tag predates the #103 merge, and a
changelog claiming a feature its tag does not contain is the trap this cut corrects.

### feat(teardown): the production caller, and empty-then-delete wired in (#23, cf#72)

- `POST /api/admin/tenants/{id}/teardown` -- admin-gated, audited, runs INLINE because the response
  IS the evidence: `reaped` (read back off the row, not from the return value), `refused` (the
  referential guard working) and `failed` (calls to retry) are three separate lists.
- `confirm_slug` required; `delete_data` defaults to FALSE (worker + module scripts + credential go,
  the data stays). `deleted` is written ONLY on a clean pass that was allowed to take the data, so
  the status keeps meaning "provably reaped".
- `beginTeardown` / `finishTeardown`: ONE destructive lease per row, shared with the reclaim path
  (overlapping teardowns issue the SAME slug-derived deletes). A tombstone being re-swept stays a
  tombstone; `deleted_at` is preserved, never rewritten.
- Teardown now EMPTIES a tenant bucket before deleting it: it mints its own bucket-scoped credential
  and revokes it before returning on every path, and the referential guard runs BEFORE the mint --
  emptying is the irreversible half, so a bucket another row references is never opened at all.
  A bucket too large for one budget reports an honest re-run-to-continue instead of failing.
- `ProvisionDeps` gains `now` / `sleep` / `fetch` (the emptying loop is budgeted); production wires
  the real three in `productionDeps`, unit tests script S3 and THROW on any other fetch.

## v1.5.0 -- 2026-07-25

### feat(hosted): tenant programmatic API token endpoints (vivijure-cf#94)

- `GET/POST/DELETE /api/tenant/{id}/api-token`. Separate credential from the dispatcher-injected
  `STUDIO_API_TOKEN` (ruled): revoking it can never sign the owner out of their browser session.
- **The plane stores no part of it.** The token is a row in the TENANT's studio DB holding only a
  SHA-256 hash, so reveal-once is true by construction. `GET` therefore carries no masked `display`
  field -- masking implies keeping a copy.
- Refuses `not_provisioned` when the studio has no `STUDIO_API_TOKEN`, because the studio's gate 403s
  before consulting named tokens and the minted credential would fail on arrival.
- `CfApi.queryD1` gains real parameter binding; migration 0009 adds `tenants.api_token_rotated_at`.
- Contract + the custody pin documented in `docs/control-plane.md`.


### feat(r2): bounded empty-then-delete cycle (vivijure-cf#72)

- `src/r2-empty.ts`: ListObjectsV2 + batched DeleteObjects over the S3 API, so a tenant bucket that
  has been rendered into can finally be removed. R2 refuses to delete a non-empty bucket and its REST
  API has no object list/delete at all, which is why de-provision could not complete.
- **Invariant, stated in the file: MINT -> WORK -> REVOKE -> YIELD.** Each cycle mints its own
  credential, does bounded work, and revokes before returning. No credential outlives its invocation
  and none is persisted; a large bucket empties across N cycles instead of failing terminally.
- `emptied` is only ever claimed from an **observed empty listing**, never inferred from "we deleted
  everything we saw".
- Live-proven against real R2, including the positive control that the old `deleteR2Bucket` still
  fails on a non-empty bucket, so the fix cannot pass for the boring reason.


### feat(r2): SigV4 header signing, proven against the official AWS vectors (cf#72)

- `src/sigv4.ts`: AWS Signature Version 4 header-based signing (arbitrary method, headers, body), the
  capability the R2 empty-then-delete leg needs. The existing presign helper is query-based, GET/PUT
  only, and test-side by contract, so it could not sign a ListObjectsV2 or a DeleteObjects POST.
- **S3 flavour stated explicitly:** the canonical URI is used AS GIVEN, no path normalization, because
  S3 is the documented exception and an object key legitimately contains `.`/`..`/`//`. The suite's
  `normalize-path` cases are deliberately NOT vendored: they encode non-S3 behaviour and passing them
  would mean the signer was wrong for its only caller.
- Proven against the **official AWS SigV4 conformance vectors**, vendored byte-for-byte from a pinned
  `boto/botocore` commit with AWS's LICENSE and NOTICE. All three stages asserted (canonical request,
  string to sign, Authorization) so a failure names the stage that diverged.


### fix(teardown): referential guard, column blanking, and a recorded outcome (#23)

- **Referential guard, fail-closed.** `teardownTenant` now asks whether any OTHER tenant row still
  references a resource before reaping it, and refuses (recording who, and whether they are live) if
  one does. A census of the live plane found ONE D1 referenced by NINE tenant rows -- eight
  tombstones and the live tenant -- because resource names derive from the SLUG and freeing a slug
  RENAMES the old row. Tearing down any tombstone would have deleted the live tenant's database,
  bucket and worker. If the guard cannot run, nothing is deleted.
- **Columns blank only on that resource's successful deletion**, so a row can no longer read as
  reaped while a customer's bucket is still there.
- **The outcome is recorded** (`teardown_at`, `teardown_failures`, migration 0008), keeping
  "attempted and clean" distinguishable from "never attempted".
- `docs/control-plane.md` documents slug-reuse-is-resource-reuse as a structural fact, including why
  the reclaim path is NOT exposed to it (`TIER_A_STATUSES` excludes `deleted`).


### test(reclaim): the reclaim SEQUENCE runs against real infrastructure (#38)

- `claimReclaim -> teardown -> reclaimSlug` now runs as ONE pass with a real store (real migration
  ledger) on one side and real Cloudflare resources on the other. Both halves were separately
  live-proven; the join between them had never run.
- Covers what was mock-only: the ordering, the exclusivity write refusing a second claim under a
  live lease, the lease-token check refusing a blank without it, the row actually blanking, and a
  follow-on provision job starting on the reclaimed row.
- The node:sqlite D1 shim + migrated-db helper move to `tests/sqlite-d1.ts` so the sequence
  rehearsal drives the SAME store harness as the store-half proofs rather than a second one.


### fix(test): live provision e2e drives the step machine the way production does (#4)

- The suite generates its own **ephemeral KEK**; `STUDIO_TOKEN_KEK` is off the required-env list.
  It round-trips in-process over a `MemoryStore` tenant, so the live worker KEK was never needed and
  admitting it would only widen that credential's custody into CI. This was #4's recorded blocker
  and it was a premise error.
- The suite now **resumes on a budget yield** (`runProvisionJob` -> `continueProvisionJob`), matching
  the `deps.ts` start/resume wiring the tenant job poll drives. A real provision yields after
  `wfp_upload` at ~23s under the 15s invocation budget, so the previous single-invocation assertion
  could never pass against real infrastructure.
- `docs/deploy.md` records the KEK recovery search as **exhausted** and the value as unrecoverable
  (worker secrets are write-only), plus the escrow gap and the re-key cost that follow from it.
- **Dispatch door for the suite.** There is no out-of-worker HTTP path into a WfP dispatch namespace
  (`*.workers.dev` TLS covers one label; WfP user Workers are not published there at all), so the
  suite deploys an ephemeral `e2e-harness-dispatcher-<run>` in `beforeAll` and deletes it in
  `afterAll`, verified from the account. It carries a per-run bearer AND a tenant scope baked into
  the deployed artifact, because both namespaces are shared with production tenants. A leftover
  harness fails the run loudly.
- The e2e tenant **id** now carries the run token. Module script names derive from the tenant id, so
  the old fixed `ten_e2e` put every run's module workers at identical names inside a shared
  namespace, and `ten-e2e` could collide with a real hex tenant id beginning `ten_e2e...`.


### fix(hosted): module-upgrade jobs claim a lease and self-heal (#44)

- `setJobRunning` runs synchronously on accept and again at upgrade entry, matching provision.
- The upgrade-route 409 guard keys off a **live lease**, not bare `queued`/`running` status, so a
  dead driver no longer wedges every future upgrade for that tenant.
- `jobHasLiveDriver` exported from `store.ts` (same expired-or-absent lease reads as free).

## v1.4.3 -- 2026-07-23

PATCH. K3 stale-job clock fix (#79).

- **fix(security):** use `deps.now()` for stale-job detection instead of `Date.now()` (K3 verify)

## v1.4.2 -- 2026-07-22

PATCH. SSO redirect harden + audit CI.

- **fix(security):** reject SSO `redirect_to` backslash / protocol-relative open redirect (#76)
- **docs:** clarify studio PIN is studio-only; module bundles are self-anchored (cf#147)
- **ci:** adversarial security audit workflow

## v1.4.1 -- 2026-07-22

PATCH. Provisioner rollback on failed provision (cf#91).

### fix(provisioner) -- auto-teardown on failed provision (cf#91)

- Failed provisions auto-unwind created resources (re-fetch tenant row, then `teardownTenant`).
- R2 token revoke falls back to deterministic name (`vivijure-tenant-<slug>-r2`) via a
  result_info-checked token census when the id was never persisted.
- Persist `r2_token_id` immediately after mint (before hashing the secret value).

## v1.4.0 -- 2026-07-19

MINOR. The demo-hardening batch: everything merged after the v1.3.1 outage fix, shipped together
because control-plane deploy is tag-only. This is the release that makes tonight's work LIVE -- until
it deploys, the site still serves the pre-batch behavior (the cold-401 intro and the live-tenant 503
below).

### Availability: the tenant job poll drives PROVISION jobs only (#56)

A tenant polling its own job page during an admin module upgrade could win the job claim and be driven
through `continueProvisionJob`, whose success path writes `awaiting_invoke_key` -- taking a LIVE tenant
non-routable (503) on the branch where the upgrade SUCCEEDS. The poll now refuses to drive any job kind
it does not own; it still reports the job. Guard placed before the stale-job branch, which also closed
a second `setTenantStatus("failed")` instance of the same class.

### Onboarding: the signed-out intro renders without a 401 (#67)

The intro eagerly fetched the session-gated `/api/tenant/provision-plan`, so every unauthenticated
visitor -- i.e. everyone on a cold visit, and everyone while signups are closed -- saw a red "Could not
load the setup plan: unauthorized" and a spinner that never resolved. That is exactly the first screen
an outside evaluator sees. The intro now renders a clearly-labelled representative example with no
network call; the real numbers are fetched behind the sign-in for the Review step.

### Operator + client surfaces

- `modules_release` and the job row are readable (#43, #57): the release pair projects on the tenant
  view and `GET /api/tenant/:id/job` reports `kind`, `from_release`, `to_release`, `finished_at`. The
  answer to "what version is this tenant on?" now exists over the API instead of only in prod D1.
- The invoke-key 202 emits structured facts, not just prose (#27, #59): a `readiness` object a client
  can compose from, with the four load-bearing claims (installed, stored, retry, do-not-re-paste) as
  assertable fields rather than substring greps. `message` retained for one release.

### The onboarding transport seam is testable (#31, #58)

`onboarding.js` no longer owns any transport; the request-building code lives once in
`onboarding-api.js` behind one seam, replacing a mirror that asserted a copy of the code rather than the
code. A tripwire fails if `onboarding.js` ever regrows a fetch.

### Deploy safety (both first exercised by THIS release)

- Post-deploy human-surface smoke check (#63, #64): the release run now asserts the human-visited front
  door actually renders (200 AND text/html AND a real front-door body), turning the v1.3.1 outage class
  into a red run in seconds instead of days of green silence.
- Tag-deploy ancestry guard (#62, fc#859): the release job refuses to deploy a commit that is not on
  `main`, closing the `git tag v9.9.9 <unmerged-commit>` bypass around branch protection.

## v1.3.1 -- 2026-07-19

PATCH, and an outage fix. **The hosted control plane had served no human-visitable page since
v1.3.0.** `/` and every HTML, CSS and JS path returned 500 while every JSON route returned 200, so
the plane looked healthy to every check anyone was running.

### The ASSETS binding was never created (#60)

`assets` is a **bare TOML key**, so it binds to whatever table header precedes it. The
`[observability]` table added in v1.3.0 landed above it, and the line was silently parsed as
`observability.assets`. The top-level ASSETS binding therefore did not exist, and
`env.ASSETS.fetch(request)` at the end of `src/index.ts` threw on undefined for every asset path.

wrangler's only protest was a warning that is easy to scroll past:

```
Unexpected fields found in observability field: "assets"
```

The fix is a **move**: bare top-level keys go above the first table header. The comment now records
that the position is load-bearing, because the line reads as equally correct in either place, which
is precisely why it shipped.

### The gap that let it ship is closed too

Every render guard asked *"did the render succeed?"*. None asked *"is the result the config we
meant?"* -- and a render can succeed while binding nothing. `tests/render-wrangler.test.sh` now
parses the rendered TOML and asserts a top-level `assets` key, `binding == "ASSETS"`,
`run_worker_first`, and the absence of a stray key under `[observability]`.

The guard was watched **red** before being trusted: a negative control regenerates the exact broken
shape and requires the assertion to fail against it. Its output is captured rather than printed,
because a deliberate `FAIL` line in CI teaches people to ignore real ones.

This is the second config-shape defect on this file the unit suite could not see; `run_worker_first`
was the first, on 2026-07-17. The suite never loads the asset layer.

**Still open:** nothing verifies at deploy time that a human-visited path returns 200. `/ready` does
not cover it. That check is what would have caught this in minutes instead of days.

## v1.3.0 -- 2026-07-19

MINOR: an operator can finally watch a hosted tenant actually render, the plane gets a diagnostic
surface, and a provision records where its time goes (cp#45, cp#18, cp#43).

### Operator verification route (cp#45)

Until now the release standard -- **nothing is verified until someone has looked at the actual output**
-- was not performable for a hosted tenant by anyone without the control-plane KEK. The tenant studio
serves its root publicly but gates every API path, and the only credential that can drive it is
encrypted in D1 and decryptable only inside the worker. Every hosted module release to date rested on
install-and-probe evidence, never on observed output.

- **Three admin routes**: open a canonical smoke render, drive it, and **stream the artifact bytes back
  through the plane** so an operator can actually look at them. The third one is the point; returning an
  R2 key to someone who by construction cannot reach the tenant would be `phase=done` wearing a hat.
- **No credential leaves the worker.** The studio token is decrypted per call, used, and dropped. It
  never crosses the interface, never reaches the store, never reaches a response. The client is **four
  typed calls with constant paths**, deliberately NOT a generic "dispatch this path to that tenant"
  helper, which would have been a permanent operator proxy into every customer studio.
- **Spend guard is part of the build, not a follow-up**, because this route costs GPU by definition.
  The payload is canonical (tenant id and nothing else, so it cannot be turned into a film), plus a
  per-tenant cooldown, a platform-wide daily cap, and one render in flight per tenant. Guards live in
  the `WHERE` of a single conditional INSERT: the WRITE authorizes, the read only explains.
- **What it does NOT bound, stated plainly**: dollars (it bounds invocations, and a cold GPU costs more
  than a warm one), a tenant's own rendering, a job already handed to RunPod, or an operator who simply
  waits out the cooldown.
- Rendering through a non-tenant door remains rejected. It would produce a satisfying artifact that
  answers a different question.

### Per-step provision timing (cp#18)

- Every `mark()` now logs `provision.step` with **`stepMs` (that step alone)**, cumulative `elapsedMs`,
  and the driver phase. Previously timing was recorded ONLY on yield, so a provision that SUCCEEDED
  produced no timing anywhere, and D1 never held it either (`steps_done` carries step names, and
  `updated_at` is overwritten on every write).
- **Additive only**: the budget logic and yield boundary are untouched, and the instrument deliberately
  does not perturb what it measures. It reuses the timestamp the log line already read rather than
  calling the clock twice, and the log lands BEFORE the budget throw so the step that triggers a yield
  is not the one measurement that goes missing.
- `stepMs` is mark-to-mark and therefore includes the previous step's progress write, because the
  invocation budget is consumed by everything on the wall clock. The first step additionally carries
  unmarked precondition work; read it as "everything up to and including this step".

### Observability

- **Workers Logs enabled on the control plane**, which had no observability surface at all.
- Tenant telemetry design recorded in `docs/tenant-telemetry.md`: operational fields only, with the
  content-carrying fields excluded and a written per-field disposition. Design only; nothing is wired.

### Docs

- Backfilled the missing v1.2.0 and v1.2.1 entries, including the fact that v1.2.0's headline route
  shipped non-functional.

## v1.2.1 -- 2026-07-19

PATCH: the module-upgrade route could not insert its job, so the feature v1.2.0 had just shipped could
not succeed for any input at all (cf#103).

- **`createModuleUpgradeJob` wrote bare words where it needed string literals**:
  `VALUES (?1, ?2, module_upgrade, queued, ?3, ?4)`. SQLite parses a bare word in `VALUES` as a COLUMN
  REFERENCE, so every call threw `SQLITE_ERROR` and the route answered `500` for every tenant and every
  release. Fixed by quoting them. The correct pattern (`?3` bound, `'queued'` quoted) sat 17 lines above
  in `createProvisionJob`.
- **468 green tests could not have caught it.** Every test in the repo builds a hand-written
  `MemoryStore`, so no test ever handed a `store-d1.ts` SQL string to a SQL engine. Every literal, column
  name, and clause in that file was unverified by construction.
- **`tests/store-d1-sql.test.ts` (new)** drives the REAL `D1Store` against real SQLite built from the
  real `migrations/`, and reads results back through SQL rather than trusting `RETURNING`. Two controls
  (`createProvisionJob`, `getTenantBySlug`) prove the harness discriminates.
- Found by a live rehearsal on the first real call, after unit tests, code review, and a production
  deploy all passed. Standing consequence recorded: **a store or SQL layer exercised only through a fake
  is UNTESTED**, and only a live run against real infrastructure says otherwise.

## v1.2.0 -- 2026-07-18

MINOR: module upgrade for live tenants, and the slug-reclaim lane (cf#103, control-plane#18).

**Correction, recorded rather than quietly fixed:** the module-upgrade route below shipped
NON-FUNCTIONAL in this version and could not succeed for any input. See v1.2.1. The slug-reclaim work in
this release was unaffected and did work as described.

### Module upgrade

- **Ship a new module release to a LIVE tenant without taking it down.** The tenant keeps serving
  throughout; the upgrade runs as a job with progress recorded per step.

### Slug reclaim

- **Tier A slug reclaim executes**, so a slug held by a tenant that never went live can be freed and
  re-provisioned by its owner without operator SQL.
- **Slug lease tiers with the WRITE as the enforcement point, not the check.** The check is never the
  gate; a conditional write is. This is the pattern the rest of the lifecycle now follows.
- **Reclaim is serialized on a lease** so two concurrent attempts cannot destroy each other, and a
  reclaim is REFUSED while a provision driver holds the lease. A lease expires, so a dead reclaim
  self-heals rather than stranding the row.
- **Teardown reaps the STORED script name**, not one recomputed from the slug.
- Live teardown rehearsal run against real Cloudflare rather than against fakes.

### Fixes

- Onboarding names the unproven modules instead of rendering `[object Object]` to the customer.
- The invoke-key contract is read as the route actually serves it, and the summary `ok` field is dropped
  from both invoke-key outcomes (cp#20).
- One slug rule shared by the preview and provision paths, so the two cannot disagree.

## v1.1.1 -- 2026-07-18

PATCH: the readiness probe stops failing customers for a benign propagation delay, and its diagnostic
actually reaches them (control-plane#17). Both defects were found by the cf#114 live verification.

- **A deadline with every module still `not_visible_yet` is now a SOFT outcome**, not a failure. The
  key is installed and the condition self-resolves, so the route answers `202` naming
  `modules_unconfirmed` and telling the caller to retry without re-pasting the key. The tenant is
  **not** promoted, so an unconfirmed module can never be rendered against. Measured cause: a
  first-ever key write to five fresh module scripts exceeded the 10s deadline and passed a minute
  later. The deadline was validated only against a virtual clock, which cannot measure the edge.
- **Every `misconfigured` verdict still fails HARD and immediately** (absent endpoint id, non-200,
  malformed envelope, echo mismatch). The soft path is deliberately narrow; widening it would be the
  laundering this design refuses. Mutation-tested in both directions.
- **`TenantModuleError` now surfaces as `503 modules_not_ready` carrying the real message** (module,
  script, retryability, attempts, elapsed) instead of falling into the top-level catch and reaching
  the caller as a bare `500 internal_error`. cf#114 exists because a misleading error fired at the
  worst possible moment; it shipped with an opaque one at that same moment.
- **Route-level tests asserting what the CALLER receives on every outcome.** This is the actual fix:
  every prior test asserted what the probe threw or returned, and none asserted the response, which
  is exactly how the opaque 500 shipped green.
- No invented lifecycle value: the unconfirmed response reports the tenant's TRUE stored status
  rather than a label no store ever holds.

## v1.1.0 -- 2026-07-18

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
