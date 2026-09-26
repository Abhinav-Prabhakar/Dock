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

This is a Next.js project (App Router, **static export** — no Node server
in production; nginx and the backend both serve the built `out/` files).

```bash
# from the repo root — db + api + nginx (builds this project and serves
# the export at /customers/)
docker compose up --build
open http://localhost:8080/customers/
```

| URL | What |
|---|---|
| `http://localhost:8080/customers/` | Booking intake (or redirect to the dashboard when orders exist) |
| `http://localhost:8080/customers/?new` | Booking intake, forced (gate bypassed) |
| `http://localhost:8080/customers/dashboard/` | Fleet dashboard |
| `http://localhost:8080/customers/intake-{a,b,c,d}/` | Exploratory intake UI variants |

Without Docker, the backend still mounts this project's build output at
`http://localhost:8399/customers/` (`backend/server/app.py`, StaticFiles
over `customers/out/` — run `npm run build` here first).

### Working on this project directly

```bash
cd customers
npm ci
npm run dev      # http://localhost:3000/customers/ — /api/* is rewritten
                  # to http://localhost:8080/api (override with
                  # DOCK_API_ORIGIN=http://localhost:8399 if you're running
                  # the backend standalone instead of through nginx)
npm run build    # DOCK_EXPORT=1 next build -> customers/out/ (static export;
                  # rewrites aren't allowed with output:'export', so the
                  # dev-only /api rewrite in next.config.mjs only applies
                  # when DOCK_EXPORT isn't set)
npm test         # vitest — the orders store + Booking Desk live-update logic
```

All backend calls go through `shared/api.js` (`window.DockAPI`), always
same-origin: `/api/*` behind nginx (or the dev rewrite above), the root when
the backend serves the site on :8399. There is no offline mode — a plain
static server without the API shows an explicit "booking service
unavailable" state rather than stale or invented data. The rate-quotation
slip (`shared/offers.js`) is shared by the booking page, all four intake
variants and the dashboard.

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

Every page keeps its original hand-built HTML/CSS/JS — physics, canvas,
maplibre, drag-select calendars — completely unchanged, per the porting
plan: only the *mounting* moved to Next.js. Concretely: each page's
`<body>` markup was extracted verbatim into `app/markup/*.js` (a plain JS
module exporting that HTML as a string), and every `style.css`/`script.js`
etc. moved as-is into `public/` at the same relative paths they always had
(`public/dashboard/script.js`, `public/shared/api.js`, …) — so the exported
site's URLs and directory layout are byte-identical to the old static
files. A thin client component per route (`app/**/*Client.js`) renders the
markup via `dangerouslySetInnerHTML` and then loads the same stylesheets
and scripts, in the same order, that the original `<head>`/`<body>` did.
The only page with genuinely new code is the dashboard — see "Live updates"
below.

```
customers/
  app/
    layout.js            root <html>/<body> shell + shared favicon metadata
    page.js, RootIntakeClient.js        "/" — booking intake
    dashboard/page.js, DashboardClient.js   "/dashboard/" — fleet dashboard
    intake-a/ … intake-d/  page.js + IntakeClient.js per variant
    markup/               root.js, dashboard.js, intakeA.js … intakeD.js —
                          the original <body> markup, extracted verbatim
  components/
    LegacyPage.js         mounts a markup string + loads its css/js, in order
  lib/
    ordersStore.js        the live orders store (see "Live updates")
    chatEvents.js         Booking Desk stream → "should I refetch?" logic
  public/                 unchanged CSS/JS, at their original relative paths
    style.css, script.js  booking intake
    shared/                api.js, offers.js, offers.css
    dashboard/             style.css, script.js, desk.js, desk.css,
                          world.geo.json
    intake-a/ … intake-d/  script.js, style.css
  tests/                  vitest — ordersStore, chatEvents, register CSS
  design.md               THE design contract for the intake page — read
                          before styling anything
  README.md               this file
```

`customers/out/` (git-ignored) is the static export `npm run build`
produces — that's what nginx and the backend's `/customers` mount actually
serve; `node_modules/`, `.next/` are also git-ignored.

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

### Dashboard data layer (`public/dashboard/script.js`)

