# Dock API — live backend reference

The Dock backend is a **live** FastAPI server. Two static sites — the
customer booking site (`customers/`) and the operator console
(`drafts/cargo-ship/`) — talk to it over REST + one WebSocket; every episode
runs a real simulator instance day-by-day and streams events as they happen.

```bash
docker compose up --build
# operator console: http://localhost:8080
# customer site:    http://localhost:8080/customers/
# API (same-origin, behind nginx): http://localhost:8080/api/...
```

The `api` container has no host port of its own — it's only reachable
through `ui`'s (nginx) same-origin `/api` proxy, exactly the way the browser
sees it. Postgres comes up first (`db`), then `api` runs Alembic migrations
(`alembic upgrade head`: `0001` orders table, `0002` order-id sequence,
`0003` offers table + order↔simulation links) before serving traffic.

Running uvicorn directly is the non-Docker path (from `backend/`, needs a
reachable `DATABASE_URL`):

```bash
.venv/bin/uvicorn server.app:app --port 8399
```

Base URL below is `http://localhost:8080/api` under `docker compose`, or
`http://localhost:8399` when running uvicorn directly. All responses are
JSON. Errors are standard FastAPI `{"detail": "..."}` with HTTP status
codes — nothing silently degrades; a missing forecaster artifact, missing
checkpoint, or bad scenario name returns an explicit error.

## Concepts

- **Episode** — one simulator run: `{policy, scenario, seed, horizon_days}`.
  Runs on a server thread, advancing one sim-day per `1/speed` seconds.
  **One ad-hoc episode at a time** (409 otherwise); finished episodes stay
  queryable. The always-on live simulation (below) doesn't count against
  this limit.
- **Live simulation** — an always-on episode, started at server startup and
  auto-restarted whenever it reaches its horizon (a fresh seed each time):
  PPO policy, baseline scenario, 1 sim-day/minute by default, 90-day
  horizon. Both sites read it for their live view, and it's what customer
  quotes are priced against (`POST /orders`); it never blocks a separate
  `POST /episodes` run. `GET /live*` reads it; `503` while it's still
  starting or between a restart.
- **Event stream** — every sim event is appended to a **hash-chained JSONL
  ledger** (`backend/runs/ledger/<episode_id>.jsonl`, Keccak-256) and pushed to
  WebSocket subscribers. Events carry `seq`, `prev_hash`, `hash`.
- **Customer orders** — a customer's booking request, priced live against the
  simulation's own policy and bid-price engine, stored in Postgres
  (`orders` / `offers` tables). See **Orders** below.
- **Deals** — conditional bookings (`flex_window`/`alt_hub`/`split` counters)
  become settlement contracts on a **real local EVM** (in-process py-evm via
  eth-tester; contract `backend/settlement/DockSettlement.sol` deployed per
  episode — real tx hashes, real contract address). The backend is the oracle
  writing departure/delivery confirmations.
- **Compare artifacts** — the precomputed 5-policy export
  (`backend/demo/*.json`) is served read-only; generating it takes minutes, so
  it is batch-produced by `scripts/export_demo.py`, not computed on demand.

## REST endpoints

### Meta / reference data

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `{"ok": true}` |
| GET | `/policies` | `[{id, label, desc}]` — `static`, `greedy`, `heuristic`, `heuristic_bid`, `ppo` |
| GET | `/scenarios` | full scenario JSONs (10): `scenario_id, split, description, base_demand_mult, shock_*, port_closures, …` |
| GET | `/ports` | 8 ports: `port_id, name, lat, lon, berths, daily_capacity_teu, base_congestion, tz_offset, mean_dwell_days, base_wait_hours` |
| GET | `/vessels` | 4 vessels: `vessel_id, name, capacity_teu, reefer_plugs, min/service/max_speed_kt, fuel_a/b_tpd, age_years, draft_m, loop` |
| GET | `/routes` | 18 routes: `origin, dest, base_teu_wk, market_usd_per_teu, lane, direction` |
| GET | `/models/report` | `models/artifacts/report.json` — train/holdout split, demand MAPE, elasticity/WTP estimated-vs-true |

