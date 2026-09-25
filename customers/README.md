# customers — MERIDIAN LINE customer portal

The customer-facing site for Dock. Customer companies file cargo booking
requests here; the orders land in a shared store on the Dock FastAPI
backend and are meant to surface on the operator-side site
(`drafts/cargo-ship/`). No auth — one portal per customer company, all
orders in one shared pool.

This folder used to live at `drafts/customers/` (before that,
`drafts/light-6/`). It is now a first-class site at the repo root.

---

## Quick start

```bash
# from the repo root — db + api + nginx (serves this site at /customers/)
docker compose up --build
open http://localhost:8080/customers/
```

| URL | What |
|---|---|
| `http://localhost:8080/customers/` | Booking intake (or redirect to the dashboard when orders exist) |
| `http://localhost:8080/customers/?new` | Booking intake, forced (gate bypassed) |
| `http://localhost:8080/customers/dashboard/` | Fleet dashboard |
| `http://localhost:8080/customers/intake-{a,b,c,d}/` | Exploratory intake UI variants |

Without Docker, the backend still mounts this directory itself at
`http://localhost:8399/customers/` (`backend/server/app.py`, StaticFiles).

All backend calls go through `shared/api.js` (`window.DockAPI`), always
same-origin: `/api/*` behind nginx, the root when the backend serves the site
on :8399. There is no offline mode — a plain static server without the API
shows an explicit "booking service unavailable" state rather than stale or
invented data. The rate-quotation slip (`shared/offers.js`) is shared by the
booking page, all four intake variants and the dashboard.

---

## What the customer sees

```
no orders on the store ──►  / (booking intake)  ──CONFIRM──► POST /orders
                                     │                            │
orders exist ◄── ?new forces form ◄──┴──►  /dashboard/ ◄──────────┘
```

- **`/`** — the booking credential. A laminated MERIDIAN LINE badge
  hanging on a verlet-physics leather cord (grab/fling it) beside a
  two-column paper deck: CARGO (container type blocks, up to six) and
  ROUTE (departure-window calendar + port-pair datestamps + price
  stepper). `?new` skips the gate.
- **`/dashboard/`** — the merged fleet dashboard: a waybill register and
  a credential wall sharing the left pane (top-bar REGISTER ⇄
  CREDENTIALS toggle), a near-full-height pinned tracking chart on the
  right, and the serif fleet counters (TEU Afloat / Orders Active / Avg
  Transit) pinned under the views.

---

## File map

```
customers/
  index.html            booking intake — scene markup (badge, deck, wall)
  style.css             intake styles (design tokens in :root)
  script.js             badge physics, deck choreography, calendar,
                        port-pair stamps, submit → POST /orders
  design.md             THE design contract — read before styling anything
  dashboard/
    index.html          dashboard markup (top bar, views, chart, overlay)
    style.css           dashboard styles
    script.js           data layer (API fetch + normalize), register,
                        credential wall, manifest overlay, maplibre chart,
                        SVG fallback chart, selection sync
    world.geo.json      Natural Earth 110m land (inline chart style)
  intake-a/  intake-b/  intake-c/  intake-d/
                        exploratory booking-intake UI variants (same API
                        contract, four different interaction concepts)
  README.md             this file
```

---

## Orders, quotes and the live simulation

Orders live in **Postgres** (`backend/server/orders.py`; schema owned by
`backend/alembic/`). One order = one booking request for **a single cargo
type**; a multi-type consignment is filed as several orders, one per kind.
A fresh database starts empty — there are no seed or sample rows.

Every order is **priced live** against the always-on simulation run by the
trained PPO policy (`backend/server/quotes.py`):

```
POST /orders  {origin, dest, teu, weight_t, cargo_type, segment,
               req_dep_day, flex_days}
  -> 201 { order, offers[], recommendation }
POST /orders/{id}/accept  {offer_id}  -> { order, offers }
POST /orders/{id}/decline             -> { order, offers }
GET  /orders          all orders, newest first (display fields derived live)
GET  /orders/{id}     one order + its offers
```

- `req_dep_day` is **days from now**; `flex_days` is the ± tolerance.
- Offers are the policy's own booking actions — *as requested*, *flexible
  sailing* (a later sailing at a discount), *alternate port*, *split* —
  limited to what physically fits (capacity + stowage solver) and priced by
  the bid-price engine. Nothing is offered below the cost of the space; if
  nothing clears it the order is `NO OFFER`. The model's pick is flagged
  `recommended`.
- Quotes are valid 15 minutes (or until the live simulation restarts).
- Validation errors are `422` with a readable `detail`; no live simulation
  is `503` — nothing is stored or faked.

