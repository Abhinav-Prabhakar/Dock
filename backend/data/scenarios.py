"""Scenario configurations for the Dock data generator.

Each scenario is a demand/economic regime that modulates the base generation
process. At least 5 named demand-distribution configs plus adversarial
worst-cases are required by the spec; we ship 10 total (7 named + 1 growth
variant + 2 adversarial). 20% (2 of 10) are marked as a holdout split that is
never used for model training — the split is chosen deterministically from
the master seed.
"""

from __future__ import annotations

import copy
from typing import Any

import numpy as np

# Week indices are 0..103 covering 2025-01-01 .. 2026-12-31 (week of
# 2025-01-01 is week 0). Fixed event schedules below reference these indices.
#
# Reference points:
#   week 0    = 2025-01-01
#   week 87   = week containing 2026-09-01 (Drewry WCI ~$4,476 anchor)
#   week 60   ~ early March 2026
#   week 40   ~ early October 2025

_BASE: dict[str, Any] = {
    "description": "Nominal market: spec-default demand, seasonality, shocks.",
    "base_demand_mult": 1.0,          # multiplies every route's base TEU/wk
    "seasonal_amplitude": 0.30,       # sinusoid amplitude (spec: +/-30%)
    "seasonal_phase_wk": 0.0,         # week index of the seasonal peak
    "trend_per_quarter": 0.0,         # linear drift, fraction per quarter
    "shock_rate_per_year": 1.5,       # Poisson rate of demand shock events
    "shock_mag_range": (2.0, 5.0),    # spike multiply / drop divide
    "shock_duration_wk": (1, 3),      # weeks a shock stays active
    "backhaul_mult": 1.0,             # scales 'back' direction demand only
    "headhaul_mult": 1.0,             # scales 'head' direction demand only
    "price_mult": 1.0,                # scales market rate level
    "rate_vol_mult": 1.0,             # scales weekly rate volatility
    "fuel_mult": 1.0,                 # scales VLSFO level
    "fuel_spike_wk": None,            # (start_wk, end_wk, multiplier)
    "congestion_mult": 1.0,           # scales wait-time severity
    "disruption_mult": 1.0,           # scales per-week disruption probs
    "port_closures": [],              # [(port, start_wk, end_wk)]
    "port_strikes": [],               # [(port, start_wk, end_wk)]
    "canal_closures": [],             # [(start_wk, end_wk)] Suez->Asia-Europe
    "demand_spike_events": [],        # [(start_wk, end_wk, mult, lanes|None)]
    "segment_mix_shift": 0.0,         # +x shifts mass flexible->urgent
}

SCENARIOS: dict[str, dict[str, Any]] = {
    "baseline": {**_BASE},

    "high-imbalance": {
        **_BASE,
        "description": "Extreme 80/20 trade imbalance; backhaul starved.",
        "backhaul_mult": 0.62,
        "headhaul_mult": 1.06,
    },

    "volatile-shocks": {
        **_BASE,
        "description": "Frequent large demand shocks (strikes, surges, "
                       "canal scares); high spot-rate volatility.",
        "shock_rate_per_year": 6.0,
        "shock_mag_range": (2.0, 5.0),
        "shock_duration_wk": (1, 4),
        "rate_vol_mult": 1.8,
        "disruption_mult": 1.6,
    },

    "seasonal-peak": {
        **_BASE,
        "description": "Strong pre-holiday peak season: amplitude at the "
                       "spec maximum with the peak centred on early Q4, plus "
                       "a peak-quarter demand boost.",
        "seasonal_amplitude": 0.30,
        "seasonal_phase_wk": 40.0,
        "demand_spike_events": [(38, 47, 1.35, None), (90, 99, 1.30, None)],
        "price_mult": 1.10,
    },

    "depressed-demand": {
        **_BASE,
        "description": "Recessionary market: structurally low volumes, "
                       "negative drift, weak rates.",
        "base_demand_mult": 0.66,
        "trend_per_quarter": -0.05,
        "price_mult": 0.72,
        "shock_rate_per_year": 1.0,
    },

    "steady-growth": {
        **_BASE,
        "description": "Calm growing market: +5%/quarter drift, few shocks.",
        "trend_per_quarter": 0.05,
        "shock_rate_per_year": 0.5,
        "rate_vol_mult": 0.6,
        "disruption_mult": 0.6,
    },

    "boom-market": {
        **_BASE,
        "description": "Capacity-crunch boom: high demand, high rates, "
                       "congestion pressure everywhere.",
        "base_demand_mult": 1.32,
        "trend_per_quarter": 0.03,
        "price_mult": 1.45,
        "congestion_mult": 1.5,
        "shock_rate_per_year": 2.0,
    },

    "port-strike-season": {
        **_BASE,
        "description": "Labour unrest: scheduled multi-week strikes at LA/LB "
                       "and Rotterdam with knock-on congestion.",
        "port_strikes": [("USLAX", 30, 34), ("NLRTM", 44, 46),
                         ("USLAX", 82, 84)],
        "disruption_mult": 1.5,
        "congestion_mult": 1.3,
    },

    "adversarial-canal-closure": {
        **_BASE,
        "description": "ADVERSARIAL: Suez-style canal closure weeks 40-46. "
                       "Asia-Europe voyages reroute (longer transit, delay, "
                       "fuel burn) while transpacific demand spikes.",
        "canal_closures": [(40, 46)],
        "demand_spike_events": [(40, 48, 2.6, ["asia_na"]),
                               (41, 45, 1.8, ["asia_europe"])],
        "fuel_spike_wk": (40, 50, 1.35),
        "price_mult": 1.25,
        "disruption_mult": 1.8,
    },

    "adversarial-perfect-storm": {
        **_BASE,
        "description": "ADVERSARIAL: simultaneous LA/LB port closure "
                       "(weeks 60-63) + transpacific demand spike + fuel "
                       "spike + storm cluster. Worst-case robustness test.",
        "port_closures": [("USLAX", 60, 63)],
        "demand_spike_events": [(58, 66, 3.0, ["asia_na"])],
        "fuel_spike_wk": (58, 68, 1.60),
        "price_mult": 1.35,
        "disruption_mult": 2.2,
        "congestion_mult": 1.8,
    },
}

HOLDOUT_FRACTION = 0.20


def build_scenarios(seed: int) -> tuple[dict[str, dict], list[str], list[str]]:
    """Return (configs, train_ids, holdout_ids).

    The holdout split is drawn from a dedicated RNG derived from the master
    seed, so it is deterministic and independent of generation order.
    """
    configs = {name: copy.deepcopy(cfg) for name, cfg in SCENARIOS.items()}
    names = sorted(configs)
    rng = np.random.default_rng(np.random.SeedSequence(seed).spawn(1)[0])
    n_holdout = max(1, round(len(names) * HOLDOUT_FRACTION))
    holdout = sorted(rng.choice(names, size=n_holdout, replace=False).tolist())
    train = [n for n in names if n not in holdout]
    return configs, train, holdout


def scenario_json(name: str, cfg: dict, split: str) -> dict:
    """JSON-serializable scenario record written to scenarios/<name>.json."""
    out = {"scenario_id": name, "split": split}
    out.update(cfg)
    return out
