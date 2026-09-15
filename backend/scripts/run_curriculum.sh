#!/usr/bin/env bash
# Full PPO curriculum run (plan.md 3.7, technical.md 5) — intended for the
# GPU box. Runs phases 1-5 sequentially, warm-starting each phase from the
# previous checkpoint, then evaluates the final model on HOLDOUT scenarios.
#
#   PY=~/.venvs/dock-rl/bin/python bash scripts/run_curriculum.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PY:-.venv/bin/python}"
SEED="${SEED:-42}"
N_ENVS="${N_ENVS:-8}"

run() {  # phase timesteps name [init_from]
  local extra=()
  if [ -n "${4:-}" ]; then extra=(--init-from "$4"); fi
  "$PY" -m rl.train --phase "$1" --timesteps "$2" --n-envs "$N_ENVS" \
      --seed "$SEED" --device auto --run-name "$3" "${extra[@]}"
}

run 1 200000 ppo_c1
run 2 300000 ppo_c2 runs/ppo_c1/model.zip
run 3 300000 ppo_c3 runs/ppo_c2/model.zip
run 4 600000 ppo_c4 runs/ppo_c3/model.zip
run 5 400000 ppo_c5 runs/ppo_c4/model.zip

"$PY" -m rl.evaluate --model runs/ppo_c5/model.zip --episodes 5 --horizon 90
echo "CURRICULUM DONE -> runs/ppo_c5/model.zip"
