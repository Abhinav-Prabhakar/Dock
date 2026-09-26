# Dock

**Dynamic revenue management for container shipping fleets.**

Container shipping moves 80% of global trade and generated ~$141B in 2025 — yet it
still prices its most perishable asset (a container slot on a specific voyage on a
specific date) with a flat weekly rate card and binary accept/reject. Airlines
solved this in the 1980s and unlocked 3–9% more revenue. Shipping never did.

Dock replaces the rate card with an integrated decision system: it knows what
capacity is actually worth across the whole network, what's physically possible to
load, how to negotiate instead of reject, and when to hold capacity for a better
booking tomorrow.

> `plan.md` is the source of truth. Every feature and claim traces back to it.
> `backend.md` documents the backend contract for frontend work; `frontend.md`
> is the frontend architecture & data contract (the two `design.md` files are the visual specs). `CONTEXT.md` is the agent handoff / working state.
> `docs/INTEGRATION_PLAN.md` tracks the current work wiring both sites to the
> live backend and containerising the stack.

## What it does

- **Opportunity-cost pricing** — every quote reflects the shadow price of capacity
  on every leg of every voyage, not a flat route rate.
- **Negotiation, not rejection** — when a booking doesn't fit, Dock issues
  structured counter-offers: flexible-window discounts, alternate-hub routing,
  split consignments. Every response carries a reason code derived from the bid
  price.
- **Stowage-aware decisions** — a deterministic constraint solver (destination-
  order stacking, IMDG hazmat segregation, weight balance, reefer plugs) masks out
  physically impossible actions before pricing or the RL policy ever sees them.
- **Sequential strategy via RL** — a MaskablePPO agent learns the trade-offs a
  static scorer can't represent: holding capacity for premium demand,
  repositioning empties ahead of an export surge, slow-steaming when fuel +
  carbon savings beat delay costs.
- **Resilience** — disruption events (port closures, storms, canal blockages)
  trigger rerouting and repricing in real time.

## Architecture

```
                BOOKING REQUEST
                      │
        ┌─────────────┴──────────────┐
        │  Demand forecasting        │  (closed-form ridge, bound per
        └─────────────┬──────────────┘   episode; elasticity + WTP models
                      ▼                  for calibration)
        ┌────────────────────────────┐
        │  Bid-price engine          │  shadow price per leg / time window
        └─────────────┬──────────────┘
                      ▼
        ┌────────────────────────────┐
        │  Stowage constraint solver │  → binary action mask (hard rules,
        └─────────────┬──────────────┘    never learned)
                      ▼
        ┌────────────────────────────┐
        │  RL decision engine        │  MaskablePPO over masked actions
        └─────────────┬──────────────┘
                      ▼
        ┌────────────────────────────┐
        │  Negotiation layer         │  structured response + reason code
        └─────────────┬──────────────┘
                      ▼
           SIMULATOR / DIGITAL TWIN   (Gymnasium env — trains RL, generates
                                      data, powers the demo; >1000× real-time)
```

Design principles:

- **Hard constraints are never learned.** The RL agent only ever chooses among
  physically valid, legally compliant options.
- **No oracle leakage.** Pricing and the RL observation consume the trained
  `DemandForecaster`, never the simulator's ground-truth demand intensity.
  Missing model artifacts raise `RuntimeError` — nothing degrades silently.
- **Supervised models feed the RL policy; they never replace it.** The demand
  forecaster supplies the observation features and the bid-price engine's
  expected demand. Elasticity and WTP models calibrate and prove the pipeline
  recovers its own generative parameters.

## Repository layout

