"""Holdout evaluation: trained PPO vs baselines (plan.md §7).

    cd backend
    .venv/bin/python -m rl.evaluate --model runs/ppo_phase4_*/model.zip \
        --episodes 12

Every policy runs the HOLDOUT scenarios only (the build_scenarios(seed)
split that training never sees), with identical simulator seeds across
policies per episode — same demand realization, apples-to-apples. Reports
mean +/- std of the headline metrics and writes eval_results.json next to
the model.

Policies compared:
  ppo        the trained MaskablePPO, masked + deterministic, bid-price env
  static     weekly rate card, binary accept/reject (industry baseline)
  greedy     myopic dynamic pricing
  heuristic  rule-based counters + speed/repositioning (Level-1 fallback)
  heuristic_bid  heuristic rules priced by the bid-price engine (ablation:
                 separates "better pricing" from "learned sequencing")
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np

from baselines import (DynamicHeuristicPolicy, GreedyPolicy,
                       StaticRateCardPolicy)
from data.scenarios import build_scenarios
from env import CargoFleetEnv
from simulator import SimConfig, Simulator

SHOW = ["profit_usd", "revenue_usd", "revenue_per_teu", "utilization",
        "requests", "accepted", "counter_win_rate", "reject_to_counter_conv",
        "empty_teu_nm", "co2_per_teu", "fuel_tonnes", "leased_containers"]


def run_baseline(policy, scenario: str, seed: int, horizon: int) -> dict:
    cfg = SimConfig(scenario=scenario, horizon_days=horizon, seed=seed,
                    pricing=policy.pricing_mode)
    return Simulator(cfg).run(policy)


def run_ppo(model, scenario: str, seed: int, horizon: int) -> dict:
    cfg = SimConfig(scenario=scenario, horizon_days=horizon,
                    pricing="bid_price")
    env = CargoFleetEnv(cfg, scenario_pool=[scenario])
    # pin the simulator to the same seed+scenario the baselines get for
    # this episode — same demand realization, apples-to-apples
    obs, _ = env.reset(seed=seed,
                       options={"sim_seed": seed, "scenario": scenario})
    while True:
        a, _ = model.predict(obs, action_masks=env.action_masks(),
                             deterministic=True)
        obs, _r, term, trunc, _ = env.step(int(a))
        if term or trunc:
            break
    return env.sim.metrics.report()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", type=str, required=True,
                    help="path to model.zip (or 'none' for baselines only)")
    ap.add_argument("--episodes", type=int, default=12,
                    help="episodes per scenario x policy")
    ap.add_argument("--horizon", type=int, default=90)
    ap.add_argument("--seed", type=int, default=42,
                    help="scenario-split seed (must match training)")
    ap.add_argument("--scenarios", type=str, default=None,
                    help="comma list; default = holdout scenarios")
    args = ap.parse_args()

    _cfg, _train, holdout = build_scenarios(args.seed)
    scenarios = (args.scenarios.split(",") if args.scenarios else holdout)
    print(f"eval scenarios: {scenarios}  (train pool untouched: {_train})")

    model = None
    if args.model != "none":
        from sb3_contrib import MaskablePPO
        model = MaskablePPO.load(args.model)
        print(f"loaded {args.model}")

    heuristic_bid = DynamicHeuristicPolicy()
    heuristic_bid.pricing_mode = "bid_price"
    baselines = {
        "static": StaticRateCardPolicy(),
        "greedy": GreedyPolicy(),
        "heuristic": DynamicHeuristicPolicy(),
        "heuristic_bid": heuristic_bid,
    }

    results: dict[str, dict[str, list[dict]]] = {}
    t0 = time.time()
    for scen in scenarios:
        results[scen] = {k: [] for k in baselines}
        if model is not None:
            results[scen]["ppo"] = []
        for ep in range(args.episodes):
            seed = args.seed * 1000 + ep * 101
            for name, pol in baselines.items():
                results[scen][name].append(
                    run_baseline(pol, scen, seed, args.horizon))
            if model is not None:
                results[scen]["ppo"].append(
                    run_ppo(model, scen, seed, args.horizon))
        print(f"  {scen}: {args.episodes} episodes done "
              f"({time.time() - t0:.0f}s)")

    # ---- aggregate + report ------------------------------------------
    order = (["ppo"] if model is not None else []) + list(baselines)
    out = {"episodes": args.episodes, "horizon": args.horizon,
           "scenarios": scenarios, "results": {}}
    for scen in scenarios:
        out["results"][scen] = {}
        print(f"\n=== {scen} ===")
        header = f"{'policy':<14}" + "".join(f"{k:>16}" for k in
                                            ["profit_usd", "revenue_per_teu",
                                             "utilization", "empty_teu_nm"])
        print(header)
        for name in order:
            reps = results[scen][name]
            agg = {}
            for k in SHOW:
                vals = np.array([r[k] for r in reps], dtype=float)
                agg[k] = {"mean": round(float(vals.mean()), 2),
                          "std": round(float(vals.std()), 2)}
            out["results"][scen][name] = agg
            print(f"{name:<14}"
                  f"{agg['profit_usd']['mean']:>16,.0f}"
                  f"{agg['revenue_per_teu']['mean']:>16,.1f}"
                  f"{agg['utilization']['mean']:>16.3f}"
                  f"{agg['empty_teu_nm']['mean']:>16,.0f}")
        if model is not None and "ppo" in out["results"][scen]:
            for base in ("static", "heuristic"):
                lift = (out["results"][scen]["ppo"]["profit_usd"]["mean"]
                        / max(out["results"][scen][base]["profit_usd"]
                              ["mean"], 1) - 1)
                print(f"  ppo vs {base}: profit {lift:+.1%}")

    dst = (Path(args.model).parent / "eval_results.json"
           if args.model != "none" else Path("eval_results.json"))
    dst.write_text(json.dumps(out, indent=2))
    print(f"\nwrote {dst}  ({time.time() - t0:.0f}s total)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
