# Dock — Agent Handoff / Working Context

*Written for a fresh Devin session. Read `plan.md` first (source of truth), then this file for current state.*

## Mission right now

Backend is **complete and verified**. The full PPO curriculum ran on the
remote GPU box (phases 1–5, ~1.8M steps total): checkpoints
`runs/ppo_c1..c5/` are committed locally, `runs/ppo_c5/eval_results.json`
holds the 5-episode × 90-day holdout eval, and `public/demo/*.json` was
regenerated with `ppo` included. **PPO is the top policy on holdout
aggregate ($17.97M mean, +164% vs static) and wins volatile-shocks
outright.** The GPU box has been shut down — everything needed is in git.

**Live API + settlement layer landed** — `backend/server/` is a FastAPI
server (`uvicorn server.app:app`) that runs episodes live and streams
events over WebSocket; every event is hash-chained into
`runs/ledger/<id>.jsonl`; conditional deals (flex/alt-hub/split counters)
settle on a real in-process EVM (`settlement/` — py-evm + committed
`DockSettlement.sol` artifact, real tx hashes). `api.md` is the full
reference; `scripts/verify_ledger.py` verifies chains. `public/demo/*.json`
still backs the 5-policy comparison (served via `GET /compare/*`).

**Remaining:** the frontend build per `frontend.md` — two screens
(Customers + Fleet), a persistent money HUD that opens the comparison
dialog, decision log rail + disaster replay + credibility panel on Fleet.
`src/` stays mock until that build starts; live surfaces read the API,
comparison reads `/compare/*`.

**Product direction (explicit):** RL is the decision engine — no classic-ML
fallback anywhere. Missing artifacts raise `RuntimeError`, never degrade
silently. Supervised models feed RL (forecast → obs + bid-price engine),
they do not replace it.

## Repository

- Root: `/Users/abhinav/Projects/Dock`
- `plan.md` — full product spec. Obey its P0 scope; no P1–P3 creep.
- `README.md` — already rewritten for the hackathon pitch.
- Frontend: Next.js 16 / React 19, currently a Dock Operations UI. `AGENTS.md` says: read `node_modules/next/dist/docs/` before touching Next code (breaking changes).
- Backend: Python under `backend/` + a live FastAPI server (`backend/server/`, see `api.md`).

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
    fleet_env.py      # CargoFleetEnv (Gymnasium): Discrete(44), OBS_DIM=112,
                      #   action_masks() for MaskablePPO, per-step profit reward;
                      #   obs demand slots = forecaster.next_week() (no oracle)
  models/
    demand.py         # DemandForecaster: closed-form ridge on climatology
                      #   residual, lam units; bind() -> BoundDemandForecaster
                      #   (.daily = engine demand_fn, .next_week = env obs)
    elasticity.py     # per-segment OLS on log volume ratio (recovers 0.55/1.1/1.8)
    wtp.py            # per-segment lognormal WTP/market (recovers 1.00/1.08/1.38)
    train.py          # python -m models.train --data data/generated --out models/artifacts
    artifacts/        # committed: weights.npz + meta.json + report.json
  baselines/
    heuristics.py     # StaticRateCardPolicy, GreedyPolicy, DynamicHeuristicPolicy
  rl/
    train.py          # MaskablePPO + SubprocVecEnv; --phase 1..5 curriculum
    evaluate.py       # --model none|<path>; holdout-only, pinned seeds
  ledger/
    store.py          # hash-chained JSONL event ledger (real Keccak-256,
                      #   pycryptodome); genesis meta line; Ledger.verify()
  settlement/
    DockSettlement.sol      # one contract, many deals: registerDeal/
                            #   confirmDeparture/confirmDelivery/settle
    artifacts/DockSettlement.json  # committed bytecode+ABI (py-solc-x build)
    terms.py          # deal terms: window=board_day±2d, deadline=board+45,
                      #   penalty 1000bps; deal_id = keccak(tag:rid:call)
    chain.py          # web3 + eth-tester PyEVM adapter — real local EVM
    processor.py      # sim-event -> on-chain lifecycle bridge
  server/
    app.py            # FastAPI app + CORS; uvicorn server.app:app
    episodes.py       # EpisodeManager: thread-per-episode, pause/resume/
                      #   speed, ledger+WS fanout, deals bookkeeping
    routes.py         # REST surface (api.md)
    ws.py             # WS /episodes/{id}/stream — replay + live fanout
  scripts/
    run_episode.py    # python -m scripts.run_episode --episodes 3 --horizon 90
    export_demo.py    # python -m scripts.export_demo --out ../public/demo
    verify_ledger.py  # python -m scripts.verify_ledger <file.jsonl>
    run_curriculum.sh # full 5-phase PPO curriculum on the GPU box
  tests/              # ~130 pytest tests, all passing. pytest.ini at backend root
  runs/               # committed checkpoints ppo_c1..c5 + eval_results.json
                      #   + ledger/ per-episode event chains
  requirements.txt    # sim + RL + fastapi/uvicorn/httpx + web3/eth-tester/
                      #   py-evm/pycryptodome/py-solc-x