### Episodes (ad-hoc)

**`POST /episodes`** — start an ad-hoc episode (separate from the always-on
live simulation).

```json
{ "policy": "heuristic",          // static|greedy|heuristic|heuristic_bid|ppo
  "scenario": "baseline",         // any id from GET /scenarios
  "seed": 42,
  "horizon_days": 90,
  "speed_days_per_sec": 20 }      // 0 = flat out; clamped to [0.5, 120]
```
→ `201` episode descriptor:
```json
{ "id": "78d290dcc35c", "policy": "heuristic", "scenario": "baseline",
  "seed": 42, "horizon_days": 90, "speed_days_per_sec": 20.0,
  "status": "running", "day": 0.0, "error": null,
  "n_events": 0, "n_deals": 0, "created_at": 1789500798.67, "live": false }
```
Errors: `400` unknown policy/scenario · `409` an ad-hoc episode is already
running · `500` config failure (e.g. missing forecaster — the message names it).

| Method | Path | Returns |
|---|---|---|
| GET | `/episodes` | `[descriptor]` — all episodes incl. the live one and finished ones |
| GET | `/episodes/{id}` | **snapshot** (below) |
| POST | `/episodes/{id}/control` | `{"action": "pause"|"resume"|"stop"|"set_speed", "speed"?: float}` → descriptor |
| GET | `/episodes/{id}/events?after_seq=0&limit=500` | `{"events": [...], "next_seq": n}` — REST fallback for the WS stream |
| GET | `/episodes/{id}/deals` | `[deal]` — contract records (below) |
| GET | `/episodes/{id}/deals/{deal_id}` | one deal |
| GET | `/episodes/{id}/ledger?after_seq&limit` | events read back from the .jsonl file |
| GET | `/episodes/{id}/ledger/verify` | `{"ok": true, "n_events": n, "first_bad_seq": null, "detail": "..."}` |

**Snapshot** (`GET /episodes/{id}`, real example from the live episode):
```json
{ "id": "79de9a369519", "policy": "ppo", "scenario": "baseline",
  "status": "running", "day": 5.0, "horizon_days": 90,
  "metrics": { "cum_revenue": 4863909.62, "cum_profit": 4567036.72,
               "teu_booked": 3237.0, "utilization": 0.0,
               "requests": 482, "accepted": 174, "rejected": 223,
               "countered": 23, "counter_won": 5,
               "fuel_tonnes": 430.0, "co2_tonnes": 1354.5,
               "costs": { "fuel": 271873.0, "carbon": 0.0,
                          "port_fees": 25000.0, "demurrage": 0.0,
                          "reposition": 0.0, "lease": 0.0, "roll_comp": 0.0 } },
  "vessels": [ { "vessel_id": "VES1", "name": "Pacific Aurora", "mode": "PORT",
                 "port": "CNSHA", "from_port": null, "to_port": null,
                 "leg_start_day": null, "leg_end_day": null,
                 "progress": null,   // fraction along the current leg when at sea —
                                     // interpolate port coords for the map
                 "onboard_teu": 0, "speed_kt": 16.0 }, "…" ],
  "empties": { "CNSHA": 500.0, "SGSIN": 500.0, "…": "…" } }
```

### Orders (customer bookings)

Shared store between the customer site and the operator console; no
auth by design (one portal per customer company, one ledger on the operator
side). An "order" is one booking request for a single cargo type. Backed by
Postgres (`orders` + `offers` tables, owned by the Alembic migrations — no
seed rows; a fresh database starts empty).

**`POST /orders`** — price a request against the live simulation.
`req_dep_day` is **days from now** (the live sim clock) — how the customer
site expresses its calendar window.

```json
{ "origin": "CNSHA", "dest": "NLRTM", "teu": 4, "weight_t": 40,
  "cargo_type": "dry", "segment": "standard",
  "req_dep_day": 5, "flex_days": 3 }
```

