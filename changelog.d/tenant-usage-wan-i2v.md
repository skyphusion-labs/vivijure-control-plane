### feat(admin): tenant usage view, wan-train on the shared pool, cloud i2v in the catalog

GET /api/admin/tenants/:id/usage lists every recorded RunPod / public-slug job
and every attributed AI Gateway row for that tenant, rolled up by module, with
optional SPEND_PRICEBOOK costs.

wan-train is an endpoint-backed plan key (RUNPOD_WAN_TRAIN_ENDPOINT_ID).
cf-grok-video / cf-seedance / cf-flux-3-video / cf-hh1-r2v join the tenant
catalog. Traefik door URLs stamp onto the studio when the plane vars are set.
