# Operator access: scoped credentials, authenticated attribution, and the audit trail

Status: shipped in cp#219. The console that drives it is cp#89.
Audience: whoever holds the root credential, and whoever reviews what we told customers.

This document is the contract. It should be reproducible from here without reading the code.

## The stance this encodes

Ruled by Conrad, 2026-07-27:

> "I would rather scope an admin token, honestly. People are going to expect us to fix stuff. The
> more I think about it, if you want the assured privacy solution, self host, same with anything
> else."

> "Honestly, we won't use it unless someone reports an issue, but we still have access, and honestly,
> that's kind of expected."

Three consequences, and they are the whole design:

1. Operator reach into a hosted tenant is **inherent to hosting**, not a leak in it. Whoever runs the
   machine can reach the data. Promising otherwise on somebody else's infrastructure would be a
   promise we could not keep, and the honest answer for anyone needing a guarantee stronger than
   this is **self-host**, which is a first-class door at absolute parity.
2. Access is **held, not routinely exercised**: a credible report is the trigger. Same shape as the
   CSAM enforcement ruling (report-driven, never proactive scanning).
3. Therefore the work is **scoping and attribution, never withholding**, and "we hold access we do
   not routinely use" has to be **checkable** or it is marketing. The audit trail is the check.

## What existed before, and why it was not enough

One shared bearer, `CONTROL_PLANE_ADMIN_TOKEN`, gating all of `/api/admin/*`.

- No scope. Any holder held every capability over every tenant, so a crew member who needed to read
  one tenant's status could not be given that without also being given teardown, money minting, and
  the KEK sweep.
- No identity. Audit rows recorded the actor as the literal string `admin-token`, which proves an
  event happened and nothing about who caused it.
- cp#193 shipped around this on the money surface by recording `operator_claimed`: a name typed into
  a form, deliberately labelled a claim, because recording it as verified would have put false
  attribution into a money audit. That workaround was correct, and it was evidence of the gap.

## What exists now

### Named credentials

A credential is a random 256-bit token. The plane stores only its SHA-256 hex
(`operator_credentials.token_sha256`), so a dump of that table yields nothing replayable. The
plaintext exists exactly once, in the mint response. There is no masked-display column, because
keeping a prefix to show back implies keeping something.

Each credential carries:

| field | meaning |
| --- | --- |
| `name` | the authenticated operator identity; lands in the trail as `operator:<name>` |
| `scopes` | what it may do; validated at mint against the catalogue below |
| `expires_at` | optional, enforced on presentation, not by a sweep |
| `revoked_at` | soft revoke; the row survives so old audit rows still resolve |
| `last_used_at` | stamped on every authenticated request, so a dormant credential is visible |

Names are unique among LIVE credentials only. A revoked name can be reissued; two live credentials
answering to one name would make `operator:joan` in the trail ambiguous.

### The scope catalogue

Seven scopes, one per hazard class rather than one per route. `src/operator-auth.ts` is the source of
truth and `GET /api/admin/whoami` serves it, so the console never carries its own copy.

| scope | grants |
| --- | --- |
| `tenants:read` | tenant records, provisioning state, credit balances, preservation holds, smoke-render results **including the rendered artifact**, plus fleet reports (census, our R2 usage, RunPod reconciliation) and the audit trail |
| `tenants:write` | suspend/resume, storage quota, abuse-report URL, video-finish binding and tier state, opening and releasing preservation holds |
| `tenants:destroy` | teardown; irreversible, so never folded into `tenants:write` |
| `studio:operate` | module and studio upgrades, refreshing bindings, re-provisioning RunPod, starting a smoke render (spends GPU), minting an invoke-key handoff |
| `credits:write` | operator credits; mints money from nothing |
| `platform:settings` | platform switches, today the signups gate |
| `meter:operate` | run the metering pipeline: force an ingest tick (advances the watermark) and force an overage settlement (turns measured usage into ledger rows). Separate from `credits:write`, which mints money from nothing on the manual rail, and from `platform:settings`, because neither is a switch |
| `keys:rotate` | KEK status and the re-encryption sweep |

