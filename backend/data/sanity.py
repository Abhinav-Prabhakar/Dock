"""Programmatic sanity checks run after generation. Printed by generate.py."""

from __future__ import annotations

import numpy as np
import pandas as pd

EUROPE_PORTS = {"NLRTM", "DEHAM", "BEANR"}
ASIA_PORTS = {"CNSHA", "SGSIN", "KRPUS"}

REQUIRED_COLS = {
    "bookings": ["request_id", "scenario_id", "request_timestamp",
                 "origin_port", "destination_port", "requested_departure",
                 "flex_window_days", "teu", "container_type",
                 "weight_tonnes", "customer_segment",
                 "willingness_to_pay_per_teu", "quoted_price_per_teu",
                 "lead_time_days", "outcome", "price_driven_no_book"],
    "ports": ["port_id", "name", "lat", "lon", "berths",
              "daily_capacity_teu", "base_congestion", "tz_offset"],
    "vessels": ["vessel_id", "name", "capacity_teu", "reefer_plugs",
                "min_speed_kt", "service_speed_kt", "max_speed_kt",
                "fuel_a_tpd", "fuel_b_tpd", "age_years", "draft_m"],
    "voyages": ["voyage_id", "vessel_id", "leg_seq", "origin_port",
                "dest_port", "etd", "eta", "distance_nm", "own_lift_teu"],
    "route_demand_weekly": ["scenario_id", "week_index", "origin_port",
                            "destination_port", "n_bookings", "teu_demanded",
                            "teu_carried", "capacity_offered_teu",
                            "seasonality_index", "shock_flag"],
    "price_volume_panel": ["scenario_id", "week_index", "origin_port",
                           "destination_port", "customer_segment",
                           "price_per_teu", "realized_volume_teu"],
    "port_congestion_daily": ["scenario_id", "port_id", "date",
                              "vessel_arrivals", "berth_occupancy_pct",
                              "avg_wait_hours", "queue_length",
                              "weather_severity", "disruption_event"],
    "weather_route_weekly": ["scenario_id", "week_index", "origin_port",
                             "destination_port", "storm_probability",
                             "wave_height_mean_m", "wave_height_max_m",
                             "wind_speed_kt", "delay_probability",
                             "disruption_type", "realized_delay_days"],
    "vessel_telemetry_daily": ["vessel_id", "date", "engine_hours",
                               "mean_speed_kt", "fuel_consumed_tonnes",
                               "co2_tonnes", "vibration_rms",
                               "exhaust_temp_c", "at_sea"],
    "vessel_maintenance_events": ["vessel_id", "date", "event_type",
                                  "component", "downtime_days", "cost_usd",
                                  "failure_within_30d"],
}


