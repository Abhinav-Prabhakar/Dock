"""Smoke runner: simulate episodes under each baseline policy and compare.

Usage (from backend/):
    .venv/bin/python -m scripts.run_episode --episodes 5 --horizon 90
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd

from baselines import (DynamicHeuristicPolicy, GreedyPolicy,
                       StaticRateCardPolicy)
from simulator import SimConfig, Simulator

POLICIES = {
    "static": StaticRateCardPolicy,
    "greedy": GreedyPolicy,
    "heuristic": DynamicHeuristicPolicy,
}

SHOW = ["profit_usd", "revenue_usd", "revenue_per_teu", "utilization",
        "requests", "accepted", "rejected", "counter_win_rate",
        "reject_to_counter_conv", "empty_teu_nm", "co2_per_teu",
        "leased_containers", "rolled_bookings"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodes", type=int, default=5)
    ap.add_argument("--horizon", type=int, default=90)
    ap.add_argument("--scenario", type=str, default="baseline")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    rows = []
    for name, cls in POLICIES.items():
        policy = cls()
        cfg = SimConfig(scenario=args.scenario, horizon_days=args.horizon,
                        seed=args.seed, pricing=policy.pricing_mode)
        t0 = time.time()
        reps = []
        for ep in range(args.episodes):
            cfg.seed = args.seed + ep * 101
            sim = Simulator(cfg)
            reps.append(sim.run(policy))
        if name == "heuristic":
            reps_outcomes = reps[-1]["outcomes"]
        dt = time.time() - t0
        sim_days = args.episodes * args.horizon
        r = {k: np.mean([x[k] for x in reps if k in x]) for k in SHOW}
        r["policy"] = name
        r["days_per_sec"] = round(sim_days / dt)
        rows.append(r)

    df = pd.DataFrame(rows).set_index("policy").T
    pd.set_option("display.width", 160)
    print(df.to_string(float_format=lambda x: f"{x:,.2f}"))
    print("\noutcome mix (heuristic, last episode):")
    print(f"  {reps_outcomes}")
    print(f"\nreal-time factor ~= days_per_sec x 86400")
    return 0


if __name__ == "__main__":
    sys.exit(main())
