# Dock frontend — architecture

Next.js 16 (App Router, Turbopack) · React 19 · Tailwind v4 · TypeScript ·
MapLibre GL · vitest + jsdom. Dev server on **:3000**; it talks to the live
FastAPI backend on **:8399** (`api.md` is the wire contract). The backend is
frozen — the frontend adapts to it, never the other way round.

```
src/
  app/
    layout.tsx                  # fonts (Inter + Outfit), metadataBase, globals
    globals.css                 # @theme design tokens + panel/chip classes
    page.tsx                    # "/" — legacy ops mock (stowage demo), static
    booking-desk/page.tsx       # redirect → /customers
    (dock)/                     # route group — the live product
      layout.tsx                # shared chrome: EpisodeProvider + DockNav +
                                #   EpisodeControls + MoneyHUD
      error.tsx                 # route-group error boundary
      customers/{page,CustomersScreen}.tsx
      fleet/{page,FleetScreen}.tsx
    api/chat/route.ts           # SSE proxy for the legacy mock's AI chat
    icon.svg · favicon.ico · apple-icon.png · manifest.ts · opengraph-image.tsx
    not-found.tsx · loading.tsx
  lib/
    api.ts                      # typed REST client + ApiError + wsUrl()
    offers.ts                   # verdict stamps, formatters, segment colors
    data.ts                     # static mock data for the "/" ops screen only
    llm.ts                      # chat client for the legacy mock screen
  components/
    dock/                       # shared chrome + primitives
      EpisodeProvider.tsx       # THE data spine — WS + polling, one context
      EpisodeControls.tsx       # policy/scenario/seed/horizon/speed + transport
      DockNav.tsx               # logo + Customers|Fleet tabs
      MoneyHUD.tsx              # live cum_profit + sparkline → ComparisonDialog
      ComparisonDialog.tsx      # the 5-policy ablation ladder (precomputed)
      ui.tsx                    # SectionTitle/Pill/StatusDot/HashChip/MeterBar/Empty
    customers/
      BookingDesk.tsx           # imperative animated scene (the offer desk)
      DealsRail.tsx             # on-chain deals + ledger verify
      WhyDrawer.tsx             # offer detail + /compare/offers explain
      booking-desk.css          # the scene's whole visual system
    fleet/
      PortMap.tsx               # fully-local MapLibre map (public/map/**)
      VesselCards.tsx           # spec-sheet cards + live telemetry
      EmptiesTicker.tsx         # per-port empty-container strip
      DecisionLogRail.tsx       # filterable ops log of the event stream
      ShockReplay.tsx           # canned NLRTM-closure A/B + "run it live"
      CredibilityPanel.tsx      # model report + ledger hash-chain verify
    *.test.tsx                  # colocated vitest specs (see docs/TESTING.md)
public/
  demo/                         # precomputed 5-policy export (served via /compare/*)
  map/                          # fully-local vector basemap (see pipeline below)
  assets/                       # brand icons
```

## Screen map

| Route | What it is | Data |
|---|---|---|
| `/` | Legacy ops mock (stowage planning demo + AI chat). Static, self-contained — reads `src/lib/data.ts` only. A "Live dashboard" chip links to `/customers`. | none |
| `/customers` | **The booking desk, live.** `BookingDesk` is an imperative animated scene (warm lamplit shop — CSS + DOM, no React re-render per event): customers wander, walk to the counter when real `booking.decision` events arrive, deal offer cards onto the counter, and a rubber stamp lands on each (`stampFor` → BOOKED / DEAL·KIND / PASSED / NO DEAL / REJECTED). Clicking a card opens `WhyDrawer` (offer fields + the deep `explain` block matched from `/compare/offers` by `request_id`, else nearest lane analog). Right rail: `DealsRail` — on-chain settlement deals with stage track (registered→departed→delivered→settled), terms, tx hashes, and a ledger-verify button. | WS `booking.decision`; `GET /episodes/{id}/deals` (polled); `GET /episodes/{id}/ledger/verify`; `GET /compare/offers` |
| `/fleet` | **The ops floor.** `PortMap` (port dots, dashed service loops, ship glyphs interpolated along legs, popups) over `EmptiesTicker` over `VesselCards`. Right rail: `DecisionLogRail` (the same event stream, ops lens, filterable), `ShockReplay` (precomputed static-vs-ppo NLRTM closure chart + a "run it live" button that races two real episodes), `CredibilityPanel` (`/models/report` est-vs-true + ledger verify). | `GET /ports` `/vessels` `/episodes/{id}` (polled); WS events; `/compare/shock`; `/models/report` |
| Comparison dialog | Modal over either screen, opened from the MoneyHUD. Policy ladder cards (mean ± std + lift vs static), racing-lines cum_profit chart, secondary metric chips, segment strip, provenance footer. | `/compare/summary` `/compare/timeline` `/compare/meta` |