`boot()` loads `/ports` through `DockAPI` once (ports don't change) and
orders through the shared store (see "Live updates" below); if the API is
down a banner says so and nothing stale is shown. `normalize()` maps an API
row to the display shape (`cargo_type` → `types[]`, requested window →
`window`, `created` s → ms). `QUOTED` orders get a **Review quote** button
that reopens the rate-quotation slip.

### Live updates

The whole reason for the Next.js port: a booking made in the Booking Desk
chat updates the register, wall, totals, chart and detail card **without a
reload**. `lib/ordersStore.js` is a tiny framework-agnostic store
(`subscribe`/`getState`/`refetch`/`startPolling`) that owns the `/api/orders`
list; `app/dashboard/DashboardClient.js` wires it onto
`window.DockOrdersStore` before `dashboard/script.js` loads, and starts its
15s visibility-aware poll (paused while the tab is hidden) so a booking made
on the intake page or in another tab shows up here too.

`dashboard/script.js`'s `boot()` does its first orders fetch through
`window.DockOrdersStore.refetch()` and then `subscribe()`s to it; every push
(the poll, a Booking Desk action, `reviewQuote()`'s own refetch) re-enters
`applyOrders()` — the same function `boot()` used for the first paint — which
re-derives each order's chart geometry and repaints the register, wall,
totals and chart in place, preserves the current selection if it still
exists, and selects/flashes a newly-appeared order otherwise. The physics,
canvas and maplibre code itself is untouched; only its single "here are the
orders" entry point was made re-entrant.

`dashboard/desk.js` (the Booking Desk) no longer calls `location.reload()`:
a mid-stream `action` SSE event or a `done` payload with `orders_changed:
true` calls `window.DockOrdersStore.refetch()` instead, and an order-id link
in a reply focuses that order on the dashboard directly (`window.
DockDashboard.focus`), refetching first if the order isn't loaded yet. The
old "REFRESH THE REGISTER →" button is gone — there's nothing left to
refresh by hand. See `lib/chatEvents.js` + `tests/chatEvents.test.js` for the
refetch decision as a pure, unit-tested function, and
`tests/ordersStore.test.js` for the store itself.

### Booking Desk (`dashboard/desk.js`, `desk.css`)

A deliberately quiet side feature: a small mono `BOOKING DESK` tag in the
bottom-right corner unfolds into a pinned `.paper` slip (brass pin, Georgia
title, letterpress rules). The customer's messages are sage-inked cards;
the desk's replies are typed straight onto the slip; whatever the agent
actually did (quote / booked / declined) is shown as a ledger receipt under
the reply — a rule in the action's ink (terracotta / sage / ink), a small
boxed mono label (`QUOTED`), then the details at reading size (11.5 px mono:
order id, lane, TEU, offers). Receipts use `.desk-receipt`, never `.stamp`
(that class is the register's SVG status stamp). Order ids are links that
focus the order on the chart (`window.DockDashboard.focus`). Palette
discipline holds: no colours beyond the dashboard tokens.

**Dashboard legibility rule:** small text is never set below ~9 px for
reading copy (labels, table headers, cell captions: 9.2–10.8 px) and small
greys stay at least `#827d6f` on the cream sheet. When a label grows, its
letter-spacing is retuned so its width is unchanged — for mono text
`new_ls = (0.6 + ls) / k − 0.6` for a size factor `k` — so the layout
still fits one screen. Only decorative micro-text over the chart (soundings,
microtext lines) sits smaller.

Replies stream (`POST /api/chat/customer/stream`, server-sent events): a
mono status line (`PRICING AGAINST THE LIVE FLEET…`) while tools run, the
stamps as soon as the action happens, then the text as it's written.
It talks to `POST /api/chat/customer` (`backend/server/assistant.py`): the
server runs the LLM with tools over the same order functions this page
uses — list/get orders, price a request, accept or decline an offer, fleet
positions. The key stays on the server. A booking can never happen in the
same turn it was quoted (enforced in code), so nothing books without the
customer's reply. The conversation lives in `sessionStorage['ml.desk']`,
which now just persists across the tab's lifetime — a booking no longer
reloads the page (see "Live updates" above). `GET /api/chat/status` →
`enabled: false` shows the desk as offline.

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
Orders on the same port pair share one great-circle arc, so each lane is
drawn once (`lanes()`) and the selected order is drawn on its own layer on
top — paper halo, sage wash, status-ink line — otherwise N stacked "dimmed"
copies of a busy lane read as strongly as the selection. Clicking a shared
lane selects its newest order, then cycles through the rest.

### View switch

`localStorage['ml.view']` persists `ledger` vs `creds`. `.view` panes
are `hidden`-toggled flex columns; the register scrolls inside its
paper sheet (`#ledger` overflow), the wall scrolls as a badge grid.

### Actions

- **`+ NEW REQUEST`** → `../index.html?new`
- **Review quote** (on `QUOTED` orders) → the rate-quotation slip

### Top bar + register fixes (this port)

The `MERIDIAN LINE · CUSTOMER FLEET` eyebrow in the top bar is gone (the
`.org` wordmark stays); the rest of the bar is unchanged. The waybill
register's `BOOKING`, `ROUTE` and `CONSIGNMENT` cells, plus the `WINDOW /
ETA` column header, now truncate with an ellipsis instead of wrapping onto a
second/third line and colliding with the next column — `white-space: nowrap`
+ `text-overflow: ellipsis` on the cells that were missing it
(`public/dashboard/style.css`, `.c-id`, `.c-cons .teu`, `.c-route`, `.lhead
span`), plus the same treatment on the pinned detail card's and the
quote-review sheet's value rows (`.d-rows .r b`, `.lrows .r b`) for
consistency. The grid column widths themselves are untouched — the register
already let its cells shrink below their content width
(`.lrow > span { min-width: 0 }`); the missing piece was simply telling the
text not to wrap. See `tests/registerOverflow.test.js`.

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
