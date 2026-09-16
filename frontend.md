# Dock frontend — layout & data contract

Two screens plus one piece of persistent chrome. **Data source: the live
backend API** (`api.md` — `uvicorn server.app:app` on :8399). Episodes are
started with `POST /episodes` and stream events over
`WS /episodes/{id}/stream`; REST provides snapshots, deals, and the ledger.
The only precomputed data is the **5-policy comparison**, served read-only
via `GET /compare/*` (backed by `public/demo/*.json` — a multi-minute batch
export, schemas in `backend.md`). No mock shapes from `src/lib/data.ts`;
comparison numbers arrive pre-aggregated and pre-rounded.
`src/app/page.tsx` stays as-is; this doc describes where each backend
surface lands in the UI.

## App shell

```
┌──────────────────────────────────────────────────────────────┐
│  [Dock]        Customers | Fleet                    $ 21.5M ▸ │ ← money HUD
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                      (active screen)                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- **Money HUD (top-right, always visible):** live cumulative profit of the
  running episode — `day.summary.cum_profit` events (or
  `GET /episodes/{id} → metrics.cum_profit` on poll). No episode running →
  fall back to the export headline `GET /compare/summary →
  policies.ppo.profit_usd.mean`. A tiny sparkline of the live
  `cum_profit` series works too.
- **Clicking it opens the comparison dialog** — overlays either screen.
- **Episode control bar** (either screen): policy selector (`GET
  /policies`), scenario selector (`GET /scenarios` — render
  `description`), seed, speed slider (`speed_days_per_sec`, 0 = flat out),
  start/pause/resume/stop (`POST /episodes`, `POST /episodes/{id}/control`).
  One live episode at a time — a second start returns 409.

## The comparison dialog (opened from the money HUD)

The ablation ladder — all precomputed via `GET /compare/summary` +
`GET /compare/timeline` + `GET /compare/meta`:

- **Policy ladder row** — `static → greedy → heuristic → heuristic_bid →
  ppo`. Each rung a card: profit (`profit_usd.mean`), `lift_vs_static`
  deltas (`profit_usd_pct`, `revenue_per_teu_pct`, `utilization_pp`).
  Keep `mean ± std` visible — honest dispersion is a feature.
- **Racing-lines chart** — `cum_profit` (and/or `cum_revenue`) vs `day`
  per policy. The chart that carries the demo.
- **Secondary metric chips** — `utilization`, `co2_per_teu`,
  `empty_teu_nm`, `counter_win_rate`, `reject_to_counter_conv`.
- **Segment strip** — `policies.*.segments`: requests vs booked for
  `urgent` / `standard` / `flexible`.
- `policies_present` in `compare/meta` includes `ppo` — highlight it as
  the lead rung.

## Screen 1 — Customers

The booking desk, **live**: offer cards appear on a ticker as the running
episode emits them — pace is the episode's `speed_days_per_sec`.

**Offer card** (one `booking.decision` event — fields in `api.md`):

- Header: `{origin} → {dest}` route chip, `{teu} TEU`, segment chip
  (`urgent`/`standard`/`flexible`), cargo-type chip (`dry`/`reefer`/
  `hazmat` — reefer/hazmat get their own iconography; they carry the hard
  constraints).
- Body: quoted `{price}` $/TEU vs `{market_rate}` for comparison,
  requested departure `{req_dep_day}` + `{flex_days}`, `{n_options}`
  voyage options seen, `{weight_t}` tonnes.
- Footer: outcome chip from `{outcome}` + `{reason}` — `booked:*` green,
  `price_reject`/`declined`/`counter_declined:*` amber, `rejected:*`
  grey/red. `{decision}` vs `{kind}` distinguishes what the policy chose
  from how it resolved.
- Where a deeper explain payload is wanted, `GET /compare/offers` records
  carry the full `explain` block (per-leg bid decomposition, reason codes)
  — use it for the demo "why" drawer; the live stream's
  `reason`/`market_rate`/`price` fields cover the card itself.

**Deals rail (new — the settlement story):** conditional bookings
(`kind ∈ {flex_window, alt_hub, split}`) become contracts. Each deal card:
`{origin}→{dest}, {teu} TEU @ {price_usd}`, status pill
(`registered → departed → delivered → settled`, or `pending` past
horizon), the terms (`window_lo/hi`, `delivery_deadline`, `penalty_bps`),
and the on-chain refs — `contract` address + `tx.{register, departure,
delivery, settle}` hashes. Settlement result chip: `settled_outcome`
(`settled_full` / `settled_penalty` / `refunded`) + `settled_amount_usd`.
Source: `GET /episodes/{id}/deals` (poll) or the `settlement.*` events on
the same WS stream. A "verify" affordance calling
`GET /episodes/{id}/ledger/verify` → `{ok:true}` is a strong trust beat.

## Screen 2 — Fleet

The ops floor. Four regions:

1. **Map** — 8 ports from `GET /ports` (real `lat`/`lon` — draw a real
   map). Vessel positions from `GET /episodes/{id} → vessels[]`:
   `mode:"PORT"` → at `port`; `mode:"SEA"` → interpolate `from_port →
   to_port` along `progress` (leg fraction). Poll the snapshot every
   ~1s, or derive day-by-day from `day.summary` ticks. Loops/rotations
   per vessel are in `backend.md` §Fleet; spec data in `GET /vessels`.
2. **Vessel cards / stowage** — spec sheet per ship from `GET /vessels`
   (capacity, reefer plugs, speed range incl. service speed, age, draft,
   `fuel_a/b_tpd`); live `onboard_teu`, `speed_kt`, `port` from the
   snapshot. Container placement view = the existing stowage visual.
   Bookable own-lift ≈ `capacity × 0.45 × 0.88`.
3. **Decision log rail** — the same live `booking.decision` /
   `departure.confirmed` / `delivery.confirmed` / `settlement.*` stream,
   framed as an ops log: day, event type, route, outcome, one line each,
   filterable by type. Ops sees *what the policy did*; customers see
   *what they were offered*. Same stream, different lens.
4. **Disaster replay** — two options: (a) live — start an episode on a
   shock scenario (`GET /scenarios` → ones with `port_closures` /
   `demand_spike_events` populated, e.g. `volatile-shocks`), run `static`
   then `ppo` at high speed and show the `day.summary.cum_profit`
   divergence; (b) precomputed — `GET /compare/shock` has the fixed
   NLRTM-closure A/B (`event.day_lo`–`day_hi`, `runs.static` vs
   `runs.ppo` daily + summary deltas). (a) is more alive, (b) is
   deterministic on stage. Either way: two columns, same event window.
5. **Credibility panel** — "measured, not guessed": `GET /models/report`
   → recovered elasticities (flexible 1.80 / standard 1.10 / urgent
   0.55 vs true), WTP multipliers (1.00 / 1.08 / 1.38), demand MAPE.
   Plus a chain-integrity line: `GET /episodes/{id}/ledger/verify` →
   `{ok, n_events, detail}` — "N events, hash chain intact."

## Data-source map

| UI element | Source | Fields |
|:--|:--|:--|
| Money HUD | WS `day.summary` / `GET /episodes/{id}` | `cum_profit` |
| Episode controls | `GET /policies`, `GET /scenarios`, `POST /episodes`, `/control` | descriptor + status |
| Ladder cards | `GET /compare/summary` | `policies.<name>.*.{mean,std}`, `lift_vs_static` |
| Racing lines | `GET /compare/timeline` | `policies.<name>[].{day,cum_profit,cum_revenue,utilization,teu_booked,empty_teu_nm,mean_bid_pressure}` |
| Segment strip | `GET /compare/summary` | `policies.*.segments.<seg>.{requests,booked}` |
| Offer cards + log rail | WS `booking.decision` (+`cargo.booked`,`departure/delivery.confirmed`,`settlement.*`) | per `api.md` event table |
| "Why" drawer (deep) | `GET /compare/offers` | `explain.{quote_per_teu,bid_price_per_teu,market_rate_per_teu,reason,legs[],text}` |
| Deals rail | `GET /episodes/{id}/deals` + WS `settlement.*` | `deal_id, kind, terms, status, settled_*, contract, tx.*` |
| Map | `GET /ports` + `GET /episodes/{id}` | `lat,lon`; `vessels[].{mode,port,from_port,to_port,progress}` |
| Vessel specs | `GET /vessels` | spec sheet + `loop` |
| Empties ticker | `GET /episodes/{id}` | `empties.<port>` |
| Credibility | `GET /models/report` | `models.{demand.mape,elasticity.per_segment,wtp.per_segment}` |
| Chain integrity | `GET /episodes/{id}/ledger/verify` | `ok, n_events, detail` |
| Provenance footer | `GET /compare/meta` | `git_sha, generated_at, seed, episodes, scenarios, policies_present` |

## Null / edge behavior

- `mean_bid_pressure` is `null` for `static`/`greedy` — render "n/a".
- `lift_vs_static.<policy>` is `null` if the static profit mean ≤ 0 (the
  depressed-demand holdout makes static negative — the honest demo point
  is that static loses money there; render the raw values).
- Deals end `pending` when the horizon cuts inside their delivery
  deadline — that's the honest state, not a bug.
- `split` outcomes are rare **by construction** (both halves must
  independently fit) — don't promise a split card; if one appears it's
  real.
- `GET /episodes/{id}/deals` is empty for `static`/`greedy` (they never
  counter) — render an empty-state, not an error.
- 409 on a second episode start — surface "episode already running" with
  a link to it, don't retry-loop.
- No episode running → live surfaces show an idle/empty state with the
  episode control bar prominent.

## Regeneration (comparison artifacts only)

```bash
cd backend && .venv/bin/python -m scripts.export_demo --out ../public/demo \
    --model runs/ppo_c5/model.zip
```