The offer menu is the policy's own booking action space (accept / flex-window
counter / alt-hub counter / split), filtered by the same feasibility mask the
simulator applies to simulated cargo (`env.fleet_env.booking_mask` — capacity
+ stowage solver) and priced by the same live bid-price engine
(`sim.pricer.quote`). An offer is **never** priced below the bid-price floor —
a counter that would clear under opportunity cost is withheld rather than
shown. `recommendation` is what the live PPO policy would do with this exact
request (a masked forward pass — `policy_view.evaluate`). If no offer clears
the floor, `offers` is empty and the order is stored as `NO OFFER` (recorded
so the operator still sees turned-away demand). `422` on validation failure
(bad port/OD pair/cargo_type/segment/`req_dep_day < 0.5`); `503` when the
live simulation is down — nothing is stored in that case.

→ `201`, real example:
```json
{ "order": { "id": "BK-2403-TC", "origin": "CNSHA", "dest": "NLRTM",
             "teu": 4, "weight_t": 40.0, "cargo_type": "dry",
             "segment": "standard", "req_dep_day": 5.0, "flex_days": 3,
             "status": "QUOTED", "created": 1790392772.28,
             "vessel": null, "voyage": null, "eta": null, "progress": 0.0,
             "price_usd": null, "episode_id": "79de9a369519",
             "request_id": 482, "offer_id": null, "deal_id": null,
             "board_day": null, "eta_day": null, "discharge_port": null },
  "offers": [ { "id": "BK-2403-TC-O1", "order_id": "BK-2403-TC",
                "kind": "accept", "action": 1,
                "price_per_teu": 1587.28, "total_usd": 6349.12,
                "discount_pct": 0.0, "discharge_port": "NLRTM",
                "board_day": 7.78, "eta_day": 38.52,
                "legs": [ { "vessel_id": "VES1", "vessel": "Pacific Aurora",
                            "teu": 4, "board_day": 7.78, "eta_day": 38.52 } ],
                "summary": "Pacific Aurora sails in 3 days, inside your window — arrives in ~34 days.",
                "pricing": { "bid_price": 531.28, "market_rate": 1541.05,
                             "reason": "market_uplift", "list_price": 1587.28 },
                "prob": 0.9641, "recommended": true, "status": "open",
                "created": 1790392772.28 } ],
  "recommendation": { "action": 1,
                       "label": "Pacific Aurora sails in 3 days, inside your window — arrives in ~34 days.",
                       "prob": 0.9641, "value": -463.02,
                       "attribution": [ { "idx": 15, "label": "opt0 leg capacity", "w": -1.0, "x": 0.605 }, "…" ] } }
```

