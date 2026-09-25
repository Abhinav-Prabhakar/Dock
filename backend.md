# Dock backend — frontend-facing reference

Everything the dashboard needs to know: what the backend is, what it
produces, the exact shape of every artifact it writes, and the vocabulary
used throughout. The backend now also exposes a **live API** — FastAPI +
WebSocket episode streaming, hash-chained event ledger, and on-chain deal
settlement — fully documented in `api.md`. The static artifacts below
remain the source for the 5-policy comparison surfaces (they are produced
by a multi-minute batch export, not computed on demand); live episode
data, deals, and the ledger come from the API.

## The pipeline (one picture)

```
data.generate  →  generated parquets + scenario defs
                      │
models.train    →  models/artifacts/{demand_forecaster, elasticity, wtp}
                      │                    (fitted once, committed)
                      ▼
simulator       →  per-episode world: demand stream, fleet, stowage,
                   market rates, disruptions — all pinned by seed+scenario
                      │
policies        →  static | greedy | heuristic | heuristic_bid | ppo
                      │
rl.evaluate     →  eval_results.json (holdout-only, identical seeds)
export_demo     →  backend/demo/{summary,timeline,offers,shock,meta}.json
                      │
                      ▼   the only thing src/ ever reads
                   backend/demo/*.json
```

Policies are ranked on an **ablation ladder**: each rung adds one layer
(fill-surge pricing → counter-offers → bid-price opportunity cost →
learned sequencing via PPO). `static` is "how the industry works today";
`ppo` is Dock.

## What the frontend reads: `backend/demo/`

Written by `cd backend && .venv/bin/python -m scripts.export_demo`
(`--model <path>` adds the `ppo` policy). All files UTF-8 JSON, floats
pre-rounded.

### `summary.json` — headline metrics table

```jsonc
{
  "policies": {
    "<policy>": {                       // static|greedy|heuristic|heuristic_bid|ppo
      "profit_usd":            {"mean": 0.0, "std": 0.0},
      "revenue_usd":           {"mean": 0.0, "std": 0.0},
      "revenue_per_teu":       {"mean": 0.0, "std": 0.0},  // $/TEU
      "utilization":           {"mean": 0.0, "std": 0.0},  // TEU-nm carried / offered
      "empty_teu_nm":          {"mean": 0.0, "std": 0.0},  // repositioning waste
      "co2_per_teu":           {"mean": 0.0, "std": 0.0},  // tonnes CO2 per TEU booked
      "fuel_tonnes":           {"mean": 0.0, "std": 0.0},
      "counter_win_rate":      {"mean": 0.0, "std": 0.0},  // counters accepted / issued
      "reject_to_counter_conv":{"mean": 0.0, "std": 0.0},
      "requests":              {"mean": 0.0, "std": 0.0},
      "accepted":              {"mean": 0.0, "std": 0.0},
      "teu_booked":            {"mean": 0.0, "std": 0.0},
      "segments": {
        "flexible": {"requests": 0.0, "booked": 0.0},
        "standard": {"requests": 0.0, "booked": 0.0},
        "urgent":   {"requests": 0.0, "booked": 0.0}
      }
    }
  },
  "lift_vs_static": {
    "<policy>": {"profit_usd_pct": 0.0, "revenue_per_teu_pct": 0.0,
                 "utilization_pp": 0.0}   // null when static mean <= 0
  }
}
```

`mean`/`std` are over episodes × holdout scenarios at identical seeds —
`std` is honest dispersion, not an error bar to hide.

### `timeline.json` — the racing-lines chart

```jsonc
{"policies": {"<policy>": [
  {"day": 1, "cum_revenue": 0.0, "cum_profit": 0.0, "utilization": 0.0,
   "teu_booked": 0.0, "empty_teu_nm": 0.0,
   "mean_bid_pressure": 0.4}    // null for policies with no bid engine
]}}
```

