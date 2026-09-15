"""Per-segment willingness-to-pay model from the bookings log.

The generator draws ``wtp = market_rate * wtp_mult * exp(N(0, wtp_sd))``,
so ``log(wtp / market_rate)`` is normal with mean ``log(wtp_mult)`` and
std ``wtp_sd``. Per segment we fit a lognormal in closed form:
``mu = mean(log ratio)``, ``sigma = std(log ratio)``; the implied WTP
multiplier is ``exp(mu)`` and should recover calibration's
``{flexible 1.00, standard 1.08, urgent 1.38}``.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from data import calibration as C
from data.demand import SEG_NAMES


class WTPModel:
    """Closed-form per-segment lognormal WTP (mu, sigma).

    `self.params[segment] = {"mu", "sigma", "n"}`.
    """

    def __init__(self):
        self.params: dict[str, dict] = {}
        self.meta: dict = {}

    # ------------------------------------------------------------------
    # public interface
    # ------------------------------------------------------------------

    def fit(self, bookings: pd.DataFrame) -> "WTPModel":
        self.params = {}
        ratio = (bookings["willingness_to_pay_per_teu"].to_numpy(dtype=float)
                 / bookings["market_rate_per_teu"].to_numpy(dtype=float))
        seg_arr = bookings["customer_segment"].to_numpy()
        for seg in SEG_NAMES:
            r = ratio[seg_arr == seg]
            r = r[np.isfinite(r) & (r > 0)]
            lr = np.log(r)
            self.params[seg] = {
                "mu": float(lr.mean()) if len(lr) else 0.0,
                "sigma": float(lr.std()) if len(lr) else 0.0,
                "n": int(len(lr)),
            }
        self.meta = {
            "model": "wtp",
            "method": "per-segment lognormal: mu/sigma = mean/std of "
                      "log(willingness_to_pay_per_teu / market_rate_per_teu)",
            "segments": SEG_NAMES,
        }
        return self

    def wtp_mult(self, segment: str) -> float:
        """Implied mean WTP multiplier exp(mu) for `segment`."""
        return float(np.exp(self.params[segment]["mu"]))

    def sample_ratio(self, segment: str, n: int,
                     rng: np.random.Generator | None = None) -> np.ndarray:
        """Draw n WTP/market-rate ratios from the fitted lognormal."""
        rng = rng or np.random.default_rng()
        p = self.params[segment]
        return np.exp(rng.normal(p["mu"], p["sigma"], size=int(n)))

    def evaluate(self, bookings: pd.DataFrame) -> dict:
        """Compare implied WTP multipliers to calibration's wtp_mult."""
        per_segment: dict[str, dict] = {}
        max_err = 0.0
        for seg in SEG_NAMES:
            p = self.params.get(seg, {"mu": float("nan"),
                                      "sigma": float("nan")})
            implied = float(np.exp(p["mu"]))
            true = float(C.SEGMENTS[seg]["wtp_mult"])
            err = abs(implied - true)
            max_err = max(max_err, err) if np.isfinite(err) else max_err
            per_segment[seg] = {
                "mu": p["mu"], "sigma": p["sigma"],
                "implied_mult": implied, "true_mult": true,
                "abs_err": float(err),
            }
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
                 mu=np.array([self.params[s]["mu"] for s in segs]),
                 sigma=np.array([self.params[s]["sigma"] for s in segs]),
                 n=np.array([self.params[s]["n"] for s in segs]))
        meta = dict(self.meta)
        meta["model"] = "wtp"
        meta["params"] = self.params
        (out / "meta.json").write_text(json.dumps(meta, indent=2))

    @classmethod
    def load(cls, out_dir) -> "WTPModel":
        out = Path(out_dir)
        z = np.load(out / "weights.npz")
        m = cls()
        for i, seg in enumerate(z["segments"]):
            m.params[str(seg)] = {
                "mu": float(z["mu"][i]),
                "sigma": float(z["sigma"][i]),
                "n": int(z["n"][i]),
            }
        meta_path = out / "meta.json"
        m.meta = json.loads(meta_path.read_text()) if meta_path.exists() \
            else {}
        return m