Offer object fields: `id, order_id, kind` (`accept|flex_window|alt_hub|split`),
`action` (policy action index), `price_per_teu, total_usd, discount_pct,
discharge_port, board_day, eta_day, legs[]` (per-leg `vessel_id, vessel, teu,
board_day, eta_day`; two legs for a split), `summary` (plain-English), `pricing`
(bid-price engine detail: `bid_price, market_rate, reason, list_price`, or
`null`), `prob` (policy's probability for this action, or `null` off a
non-learned live policy), `recommended` (matches the policy's own pick),
`status` (`open|accepted|declined|expired`).

**`POST /orders/{id}/accept`** — `{"offer_id": "BK-2403-TC-O1"}`. Books the
cargo on the chosen voyage at the quoted price (a quote is a commitment) —
the same code path as a simulated booking from here on (stowage, departure,
delivery, settlement deal for counter-offers, ledger). `409` when: the quote
expired (15 min TTL); the live simulation restarted since it was priced;
the sailing already left (`sim.day` within 0.25 day of `board_day`); the
space was taken by other demand in the meantime; or the order was already
decided (accepted/declined/expired). `404` unknown order or offer.

**`POST /orders/{id}/decline`** — customer turns down every offer. Recorded
as a `booking.decision` (`outcome: declined`) so the operator sees it.

**`GET /orders`** / **`GET /orders/{id}`** (adds `offers[]`) — display fields
are derived live from the current sim clock, never stored: `status` becomes
`LOADING` once `CONFIRMED` and within a day of sailing, `AT PORT` once
`IN TRANSIT` and past ETA, `progress` (0–1 along the voyage), and
`eta: "D+n"`. Only orders booked in the *current* live episode move this way
(an order from a since-restarted episode keeps its last stored state). Real
example:
```json
{ "id": "BK-2402-TC", "origin": "CNSHA", "dest": "NLRTM", "teu": 6,
  "weight_t": 60.0, "cargo_type": "dry", "segment": "standard",
  "req_dep_day": 5.0, "flex_days": 3, "status": "CONFIRMED",
  "created": 1790392289.2, "vessel": "Pacific Aurora", "voyage": "VES1-5",
  "eta": null, "progress": 0.0, "price_usd": 13386.18,
  "episode_id": "4ad56f6d1373", "request_id": 174, "offer_id": "BK-2402-TC-O1",
  "deal_id": null, "board_day": 5.26, "eta_day": 36.0,
  "discharge_port": "NLRTM" }
```
(`episode_id` here is from a prior live episode that has since restarted, so
its status/eta stay frozen rather than advancing.)

**`DELETE /orders`** — `204`, clears the `orders` and `offers` tables.

Status lifecycle:
```
QUOTED ──accept──> CONFIRMED ──(near sailing)──> LOADING
   │                                                 │
   ├──decline──> DECLINED                    departure.confirmed
   │                                                 ▼
   └──(nothing clears the floor)──> NO OFFER    IN TRANSIT ──(past ETA)──> AT PORT
                                                          │
                                                  delivery.confirmed
                                                          ▼
                                                     DELIVERED

(any open QUOTED)──(TTL lapses, or the live sim restarts)──> EXPIRED
```

### Live simulation views

| Method | Path | Returns |
|---|---|---|
| GET | `/live` | episode snapshot (as above) plus `live: true, speed_days_per_sec, n_events, last_seq` |
| GET | `/live/events?after_seq=0&limit=200&types=` | events after `after_seq`; `types` is a comma-separated filter (e.g. `booking.decision,order.accepted`); `limit` clamped to [1, 1000] |
| GET | `/live/policy?limit=20` | recent policy decisions as the network saw them (below); `limit` clamped to [1, 60] |
| GET | `/live/policy/network` | static weight slice for drawing the network; `404` if the live policy isn't a neural net (e.g. `heuristic`) |
| GET | `/live/vessels/{id}/stowage` | one vessel's current stowage (below) |

`GET /live` — real example (trimmed):
```json
{ "id": "79de9a369519", "policy": "ppo", "status": "running", "day": 5.0,
  "…": "…full snapshot as above…",
  "live": true, "speed_days_per_sec": 0.0167, "n_events": 597, "last_seq": 597 }
```

`GET /live/events?limit=3` — real example:
```json
{ "episode_id": "79de9a369519",
  "events": [
    { "seq": 595, "day": 4.0, "type": "booking.decision", "request_id": 401,
      "decision": "accept", "kind": "accept", "outcome": "price_reject",
      "reason": "", "price": 0.0, "quoted": 782.53, "teu": 1, "weight_t": 7.9,
      "origin": "SGSIN", "dest": "CNSHA", "segment": "flexible",
      "cargo_type": "dry", "market_rate": 539.68, "req_dep_day": 14.22,
      "flex_days": 6, "n_options": 1, "vessel_id": "VES1",
      "prev_hash": "0x094e…", "hash": "0x2d5b…" },
    { "seq": 596, "day": 5.0, "type": "day.summary", "cum_revenue": 4863909.62,
      "…": "…day.summary fields…" },
    { "seq": 597, "day": 5.0, "type": "day.metrics", "…": "…same fields as day.summary…" }
  ],
  "next_seq": 597 }
```

`GET /live/policy?limit=1` — one decision trace (real example, trimmed):
```json
{ "episode_id": "79de9a369519", "policy": "ppo", "day": 5.0,
  "decisions": [ {
    "n": 404, "day": 4.0, "step": "booking",
    "request": { "request_id": 401, "origin": "SGSIN", "dest": "CNSHA",
                 "teu": 1, "weight_t": 7.9, "cargo_type": "dry",
                 "segment": "flexible", "flex_days": 6,
                 "req_dep_day": 14.22, "market_rate": 539.68,
                 "customer": false },
    "repo_pairs": null,
    "outcome": { "outcome": "price_reject", "kind": "accept", "price": 0.0,
                 "reason": "", "seq": 595, "hash": "0x2d5b…", "prev_hash": "0x094e…" },
    "action": 1,
    "probs": [0.0485, 0.9515, 0.0, "…44 total, masked-illegal entries 0.0…"],
    "logits": [-2.677, 0.299, null, "…null where the mask forbids the action…"],
    "mask": [true, true, false, "…44 total…"],
    "value": -476.64, "entropy": 0.194,
    "h1": ["…28 sampled hidden-layer-1 activations…"],
    "h2": ["…28 sampled hidden-layer-2 activations…"],
    "obs": ["…112 raw observation floats…"],
    "attribution": [ { "idx": 15, "label": "opt0 leg capacity", "w": -1.0, "x": 0.577 },
                     { "idx": 5, "label": "segment flexible", "w": -0.97, "x": 1.0 }, "…top 8…" ],
    "pricing": { "kind": "accept", "discount_pct": 0.0, "list_price": 782.53,
                 "price": 782.53, "bid_price": 1399.61, "market_rate": 539.68,
                 "reason": "competitiveness_guard", "vessel_id": "VES1",
                 "board_day": 15.03, "eta_day": 75.75,
                 "legs": [ { "leg": 1, "pressure": 0.525, "remaining_teu": 1828.0,
                             "bid_price": 500.92 }, "…" ] }
  } ] }
```
`pricing` is the bid-price engine's view of the priced option (opportunity
cost floor, market rate, reason code, per-leg pressure) — `null` for a reject
or when the live policy has no pricer. `outcome` is filled in from the
matching `booking.decision` event once it's fired (`seq`/`hash` let you line
up the trace entry with its ledgered event).

