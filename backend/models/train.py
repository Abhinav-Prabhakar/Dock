"""Train the three supervised models on the generated parquet data.

    cd backend
    .venv/bin/python -m models.train --data data/generated \
        --out models/artifacts [--seed 42]

Train/holdout scenario split comes from
``<data>/scenarios/manifest.json`` when present, else from
``build_scenarios(seed)``. Each model is fitted on TRAIN scenario rows
only and evaluated on HOLDOUT rows. Artifacts land in ``<out>/<name>/``
(weights.npz + meta.json) and a combined report in ``<out>/report.json``.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from .demand import DemandForecaster
from .elasticity import ElasticityModel
from .wtp import WTPModel


def _split(data_dir: Path, seed: int) -> tuple[list[str], list[str]]:
    """(train_ids, holdout_ids) — manifest first, build_scenarios else."""
    manifest = data_dir / "scenarios" / "manifest.json"
    if manifest.exists():
        m = json.loads(manifest.read_text())
        return (list(m["train_scenarios"]), list(m["holdout_scenarios"]))
    from data.scenarios import build_scenarios
    _configs, train, holdout = build_scenarios(seed)
    return list(train), list(holdout)


def _fit_eval(name: str, model, fit_df: pd.DataFrame,
              eval_df: pd.DataFrame, out_dir: Path) -> dict:
    model.fit(fit_df)
    metrics = model.evaluate(eval_df)
    model.save(out_dir / name)
    # stamp meta.json with timestamp + eval metrics
    meta_path = out_dir / name / "meta.json"
    meta = json.loads(meta_path.read_text())
    meta["fit_timestamp_utc"] = datetime.now(timezone.utc).isoformat()
    meta["eval_metrics"] = metrics
    meta_path.write_text(json.dumps(meta, indent=2))
    return metrics


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", default="data/generated",
                    help="directory containing the generated parquets")
    ap.add_argument("--out", default="models/artifacts",
                    help="output directory for model artifacts")
    ap.add_argument("--seed", type=int, default=42,
                    help="master seed (only used if no manifest.json)")
    args = ap.parse_args()

    data_dir = Path(args.data)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    train_ids, holdout_ids = _split(data_dir, args.seed)
    print(f"train scenarios   ({len(train_ids)}): {', '.join(train_ids)}")
    print(f"holdout scenarios ({len(holdout_ids)}): {', '.join(holdout_ids)}")

    weekly = pd.read_parquet(data_dir / "route_demand_weekly.parquet")
    panel = pd.read_parquet(data_dir / "price_volume_panel.parquet")
    bookings = pd.read_parquet(
        data_dir / "bookings.parquet",
        columns=["scenario_id", "customer_segment",
                 "willingness_to_pay_per_teu", "market_rate_per_teu"])

    in_train = lambda df: df["scenario_id"].isin(train_ids)
    in_hold = lambda df: df["scenario_id"].isin(holdout_ids)

    metrics = {
        "demand": _fit_eval("demand_forecaster", DemandForecaster(),
                            weekly[in_train(weekly)],
                            weekly[in_hold(weekly)], out_dir),
        "elasticity": _fit_eval("elasticity", ElasticityModel(),
                                panel[in_train(panel)],
                                panel[in_hold(panel)], out_dir),
        "wtp": _fit_eval("wtp", WTPModel(),
                         bookings[in_train(bookings)],
                         bookings[in_hold(bookings)], out_dir),
    }

    report = {
        "seed": args.seed,
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "split": {"train": train_ids, "holdout": holdout_ids},
        "models": metrics,
    }
    (out_dir / "report.json").write_text(json.dumps(report, indent=2))

    # ------------------------------------------------------------- table
    d = metrics["demand"]
    print("\n=== holdout metrics ===")
    print(f"{'model':<12} {'metric':<28} value")
    print("-" * 55)
    print(f"{'demand':<12} {'MAPE (actual>5 TEU)':<28} {d['mape']:.4f}")
    print(f"{'':<12} {'MAE (TEU)':<28} {d['mae_teu']:.2f}")
    print(f"{'':<12} {'rows':<28} {d['n']}")
    for sid, mape in d["per_scenario"].items():
        print(f"{'':<12} {'  mape[' + sid + ']':<28} {mape:.4f}")
    print("-" * 55)
    for seg, p in metrics["elasticity"]["per_segment"].items():
        print(f"{'elasticity':<12} {seg:<28} est {p['estimated']:.3f} "
              f"(true {p['true']:.2f}, err {p['abs_err']:.3f})")
    print(f"{'':<12} {'max_abs_err':<28} "
          f"{metrics['elasticity']['max_abs_err']:.4f}")
    print("-" * 55)
    for seg, p in metrics["wtp"]["per_segment"].items():
        print(f"{'wtp':<12} {seg:<28} mult {p['implied_mult']:.3f} "
              f"(true {p['true_mult']:.2f}, err {p['abs_err']:.3f}) "
              f"mu {p['mu']:.3f} sigma {p['sigma']:.3f}")
    print(f"{'':<12} {'max_abs_err':<28} "
          f"{metrics['wtp']['max_abs_err']:.4f}")
    print("-" * 55)
    print(f"report written to {out_dir / 'report.json'}")


if __name__ == "__main__":
    main()