```
backend/                 Python backend (this is the core system)
  simulator/             Digital twin: ports, fleet, demand, weather, economics
  env/                   Gymnasium wrapper (CargoFleetEnv, Discrete(44), obs 112)
  constraints/           Stowage solver + action masking
  pricing/               Bid-price engine + counter-offer generation
  models/                DemandForecaster (ridge), ElasticityModel, WTPModel,
                         train CLI, committed artifacts
  rl/                    MaskablePPO curriculum training + holdout evaluation
  baselines/             Static / greedy / dynamic heuristic policies
  data/                  Calibration constants, scenario configs, generators
  scripts/               run_episode, export_demo, run_curriculum
  tests/                 145 pytest tests
  runs/                  Trained checkpoints (ppo_c1..c5) + eval_results.json
  demo/                  Exported demo artifacts (summary/timeline/offers/
                         shock/meta JSON) — served via GET /compare/*
customers/               Customer booking site (static; served at /customers)
drafts/cargo-ship/       Port-operator console (static; live 3D vessel + bookings,
                         stowage, statistics, model views)
docs/                    INTEGRATION_PLAN.md (current work)
scripts/                 smoke.sh, e2e.sh, check_imports.py
plan.md                  Product source of truth
backend.md               Backend contract: inputs, wiring, models, outputs
frontend.md              Frontend architecture + data contract
technical.md             Build directive + resolved-issue log
CONTEXT.md               Agent handoff / working state
```

## Quickstart

### Docker (whole stack)

```bash
cp .env.example .env      # optional — defaults work as-is
docker compose up --build
```

- **http://localhost:8080** — port-operator console
- **http://localhost:8080/customers/** — customer booking site
- **http://localhost:8080/api/** — the backend API (same-origin, via nginx)

`scripts/e2e.sh` runs a customer booking through to an on-chain settlement (start the stack with `DOCK_LIVE_SPEED=0.5` so the voyage takes minutes, not hours).

First run pulls/builds everything (Postgres, then the backend image with
its RL/settlement deps, then nginx) — a few minutes. The `api` container
runs migrations and generates the reference datasets on every start; the
database itself persists in the `dock_pgdata` volume across restarts.
`docker compose down -v` wipes it back to empty.

### Backend (without Docker)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 1. Generate the synthetic datasets (10 scenarios, 2 held out; ~2.6s)
python -m data.generate --seed 42 --scale 1.0 --out data/generated

# 2. Train the supervised models (required — pricing and RL error without them)
python -m models.train --data data/generated --out models/artifacts

# 3. Tests (test_api.py needs a reachable, migrated Postgres — see its
#    docstring; `docker compose up -d db && alembic upgrade head` first)
python -m pytest -q                                    # 145 tests

# 4. Run a head-to-head episode (baselines only)
python -m scripts.run_episode --episodes 3 --horizon 60

# 5. Evaluate policies on holdout scenarios (identical seeds per episode)
python -m rl.evaluate --model none --episodes 5 --horizon 90
python -m rl.evaluate --model runs/ppo_c5/model.zip --episodes 5 --horizon 90

# 6. Export the demo artifacts the frontend reads
python -m scripts.export_demo --out ../demo \
    --horizon 90 --episodes 3 --model runs/ppo_c5/model.zip
```

### RL training (GPU recommended; ~1.8M steps total)

```bash
cd backend
# one phase at a time, warm-starting from the previous checkpoint —
# or run the whole curriculum:
bash scripts/run_curriculum.sh            # phases 1-5 + auto holdout eval
# individual phase:
python -m rl.train --phase 4 --timesteps 600000 --n-envs 8 \
    --device cuda --init-from runs/ppo_c3/model.zip
