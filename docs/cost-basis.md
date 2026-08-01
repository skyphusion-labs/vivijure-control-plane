# Cost basis: measured per-job-class compute cost

Tracking issue: `vivijure-control-plane#180`. Feeds the prepaid credit design (`cp#173`) and the
per-tenant meter (`vivijure-cf#56`). This document is a MEASUREMENT, not a pricing design; the credit
system itself is built under cp#173 and is deliberately out of scope here.

Measurement date: **2026-07-27**. Billing window: **July 2026** (2026-07-01 to 2026-07-27), plus June
2026 for comparison.

## How to read this document

Every number carries a provenance tag. An untagged number is a bug in this document.

| Tag | Meaning |
| --- | --- |
| **MEASURED** | Read off our own billing API, our own render history, or our own runlog. Real money or a real job. |
| **CITED RATE** | Read off a vendor pricing page. URL and retrieval date given. Not our own observation. |
| **DERIVED** | Computed from a MEASURED value and a CITED RATE. The formula is shown so it can be rechecked. |
| **NOT AVAILABLE** | We cannot source it today. Recorded as a gap, never filled with an estimate. |

An uncited number is an estimate wearing a costume, so there are none here.

## Method, and why the derived GPU-hours can be trusted

RunPod's billing API returns three components per serverless endpoint: `gpuAmount`, `feeAmount`, and
`diskAmount`. It does NOT return GPU-seconds. To get hours we needed the rate, and to trust the rate
we had to prove which rate RunPod actually applied.

**Finding: `gpuAmount` is billed at the Pod (base) rate, and `gpuAmount + feeAmount` equals the
Serverless Flex rate.** That makes the ratio `(gpuAmount + feeAmount) / gpuAmount` a fingerprint of
the GPU tier, independent of how many hours ran.

Predicted ratios from the published rate card (CITED RATE, <https://www.runpod.io/pricing>, retrieved
2026-07-27):

| GPU | Pod $/hr | Serverless Flex $/hr | Predicted ratio |
| --- | ---: | ---: | ---: |
| RTX PRO 6000 Blackwell Server Edition (96 GB) | 1.99 | 3.49 | **1.7538** |
| H200 SXM (141 GB) | 4.39 | 5.93 | **1.3508** |
| B200 (180 GB) | 5.89 | 8.64 | **1.4669** |

Observed ratios in our July billing (MEASURED):

| Endpoint | Observed ratio | Matches |
| --- | ---: | --- |
| `sj0btgpjdtswa7` (audio upscale) | 1.7538 | RTX PRO 6000, exact to 4 dp |
| `dp3ofo30qcb988`, `hc9xccajqidda4`, `odz1x4bduwlqws`, `3w8gxf29or8kj2` | 1.7538 | RTX PRO 6000, exact to 4 dp |
| `8kjcn5sz6k8p1n` (retired local train) | 1.3508 | H200, exact to 4 dp |
| `t9wcvlxh8rc5la` (render) | 1.3739 | blend of H200 and B200 |
| `zqb7tougbqfkqa` (wan train) | 1.3946 | blend of H200 and B200 |

Six endpoints reproduce a published rate to four decimal places. The published rate card therefore
describes what we were actually charged, and GPU-hours follow as
`GPU-hours = gpuAmount / pod_rate`. For the two mixed-pool endpoints the B200 share is solved from
the blended ratio and the hours split accordingly.

Two independent cross-checks passed:

1. **Reconciliation (MEASURED).** The 12 per-endpoint July rows sum to `gpu 209.027079`,
   `fee 81.974930`, `disk 2.958160`, total **293.960169**. The account-level July figures are
   identical to six decimals. The per-endpoint breakdown is complete, with nothing unattributed.
2. **Independent run count (DERIVED).** Endpoint `8kjcn5sz6k8p1n` billed 1.561 GPU-hours in July; a
   single logged training run on it took 0.7583 GPU-hours, giving 2.06 runs-equivalent, consistent
   with a whole number of runs.

## 1. GPU job classes on our RunPod endpoints (production)

July 2026, production endpoints only. Dollars are MEASURED (RunPod billing API, `get-billing`
`scope=serverless`, `bucketSize=month`). GPU-hours and `$/GPU-hr` are DERIVED by the method above.

