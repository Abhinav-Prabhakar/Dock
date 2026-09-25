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
expect "missing file is a 404"                  404 "$BASE/customers/no-such-file.json"

echo "api (through nginx /api)"
expect "health"          200 "$API/health"
expect "ports"           200 "$API/ports"
expect "vessels"         200 "$API/vessels"
expect "compare/summary" 200 "$API/compare/summary"

echo "orders round-trip (Postgres)"
id=$(curl -s -X POST "$API/orders" -H 'content-type: application/json' \
  -d '{"origin":"CNSHA","dest":"NLRTM","teu":2,"weight_t":20,"cargo_type":"dry","segment":"standard","req_dep_day":40,"flex_days":1}' \
  | json 'd.get("id","")')
[ -n "$id" ] && ok "POST /orders -> $id" || bad "POST /orders returned no id"
got=$(curl -s "$API/orders/$id" | json 'd.get("id","")')
[ "$got" = "$id" ] && ok "GET /orders/$id" || bad "GET /orders/$id"
expect "bad OD pair rejected" 422 -X POST "$API/orders" -H 'content-type: application/json' \
  -d '{"origin":"NLRTM","dest":"USNYC","teu":1,"weight_t":5,"cargo_type":"dry","segment":"standard","req_dep_day":40,"flex_days":0}'

echo "episode (simulator + ledger)"
# a short flat-out static episode; stop anything already running first
for running in $(curl -s "$API/episodes" | json '" ".join(e["id"] for e in d if e["status"] in ("running","paused"))'); do
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
