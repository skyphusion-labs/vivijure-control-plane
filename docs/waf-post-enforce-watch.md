# Standing post-enforce WAF watch: OWASP 949110 (cp#14)

**Domain:** `vivijure.com` (and studio / demo / mcp hostnames on the same zone).
**Mode:** enforce since 2026-07-18 (tuning window had zero legitimate blocks).

## Why this exists

OWASP does not block per contributing rule. Rules add an anomaly **score**; the single rule that
blocks is **`949110` Inbound Anomaly Score Exceeded** (Cloudflare rule id
`6179ae15870a4bb7b2d480d4843b323c`, action `block`, score threshold **40**, ruleset
`4814384a9e5d4991b9815dcfc25d2f1f`).

Legitimate vivijure traffic **does** score (headers, missing Accept, scanners, curl e2e). During
the enforce flip window the aggregate stayed under 40 and 949110 fired **0** times. There is no
"about to block" signal -- the first symptom of a threshold crossing is a **user-visible 403 on a
JSON POST**.

## Standing check

**Signal:** `949110` fired count stays **0** on legitimate surfaces (or every fire is attributable
to scanners, not studio/demo/mcp API clients).

**GraphQL** (`firewallEventsAdaptiveGroups`), filter `ruleId = "6179ae15870a4bb7b2d480d4843b323c"`.
Any non-zero count on a non-scanner path is the signal. Re-query on a schedule (weekly is enough
while quiet; daily after a client change that lengthens prompts or changes headers).

### Surfaces that score in normal traffic

- `studio.vivijure.com/` and `/api/*`
- `studio-mcp.vivijure.com/mcp`
- `search-internal.skyphusion.org` / internal MCP (if on same zone policy)
- `demo.vivijure.com/`
- apex + `www` + static assets

### Score-contributing rules seen on legitimate traffic (2026-07-18 window)

| events (window) | rule | what trips it |
| --- | --- | --- |
| 6365 | 920274 Invalid character in request headers | normal browser + API client headers |
| 3072 | 930130 Restricted File Access Attempt | mostly scanners |
| 2230 | 920300 Request Missing an Accept Header | API/MCP clients and curl e2e |
| 195 | 920440 URL file extension restricted | asset requests |
| 10 | 913101 User-Agent associated with scripting | curl e2e / ops |

Shape of healthy: several score rules fire steadily, aggregate under 40, **949110 silent**.

## If 949110 fires on a real client

1. Pull the event: path, UA, score breakdown, rule ids that contributed.
2. Prefer fixing the client (Accept header, body shape) over a permanent exception.
3. Only add a WAF exception with a narrow path/method/host match and a ticket; never a zone-wide
   disable of OWASP.
4. Record the incident in the security log; do not treat a one-off scanner as a product fire.

## Not a substitute for

- CI, typecheck, or deploy gates
- Application auth / rate limits
- Content-access audit (cp#120)

## Source

Landed from issue cp#14 so the measurement and procedure do not live only in an issue body.

