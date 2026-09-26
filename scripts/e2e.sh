#!/usr/bin/env bash
# End-to-end run against a running stack: a customer books a counter-offer
# through the same API calls the booking site makes, the operator console's
# Live bookings panel sees it (replayed through js/live.js itself), and the
# on-chain deal settles.
#
# Only counter-offers (flex_window / alt_hub / split) register a settlement
# contract, so this accepts one of those — never a plain "as requested" offer.
#
# Delivery takes weeks of sim time, so run the stack at a faster live pace:
#     DOCK_LIVE_SPEED=0.5 docker compose up -d --build
#     scripts/e2e.sh                     # BASE defaults to http://localhost:8080
set -euo pipefail
cd "$(dirname "$0")/.."
export BASE="${BASE:-http://localhost:8080}"
export LIVE_JS="$PWD/drafts/cargo-ship/js/live.js"

python3 - <<'PY'
import json, os, subprocess, sys, time, urllib.error, urllib.request

API = os.environ["BASE"] + "/api"
COUNTER_KINDS = ("flex_window", "alt_hub", "split")

def call(path, body=None):
    req = urllib.request.Request(API + path, method="POST" if body is not None else "GET",
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{path}: HTTP {e.code} {e.read()[:300]!r}") from None

def fail(msg):
    print(f"  FAIL {msg}"); sys.exit(1)

def ok(msg):
    print(f"  ok   {msg}")

# The panel's own logic: node imports js/live.js and replays what the panel's
# poller received — seeded from /orders on its first poll, then the incremental
# feed with the exact type filter the poller uses.
PANEL = """
const { CUSTOMER_EVENT_TYPES, seedCustomers, trackCustomer, describeEvent } = await import(process.env.LIVE_JS_URL);
if (process.argv[1] === 'types') { console.log(CUSTOMER_EVENT_TYPES); process.exit(0); }
const { orders, episode, events } = JSON.parse(await new Promise(r => { let s = ''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => r(s)); }));
const reqs = new Map(), lines = [];
seedCustomers(orders, episode, reqs);
for (const ev of events) { trackCustomer(ev, reqs); const d = describeEvent(ev, reqs); if (d) lines.push(d); }
console.log(JSON.stringify(lines));
"""
NODE_ENV = dict(os.environ, LIVE_JS_URL="file://" + os.environ["LIVE_JS"])

def node(arg, stdin=""):
    return subprocess.run(["node", "--input-type=module", "-e", PANEL, arg], input=stdin,
                          capture_output=True, text=True, check=True, env=NODE_ENV).stdout

TYPES = node("types").strip()

class PanelFeed:
    """Polls /live/events the way js/live.js does (after_seq = next_seq,
    limit 1000); the endpoint only returns the latest matches, so polling has
    to run throughout, exactly like the open panel."""
    def __init__(self, episode_id):
        self.episode, self.after, self.events = episode_id, 0, []
        self.orders = call("/orders")

    def poll(self):
        res = call(f"/live/events?after_seq={self.after}&limit=1000&types={TYPES}")
        if res.get("episode_id") not in (None, self.episode):
            fail("the live world restarted before the deal settled")
        self.events += res["events"]
        self.after = res["next_seq"]

    def lines(self, oid):
        self.poll()
        out = node("replay", json.dumps({"orders": self.orders, "episode": self.episode,
                                         "events": self.events}))
        return [l["text"] for l in json.loads(out) if oid in l["text"]]

print("live world")
live = None
for _ in range(420):                  # a world restart (PPO + contract setup) takes minutes
    try:
        live = call("/live")
    except Exception:
        time.sleep(1); continue
    if live.get("day", 99) <= 20:      # leave room for a voyage before the 90-day horizon
        break
    time.sleep(1)
if not live or live["day"] > 20:
    fail(f"live world not at an early day (last: {live and live.get('day')})")
ep, horizon = live["id"], live["horizon_days"]
ok(f"episode {ep} · day {live['day']:.1f} of {horizon} · {live['speed_days_per_sec']} sim-days/s")

feed = PanelFeed(ep)                   # the operator's panel is open from here on
feed.poll()

print("customer: quote until a counter-offer appears")
routes = call("/routes")
lanes = sorted({(r["origin"], r["dest"]) for r in routes},
               key=lambda od: (od[1] not in ("NLRTM", "DEHAM"), od))   # alt-hub lanes first
order = offer = None
for dep in (3, 6, 10):
    for o, d in lanes:
        q = call("/orders", {"origin": o, "dest": d, "teu": 4, "weight_t": 40, "cargo_type": "dry",
                             "segment": "standard", "req_dep_day": dep, "flex_days": 0})
        feed.poll()
        day = call("/live")["day"]
        fits = [f for f in q["offers"] if f["kind"] in COUNTER_KINDS
                and f["board_day"] > day + 1 and f["eta_day"] < horizon - 2]
        if fits:
            order, offer = q["order"], min(fits, key=lambda f: f["eta_day"])
            break
        if q["offers"]:
            call(f"/orders/{q['order']['id']}/decline", {})
    if order:
        break
if not order:
    fail("no counter-offer (flex_window/alt_hub/split) that delivers inside this world's horizon")
oid = order["id"]
ok(f"{oid} {order['origin']}→{order['dest']} · offered {offer['kind']} "
   f"${offer['price_per_teu']:,.0f}/TEU · board D{offer['board_day']:.1f} · eta D{offer['eta_day']:.1f}")

print("customer: accept the counter-offer")
res = call(f"/orders/{oid}/accept", {"offer_id": offer["id"]})
st = res["order"]["status"]
if st not in ("CONFIRMED", "LOADING"):
    fail(f"accept -> {st}")
ok(f"accept -> {st}")
deal_id = None
for _ in range(20):
    deal_id = call(f"/orders/{oid}").get("deal_id")
    if deal_id:
        break
    time.sleep(0.5)
if not deal_id:
    fail("no deal registered for the order")
ok(f"deal registered on the order: {deal_id[:16]}…")

print("operator: Live bookings panel (js/live.js replay)")
lines = feed.lines(oid)
for want in (" quoted", " accepted", " deal registered"):
    if not any(want in l for l in lines):
        fail(f"panel has no '{want.strip()}' line for {oid}: {lines}")
for l in lines:
    print(f"       {l}")
decision = [e for e in feed.events if e["type"] == "booking.decision"
            and e.get("order_id") == oid and e.get("source") == "customer"]
if not decision:
    fail("no customer booking.decision")
ok("quoted, accepted, customer booking.decision and deal registered lines present")

print("voyage + settlement")
seen, deal = set(), None
for _ in range(240):
    feed.poll()
    o = call(f"/orders/{oid}")
    if o["status"] not in seen:
        seen.add(o["status"]); ok(f"order status {o['status']}")
    deal = call(f"/episodes/{ep}/deals/{deal_id}")
    if deal["status"] == "settled":
        break
    time.sleep(1)
if not deal or deal["status"] != "settled":
    fail(f"deal never settled (status {deal and deal['status']})")
# settlement fires on the same delivery event that marks the order DELIVERED
for _ in range(10):
    if "DELIVERED" in seen:
        break
    if call(f"/orders/{oid}")["status"] == "DELIVERED":
        seen.add("DELIVERED"); ok("order status DELIVERED")
        break
    time.sleep(0.5)
else:
    fail("order never reached DELIVERED")
tx = (deal.get("tx") or {}).get("settle")
tx = tx.get("tx_hash") if isinstance(tx, dict) else tx
if not tx:
    fail("settled deal has no settle tx hash")
ok(f"deal settled: {deal['settled_outcome']} · ${deal['settled_amount_usd']:,.2f} · "
   f"contract {deal['contract']} · settle tx {tx[:18]}…")

lines = feed.lines(oid)
for want in (" departed", " delivered", " settled"):
    if not any(want in l for l in lines):
        fail(f"panel has no '{want.strip()}' line for {oid}: {lines}")
print("  panel feed for the order:")
for l in lines:
    print(f"       {l}")
ok("customer booked -> operator saw it live -> deal settled")
PY