## Data flow — EpisodeProvider

`src/components/dock/EpisodeProvider.tsx` owns *all* live state. Everything on
`/customers` and `/fleet` reads `useEpisode()`; nothing else fetches episode
data.

Lifecycle:

1. **Boot** (mount): `GET /health` → `backendUp`. Then `Promise.all` of
   `/policies` `/scenarios` `/episodes` `/ports` `/vessels` `/routes` — each
   individually fault-tolerant (`.catch(() => [])`).
2. **Adopt**: if `GET /episodes` returns one with `status ∈ {running, paused}`,
   attach to it — refresh-resilient.
3. **Attach** (`attach(desc)`): reset per-episode state, open
   `WS /episodes/{id}/stream` (replay + live fanout), prime snapshot + deals,
   start polling: **snapshot every 1000ms** (`SNAPSHOT_MS`), **deals every
   2500ms** (`DEALS_MS`).
4. **Events**: `handleEvent` appends to `events` (capped at `MAX_EVENTS = 3000`,
   oldest dropped), folds `day.summary`/`day.metrics` into `metrics` +
   `profitSeries` (deduped by day), folds `episode.status`/`episode.end` into
   the descriptor. Malformed frames are dropped.
5. **Idle-down**: when status leaves running/paused the timers clear and one
   final snapshot+deals poll lands the terminal state.
6. **Detach**: unmount cleanup closes the socket and clears timers.

Start path: `POST /episodes` → attach. **409** → fetch `GET /episodes`, find
the live one, attach to it, and surface "An episode was already running —
attached to it." — adoption, not a retry loop. `control()` maps to
`POST /episodes/{id}/control` (`pause`/`resume`/`stop`/`set_speed`).

Context surface: `backendUp, policies, scenarios, ports, vessels, routes,
episode, metrics, profitSeries, events, deals, snapshot, wsConnected,
starting, error, start, control, dismissError`.

### Event types consumed per surface

| Event | Consumed by |
|---|---|
| `booking.decision` | BookingDesk (drives customers + cards + stamps), DecisionLogRail, WhyDrawer |
| `cargo.booked`, `departure.confirmed`, `delivery.confirmed` | DecisionLogRail |
| `settlement.*` (deal_registered, departure/delivery_recorded, settled) | DecisionLogRail (deals themselves come from the polled `/deals` endpoint) |
| `day.summary` / `day.metrics` | MoneyHUD (cum_profit + sparkline), BookingDesk till, EpisodeProvider metrics/profitSeries |
| `episode.status`, `episode.end` | EpisodeProvider descriptor → controls, map idle chip, desk overlay |

## Design system contract

Tokens live in `src/app/globals.css` `@theme` (Tailwind v4 — utilities like
`text-hi`, `bg-ink`, `border-edge` are generated from these):

- **Surfaces**: `abyss #060a20` → `ink #0b1130` → `panel #12183c` →
  `panel-2/-3`; hairlines `edge #262e63` / `edge-soft #1e2650`.
- **Text ramp**: `hi #eef0ff` → `mid #9aa1c9` → `low #6c739b` → `faint #4b5180`.
- **Brand**: `accent #6a73ea` (+ `accent-hi`, `accent-deep` for gradients).
- **Status**: `loaded #3fbdb0` (won/teal) · `reserved #d9b13b` (warn/amber) ·
  `pending #e0566b` / `critical #f0524f` (rejected/red) · `warn #e5a33c`;
  each with a `*-soft` variant for text on dark.
- **Utility classes**: `.panel` (gradient card) / `.panel-flat` (flat card) /
  `.chip` (pill surface) / `.dock-bg` (page backdrop bloom) / `.scroll-thin`.
- **Type**: Inter = `font-sans` body; Outfit = `font-display` for numerals and
  headings; `tabular-nums` on every number.

