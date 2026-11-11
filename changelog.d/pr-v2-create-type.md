### fix(runpod): an endpoint create sends the v2 routing type

`RunPodClient.createEndpoint` now sends `type: "QUEUE"`. The v2 create request requires it, along with `name` and `scaling`, and the call refused a fresh create without it (fleet-chezmoi#2083). An update takes no type and is unchanged.
