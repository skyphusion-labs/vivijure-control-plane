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

**QUERY A CONTRIBUTING RULE IN THE SAME PASS. THIS IS NOT OPTIONAL, AND HERE IS WHY.**

The signal above is an ABSENCE, and on its own **it cannot fail**. A healthy zone returns zero
rows. So does a stale rule id, a rotated ruleset id, the wrong zone, an expired token, or a
renamed schema field. **Every one of those yields `0`, which this document defines as healthy** --
there is no state in which the check can report *"I could not look"*.

That is worse here than it would be elsewhere, by this document's own argument: there is no
"about to block" warning and the next symptom is a user-visible 403. A silently broken query does
not degrade the early warning, it **removes the only one**, and nothing in the output changes when
it does.

So query **`920274`** (Invalid character in request headers) alongside it. It is the highest-volume
contributing rule in the table below and is expected to be busy:

| result | reading |
|---|---|
| `920274` in the thousands, `949110` zero | **healthy** -- the zero is a measurement |
| both zero | **THE INSTRUMENT IS BROKEN**, not the zone quiet. Fix the query before believing anything |
| `949110` non-zero on a non-scanner path | the signal -- see below |

One extra filter on a query the operator already runs, and it converts an unfalsifiable zero into
a measured one.

**AND THE SIBLING CONTROL IS NOT SUFFICIENT ON ITS OWN. Read this before trusting it.**

It detects every failure that drives BOTH queries to zero -- wrong zone, expired token, renamed
schema field, wrong time window, rotated ruleset id. **It cannot detect a rotation of
`6179ae15870a4bb7b2d480d4843b323c` itself**, which is the one identifier the entire signal rests on:
that filter would match nothing and return zero while `920274` stayed in the thousands, which is
row 1 of the table above -- *"healthy, the zero is a measurement"*. **Not caught, and actively
mis-reported as healthy.**

The reason is general and worth stating: **a sibling-volume comparison tests everything the two
queries SHARE and cannot test the field that DISTINGUISHES them.** The threshold has the same hole
-- a raise above 40 also reads healthy.

**So the sibling control is necessary and not sufficient. Pair it with a POSITIVE EXISTENCE PROBE,
on the same schedule:**

> assert that rule id `6179ae15870a4bb7b2d480d4843b323c` still resolves inside ruleset
> `4814384a9e5d4991b9815dcfc25d2f1f`, and that its score threshold is still 40.

That probe has a real **not-found** result, which is exactly the *"I could not look"* state this
document rightly says the raw signal lacks. A volume comparison can never supply it for its own
identifier.

**Runnable form matters here.** The filter above takes a 32-hex `ruleId`; `920274` is an OWASP rule
NUMBER and this document does not give its id form. Resolve and record `920274`'s `ruleId` before
relying on the control -- **an improvised filter that matches nothing returns zero, which the table
reads as instrument-broken, so the control fails closed on its own under-specification.** That is
the safe direction and still needs fixing.

### The three identifiers are Cloudflare's, and they move without telling us

Rule id `6179ae15870a4bb7b2d480d4843b323c`, ruleset `4814384a9e5d4991b9815dcfc25d2f1f` and the
score threshold **40** are **observed values, not constants we control** -- recorded here as read
during the cp#14 enforce-flip window (2026-08-05). They are not re-verified by this document and
nothing notifies us if they change. **Do not read the contributing-rule control as covering a
rotation of the 949110 id itself -- it does not, per the section above; the existence probe is what
covers that.** Re-read all three from the live zone when either control fires.

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