**"Icons over text" rule**: labels are 9–12px uppercase micro-labels; meaning
is carried by lucide icons (`strokeWidth 1.75`, 10–15px) + numerals + color.
Build new surfaces from `src/components/dock/ui.tsx` primitives —
`SectionTitle` (icon + uppercase header), `Pill` (tone colorway), `StatusDot`
(live pulse), `HashChip` (copyable truncated tx/deal hash), `MeterBar`
(clamped progress), `Empty` (icon + one-line idle state). Verdict/stamp logic
is shared in `src/lib/offers.ts` (`stampFor`, `outcomeTone`, `CARGO_ICON`,
`SEGMENT_COLORS`, `fmtUsd`/`fmtUsdM`/`fmtPct`/`shortHash`/`humanizeToken`) so
the booking desk, ops log, and why drawer always agree.

The booking desk is deliberately exempt: it is an imperative DOM/CSS scene
(`booking-desk.css` + direct `createElement`) driven by the event queue —
React owns the chrome, the scene owns the stage.

## Map asset pipeline (`public/map/` — fully local, no API keys)

The Fleet map never leaves localhost: vector tiles, glyphs, sprites and the
style are all committed under `public/map/` (~61MB). Recipe used:

```bash
# 1. Extract a regional z0–6 slice of the Protomaps daily build.
#    go-pmtiles 1.31.2 binary (github.com/protomaps/go-pmtiles releases):
pmtiles extract https://build.protomaps.com/20260920.pmtiles dock-slice.pmtiles \
    --bbox=-140,-10,165,68 --maxzoom=6

# 2. Unpack the archive to plain {z}/{x}/{y}.mvt files — small node script
#    using the `pmtiles` npm package (already a dependency): open the archive
#    with `new PMTiles(path)` / FetchSource, iterate `getZxy(z,x,y)` entries,
#    write each tile body to public/map/tiles/{z}/{x}/{y}.mvt (gzip-encoded
#    MVT as stored in the archive).
#    → 1314 tiles under public/map/tiles/

# 3. Fonts + sprites from the protomaps basemaps-assets tarball
#    (github.com/protomaps/basemaps-assets releases): copy the three
#    fontstacks used by the style to public/map/fonts/<Fontstack>/*.pbf
#    (768 glyph PBFs: Noto Sans Regular / Medium / Italic) and the dark
#    sprite set to public/map/sprites/dark{,@2x}.{json,png}.

# 4. Hand-authored style: public/map/style.json ("Dock Abyss") —
#    12 layers (background, earth, landcover, water, boundaries ×2,
#    water/earth/place labels), glyphs "/map/fonts/{fontstack}/{range}.pbf",
#    sprite "/map/sprites/dark", vector source tiles
#    "/map/tiles/{z}/{x}/{y}.mvt", bounds [-140,-10,165,68], minzoom 0,
#    maxzoom 6, attribution © Protomaps © OpenStreetMap contributors.
```

`PortMap` consumes it once (`new maplibregl.Map({style: "/map/style.json"})`);
live data rides on top via a GeoJSON source (dashed service loops, split at
the antimeridian) plus `Marker`s for ports and ship glyphs that
`setLngLat` per snapshot — `lerpSea` interpolates `from_port → to_port` by
`progress`, taking the short way across the dateline; glyphs rotate to the
leg bearing. The map instance is created once and never re-created.

## Tests

vitest + jsdom + Testing Library, colocated `*.test.tsx` — **13 files,
90 tests, all green**. `npm test` (alias `vitest run`). Full coverage list,
mock mechanics and known gaps: `docs/TESTING.md`.

## Deploy notes

- `NEXT_PUBLIC_DOCK_API` — backend base URL baked into the client bundle
  (default `http://localhost:8399`). `wsUrl()` derives `ws(s)://` from it.
- `NEXT_PUBLIC_SITE_URL` — feeds `metadataBase` in `src/app/layout.tsx`
  (default `http://localhost:3000`); required for absolute OG image URLs.
- The compare surface is served by the backend (`GET /compare/*` →
  `public/demo/*.json`); regenerate with
  `cd backend && .venv/bin/python -m scripts.export_demo --out ../public/demo`.
- `next build` is fully static except `/api/chat` (dynamic route handler for
  the legacy screen's AI chat). `public/map/` ships as static assets.
- `AGENTS.md`: this Next.js version has breaking changes — consult
  `node_modules/next/dist/docs/` before changing conventions.