**A scope bounds what a credential can DO. It is only loosely a bound on what its holder can SEE:**
`tenants:read` reaches a tenant's rendered smoke-render output. Scoping is least privilege, not a
privacy boundary, and any customer-facing wording has to say so rather than implying scopes limit
what we can look at.

### The root credential survives, and is the only thing that can mint

`CONTROL_PLANE_ADMIN_TOKEN` still works, holds every scope, and is the **only** credential that can
create, list or revoke other credentials. A scoped credential able to mint an unscoped one would hold
every scope in two requests. (Same constraint Cloudflare enforces on its own API tokens: an
API-created token cannot carry token-management rights. Design for it up front or discover it at mint
time.)

Root actions still record `admin-token`, so **root-token use is visibly un-attributed in the trail,
by design**. That is the one path where "we record who" means "we record which credential".

### Authorization is a table, and the default is deny

`ADMIN_REQUIREMENTS` in `src/index.ts` maps method plus path to a requirement, consulted **before**
dispatch. A path with no entry is refused to everyone including root, and answers 404 (the common
cause is a path that is not a route at all, which answered 404 before the table existed).

A per-handler check would be correct exactly as long as every future handler remembered to write one,
and the failure mode of forgetting is an ungated admin route that no test notices because it works.
Here, forgetting makes the route unreachable. `tests/operator-scopes.test.ts` walks the router's own
path patterns and fails if one is not gated by anything.

Order is authenticate, then authorize: checking the table first would let an unauthenticated caller
map the admin surface by reading 403 against 404.

### Attribution

- A named credential records `operator:<name>` as the audit actor on every admin action.
- On the money surface, an authenticated principal records **`operator_authenticated`** in both the
  ledger note and the audit detail, replacing cp#193's `operator_claimed`. A body naming somebody
  else is **refused** (`operator_mismatch`), not ignored: silently dropping it would let a UI display
  a name that is not the one recorded.
- The root token keeps the old contract exactly: `operator` is required and recorded as a claim,
  because it still cannot prove anything about who holds it.

### Reads are audited, and the line is drawn deliberately

Reaching into **one tenant** writes an audit row (`tenant.read.*`):

- `GET /api/admin/tenants/:id/credits`
- `GET /api/admin/tenants/:id/preservation-holds`
- `GET /api/admin/tenants/:id/smoke-render/:smk`
- `GET /api/admin/tenants/:id/smoke-render/:smk/artifact` (rendered tenant content; recorded BEFORE
  the fetch, so reaching for it leaves a record whether or not the fetch then succeeds)