```

## Verified state

- `cd backend && .venv/bin/python -m pytest` → **~130 passed** (incl. API,
  ledger, settlement, sim-event suites)
- Live API E2E: `uvicorn server.app:app` → `POST /episodes` (heuristic,
  60d) → 22 deals registered on a real py-evm contract, 2 settled on-chain
  with register/departure/delivery/settle tx hashes; `ledger/verify` →
  hash chain intact; PPO episode (15d) streams 1,576 events end-to-end.
- `python -m models.train` → elasticity {1.797, 1.106, 0.553} vs true
  {1.8, 1.1, 0.55}; WTP mults {1.000, 1.080, 1.380}; demand MAPE 0.58.
- `rl.evaluate --model runs/ppo_c5/model.zip` (5×90d, holdout):
  volatile-shocks — **ppo 25.9M wins** (bid 24.7 / heuristic 23.2 /
  greedy 22.0 / static 17.0); depressed-demand — heuristic 9.0 / ppo 8.3 /
  bid 8.5 / greedy 6.5 / static −5.2 (ppo −7.2% vs heuristic — the
  forecaster lags a collapsing regime; honest artifact, reported).
- `rl.evaluate --model none` (3×60d): baseline — static 16.9M / greedy
  20.1M / heuristic 20.7M / heuristic_bid 21.5M (vs 22.7M oracle — inside
  the ±10% gate).
- `scripts/export_demo.py --model runs/ppo_c5/model.zip` →
  `public/demo/{summary,timeline,offers,shock,meta}.json`, all 5 policies
  (`policies_present` includes `ppo`), shock A/B is static-vs-ppo.
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

## Remote GPU box (training — currently powered off, all results pulled)

- `ssh abhinav@192.168.1.3` — **key-based auth already configured** from this
  Mac (`~/.ssh/id_ed25519`). No password needed. Always `-o BatchMode=yes`.
- It is **WSL2**, python3.12, ~920GB free, 12 cores, 5GB RAM. GPU: RTX 3050
  8GB, driver 572.70, CUDA 12.8 driver-level. `nvidia-smi` lives at
  `/usr/lib/wsl/lib/nvidia-smi`.
- **Note:** training is complete and the box is off. Everything it produced
  is committed under `backend/runs/` — restart only if retraining is wanted.
- Project synced at `~/Dock`. **`~/Dock/backend/.venv` is BROKEN** (mixed
  cu12/cu13 nvidia wheels — torch dumps core; do not use it). The working
  stack is **`~/.venvs/dock-rl/`**: torch 2.9.1+cu128 (cuda OK),
  stable-baselines3, sb3-contrib, tensorboard, numpy/pandas/pyarrow/
  gymnasium. Always `PY=~/.venvs/dock-rl/bin/python`.
- Sync code changes before remote runs:
  `rsync -az --exclude '.venv/' --exclude 'data/generated/' --exclude '__pycache__/' --exclude 'runs/' --exclude 'eval_results.json' -e "ssh -o BatchMode=yes" backend/ abhinav@192.168.1.3:~/Dock/backend/`
- Full curriculum: `PY=~/.venvs/dock-rl/bin/python nohup bash scripts/run_curriculum.sh > runs/curriculum.log 2>&1 &`
  phases warm-start via --init-from, then auto-evaluates on holdout.

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
- **Demand units gotcha**: `lam` is a request-rate intensity — requests
  arrive at `lam / MEAN_TEU_PER_BOOKING`/wk but carry ~15.7 TEU each, so raw
  requested TEU ≈ 1.75×lam. The forecaster + obs_teu both work in lam units
  (request counts × MEAN_TEU_PER_BOOKING). Never feed raw TEU sums into the
  forecaster.
- **No oracle**: `sim.demand.lam` is only read inside `DemandStream` itself.
  `pricing="bid_price"` or `attach_pricer()` or `CargoFleetEnv.reset` without
  a forecaster raise `RuntimeError` (point the user at `models.train`).
- Tests use `conftest.stub_forecaster()` (constant-demand StubForecaster) —
  keeps the suite hermetic without the real artifact.

## What's NOT built yet

- The frontend surfaces in `frontend.md` — `src/` still 100% mock data by
  explicit instruction. The API (`api.md`) + `public/demo/` artifacts are
  ready to drive it.
- Old `runs/ppo_phase1_*` checkpoint was trained on oracle obs — stale,
  kept for history only; `ppo_c5` is the real artifact.

## Working agreement

- Commit + push frequently (`git add -A`; message = why not what; Devin
  trailer per git rules). Note: `git commit -F - <<'EOF'` (heredoc), NOT
  `-m "$(...)"` with backticks in the message (backticks execute!).
- Use the GPU box for anything heavier than a few minutes.
- Prefer sub-agents for well-scoped chunks (they get fresh context — include
  absolute paths, module names, and exact commands in their prompt).
- Tests must stay green before commits.
