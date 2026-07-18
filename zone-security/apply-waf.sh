#!/usr/bin/env bash
# Zone-security IaC: WAF managed-ruleset baseline for a vivijure zone.
#
# Deploys the http_request_firewall_managed entrypoint ruleset: Cloudflare Managed Ruleset +
# Cloudflare OWASP Core Ruleset. Mode "log" observes without blocking (the tuning window);
# mode "enforce" removes the overrides so the managed defaults act (the pre-launch flip,
# vivijure-cf#40 launch checklist).
#
# Managed-ruleset IDs are RESOLVED from the API at apply time, never hardcoded (an ID read off
# someone's memory is a guess; the API is the record). Requires a token with Zone WAF Edit +
# Zone Read on the target zone in CLOUDFLARE_API_TOKEN. Idempotent: PUT replaces the entrypoint
# rules wholesale; re-running converges to this file's shape.
set -euo pipefail

ZONE_NAME="${ZONE_NAME:-vivijure.com}"
MODE="${1:-log}"
case "$MODE" in log|enforce) ;; *) echo "usage: $0 [log|enforce]" >&2; exit 2;; esac
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be set (zone-security token; never echo it)}"

api() { curl -sf -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" "$@"; }
BASE="https://api.cloudflare.com/client/v4"

ZID=$(api "$BASE/zones?name=$ZONE_NAME" | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; assert r, "zone not found"; print(r[0]["id"])')
echo "zone $ZONE_NAME = $ZID"

# Resolve the two managed rulesets by NAME from the account-level managed listing the zone sees.
# Refuse honestly if either is absent (entitlement not live yet) -- a baseline that silently
# deploys half its rulesets reads as done and is not.
LISTING=$(api "$BASE/zones/$ZID/rulesets")
resolve() {
  printf '%s' "$LISTING" | python3 -c '
import json,sys
name=sys.argv[1]
rs=[r for r in json.load(sys.stdin)["result"] if r.get("name")==name and r.get("kind")=="managed"]
assert rs, f"managed ruleset not offered on this zone: {name}"
print(rs[0]["id"])' "$1"
}
CF_MANAGED_ID=$(resolve "Cloudflare Managed Ruleset")
OWASP_ID=$(resolve "Cloudflare OWASP Core Ruleset")
echo "resolved: managed=$CF_MANAGED_ID owasp=$OWASP_ID"

if [ "$MODE" = "log" ]; then OVR=',"overrides":{"action":"log"}'; else OVR=""; fi
BODY=$(cat <<JSON
{
  "rules": [
    {
      "description": "Cloudflare Managed Ruleset (baseline; vivijure-cf zone-security)",
      "expression": "true",
      "action": "execute",
      "enabled": true,
      "action_parameters": {"id": "$CF_MANAGED_ID"$OVR}
    },
    {
      "description": "Cloudflare OWASP Core Ruleset (baseline; vivijure-cf zone-security)",
      "expression": "true",
      "action": "execute",
      "enabled": true,
      "action_parameters": {"id": "$OWASP_ID"$OVR}
    }
  ]
}
JSON
)
api -X PUT "$BASE/zones/$ZID/rulesets/phases/http_request_firewall_managed/entrypoint" \
  --data "$BODY" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["success"], d; rs=d["result"]; print("deployed entrypoint", rs["id"], "version", rs["version"]); [print(" -", r["description"], "| overrides:", r["action_parameters"].get("overrides", "NONE (enforce)")) for r in rs["rules"]]'

# Read-back: the deployed state is the fact, not the PUT response alone.
api "$BASE/zones/$ZID/rulesets/phases/http_request_firewall_managed/entrypoint" \
  | python3 -c 'import json,sys; rs=json.load(sys.stdin)["result"]; print("read-back version", rs["version"], "rules:", len(rs["rules"]))'
