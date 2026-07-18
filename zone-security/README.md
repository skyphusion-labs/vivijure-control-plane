# Zone security (vivijure.com) -- IaC home

Edge protections for the vivijure.com zone (Cloudflare Pro, activated 2026-07-17). Nothing here is
dashboard-controlled; `apply-waf.sh` is the record and the mechanism.

This directory moved here from `vivijure-cf` in the cf#85 extraction, per Conrad standing
ruling that zone WAF IaC is owned by the project that wants it: the hosted plane wants it, so
it rides with the hosted plane. It is otherwise unchanged from the vivijure-cf original.

WAF stays in LOG MODE. The flip to enforce is a separate launch gate (vivijure-cf#40), not
part of the extraction.

## WAF managed rulesets

`./apply-waf.sh log` deploys the `http_request_firewall_managed` entrypoint with the Cloudflare
Managed Ruleset + OWASP Core Ruleset, everything overridden to `log` (observe, never block).
`./apply-waf.sh enforce` drops the overrides so managed defaults act; that flip is a
vivijure-cf#40 launch-checklist item and happens only after the log-mode tuning window is clean.

Needs `CLOUDFLARE_API_TOKEN` with Zone WAF Edit + Zone Read on vivijure.com (per-function token;
presence-check only, never echo). Managed-ruleset IDs are resolved from the API at apply time.

## Log-mode tuning window: what to watch

Security > Events (zone dashboard) or the GraphQL firewallEventsAdaptive dataset, filtered to
`action = log`. Watch for MATCHES ON LEGITIMATE TRAFFIC before any flip to enforce:

- `POST /api/auth/email/start` and `/api/tenant/provision` on studio.vivijure.com (JSON bodies;
  OWASP body-inspection rules are the classic false-positive source here).
- Tenant studio APIs on `*.studio.vivijure.com` (Bearer-token JSON clients, film submit payloads
  with long prompt text -- prompt prose can trip SQLi/XSS heuristics).
- demo.vivijure.com fetch flows (same-origin JSON).
- The OWASP anomaly score: on Pro, tune by raising the score threshold or lowering paranoia level
  BEFORE per-rule exceptions; record any exception as a rule override in `apply-waf.sh`, never a
  dashboard click.

## Super Bot Fight Mode: assessed, deliberately OFF

SBFM on the Pro plan is zone-wide and cannot be scoped by hostname or path, and WAF custom rules
cannot `skip` it (Enterprise Bot Management can; Pro SBFM cannot). Its "definitely automated"
verdict catches exactly our legitimate traffic: Bearer-token API clients against tenant studio
APIs, MCP consumers, curl-driven e2e and ops runs. Verified-bot allowance does not cover them
(they are not on Cloudflare's verified-bot list). Enabling it would break scripted clients on
`*.studio.vivijure.com` with no exemption mechanism at this plan tier.

Decision: leave SBFM OFF. Bot-shaped abuse on the signup door is already bounded by the
control plane's own rate limit (`CP_RATE_LIMIT`, 5/60s per email) and the WAF baseline above;
revisit only with observed bot pain, and then prefer WAF custom rules / rate-limiting rules
(path-scoped, loggable) over SBFM.
