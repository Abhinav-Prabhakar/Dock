"""Weekly route-demand forecaster — the model that closes the oracle leak.

`DemandForecaster` is a closed-form ridge regression per (route, week),
fitted on the ``route_demand_weekly`` parquet. No sklearn, no iterative
optimizer — just ``np.linalg.solve`` on the normal equations with an L2
term.

The regression target is the **climatology residual**
``log1p(teu_demanded) - log1p(clim[route, week-of-year])``, and the lag
features are residual lags. Scenario-level regime multipliers are constant
within an episode but unobserved at week 0; a level model fit on the pooled
train scenarios systematically regresses to the pooled mean (measured ~1.8x
over-prediction on a baseline episode), whereas residual lags let a single
observed week re-level the whole forecast to the episode's regime.

`BoundDemandForecaster` wraps a fitted model for one simulator episode: it
maintains a TEU history buffer indexed by *absolute* week, seeded before the
episode start with the fitted climatology and filled forward with observed
values (when the simulator supplies them — including a provisional scaled
nowcast for the week in progress) or the model's own recursive predictions.
Its ``daily(r, day_lo, day_hi)`` method has the exact ``demand_fn``
signature the pricing engine consumes.

Feature vector per (route r, week w) — 29 columns:
    0        intercept (1.0)
    1..18    route one-hot (order = data.demand.ROUTE_KEYS)
    19,20    sin/cos of 2*pi*(w mod 52)/52      (week-of-year)
    21,22    sin/cos of 2*pi*w/12               (12-week generative period)
    23       min(w, 103)/104                    (trend, clipped vs runaway)
    24..26   residual lags 1, 2, 4 weeks:
             log1p(hist[w-k]) - log1p(clim[woy(w-k)])
    27       mean of the three lag features     (rolling mean)
    28       shock indicator: hist[w-1] > 1.5 * clim[woy(w-1)]
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from data import calibration as C
from data.demand import ROUTE_ID_OF, ROUTE_KEYS

N_ROUTES = len(ROUTE_KEYS)
WEEKS_PER_YEAR = 52

# lam is a *request-rate* intensity: DemandStream / generate_bookings draw
# Poisson(lam / MEAN_TEU_PER_BOOKING) requests, but the TEU-bucket mixture
# averages ~15.7 TEU per booking, so realized requested TEU oversamples lam
# by ~1.75x. The forecaster works in lam units throughout: the training
# target is n_bookings x MEAN_TEU_PER_BOOKING (an unbiased estimator of lam
# with no TEU-mixture noise) and the simulator reports observations in the
# same count-equivalent units. What the pricing engine consumed from the
# old oracle was lam — these units preserve that calibration exactly.
REQUEST_TEU_MEAN = float(sum(
    p * (lo + hi - 1) / 2.0 for lo, hi, p in C.TEU_BUCKETS))
TEU_OVERSAMPLE = REQUEST_TEU_MEAN / C.MEAN_TEU_PER_BOOKING   # ~1.75
# Feature layout offsets (see module docstring).
_F_ONEHOT = 1
_F_WOY = _F_ONEHOT + N_ROUTES          # 19
_F_SEAS12 = _F_WOY + 2                 # 21
_F_TREND = _F_SEAS12 + 2               # 23
_F_LAGS = _F_TREND + 1                 # 24
_F_ROLL = _F_LAGS + 3                  # 27
_F_SHOCK = _F_ROLL + 1                 # 28
N_FEATURES = _F_SHOCK + 1              # 29


def _lag_value(hist_row: np.ndarray | None, w_lag: int, week_index: int,
               clim_row: np.ndarray) -> float:
    """Residual lag: log1p(TEU `k` weeks back) minus log1p(climatology).

    Residual 0 (not a level) when the lag week is outside the readable
    history (before week 0, beyond the buffer, at/after `week_index`, or
    non-finite) — the same seeding rule the bound forecaster applies to
    pre-episode weeks.
    """
    v = np.nan
    if hist_row is not None and 0 <= w_lag < week_index \
            and w_lag < hist_row.shape[0]:
        v = hist_row[w_lag]
    if not np.isfinite(v):
        v = clim_row[w_lag % WEEKS_PER_YEAR]
    return np.log1p(max(v, 0.0)) - np.log1p(
        max(clim_row[w_lag % WEEKS_PER_YEAR], 0.0))


def _features(clim: np.ndarray, r: int, w: int,
              hist_row: np.ndarray | None, week_index: int,
              out: np.ndarray) -> None:
    """Write the 29-dim feature vector for (route r, target week w) into
    `out`. `hist_row` is that route's TEU history indexed by absolute week;
    only entries < week_index are read. Pass None to seed all lags from the
    climatology."""
    out.fill(0.0)
    out[0] = 1.0
    out[_F_ONEHOT + r] = 1.0
    woy = w % WEEKS_PER_YEAR
    out[_F_WOY] = np.sin(2.0 * np.pi * woy / WEEKS_PER_YEAR)
    out[_F_WOY + 1] = np.cos(2.0 * np.pi * woy / WEEKS_PER_YEAR)
    out[_F_SEAS12] = np.sin(2.0 * np.pi * w / C.SEASONAL_PERIOD_WEEKS)
    out[_F_SEAS12 + 1] = np.cos(2.0 * np.pi * w / C.SEASONAL_PERIOD_WEEKS)
    out[_F_TREND] = min(w, C.N_WEEKS - 1) / C.N_WEEKS
    clim_row = clim[r]
    lags = np.array([
        _lag_value(hist_row, w - k, week_index, clim_row)
        for k in DemandForecaster.LAGS
    ])
    out[_F_LAGS:_F_LAGS + 3] = lags
    out[_F_ROLL] = lags.mean()
    prev = np.nan
    if hist_row is not None and 0 <= w - 1 < week_index \
            and w - 1 < hist_row.shape[0]:
        prev = hist_row[w - 1]
    if not np.isfinite(prev):
        prev = clim_row[(w - 1) % WEEKS_PER_YEAR]
    out[_F_SHOCK] = 1.0 if prev > 1.5 * clim_row[(w - 1) % WEEKS_PER_YEAR] \
        else 0.0


class DemandForecaster:
    """Ridge forecaster of weekly demanded TEU per route.

    Fit on the train-split scenarios of ``route_demand_weekly`` only; the
    route/week-of-year climatology used for lag seeding is computed on the
    same fit frame, so nothing from the holdout leaks in.
    """

    LAGS = (1, 2, 4)

    def __init__(self, l2: float = 1.0):
        self.l2 = float(l2)
        self.beta: np.ndarray | None = None      # (N_FEATURES,)
        self.clim: np.ndarray | None = None      # (R, 52) climatology
        self.meta: dict = {}

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _hist_of(weekly: pd.DataFrame) -> dict[str, np.ndarray]:
        """Per-scenario (R, max_week+1) demand-intensity arrays (lam units).

        Prefers n_bookings x MEAN_TEU_PER_BOOKING (the direct estimator of
        lam); falls back to teu_demanded / TEU_OVERSAMPLE for frames that
        lack the count column.
        """
        hists: dict[str, np.ndarray] = {}
        for sid, g in weekly.groupby("scenario_id"):
            w_max = int(g["week_index"].max()) + 1
            h = np.full((N_ROUTES, max(w_max, 1)), np.nan)
            r_idx = np.array(
                [ROUTE_ID_OF[f"{o}>{d}"] for o, d in
                 zip(g["origin_port"], g["destination_port"])])
            if "n_bookings" in g.columns:
                vals = (g["n_bookings"].to_numpy(dtype=float)
                        * C.MEAN_TEU_PER_BOOKING)
            else:
                vals = (g["teu_demanded"].to_numpy(dtype=float)
                        / TEU_OVERSAMPLE)
            h[r_idx, g["week_index"].to_numpy()] = vals
            hists[str(sid)] = h
        return hists

    def _design_matrix(self, hists: dict[str, np.ndarray],
                       ) -> tuple[np.ndarray, np.ndarray, list[tuple[str, int, int]]]:
        """(X, y, row index) over every observed (scenario, route, week)."""
        rows, ys, index = [], [], []
        feat = np.empty(N_FEATURES)
        for sid, h in hists.items():
            for r in range(N_ROUTES):
                row = h[r]
                for w in range(row.shape[0]):
                    y = row[w]
                    if not np.isfinite(y):
                        continue
                    _features(self.clim, r, w, row, w, feat)
                    rows.append(feat.copy())
                    ys.append(np.log1p(max(y, 0.0))
                              - np.log1p(max(self.clim[r, w % WEEKS_PER_YEAR],
                                             0.0)))
                    index.append((sid, r, w))
        return np.asarray(rows), np.asarray(ys), index

    # ------------------------------------------------------------------
    # public interface
    # ------------------------------------------------------------------

    def fit(self, weekly: pd.DataFrame) -> "DemandForecaster":
        """Fit on a route_demand_weekly frame (train scenarios only)."""
        hists = self._hist_of(weekly)
        # R x 52 climatology over the fit frame (all scenarios pooled).
        sums = np.zeros((N_ROUTES, WEEKS_PER_YEAR))
        cnts = np.zeros((N_ROUTES, WEEKS_PER_YEAR))
        for h in hists.values():
            for w in range(h.shape[1]):
                v = h[:, w]
                ok = np.isfinite(v)
                sums[ok, w % WEEKS_PER_YEAR] += v[ok]
                cnts[ok, w % WEEKS_PER_YEAR] += 1
        with np.errstate(invalid="ignore", divide="ignore"):
            clim = np.where(cnts > 0, sums / np.maximum(cnts, 1), np.nan)
        # any route-woy never seen -> global route mean -> global mean
        route_mean = np.nanmean(
            np.where(cnts.sum(axis=1)[:, None] > 0, clim, np.nan), axis=1)
        global_mean = float(np.nanmean(route_mean)) \
            if np.isfinite(route_mean).any() else 0.0
        route_mean = np.where(np.isfinite(route_mean), route_mean,
                              global_mean)
        self.clim = np.where(np.isfinite(clim),
                             clim, route_mean[:, None])

        X, y, index = self._design_matrix(hists)
        a = X.T @ X
        reg = self.l2 * np.eye(N_FEATURES)
        reg[0, 0] = 0.0                       # never penalise the intercept
        self.beta = np.linalg.solve(a + reg, X.T @ y)
        self.meta = {
            "model": "demand",
            "method": "closed-form ridge on climatology residual "
                      "log1p(teu)-log1p(clim[route,woy]), "
                      "np.linalg.solve normal equations",
            "l2": self.l2,
            "n_rows": int(len(y)),
            "n_features": N_FEATURES,
            "features": [
                "intercept", f"route_one_hot[{N_ROUTES}]",
                "woy_sin", "woy_cos", "seas12_sin", "seas12_cos",
                "trend=min(w,103)/104",
                "resid_lag1", "resid_lag2", "resid_lag4",
                "rolling_mean_resid_lags", "shock_indicator",
            ],
            "scenarios": sorted(hists),
        }
        return self

    def predict_week(self, hist: np.ndarray, week_index: int) -> np.ndarray:
        """(R,) predicted raw TEU for `week_index`.

        `hist` is (R, W) TEU indexed by absolute week; only columns
        < week_index are read. Predictions are expm1 of the ridge output,
        clipped at 0.
        """
        assert self.beta is not None and self.clim is not None, "not fitted"
        X = np.empty((N_ROUTES, N_FEATURES))
        feat = np.empty(N_FEATURES)
        for r in range(N_ROUTES):
            row = hist[r] if r < hist.shape[0] else None
            _features(self.clim, r, week_index, row, week_index, feat)
            X[r] = feat
        woy = week_index % WEEKS_PER_YEAR
        return np.clip(np.expm1(np.log1p(np.clip(self.clim[:, woy], 0.0,
                                               None))
                                + X @ self.beta), 0.0, None)

    def evaluate(self, weekly: pd.DataFrame) -> dict:
        """One-step-ahead eval: for each scenario, predict every
        (route, week w) from the scenario's own actual history for w' < w.

        Returns {"mape", "mae_teu", "n", "per_scenario"}; MAPE is over rows
        with actual > 5 TEU.
        """
        hists = self._hist_of(weekly)
        per_scenario: dict[str, float] = {}
        abs_err, ape, n_rows = [], [], 0
        for sid, h in hists.items():
            w_max = h.shape[1]
            preds = np.empty((N_ROUTES, w_max))
            for w in range(w_max):
                preds[:, w] = self.predict_week(h, w)
            actual = h
            ok = np.isfinite(actual)
            err = np.abs(preds - actual)
            abs_err.append(err[ok])
            n_rows += int(ok.sum())
            m = ok & (actual > 5.0)
            ape.append((err[m] / actual[m]))
            per_scenario[sid] = float((err[m] / actual[m]).mean()) \
                if m.any() else float("nan")
        abs_err = np.concatenate(abs_err) if abs_err else np.array([0.0])
        ape = np.concatenate(ape) if ape else np.array([np.nan])
        return {
            "mape": float(np.nanmean(ape)),
            "mae_teu": float(abs_err.mean()),
            "n": int(n_rows),
            "per_scenario": per_scenario,
        }

    # ------------------------------------------------------------------
    # persistence
    # ------------------------------------------------------------------

    def save(self, out_dir) -> None:
        assert self.beta is not None and self.clim is not None, "not fitted"
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        np.savez(out / "weights.npz", beta=self.beta, clim=self.clim,
                 l2=np.array(self.l2))
        meta = dict(self.meta)
        meta["model"] = "demand"
        (out / "meta.json").write_text(json.dumps(meta, indent=2))

    @classmethod
    def load(cls, out_dir) -> "DemandForecaster":
        out = Path(out_dir)
        z = np.load(out / "weights.npz")
        m = cls(l2=float(z["l2"]))
        m.beta = z["beta"]
        m.clim = z["clim"]
        meta_path = out / "meta.json"
        m.meta = json.loads(meta_path.read_text()) if meta_path.exists() \
            else {}
        return m

    # ------------------------------------------------------------------
    # episode binding
    # ------------------------------------------------------------------

    def bind(self, start_week: int, horizon_weeks: int,
             observed=None, now=None) -> "BoundDemandForecaster":
        return BoundDemandForecaster(self, int(start_week),
                                     int(horizon_weeks), observed, now)

    def predict_daily(self, route_idx: int, day_lo: float,
                      day_hi: float) -> float:
        """Convenience default binding (episode day == absolute day from
        week 0). The simulator should prefer `bind(...).daily`."""
        if not hasattr(self, "_default_bound"):
            self._default_bound = self.bind(0, C.N_WEEKS)
        return self._default_bound.daily(route_idx, day_lo, day_hi)


class BoundDemandForecaster:
    """A fitted DemandForecaster bound to one simulator episode.

    Internal hist buffer is indexed by ABSOLUTE week. Weeks < start_week
    are seeded with clim[r, woy]; weeks >= start_week are filled lazily —
    `observed(route_idx, abs_week)` (float TEU for fully-elapsed episode
    weeks, else None) takes precedence over the model's own recursive
    prediction. Predictions are computed in ascending week order so lags
    always see consistent inputs, cached, and re-checked against `observed`
    on every call.
    """

    def __init__(self, model: DemandForecaster, start_week: int,
                 horizon_weeks: int, observed, now):
        assert model.beta is not None and model.clim is not None, \
            "bind() requires a fitted model"
        self.model = model
        self.start_week = start_week
        self.horizon_weeks = horizon_weeks
        self.end_week = start_week + horizon_weeks     # exclusive
        self.observed = observed
        self.now = now

        n = max(self.end_week, 1) + 8                  # slack for overshoot
        self._hist = np.zeros((N_ROUTES, n))
        self._obs_done = np.zeros((N_ROUTES, n), dtype=bool)
        # seed pre-episode weeks with the climatology
        for w in range(max(0, min(start_week, n))):
            self._hist[:, w] = model.clim[:, w % WEEKS_PER_YEAR]
        # predictions for weeks <= _valid_upto are consistent with _hist
        self._valid_upto = max(0, start_week) - 1

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------

    def _cur_week(self) -> int:
        """Current absolute week from the episode clock."""
        if self.now is None:
            # no clock supplied: treat the episode as fully elapsed so a
            # replay binding picks up every observation it is offered
            return self.end_week - 1
        return self.start_week + int(float(self.now()) // 7)

    def _grow(self, w: int) -> None:
        if w < self._hist.shape[1]:
            return
        add = w - self._hist.shape[1] + 8
        self._hist = np.hstack(
            [self._hist, np.zeros((N_ROUTES, add))])
        self._obs_done = np.hstack(
            [self._obs_done, np.zeros((N_ROUTES, add), dtype=bool)])

    def _value(self, r: int, w: int) -> float:
        """TEU for absolute week w: climatology before the episode /
        before week 0, observed or recursively predicted inside it."""
        if w < 0 or w < self.start_week:
            return float(self.model.clim[r, w % WEEKS_PER_YEAR])
        self._sync(w)
        return float(self._hist[r, w])

    def _sync(self, upto_week: int) -> None:
        """Refresh observations for elapsed weeks plus the provisional
        nowcast for the week in progress, then (re)fill predictions in
        ascending week order through `upto_week`."""
        self._grow(upto_week)
        cur = self._cur_week()
        live = np.zeros(N_ROUTES, dtype=bool)   # routes with a live nowcast
        if self.observed is not None:
            last = min(cur, self._hist.shape[1] - 1)
            for u in range(max(0, self.start_week), last + 1):
                # elapsed weeks lock once observed; the week in progress is
                # re-read every sync (its nowcast keeps moving)
                todo = ~self._obs_done[:, u] if u < cur \
                    else np.ones(N_ROUTES, dtype=bool)
                changed = False
                for r in np.flatnonzero(todo):
                    v = self.observed(int(r), u)
                    if v is None:
                        continue
                    self._hist[r, u] = max(float(v), 0.0)
                    if u < cur:
                        self._obs_done[r, u] = True
                    else:
                        live[r] = True
                    changed = True
                if changed and u - 1 < self._valid_upto:
                    # later predictions were built without this obs
                    self._valid_upto = u - 1
        lo = max(self._valid_upto + 1, max(0, self.start_week))
        for u in range(lo, upto_week + 1):
            pred = self.model.predict_week(self._hist, u)
            keep = self._obs_done[:, u] | live if u == cur \
                else self._obs_done[:, u]
            pred[keep] = self._hist[keep, u]
            self._hist[:, u] = pred
        self._valid_upto = max(self._valid_upto, upto_week)

    # ------------------------------------------------------------------
    # public interface — daily() is the pricing engine's demand_fn
    # ------------------------------------------------------------------

    def daily(self, route_idx: int, day_lo: float, day_hi: float) -> float:
        """Expected request TEU on `route_idx` over EPISODE-DAY window
        [day_lo, day_hi]. Episode day d maps to absolute week
        start_week + d//7; each intersecting week contributes
        pred(r, w) * overlap_days/7."""
        if day_hi <= day_lo:
            return 0.0
        w_lo = self.start_week + int(np.floor(day_lo / 7.0))
        w_hi = self.start_week + int(np.floor(day_hi / 7.0))
        total = 0.0
        for w in range(w_lo, w_hi + 1):
            span_lo = 7.0 * (w - self.start_week)
            span_hi = span_lo + 7.0
            overlap = min(day_hi, span_hi) - max(day_lo, span_lo)
            if overlap <= 0.0:
                continue
            total += self._value(route_idx, w) * (overlap / 7.0)
        return float(max(total, 0.0))

    # alias matching the BidPriceEngine demand_fn naming in technical.md
    predict_daily = daily

    def next_week(self) -> np.ndarray:
        """(R,) predicted TEU for the week after the current one."""
        target = self._cur_week() + 1
        target = min(target, self.end_week - 1)
        target = max(target, 0)
        if target < self.start_week:
            return self.model.clim[:, target % WEEKS_PER_YEAR].copy()
        self._sync(target)
        return np.clip(self._hist[:, target], 0.0, None).copy()