Status lifecycle: `QUOTED → CONFIRMED → LOADING → IN TRANSIT → AT PORT →
DELIVERED`, plus `NO OFFER`, `DECLINED`, `EXPIRED`. Vessel, voyage, price,
ETA (`D+n`) and progress exist only once an offer is accepted; before that
the pages show honest placeholders (`— AWAITING VESSEL`, `TBC`).

Ports and servable lanes come from `GET /ports` + `GET /routes`
(`DockAPI.network()`); no page embeds its own copy.

---

## Page behaviour

### Shared modules (`customers/shared/`)

- `api.js` → `window.DockAPI`: every backend call, same-origin.
- `offers.js` + `offers.css` → `window.DockOffers.review(results)`: the
  rate-quotation slip (offers, the carrier's pick, accept / decline,
  stamped outcome). Design-independent, so any intake can host it.

### Gate (`customers/script.js`, top of file)

On load (unless `?new`): `DockAPI.orders()` → non-empty →
`location.replace('dashboard/')`; otherwise the form.

### Booking intake submit

One order per `.ctype` container block (cargo chip → `cargo_type`, unit
count → `teu`, per-unit kg → `weight_t`), `segment: 'standard'`,
`req_dep_day`/`flex_days` from the dragged calendar window. Each is priced
with `DockAPI.quote`, then `DockOffers.review` shows the offers; the badge
re-inks with the real outcome. `intake-a…d` follow the same flow.

### Dashboard data layer (`customers/dashboard/script.js`)

`boot()` loads `/ports` + `/orders` through `DockAPI`; if the API is down a
banner says so and nothing stale is shown. `normalize()` maps an API row to
the display shape (`cargo_type` → `types[]`, requested window → `window`,
`created` s → ms). `QUOTED` orders get a **Review quote** button that
reopens the rate-quotation slip.

### The chart

MapLibre GL on a fully **inline** style (no tiles, no keys): cream ocean
background, `world.geo.json` land fill, JS-generated graticule, dashed
great-circle routes (sage; terracotta for attention, faint for
delivered), a "done" solid overlay up to the vessel position, port
dots + mono labels, vessel glyph markers at `progress`, seeded depth
soundings, compass rose, title/correction block, and a pinned detail
note (`#dcard`) that fills on selection. If GL fails to reach `load`
within 5 s, an inline-SVG plate-carrée chart (`renderFallback`) draws
the same layers; selection restyles both renderers via `refreshRoutes()`.

Selection is global: register row ↔ wall badge ↔ route line ↔ vessel
marker ↔ detail note all select the same `order.id`. `Esc` releases it.

### View switch

`localStorage['ml.view']` persists `ledger` vs `creds`. `.view` panes
are `hidden`-toggled flex columns; the register scrolls inside its
paper sheet (`#ledger` overflow), the wall scrolls as a badge grid.

### Actions

- **`+ NEW REQUEST`** → `../index.html?new`
- **Review quote** (on `QUOTED` orders) → the rate-quotation slip

---

## Design system (contract: `design.md`)

Cream plaster wall `#f4f0e4` · ink `#1d1a14` · sage `#3a5a44` ·
terracotta `#b96f4b` · hairline `#d9d3c1` (always with a 1px white
highlight — "letterpress rule") · Georgia serif numerals with
`tabular-nums` · tiny letterspaced uppercase mono labels · print
misregistration ghosts on dynamic numerals (`data-t` +
`::before`/`::after`) · seeded `mulberry32` art (barcodes, container
stacks, stamps, weathering) · rubber-stamp distress filters
(`stampInk`/`inkD`/`mildInk`) · brass/leather hardware · exactly ONE
off-palette element (pure-black tooltip `#0e0d0b`) · minimal text,
icon-forward.

Functional accent hues: amber `#c98f1f` = hazmat, ice-blue `#4a7f9e` =
reefer. Everything procedural — no image/font/audio assets anywhere.

---

## Known behaviour & limitations

- **No auth.** One shared order pool by design — every customer sees the
  same register.
- **No offline mode.** Every page reads the live API; if it's down the
  page says so. The only localStorage key left is `ml.view` (which dashboard
  tab you were on — a UI preference, not data).
- **Intake variants** (`intake-a…d`) are parallel designs on the same
  shared modules; any of them can become the front door by pointing
  nginx's `/customers/` at it.
- **cargo-ship** (`drafts/cargo-ship/`, the port-operator site) reads the
  same live API; its Live bookings panel shows these orders in real time,
  through to the settlement of counter-offer deals.

## Files NOT to confuse this with

- `drafts/cargo-ship/` — the vessel/port-operator site, served at `/` by the
  same nginx; reads the same live API.