def run_checks(frames: dict[str, pd.DataFrame],
               train_ids: list[str], holdout_ids: list[str]) -> dict:
    """Return {check_name: (passed: bool, detail: str)}."""
    out = {}
    b = frames["bookings"]

    # 1. Directional imbalance: Asia->Europe carried TEU > Europe->Asia
    booked = b[b["outcome"] != "rejected"]
    ae = booked["origin_port"].isin(ASIA_PORTS) & \
        booked["destination_port"].isin(EUROPE_PORTS)
    ea = booked["origin_port"].isin(EUROPE_PORTS) & \
        booked["destination_port"].isin(ASIA_PORTS)
    teu_ae = booked.loc[ae, "teu"].sum()
    teu_ea = booked.loc[ea, "teu"].sum()
    out["asia_to_europe_gt_europe_to_asia"] = (
        teu_ae > teu_ea,
        f"Asia->Europe carried {teu_ae:,.0f} TEU vs Europe->Asia "
        f"{teu_ea:,.0f} TEU ({teu_ae / max(teu_ea, 1):.2f}x)")

    # 2. Segment price ordering: urgent > standard > flexible
    seg_price = booked.groupby("customer_segment",
                               observed=True)["realized_price_per_teu"].mean()
    ok = seg_price["urgent"] > seg_price["standard"] > seg_price["flexible"]
    out["segment_price_ordering"] = (
        bool(ok),
        "mean realized $/TEU: " + ", ".join(
            f"{s}={seg_price[s]:,.0f}" for s in
            ["urgent", "standard", "flexible"]))

    # 3. Hazmat share ~10%
    hz = (b["container_type"] == "hazmat").mean()
    out["hazmat_share_approx_10pct"] = (
        abs(hz - 0.10) < 0.02, f"hazmat share = {hz:.3f}")

    # 4. Elasticity sign: within a route-week-segment cell, higher relative
    #    price must mean lower volume (de-meaned by the deterministic
    #    baseline volume so cross-route level differences don't dominate).
    pv = frames["price_volume_panel"]
    corr = np.corrcoef(
        np.log(pv["relative_price"]),
        np.log(pv["realized_volume_teu"] / pv["baseline_volume_teu"]))[0, 1]
    # ... and in the booking log, price-driven no-books increase with the
    # relative quote (checked within 'standard' so the urgent-segment quote
    # uplift doesn't mask the gradient).
    bs = b[b["customer_segment"] == "standard"]
    rel = bs["quoted_price_per_teu"] / bs["market_rate_per_teu"]
    dec = pd.qcut(rel, 10, labels=False, duplicates="drop")
    nb = bs.groupby(dec, observed=True)["price_driven_no_book"].mean()
    slope = np.corrcoef(np.arange(len(nb)), nb.to_numpy())[0, 1]
    monotone = bool(slope > 0.5 and nb.iloc[-1] > nb.iloc[0])
    out["elasticity_sign_negative"] = (
        bool(corr < 0 and monotone),
        f"within-cell log(price)~log(volume) corr={corr:.3f}; standard-seg "
        f"no-book decile slope={slope:.2f} (lowest={nb.iloc[0]:.3f}, "
        f"highest={nb.iloc[-1]:.3f})")

    # 5. No NaNs in required columns
    bad = []
    for name, cols in REQUIRED_COLS.items():
        df = frames[name]
        missing = [c for c in cols if c not in df.columns]
        nan_cols = [c for c in cols if c in df.columns
                    and df[c].isna().any()]
        if missing:
            bad.append(f"{name}: missing {missing}")
        if nan_cols:
            bad.append(f"{name}: NaNs in {nan_cols}")
    out["no_nans_in_required_columns"] = (not bad, "; ".join(bad) or "clean")

    # 6. Holdout disjoint from train
    scen_train = set(b.loc[b["scenario_id"].isin(train_ids), "scenario_id"])
    overlap = scen_train & set(holdout_ids)
    out["holdout_disjoint_from_train"] = (
        not overlap and set(train_ids).isdisjoint(holdout_ids),
        f"train={sorted(train_ids)} holdout={sorted(holdout_ids)}"
        + (f" OVERLAP={overlap}" if overlap else ""))

    # 7. Outcome distribution sanity: this is a *request* log, so rejects are
    # expected; the meaningful bars are (a) most requests convert to a deal
    # (accepted + successful counter-offers) and (b) counter-offers are a
    # visible minority of traffic (the negotiation layer needs volume to
    # matter but shouldn't dominate).
    oc = b["outcome"].value_counts(normalize=True)
    conv = oc.get("accepted", 0) + oc.get("counter_offered", 0)
    out["outcome_distribution"] = (
        0.55 < conv < 0.90 and 0.05 < oc.get("counter_offered", 0) < 0.45,
        ", ".join(f"{k}={v:.1%}" for k, v in oc.items())
        + f" (conversion={conv:.1%})")

    # 8. Congestion realism: waits mostly <24h, tail reaches multi-day
    cong = frames["port_congestion_daily"]
    p50 = cong["avg_wait_hours"].median()
    p99 = cong["avg_wait_hours"].quantile(0.99)
    mx = cong["avg_wait_hours"].max()
    out["congestion_realism"] = (
        p50 < 24 and p99 > 24,
        f"wait hours p50={p50:.1f} p99={p99:.1f} max={mx:.1f}")

    # 9. Slow-steaming fuel curve sanity: fuel(18) - fuel(14) saving 30-55%
    ves = frames["vessels"].iloc[0]
    f18 = ves["fuel_a_tpd"] + ves["fuel_b_tpd"] * 18 ** 3
    f14 = ves["fuel_a_tpd"] + ves["fuel_b_tpd"] * 14 ** 3
    saving = 1 - f14 / f18
    out["slow_steaming_saving_18_to_14kt"] = (
        0.30 < saving < 0.55, f"VES1 fuel(18)={f18:.0f}t/d, "
        f"fuel(14)={f14:.0f}t/d, saving={saving:.1%}")

    # 10. Voyage coverage: accepted bookings attach to voyages
    frac_own = (booked["voyage_id"] != "").mean()
    out["voyage_attachment"] = (
        frac_own > 0.05,
        f"{frac_own:.1%} of non-rejected bookings ride own vessels "
        f"(rest = partner/charter slots)")

    return out


def print_report(checks: dict) -> bool:
    all_ok = True
    print("\n=== SANITY CHECKS ===")
    for name, (ok, detail) in checks.items():
        all_ok &= ok
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")
    return all_ok
