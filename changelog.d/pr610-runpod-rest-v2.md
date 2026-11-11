### fix(runpod): the plane's RunPod client and operator scripts move to REST v2

RunPod REST v1 retires 2026-11-15 (fleet-chezmoi#2083). `RunPodClient` (`src/runpod.ts`), `scripts/reconcile-runpod.mjs` and `scripts/check-satellite-pins.mjs` now call `https://api.runpod.io/v2`, with the shapes from RunPod's v2 OpenAPI:
- endpoints under `/v2/serverless`, every list walked to its last page by cursor;
- templates with `image`, `serverless` and `disk`;
- endpoints created with `gpu.pools` (mapped from the plan's GPU types: H200 to `HOPPER_141`, B200 to `BLACKWELL_180`), nested `workers` and `scaling`.

A v2 template is applied once and keeps no link to its endpoint, so a live endpoint is re-pinned or re-envd with the new `updateEndpointImage` and `updateEndpointEnv` (`PATCH /v2/serverless/{id}`). The pin check reads each pinned endpoint's own `image`. `listWasWhole` accepts v2's `pagination.hasNextPage: false` as a whole page; any other pagination block is not whole. A test fails if `src/` or `scripts/` names the v1 host. The serverless invoke API (`/run`, `/status`, `/cancel`, `/health` on the `.ai` host) is a different product and is unchanged.
