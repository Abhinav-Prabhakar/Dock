"""PPO training for the Dock RL decision engine (plan.md §3.6, §3.7).

    cd backend
    .venv/bin/python -m rl.train --phase 1 --timesteps 200000 --n-envs 8

Curriculum phases (§3.7): tiny -> small -> +shaping -> full -> stress.
All phases train against the bid-price pricing engine (Dock = RL with
bid-price control); phase >=3 adds potential-based reward shaping.
Scenario pools always exclude the holdout scenarios.

Warm-start: --init-from runs/ppo_phaseN_*/model.zip loads the previous
phase's weights and continues training on the new phase's env.

Requires: stable-baselines3, sb3-contrib (MaskablePPO), torch.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from data.scenarios import build_scenarios
from env import CargoFleetEnv
from simulator import SimConfig

RUNS = Path(__file__).resolve().parent.parent / "runs"

# Curriculum (§3.7) — smaller worlds first, then full scale.
PHASES = {
    1: dict(horizon_days=14, vessel_ids=["VES4"], fleet_actions=False,
            shaping=False, label="tiny"),
    2: dict(horizon_days=30, vessel_ids=["VES4", "VES3"], label="small"),
    3: dict(horizon_days=30, vessel_ids=["VES4", "VES3"], shaping=True,
            label="small+shaping"),
    4: dict(horizon_days=90, vessel_ids=None, shaping=True, label="full"),
    5: dict(horizon_days=90, vessel_ids=None, shaping=True, label="stress",
            extra_pool=["adversarial-canal-closure",
                        "adversarial-perfect-storm"]),
}


def train_pool(seed: int, extra: list[str] | None = None) -> list[str]:
    _, train, _ = build_scenarios(seed)
    return train + (extra or [])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", type=int, default=1, choices=sorted(PHASES))
    ap.add_argument("--timesteps", type=int, default=200_000)
    ap.add_argument("--n-envs", type=int, default=8)
    ap.add_argument("--device", type=str, default="auto")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--pricing", type=str, default="bid_price",
                    choices=["bid_price", "dynamic"])
    ap.add_argument("--init-from", type=str, default=None,
                    help="model.zip to warm-start from (prior phase)")
    ap.add_argument("--run-name", type=str, default=None)
    args = ap.parse_args()

    try:
        from sb3_contrib import MaskablePPO
        from sb3_contrib.common.wrappers import ActionMasker
        from stable_baselines3.common.vec_env import SubprocVecEnv
    except ImportError:
        raise SystemExit(
            "RL stack missing: pip install stable-baselines3 sb3-contrib torch")

    ph = PHASES[args.phase]
    pool = train_pool(args.seed, ph.get("extra_pool"))
    cfg = SimConfig(horizon_days=ph["horizon_days"],
                    vessel_ids=ph["vessel_ids"], pricing=args.pricing,
                    fleet_actions=ph.get("fleet_actions", True))
    shaping = bool(ph.get("shaping", False))

    def masked(seed_i):
        def _init():
            env = CargoFleetEnv(cfg, scenario_pool=pool, shaping=shaping)
            return ActionMasker(env, lambda e: e.action_masks())
        return _init

    venv = SubprocVecEnv([masked(args.seed + i) for i in range(args.n_envs)])

    run_name = args.run_name or f"ppo_phase{args.phase}_{int(time.time())}"
    log_dir = RUNS / run_name
    log_dir.mkdir(parents=True, exist_ok=True)

    kwargs = dict(learning_rate=3e-4, n_steps=512, batch_size=256,
                  gamma=0.99, ent_coef=0.01, verbose=1,
                  policy_kwargs=dict(net_arch=[256, 256]),
                  tensorboard_log=str(log_dir), device=args.device,
                  seed=args.seed)
    if args.init_from:
        # warm-start: policy/value weights carry over; env and
        # hyperparameters are re-set for this phase
        model = MaskablePPO.load(args.init_from, env=venv, **kwargs)
        print(f"warm-start from {args.init_from}")
    else:
        model = MaskablePPO("MlpPolicy", venv, **kwargs)

    import subprocess
    try:
        git_sha = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], capture_output=True,
            text=True, cwd=Path(__file__).resolve().parent.parent,
            timeout=10).stdout.strip() or None
    except Exception:
        git_sha = None
    (log_dir / "config.json").write_text(json.dumps({
        "phase": args.phase, "timesteps": args.timesteps,
        "n_envs": args.n_envs, "seed": args.seed, "pool": pool,
        "horizon_days": cfg.horizon_days, "vessel_ids": cfg.vessel_ids,
        "pricing": args.pricing, "shaping": shaping,
        "init_from": args.init_from, "git_sha": git_sha,
        "obs_semantics": "forecaster-v1 (demand slots = "
                         "BoundDemandForecaster.next_week, lam units)",
        "forecaster": str(
            Path(__file__).resolve().parent.parent
            / "models" / "artifacts" / "demand_forecaster"),
    }, indent=2))

    model.learn(total_timesteps=args.timesteps)
    model.save(str(log_dir / "model"))
    print(f"saved -> {log_dir / 'model.zip'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