- `GET /api/admin/llm-spend?tenant=...` (that tenant's LLM spend for a window)

The row is written after the plane-capability check (a deploy with no provisioner or no meter answers
503 and has reached nothing) and after the request is known to be well formed (a malformed query is a
400, not a reach), but BEFORE the data is read. A trail full of rows about typos is a trail nobody
reads, and one that records only successful reads has a retry loophole.

Fleet-level reads are **not** audited: the tenant census, our own R2 usage, the RunPod
reconciliation, and the trail itself. Those read our inventory and our bill, not any one tenant's
material, and auditing them would bury the rows that matter.

So the honest claim is: **an operator reaching into a specific tenant leaves a durable record naming
who and when; an operator counting our own fleet does not.**

### The trail is readable

`GET /api/admin/audit?target=<tenant id>&limit=<n>` (`tenants:read`), newest first, ordered by the
autoincrement key rather than by `created_at`, which has one-second resolution here. Before cp#219
`admin_audit` was append-only with no reader, which is durable and not reviewable.

## The routes

| method | path | requires |
| --- | --- | --- |
| GET | `/api/admin/whoami` | authentication only |
| GET | `/api/admin/operators` | root |
| POST | `/api/admin/operators` | root |
| POST | `/api/admin/operators/:id/revoke` | root |
| GET | `/api/admin/audit` | `tenants:read` |

Everything else is unchanged, now gated by the table.

### Minting

```
POST /api/admin/operators
Authorization: Bearer <root token>
{"name": "joan", "scopes": ["tenants:read", "studio:operate"], "expires_in_days": 30}

201 {"id": "opc_...", "name": "joan", "scopes": [...], "expires_at": "...", "token": "<64 hex>"}
```

`cache-control: no-store`. **This is the only moment the token exists.** Refusals: `invalid_name`,
`invalid_scopes` (an unknown scope is refused, never dropped silently), `invalid_expiry`,
`name_in_use` (409, a live credential already holds that name), `mint_failed` (503, a store fault,
distinguished from the name clash so nobody hunts a credential that does not exist).

### Revoking

```
POST /api/admin/operators/opc_.../revoke   ->  204, or 404 if already revoked
```

Effective on the next request. Audited even when it changed nothing: a repeat is either a confused
operator or somebody probing which ids exist.

## Operating notes

- Mint one credential per PERSON, never per purpose. The name is an identity in a money audit.
- Grant the narrowest set that does the job. A refusal names the scope required and the scopes held,
  so asking for the right grant is one round trip.
- Revoke rather than share. Per-credential revocation exists so one member's credential can die
  without rotating everyone.
- Keep the root token out of daily use. Everything it does is recorded as `admin-token` and is
  therefore un-attributable; that is what it is for (break-glass), and it is not what daily work
  should look like. **The console enforces this**: presented with the root credential it offers
  credential management and nothing else, and it does not even LOAD the panels it declines to show,
  so it cannot write an access it refused to display. The API stays open to the root credential
  deliberately, because disarming break-glass in the gate would remove it at the moment it exists
  for. The restriction is the console declining, not the platform refusing.

## What the merged privacy text promises, and where that is tested

`docs/legal/hosted/PRIVACY-DELTA.md` Section 2.3 and `aup/1.0.0.md` Section 5 enter force at hosted
launch. They promise, in these words, that any access reaching into a specific tenant writes a record
carrying "which operator, authenticated by the credential rather than typed in on the honor system;
what was done; which tenant; and when."

That is a commitment rather than a description, so it is tested rather than assumed
(`tests/operator-scopes.test.ts`):

- **Every tenant-scoped route in `ADMIN_REQUIREMENTS` must be CLASSIFIED as audited.** A route that
  names a tenant and is not classified fails the suite. Same fail-closed shape as the scope table: the
  hazard is not a route that is wrong today, it is the one added next year.
- **The four promised fields are asserted on a real row** written through the real router, not merely
  the existence of a row.
- **The root credential is NOT exempt.** Break-glass access writes the same row, attributed to
  `admin-token` rather than to a person, which is exactly what the text discloses. There is no
  carve-out, so "every exercised access is recorded" needs no exception clause.

Note what the merged text does NOT claim: it does not say the record carries the TRIGGER. The four
triggers govern *when* access is permitted (a separate bullet); the record carries who, what, which
tenant, and when. If a trigger is ever added to the record it should be labelled operator-asserted,
because we can authenticate WHO but never WHY, and an unlabelled trigger would recreate the
`operator_claimed` problem on a new field.

## What this does NOT do

Stated so nobody reads more into it than is there.

- **No tenant-facing view of the trail.** A tenant cannot today see the rows recording operator
  access to their studio. If a disclosure promises one, that is new work.
- **Scopes do not bound what we can see**, only what we can do. See the catalogue note above.
- **Root-token actions name a credential, not a person.**
- **No approval workflow.** Nothing requires a second operator to authorise a reach into a tenant.
  The record is after the fact.
- **`POST /api/admin/llm-meter/run` is gated but not audited.** It is a platform action rather than a
  reach into a tenant, and its own audit design belongs with the meter lane (cp#185) rather than being
  bolted on from here. Recorded as a known gap.
