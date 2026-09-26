# Dock frontend — architecture & data contract

Two static sites, no build step, both on the live backend API. This file says
**where every screen gets its data** and how it behaves when data is missing.
What things *look* like is specified elsewhere and is not repeated here:

- `customers/design.md` — the customer booking site (MERIDIAN LINE)
- `drafts/cargo-ship/design.md` — the port-operator console

Both design files are the contract for visuals; connecting data never changes
a screen's layout. The full endpoint reference is `api.md`; the integration
history is `docs/INTEGRATION_PLAN.md`.

## Serving

```
ui   nginx :8080   /            → drafts/cargo-ship/   (operator console)
                   /customers/  → customers/           (customer site)
                   /api/*       → api:8000             (FastAPI, incl. WebSocket upgrade)
api  FastAPI       always-on live PPO world · Postgres orders/offers · /compare/* artifacts
db   Postgres 16   orders + offers (Alembic migrations 0001–0003)
```

`cp .env.example .env && docker compose up --build`, then
http://localhost:8080 (operator), http://localhost:8080/customers/ (customers).
Everything is **same-origin**: pages call `/api/...`, never a host or port.
Without Docker, uvicorn also mounts `customers/` itself at `/customers/` and
the customer client then calls the root (`location.port === '8399'`).

### The live world

The API starts one live episode on startup (`ppo`, `baseline`, 90-day horizon,
restarted at the end) paced by `DOCK_LIVE_SPEED` (default 1 sim-day per
minute). Customer quotes are priced against it and both sites' live views read
it. A restart ends open quotes (`EXPIRED`) and starts a fresh event feed.

## Rules both sites follow

- **No mock, seeded, cached or invented data.** No embedded port tables,
  vessel names, voyage codes or prices — ports and lanes come from
  `/ports` + `/routes`.
- **API down → explicit "unavailable" state** with the API's own message,
  never stale data and never a fallback.
- **No real data for an element → relabel minimally** (em-dash, `TBC`,
  `— AWAITING VESSEL`, disabled control) rather than invent a value.

## API clients

| Site | Client | Shape |
|:--|:--|:--|
| customers | `customers/shared/api.js` → `window.DockAPI` (classic script) | `ports, routes, network, orders, order, quote, accept, decline, live` |
| operator | `drafts/cargo-ship/js/api.js` → `API` (ES module, DOM-free) | `live, liveEvents, livePolicy, policyNetwork, stowage, vessels, ports, routes, orders, compare(name)` |

Both reject with the API's `detail` text (`status` 0 = unreachable), which the
page shows verbatim in its unavailable state.

## Customer site (`customers/`)

| Screen | Source | Notes |
|:--|:--|:--|
| Gate (`/`) | `GET /orders` | non-empty → redirect to `dashboard/`; `?new` forces the form |
| Booking intake (`/`, `intake-a…d/`) | `GET /ports` + `GET /routes` (`DockAPI.network()`) | port stamps cycle only servable lanes; if unreachable the deck shows `BOOKING SERVICE UNAVAILABLE — …` and CONFIRM stays disabled |
| Submit | `POST /orders` per cargo kind | body `{origin, dest, teu, weight_t, cargo_type, segment, req_dep_day, flex_days}`; `req_dep_day` = **days from now** (window midpoint), `flex_days` = half the window; `→ {order, offers[], recommendation}` |
| Offer slip (`shared/offers.js`) | the `POST /orders` results, then `POST /orders/{id}/accept {offer_id}` / `…/decline` | one block per order; offers labelled *As requested / Flexible sailing / Alternate port / Split shipment*, price/TEU, total, pricing reason, the model's pick; stamps CONFIRMED / DECLINED / EXPIRED (409) / NO OFFER |
| Badge re-ink | the slip's final orders | status row + band: `QUOTED`, `CONFIRMED`, `CLOSED`, `NOT PRICED` |
| Dashboard (`dashboard/`) | `GET /ports` + `GET /orders` | register, credential wall, tracking chart, fleet counters; `QUOTED` orders get **Review quote** → `GET /orders/{id}` → the same slip with its open offers |

**Offer slip placement (decided):** the slip stays a shared overlay rather than
a step inside the booking deck. The deck is exactly two columns (CARGO, ROUTE)
in `customers/design.md`, and the same slip serves the canonical intake, all
four variants and the dashboard's Review quote.

**Order lifecycle:** `QUOTED → CONFIRMED → LOADING → IN TRANSIT → AT PORT →
DELIVERED`, plus `NO OFFER` (nothing clears the bid-price floor), `DECLINED`,
`EXPIRED` (15 min or a world restart). Vessel, voyage, price, ETA (`D+n`) and
progress exist only after an accept; `LOADING`, `AT PORT`, progress and ETA
are derived on read from the live clock.

**Deals:** only counter-offers (flexible sailing, alternate port, split)
register an on-chain settlement contract; the order carries its `deal_id`.
A plain "as requested" booking has no deal.

## Operator console (`drafts/cargo-ship/`)

