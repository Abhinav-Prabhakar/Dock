# Dock frontend — layout & data contract

Two screens plus one piece of persistent chrome. **Data sources**: the
live backend API (`api.md`) drives everything real-time — episodes stream
over `WS /episodes/{id}/stream`, snapshots/deals/ledger via REST; the
precomputed 5-policy comparison still comes from `public/demo/*.json`,
served through `GET /compare/*` (see `backend.md` for the artifact
schemas). No mock shapes from `src/lib/data.ts`; all comparison numbers
are pre-aggregated and pre-rounded. `src/app/page.tsx` stays as-is; this
doc describes where each backend surface lands in the UI.

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

- **Money HUD (top-right, always visible):** Dock's cumulative profit —
  `summary.json → policies.<lead>.profit_usd.mean` (lead = `ppo` once
  exported, else `heuristic_bid`). Optionally a tiny sparkline of
  `timeline.json → policies.<lead>[].cum_profit`.
- **Clicking it opens the comparison dialog** — this is what `/compare`
  was going to be; as a dialog it can overlay either screen.

## The comparison dialog (opened from the money HUD)

The ablation ladder, data = `summary.json` + `timeline.json`:

- **Policy ladder row** — `static → greedy → heuristic → heuristic_bid →
  ppo`. Each rung a card: profit (`profit_usd.mean`), and `lift_vs_static`
  deltas (`profit_usd_pct`, `revenue_per_teu_pct`, `utilization_pp`).
  Cards keep `mean ± std` visible — honest dispersion is a feature.
- **Racing-lines chart** — `timeline.json`: `cum_profit` (and/or
  `cum_revenue`) vs `day` for every policy, one line each. The chart that
  carries the demo.
- **Secondary metric chips** — `utilization`, `co2_per_teu`,
  `empty_teu_nm`, `counter_win_rate`, `reject_to_counter_conv`.
- **Segment strip** — `policies.*.segments`: requests vs booked for
  `urgent` / `standard` / `flexible`. Shows Dock prioritizing urgent at
  premium and steering flexible cargo to later sailings.
- When `ppo` is present in `policies_present` (meta.json), it gets the
  highlighted rung; before that, `heuristic_bid` is the lead.

## Screen 1 — Customers

The booking desk: offer cards appear on a ticker (replay `offers.json` in
day order — it feels live because it is a real recorded episode).

**Offer card** (one `offers.json` record):

- Header: `{origin} → {dest}` route chip, `{teu} TEU`, segment chip
  (`urgent`/`standard`/`flexible`), cargo-type chip (`dry`/`reefer`/
  `hazmat` — reefer/hazmat get their own iconography; they carry the hard
  constraints).
- Body: quote `{price}` $/TEU with `discount_pct` when the decision is a
  counter (`decision_kind`: `accept` | `reject` | `flex_window` |
  `alt_hub` | `split`), market rate for comparison
  (`explain.market_rate_per_teu`), requested departure + `flex_days`.
- Footer: outcome chip — the colon-namespaced `outcome` string. Suggested
  coloring: `booked:*` green, `declined` / `price_reject` amber,
  `counter_declined:*` amber, `rejected:*` grey/red.
- Expandable **"why"** drawer from `explain`: reason chip
  (`bid_price_floor` | `market_uplift` | `competitiveness_guard`),
  `quote_per_teu` vs `bid_price_per_teu` vs `market_rate_per_teu`, and the
  per-leg mini-table (`remaining_teu` / `expected_teu` / `pressure` /
  `bid_price` per leg) — or just render `explain.text` plus the legs.
- `explain` may be `null` (no pricer on that policy, or no feasible
  option) — collapse the drawer, don't fake it.

## Screen 2 — Fleet

The ops floor. Four regions:

1. **Map** — 8 ports (`CNSHA SGSIN KRPUS NLRTM DEHAM BEANR USLAX USNYC`),
   vessel positions on their loops (see backend.md for the rotation per
   vessel), moving at the scrubber's day.
2. **Vessel cards / stowage** — spec sheet per ship (capacity, reefer
   plugs, speed range incl. service speed, age, draft, burn rate — the
   table in backend.md §"Fleet"). Container placement view = the existing
   stowage visual. Bookable own-lift ≈ `capacity × 0.45 × 0.88` — that is
   the scale of `remaining_teu` in offer legs, not nominal TEU.
3. **Decision log rail** — the same `offers.json` stream as the Customers
   cards, but framed as an ops log: timestamp (`day`), decision kind,
   outcome, reason code, one line each, filterable by outcome family.
   Ops sees *what the policy did*; customers see *what they were offered*.
   Same artifact, different lens.
4. **Disaster replay** — `shock.json`: a day scrubber over the event
   window (`event.day_lo`–`day_hi`, ~days 42–63), two columns —
   `runs.static` vs `runs.<lead>` — each showing its `daily` series
   (profit line, utilization, TEU booked) with `summary` deltas at the
   end. Header carries `event.description` (NLRTM closure + 2× demand
   spike). The divergence between the two columns through the event is
   the 60-second payoff.
5. **Credibility panel** — "measured, not guessed": from
   `models/artifacts/report.json` — recovered demand elasticities
   (flexible 1.80 / standard 1.10 / urgent 0.55, shown against the true
   values), WTP multipliers (1.00 / 1.08 / 1.38), demand forecaster
   holdout MAPE. One compact table or stat row; it's a footnote-sized
   panel that does a lot of trust work.

## Data-source map

| UI element | File | Fields |
|:--|:--|:--|
| Money HUD | `summary.json`, `timeline.json` | `policies.<lead>.profit_usd.mean`, `[].cum_profit` |
| Ladder cards | `summary.json` | `policies.<name>.*.{mean,std}`, `lift_vs_static` |
| Racing lines | `timeline.json` | `policies.<name>[].{day,cum_profit,cum_revenue,utilization,teu_booked,empty_teu_nm,mean_bid_pressure}` |
| Segment strip | `summary.json` | `policies.*.segments.<seg>.{requests,booked}` |
| Offer cards + log rail | `offers.json` | `request_id, day, origin, dest, teu, segment, cargo_type, req_dep_day, flex_days, decision_kind, discount_pct, outcome, price, explain` |
| "Why" drawer | `offers.json` | `explain.{quote_per_teu,bid_price_per_teu,market_rate_per_teu,reason,legs[],text}` |
| Disaster replay | `shock.json` | `event.{port,day_lo,day_hi,description}`, `runs.<policy>.{daily,summary}` |
| Credibility | `models/artifacts/report.json` | `models.{demand.mape,elasticity.per_segment,wtp.per_segment}` |
| Provenance footer | `meta.json` | `git_sha, generated_at, seed, episodes, horizon_days, scenarios, policies_present` |

## Null / edge behavior

- `mean_bid_pressure` is `null` for `static`/`greedy` — render "n/a".
- `explain` is `null` for infeasible requests and pricer-less policies.
- `lift_vs_static.<policy>` is `null` if the static profit mean ≤ 0 (the
  depressed-demand holdout makes static negative — the honest demo point
  is that static loses money there; render the raw values).
- `split` outcomes are rare **by construction** (both halves must
  independently fit) — don't promise a split card will appear; if one
  does, it's real.

## Regeneration

```bash
cd backend && .venv/bin/python -m scripts.export_demo --out ../public/demo
# after PPO lands: add --model runs/ppo_c5/model.zip
```