| Job class | Endpoint | Total $ | gpu $ | fee $ | disk $ | GPU-hr | $/GPU-hr | $/GPU-s | GPU pool |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Keyframe batch + i2v shot (render) | `t9wcvlxh8rc5la` | 122.961 | 88.491 | 33.087 | 1.383 | 19.136 | **6.353** | 0.001765 | 20% B200 / 80% H200 |
| Cast-LoRA training (Wan) | `zqb7tougbqfkqa` | 56.983 | 40.558 | 16.003 | 0.421 | 8.352 | **6.772** | 0.001881 | 38% B200 / 62% H200 |
| Upscale pass (video) | `4q8idwbk6tyqbq` | 7.680 | 4.420 | 3.250 | 0.009 | 2.221 | **3.454** | 0.000959 | RTX PRO 6000 |
| Lip-sync pass (MuseTalk) | `zw6pt4lymf69pk` | 7.905 | 4.539 | 3.354 | 0.012 | 2.281 | **3.460** | 0.000961 | RTX PRO 6000 |
| Audio upscale pass | `sj0btgpjdtswa7` | 0.381 | 0.217 | 0.164 | 0.000 | 0.109 | **3.494** | 0.000971 | RTX PRO 6000 |
| **Production total** | | **195.909** | | | | **32.099** | | | |

`$/GPU-hr` is computed on `gpu + fee` (the compute charge); `disk` is reported separately because it
is a storage charge, not a per-second compute rate. The audio-upscale row lands at 3.494 against a
published 3.49, which is the tightest available confirmation that the derivation is sound.

**The render and train classes are the same physical GPU pool.** Their `$/GPU-hr` differs only by
the B200/H200 mix RunPod happened to schedule, not by any property of the work. A rate card should
carry ONE B200/H200-class rate, not two, with the mix treated as scheduling variance.

### Per-job costs where a real job duration exists

| Job class | Duration basis | Cost | Provenance |
| --- | --- | ---: | --- |
| Cast-LoRA training run, `:train-0.2.1`, prod EP | `executionTime` 6,980,552 ms (1.9390 GPU-hr) | **11.50 to 16.75** | MEASURED duration (runlog `2026-07-23-vivijure-wan-train-phase-e-deploy.md` records the sibling run; this run is logged in `fleet-chezmoi/docs/runlog/2026-07-20-vivijure-wan-train-d2.md`, job `9edf3fa6-...-u2`, EP `zqb7tougbqfkqa`, `:train-0.2.1`); range spans all-H200 to all-B200 at CITED RATE. At the blended measured rate, **13.13**. |
| Cast-LoRA training run, `:train-0.1.x`, retired local EP | `executionTime` 2,730,015 ms (0.7583 GPU-hr) | **4.50** | MEASURED duration (runlog `2026-07-23-vivijure-wan-train-phase-e-deploy.md`, job `ce764934-...-u1`); EP proven 100% H200 by its exact 1.3508 ratio, so no range is needed. Shorter config, retained only as a second data point. |
| One film (all stages on the render EP) | July render spend / 133 July render rows | **0.914 per film submitted** | MEASURED both sides. Mean GPU per film 8.6 GPU-min. See the caveats below before using this. |

Caveats on the per-film number, which matter for pricing:

- The denominator is films **submitted**, not completed. Across the full 200-row history, 129
  COMPLETED / 56 FAILED / 12 CANCELLED. **We pay for failed GPU work**, so a cost basis built on
  completed jobs alone would understate real cost by a material margin. Submitted is the honest
  denominator.
- Films routed to the cloud i2v door do not consume this endpoint, so they dilute the denominator.
  The true per-film cost for backend-rendered films is therefore somewhat higher than 0.914.
- Cost per delivered video second is bounded at **0.3675 per second, upper bound only** (121.578 over
  330.824 delivered seconds). It is an upper bound because `clip_deliveries` is populated on only 49
  of 129 completed rows, so the denominator undercounts. Do not quote this as the rate.

## 2. Cloud i2v and cloud keyframe (the GPUless cost door)

The cloud door does not run on a separate provider account. Cloud i2v modules call **RunPod public
endpoints** (`modules/*/src/index.ts` hardcode `https://api.runpod.ai/v2/<slug>`), and cloud keyframes
run on **Cloudflare Workers AI**. All rates below are CITED RATE, retrieved 2026-07-27.

