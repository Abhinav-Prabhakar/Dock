"""Dock synthetic data generator — CLI entry point.

Usage:
    cd backend
    .venv/bin/python -m data.generate --seed 42 --scale 1.0 --out data/generated

Reproducibility: every RNG stream is spawned from np.random.SeedSequence(seed)
in a fixed order, so identical (seed, scale) -> identical bytes-out values.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

from . import calibration as C
from . import entities, demand, environment, sanity
from .scenarios import build_scenarios, scenario_json


def _spawn(seed: int, n: int) -> list[np.random.Generator]:
    """Deterministic, order-independent child RNG streams."""
    return [np.random.default_rng(s)
            for s in np.random.SeedSequence(seed).spawn(n)]


def _write(df: pd.DataFrame, out_dir: Path, name: str,
           preview_rows: int = 100) -> tuple[int, int]:
    """Write parquet + a small CSV preview. Returns (rows, parquet_bytes)."""
    pq = out_dir / f"{name}.parquet"
    df.to_parquet(pq, index=False)
    df.head(preview_rows).to_csv(out_dir / f"{name}_preview.csv",
                                 index=False)
    return len(df), pq.stat().st_size


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Dock synthetic data generator")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--scale", type=float, default=1.0,
                    help="multiplier on booking volume (1.0 ~ 900k bookings)")
    ap.add_argument("--out", type=str, default="data/generated",
                    help="output directory (relative to CWD)")
    args = ap.parse_args(argv)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    scen_dir = out_dir / "scenarios"
    scen_dir.mkdir(exist_ok=True)

    t0 = time.time()
    rngs = _spawn(args.seed, 64)
    rng_iter = iter(rngs)

    configs, train_ids, holdout_ids = build_scenarios(args.seed)
    scen_names = list(configs)  # insertion order = fixed

    # ---- scenario files + manifest ---------------------------------------
    manifest = {
        "seed": args.seed,
        "scale": args.scale,
        "n_scenarios": len(scen_names),
        "train_scenarios": train_ids,
        "holdout_scenarios": holdout_ids,
        "holdout_fraction": len(holdout_ids) / len(scen_names),
        "time_window": {"start": str(C.START_DATE), "end": str(C.END_DATE),
                        "weeks": C.N_WEEKS},
        "datasets": {},
        "notes": [
            "scenario_id in all per-scenario datasets == scenario file name",
            "holdout scenarios must never be used for model training",
            "voyage_id == '' in bookings means partner/charter lift or a "
            "rejected request (see CALIBRATION.md)",
        ],
    }
    for name in scen_names:
        split = "holdout" if name in holdout_ids else "train"
        rec = scenario_json(name, configs[name], split)
        # tuples -> lists for JSON
        for k, v in rec.items():
            if isinstance(v, tuple):
                rec[k] = list(v)
            elif isinstance(v, list):
                rec[k] = [list(x) if isinstance(x, tuple) else x for x in v]
        (scen_dir / f"{name}.json").write_text(json.dumps(rec, indent=2))

    # ---- static tables -----------------------------------------------------
    frames: dict[str, pd.DataFrame] = {}
    stats: dict[str, tuple[int, int]] = {}

    ports = entities.build_ports()
    vessels = entities.build_vessels()
    voyages = entities.build_voyages(next(rng_iter), vessels, ports)
    cal = entities.departure_calendar(voyages)

    stats["ports"] = _write(ports, out_dir, "ports")
    stats["vessels"] = _write(vessels, out_dir, "vessels")
    stats["voyages"] = _write(voyages, out_dir, "voyages")
    frames["ports"] = ports
    frames["vessels"] = vessels
    frames["voyages"] = voyages

    # ---- per-scenario datasets ----------------------------------------------
    bookings_all, weekly_all, panel_all, cong_all, wx_all = [], [], [], [], []
    for name in scen_names:
        cfg = configs[name]
        rng = next(rng_iter)
        mkt = demand.market_state(rng, cfg)
        lam, flag = demand.demand_intensity(rng, cfg)
        cap = demand.weekly_capacity(rng, cfg, cal)

        bk = demand.generate_bookings(rng, name, cfg, lam, mkt["rates"],
                                      cap, cal, args.scale)
        bookings_all.append(bk)
        weekly_all.append(demand.route_weekly(bk, lam, flag, cap, cfg, name))
        panel_all.append(demand.price_volume_panel(rng, name, lam,
                                                   mkt["rates"]))
        cong_all.append(environment.port_congestion_daily(rng, name, cfg))
        wx_all.append(environment.weather_route_weekly(rng, name, cfg))
        print(f"  scenario {name:32s} bookings={len(bk):,}", flush=True)

    bookings = pd.concat(bookings_all, ignore_index=True)
    bookings.insert(0, "request_id",
                    [f"BK-{i:07d}" for i in range(len(bookings))])
    frames["bookings"] = bookings
    frames["route_demand_weekly"] = pd.concat(weekly_all, ignore_index=True)
    frames["price_volume_panel"] = pd.concat(panel_all, ignore_index=True)
    frames["port_congestion_daily"] = pd.concat(cong_all, ignore_index=True)
    frames["weather_route_weekly"] = pd.concat(wx_all, ignore_index=True)

    # ---- fleet-wide datasets ------------------------------------------------
    rng_fleet = next(rng_iter)
    mnt = environment.vessel_maintenance_events(rng_fleet, vessels)
    frames["vessel_maintenance_events"] = mnt
    frames["vessel_telemetry_daily"] = environment.vessel_telemetry_daily(
        rng_fleet, vessels, voyages, mnt)

    # ---- write ---------------------------------------------------------------
    for name in ["bookings", "route_demand_weekly", "price_volume_panel",
                 "port_congestion_daily", "weather_route_weekly",
                 "vessel_telemetry_daily", "vessel_maintenance_events"]:
        stats[name] = _write(frames[name], out_dir, name)

    manifest["datasets"] = {
        k: {"rows": v[0], "parquet_bytes": v[1]} for k, v in stats.items()}
    manifest["total_parquet_mb"] = round(
        sum(v[1] for v in stats.values()) / 1e6, 1)
    manifest["generation_seconds"] = round(time.time() - t0, 1)
    (scen_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    # ---- report ---------------------------------------------------------------
    print("\n=== DATASET SUMMARY ===")
    total = 0
    for k, (rows, size) in stats.items():
        total += size
        print(f"  {name_pad(k):32s} {rows:>9,} rows   {size / 1e6:7.2f} MB")
    print(f"  {'TOTAL':32s} {'':>9}       {total / 1e6:7.2f} MB")
    print(f"  holdout scenarios: {holdout_ids}")

    ok = sanity.print_report(sanity.run_checks(frames, train_ids, holdout_ids))
    print(f"\nDone in {time.time() - t0:.1f}s -> {out_dir}")
    return 0 if ok else 1


def name_pad(s: str) -> str:
    return s


if __name__ == "__main__":
    sys.exit(main())
