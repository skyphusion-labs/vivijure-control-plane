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
