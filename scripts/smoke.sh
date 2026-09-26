#!/usr/bin/env bash
# End-to-end smoke test against a running stack (`docker compose up`).
# Everything goes through the ui service (nginx on :8080), the same path a
# browser takes. Used by CI; run it locally any time:
#     scripts/smoke.sh                    # default BASE=http://localhost:8080
#     BASE=http://host:port scripts/smoke.sh
set -uo pipefail

BASE="${BASE:-http://localhost:8080}"
API="$BASE/api"
pass=0; fail=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect() {  # expect <name> <want-code> <curl args...>
  local name=$1 want=$2; shift 2
  local got; got=$(status "$@")
  [ "$got" = "$want" ] && ok "$name ($got)" || bad "$name (want $want, got $got)"
}
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

echo "sites"
expect "operator console  /"                    200 "$BASE/"
expect "operator js       /js/main.js"          200 "$BASE/js/main.js"
expect "customer intake   /customers/"          200 "$BASE/customers/"
expect "customer dashboard /customers/dashboard/" 200 "$BASE/customers/dashboard/"
expect "shared api client        " 200 "$BASE/customers/shared/api.js"
expect "offer slip component      " 200 "$BASE/customers/shared/offers.js"
expect "missing file is a 404"                  404 "$BASE/customers/no-such-file.json"
for page in "" dashboard/ intake-a/ intake-b/ intake-c/ intake-d/; do
  html=$(curl -s "$BASE/customers/$page")
  if echo "$html" | grep -q 'shared/api.js' && echo "$html" | grep -q 'shared/offers.js'; then
    ok "customers/$page uses the shared API client + offer slip"
  else
    bad "customers/$page is missing shared/api.js or shared/offers.js"
  fi
done

echo "api (through nginx /api)"
expect "health"          200 "$API/health"
expect "ports"           200 "$API/ports"
expect "vessels"         200 "$API/vessels"
expect "routes"          200 "$API/routes"
expect "compare/summary" 200 "$API/compare/summary"

echo "live simulation"
live=""
for _ in $(seq 1 60); do             # the live world loads PPO on startup
  live=$(curl -s "$API/live" | json 'd.get("id","")' 2>/dev/null)
  [ -n "$live" ] && break; sleep 1
done
[ -n "$live" ] && ok "GET /live -> episode $live" || bad "live simulation never came up"
expect "vessel stowage" 200 "$API/live/vessels/VES1/stowage"
expect "policy network" 200 "$API/live/policy/network"
n=0
for _ in $(seq 1 60); do             # the policy thread starts right after /live comes up
  n=$(curl -s "$API/live/policy" | json 'len(d["decisions"])' 2>/dev/null)
  [ "${n:-0}" -gt 0 ] && break; sleep 1
done
[ "${n:-0}" -gt 0 ] && ok "policy trace has $n live decisions" \
  || { bad "no live policy decisions after 60s"; curl -s "$API/live" | head -c 400; echo; }

echo "customer booking (quote -> accept, Postgres)"
oid=""; offer=""
for dep in 5 9 14 20 26 33 40 5 12 19; do
  q=$(curl -s -X POST "$API/orders" -H 'content-type: application/json' \
    -d "{\"origin\":\"CNSHA\",\"dest\":\"NLRTM\",\"teu\":6,\"weight_t\":60,\"cargo_type\":\"dry\",\"segment\":\"standard\",\"req_dep_day\":$dep,\"flex_days\":3}")
  oid=$(echo "$q" | json 'd["order"]["id"]')
  offer=$(echo "$q" | json '(d["offers"] or [{}])[0].get("id","")')
  [ -n "$offer" ] && break
  sleep 1
done
[ -n "$oid" ] && ok "POST /orders -> $oid" || bad "POST /orders returned no order"
if [ -n "$offer" ]; then
  ok "quote has offers (first: $offer)"
  st=$(curl -s -X POST "$API/orders/$oid/accept" -H 'content-type: application/json' \
    -d "{\"offer_id\":\"$offer\"}" | json 'd.get("order",{}).get("status","")')
  case "$st" in CONFIRMED|LOADING) ok "accept -> $st";; *) bad "accept -> '$st'";; esac
  src=$(curl -s "$API/live/events?types=booking.decision&limit=1000" \
    | json "next((e.get('source','') for e in d['events'] if e.get('order_id')=='$oid'), '')")
  [ "$src" = "customer" ] && ok "booking.decision recorded for the customer" || bad "no customer booking.decision"
else
  bad "no offers in any window (live world may be saturated)"; echo "  last quote: $(echo "$q" | head -c 600)"
fi
expect "bad OD pair rejected" 422 -X POST "$API/orders" -H 'content-type: application/json' \
  -d '{"origin":"NLRTM","dest":"USNYC","teu":1,"weight_t":5,"cargo_type":"dry","segment":"standard","req_dep_day":10,"flex_days":0}'

echo "episode (simulator + ledger)"
# a short flat-out static episode alongside the live one; stop any other ad-hoc run first
for running in $(curl -s "$API/episodes" | json '" ".join(e["id"] for e in d if e["status"] in ("running","paused") and not e.get("live"))'); do
  curl -s -o /dev/null -X POST "$API/episodes/$running/control" -H 'content-type: application/json' -d '{"action":"stop"}'
done
ep=$(curl -s -X POST "$API/episodes" -H 'content-type: application/json' \
  -d '{"policy":"static","scenario":"baseline","seed":7,"horizon_days":5,"speed_days_per_sec":0}' | json 'd.get("id","")')
[ -n "$ep" ] && ok "POST /episodes -> $ep" || bad "POST /episodes returned no id"
st=""
for _ in $(seq 1 60); do
  st=$(curl -s "$API/episodes/$ep" | json 'd.get("status","")')
  [ "$st" = "done" ] || [ "$st" = "error" ] && break
  sleep 1
done
[ "$st" = "done" ] && ok "episode finished" || bad "episode status: $st"
v=$(curl -s "$API/episodes/$ep/ledger/verify" | json 'd.get("ok")')
[ "$v" = "True" ] && ok "ledger hash chain verifies" || bad "ledger verify: $v"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