Booking-step traces also carry the context the operator console's
decision-engine page draws (all read from the live simulator, before the
action is applied):

- `pricing.curve` — `[[price, P(accept), expected margin], …64]`: the
  bid-price engine's own objective `P(wtp_seg ≥ p)·(p − bid)` over
  0.4–1.9× market, using the engine's *segment* willingness-to-pay model
  (calibration) — not the customer's hidden draw. Plus `pricing.segment`, `pricing.teu`.
- `options` — every voyage option the request had: `kind`
  (`requested`|`alt_hub`), `vessel_id`, `dest`, `board_day`, `eta_day`,
  `within_flex`, `bid` ($/TEU opportunity cost), `room_teu`,
  `legs[{leg, from, to, pressure, remaining_teu, bid_price}]`, `feasible`,
  `reason` (why not, e.g. `no capacity on leg`).
- `counterfactuals` — what `static`, `greedy`, `heuristic` and
  `heuristic_bid` would do with the **same** request in the **same** state:
  `{key, label, kind, price, margin_usd}` (margin over the bid-price floor ×
  TEU; 0 for a reject).
- `latency_ms` — measured wall time for this decision: `mask`, `policy`,
  `bid` (option/pricing context), `act` (env step incl. booking, ledger,
  settlement). Stages not isolated are absent, never estimated.
- `outcome.deal` — `{deal_id, kind, tx_hash, contract, terms}` when the
  booking registered an on-chain settlement deal (counter-offers).

`GET /live/policy/network` — the trained policy is `112 -> 256 -> 256 (tanh)
-> pi(44)` with a separate value head; drawing all 256 units per hidden layer
is unreadable, so this returns a fixed slice of **K=28** units per layer (the
ones carrying the most weight into the action head — cached per checkpoint,
same units `evaluate()` reports activations for). Real shape:
```json
{ "obs_labels": ["…112 labels…"], "action_labels": ["…44 labels…"],
  "units": { "h1": [0, 12, 14, "…28 indices…"], "h2": [24, 29, 31, "…28 indices…"] },
  "layers": [112, 256, 256, 44],
  "w1": "28 x 112 weights", "w2": "28 x 28 weights", "w3": "44 x 28 weights" }
```