One entry per sim day (1..horizon), averaged across episodes and scenarios.
`mean_bid_pressure` = mean over legs of `expected contested TEU / remaining
TEU` — the engine's scarcity signal; only `heuristic_bid`/`ppo` populate it.

### `offers.json` — the decision feed (~40 records)

Sampled deliberately across every outcome kind so the feed shows the full
decision surface:

```jsonc
[{
  "request_id": 0, "day": 0, "origin": "CNSHA", "dest": "NLRTM",
  "teu": 1, "segment": "standard", "cargo_type": "hazmat",
  "req_dep_day": 6.9, "flex_days": 0,
  "decision_kind": "accept",      // accept|reject|flex_window|alt_hub|split
  "option_idx": 0, "discount_pct": 0.0,
  "outcome": "booked:accept",     // see outcome vocabulary below
  "price": 1160.03,               // quoted $/TEU (null when no quote)
  "explain": {                    // BidPriceEngine.explain(); null when the
    "engine": "bid_price",        // policy has no pricer or no option exists
    "quote_per_teu": 1160.03,
    "bid_price_per_teu": 533.51,  // the opportunity-cost floor
    "market_rate_per_teu": 1126.25,
    "reason": "market_uplift",    // bid_price_floor|market_uplift|competitiveness_guard
    "legs": [{                    // one per voyage leg — the audit trail
      "leg_idx": 0, "dep_day": 6.14,
      "remaining_teu": 3168.0,    // capacity left on that leg
      "expected_teu": 1264.1,     // forecaster's expected contested demand
      "pressure": 0.399,          // expected/remaining — drives the bid
      "market_rate": 264.53,      // leg-prorated market rate
      "bid_price": 90.03          // leg's opportunity cost contribution
    }],
    "text": "Bid price VES1 legs [0, 1]: $534/TEU ..."   // human-readable
  }
}]
```

`explain` is the explainability payload — render `text` plus the legs
table; that's the whole "why did the system quote this" story.

### `shock.json` — the wow-moment replay

```jsonc
{
  "event": {"port": "NLRTM", "day_lo": 42, "day_hi": 63,
            "description": "NLRTM port closure weeks 46-49 ..."},
  "runs": {"static":        {"daily": [<same shape as timeline entries>],
                           "summary": {<same metrics as summary.json>}},
           "heuristic_bid": {"daily": [...], "summary": {...}}
           /* "ppo" replaces/extends the lead run when --model given */}
}
```

Identical shocked world, identical seed, two policies — the divergence
between their `daily` series is the demo.

### `meta.json` — provenance

`git_sha`, `generated_at`, `seed`, `episodes`, `horizon_days`,
`scenarios` (holdout names), `policies_present`, `demand_model` (artifact
path), `notes`.

## Vocabulary the UI needs

- **Segments** (`segment`): `flexible` (lowest WTP, widest departure flex),
  `standard`, `urgent` (highest WTP, zero flex). Recovered WTP multipliers:
  1.00 / 1.08 / 1.38.
- **Cargo types**: `dry`, `reefer`, `hazmat` — hazmat and reefer have hard
  stowage constraints (bay designations, powered plugs).
- **Decision kinds**: `accept`, `reject`, `flex_window` (discount for a
  different departure), `alt_hub` (discharge at a partner hub), `split`
  (consignment across two departures — real but rare by construction).
- **Outcomes** (`outcome`, colon-namespaced): `booked:accept`,
  `booked:flex_window`, `booked:alt_hub`, `booked:split`, `declined`
  (customer walked at the quote), `price_reject`, `counter_declined:*`,
  `rejected:below_floor_or_full`, `rejected:infeasible` (no stowage-legal
  placement — hazmat caps, reefer plugs, weight order).
- **Quote reasons** (`explain.reason`): `bid_price_floor` (opportunity cost
  bound the price), `market_uplift` (segment uplift over market),
  `competitiveness_guard` (capped vs market so the shipper stays).
