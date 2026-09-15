"""Hermetic tests for backend/models/ — the supervised forecaster package
(technical.md §3).

Everything runs on small SYNTHETIC frames built here; nothing reads
data/generated. Interfaces under test:

    DemandForecaster: fit(weekly_df) / predict_week(hist, w) /
        evaluate(weekly_df) / save(dir) / load(dir) /
        bind(start_week, horizon_weeks, observed, now). The bound object
        exposes .daily(r, lo, hi) (the BidPriceEngine demand_fn
        signature) and .next_week() -> (18,) (the env obs feature).
    ElasticityModel:  fit(panel_df) -> per-segment .elasticity(seg).
    WTPModel:         fit(bookings_df) -> per-segment .wtp_mult(seg).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

# models/ may not have landed yet — skip (not fail) until it does.
demand_mod = pytest.importorskip("models.demand")
elasticity_mod = pytest.importorskip("models.elasticity")
wtp_mod = pytest.importorskip("models.wtp")

from data import calibration as C          # noqa: E402
from data import demand as D               # noqa: E402

DemandForecaster = demand_mod.DemandForecaster
ElasticityModel = elasticity_mod.ElasticityModel
WTPModel = wtp_mod.WTPModel

N_ROUTES = len(D.ROUTE_KEYS)
N_WEEKS = 30
SCEN_TRAIN, SCEN_TEST = "train-a", "train-b"


# ---------------------------------------------------------------------------
# Synthetic frames
# ---------------------------------------------------------------------------

def _weekly_frame() -> pd.DataFrame:
    """Deterministic route-week demand for two scenarios sharing one
    formula: teu = base_route x (1 + 0.3 sin(2 pi w / 12)) — no noise, so
    fit/evaluate sanity is a modelling check, not a statistics check."""
    wk = np.arange(N_WEEKS)
    seas = 1.0 + 0.3 * np.sin(2 * np.pi * wk / 12.0)
    rows = []
    for scen in (SCEN_TRAIN, SCEN_TEST):
        for r, (o, d) in enumerate(D.ROUTE_KEYS):
            for w in wk:
                rows.append({
                    "scenario_id": scen,
                    "week_index": int(w),
                    "origin_port": o,
                    "destination_port": d,
                    "teu_demanded": float(D.ROUTE_BASE[r] * seas[w]),
                    "extra_col_the_model_ignores": 1.0,
                })
    return pd.DataFrame(rows)


def _hist_matrix(weekly: pd.DataFrame) -> np.ndarray:
    """(R, W) TEU history indexed by absolute week — the predict_week
    `hist` argument's shape (columns >= target week are never read)."""
    w_max = int(weekly["week_index"].max()) + 1
    h = np.full((N_ROUTES, max(w_max, 1)), np.nan)
    r_idx = np.array([D.ROUTE_ID_OF[f"{o}>{d}"] for o, d in
                      zip(weekly["origin_port"], weekly["destination_port"])])
    h[r_idx, weekly["week_index"].to_numpy()] = \
        weekly["teu_demanded"].to_numpy(dtype=float)
    return h


TRUE_ELAST = {"flexible": 1.8, "standard": 1.1, "urgent": 0.55}


def _elasticity_frame() -> pd.DataFrame:
    """Exact isoelastic response: realized = baseline * rel_price^-e."""
    rows = []
    for seg, e in TRUE_ELAST.items():
        for p in (0.80, 0.90, 1.00, 1.10, 1.25):
            base = 1200.0
            rows.append({
                "scenario_id": SCEN_TRAIN,
                "customer_segment": seg,
                "relative_price": float(p),
                "baseline_volume_teu": base,
                "realized_volume_teu": base * p ** (-e),
            })
    return pd.DataFrame(rows)


def _wtp_frame(n_per_seg: int = 4000) -> pd.DataFrame:
    """Lognormal wtp/market ratios with mu_seg = log(calibration wtp_mult)
    and a small sigma — the implied multiplier must recover exp(mu)."""
    rng = np.random.default_rng(0)
    rows = []
    for seg in C.SEGMENTS:
        mu = np.log(C.SEGMENTS[seg]["wtp_mult"])
        ratio = np.exp(rng.normal(mu, 0.10, n_per_seg))
        market = 1800.0
        rows.append(pd.DataFrame({
            "scenario_id": SCEN_TRAIN,
            "customer_segment": seg,
            "willingness_to_pay_per_teu": market * ratio,
            "market_rate_per_teu": market,
        }))
    return pd.concat(rows, ignore_index=True)


# ---------------------------------------------------------------------------
# DemandForecaster
# ---------------------------------------------------------------------------

