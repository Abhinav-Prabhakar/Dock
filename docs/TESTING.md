# Dock frontend — testing

**13 spec files · 90 tests · all green.** Stack: vitest 3 + jsdom 30 +
@testing-library/react 16 + jest-dom matchers.

```bash
npm test          # vitest run (one-shot)
npm run test:watch
# or directly:
./node_modules/.bin/vitest run
```

Config: `vitest.config.ts` — jsdom environment, `globals: true`, specs are
`src/**/*.test.{ts,tsx}` colocated with their subjects, `@` → `src/`.
`vitest.setup.ts` loads `@testing-library/jest-dom/vitest`. CSS is disabled
(`css: false`) — `booking-desk.css` imports are no-ops under test.
`@vitejs/plugin-react` is cast `as unknown as Plugin` in the config: the
plugin is typed against this repo's rolldown-vite fork while vitest bundles
stock vite — structurally divergent types, runtime-compatible. Keep the cast.

## Coverage by file

| Spec | Subject | What it covers |
|---|---|---|
| `src/lib/api.test.ts` | REST client | `/health` GET, `ApiError` extraction of FastAPI `{detail}` (incl. non-JSON + non-string-detail fallbacks to status text), `startEpisode` POST body, `/compare/<name>` path building, `getEpisodeDeals`; `wsUrl` http→ws and https→wss via env override |
| `src/lib/offers.test.ts` | verdict helpers | `stampFor` over the full outcome × kind matrix (booked/accept, counter kinds, booked:* prefixes, counter_declined, declined, price_reject, rejected:*); `outcomeTone` buckets; `humanizeToken` (snake/kebab/colon); `shortHash`; `fmtUsd`/`fmtUsdM`/`fmtPct` |
| `src/components/dock/ui.test.tsx` | shared primitives | `Pill` tones + icon, `MeterBar` clamping (0/1/fractional), `StatusDot` classes, `Empty`, `HashChip` (missing → em dash, truncate, click-to-copy tick) |
| `src/components/dock/EpisodeProvider.test.tsx` | the data spine | boot health → `backendUp` true/false; adopt-running-episode opens the WS to `…/episodes/{id}/stream`; `day.summary` folds into metrics + profitSeries (same-day dedup); `episode.end` → completed; `start()` POSTs params + attaches; **409 → adopts the already-running episode + error message**; non-409 start failure surfaces `detail` |
| `src/components/dock/ComparisonDialog.test.tsx` | comparison modal | closed → null; all five ladder cards with names/profits; signed lift chips + "static ≤ 0" fallback for missing lift; `meta.policies_present` n/a marking; provenance footer; fetch-failure state; Escape + backdrop close |
| `src/components/customers/DealsRail.test.tsx` | deals rail | deal card (route, price, segment, terms, settled pill); contract + tx hash chips; verify → intact chain / broken chain; empty states (no episode vs live-no-deals) |
| `src/components/customers/WhyDrawer.test.tsx` | why drawer | null → nothing; lane chip + stamp + hero price; loads `/compare/offers` export and renders quote/bid/market bars; export fetch on open; export-failure state; Escape + backdrop close |
| `src/components/fleet/PortMap.test.tsx` | map | mounts without throwing against a stubbed maplibre; non-empty container; clean mount with zero episode data |
| `src/components/fleet/VesselCards.test.tsx` | vessel cards | empty state without `/vessels`; one card per vessel (name/id/spec cells); idle pill + "—" without an episode; live SEA state (speed, onboard, leg); berthed PORT state |
| `src/components/fleet/EmptiesTicker.test.tsx` | empties strip | "no live data" pill without snapshot; one chip per port sorted by TEU desc; fractional TEU rounding |
| `src/components/fleet/DecisionLogRail.test.tsx` | ops log | empty state; newest-first rows (day, route, outcome stamp); filter-chip counts; click-to-filter |
| `src/components/fleet/ShockReplay.test.tsx` | shock replay | canned export render (banner, legend, delta chips); export-failure state; "run it live" starts a static episode on volatile-shocks; button disabled when backend down or episode live |
| `src/components/fleet/CredibilityPanel.test.tsx` | credibility | mounts clean live and idle; non-empty container (model-report parsing is defensive — an unparsed shape renders the "unavailable" state rather than throwing) |

