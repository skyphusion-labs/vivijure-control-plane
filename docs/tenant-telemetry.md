# Tenant telemetry: what we collect, what we refuse, and what that costs us

Status: PROPOSAL. Nothing described here is wired. This document is the audit and the
per-field disposition Conrad's 2026-07-19 ruling requires BEFORE any tenant collection
exists, and it is the direct input to the PRIVACY.md and SLA wording (Ernst's lane).

## The ruling this is written against

1. Operational telemetry ONLY, strictly filtered. "We are not monitoring what they are
   doing, we are just using the tools to make sure that it stays up."
2. We DISCLOSE it as part of the SLA. This is a normal provider boundary, plainly stated.
3. **If it cannot be done without logging their personal work, we do not do it.** We do not
   guarantee an SLA that way; we tell customers to open a ticket, and the lack of proactive
   monitoring is the price of their privacy on this platform.

The test: a field set is acceptable only if **every field is machine-generated and none is
user-derived.**

## Part 1: the audit (the gate)

**Finding: the tenant studio DOES log user-derived content today.** This is not
hypothetical. Tenants run the published `vivijure-cf` studio bundle, which has 13
`console.*` call sites. Four of them emit user-derived strings:

| Call site | What leaks | User-derived? |
|---|---|---|
| `src/index.ts:1123` `render.bookkeeping_deferred` | `project: row.project`, the **user-chosen project name**, plus `job_id` | YES |
| `src/index.ts:1142` `render.bookkeeping_deferred` | `film_id` | YES |
| `src/index.ts:1810` `console.error("router error", url.pathname, e)` | request **pathname**, which carries project and film identifiers | YES |
| `src/cast-bundle.ts:176,192,371` | cast id, artifact **R2 key**, artifact **path**, bundle **voice_id** | YES |

The remaining nine sites (`rate-limit.ts` x4, `access-auth.ts` x3, and the two static
config warnings) emit only configuration and internal state, no user data.

**Conclusion: the `Logs` field is a content carrier on the tenant leg, with named call
sites. It is excluded, and this is settled, not a judgement call.**

### Exceptions are also a content carrier, and stack traces are NOT content-free

We checked rather than assumed. There are two interpolated `throw` sites in the studio:

- `src/access-auth.ts:88`, `certs endpoint -> ${res.status}`. Machine-generated.
- `src/providers/openai-image.ts:55`, `OpenAI image API ${resp.status}${detail}`, where
  `detail` is **the upstream provider's error message verbatim** (`e?.error?.message`).
  OpenAI content-policy rejections routinely quote or paraphrase the offending prompt.
  **A user's prompt text can reach an exception message on this path.**

**Conclusion: `Exceptions` is excluded.** One concrete path is enough; we do not need to
enumerate every possible provider error string to know the field is unsafe.

## Part 2: per-field disposition (`workers_trace_events`)

Field list read off the Cloudflare dataset documentation, not guessed.

| Field | Collect | Origin | Why |
|---|---|---|---|
| `ScriptName` | YES | machine | Identifies which tenant studio. We assign the name (`tenant-<slug>-studio`); it derives from the tenant slug, an account identifier, not creative work. |
| `DispatchNamespace` | YES | machine | Constant (`vivijure-tenants`). Separates tenant estate from our own workers. |
| `Outcome` | YES | machine | Enum only: `ok`, `canceled`, `exception`, `unknown`. No free text. |
| `EventTimestampMs` | YES | machine | Clock value. |
| `WallTimeMs` | YES | machine | Duration integer. |
| `CPUTimeMs` | YES | machine | Duration integer. |
| `ScriptVersion` | YES | machine | Deploy version we published. |
| `EventType` | YES | machine | Enum: `fetch`, `scheduled`, `alarm`, `queue`, and similar. No free text. |
| `Entrypoint` | YES | machine | Class name from our own bundle. |
| `ScriptTags` | YES | machine | Operator-defined tags we set. |
| **`Logs`** | **NO** | **user-derived** | Console messages. Audit above: carries project names, film ids, R2 keys, artifact paths, voice ids. |
| **`Exceptions`** | **NO** | **user-derived** | Uncaught exception messages. Audit above: can embed a user prompt via the provider error path. |
| **`Event`** | **NO** | **user-derived** | **Not on the lead's original PASS list; flagging it.** `Event` is "details about the source event": for a fetch it carries the **request URL**, which contains project and film identifiers. It is a single opaque object, so field selection is all-or-nothing; there is no way to take the response status without also taking the URL. Excluded. See the sufficiency cost in Part 3. |

## Part 3: is the clean set SUFFICIENT to detect an outage? Partly. Read this before writing any SLA.

Reasoned against three real failure modes.

| Failure mode | Detectable from the clean set? | How, or why not |
|---|---|---|
| Studio throws or crashes | **YES** | `Outcome = exception`. Rate per `ScriptName` over time. |
| Studio hangs or times out | **YES** | `WallTimeMs` distribution, plus `Outcome = canceled`. |
| Studio never invoked at all | **YES, with a caveat** | Absence of rows for a `ScriptName`. Caveat: absence is ambiguous. A studio nobody visited looks identical to a studio that is unreachable. |
| **Studio returns HTTP 4xx/5xx successfully** | **NO** | This is the sharp one. A Worker that *successfully executes* and returns a 500 has `Outcome = ok`. The HTTP status lives inside `Event`, which we excluded as a content carrier. **The clean field set is blind to a studio serving errors.** |

**This blind spot is real and it is the most likely tenant-visible outage.** Per the
ruling, an SLA must therefore NOT promise to catch a studio serving error responses on
the strength of telemetry alone.

### Closing the blind spot WITHOUT content: Gatus synthetic checks

The fix is already in the fleet and needs no new invention. A **black-box health check is
our own synthetic request, not the tenant's traffic**, so it observes the studio liveness
while touching zero customer content. It sees exactly what telemetry cannot: a real status
code from a real request we made ourselves.

The fleet already runs Gatus on biafra and watt with ntfy plus email alerting wired
(`system/stacks/biafra/monitoring/gatus/config.yaml`), and the existing vivijure CPU
helper checks are the template. The standing fleet rule ("a check lives with, and moves
with, the same IaC as the service it watches") applies: tenant checks are generated from
the tenant roster, in the same change that provisions a tenant.

**Recommended split:**

- **Logpush (clean field set)** for estate-wide health: exception rates, latency
  regressions, per-tenant invocation volume.
- **Gatus `/health` probe per tenant** for per-tenant up/down and status codes, which is
  what an SLA can actually promise.

Together these detect every failure mode in the table with **no customer content
collected anywhere**. Neither alone is sufficient.

### Alerting (proactive means alerting, not a dashboard)

Reuse, do not invent:

| What fires | Threshold | Where |
|---|---|---|
| Tenant `/health` non-200 or unreachable | 2 consecutive failed 60s probes | Gatus to ntfy + email (already wired) |
| Tenant exception rate | `Outcome = exception` above 5% of invocations over 10m | Grafana alert on Loki |
| Tenant latency regression | p95 `WallTimeMs` above 3x the 24h baseline for 10m | Grafana alert on Loki |
| Estate-wide silence | zero invocations across ALL tenants for 10m (a control-plane or platform fault, not a tenant one) | Grafana alert on Loki |

Per-tenant "no invocations" is deliberately NOT an alert: an idle studio is not an outage,
and paging on it would train us to ignore the channel.

## Part 4: UNRESOLVED, and it must not be papered over

**Does `output_options.field_names` exclude a field AT SOURCE, or filter it after
collection?**

**The Cloudflare documentation does not say.** We checked the Log Output Options page, the
Workers Logpush page, the `workers_trace_events` dataset page, and the Workers for
Platforms observability page. All describe `field_names` as selecting which fields are
included in the output. **None states whether an unselected field is never emitted or is
collected and then dropped.** We are not going to assert the stronger claim without
evidence.

What we CAN state with confidence, and what actually bounds our own liability:

- An excluded field is **never delivered to our destination**. It does not enter our
  fleet, our Loki, or our 7-day retention. That is the boundary the ruling is about, and
  `field_names` definitively controls it.
- Whether Cloudflare transiently processes the field on their side before dropping it is a
  question about **our compute provider, who is already the tenant's compute provider** and
  already processes this data to run the Worker at all. It is a subprocessor question for
  the privacy policy, not a new collection by us.

**Ernst should word PRIVACY.md against the claim we can defend** ("this data is never
delivered to or retained by us") rather than the stronger unverified one ("Cloudflare never
emits it"). If the stronger claim is wanted, it needs confirmation from Cloudflare support,
which we have not obtained.

### A note on why Logpush, not a Tail Worker, for the tenant leg

Our own workers ship logs to Loki via the `vivijure-tail` Tail Worker. **That mechanism is
the wrong choice for tenants**, on privacy grounds rather than technical ones: a Tail
Worker receives the **complete** tail event, `Logs` and `Exceptions` included, and then
our code decides what to forward. The customer content would enter code we wrote and would
be excluded only by our own correctness.

Logpush `field_names` excludes the field before it is ever handed to us. **The filter is
enforced by the platform rather than by our own code being right**, which is the stronger
guarantee and the one to prefer where customer content is at stake.

Per the Workers for Platforms documentation, a single Logpush job on the dispatch Worker
covers the dispatch Worker and every user Worker in the namespace, so this needs no
per-tenant configuration.

## Part 5: cost

Measured, not estimated: `vivijure-studio` emits 4,932 events per 24h, about 150k/month.
Against the 20M/month included allowance on Paid, at roughly 150k/month per active tenant:

| Active tenants | Events/month | Overage cost at $0.60/M |
|---|---|---|
| 130 | ~20M | $0 (at the allowance) |
| 200 | ~30M | ~$6/mo |
| 500 | ~75M | ~$33/mo |
| 1,000 | ~150M | ~$78/mo |

Tenant studios emit nothing today (the provisioner upload metadata sets no
`observability` field), so this is entirely additive spend. **Recommendation: full rate, no
sampling.** Sampling would degrade exactly the rare-but-important events monitoring exists
to catch, and the dollar cost is immaterial at any plausible launch scale. Revisit above
~500 tenants.

## Summary

The clean field set holds the boundary: every collected field is machine-generated, and
`Logs`, `Exceptions`, and `Event` are excluded with named evidence for each. The point-3
fallback in the ruling is **not** needed for tenant monitoring as a whole, but it DOES
apply, narrowly, to one promise: **telemetry alone cannot see a studio serving HTTP
errors**, and no clean field set will fix that. That capability comes from synthetic Gatus
probes or it does not come at all, and the SLA must be written to match.

---

# Part 6: Logpush delivery design (answers to the three gating questions)

Design only. Nothing here is wired, and per the ruling nothing gets wired until the
tenant leg is approved on its merits.

## Q1. Can Logpush deliver to our self-hosted Loki? Not directly. A shim is required.

Loki's push API expects its own envelope:

```json
{"streams":[{"stream":{"worker":"..."},"values":[["<ns>","<line>"]]}]}
```

Logpush does not emit that. It POSTs its own batch of the selected fields to an HTTPS
destination. So a translating shim is mandatory; there is no configuration that makes
Loki accept a Logpush batch directly.

**The privacy question you asked, answered: YES, the never-collected property survives
the shim.** `output_options.field_names` determines what is in the payload Cloudflare
sends. A field that is not in `field_names` is **not in the POST body**. The shim
therefore cannot forward, log, or leak `Logs`, `Exceptions`, or `Event`, because it never
receives them. The exclusion stays enforced by the platform, upstream of any code we
write, which is exactly the property that distinguishes this from the tail-worker
approach.

That holds regardless of where the shim runs or how carelessly it is written. Worth
stating plainly: **the shim is not part of the trust boundary for content.** It is only
trusted for availability and correct reshaping.

**Recommended shim placement: a Worker, reusing the existing `LOKI_VPC` pattern.**

```
Logpush (filtered fields only) --HTTPS--> shim Worker --LOKI_VPC (vpc_service)--> Loki
```

Rationale: Loki is deliberately network-isolated with **no auth on its push path** (the
monitoring compose comments call this out explicitly, and it is safe precisely because
Loki is unreachable from outside). A Logpush HTTP destination must be publicly
reachable. Exposing Loki directly to satisfy that would destroy the isolation that makes
the credentialless push path acceptable. A Worker keeps Loki private and terminates the
public surface somewhere we control, and `vivijure-tail` already proves the
`vpc_service` hop works.

Authentication is our responsibility, not Cloudflare's: the docs state plainly that
"Cloudflare customers are expected to perform their own authentication of the pushed
logs." Logpush supports `header_*` destination parameters, so the shim requires a shared
secret header. That secret is a Worker secret, never a tracked file.

**Implementation ordering constraint (do not discover this at deploy time):** creating a
Logpush job VALIDATES the destination first. Per the docs, the endpoint must accept a
gzipped `test.txt.gz` whose content is `{"content":"tests"}` or job creation errors. So
the shim Worker must be **deployed and answering that validation probe BEFORE** the
Logpush job can be created. Same class as the dangling-binding hazard already documented
in `wrangler.toml.example`: an ordering fact that only a real deploy will teach you.

**One item to confirm empirically rather than assume:** the destination documentation does
not state the exact wire format of a live batch (the validation upload is gzipped, which
strongly suggests gzipped NDJSON, and that matches Logpush behaviour elsewhere). The shim
must be written against a REAL captured push, not against an assumed shape. This is the
same trap as parsing a vendor format from a remembered sample.

## Q2. Can a job be scoped to the tenant dispatch namespace? Yes, cleanly.

`DispatchNamespace` is a plain `string` field in `workers_trace_events`, and Logpush
filters support `eq` on strings. Filtering is unsupported only on `objects` and
`array[object]` types, which does not affect us here.

```json
{"where":{"key":"DispatchNamespace","operator":"eq","value":"vivijure-tenants"}}
```

`ScriptName` is also a string and supports `startsWith`, giving a fallback or a
belt-and-braces second predicate (`tenant-`).

**Important framing: scoping is NOT the privacy control, and must not be relied on as
one.** The job's `field_names` never includes `Logs`, `Exceptions`, or `Event`, so even a
job that over-captured every Worker in the account would collect **zero** customer
content. Scoping controls cost and noise. The field set controls content. Keeping those
two concerns distinct matters, because it means a future filter mistake is a billing
annoyance rather than a privacy incident. Use both; depend on the field set.

Per the Workers for Platforms documentation, one job on the dispatch Worker covers the
dispatch Worker and every user Worker in the namespace, so this needs no per-tenant
configuration and does not scale with tenant count.

## Q3. Outage classes: what the clean field set CAN and CANNOT see

Restated here as the standalone deliverable. Clean set = `ScriptName`,
`DispatchNamespace`, `Outcome`, `EventTimestampMs`, `WallTimeMs`, `CPUTimeMs`,
`ScriptVersion`.

| Outage class | Detectable? | Mechanism, or why not |
|---|---|---|
| Studio throws / crashes | **YES** | `Outcome = exception`, rate per `ScriptName`. |
| Studio hangs / times out | **YES** | `WallTimeMs` p95 against baseline; `Outcome = canceled`. |
| Studio CPU-starved | **YES** | `CPUTimeMs` against baseline. |
| Studio never invoked | **PARTIAL** | Absence of rows. **Ambiguous by construction:** an idle studio and an unreachable studio are indistinguishable. Usable estate-wide (all tenants silent = platform fault), NOT usable per tenant. |
| **Studio returns HTTP 4xx/5xx** | **NO** | A Worker that executes successfully and returns a 500 has `Outcome = ok`. Status lives inside `Event`, excluded as a content carrier. |
| Bad deploy / regression by version | **YES** | `ScriptVersion` correlated against exception rate. |

**The 4xx/5xx blindness is structural, not a tuning problem.** No selection of clean
fields fixes it, because the status code is only ever inside `Event`, and `Event` also
carries the request URL. That is the whole trade.

Consequence for the SLA, stated so it cannot be missed: **an SLA backed by telemetry
alone must not promise to detect a studio serving errors.** It can promise detection of
crashes, hangs, and platform-wide outage. Detection of error responses requires the
synthetic Gatus probe described in Part 3, which uses our own request rather than the
tenant's traffic and therefore stays inside the boundary.

## Q4. `path` is user-derived, and it is not being smuggled in

Agreed and already handled. `path` reaches us only inside `Event`, which Part 2 excludes
in full. There is no configuration in this design that collects a request path for a
tenant Worker.

Noting for completeness, because it is the same field and could confuse a future reader:
our **own** tail worker DOES put `path` on its invocation line
(`path: ev.request?.path` in `tail/src/index.ts`). That is correct for our Workers, whose
paths we author, and is one more reason the tail worker must never be pointed at a tenant
script.

## Summary of Part 6

| Question | Answer |
|---|---|
| Deliver straight to Loki? | **No.** Shim required; Loki does not accept Logpush batches. |
| Does the shim weaken the boundary? | **No.** It only ever receives the filtered field set. Not in the content trust boundary. |
| Scope to the tenant namespace? | **Yes**, `DispatchNamespace eq vivijure-tenants`. Cost control, not the privacy control. |
| Blind spots? | **HTTP 4xx/5xx**, structurally. Per-tenant silence is ambiguous. Both constrain the SLA. |
| Blocking prerequisite | Shim Worker must answer the gzipped validation probe BEFORE job creation. |
| Must be verified empirically | The live batch wire format. Write the shim against a captured push, never an assumed shape. |
