# Dock API — live backend reference

The Dock backend is a **live** FastAPI server. The Next.js frontend talks to it
over REST + one WebSocket; every episode runs a real simulator instance
day-by-day and streams events as they happen.

```bash
# start the server (from backend/)
.venv/bin/uvicorn server.app:app --port 8399
# frontend dev origin is pre-allowed: http://localhost:3000
```

Base URL below is `http://localhost:8399`. All responses are JSON. Errors are
standard FastAPI `{"detail": "..."}` with HTTP status codes — nothing silently
degrades; a missing forecaster artifact, missing checkpoint, or bad scenario
name returns an explicit error.

## Concepts

- **Episode** — one simulator run: `{policy, scenario, seed, horizon_days}`.
  Runs on a server thread, advancing one sim-day per `1/speed` seconds.
  **One live episode at a time** (409 otherwise); finished episodes stay
  queryable.
- **Event stream** — every sim event is appended to a **hash-chained JSONL
  ledger** (`backend/runs/ledger/<episode_id>.jsonl`, Keccak-256) and pushed to
  WebSocket subscribers. Events carry `seq`, `prev_hash`, `hash`.
- **Deals** — conditional bookings (`flex_window`/`alt_hub`/`split` counters)
  become settlement contracts on a **real local EVM** (in-process py-evm via
  eth-tester; contract `backend/settlement/DockSettlement.sol` deployed per
  episode — real tx hashes, real contract address). The backend is the oracle
  writing departure/delivery confirmations.
- **Compare artifacts** — the precomputed 5-policy export
  (`public/demo/*.json`) is served read-only; generating it takes minutes, so
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

### Episodes

**`POST /episodes`** — start a live episode.

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
  "n_events": 0, "n_deals": 0, "created_at": 1789500798.67 }
```
Errors: `400` unknown policy/scenario · `409` an episode is already running ·
`500` config failure (e.g. missing forecaster — the message names it).

| Method | Path | Returns |
|---|---|---|
| GET | `/episodes` | `[descriptor]` — all episodes incl. finished |
| GET | `/episodes/{id}` | **snapshot** (below) |
| POST | `/episodes/{id}/control` | `{"action": "pause"|"resume"|"stop"|"set_speed", "speed"?: float}` → descriptor |
| GET | `/episodes/{id}/events?after_seq=0&limit=500` | `{"events": [...], "next_seq": n}` — REST fallback for the WS stream |
| GET | `/episodes/{id}/deals` | `[deal]` — contract records (below) |
| GET | `/episodes/{id}/deals/{deal_id}` | one deal |
| GET | `/episodes/{id}/ledger?after_seq&limit` | events read back from the .jsonl file |
| GET | `/episodes/{id}/ledger/verify` | `{"ok": true, "n_events": n, "first_bad_seq": null, "detail": "..."}` |

**Snapshot** (`GET /episodes/{id}`):
```json
{ "id", "policy", "scenario", "status", "day", "horizon_days",
  "metrics": { "cum_revenue", "cum_profit", "teu_booked", "utilization",
               "requests", "accepted", "rejected", "countered",
               "counter_won", "fuel_tonnes", "co2_tonnes",
               "costs": {"fuel","carbon","port_fees","demurrage",
                         "reposition","lease","roll_comp"} },
  "vessels": [ { "vessel_id", "name", "mode": "SEA"|"PORT",
                 "port", "from_port", "to_port",
                 "leg_start_day", "leg_end_day",
                 "progress": 0.0-1.0,   // fraction along the current leg —
                                        // interpolate port coords for the map
                 "onboard_teu", "speed_kt" } ],
  "empties": { "CNSHA": 1200.0, ... } }
```

### Comparison artifacts (precomputed)

`GET /compare/{name}` — `name ∈ {summary, timeline, offers, shock, meta}`;
serves `public/demo/{name}.json` verbatim (schemas in `backend.md` §Artifacts).
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
| `booking.decision` | `request_id, decision, kind, outcome, reason, price, quoted, teu, weight_t, origin, dest, segment, cargo_type, market_rate, req_dep_day, flex_days, n_options, vessel_id` | each request decided |
| `cargo.booked` | decision fields + `vessel_id, board_call, discharge_call, board_day, discharge_day_est` | consignment booked (split fires twice) |
| `departure.confirmed` | `request_id, vessel_id, call_idx, port, planned_etd, actual_day, teu, dest_call` | vessel sails with cargo aboard |
| `delivery.confirmed` | `request_id, vessel_id, port, board_call, actual_day, teu, price` | cargo discharged at destination |
| `day.summary` / `day.metrics` | `cum_revenue, cum_profit, teu_booked, utilization, requests, accepted, rejected, countered, counter_won, fuel_tonnes, co2_tonnes, leased_containers, repositioned_teu, vessels_at_sea` | end of each sim-day |
| `settlement.deal_registered` | `deal_id, request_id, kind, origin, dest, teu, price_usd, terms, contract, tx_hash` | deal locked on-chain |
| `settlement.departure_recorded` / `.delivery_recorded` | `deal_id, request_id, actual_day, planned_etd, tx_hash` | oracle confirmations mined |
| `settlement.settled` | `deal_id, request_id, outcome, amount_usd, tx_hash` | `settle()` mined |
| `episode.end` | `status, metrics` (full report) | horizon reached / stopped |

`outcome` on booking.decision: `booked|price_reject|declined|rejected|
counter_declined`; `reason` adds the sub-code (`policy`, `infeasible`,
`departure_outside_flex`, …). Settlement outcomes: `settled_full`,
`settled_penalty`, `refunded`.

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
