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
# 1. the backend — serves the API AND this site, same origin
cd backend
.venv/bin/uvicorn server.app:app --port 8399

# 2. open the site
open http://localhost:8399/customers/
```

That's it. `backend/server/app.py` mounts this directory at `/customers`
(StaticFiles, `html=True`), so page URLs look like:

| URL | What |
|---|---|
| `http://localhost:8399/customers/` | Booking intake (or redirect to the dashboard when orders exist) |
| `http://localhost:8399/customers/?new` | Booking intake, forced (gate bypassed) |
| `http://localhost:8399/customers/dashboard/` | Fleet dashboard |
| `http://localhost:8399/customers/intake-{a,b,c,d}/` | Exploratory intake UI variants |

The site also works from any plain static server (`python -m http.server`
etc.): every `fetch` targets `http://localhost:8399` unless the page is
already being served from port 8399, in which case it goes same-origin.
CORS is pre-allowed for any `localhost`/`127.0.0.1` port.

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

## The shared order store

Orders live in **Postgres** (table `orders`, managed by
`backend/server/orders.py` via SQLAlchemy Core; schema owned by
`backend/alembic/`, not created by the app). One
customer "order" = one booking request for **a single cargo type**; a
multi-type consignment is filed as several orders, one POST per kind.

Schema:

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | `BK-####-TC`, continuing the seeded range |
| `origin` | TEXT | UN/LOCODE port id, must exist in `/ports` |
| `dest` | TEXT | must form a servable OD pair with origin |
| `teu` | INTEGER | ≥ 1 |
| `weight_t` | REAL | total tonnes across all TEU |
| `cargo_type` | TEXT | `dry` \| `reefer` \| `hazmat` |
| `segment` | TEXT | `flexible` \| `standard` \| `urgent` |
| `req_dep_day` | REAL | requested departure, sim-days; ≥ sim_day + 0.5 |
| `flex_days` | INTEGER | ± departure tolerance, ≥ 0 |
| `status` | TEXT | display lifecycle (below) |
| `created` | REAL | unix seconds |
| `vessel`, `voyage`, `eta`, `progress`, `price_usd` | nullable | filled by ops/sim later; dashboard renders `—`/`AWAITING VESSEL`/`TBC` for nulls |

Seeded once, when the table is first created, with 9 sample orders
(mixed statuses, all servable OD pairs). `DELETE /orders` wipes the
table and does **not** reseed — that's the demo reset.

Status lifecycle (display-only until the simulator owns it):
`PENDING REVIEW → CONFIRMED → LOADING → IN TRANSIT → AT PORT → DELIVERED`.

### API contract (FastAPI, `backend/server/routes.py`)

| Method | Path | Returns |
|---|---|---|
| GET | `/ports` | 8 ports: `port_id, name, lat, lon, berths, daily_capacity_teu, base_congestion, tz_offset, mean_dwell_days, base_wait_hours` |
| GET | `/routes` | 18 servable OD pairs: `origin, dest, base_teu_wk, market_usd_per_teu, lane, direction` |
| GET | `/orders` | all orders, newest first |
| GET | `/orders/{id}` | one order (404 otherwise) |
| POST | `/orders` | `201` + created order, or `422 {"detail": "..."}` |
| DELETE | `/orders` | `204` — wipes the store (demo reset) |

POST body (validated server-side):

```json
{ "origin": "SGSIN", "dest": "NLRTM", "teu": 4, "weight_t": 44.0,
  "cargo_type": "dry", "segment": "urgent",
  "req_dep_day": 3.0, "flex_days": 0 }
```

Validation rules: `origin`/`dest` are real ports **and** a servable OD
pair (a vessel loop must cover it — the 18 `ROUTES`); `teu` ≥ 1;
`weight_t` > 0; `cargo_type`/`segment` enum; `req_dep_day` ≥ current sim
day + 0.5 (current day = the running episode's day, else 0);
`flex_days` ≥ 0.

The eight ports and the 18 pairs come from `backend/data/calibration.py`.
The site embeds the same table as an offline fallback — keep them in
sync if the network ever changes.

---

## Page behaviour

### Gate (`customers/script.js`, top of file)

On load (unless `?new`): `GET /orders` → non-empty →
`location.replace('dashboard/')`. If the API is unreachable, falls back
to the `ml.orders` localStorage cache (written after every successful
fetch), then to the form. This is the "first visit → form, returning →
dashboard" rule.

### Booking intake submit

The current page posts **one order per `.ctype` container block**
(cargo chip → `cargo_type` via `{dry,haz→hazmat,reef→reefer}`, unit
count → `teu`, per-unit kg → `weight_t`), `segment: 'standard'`, and
derives `req_dep_day`/`flex_days` from the dragged calendar window
(midpoint → sim-day float, half-span → ± days). Port stamps cycle real
UN/LOCODE pairs — changing the origin re-inks the destination lane with
only servable pairs. On API failure it mirrors a legacy-shaped order
into `ml.orders` and still redirects.

### Dashboard data layer (`customers/dashboard/script.js`)

`boot()` fetches `/ports` + `/orders` in parallel; on success it caches
orders into `ml.orders`, on failure it renders the cache (or nothing, if
empty). `normalize()` accepts both API rows and the legacy cached shape
(`from/to`/`types[]`): `cargo_type` fans out into `types[]`,
`req_dep_day ± flex_days` becomes the `window`/`eta` display strings
(`D+n` style), `created` converts s → ms, missing `vessel`/`voyage`
/`price` render as pool names/`—`. Chart geometry (great-circle arc,
antimeridian-split segments, vessel position/heading) is derived per
order after normalisation.

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
- **`RESET DEMO`** → `DELETE /orders` + clear `ml.orders` → `../index.html`
  (lands on the form because the store is now empty)

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
- **`sim_day` for `req_dep_day`** is the running episode's day, else 0.
  With no episode running, `req_dep_day` is "days from today" and the
  `≥ 0.5` floor is the only check.
- **Display fields are mocked.** `vessel`/`voyage`/`eta`/`progress`/
  `price_usd` are null on POSTed orders until ops (or the simulator)
  fills them; seeds carry plausible values so the chart isn't empty.
  The dashboard renders honest placeholders.
- **`ml.orders` is a cache, not the store.** It's written after every
  successful `/orders` fetch and read only when the API is unreachable.
  Editing it by hand does nothing to the real store.
- **Intake variants** (`intake-a…d`) are parallel design explorations of
  the same contract — none is wired into the main gate yet; one is meant
  to be promoted to `index.html` after review.
- **cargo-ship** (`drafts/cargo-ship/`, the port-operator site) doesn't
  read `/orders` yet — the shared store is the integration seam for it.

## Files NOT to confuse this with

- `src/app/(dock)/customers/` — the *operator* live booking desk in the
  Next.js product UI (different thing, different data source).
- `drafts/cargo-ship/` — the vessel/port-operator site. Out of scope
  here; consumes the same `/orders` API when wired.
