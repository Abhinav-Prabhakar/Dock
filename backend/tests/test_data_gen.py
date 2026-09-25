"""Data generator: determinism, schema, scenario split, sanity checks."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from data import generate
from data.scenarios import SCENARIOS, build_scenarios

SCALE = "0.03"          # small but statistically meaningful (~25k bookings)


@pytest.fixture(scope="module")
def generated(tmp_path_factory) -> Path:
    out = tmp_path_factory.mktemp("gen")
    rc = generate.main(["--seed", "0", "--scale", SCALE,
                        "--out", str(out)])
    assert rc == 0, "generator sanity checks failed"
    return out


class TestCLI:
    def test_writes_all_datasets(self, generated):
        for name in ["bookings", "route_demand_weekly", "price_volume_panel",
                     "port_congestion_daily", "weather_route_weekly",
                     "vessel_telemetry_daily", "vessel_maintenance_events",
                     "ports", "vessels", "voyages"]:
            assert (generated / f"{name}.parquet").exists(), name

    def test_manifest_and_holdout(self, generated):
        manifest = json.loads(
            (generated / "scenarios" / "manifest.json").read_text())
        train = set(manifest["train_scenarios"])
        hold = set(manifest["holdout_scenarios"])
        assert train and hold and train.isdisjoint(hold)
        assert train | hold == set(SCENARIOS)
        assert manifest["holdout_fraction"] == pytest.approx(0.2)

    def test_determinism(self, generated, tmp_path):
        out2 = tmp_path / "gen2"
        assert generate.main(["--seed", "0", "--scale", SCALE,
                              "--out", str(out2)]) == 0
        w1 = pd.read_parquet(generated / "route_demand_weekly.parquet")
        w2 = pd.read_parquet(out2 / "route_demand_weekly.parquet")
        pd.testing.assert_frame_equal(w1, w2)
        b1 = pd.read_parquet(generated / "bookings.parquet")
        b2 = pd.read_parquet(out2 / "bookings.parquet")
        assert len(b1) == len(b2)
        assert b1["willingness_to_pay_per_teu"].sum() == \
            pytest.approx(b2["willingness_to_pay_per_teu"].sum())


class TestSchema:
    def test_bookings_columns(self, generated):
        b = pd.read_parquet(generated / "bookings.parquet")
        required = {"request_id", "scenario_id", "request_timestamp",
                    "origin_port", "destination_port", "teu",
                    "container_type", "customer_segment",
                    "willingness_to_pay_per_teu", "quoted_price_per_teu",
                    "outcome", "market_rate_per_teu"}
        assert required <= set(b.columns)
        assert b["outcome"].isin(
            ["accepted", "rejected", "counter_offered"]).all()
        assert not b[["origin_port", "destination_port", "teu",
                      "willingness_to_pay_per_teu"]].isna().any().any()

    def test_scenario_files_parse(self, generated):
        for f in (generated / "scenarios").glob("*.json"):
            if f.name == "manifest.json":
                continue
            rec = json.loads(f.read_text())
            assert rec["scenario_id"] == f.stem
            assert rec["split"] in ("train", "holdout")


class TestStatisticalProperties:
    """Spot-check the domain properties the models rely on (plan §5)."""

    def test_price_ordering_by_segment(self, generated):
        b = pd.read_parquet(generated / "bookings.parquet")
        mean_wtp = b.groupby("customer_segment")[
            "willingness_to_pay_per_teu"].mean()
        assert mean_wtp["urgent"] > mean_wtp["standard"] \
            > mean_wtp["flexible"]

    def test_trade_imbalance_direction(self, generated):
        b = pd.read_parquet(generated / "bookings.parquet")
        carried = b[b["outcome"] != "rejected"]
        asia_eu = carried[carried["origin_port"].isin(
            ["CNSHA", "SGSIN", "KRPUS"])
            & carried["destination_port"].isin(["NLRTM", "DEHAM", "BEANR"])]
        eu_asia = carried[carried["origin_port"].isin(
            ["NLRTM", "DEHAM", "BEANR"])
            & carried["destination_port"].isin(["CNSHA", "SGSIN", "KRPUS"])]
        assert asia_eu["teu"].sum() > 1.5 * eu_asia["teu"].sum()

    def test_elasticity_sign(self, generated):
        p = pd.read_parquet(generated / "price_volume_panel.parquet")
        assert {"price_per_teu", "realized_volume_teu"} <= set(p.columns)
        # isolate within-cell elasticity: normalize out the baseline demand
        # level (price and volume are both high on busy routes)
        p = p[p["baseline_volume_teu"] > 20].copy()
        p["norm_vol"] = p["realized_volume_teu"] / p["baseline_volume_teu"]
        corr = np.corrcoef(np.log(p["relative_price"]),
                           np.log(p["norm_vol"]))[0, 1]
        assert corr < -0.5

    def test_hazmat_share(self, generated):
        b = pd.read_parquet(generated / "bookings.parquet")
        share = (b["container_type"] == "hazmat").mean()
        assert 0.05 < share < 0.15