- **Geography**: 8 ports — `CNSHA SGSIN KRPUS NLRTM DEHAM BEANR USLAX USNYC`;
  18 servable OD routes; 4 vessels `VES1..VES4` on loops.
- **Fleet** (`data/calibration.py` VESSELS — capacity, reefer plugs,
  min/service/max kt, age, draft, reference burn at service speed):

  | ID | Name | Loop role | TEU | Reefer | kt | Age | Draft | Burn/d |
  |:--|:--|:--|--:|--:|:--|--:|--:|--:|
  | VES1 | Pacific Aurora | Asia–Europe trunk | 8,000 | 560 | 12/16/18 | 4 | 14.5m | 118t |
  | VES2 | Meridian Star | Transpacific via Busan | 5,500 | 380 | 12/16/18 | 8 | 13.0m | 90t |
  | VES3 | Atlantic Pioneer | CNSHA–USNYC express | 4,000 | 280 | 12/16/18 | 12 | 12.0m | 74t |
  | VES4 | Coral Empress | Europe feeder (SGSIN/NLRTM/BEANR) | 2,500 | 200 | 12/14/18 | 17 | 10.5m | 50t |

  Fuel: `tpd = a + b·v³` (a = 15% hotel load; b fits the table burn at
  service speed); 4 t/day auxiliary in port. Bookable own-lift ≈
  capacity × 0.45 × 0.88 (own-lift share minus stowage buffer) — that's the
  `remaining_teu` scale in `offers.json` legs, not nominal capacity.
- **Scenarios**: 10 demand regimes; the demo/eval holdout is
  `depressed-demand` + `volatile-shocks` (fixed by seed; the other 8 are
  the training pool).

## Backend internals (context, not contract)

### `models/` — the supervised layer (feeds the RL agent, never replaces it)

| Model | Input (parquet) | Predicts | Artifact |
|:--|:--|:--|:--|
| `DemandForecaster` | `route_demand_weekly` (train scenarios only) | per-route weekly demand **intensity** in lam units (request count × `MEAN_TEU_PER_BOOKING`), climatology-residual ridge, closed form | `models/artifacts/demand_forecaster/` |
| `ElasticityModel` | `price_volume_panel` | per-segment price elasticity (recovered 1.80/1.10/0.55 vs true 1.8/1.1/0.55) | `models/artifacts/elasticity/` |
| `WTPModel` | `bookings` | per-segment lognormal WTP/market (recovered 1.000/1.080/1.380) | `models/artifacts/wtp/` |

Each artifact dir = `weights.npz` + `meta.json` (features, method, fit
timestamp, holdout metrics). `models/artifacts/report.json` is the
credibility slide: the pipeline recovers its own generative parameters.

**Wiring**: `Simulator` binds the forecaster per episode
(`SimConfig.forecaster`/`forecaster_path`, default artifact dir). The bound
forecaster is consumed by (a) the bid-price engine's expected demand
(`BoundDemandForecaster.daily(r, day_lo, day_hi)`) and (b) the RL
observation (`next_week()` → 18 obs slots). It conditions on
`sim.obs_teu` — realized request intensity, including a scaled same-week
nowcast. **It never reads ground-truth future demand**; `pricing`/
`attach_pricer`/`env.reset` without it raise `RuntimeError`. Do not
reintroduce an oracle path.

### `simulator/` — the world

`Simulator(SimConfig(scenario, horizon_days, seed, start_week, pricing,
fleet_actions, vessel_ids, forecaster...))`. Loop: `begin_day()` →
`apply_decision(req, BookingDecision)` per request → optional
`apply_fleet_action` every `fleet_every` days → `end_day()`. Pricing modes:
`rate_card` | `dynamic` (fill-surge) | `bid_price`. `sim.metrics.report()`
returns the full metrics dict (see `summary.json` fields + `costs`
breakdown + `outcomes` tallies). `sim.sailings` is the public schedule;
`sim.empties` the repositionable inventory.

