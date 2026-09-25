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

## What it does

- **Opportunity-cost pricing** — every quote reflects the shadow price of capacity
  on every leg of every voyage, not a flat route rate.
- **Negotiation, not rejection** — when a booking doesn't fit, Dock issues
  structured counter-offers: flexible-window discounts, alternate-hub routing,
  split consignments, overbooking with compensation, forward contracts. Every
  response carries a reason code derived from the bid price.
- **Stowage-aware decisions** — a deterministic constraint solver (destination-
  order stacking, IMDG hazmat segregation, weight balance, reefer plugs) masks out
  physically impossible actions before pricing or the RL policy ever sees them.
- **Sequential strategy via RL** — a PPO agent learns the trade-offs a static
  scorer can't represent: holding capacity for premium demand, repositioning
  empties ahead of an export surge, slow-steaming when fuel + carbon savings beat
  delay costs.
- **Resilience** — disruption events (port closures, storms, canal blockages)
  trigger automatic rerouting and repricing in real time.

## Architecture

```
                BOOKING REQUEST
                      │
        ┌─────────────┴──────────────┐
        │  Demand & risk forecasting │  (supervised: XGBoost / small NNs)
        └─────────────┬──────────────┘
                      ▼
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

Design principle: **hard constraints are never learned.** The RL agent only ever
chooses among physically valid, legally compliant options.

## Repository layout

```
backend/                 Python backend (this is the core system)
  simulator/             Digital twin: ports, fleet, demand, weather, economics
  env/                   Gymnasium wrapper (CargoFleetEnv)
  constraints/           Stowage solver + action masking
  pricing/               Bid-price engine + counter-offer generation
  forecasting/           Supervised models (demand, elasticity, risk, congestion)
  rl/                    PPO training (Stable-Baselines3 + sb3-contrib)
  baselines/             Static, rule-based, greedy, supervised policies
  data/                  Synthetic datasets + generators
src/                     Next.js dashboard (App Router, TypeScript, Tailwind)
plan.md                  Source of truth
```

## Quickstart

```bash
# Frontend
npm install
npm run dev

# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m data.generate          # build synthetic datasets
python -m baselines.evaluate     # run head-to-head policy comparison
python -m rl.train               # PPO training (curriculum phases)
```

## The demo

Three policies run the **identical simulator on identical demand scenarios**:

| Policy | What it represents |
|---|---|
| Static baseline | Weekly rate card, binary accept/reject — the industry today |
| Supervised NN | Dynamic pricing without sequential strategy |
| Dock (RL) | Full system: bid prices, counter-offers, speed, repositioning |

Headline metrics: revenue/TEU, utilization %, reject→counter-offer conversions,
empty container-miles, CO₂/TEU, profit retained under shock. Live **shock
injection** (port closure mid-simulation) is the wow moment: the baseline sails
into it; Dock reroutes, reprices, and issues reason-coded counter-offers in real
time.

Graduated fallback: if RL doesn't converge in hackathon time, the demo runs on
the supervised or rule-based policy — dynamic pricing beating static pricing is
already the story.

## Data

Models train on synthetic data generated by the simulator — diversified across
≥5 demand distributions (seasonality, trade imbalance, Poisson shock events,
elastic customer segments), with 20% of scenarios held out for evaluation. Real-
world benchmarks (freight indices, port statistics) calibrate generator
parameters where available; booking-level demand data with negotiation outcomes
does not exist publicly, which is why the simulator is the load-bearing
component.

## Impact

| Pillar | Claim |
|---|---|
| Economic | 5–12% more revenue per TEU, 4–8pp higher utilization from the same fleet |
| Environmental | 10–20% fewer empty container-miles; carbon-aware speed is a profit decision, not a mandate |
| Social | Counter-offers give small shippers access that binary reject denies; every quote is explainable |

## Status

Hackathon build in progress. Feature tiers (P0 must-ship → P3 slides-only) and
the full technical design live in [`plan.md`](plan.md).