class TestDemandForecaster:
    def _fitted(self):
        df = _weekly_frame()
        train = df[df["scenario_id"] == SCEN_TRAIN].reset_index(drop=True)
        fc = DemandForecaster()
        fc.fit(train)
        return fc, df, train

    def test_evaluate_reports_mape_on_holdout(self):
        fc, df, _ = self._fitted()
        rep = {k.lower(): v for k, v in
               fc.evaluate(df[df["scenario_id"] == SCEN_TEST]).items()}
        assert "mape" in rep
        assert rep["mape"] < 0.5          # sanity bound, not precision

    def test_predict_week_shape_and_nonneg(self):
        fc, _, train = self._fitted()
        pred = np.asarray(fc.predict_week(_hist_matrix(train), 12),
                          dtype=float)
        assert pred.shape == (N_ROUTES,)
        assert (pred >= 0).all()

    def test_bind_daily_and_next_week(self):
        fc, _, train = self._fitted()
        w0 = 10
        bound = fc.bind(start_week=w0, horizon_weeks=8)
        nw = np.asarray(bound.next_week(), dtype=float)
        assert nw.shape == (N_ROUTES,)
        assert (nw >= 0).all()
        # daily(r, 0, 7) integrates the first bound week -> the model's
        # week-w0 prediction (bound history is climatology-seeded, which
        # equals the actuals here — each fit week is a unique woy bin).
        pred = np.asarray(fc.predict_week(_hist_matrix(train), w0),
                          dtype=float)
        for r in (0, 7, N_ROUTES - 1):
            assert bound.daily(r, 0.0, 7.0) == pytest.approx(pred[r],
                                                           rel=0.05)

    def test_save_load_roundtrip(self, tmp_path):
        fc, _, train = self._fitted()
        fc.save(tmp_path)
        fc2 = DemandForecaster.load(tmp_path)
        np.testing.assert_array_equal(
            fc2.predict_week(_hist_matrix(train), 15),
            fc.predict_week(_hist_matrix(train), 15))

    def test_n_bookings_column_drives_lam_units(self):
        """The production history path estimates demand intensity as
        n_bookings x MEAN_TEU_PER_BOOKING (the direct lam estimator);
        teu_demanded / TEU_OVERSAMPLE is only the fallback for frames
        that lack the count column."""
        df = _weekly_frame()
        train = df[df["scenario_id"] == SCEN_TRAIN].reset_index(drop=True)
        h_fallback = DemandForecaster._hist_of(train)[SCEN_TRAIN]
        train2 = train.copy()
        train2["n_bookings"] = train2["teu_demanded"] / \
            (2.0 * C.MEAN_TEU_PER_BOOKING)
        h_counts = DemandForecaster._hist_of(train2)[SCEN_TRAIN]
        # counts path -> teu/2 ; fallback path -> teu/TEU_OVERSAMPLE
        np.testing.assert_allclose(
            h_counts, h_fallback * (demand_mod.TEU_OVERSAMPLE / 2.0),
            equal_nan=True)

    def test_bind_elapsed_weeks_use_observed_values(self):
        """BoundDemandForecaster._sync: an elapsed week's observed
        realization replaces the prediction and is then locked (never
        re-queried); the week in progress is re-read every sync."""
        fc, _, _ = self._fitted()
        w0 = 10
        calls: list[tuple[int, int]] = []

        def observed(r, abs_w):
            calls.append((r, abs_w))
            return 9999.0 if abs_w == w0 else None

        # episode clock at day 7 -> week w0 elapsed, w0+1 in progress
        bound = fc.bind(start_week=w0, horizon_weeks=8,
                        observed=observed, now=lambda: 7.0)
        assert bound.daily(0, 0.0, 7.0) == pytest.approx(9999.0)
        assert sum(1 for _, w in calls if w == w0) == N_ROUTES
        bound.daily(0, 7.0, 14.0)                      # syncs again
        # elapsed week stays locked; in-progress week was re-queried
        assert sum(1 for _, w in calls if w == w0) == N_ROUTES
        assert sum(1 for _, w in calls if w == w0 + 1) \
            == 2 * N_ROUTES


# ---------------------------------------------------------------------------
# ElasticityModel / WTPModel — recover the generative parameters
# ---------------------------------------------------------------------------

class TestElasticityModel:
    def test_recovers_true_elasticity_per_segment(self):
        model = ElasticityModel()
        model.fit(_elasticity_frame())
        for seg, e in TRUE_ELAST.items():
            assert model.elasticity(seg) == pytest.approx(e, abs=0.02)


class TestWTPModel:
    def test_implied_mult_recovers_lognormal_mean(self):
        model = WTPModel()
        model.fit(_wtp_frame())
        for seg in C.SEGMENTS:
            mu_true = np.log(C.SEGMENTS[seg]["wtp_mult"])
            assert model.wtp_mult(seg) == pytest.approx(
                float(np.exp(mu_true)), abs=0.02)
