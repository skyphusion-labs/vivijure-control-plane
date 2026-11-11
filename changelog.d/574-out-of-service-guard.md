### ci(deploy): refuse a deploy while the plane is out of service (#574)

`deploy.yml` now refuses, as its first step, when the repo variable `CP_OUT_OF_SERVICE` is `1`. The plane was taken out of service on 2026-11-01, and any tag deploy would have re-added its custom domain, route and cron from `wrangler.toml.example`. A `workflow_dispatch` dry run still proceeds, because it never migrates or deploys. Unset or empty means in service; any other value refuses as malformed. `tests/workflow-guards.test.py` asserts the step stays first and that the release job still depends on preflight.
