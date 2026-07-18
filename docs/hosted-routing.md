# Hosted tier: routing + domains

How a request reaches a tenant studio on the hosted door (epic #40, issue #55). Companion to
`docs/DEPLOYMENT.md` (core deploy) and `docs/module-dispatch.md` (the Phase-3 module namespace).

This document is reproducible-from-docs by intent: everything below is either in
`wrangler.control-plane.toml.example`, `src/control-plane/routing.ts`, or a named zone change.

## The shape

```
   studio.vivijure.com            -->  control-plane Worker  -->  front door (signup / account / status)
   acme.studio.vivijure.com       -->  control-plane Worker  -->  dispatch: tenant-acme-studio
   globex.studio.vivijure.com     -->  control-plane Worker  -->  dispatch: tenant-globex-studio
                                            |
                                            +-- suspended / unknown / provisioning -> refused here,
                                                before dispatch (the kill switch)
```

One Worker owns both hostnames. The tenant slug is the LEFTMOST label. Each tenant studio is a user
Worker in the `vivijure-tenants` Workers-for-Platforms dispatch namespace, running the published
studio release unmodified (spec section 2: studio-instance-per-tenant).

## Why not a Custom Domain for the tenant leg

Workers Custom Domains do **not** support wildcards (spike-confirmed). So the tenant leg is the
classic pair instead:

- a **proxied wildcard DNS record** for `*.studio.vivijure.com` (a Worker route only fires on
  proxied DNS; house style on this zone is `AAAA -> 100::` proxied, confirmed against every existing
  Worker hostname there), and
- a **route** `*.studio.vivijure.com/*` bound to the control-plane Worker.

The front door (`studio.vivijure.com`) has no wildcard problem, so it stays a Custom Domain like the
core and the MCP Worker.

## TLS

`*.studio.vivijure.com` is a **second-level wildcard**: Universal SSL does not cover it. It needs an
Advanced Certificate Manager pack.

> **BLOCKED as of 2026-07-17 (#55). Do not trust an earlier "zero new spend" reading of this.**
>
> The verification spike concluded ACM was already active on `vivijure.com` (five wildcard packs
> exist) and that one more pack was therefore free. **That is wrong.** Pack *existence* proves they
> were ordered once; it does not prove the subscription is live now. The live reads:
>
> ```
> GET  /zones/{zone}/ssl/certificate_packs/quota  -> { advanced: { allocated: 0, used: 6 } }
> POST /zones/{zone}/ssl/certificate_packs/order  -> 1450 "available with the Advanced Certificate Manager"
> ```
>
> `allocated: 0` is the entitlement: **ACM is not currently active on this zone.** It is not a token
> scope problem (a control write to the DNS endpoint returns a validation error, not an auth error).
> The six existing advanced packs are residue, `active` but expiring 2026-10-04..08, and no new pack
> can be ordered.
>
> So the tenant wildcard needs either an ACM purchase (~$10/mo/zone, new recurring spend, Conrad`s
> call) or a hostname shape that avoids a second-level wildcard. Awaiting that decision; everything
> in this document describes the ruled `<tenant>.studio.<root>` shape and changes with it.

The **front door needs no new certificate either way**: the existing advanced pack covering
`vivijure.com` + `*.vivijure.com` already covers a first-level host like `studio.vivijure.com`. Only
the second-level tenant wildcard was ever the ACM dependency.

When a pack IS ordered, it must cover BOTH hostnames -- a wildcard does not cover its own parent:

| hostname | why |
|---|---|
| `studio.vivijure.com` | the front door (already covered today by `*.vivijure.com`) |
| `*.studio.vivijure.com` | every tenant studio -- the part that needs ACM |

The six existing advanced packs on the zone are all `certificate_authority: google`,
`validity_days: 90`, `validation_method: txt`, and all include the zone apex in `hosts`. Mirror them
rather than introduce an inconsistency.

### The certificate/route asymmetry (deliberate refusal)

A wildcard certificate covers exactly ONE label. A Cloudflare route pattern `*` matches **across
dots**. So `a.b.studio.vivijure.com` matches the route and reaches the Worker while being OUTSIDE
the certificate. `classifyHost()` refuses multi-label hosts explicitly rather than letting them fall
through to a confusing dispatch miss. Same reasoning refuses punycode labels (homograph of the front
door) and the reserved-label list (`www`, `api`, `admin`, ...).

## Deploy ordering (typecheck will not catch these)

1. **Create the dispatch namespace first.** `npx wrangler dispatch-namespace create vivijure-tenants`.
   (Done on the prod account 2026-07-17: `vivijure-tenants` exists and is empty.)
   A `[[dispatch_namespaces]]` binding is subject to the dangling-binding rule: the namespace must
   EXIST at deploy time or `wrangler deploy` of the control-plane Worker FAILS. Only a real deploy catches
   this.
   It is a NEW namespace, separate from `vivijure-modules`: tenant studios and modules must not share
   one, or script names collide and a module bug sits in the tenant blast radius.
2. **Control-plane D1** created + migrated (#52 / #53).
3. **Certificate + wildcard DNS record live on the zone** before the wildcard route serves
   traffic. **Currently BLOCKED** -- see the TLS section above.
4. Then deploy the control-plane Worker (`npm run deploy:control-plane`).

A tenant studio does NOT deploy through `wrangler.control-plane.toml`: the provisioner (#53) uploads it
into the namespace via the WfP API at signup.

## The error-1042 rule

The dispatcher **must mint a fresh `Request`** when invoking a user Worker; forwarding the inbound
Request object verbatim fails with Cloudflare error 1042. This is not theoretical: the section-9
spike hit exactly this (first dispatch 500`d; fresh-Request retry went green). `freshRequest()` owns
it, and a unit test asserts the dispatched object is not the inbound one.

Note `duplex: "half"` in `freshRequest()`: the fetch spec requires it whenever a stream body is sent.
workerd is lenient, but a spec-strict runtime (undici -- the Node host path, and our vitest env)
throws without it, which would break every POST through the dispatcher (i.e. every render submit).

## The front-door default (why unknown hosts are NOT refused)

`classifyHost()` returns **front-door** for anything not under `TENANT_DOMAIN_SUFFIX`, and refuses
only hosts that ARE under it but are not usable tenants. That default is load-bearing: this Worker is
legitimately reached on hostnames that are neither the front door nor a tenant -- `wrangler dev`
serves it on `127.0.0.1`, and the control-plane suite drives it on an arbitrary host. An earlier
draft refused every unrecognized host, which 404s the entire control plane off its own dev server.
The #52 test suite caught that, not review.

Only the tenant domain is ours to police. A host under the suffix that fails the slug rule gets a 404
rather than a front-door page, because a front-door page at `admin.studio.vivijure.com` would be a
lie about what lives there.

## The suspend path (admin kill switch)

Suspend is enforced in the DISPATCHER, from control-plane state, **before** dispatch:

| tenant state | response |
|---|---|
| `suspended_at` set (ANY lifecycle) | `403`, never reaches the namespace |
| lifecycle `live`, not suspended | dispatched to `tenant-<slug>-studio` |
| `pending` / `provisioning` / `awaiting_invoke_key` | `503` + `Retry-After: 30` |
| `failed` | `503`, honest: provisioning did not finish |
| `deleting` / `deleted`, or `deleted_at` set | `404` |
| no tenant row | `404` |
| `live` but `script_name` is null | `503`, honest failure (never a silent empty studio) |
| the store itself throws | `503` -- FAIL CLOSED: suspension cannot be verified, so we do not dispatch |

Because the refusal happens in the control-plane Worker, an admin flip takes effect on the next request
and holds **even if the tenant Worker is perfectly healthy**. It does not depend on the tenant studio
cooperating, which is the whole point of a kill switch.

## The control-plane seam (consumed, not duplicated)

Routing owns hostnames and nothing else. Everything else it needs already exists in #52:

| what | where it lives | why not in routing.ts |
|---|---|---|
| slug rules (shape, length, reserved, punycode) | `tenants.ts` `validateSlug()` | signup and routing MUST agree, or a tenant provisions at a hostname it can never be reached at |
| tenant lookup | `store.ts` `getTenantBySlug()` | one data seam; `D1Store` is production, `MemoryStore` backs tests |
| tenant record + lifecycle | `store.ts` `Tenant` | one definition of what a tenant IS |
| script name | `tenants.ts` `tenantScriptName()` | the provisioner (#53) creates under it; routing reads the STORED name |

**Suspension is read off `suspended_at`, never off `status`.** The store keeps suspension as an
orthogonal axis and never writes "suspended" into the lifecycle column (two independent facts, two
independent columns). Reading it off `status` would mean the kill switch never fires, because that
value is never stored there.

## Parity

There is no `vivijure.com` literal in the routing code or in the config: `CONTROL_PLANE_HOST`, `TENANT_DOMAIN_SUFFIX`, and
`CONTROL_PLANE_ZONE_NAME` are deploy-injected. The hosted door ships AGPL (Conrad ruling, 2026-07-17) and
anyone may run a competing hosted vivijure -- a hardcoded hostname would make that structurally
impossible, so it is a parity defect by definition, not a style preference.