| Path | Model / endpoint | Rate | Source |
| --- | --- | --- | --- |
| Cloud i2v | `seedance-v1-5-pro-i2v` | 0.024/s (480p), 0.052/s (720p) of generated video | <https://docs.runpod.io/public-endpoints/models/seedance-1-5-pro> |
| Cloud i2v | `kling-v2-1-i2v-pro` | 0.45 per 5 s, 0.90 per 10 s (0.09/s) | <https://docs.runpod.io/public-endpoints/models/kling-v2-1> |
| Cloud i2v | Vidu Q3 | 0.15/s | <https://docs.runpod.io/public-endpoints/reference> |
| Cloud i2v | Alibaba Wan 2.6 i2v | 0.10 to 2.25, varies by duration and resolution | <https://docs.runpod.io/public-endpoints/reference> (range only; not itemized) |
| Cloud i2v | `minimax-hailuo-2-3-fast` | **NOT AVAILABLE** | Not listed in RunPod's public-endpoint reference as of 2026-07-27 |
| Cloud i2v | Google Veo | **NOT AVAILABLE** | Not listed in RunPod's public-endpoint reference as of 2026-07-27 |
| Cloud keyframe | `@cf/black-forest-labs/flux-2-klein-9b` (default) | 0.015 first megapixel, 0.002 per further MP, 0.002 per input image MP | <https://developers.cloudflare.com/workers-ai/platform/pricing/> |
| Cloud keyframe | `@cf/black-forest-labs/flux-2-klein-4b` | 0.000059 per input 512x512 tile, 0.000287 per output tile | same |
| Cloud keyframe | `@cf/black-forest-labs/flux-2-dev` | 0.00021 per input tile per step, 0.00041 per output tile per step | same |
| Cloud keyframe | `google/nano-banana-pro` | **NOT AVAILABLE** | CF model page defers to the dashboard and publishes no static rate |

At the default model and 1024x1024 (1 MP), a cloud keyframe is **0.015 per image** (DERIVED from the
first-megapixel rate). A 5-shot storyboard at one keyframe per shot is therefore about **0.075**.