### `pricing/bid_price.py` — the pricing layer

`BidPriceEngine` computes per-leg opportunity cost (bid price) from
remaining capacity vs forecaster-expected contested demand; quotes =
`argmax_price P(accept)·(price − bid)`, with a competitiveness guard vs
market. Public surface used by artifacts: `quote(req, opt)`,
`explain(req, opt)`, `mean_pressure()`, `network_value()` (potential for RL
reward shaping), `counter_discount(req, opt_alt, opt_req)`.

### `env/` + `rl/` — the RL surface

`CargoFleetEnv` (Gymnasium): `Discrete(44)` — 12 booking actions (reject /
accept / flex{5,10,15,20%} / alt-hub{5,10,15%} / split{50,60,70%}) + 16
speed (4 vessels × {12,14,16,18} kt) + 16 reposition (8 port pairs ×
{75,150} TEU). `action_masks()` masks infeasible actions for MaskablePPO —
the agent can never take a physically illegal action. `OBS_DIM=112`:
market/request block, 4 voyage-option blocks (feasibility, bid, departure),
per-port congestion/empties/closure, per-vessel state, **18 forecaster
demand slots**, calendar, flags. Reward = per-step profit delta −
empty-mile penalty; potential-based bid-price shaping in phases ≥3.

`rl/train.py` curriculum phases 1–5 (14d/1-vessel → 30d/2-vessel →
+shaping → 90d/full → 90d/stress), warm-started in sequence by
`scripts/run_curriculum.sh`. `rl/evaluate.py` evaluates on **holdout
scenarios only**, identical episode seeds across policies; `--model none`
runs just the baselines. Run dirs: `runs/<name>/{model.zip, config.json}`
— config records phase, seed, pool, pricing, shaping, init_from, git_sha,
obs semantics, forecaster path.

### `baselines/` — the ablation ladder

`StaticRateCardPolicy` (rate card), `GreedyPolicy` (accept if feasible),
`DynamicHeuristicPolicy` (rules + structured counters); with
`pricing_mode="bid_price"` the same rules price via the engine. These are
**benchmarks, not fallbacks** — the demo reports RL's lift over each.

### `constraints/stowage.py` — physics

`StowagePlan.can_place()` trial-places (bays × height, destination-order
stacking, weight order, hazmat bay caps, reefer plugs) and rolls back.
This is what makes `rejected:infeasible` outcomes real.

## Commands

```bash
cd backend
.venv/bin/python -m pytest                                   # 77 tests
.venv/bin/python -m data.generate --seed 42 --out data/generated
.venv/bin/python -m models.train --data data/generated --out models/artifacts
.venv/bin/python -m scripts.run_episode --episodes 3 --horizon 60
.venv/bin/python -m rl.evaluate --model none --episodes 3 --horizon 60
.venv/bin/python -m rl.evaluate --model runs/ppo_c5/model.zip --episodes 5 --horizon 90
.venv/bin/python -m scripts.export_demo --out ../demo --model runs/ppo_c5/model.zip
```

## Gotchas

- **No live simulation on stage.** Regenerate artifacts offline; the
  frontend only reads `backend/demo/*.json`.
- **Holdout hygiene**: `depressed-demand` + `volatile-shocks` are eval-only.
  Nothing trains on them — report that to judges if asked.
- **Units**: artifact TEU values are real TEU; demand-model internals use
  lam units (request-count intensity ≈ realized TEU / 1.75). Only relevant
  if you ever touch the forecaster.
- **`mean_bid_pressure` is `null`** for static/greedy — they have no bid
  engine; render "n/a", don't render 0.
- **`explain` is `null`** when no option exists (fully infeasible requests)
  or the policy has no pricer — handle both.
- Errors are loud by design: missing forecaster artifact →
  `RuntimeError` naming the fix (`python -m models.train`), not a silent
  fallback. If the export or eval exits nonzero, that message is the bug.
