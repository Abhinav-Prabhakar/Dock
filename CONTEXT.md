# Dock — Agent Handoff / Working Context

*Written for a fresh Devin session. Read `plan.md` first (source of truth), then this file for current state.*

## Mission right now

**Next task (user's explicit instruction):** implement the full backend training
pipeline, test everything end-to-end, verify logical correctness, run PPO
training **on the remote GPU box**, and bring the trained model back to this
machine for local use. That means:

1. Bid-price engine (plan §2.5) — still missing; needed for realistic pricing + reward shaping.
2. Supervised forecasters (plan §2.4) — demand/congestion models trained on `backend/data/generated/`.
3. Full PPO curriculum training on the GPU box (`rl/train.py` exists, phases 1–5).
4. Evaluate trained policy vs baselines on **holdout** scenarios only.
5. Copy the final `model.zip` (and any artifacts) back to this Mac under `backend/runs/`.
6. Keep tests green; commit + push to GitHub frequently (`git add -A`, remote = `origin`, branch `main`).

## Repository

- Root: `/Users/abhinav/Projects/Dock`
- `plan.md` — full product spec. Obey its P0 scope; no P1–P3 creep.
- `README.md` — already rewritten for the hackathon pitch.
- Frontend: Next.js 16 / React 19, currently a Dock Operations UI. `AGENTS.md` says: read `node_modules/next/dist/docs/` before touching Next code (breaking changes).
- Backend: pure Python under `backend/` (no web API yet — modules are imported directly).

## Backend layout (all implemented, all tested)

```
backend/
  data/
    calibration.py    # ALL constants: ports, vessels, distances, routes, rates,
                      #   segments, economics (VLSFO $600/t, ETS €80, CO2 3.15),
                      #   cargo mix, ALT_HUB map, SERVABLE helpers
    scenarios.py      # 10 scenario configs; build_scenarios(seed) -> (all, train, holdout)
    demand.py         # OFFLINE data-gen demand model (route-week intensities,
                      #   bookings with hidden wtp, price probes)
    environment.py    # offline congestion/weather/telemetry panels
    entities.py       # parquet row schemas
    generate.py       # CLI: python -m data.generate --seed 42 --scale 1.0 --out data/generated
    sanity.py         # 10 invariant checks, run at end of generate
    generated/        # gitignored; regenerate via CLI above (~2.6s at scale 1.0)
    CALIBRATION.md    # provenance: which public datasets anchored which params
  simulator/
    types.py          # CargoType/Segment/DecisionKind str-enums, dataclasses:
                      #   BookingRequest, VoyageOption, BookingDecision, FleetAction
    fleet.py          # VesselSpec, VesselState: loop schedule, per-leg capacity
                      #   ledger (teu/weight/reefer), upcoming_calls, legs_between
    demand.py         # ONLINE DemandStream: per-day Poisson requests anchored to
                      #   real sailings, hidden WTP, market rates
    metrics.py        # MetricsTracker: revenue/costs/outcomes/segments -> report()
    world.py          # Simulator + SimConfig: reset/begin_day/apply_decision/
                      #   apply_fleet_action/end_day/run/quote/feasible
  constraints/
    stowage.py        # StowagePlan: bays×height, dest-order stacking, weight order,
                      #   hazmat-designated bays (MAX 2/bay), reefer powered bays +
                      #   plug cap. can_place() = trial-place + rollback.
  env/
    fleet_env.py      # CargoFleetEnv (Gymnasium): Discrete(44), OBS_DIM=108,
                      #   action_masks() for MaskablePPO, per-step profit reward
  baselines/
    heuristics.py     # StaticRateCardPolicy, GreedyPolicy, DynamicHeuristicPolicy
  rl/
    train.py          # MaskablePPO + SubprocVecEnv; --phase 1..5 curriculum
  scripts/
    run_episode.py    # python -m scripts.run_episode --episodes 3 --horizon 90
  tests/              # 58 pytest tests, all passing (~20s). pytest.ini at backend root
  requirements.txt    # numpy pandas pyarrow gymnasium pytest
```

## Verified state (as of last session)

- `cd backend && .venv/bin/python -m pytest` → **58 passed**
- `python -m scripts.run_episode --episodes 3 --horizon 90` →
  static $10.8M / greedy $12.3M / heuristic $15.7M profit; utilization ~0.51;
  ~60–90 sim-days/sec (~7.5M× real-time). Outcome mix has reason codes.
- Env: 44 actions = 12 booking (reject, accept, flex-window{5,10,15,20%},
  alt-hub{5,10,15%}, split{50/50,60/40,70/30}) + 16 speed (4 vessels ×
  {12,14,16,18}kt) + 16 reposition (8 pairs × {75,150} TEU).
- Booking steps and fleet steps interleave; `action_masks()` gates each type.
- Curriculum `SimConfig.vessel_ids` subsets the fleet (phase 1 = VES4 only works).

## Data layer

- `python -m data.generate --seed 42 --scale 1.0 --out data/generated` →
  831,510 bookings + panels (10 parquet sets + scenario JSONs + manifest).
- Scenarios: baseline, high-imbalance, volatile-shocks, seasonal-peak,
  depressed-demand, steady-growth, boom-market, port-strike-season,
  adversarial-canal-closure, adversarial-perfect-storm. Holdout = 2 of 10
  (seeded split) — **never train on holdout**.
- `route_demand_weekly` per (scenario, route, week); bookings carry hidden
  `willingness_to_pay_per_teu`; price_volume_panel has `price_per_teu`,
  `relative_price`, `baseline_volume_teu`, `realized_volume_teu`,
  `elasticity_true` (for elasticity model fitting).

## Remote GPU box (for ALL training)

- `ssh abhinav@192.168.1.3` — **key-based auth already configured** from this
  Mac (`~/.ssh/id_ed25519`). No password needed. Always `-o BatchMode=yes`.
- It is **WSL2**, python3.12, ~940GB free. GPU: RTX 3050 8GB, driver 572.70,
  CUDA 12.8 driver-level. `nvidia-smi` lives at `/usr/lib/wsl/lib/nvidia-smi`.
- Project synced at `~/Dock`; venv `~/Dock/backend/.venv` has torch
  `2.6.0+cu124` (`cuda.is_available()=True`), stable-baselines3 2.9,
  sb3-contrib, gymnasium, pandas, xgboost, sklearn, pytest, tensorboard.
- Sync code changes before remote runs:
  `rsync -az --delete --exclude '.venv/' --exclude 'data/generated/' --exclude '__pycache__/' --exclude 'runs/' -e "ssh -o BatchMode=yes" backend/ abhinav@192.168.1.3:~/Dock/backend/`
- Verified: `python -m rl.train --phase 1 --timesteps 12000 --n-envs 4 --device cuda`
  → 12,288 steps in 26s, model saved to `~/Dock/backend/runs/ppo_phase1_*/model.zip`.
- Gotcha: torch cu128 wheel install for `torch==2.11.0` hangs/fails — that
  version doesn't exist. cu124 is fine; don't retry.

## Critical design decisions / gotchas

- **Requests anchor to real sailings**: `sim.sailings` maps OD→planned ETDs;
  DemandStream draws req_dep near an actual departure ±N(0,1.2). Without this,
  flex windows rarely hit sailings and everything rejects.
- `within_flex` tolerance = `max(flex_days, 1.0)` — jitter-tolerant.
- CargoType/Segment are `str` Enums; `constraints/stowage.py` deliberately uses
  string literals ("hazmat" etc.) — importing simulator.types there creates a
  circular import (simulator.fleet depends on stowage). Keep it import-free.
- `can_place()` = trial-place through `_pick_bay`/`_place` then roll back —
  never reimplement shadow logic (a prior version leaked phantom height).
- `own_lift_teu = capacity × OWN_LIFT_SHARE × (1 - STOWAGE_BUFFER)` — only ~40%
  of vessel capacity is bookable; demand exceeds it (scarce capacity is the point).
- Outcome mix keys: `booked:accept`, `booked:flex_window`, `booked:alt_hub`,
  `booked:split`, `price_reject`, `declined:*`, `counter_declined:*`,
  `rejected:<reason>` — all tallied in `metrics.outcomes` for reason-coded audit.
- Reward = per-step profit delta /10000 − empty-mile penalty (2e-6/TEU·nm).
- `run_episode.py` prints per-policy metrics + heuristic outcome mix.
- Tests build requests via `anchored_request(sim, ...)` in `conftest.py` —
  use it, don't fabricate dep_days that miss all sailings.

## What's NOT built yet

- `pricing/` bid-price engine (plan §2.5: shadow-price opportunity cost,
  urgency/flexibility premiums, competitiveness guard, reason codes).
- `models/` supervised forecasters (demand per route-week, congestion delay,
  WTP/acceptance probability, elasticity) trained on `data/generated/`.
- PPO actually trained beyond the 12K-step smoke run; no eval harness vs
  baselines on holdout yet; no model export/inference wrapper.
- No HTTP API; no frontend/backend wiring.

## Working agreement

- Commit + push frequently (`git add -A`; message = why not what; Devin
  trailer per git rules). Note: `git commit -F - <<'EOF'` (heredoc), NOT
  `-m "$(...)"` with backticks in the message (backticks execute!).
- Use the GPU box for anything heavier than a few minutes.
- Prefer sub-agents for well-scoped chunks (they get fresh context — include
  absolute paths, module names, and exact commands in their prompt).
- Tests must stay green before commits.