**MEASURED, account level:** RunPod public-endpoint spend was **61.15 in July 2026** and **35.43 in
June 2026** (`get-billing` `scope=endpoints`). The API returns this line only as an account total; it
does **not** break down per endpoint slug, so cloud i2v spend cannot currently be attributed to a
model or a tenant from billing alone. That attribution has to come from the meter (cf#56).

Two module-level flags for the owning lane, not blockers here:

- `modules/minimax-hailuo` posts to `https://api.runpod.ai/v2/minimax-hailuo-2-3-fast` and
  `modules/google-veo` targets Veo, but neither appears in RunPod's current public-endpoint reference.
  Either the docs list is incomplete or those slugs moved. Worth a live confirmation before either is
  priced into a tenant-facing rate card.

## 3. Workers AI and AI Gateway (the planner/chat LLM surface)

All CITED RATE, retrieved 2026-07-27, from
<https://developers.cloudflare.com/workers-ai/platform/pricing/> and
<https://developers.cloudflare.com/ai-gateway/reference/pricing/>.

| Item | Rate |
| --- | --- |
| Workers AI base unit | 0.011 per 1,000 neurons; 10,000 neurons/day free |
| Llama 3.2 1B | 0.027 per M input tokens, 0.201 per M output tokens |
| Llama 3.1 70B | 0.293 per M input tokens, 2.253 per M output tokens |
| Mistral 7B | 0.110 per M input tokens, 0.190 per M output tokens |
| AI Gateway Unified Billing fee | **5%** on credits purchased (100 of credit costs 105) |
| AI Gateway inference | pass-through, no markup beyond the 5% credit fee |
| AI Gateway core features | free (analytics, caching, rate limiting, DLP) |
| Persistent logs | 100,000 (Workers Free) / 10,000,000 per gateway (Workers Paid); Logpush overage 0.05 per million beyond 10M/month |

Scope note worth keeping straight: Unified Billing applies only to **third-party** models. `@cf/`
Workers AI models routed through AI Gateway bill at Workers AI pricing, not Unified Billing, so the
5% does not apply to our own keyframe calls.

**Sizing the bundled allowance:** at Llama 3.1 70B rates, one million planner input tokens plus
100k output tokens costs about **0.52**. Even a generous per-tenant planner allowance is a rounding
error against a single film at 0.914. The bundled LLM allowance is not a cost driver; GPU is.
**NOT AVAILABLE:** our own AI Gateway analytics were not readable from this seat, so actual observed
planner token volume per tenant is unmeasured. That number should come from the meter.

## 4. CPU finishing (excluded from the meter by ruling)

CPU finishing runs on owned swarm iron, selected by the `tier=finishing` swarm label rather than a
fixed node list (measured 2026-08-01: descendents, badbrains, jello). It is included in the base by
ruling, so it carries **no meter rate**. It is recorded here for capacity planning only.

The finishing tier is five CPU containers reached over Workers VPC: `video-finish`, `audio-master`,
`audio-mix`, `audio-beat-sync`, `image-prep`.

**Wall-clock per finishing job: NOT AVAILABLE.** No per-container job duration is persisted anywhere:
the containers return no duration field, the core logs none, and the studio schema has no finishing
timing column. The only datapoint in the runlogs is a single observation of a finish clearing in
**40 s** once a healthy worker picked it up, which is one sample of one stage and must not be
generalized into a capacity model.

To make this measurable, the finishing containers would need to return an elapsed-milliseconds field
and the core would need to record it alongside the render row. That is a small change and is the
cheapest way to close this gap; it is not in this measurement pass.

## 5. Gaps, stated plainly

| Gap | Consequence |
| --- | --- |
| Per-stage GPU seconds are not persisted. Keyframe-batch and i2v-shot jobs both run on `t9wcvlxh8rc5la` as separate RunPod jobs, but nothing durable records which was which. | The two headline job classes cannot be split today. The dispatch-proxy meter (cf#56) captures `executionTime` per job at submit time and closes this by construction. |
| `execution_time_ms` on film history rows is **wall clock, not GPU time**. `film-render-bridge.ts` and `scatter-orchestrator.ts` set it to `Date.now() - job.created_at`; only direct single RunPod jobs carry the true billed `executionTime` from `runpod-submit.ts`. | Anyone costing a film from the render library would overstate GPU time by including queue delay, cold starts, and the CPU finish chain. Do not use that column as a billing basis. The meter must read RunPod's `executionTime`, exactly as `docs/managed-compute.md` specifies. |
| RunPod public-endpoint billing has no per-slug breakdown. | Cloud i2v cost cannot be attributed to a model or tenant from billing; it must be metered at call time. |
| LoRA training run history is not retained. `GET /api/cast` exposes `lora_status` and `lora_trained_at` (current state), not a job log. | Training attempt counts, including failed retries, are unrecoverable. 8 of 9 cast members have ever completed training. |
| Our AI Gateway analytics were not readable from this seat. | Observed planner token volume is unmeasured; only published rates are given. |

## 6. Credit-price implication (cost basis only, NOT the credit design)

Conrad's cp#173 ruling sets **5% margin over cost**, matching Cloudflare AI Gateway's Unified Billing
fee. Applying `cost x 1.05` to the measured basis:

| Job class | Measured cost | Credit price at +5% |
| --- | ---: | ---: |
| Render (keyframe + i2v), per GPU-hour | 6.353 | **6.671** |
| Cast-LoRA training, per GPU-hour | 6.772 | **7.111** |
| Upscale / lip-sync / audio-upscale, per GPU-hour | 3.454 to 3.494 | **3.627 to 3.669** |
| One cast-LoRA training run (`:train-0.2.1`) | 13.13 | **13.79** |
| One film (July mean, per submitted film) | 0.914 | **0.960** |

Three observations the credit design will need, offered as input to cp#173 and not as decisions:

1. **Two meter classes cover the GPU surface, not five.** The measured rates cluster hard: about
   6.35 to 6.77 per GPU-hour for the B200/H200 pool (render, train) and about 3.45 to 3.49 for the
   RTX PRO 6000 pool (upscale, lip-sync, audio). Within a cluster the spread is scheduling variance.
2. **Failed jobs cost real money** and are roughly a third of all submissions. Whether the tenant or
   the house eats a failed render is a pricing decision with a measurable price tag, not a detail.
3. **The 5% is thinner than it looks.** Cloudflare charges 5% on credit purchase (100 of credit for
   105), so the margin is 5% of cost but 4.76% of gross. Matching CF's posture means matching the
   purchase-fee shape, and it does not cover the RunPod cost of a job that fails and is retried.

## 7. Reproducing this

Every number above can be regenerated:

- Per-endpoint spend: RunPod MCP `get-billing`, `scope=serverless`, `bucketSize=month`, `lastN=3`.
  Account reconciliation: the same call with `scope=all`. Public endpoints: `scope=endpoints`.
- Live endpoint and GPU-pool map: RunPod MCP `list-endpoints`. Trust it over any cached table.
- Published rates: `list-gpu-types` for pod rates, <https://www.runpod.io/pricing> for serverless flex.
- Render history: studio `GET /api/storyboard/renders`.
- Training-run durations: `fleet-chezmoi/docs/runlog/2026-07-20-vivijure-wan-train-d2.md` and
  `2026-07-23-vivijure-wan-train-phase-e-deploy.md`.

Refresh this document when the GPU pools change, when a satellite is repinned to a materially
different image, or when the worker cap moves (a scale to 40 workers is planned for 2026-07-30).
July 2026 account spend also includes **97.962** on the five now-deleted vivijure-local endpoints and
**0.089** on testbed satellites; neither recurs, so July account totals are not a forward run rate.
The production figures in section 1 exclude both.
