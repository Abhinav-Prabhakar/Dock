"""PPO training for the Dock RL decision engine (plan.md §3.6, §3.7).

    cd backend
    .venv/bin/python -m rl.train --phase 1 --timesteps 200000 --n-envs 8

Curriculum phases (§3.7): tiny -> small -> +shaping -> full -> stress.
Scenario pools always exclude the holdout scenarios.

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
    1: dict(horizon_days=14, vessel_ids=["VES4"], label="tiny"),
    2: dict(horizon_days=30, vessel_ids=["VES4", "VES3"], label="small"),
    3: dict(horizon_days=30, vessel_ids=None, label="small+shaping"),
    4: dict(horizon_days=90, vessel_ids=None, label="full"),
    5: dict(horizon_days=90, vessel_ids=None, label="stress",
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
                    vessel_ids=ph["vessel_ids"], pricing="dynamic")

    def masked(seed_i):
        def _init():
            env = CargoFleetEnv(cfg, scenario_pool=pool)
            return ActionMasker(env, lambda e: e.action_masks())
        return _init

    venv = SubprocVecEnv([masked(args.seed + i) for i in range(args.n_envs)])

    run_name = args.run_name or f"ppo_phase{args.phase}_{int(time.time())}"
    log_dir = RUNS / run_name
    log_dir.mkdir(parents=True, exist_ok=True)

    model = MaskablePPO(
        "MlpPolicy", venv,
        learning_rate=3e-4, n_steps=512, batch_size=256,
        gamma=0.99, ent_coef=0.01, verbose=1,
        policy_kwargs=dict(net_arch=[256, 256]),
        tensorboard_log=str(log_dir), device=args.device, seed=args.seed)

    (log_dir / "config.json").write_text(json.dumps({
        "phase": args.phase, "timesteps": args.timesteps,
        "n_envs": args.n_envs, "seed": args.seed, "pool": pool,
        "horizon_days": cfg.horizon_days, "vessel_ids": cfg.vessel_ids,
    }, indent=2))

    model.learn(total_timesteps=args.timesteps)
    model.save(str(log_dir / "model"))
    print(f"saved -> {log_dir / 'model.zip'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
