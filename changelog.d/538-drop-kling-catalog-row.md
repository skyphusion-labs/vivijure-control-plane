### fix(catalog): drop the `kling` row -- its RunPod slug is gone, so the door fails at every submit (cp#538)

`TENANT_MODULE_CATALOG` carried `{ module: "kling", publicEndpoint: "kling-v2-1-i2v-pro" }`, and
that slug returns 404 endpoint-not-found from RunPod today (it answered 401-exists on 2026-08-05, so
it was retired upstream between those dates; vivijure-cf#921, cf#941). A hosted tenant provisioned
from this catalog got a door that installs, passes `/ready`, and then fails **100% of submits**.

Different class from the four `cf-*` rows in cp#526: those are latent and have never executed. This
one would have been hit by the first tenant to pick that door.

Retirement is strictly dominant, measured rather than assumed: all 41 live RunPod public endpoints
were enumerated across three pages with no truncation, and neither surviving Kling endpoint does
plain i2v (one needs a reference motion video the `motion.backend` hook has no field for; the other
is multi-reference r2v, already shipped as the separate `kling-o1-r2v` door). There is no repoint,
only a removal. And `vivijure-cf/wrangler.toml.example:387` already said "Kling 2.1 stays in
modules/kling but is NOT bound on hosted" while this catalog shipped it to hosted tenants anyway --
the repo had half-decided it and the halves disagreed.

Every count typed beside the catalog moves with the row, which is the part that usually rots:
`writesTenantRenders` twelve-of-seventeen to eleven-of-sixteen, `reachesRunpod` 12-of-17 to 11-of-16,
"seventeen times" to sixteen, `docs/control-plane.md`'s catalog size and recorder count, and the
telemetry suite's "twelve modules record" to eleven. Two hand-maintained lists that say in their own
comments that they exist to FAIL when the catalog moves did exactly that and were followed, not
re-derived; two fixtures that only needed *a* public-slug module now use `seedance`.

`kling-v2-1-i2v-pro` STAYS in `PUBLIC_ENDPOINT_ALLOWLIST`: that list is pinned to a census of module
sources that hard-code a public slug, and `modules/kling` still does. Retiring the module itself is
vivijure-cf#921, in the repo that owns it.