| Screen / panel | Source | Notes |
|:--|:--|:--|
| Vessel — 3D ship + cargo | `GET /live/vessels/{id}/stowage` | `js/stowage/fromLive.js` maps the real bays × tiers onto the Dock Pioneer hull proportionally, never repeating a real container — a small vessel can render less full than its real fill fraction rather than fabricate duplicates; Vessel select from `GET /live → vessels[]`; ship speed from the vessel (`speed_kt`, 0 in port) |
| Vessel — stowage card (BOXES / TEU / UTIL) | same stowage endpoint | the selected vessel's own real counts (`aboard` units, `aboard_teu`, `aboard_teu / capacity_teu`) — not a count of what's drawn on the fixed model hull, which can differ under the resample above |
| Vessel — profit | `GET /live → metrics.cum_profit`, `GET /compare/summary → lift_vs_static.ppo.profit_usd_pct` | `—` when absent |
| Vessel — Live bookings panel | `GET /live/events` (see below) + `GET /orders` | customer quotes / accepts / declines, booking decisions, and every settlement step of customer deals |
| Stowage — elevation + plan | same stowage endpoint | Bay select and Load/Discharge/Restow/Clear stay visible but disabled (they used to invent cargo) |
| Statistics | `GET /compare/{summary,timeline,meta,shock}`, `/ports`, `/vessels`, `/live`, `/live/events?types=booking.decision,delivery.confirmed` | holdout 5-policy ladder, shock replay, live world; `js/pages/statsLive.js` |
| Model ("inside the helm") | `GET /live/policy`, `GET /live/policy/network`, `/vessels` | the real MaskablePPO forward pass per decision (obs 112, mask 44, π, V(s), attributions) + decision context; `js/pages/liveDecision.js`. Stamp is `BOOKED`/`DECLINED`/`REJECTED` once the matching `booking.decision` event has landed, `PENDING` for a non-reject decision still in flight (its outcome hasn't arrived yet) |

### Live bookings panel (`js/live.js`)

- Polls `GET /live` every 3 s and `GET /live/events?after_seq=…&limit=1000&types=…`
  every 2 s. The type filter is `CUSTOMER_EVENT_TYPES`:
  `booking.decision, order.quoted, order.accepted, order.declined,
  settlement.deal_registered, settlement.departure_recorded,
  settlement.delivery_recorded, settlement.settled`.
- Settlement events carry `request_id`, not `order_id`, and the live world
  settles simulated deals too. The panel keeps a `request_id → order_id` map:
  seeded from `GET /orders` (rows for the live `episode_id`) on its first poll
  of an episode, then learned from `order.quoted` and customer
  `booking.decision` events (`trackCustomer`). `order.quoted` matters — a
  counter-offer's `settlement.deal_registered` is emitted *before* the
  customer's `booking.decision`.
- `describeEvent(ev, reqs)` turns an event into a row; settlement events for
  non-customer requests return `null` and are skipped. Rows look like
  `BK-2420-TC deal registered · split`, `… departed`, `… delivered`,
  `… settled · settled_full · $1,636`.
- `/live/events` returns the **latest** `limit` matches after `after_seq` and
  `next_seq` jumps to the newest event — it is a live tail, not a pager. That
  is why customer requests are seeded from `/orders` rather than replayed.
- A new live episode id resets the cursor and the map.

## Null / edge behaviour

- No live world yet (API startup): `/live*` returns 503 → the panels say
  "Live simulation unavailable — …" until it's up.
- Between worlds, `/live` keeps serving the finished episode at its horizon
  until the next one starts (building PPO + the settlement contract can take
  a couple of minutes); the new episode id then resets the panel.
- `POST /orders` with no viable offer → `NO OFFER`, recorded as a customer
  `booking.decision` (rejected) so the operator sees the turned-away demand.
- Accept after the sailing left, the space was taken, 15 min passed or the
  world restarted → 409 with a readable reason; the slip stamps EXPIRED.
- Split bookings register one deal per leg; the order keeps one `deal_id`.
- `lift_vs_static.*` is `null` when the static mean profit ≤ 0 — render the
  raw values, not a percentage.
- `/live/policy/network` is 404 if the live policy isn't a neural net.

## Tests

| Check | What it proves |
|:--|:--|
| `scripts/smoke.sh` | both sites + every customer page load the shared modules; API, live world, quote → accept, ledger verify — all through nginx |
| `node --test drafts/cargo-ship/tests/*.mjs` | operator adapters (stowage, statistics, model, bookings panel) against the live API |
| `python3 scripts/check_imports.py` | every operator ES-module import resolves |
| `scripts/e2e.sh` | a customer accepts a counter-offer → the panel's own `js/live.js` logic shows quoted / deal registered / accepted / departed / delivered / settled → the on-chain deal is `settled` with a tx hash (run the stack with `DOCK_LIVE_SPEED=0.5`) |

CI (`.github/workflows/ci.yml`) runs the backend tests with Postgres, the
frontend checks and the full Docker stack + smoke on every push and PR.