`GET /live/vessels/VES1/stowage` — real example (trimmed):
```json
{ "vessel_id": "VES1", "name": "Pacific Aurora", "capacity_teu": 8000,
  "day": 5.0, "mode": "PORT", "at_call": 0, "port": "CNSHA", "speed_kt": 16.0,
  "bay_height": 125, "aboard_teu": 1252, "booked_later_teu": 412,
  "upcoming_calls": [ { "idx": 0, "port": "CNSHA", "etd_day": 7.78 },
                      { "idx": 1, "port": "SGSIN", "etd_day": 15.03 }, "…8 total…" ],
  "bays": [ { "idx": 0, "powered": true, "hazmat_ok": false,
              "aboard": [ { "discharge": "NLRTM", "discharge_call": 2,
                            "board": "CNSHA", "weight_t": 11.8,
                            "cargo_type": "dry" }, "…" ],
              "booked_later": 0 }, "…64 bays…" ] }
```
`aboard` is what's physically on board *now* (`board_call <= at_call <
discharge_call`), stacked latest-discharge-at-bottom, heavier-below-lighter;
`booked_later` counts slots booked for a later call. The 3D bay/row/tier
layout is the frontend's job.

### Comparison artifacts (precomputed)

`GET /compare/{name}` — `name ∈ {summary, timeline, offers, shock, meta}`;
serves `backend/demo/{name}.json` verbatim (schemas in `backend.md` §Artifacts).
`404` if the export hasn't been run.

### WebSocket

**`WS /episodes/{id}/stream`** — replays all buffered events, then live events
until the episode ends; closes with a final `episode.status` message.
`4404` close code for unknown episode.

## Event types

Every event: `{seq, day, type, prev_hash, hash, ...payload}`.

| Type | Payload | When |
|---|---|---|
| `episode.status` | `status` | lifecycle transitions |
| `booking.decision` | `request_id, decision, kind, outcome, reason, price, quoted, teu, weight_t, origin, dest, segment, cargo_type, market_rate, req_dep_day, flex_days, n_options, vessel_id`, plus `source: "customer", order_id` when it came from a customer booking | each request decided |
| `cargo.booked` | decision fields + `vessel_id, board_call, discharge_call, board_day, discharge_day_est` | consignment booked (split fires twice) |
| `departure.confirmed` | `request_id, vessel_id, call_idx, port, planned_etd, actual_day, teu, dest_call` | vessel sails with cargo aboard |
| `delivery.confirmed` | `request_id, vessel_id, port, board_call, actual_day, teu, price` | cargo discharged at destination |
| `day.summary` / `day.metrics` | `cum_revenue, cum_profit, teu_booked, utilization, requests, accepted, rejected, countered, counter_won, fuel_tonnes, co2_tonnes, leased_containers, repositioned_teu, vessels_at_sea` | end of each sim-day |
| `order.quoted` | `order_id, request_id, origin, dest, teu, segment, cargo_type, offers[{id,kind,price_per_teu,recommended}], recommended_action, day` | a customer's `POST /orders` was priced |
| `order.accepted` | `order_id, request_id, offer_id, kind, price_per_teu, total_usd, vessel_id` | customer accepted an offer |
| `order.declined` | `order_id, request_id` | customer declined every offer |
| `settlement.deal_registered` | `deal_id, request_id, kind, origin, dest, teu, price_usd, terms, contract, tx_hash` | deal locked on-chain |
| `settlement.departure_recorded` / `.delivery_recorded` | `deal_id, request_id, actual_day, planned_etd, tx_hash` | oracle confirmations mined |
| `settlement.settled` | `deal_id, request_id, outcome, amount_usd, tx_hash` | `settle()` mined |
| `episode.end` | `status, metrics` (full report) | horizon reached / stopped |

`outcome` on booking.decision: `booked|price_reject|declined|rejected|
counter_declined`; `reason` adds the sub-code (`policy`, `infeasible`,
`departure_outside_flex`, `no_viable_offer` (customer request with no offer
clearing the bid-price floor), `customer_accepted`, `customer_declined`, …).
Settlement outcomes: `settled_full`, `settled_penalty`, `refunded`.

Customer-booking `booking.decision` events carry `source: "customer"` and
`order_id` so the operator's event feed can tell simulated demand from a
real customer request; the same two outcomes apply — `booked` (accepted an
offer) and `declined`/`rejected` (declined, or nothing cleared the floor —
`reason: no_viable_offer`).

## Deal lifecycle

```
booking.decision(counter kind) ──cargo.booked──> registerDeal()   status: registered
        │                                      [tx: register]
        ├── departure.confirmed ──> confirmDeparture()            departed
        │                                      [tx: departure]
        ├── delivery.confirmed ──> confirmDelivery() + settle()   settled
        │                                      [tx: delivery, settle]
        └── horizon ends past delivery_deadline ──> settle()      refunded
                                   inside deadline                stays pending