```

Curriculum: 14d/1-vessel → 30d/2-vessel → +reward shaping → 90d/full-fleet →
+adversarial scenarios. Checkpoints land in `runs/ppo_cN/` with `config.json`
(git SHA + obs semantics) and TensorBoard logs.

### Live API server (without Docker)

```bash
docker compose up -d db                # just the database
cd backend
.venv/bin/alembic upgrade head          # once, or after a new migration
.venv/bin/uvicorn server.app:app --port 8399
```

FastAPI + WebSocket: `POST /episodes` starts a live sim (any policy incl.
PPO), events stream to the frontend, conditional deals settle on a real
local EVM, and every event lands in a hash-chained ledger
(`runs/ledger/<id>.jsonl`). Full reference: `api.md`. Verify a ledger with
`python -m scripts.verify_ledger runs/ledger/<id>.jsonl`.

### Frontend

Two static sites, no build step, both served same-origin by the backend:

```bash
cd backend
.venv/bin/uvicorn server.app:app --port 8399
open http://localhost:8399/customers/       # customer booking site (the backend mounts it)
# the port-operator console is served by the Docker ui service — use the Docker quickstart
```

- **`customers/`** — the customer booking site (Meridian Line): file a cargo booking, receive a live offer slip (shared `customers/shared/offers.js`; accept / flex-window / alt-hub / split counter-offers plus the PPO recommendation), and track orders through delivery on the fleet dashboard. Every `fetch` targets the backend same-origin.
- **`drafts/cargo-ship/`** — the port-operator console: a real-time 3D vessel view with a Live bookings panel (customer quotes, accepts, and the settlement of their deals), a stowage screen (side elevation + 2D top/plan view), a statistics page (5-policy comparison + shock replay), and a model page that visualizes the live PPO policy's inputs, network and outputs.

Both sites run on live data only — no mock or cached fallbacks; if the API is down they say so. `frontend.md` maps every screen to its endpoints.

## The demo

Five policies run the **identical simulator on identical demand scenarios**
(the ablation ladder — each rung adds one capability):

| Policy | What it represents |
|---|---|
| `static` | Weekly rate card, binary accept/reject — the industry today |
| `greedy` | Myopic market-rate accept |
| `heuristic` | Dynamic pricing + counter-offers, no scarcity pricing |
| `heuristic_bid` | Heuristic + bid-price opportunity cost |
| `ppo` | Dock — learned sequential policy on top of all of it |

Headline metrics: profit, revenue/TEU, utilization %, reject→counter-offer
conversions, empty container-miles, CO₂/TEU, and profit retained under shock.
A precomputed **shock replay** (port closure + demand spike mid-simulation,
identical seed A/B) is the wow moment: the static policy sails into it; Dock
reprices, reroutes, and issues reason-coded counter-offers.

Latest holdout evaluation (`runs/ppo_c5/eval_results.json`, 5 episodes × 90
days, holdout scenarios only):

| Policy | depressed-demand | volatile-shocks |
|---|---:|---:|
| static | −$5.2M | $17.0M |
| greedy | $6.5M | $22.0M |
| heuristic | $9.0M | $23.2M |
| heuristic_bid | $8.5M | $24.7M |
| **ppo** | **$8.3M** | **$25.9M — best** |

## Data

Models train on synthetic data generated by the simulator — diversified across
10 demand regimes (seasonality, trade imbalance, Poisson shock events, elastic
customer segments), with 2 scenarios held out for evaluation (`depressed-demand`,
`volatile-shocks` — **never trained on**). Real-world anchors (Drewry WCI, SCFI,
VLSFO, EU ETS) calibrate generator parameters where available — see
`backend/data/CALIBRATION.md`. Booking-level demand data with negotiation
outcomes does not exist publicly, which is why the simulator is the load-bearing
component.

## Impact

| Pillar | Claim |
|---|---|
| Economic | 5–12% more revenue per TEU, 4–8pp higher utilization from the same fleet |
| Environmental | 10–20% fewer empty container-miles; carbon-aware speed is a profit decision, not a mandate |
| Social | Counter-offers give small shippers access that binary reject denies; every quote is explainable |

## Status

Backend complete: simulator, stowage constraints, bid-price engine, supervised
models, full 5-phase PPO curriculum trained (~1.8M steps, `runs/ppo_c5`),
holdout evaluation, live API + ledger + on-chain settlement, and artifact
export all landed — 145 pytest tests green.

Frontend: both static sites run on the live API with no mock data — customers book against the live simulation and get priced counter-offers; the operator console shows the live world, every booking and the settlement of customer deals. Verified end to end by `scripts/e2e.sh`; history in `docs/INTEGRATION_PLAN.md`.
