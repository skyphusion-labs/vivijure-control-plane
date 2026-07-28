# Deploying the control plane

The control plane deploys from a **SemVer tag on this repository**, and only from a tag.

```
# bump both, they are gated against each other
#   package.json  "version"
#   src/version.ts CONTROL_PLANE_VERSION
git commit -am "chore(release): v1.2.3"
git tag -a v1.2.3 -m "control plane v1.2.3"
git push origin main --follow-tags
```

`.github/workflows/deploy.yml` then runs, in this order:

1. `npm ci`, typecheck, tests, config-render guards
2. **tag/version agreement** -- refuses if the tag does not match `package.json`
3. **render `wrangler.toml`** from `wrangler.toml.example` (`scripts/render-wrangler.sh`)
4. **report pending migrations** (`wrangler d1 migrations list CP_DB --remote`)
5. **apply D1 migrations** (`wrangler d1 migrations apply CP_DB --remote`)
6. **verify nothing is still pending** -- fails the deploy if it is
7. **`wrangler deploy`**

## Tag semantics

Split per repository, deliberately (cf#85):

| tag | deploys |
| --- | --- |
| `v*` here | the control plane |
| `v*` in `vivijure-cf` | the Studio panel |

They used to share one repo and one tag namespace. They do not any more; do not reintroduce it.

## Migrations: the doctrine

**No hand-applied schema, ever.** Schema reaches the live control-plane D1 through step 5 or not
at all.

This is not a style preference; it is cf#80, twice-proven in one e2e burn. The live D1 was built by
hand, so `0001` went in raw, `0002` was skipped, `0003` was applied after the fact, and there was
no `d1_migrations` ledger to notice. Two live provision failures came out of that single gap: an
AUP accept returning 500 on a missing `aup_sha256` column, and a provision dying at `r2_token` on
`no such column: r2_token_id`. The ledger was reconciled truthfully on 2026-07-17.

The repo schema-guard test cannot catch this class -- it compares code against `migrations/`, never
against the *deployed* database. Only the deploy job does.

### Migrate BEFORE deploy, and why

Deploy-then-migrate leaves a window where new worker code runs against the old schema. That is
exactly the cf#80 failure. Migrate-first is safe **because control-plane migrations are additive**:
old code tolerates a column it does not know about; new code cannot tolerate a missing one.

If a migration is ever non-additive (a drop, a rename, a narrowing), this ordering is **wrong** and
the change needs a two-tag expand/contract instead. Change the migration, not the ordering.

### The expected no-op

On a release that carries no schema change, steps 4-6 print `No migrations to apply`. That line is
the evidence the ledger and `migrations/` agree. Step 6 exists because `migrations apply` exiting 0
only means it did not error -- it does not prove the ledger now matches. A partial apply must not
reach `wrangler deploy` wearing a green checkmark.

## Required Actions configuration

Repository **secrets** (values never appear in this repo or its logs):

- `CLOUDFLARE_API_TOKEN` -- deploy + D1 migrate on the control-plane account
- `CLOUDFLARE_ACCOUNT_ID`
- `CONTROL_PLANE_D1_ID` -- the live control-plane D1 uuid

Repository **variables**:

- `CONTROL_PLANE_HOST`, `CONTROL_PLANE_ZONE_NAME`
- `TENANT_DISPATCH_NAMESPACE`, `TENANT_MODULE_NAMESPACE`
  - **Both namespaces must EXIST before a deploy that binds them**, or `wrangler deploy`
    fails. `TENANT_MODULE_NAMESPACE` is the sharp one: the control plane binds it as of
    cf#114, which closes the provisioner's lazy-create bootstrap, so on a fresh account it
    must be created out of band FIRST. Procedure (check -> create -> verify -> deploy) and
    the post-deploy binding check are in `deploy-runbook.md`.
- `STUDIO_RELEASES_BUCKET`, `STUDIO_RELEASE`
- `AUP_VERSION`, `AUP_URL`, `POSTERN_SEND_URL`
- `GOOGLE_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_ID`
- `APPLE_TEAM_ID`, `APPLE_SERVICES_ID` (empty = Apple SSO is not offered)
- `TENANT_AI_GATEWAY_ID` (cf#56) -- the AI Gateway that tenant MODULE workers bind as `GATEWAY_ID`.
  Set it to **`vivijure-hosted`**, the dedicated hosted-tenant gateway (authentication ON: a valid
  per-tenant token reaches the provider, a bogus one is refused 401 at the gateway).
  **Never `skyphusion-llm`** -- that is prism's gateway, and sharing it would put every tenant LLM
  call in one analytics namespace, defeating the per-tenant attribution the token exists to provide.
  Empty = no gateway named, so `plan-enhance` runs on the free local Workers AI provider.

#### `AI_GATEWAY_READ_TOKEN` and the LLM meter (cp#185)

The per-tenant Opus meter pages AI Gateway logs on a cron (`*/15 * * * *`, declared in
`wrangler.toml`) and writes integer micro-USD usage rows the credit ledger bills from. It needs
three things, all of which must be present or it does not run:

| what | where | note |
| --- | --- | --- |
| `CF_ACCOUNT_ID` | Actions secret, rendered into `wrangler.toml` | already set |
| `TENANT_AI_GATEWAY_ID` | Actions variable | must be `vivijure-hosted`; **never `skyphusion-llm`** |
| `AI_GATEWAY_READ_TOKEN` | worker secret, `wrangler secret put` | AI Gateway Read + Metadata Read, nothing else |

**A missing piece is an honest OFF, not a degraded mode.** With any of the three absent the meter
writes **no period rows at all**, and the windowed read then reports `complete: false` for every
window ("no roll-up run is assigned to this window"). That is deliberate and it is the single most
important property here: a period row asserts that an observation happened, so emitting empty ones
would manufacture billable-looking windows of zero spend out of a missing secret. A meter that
silently under-counts bills **us**, not the tenant.

Two things that are NOT the meter's problem and should not be read as one:

- **`skyphusion-llm` is refused by name at construction.** Every other wrong gateway id lands on
  Cloudflare's proven `200 / success:true / total_count:0` answer, which the roll-up's positive
  control catches. prism's gateway is not empty, so the control would *pass* while attributing
  another product's spend to vivijure tenants. It is the one misconfiguration the control cannot
  see, so it is refused explicitly rather than trusted to this document.
- **Re-reading rows is normal.** Cloudflare's `created_at gt` filter compares at whole-SECOND
  granularity (measured, not assumed), so each run re-reads the second holding the watermark. Writes
  are `INSERT OR IGNORE` on the gateway's own row id, so a re-read costs nothing. Do not "fix" it:
  the alternative is skipping a row that shares the watermark's millisecond, permanently.

Verify it live after installing the secret:

```
# force a tick and read what it actually did, rather than trusting a green cron
curl -sS -X POST -H "authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
  https://studio.vivijure.com/api/admin/llm-meter/run

# then read a window back; complete:false with a reason is a working meter reporting honestly
curl -sS -H "authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
  "https://studio.vivijure.com/api/admin/llm-spend?tenant=<id>&start=<iso>&end=<iso>"
```

The reader itself has a live regression suite against the real gateway
(`tests/ai-gateway-logs.live.test.ts`), because every vendor fact it depends on is behaviour that
can drift, and a reader built from a recorded sample is only as fresh as the sample.

- `R2_USAGE_ALERT_BYTES` (cf#56) -- alert threshold in BYTES for total R2 across tenant buckets on
  the admin usage surface. Empty = no threshold, and the surface reports a `no_threshold` verdict.
- `TENANT_R2_STORAGE_QUOTA_BYTES` (cp#183) -- the PER-TENANT storage ceiling in BYTES, bound onto
  every tenant studio as `R2_STORAGE_QUOTA_BYTES` and enforced there at submit (507 with both real
  numbers; fail-CLOSED 503 if the quota is set and its check cannot run). Empty = no ceiling, and
  there is deliberately no default: the number prices what an operator is willing to carry per
  tenant. Bytes only, no unit suffixes (`107374182400` = 100 GiB). A non-empty value that is not a
  positive integer REFUSES the provision, the studio-upgrade preflight and the converge route rather
  than being read as "off" -- see `docs/control-plane.md`.

### Which AI Gateway is which (cp#203)

Seven gateways exist on the account and they are NOT interchangeable. Pointing a consumer at the
wrong one is not a correctness bug, which is exactly why it survives: everything works, and the
spend lands in another product cost picture.

This table is the WHOLE ACCOUNT, deliberately, not the vivijure subset. A table listing only the
vivijure gateways would reproduce the very failure this section exists to prevent: the next reader
looks up the gateway id actually in front of them, does not find it, and guesses. Read 2026-07-28
with `result_info` checked (`count: 7, page: 1, total_count: 7`), so it is a complete census rather
than a first page.

| Gateway | Auth | Disposition |
| --- | --- | --- |
| `vivijure-hosted` | ON | TENANT traffic only. The per-tenant token is the access boundary and `cf-aig-metadata` carries the tenant id; this is the namespace the meter reads. Dev traffic here would forge tenant numbers. |
| `vivijure-dev` | ON | Crew DEV boxes and local studios (`vivijure-local` on a GPU dev box, any hand-run panel). Its own per-function token, `vivijure-dev-aig-run`. |
| `vivijure-demo` | OFF | Pre-existing demo surface. NO vivijure consumers, and do not add one; see the authentication note below. |
| `skyphusion-llm` | ON | **prism, a different product.** Never vivijure, in any environment. This is the one a vivijure dev config was actually pointed at, which is what cp#203 was. |
| `common-thread` | ON | Another product on this account. No vivijure consumers. |
| `openwebui-friends` | ON | Another product on this account. No vivijure consumers. |
| `default` | OFF | The account default gateway. No vivijure consumers. |

**A gateway that is not in this table is not a vivijure gateway.** That rule outlives the census:
anything created after 2026-07-28 carries no vivijure traffic until it is added here with a
disposition. Vivijure points at exactly two ids, `vivijure-hosted` for tenants and `vivijure-dev`
for crew dev work, and at nothing else.

**Dev traffic is AUTHENTICATED, deliberately.** The cheap option was to reuse `vivijure-demo`
(`authentication: false`) and skip the token. The standing rationale from cp#185 rules that out: an
unauthenticated gateway has a public, guessable URL, and keyless Unified Billing works THROUGH it,
so an unauthenticated gateway is an open proxy to our credit balance. That argument does not weaken
because the caller is a dev box; the exposed surface is the gateway, not the caller. A dev gateway
is also the one most likely to end up in a pasted snippet.

**Per-function token, not a shared one.** `vivijure-dev-aig-run` (CF token id
`74e596d3998335b93a3a4fa8fad63f3a`, permission group `AI Gateway Run`, minted by Strummer
2026-07-28, home `~strummer/.vivijure-dev-aig.env` on the primary crew box, `chmod 600`). It reaches
one capability on one account, so revoking it stops dev traffic and touches nothing else. It is NOT
a Worker secret and is deliberately absent from the owners table above, which covers
`wrangler secret put` bindings on this Worker.

Scope limit worth stating rather than implying: `AI Gateway Run` is an ACCOUNT-scoped permission
group, so this token is not confined to `vivijure-dev` at the API layer. The confinement is the URL
the consumer is configured with. That is why the gateway id and the token are rotated together and
recorded together.

Verified live at mint time (2026-07-28), all three legs against `vivijure-dev`: valid token **200**
with a real Anthropic response body, no `cf-aig-authorization` header **401** (`AiGatewayError`
2009), bogus token **401**. The gateway log then showed exactly one request, `cost=0.000145`,
`status=200`, a clean namespace with nothing else in it.

Known consumers repointed in the same pass: `~strummer/local.env` and
`~strummer/propagandhi-vivijure.env` on the crew box, and the LIVE `vivijure-local` stack on
a GPU dev box (its own `.env` plus a `docker compose up -d`, since a fixed file over a running
container that still holds the old value is the defect wearing a fix). All seven containers that
carry `GATEWAY_ID` were read back at `vivijure-dev`.

Worker **secrets** (`wrangler secret put`, never in Actions): `POSTERN_SEND_TOKEN`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_CLIENT_SECRET`, `APPLE_PRIVATE_KEY`,
`CONTROL_PLANE_ADMIN_TOKEN`, `CF_PROVISIONER_TOKEN`, `STUDIO_TOKEN_KEK`, `AI_GATEWAY_READ_TOKEN`
(cp#185), and -- only while a rotation is in progress -- `STUDIO_TOKEN_KEK_NEXT` (cp#95).

These are `secret_text` bindings on the worker and they **persist across `wrangler deploy`**, so the
pipeline does not carry them and a deploy does not need them staged in Actions. They are set once,
out of band. A deploy will not clear them; equally, a deploy cannot repair one that was never set.

#### Every worker secret has a named owner and a recorded home

"Set once, out of band" has a failure mode we hit on 2026-07-19: `CONTROL_PLANE_ADMIN_TOKEN` was live
on the worker and nobody could say who had put it there or where the value lived. A production admin
gate whose provenance cannot be accounted for is not a leak, but it is not owned either, and an
unowned credential cannot be rotated, audited, or handed over.

So: **a worker secret is not considered set until this table names its owner and its home.** If you
`wrangler secret put` something, you add the row in the same change.

| Secret | Owner | Home |
| --- | --- | --- |
| `CONTROL_PLANE_ADMIN_TOKEN` | Mackaye | `~/.vivijure-cp-admin.token` on the primary crew box (`chmod 600`) |
| `POSTERN_SEND_TOKEN` | Strummer | send identity recorded in `crew-secrets/operator/postern/vivijure-control-plane-send-identity.fragment.json` |
| `CF_PROVISIONER_TOKEN` | Rollins (hosted sprint mint, 2026-07-17) | `~/.vivijure-provisioner-full.env` on the primary crew box (dischord, `chmod 600`); mirrored to repo Actions secret `CF_PROVISIONER_TOKEN` for live gates |
| `STUDIO_TOKEN_KEK` | Rollins (recovered 2026-07-25); escrow: Mackaye | `~/.vivijure-studio-token-kek` on the primary crew box (dischord, `chmod 600`); **escrowed 2026-07-25** to crew-secrets tier `secrets-vivijure-kek` (mackaye + conrad-operator recipients only; recovery runbook `crew-secrets/docs/vivijure-kek-escrow-recovery.md`) |
| `AI_GATEWAY_READ_TOKEN` | Strummer (minted 2026-07-27) | repo Actions secret `VIVIJURE_AIGW_READ_TOKEN`. **NOT YET INSTALLED ON THE WORKER** as of 2026-07-28: the meter ships inert until someone holding the value runs `wrangler secret put AI_GATEWAY_READ_TOKEN`. Inert is honest, not broken -- see below |
| `GOOGLE_OAUTH_CLIENT_SECRET` | unset (SSO not offered) | n/a |
| `GITHUB_OAUTH_CLIENT_SECRET` | unset (SSO not offered) | n/a |
| `APPLE_PRIVATE_KEY` | unset (SSO not offered) | n/a |
| `STUDIO_TOKEN_KEK_NEXT` | whoever runs the rotation; escrow: Mackaye | **Only exists while a rotation window is open** (cp#95). Generated on an operator box, escrowed to crew-secrets tier `secrets-vivijure-kek` BEFORE it is installed, removed from the worker when the window closes |

### Rotating `STUDIO_TOKEN_KEK` (cp#95)

`tenants.studio_token_enc` is the only customer credential this plane stores as a usable value, so
the key protecting it has to be changeable on a calm day. The capability is product code
(`src/kek-rotation.ts`, two admin routes), not a script, because the day you need it is the worst
possible day to be writing it.

**The plane never mints its own KEK.** A key generated inside the platform is precisely how the
current one came to exist with no owner and no escrow (the section above). The new key is born on an
operator box and escrowed BEFORE it is installed.

The two routes, both admin-gated:

| Route | Does |
| --- | --- |
| `GET /api/admin/kek/status` | Read-only census. Counts stored tokens by WHICH installed key opens them, and answers `safe_to_promote` |
| `POST /api/admin/kek/reencrypt` | Re-encrypts stale rows under the write slot. Idempotent, resumable, bounded by an optional `limit`. Answers 200 only when a FRESH census says the old key can be dropped, 409 otherwise |

The sweep is safe to re-run: the work list is derived from the data every time (a row is work iff it
does not open under the write slot), so there is no cursor to go stale and a second run is a no-op.

#### The procedure

1. **Generate the new key on an operator box** and write it straight to a `chmod 600` file. Never
   render it.

   ```bash
   umask 077
   head -c 32 /dev/urandom | base64 > ~/.vivijure-studio-token-kek-next
   ```

2. **Escrow it BEFORE installing it**, to crew-secrets tier `secrets-vivijure-kek` (mackaye +
   conrad-operator recipients only -- this key decrypts live customer credentials, so the every-member
   `shared` tier was rejected by ruling). Runbook:
   `crew-secrets/docs/vivijure-kek-escrow-recovery.md`, section "Rotation: escrow the NEW key first".
   A rotation that produces a key with one copy has recreated the original defect.

3. **Install it as the second binding.** Reads now try both keys, so nothing has changed for any
   tenant and the step is reversible by deleting the binding.

   ```bash
   npx wrangler secret put STUDIO_TOKEN_KEK_NEXT   # paste from the chmod 600 file
   ```

   Confirm the window is open and see where you stand:

   ```bash
   curl -sS -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
     https://studio.vivijure.com/api/admin/kek/status
   ```

4. **Flip the write direction**: set `STUDIO_TOKEN_KEK_ENCRYPT_SLOT = "next"` in the wrangler config
   and deploy. From here new tokens are written under the new key, which is what lets the sweep
   converge instead of chasing live writes.

5. **Sweep**, and re-run until it answers 200:

   ```bash
   curl -sS -X POST -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
     -H 'content-type: application/json' -d '{}' \
     https://studio.vivijure.com/api/admin/kek/reencrypt
   ```

   A 409 means work is left (or a row is unreadable). Read `census`, not `sweep`: the sweep report is
   the writer describing its own work, the census is a fresh read of what is stored.

6. **Promote only on `safe_to_promote: true`.** Move the new value into `STUDIO_TOKEN_KEK`, set the
   slot back to `primary`, deploy, then delete `STUDIO_TOKEN_KEK_NEXT` and update the owners table
   above. Do not reorder these: the slot must stop naming `next` before the next binding goes away,
   or provisioning refuses (by design -- it will not silently write under the primary).

#### What blocks a promotion, and why it is not a bug

`safe_to_promote` is false while ANY row is `unreadable` -- a row no installed key opens. The sweep
never touches those: re-encrypting a row we could not read would destroy the only ciphertext, and the
value may still be recoverable from an escrowed key nobody has tried. Investigate the row before you
drop a key; dropping one with an unreadable row outstanding is how a tenant loses its token for good.

### Minted, not yet bound

Cloudflare API tokens that exist and are owned but are **not** worker secrets yet. They are listed
here rather than in the table above so that table keeps its invariant: every row there is a live
`secret_text` binding on the worker. A token graduates into the table above when a consumer actually
reads it, and not before -- a mint is not a roll.

| Token | Owner | Home | Purpose / consumer |
| --- | --- | --- | --- |
| `vivijure-cp-worker-upload` (CF token id `d28c773133d51c56fdebc26ed95a10df`) | Mackaye (minted 2026-07-25, cf#224 Lane U) | `~/.vivijure-cp-worker-upload.env` (conrad) and `~rollins/.cf-worker-upload-v2.env` (rollins), both on the primary crew box (dischord, `chmod 600`), var `CF_WORKER_UPLOAD_TOKEN` | tenant-script uploads incl. Workers VPC binding attach; **no token-mint scope by design** (CF forbids a sub-token from minting token-mint scope; split-function ruling on cf#224). Consumer: the control plane, wiring pending (Rollins, Lane U) |

Scope is exactly four permission groups on the account: Workers Scripts Write, Connectivity Directory
Admin, Connectivity Directory Bind, Connectivity Directory Read. The split exists because
`CF_PROVISIONER_TOKEN` carries `Account API Tokens Write` (it mints per-tenant bucket-scoped R2 S3
credentials, cf#53), and Cloudflare refuses to let one API token mint another that carries that group.
So the VPC-capable half was cut as its own narrower token instead of widening the provisioner. The
provisioner was not modified.

`STUDIO_TOKEN_KEK` was `UNCLAIMED` until 2026-07-25 (set on the live worker during the #93 deploy
with no durable home file); the recovery below closed that, and the crew-secrets escrow closed the
single-copy gap the same day. The paragraphs that follow are the record of how.

**Recovery search, exhausted 2026-07-25 (#4):** absent from the setting member's home and
`~/.secrets`, from every `crew-secrets` tier manifest and doc, from both repos' Actions secrets, from
`fleet-chezmoi`, and from shell history (crew shells are non-interactive, so none is written). The
binding IS live on the worker (`secret_text`), but Cloudflare worker secrets are write-only -- the
API returns names and types only -- so the value cannot come back off the platform. Treat it as
**unrecoverable**, not merely unlocated.

### RECOVERED 2026-07-25, and how

Filesystem recovery was genuinely exhausted (nothing on any box, no Actions secret, no crew-secrets
tier, no shell history) and the Cloudflare API cannot return a worker secret. But the RUNNING worker
still reads `env.STUDIO_TOKEN_KEK` on every request, and that is a recovery surface the API is not.

The value was recovered through a `wrangler dev --remote` session for this script name, which
**inherits the deployed script's secret bindings** while creating **no version and no deployment**.
That property is why this route was chosen over the two alternatives, both of which were rejected on
the same principle: a temporary export route merged to `main` would sit in a PUBLIC repo's history
forever, and a `wrangler versions upload` would sit in the script's version history, which has no
delete operation in either the CLI or the API. A closing window attached to a non-closing artifact is
not a closing window.

Custody of the recovery itself:

- The handler **never returned the KEK in plaintext.** It RSA-OAEP encrypted it to a public key
  generated on the operator box seconds earlier, so the plaintext never crossed the network and a
  captured response is inert without a private half that never left the box.
- Gated on `CONTROL_PLANE_ADMIN_TOKEN` (constant-time compare) plus a single-use per-run nonce.
- The response was decrypted straight into the `chmod 600` file home. The value was never rendered
  to a terminal, a log, or a transcript at any point.
- Ephemeral keypair, nonce and ciphertext were shredded afterwards.

**Verified by use, not by assertion:** the recovered key decrypts **7 of 7** live tenants'
`studio_token_enc` to well-formed 64-hex studio tokens. An escrow holding the wrong value is worse
than no escrow, so this check is the point, not a formality. Outside verification after the sitting:
deployed version id unchanged, version count unchanged, plane still serving.

### It has a HOME, and now an ESCROW (both closed 2026-07-25)

`~/.vivijure-studio-token-kek` on one box is a **single copy**. That closes the "nobody can say where
this lives" gap and it does NOT, alone, close the "only one copy exists" gap. That second gap CLOSED
2026-07-25: the key is escrowed in crew-secrets tier `secrets-vivijure-kek` (age ciphertext, mackaye +
conrad-operator recipients only, blob verified sha256-equal to the file home before commit; recovery
procedure in `crew-secrets/docs/vivijure-kek-escrow-recovery.md`). The row is CLOSED.

Consequences, stated plainly because this one is not like the others in this table:

- It is **not** cheap to re-key. Unlike the admin gate, this key decrypts `tenants.studio_token_enc`
  for every tenant that has one (7 at time of writing). A new KEK orphans that ciphertext and breaks
  dispatcher-injected auth for those tenants. Re-keying requires an explicit migration that re-mints
  and re-encrypts each tenant's studio token, and it is a ruled decision, not a maintenance chore.
- It had **no escrow**, which was the actual defect: the only copy of a key protecting live customer
  credentials existed in one write-only location. Recovery (above) gave it a readable home; the age
  tier (`secrets-vivijure-kek`, landed 2026-07-25) gave it the second copy.
- The live **provision e2e does not need it** and never did. That suite round-trips a KEK entirely
  in-process over a `MemoryStore` tenant it creates itself, so it generates an ephemeral key
  (`tests/provision-e2e-env.ts`). Admitting the production KEK there would widen its custody into CI
  to buy nothing. The belief that #4 was blocked on recovering this value was the premise error that
  parked that issue.

Re-keying an ADMIN TOKEN (not the KEK) is cheap and non-destructive: the admin gate fails closed, no tenant traffic
touches it, and the check is two curls (bearer -> 200, bare -> 401). Re-key on unknown provenance;
do NOT reflexively re-key because a value passed through a trusted boundary such as a transcript.

### Empty is a value, but only for four of them

`scripts/render-wrangler.sh` treats **everything as required unless it is on an explicit
allowlist**, and the direction matters. `envsubst` turns an unset variable into an empty string, so
"empty", "misspelled the variable name", and "forgot to set it" all render identically and all look
fine. Guarding a hand-picked few leaves every other value silently defaultable to empty.

`ALLOW_EMPTY` is exactly seven names:

`GOOGLE_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_SERVICES_ID`,
`TENANT_AI_GATEWAY_ID`, `R2_USAGE_ALERT_BYTES`, `TENANT_R2_STORAGE_QUOTA_BYTES`

Each is half of an SSO provider pair, and a provider is offered only when both halves are present,
so an unconfigured provider is *absent* rather than broken. Empty is how that is expressed. They are
additionally **absent** as repository variables rather than empty, because the GitHub API rejects an
empty variable value with a 422 -- the workflow cannot set them to the empty string it wants.

The two cf#56 names meet the same bar rather than being parked there to quiet a deploy.
`TENANT_AI_GATEWAY_ID` empty means this plane names no gateway, and the provisioner then binds
**neither** `GATEWAY_ID` nor `CF_AIG_TOKEN` (both or neither, since `pickProvider` needs both), so
empty is a coherent working state rather than a half-configured one. `R2_USAGE_ALERT_BYTES` empty
means an operator has not chosen a threshold, and has therefore not asked to be alerted.
`TENANT_R2_STORAGE_QUOTA_BYTES` (cp#183) meets it for the same reason: an operator who has not
chosen a byte count has not chosen a cap, and the plane binds nothing rather than a number nobody
picked. A non-empty MALFORMED value is a different matter and is refused at the write paths, which
is why it is allowed to be empty but never allowed to be wrong.

### The var census (cf#56)

A `[vars]` entry only reaches the Worker if it appears in **wrangler.toml.example**, in one of the
two allowlists in **render-wrangler.sh**, and in **both** render env blocks in **deploy.yml**.
Nothing connected those lists, so a var could be typed in `env.ts`, read in `deps.ts`, and never be
passed: it renders EMPTY, the deploy goes green, and the feature ships **inert**. Both cf#56 vars
hit exactly that, caught by review rather than by the pipeline.

`scripts/var-census.py` now checks that all four lists agree, and it runs inside
`tests/render-wrangler.test.sh` with a control proving it can fail. Add a var to one list and the
census names the lists it is missing from.

Do not extend that list to silence a failing deploy. Adding a name to it asserts that empty is
correct for that value, which for everything else here is false.

The D1 id is checked by *shape* (a uuid), not merely non-emptiness, because a wrong-but-present id
would migrate somebody else database -- the one mistake here with no undo. All of it is
negative-tested in `tests/render-wrangler.test.sh` (every required value, unset and empty, plus both
directions of the allowlist) and runs in CI on every PR.

## Prerequisites a deploy cannot create for itself

Typecheck will not catch any of these; only a real deploy will.

- the **tenant dispatch namespace** must already exist, or the `[[dispatch_namespaces]]` binding is
  dangling and `wrangler deploy` fails outright
- the **studio-releases R2 bucket** must exist *and* hold the artifact for the pinned
  `STUDIO_RELEASE` tag, or provisioning later fails at `wfp_upload`
- the **wildcard tenant leg** needs a proxied wildcard DNS record and an ACM pack covering
  `*.<CONTROL_PLANE_HOST>`; see `wrangler.toml.example`, which records that ACM was **not** entitled
  on the zone as of 2026-07-17

## Dry run

`workflow_dispatch` with `dry_run: true` (the default) renders the config and reports pending
migrations, then stops. Nothing is migrated, nothing is deployed. Use it to confirm the Actions
secrets and variables are correctly populated before cutting a real tag.

## AUP_URL must pin an immutable ref

`AUP_URL` is deploy-injected and **must** point at an immutable ref -- a full commit SHA or a tag,
never `main`, never a moving path. This is Ernst standing rule and it is load-bearing for a legal
reason, not a tidiness one: an account accepts a SPECIFIC text, the plane records the sha256 of what
it served, and that record has to stay checkable. A URL that can change out from under an
acceptance turns the record into a claim nobody can verify.

Verified live on 2026-07-18, at the point of extraction:

```
GET https://studio.vivijure.com/api/aup/current
{"version":"1.0.0",
 "url":"https://raw.githubusercontent.com/skyphusion-labs/vivijure-cf/8a5d96b.../docs/legal/hosted/aup/1.0.0.md",
 "sha256":"1072c78238a141dfcade920ff93de110f282b4b621c72f788ed0a3f51778b4ed"}
```

Full 40-character commit SHA, resolves 200, and the served bytes hash to exactly the advertised
sha256. The rule was already being honoured.

**Which refs count as moving:** `main`, `master`, `head`, `develop`, `trunk`, and any
`refs/heads/` path -- matched case-insensitively, because `/blob/Main/` is the same moving ref as
`/blob/main/`. That list is wider than the obvious two because a 16-case corpus driven through the
real script found `develop`, `trunk`, and every case variant sailing through a glob that looked
correct to two readers (2026-07-18).

**Known, accepted limitation:** a directory literally *named* after a branch, under an otherwise
pinned ref (`.../<sha>/develop/aup.md`), is refused as well. That is a false positive, and it fails
closed and loudly -- the operator sees the error and renames the path. Refusing a safe URL costs
seconds; accepting a moving one silently rewrites what an account agreed to. Distinguishing the two
would need per-forge URL parsing, which is more machinery and more ways to be wrong than the case
it rescues.

**Consequence for the cf#85 extraction:** the pin resolves against vivijure-cf *history*, not its
`main`, so removing the hosted legal set from vivijure-cf in phase 4 does **not** 404 the text any
existing tenant already accepted. No fix is required before phase 4. The one thing that would break
it is vivijure-cf being deleted or made private -- it stays public, so this holds.

**Going forward:** new AUP versions published from THIS repo pin to a commit SHA in THIS repo, by
the same rule. Bumping `AUP_VERSION` re-gates every account on their next request by construction,
so a new version and a new immutable URL travel together.

## Zone security

`zone-security/` holds the vivijure.com WAF as code. It is **not** part of this deploy job; it is
applied deliberately with `zone-security/apply-waf.sh`. WAF is in log mode; the flip to enforce is
a separate launch gate (vivijure-cf#40).