```

Deal record (`GET .../deals`):
```json
{ "deal_id": "d7e7…5a", "request_id": 163, "kind": "flex_window",
  "origin": "SGSIN", "dest": "NLRTM", "teu": 6, "price_usd": 1552.21,
  "segment": "standard", "vessel_id": "VES1",
  "board_day": 13.39, "discharge_eta": 36.88,
  "terms": {"window_lo": 11.39, "window_hi": 15.39,
            "delivery_deadline": 58.39, "penalty_bps": 1000},
  "status": "registered|departed|delivered|settled",
  "register_day": 2.0, "actual_departure": 13.0, "actual_delivery": 37.0,
  "settled_outcome": "settled_full", "settled_amount_usd": 9313.26,
  "contract": "0xF2E2…395b",
  "tx": {"register": "0x91c0…", "departure": "0x8788…",
         "delivery": "0x915d…", "settle": "0x76c0…"} }
```

Contract semantics (`DockSettlement.sol`): depart within `[window_lo,
window_hi]` and deliver → full price; depart after `window_hi` → payout reduced
by `penalty_bps`; undelivered past `delivery_deadline` → refund. The backend
oracle records real sim timings; `settle()` is a pure function of them.

## Env knobs

- `DOCK_LIVE` — `0` disables the always-on live simulation entirely (no
  `/live*` routes, no customer quotes: `POST /orders` 503s). Default on.
- `DOCK_LIVE_POLICY` — policy driving the live simulation (default `ppo`).
- `DOCK_LIVE_SCENARIO` — scenario for the live simulation (default `baseline`).
- `DOCK_LIVE_SPEED` — sim-days per wall-clock second for the live simulation
  (default `1/60`, i.e. 1 sim-day per minute).
- `DOCK_LEDGER_DIR` — where per-episode hash-chained ledgers are written
  (`docker-compose.yml` maps this to the `dock_ledger` volume so ledgers
  survive rebuilds).
- `DATABASE_URL` — Postgres connection string for the orders/offers store
  (SQLAlchemy `postgresql+psycopg://...`).
- `DOCK_SEED` — opt-in local synthetic seed step (a few episodes' worth of
  orders/events from the real simulator) after migrations run; **not yet
  implemented** — currently a no-op regardless of the value.
- `DB_PORT` — host port Postgres is published on under `docker compose`
  (default `5432`; change if something else already uses it).
- `DOCK_PPO_MODEL` — PPO checkpoint path override (default: newest
  `runs/ppo_c<N>/model.zip`).
- `DOCK_SETTLEMENT=off` — explicit opt-out of chain writes (deals still tracked
  offline). Default `on`; a missing contract artifact fails loudly, not
  silently.

## CLI verifier

```bash
.venv/bin/python -m scripts.verify_ledger runs/ledger/<episode_id>.jsonl
# per-event hash recomputation + linkage check; exit 0 ok / 1 tampered
```
