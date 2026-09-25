#!/bin/sh
# Runs migrations, then starts the API. Idempotent — safe to run on every
# container start (a fresh volume gets the full schema; an existing one
# just applies whatever revisions it's missing).
set -e

echo "docker-entrypoint: running migrations..."
alembic upgrade head

# data/generated/ isn't committed (it's ~seconds of synthetic data-gen
# output, not a design artifact); the trained model artifacts under
# models/artifacts/ ARE committed, so this doesn't retrain anything.
if [ ! -f data/generated/ports.parquet ]; then
    echo "docker-entrypoint: generating reference data (data/generated/)..."
    python -m data.generate --seed 42 --scale 1.0 --out data/generated
fi

# DOCK_SEED=1 will run a local-only synthetic seed step here once episode
# persistence lands (docs/INTEGRATION_PLAN.md §3/§5) — not implemented
# yet, so it's a no-op today; orders start empty either way (no mock rows).
if [ "${DOCK_SEED:-0}" = "1" ]; then
    echo "docker-entrypoint: DOCK_SEED=1 set, but the seed step isn't implemented yet — skipping."
fi

echo "docker-entrypoint: starting uvicorn..."
# Exactly one worker: episodes run on in-process threads with in-memory
# state, so a second worker would run a second, disconnected simulator.
exec uvicorn server.app:app --host 0.0.0.0 --port 8000 --workers 1
