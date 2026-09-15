# Dock Repo Status

Last reviewed: 2026-09-15

## What This Project Is

Dock is a hackathon project for dynamic revenue management in container shipping. The core system is a Python simulator, pricing, forecasting, constraints, and RL environment. The frontend is a Next.js dashboard.

The intended demo flow is artifact-driven:

```text
backend/scripts/export_demo.py -> public/demo/*.json -> Next.js /compare route
```

There is no backend web server today. Python modules are imported directly, and the frontend should read precomputed JSON artifacts for the demo.

## Existing Planning And Structure Docs

- `plan.md` is the product source of truth. It explains the problem, architecture, RL design, feature tiers, demo plan, and pitch claims.
- `technical.md` is the coding-agent build directive. It has the current module state, backend/frontend build order, and the `/compare` route spec.
- `CONTEXT.md` is the live handoff document. It explains the latest backend state, verification notes, remote GPU training context, and gotchas.
- `README.md` is the public-facing project summary and quickstart, but some backend paths in it are less current than `technical.md`.

- `SIDEBAR_CONTROLS.md` lists which sidebar buttons are wired, which are visual only, and how to attach behaviour to them.

For implementation work, read in this order: `plan.md`, then `technical.md`, then `CONTEXT.md`.

## Current Structure

- `backend/data/`: synthetic data generation, calibration, scenarios, and data sanity checks.
- `backend/simulator/`: digital twin for fleet, demand, world state, and metrics.
- `backend/constraints/`: stowage and hard feasibility checks.
- `backend/pricing/`: bid-price engine and reason-coded pricing explanations.
- `backend/models/`: demand, elasticity, and willingness-to-pay models with committed artifacts.
- `backend/env/`: Gymnasium environment for RL with action masking.
- `backend/rl/`: MaskablePPO training and evaluation.
- `backend/baselines/`: static, greedy, dynamic, and bid-price heuristic policies.
- `backend/scripts/`: episode runner, curriculum runner, and demo JSON exporter.
- `backend/tests/`: pytest suite for simulator, environment, data, stowage, and models.
- `src/app/`: Next.js App Router frontend. Current root page is a mock operations UI.
- `src/components/`: UI components for the existing operations screen and chat panel.
- `src/lib/`: frontend mock data and LLM helper code.
- `public/demo/`: generated static demo artifacts.

## Current Status

Backend status is mostly complete for the hackathon demo. The simulator, stowage constraints, bid-price pricing, baseline policies, forecaster models, RL environment, evaluation harness, and demo export pipeline are present.

The generated demo artifacts currently exist in `public/demo/`: `summary.json`, `timeline.json`, `offers.json`, `shock.json`, and `meta.json`. `meta.json` lists `static`, `greedy`, `heuristic`, and `heuristic_bid`; there is no `ppo` policy artifact yet.

Frontend status is incomplete for the planned demo. The existing `src/app/page.tsx` renders a mock Dock Operations interface using `src/lib/data.ts`. It does not consume `public/demo/` artifacts. The planned judge-facing `/compare` route is specified in `technical.md` section 4.2 but is not implemented.

The current branch is `design`, with remote `origin` at `git@github.com:Abhinav-Prabhakar/Dock.git`.

## Assistant Setup

- `AGENTS.md` contains the Next.js 16 warning for coding agents.
- `CLAUDE.md` contains `@AGENTS.md`, so Claude Code receives the same guidance.
- `.cursor/rules/dock-project.mdc` gives Cursor the same project-level arrangement, plus pointers to `plan.md`, `technical.md`, and `CONTEXT.md`.

## Main Gaps

- Build `src/app/compare/page.tsx` to render the artifact-driven comparison dashboard from `public/demo/*.json`.
- Add the priority panels from `technical.md` section 4.2: headline scoreboard, racing-lines chart, reason-coded offer feed, impact strip, and then shock panel.
- Pull in a trained PPO checkpoint only if the curriculum run finishes, then rerun `backend/scripts/export_demo.py` with the model so `public/demo/meta.json` includes `ppo`.
- Keep README quickstart paths in mind: `technical.md` and the actual backend layout are more current than the README's older `forecasting/` and `baselines.evaluate` references.

## Quick Verification Commands

```bash
npm run lint
cd backend && .venv/bin/python -m pytest
cd backend && .venv/bin/python -m scripts.export_demo --out ../public/demo --horizon 90 --episodes 5 --seed 42
```
