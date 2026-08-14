### feat(ci): fail when STUDIO_RELEASE trails the published studio artifact (cf#372)

`STUDIO_RELEASE` is the single value deciding which studio code a hosted tenant runs, and self-host
pulls the same tag straight from the vivijure-cf release. When the pin trails, hosted and self-host
run different code from the same nominal tag, against the absolute hosted/self-host parity
invariant. Nothing anywhere compared those two numbers, so the parity gate read green at the TAG
while being violated at the RUNTIME; the pin went stale three times, and twice the remedy was to
bump the value, which has a 100% recurrence rate.

`scripts/check-studio-pin.mjs` is a sibling of `check-satellite-pins.mjs` and deliberately its
shape: exit 0 current, 1 real drift, 2 could not be PERFORMED and never a pass. RELEASE mode is
credential-free and now runs in `deploy.yml` preflight, so **a control-plane deploy refuses while
its pin trails the latest published studio release** -- advancing the pin stops being a follow-up to
a release and becomes a precondition of one. It is deliberately not the deployed-binding mode
there: during a deploy that binding is exactly what is about to change, and a check that fires on
normal operation is a check somebody mutes.

The second mode is why this is two checks rather than one. The Actions variable is a PROPOSAL:
`render-wrangler.sh` interpolates it into `[vars]` at DEPLOY time and `deploy.yml` fires on a `v*`
tag only, so between setting the variable and cutting a tag the variable reads NEW and the deployed
binding reads OLD. Measured 2026-08-14, control first: variable `v1.26.0`, latest published release
`v1.26.0`, **deployed binding `v1.20.0`**. A check reading only the variable would have been green
with hosted six releases behind. `studio-pin-drift.yml` runs daily on `ubuntu-latest` and reads the
live Worker binding, with a known-positive on the same credential and object class in the same run
because a scope-limited Cloudflare credential returns `success: true` with an empty result.

No tolerance knob, deliberately: a chosen hosted lag is a legitimate answer and belongs in the
script as a reviewed change carrying its reason, not as an env var anyone can set to infinity in a
green run. `tests/workflow-guards.test.py` gains structural assertions so the wiring cannot vanish,
including an ABSENCE assertion that no workflow redirects the checker's endpoint bases -- the one
edit that would leave it green while measuring nothing.
