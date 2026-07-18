# hosted/ -- the hosted-tier front door assets

Static assets for the **platform control plane** worker (the hosted signup +
onboarding door at `studio.vivijure.com`). Vanilla JS/HTML/CSS, no framework, no
build step, like the rest of the studio frontend.

This is a SEPARATE asset bundle from `public/` on purpose: `public/` belongs to
the studio worker (and to every self-hoster), and the hosted signup flow has no
business shipping to a self-hosted studio.

| File | What it is |
|---|---|
| `onboarding.html` | The setup flow screens: what you get, the rules, the key, capacity, review, build, done. |
| `onboarding.js` | The flow: step machine, gates, and the control-plane API adapter. |
| `onboarding-checks.js` | Pure helpers (key shape, quota fit, cost ceiling, gates). Unit-tested in `tests/onboarding-checks.test.ts`. No DOM. |
| `onboarding-checks.d.ts` | Hand-authored types so the tests pass the `tsc` gate (no build step). |
| `public/platform.css` | Styles. Design tokens copied from `public/styles.css` (a separate worker cannot import it). |

## Wiring this up (integration notes)

Reconciled against Rollins' posted #52 contract (issue 52, comment 4998960324). Routes below are
split into what the contract carries and what this flow still needs.

The worker serving these needs its `ASSETS` binding pointing at **`public`**.

### From the contract (authoritative; this adapter follows it)

| Route | Used for |
|---|---|
| `GET /api/platform/config` | signups switch, AUP version, `auth_methods` (projected, never hardcoded) |
| `GET /api/me` | the shell: account, AUP state, tenant + tenant status |
| `GET /api/aup/current` -> `{version, url, summary}` | the rules step (rendered as text + link, never innerHTML) |
| `POST /api/aup/accept` `{version}` | the blocking gate |
| `GET /api/tenant/slug-available?slug` | the name step |
| `POST /api/tenant/provision` `{slug, runpod_api_key}` | starts the build |
| `GET /api/tenant/:id/job` | polled; `error_message` shown VERBATIM |
| `POST /api/tenant/:id/retry` (409 `runpod_key_required`) | the re-paste path |
| `POST /api/tenant/:id/invoke-key` `{runpod_invoke_key}` | key B |

Job status (`queued|running|succeeded|failed`) and tenant status
(`provisioning|awaiting_invoke_key|live`) are different machines. The flow polls the job, then reads
tenant status from `/api/me`. A succeeded job is NOT "live".

### Requested, not yet in the contract (raised on #52; NOT invented facts)

| Want | Why the UI needs it |
|---|---|
| `GET /api/tenant/provision-plan` -> `{endpoints[], cost_example}` | The review screen says "this is exactly what we will create on your account." The endpoint list and the pinned `max_workers` are the provisioner's (#54), not this page's. |
| `POST /api/tenant/capacity` `{runpod_api_key}` -> `{quota, existing_worker_sum}` | #58 requires the happy path to surface the account's REAL quota BEFORE we touch it. A number that only appears inside a failure message does not satisfy that. Must create nothing. |
| `endpoints[] {key,label,id,name}` on the tenant (via `/api/me`) | The key-B console walk-through has to name the 4 endpoints we just created so the tenant ticks the right boxes. Ruled as copy-match, not guesswork. |
| a probe body on invoke-key rejection: `{probe:{graphql_denied, health:{[id]:bool}}}` | "Your key is wrong" is not an honest error. The tenant needs to know WHICH way (too powerful vs scoped to the wrong endpoints) to fix it. A bare 204 pass is handled; a bare failure cannot be explained. |
| `tenant_domain_suffix` on `/api/platform/config` | to build the studio URL without hardcoding the domain (currently defaults to `.studio.vivijure.com`). |

Until these land the flow falls back honestly: a bare 204 on invoke-key is reported as "your studio
accepted it" and never dressed up as a check this page performed.

## Rules this code follows (do not regress them)

- **Verify custody against the WRITE HISTORY, not the final state.** (Crew lesson from Rollins'
  #53 sabotage pass: his custody test asserted the transient key was absent from the store's FINAL
  state, and a deliberately sabotaged provisioner still passed, because a later write overwrote the
  leak before the assertion ran. On real storage that leak happened and was readable in the window.)
  The analogue here: reading localStorage at the end of the flow cannot see a transient
  write-then-clear. So the check shims every storage setter (`localStorage.setItem`,
  `sessionStorage.setItem`, `history.pushState`/`replaceState`, `document.cookie`) BEFORE any page
  script runs, records every value ever PASSED to them, and asserts no key value appears in that
  history -- plus a CONTROL that the shim records, or the negative proves nothing. Current result:
  the flow performs ZERO storage writes of any kind.
- **Neither key is ever stored by this page.** Both live in closure variables, never in
  localStorage/sessionStorage, never in a URL, never logged. Key A is cleared the moment the
  endpoints exist (before key B is asked for, so the page never holds both); key B is cleared on a
  failed verdict and at go-live. Live-verified, not just asserted.
- **Two-phase custody is not optional** (#52 ruling). RunPod keys are console-minted only and
  per-endpoint scoping can only name endpoints that already exist, so the second mint is forced.
  Account-wide invoke as a shortcut was REJECTED for launch: do not add an option branch for it.
- **Key B is verified before it is kept.** A full key passes every health check, so "it works" is a
  useless test; the refusal hangs on graphql being DENIED. Never relax that to a truthy check.
- **Mock mode is an explicit opt-in** (`?mock=1`), never a fallback. A page that
  cannot reach its API must look broken, loudly. It must never quietly show a
  stranger invented quota numbers, invented costs, and a fake "your studio is
  live" link.
- **Every number shown is one we read back from RunPod.** Never the published
  balance table: it is stale (#60). If the real quota cannot be read, the flow
  refuses rather than guessing.
- **The plan is data, not UI.** Add an endpoint to the plan and the review screen
  grows a row on its own. The frontend is a projection.
- **The AUP block is a marked seam** (`AUP-PLACEHOLDER-START/END`), visible as a
  placeholder in the rendered page. Ernst owns that text (#57). Do not write
  policy prose there.

## The resolve guard

`npm run guard:resolve` (a step of the required `ci` job) asserts that every function these pages
call actually exists. It is here because three identical defects shipped in one night: an edit
removed a helper and left its call sites behind, and `node --check` (valid syntax), `tsc` (never
sees these files), and the vitest suite (tests the pure helpers, never loads the DOM path) all
passed every time. Only driving the page in a browser caught them.

It is a heuristic and says so: it will miss a call to a function defined in a different IIFE, so a
clean run does not prove a page works. It proves nobody deleted a function out from under its
callers, which is the bug we actually keep writing.

**Overriding it:** per-identifier, in the file that needs it, with a reason.

```js
// resolve-guard-allow: someGlobal -- injected by the host page before this script runs
```

There is deliberately **no way to skip a file or disable the guard**, and an annotation that
suppresses nothing is itself an error, so overrides cannot rot into blanket permission. The scope
unit is the PAGE (the union of every script an HTML loads), because these are classic scripts
sharing one global; per-file analysis would flag every cross-file call in the planner and a guard
that cries wolf is worse than no guard.

Public docs for the tier: [`hosted-tier.md`](hosted-tier.md).