## How the mocks work

- **`useEpisode` fixture** — every component spec (DealsRail, WhyDrawer,
  VesselCards, EmptiesTicker, DecisionLogRail, ShockReplay, CredibilityPanel,
  PortMap) stubs the provider, not the network:
  `vi.mock("@/components/dock/EpisodeProvider", () => ({ useEpisode: () => mocks.ctx }))`
  with a `baseCtx()` factory (`vi.hoisted`) returning the full context shape —
  empty reference data, `episode: null`, `events: []`, `snapshot: null`,
  vi.fn() stubs for `start`/`control`/`dismissError`. Tests override per-case.
- **`FakeWebSocket`** (`EpisodeProvider.test.tsx`) — a class collecting
  `static instances[]`; `open()`, `emit(payload)` (JSON-stringified into
  `onmessage`), `close()`, `latest()`. Installed via
  `vi.stubGlobal("WebSocket", FakeWebSocket)`; assert WS URLs with
  `API_BASE.replace(/^http/, "ws")`.
- **Fetch router** (`EpisodeProvider.test.tsx`) — `vi.stubGlobal("fetch", …)`
  with a URL-suffix router (`/health`, `/policies`, `/episodes` GET/POST,
  `/episodes/{id}` snapshot, `/deals`, else 404 `{detail}`). Mutable knobs
  (`episodesList`, `snapshotBody`, `postHandler`, `healthOk`,
  `postedBodies`) reset in `beforeEach` so each test steers the backend.
  `api.test.ts` uses a simpler per-test `fetchMock`.
- **`vi.mock("@/lib/api", importOriginal)`** — surface specs keep the real
  module but replace one method (`api.getCompare`, `api.verifyLedger`,
  `api.getModelsReport`) with a hoisted `vi.fn`.
- **maplibre mock** (`PortMap.test.tsx`) — `vi.mock("maplibre-gl")` returns
  `Map`/`Marker`/`Popup` as `vi.fn` constructors whose instances are bags of
  `vi.fn()` (`setLngLat`/`addTo`/`setHTML` chain via `mockReturnThis`), so
  jsdom never touches WebGL. The mock exports both named and `default`.
- jsdom has no `matchMedia`/`canvas`/WebGL — `PortMap` guards with
  `window.matchMedia?.()`; specs only assert mount + non-empty DOM.

## Known gaps

- **`BookingDesk` is only import-smoke-tested** — it's an imperative DOM/CSS
  scene (rAF loop, `createElement`, timers); there is no spec asserting card
  dealing, stamps, or the drain behaviour. Rendering it under jsdom is
  possible (it guards nothing canvas/WebGL) but assertions would be on
  classes/`querySelector` — deliberately deferred.
- **Polling intervals untested** — `SNAPSHOT_MS = 1000` / `DEALS_MS = 2500`
  timers and the stop-on-idle effect run on real timers; no fake-timer suite
  covers them (or `MAX_EVENTS = 3000` truncation).
- **WS failure paths untested** — socket close/error mid-episode (the
  provider never retries the WS; snapshot polling keeps metrics fresh, but
  the event rail stops).
- **`MoneyHUD`, `EpisodeControls`, `DockNav`** — no dedicated specs (covered
  only transitively); the slider→`set_speed` wiring in `EpisodeControls` is
  unexercised.
- **`/` ops mock + chat** (`src/components/*`, `src/components/chat/*`,
  `src/lib/data.ts`, `src/lib/llm.ts`, `app/api/chat/route.ts`) — legacy
  demo surface, untested.
- **Charts** (`ComparisonDialog` racing lines, `ShockReplay` chart) — asserted
  via surrounding chips/legend, not the SVG geometry.
- Backend (`backend/tests`, ~130 pytest) is a separate suite — see
  `CONTEXT.md`; nothing in `src/` covers the wire contract end-to-end.
