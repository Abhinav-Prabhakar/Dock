"""Per-segment price-elasticity recovery from the price-volume panel.

The generator draws ``realized_volume = baseline * relative_price**(-e) *
lognormal(0, 0.15)``, so a per-segment OLS of
``log(realized / baseline)`` on ``log(relative_price)`` recovers
``-elasticity`` as the slope, in closed form (no optimizer, no sklearn).
The panel's randomized price probes (relative_price in
{0.80, 0.90, 1.00, 1.10, 1.25}) supply the off-market price variation an
observational booking log could not identify.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from data.demand import SEG_NAMES


class ElasticityModel:
    """Closed-form per-segment elasticity estimates.

    `self.params[segment] = {"elasticity", "intercept", "n"}` where
    ``intercept`` is the OLS intercept of the log-log regression
    (generatively ~0; kept so `predict_ratio` is exact).
    """

    def __init__(self):
        self.params: dict[str, dict] = {}
        self.meta: dict = {}

    # ------------------------------------------------------------------

    @staticmethod
    def _ols(panel: pd.DataFrame) -> tuple[float, float, int]:
        """(slope, intercept, n) of y=log(real/baseline) on
        x=log(relative_price) over the valid rows of `panel`."""
        m = ((panel["baseline_volume_teu"] > 0)
             & (panel["realized_volume_teu"] > 0)
             & (panel["relative_price"] > 0))
        p = panel.loc[m]
        x = np.log(p["relative_price"].to_numpy(dtype=float))
        y = np.log(p["realized_volume_teu"].to_numpy(dtype=float)
                   / p["baseline_volume_teu"].to_numpy(dtype=float))
        n = int(len(x))
        if n < 2 or float(np.var(x)) == 0.0:
            return 0.0, float(y.mean()) if n else 0.0, n
        xc = x - x.mean()
        slope = float((xc * (y - y.mean())).sum() / (xc * xc).sum())
        return slope, float(y.mean() - slope * x.mean()), n

    # ------------------------------------------------------------------
    # public interface
    # ------------------------------------------------------------------

    def fit(self, panel: pd.DataFrame) -> "ElasticityModel":
        self.params = {}
        for seg in SEG_NAMES:
            slope, intercept, n = self._ols(
                panel[panel["customer_segment"] == seg])
            self.params[seg] = {"elasticity": -slope,
                                "intercept": intercept, "n": n}
        self.meta = {
            "model": "elasticity",
            "method": "per-segment OLS of log(realized/baseline) on "
                      "log(relative_price); elasticity = -slope",
            "segments": SEG_NAMES,
        }
        return self

    def elasticity(self, segment: str) -> float:
        return float(self.params[segment]["elasticity"])

    def predict_ratio(self, segment: str,
                      relative_price: np.ndarray | float) -> np.ndarray:
        """Expected realized/baseline volume ratio at `relative_price`."""
        p = self.params[segment]
        rp = np.asarray(relative_price, dtype=float)
        return np.exp(p["intercept"]
                      - p["elasticity"] * np.log(np.maximum(rp, 1e-9)))

    def evaluate(self, panel: pd.DataFrame) -> dict:
        """Compare fitted elasticities to the panel's elasticity_true."""
        per_segment: dict[str, dict] = {}
        max_err = 0.0
        for seg in SEG_NAMES:
            g = panel[panel["customer_segment"] == seg]
            est = float(self.params.get(seg, {}).get("elasticity",
                                                     float("nan")))
            true = float(g["elasticity_true"].mean()) if len(g) \
                else float("nan")
            err = abs(est - true)
            max_err = max(max_err, err) if np.isfinite(err) else max_err
            per_segment[seg] = {"estimated": est, "true": true,
                                "abs_err": float(err)}
        return {"per_segment": per_segment, "max_abs_err": float(max_err)}

    # ------------------------------------------------------------------
    # persistence
    # ------------------------------------------------------------------

    def save(self, out_dir) -> None:
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        segs = list(self.params)
        np.savez(out / "weights.npz",
                 segments=np.array(segs),
                 elasticity=np.array([self.params[s]["elasticity"]
                                      for s in segs]),
                 intercept=np.array([self.params[s]["intercept"]
                                     for s in segs]),
                 n=np.array([self.params[s]["n"] for s in segs]))
        meta = dict(self.meta)
        meta["model"] = "elasticity"
        meta["params"] = self.params
        (out / "meta.json").write_text(json.dumps(meta, indent=2))

    @classmethod
    def load(cls, out_dir) -> "ElasticityModel":
        out = Path(out_dir)
        z = np.load(out / "weights.npz")
        m = cls()
        for i, seg in enumerate(z["segments"]):
            m.params[str(seg)] = {
                "elasticity": float(z["elasticity"][i]),
                "intercept": float(z["intercept"][i]),
                "n": int(z["n"][i]),
            }
        meta_path = out / "meta.json"
        m.meta = json.loads(meta_path.read_text()) if meta_path.exists() \
            else {}
        return m
