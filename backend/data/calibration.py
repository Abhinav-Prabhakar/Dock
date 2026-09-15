"""Real-world calibration anchors for the Dock synthetic data generator.

All numbers in this module are anchored to publicly observable market data
(Drewry WCI, SCFI, EU ETS, VLSFO bunker prices, port statistics). See
CALIBRATION.md for the source-by-source documentation and the simplifications
we made. Everything here is a *constant* — all randomness lives in the
generator modules, seeded via numpy.random.Generator.
"""

from __future__ import annotations

import numpy as np

# ---------------------------------------------------------------------------
# Time axis
# ---------------------------------------------------------------------------
# 24 months of history. Anchored so the real-world reference points the spec
# cites (Drewry WCI ~Sep 2026, SCFI ~Aug 2026) fall inside the window.
START_DATE = np.datetime64("2025-01-01")
END_DATE = np.datetime64("2026-12-31")          # inclusive
N_WEEKS = 104                                    # 2025-W01 .. 2026-W52
N_DAYS = int((END_DATE - START_DATE).astype(int)) + 1  # 731

# Voyage schedules start earlier so early-2025 bookings have sailings to
# attach to, and run a bit past END for late-window requests.
SCHEDULE_START = START_DATE - np.timedelta64(75, "D")
SCHEDULE_END = END_DATE + np.timedelta64(75, "D")

# ---------------------------------------------------------------------------
# Ports — real UN/LOCODE-style ids, coordinates (WGS84), physical stats.
# daily_capacity_teu ~ realistic quayside throughput for a mid-size terminal
# cluster (not the whole port); base_congestion is a 0-1 steady-state
# occupancy prior; tz_offset is UTC offset hours.
# ---------------------------------------------------------------------------
# (port_id, name, lat, lon, berths, daily_capacity_teu, base_congestion,
#  tz_offset, mean_dwell_days, base_wait_hours)
PORTS = [
    ("CNSHA", "Shanghai",                 31.2243,  121.4869, 30, 42000, 0.62,  8, 2.2,  6.0),
    ("SGSIN", "Singapore",                 1.2644,  103.8200, 26, 36000, 0.55,  8, 1.6,  5.0),
    ("KRPUS", "Busan",                    35.0951,  129.0398, 20, 21000, 0.48,  9, 1.4,  4.0),
    ("NLRTM", "Rotterdam",                51.9480,    4.1420, 24, 33000, 0.58,  1, 1.9,  8.0),
    ("DEHAM", "Hamburg",                  53.5403,    9.9852, 15, 13500, 0.52,  1, 2.1,  7.0),
    ("BEANR", "Antwerp",                  51.2630,    4.4020, 18, 24000, 0.50,  1, 1.8,  6.0),
    ("USLAX", "Los Angeles/Long Beach",   33.7292, -118.1970, 24, 29000, 0.66, -8, 2.6, 10.0),
    ("USNYC", "New York/New Jersey",      40.6690,  -74.0100, 14, 11500, 0.54, -5, 2.2,  7.0),
]

# Inter-port distances in nautical miles (approximate real sailing distances;
# Asia-Europe via Suez, Asia-US East Coast via Panama).
DISTANCES_NM = {
    ("CNSHA", "SGSIN"): 2170,
    ("SGSIN", "CNSHA"): 2170,
    ("SGSIN", "NLRTM"): 8290,
    ("NLRTM", "SGSIN"): 8290,
    ("NLRTM", "DEHAM"): 420,
    ("DEHAM", "NLRTM"): 420,
    ("NLRTM", "BEANR"): 95,
    ("BEANR", "NLRTM"): 95,
    ("BEANR", "SGSIN"): 8260,
    ("SGSIN", "BEANR"): 8260,
    ("CNSHA", "KRPUS"): 490,
    ("KRPUS", "CNSHA"): 490,
    ("KRPUS", "USLAX"): 5300,
    ("USLAX", "KRPUS"): 5300,
    ("USLAX", "CNSHA"): 5700,
    ("CNSHA", "USLAX"): 5700,
    ("CNSHA", "USNYC"): 10600,
    ("USNYC", "CNSHA"): 10600,
}

# ---------------------------------------------------------------------------
# Fleet — 4 vessels. Fuel model: fuel_tonnes_per_day = fuel_a + fuel_b * v^3
# (v = speed in knots). fuel_b is calibrated so that fuel(service_speed)
# equals the reference burn for that size class; fuel_a adds a speed-
# independent hotel/auxiliary load which softens the pure cube so that
# slow-steaming 18->14 kt saves ~35-50% (matching industry figures).
# ---------------------------------------------------------------------------
# (vessel_id, name, capacity_teu, reefer_plugs, min_kt, service_kt, max_kt,
#  age_years, draft_m, ref_burn_tpd_at_service)
VESSELS = [
    ("VES1", "Pacific Aurora",   8000, 560, 12.0, 16.0, 18.0,  4, 14.5, 118.0),
    ("VES2", "Meridian Star",    5500, 380, 12.0, 16.0, 18.0,  8, 13.0,  90.0),
    ("VES3", "Atlantic Pioneer", 4000, 280, 12.0, 16.0, 18.0, 12, 12.0,  74.0),
    ("VES4", "Coral Empress",    2500, 200, 12.0, 14.0, 18.0, 17, 10.5,  50.0),
]

# Fixed port rotations (closed loops). Distances must exist in DISTANCES_NM
# for every consecutive pair including last->first.
VESSEL_LOOPS = {
    "VES1": ["CNSHA", "SGSIN", "NLRTM", "DEHAM", "NLRTM", "SGSIN"],
    "VES2": ["CNSHA", "KRPUS", "USLAX", "KRPUS"],
    "VES3": ["CNSHA", "USNYC"],
    "VES4": ["SGSIN", "NLRTM", "BEANR"],
}

# Fraction of a vessel's leg capacity that is bookable as "own lift" on the
# spot market. The remainder models contract cargo / alliance commitments.
OWN_LIFT_SHARE = 0.45
# Fraction of capacity kept as a stowage/safety buffer (never sold).
STOWAGE_BUFFER = 0.12

# ---------------------------------------------------------------------------
# Routes (origin -> destination OD pairs).
# base_teu_wk = baseline demanded TEU/week (spec: 200-1200 headhaul; backhaul
# is scaled down by the trade imbalance, which here is ~75/25 - inside the
# 60/40-80/20 spec band). market_usd_per_teu is the baseline mean spot rate
# expressed per TEU (Drewry WCI $4,476/FEU ~ $2,600/TEU equivalent; the
# $1,500-4,500/FEU Shanghai-Rotterdam range maps to ~$880-2,650/TEU, so a
# $1,700-1,800/TEU mean with stochastic spread reproduces the observed band).
# lane: 'asia_europe', 'asia_na', 'regional'. direction: 'head' or 'back'.
# ---------------------------------------------------------------------------
# (origin, dest, base_teu_wk, market_usd_per_teu, lane, direction)
ROUTES = [
    ("CNSHA", "NLRTM", 1100, 1780.0, "asia_europe", "head"),
    ("CNSHA", "DEHAM",  550, 1820.0, "asia_europe", "head"),
    ("CNSHA", "BEANR",  300, 1720.0, "asia_europe", "head"),
    ("SGSIN", "NLRTM",  480, 1620.0, "asia_europe", "head"),
    ("SGSIN", "BEANR",  180, 1580.0, "asia_europe", "head"),
    ("CNSHA", "USLAX", 1050, 1720.0, "asia_na",     "head"),
    ("KRPUS", "USLAX",  420, 1550.0, "asia_na",     "head"),
    ("CNSHA", "USNYC",  600, 2150.0, "asia_na",     "head"),
    ("NLRTM", "CNSHA",  340,  790.0, "asia_europe", "back"),
    ("NLRTM", "SGSIN",  200,  730.0, "asia_europe", "back"),
    ("DEHAM", "CNSHA",  170,  810.0, "asia_europe", "back"),
    ("BEANR", "SGSIN",  120,  700.0, "asia_europe", "back"),
    ("USLAX", "CNSHA",  300,  760.0, "asia_na",     "back"),
    ("USLAX", "KRPUS",  140,  720.0, "asia_na",     "back"),
    ("USNYC", "CNSHA",  190,  930.0, "asia_na",     "back"),
    ("CNSHA", "SGSIN",  260,  690.0, "regional",    "head"),
    ("SGSIN", "CNSHA",  160,  470.0, "regional",    "back"),
    ("NLRTM", "BEANR",   90,  340.0, "regional",    "head"),
]

# Alternate-hub mapping used by counter-offer generation (Rotterdam/Hamburg
# cargo can be diverted to Antwerp; NY/NJ can divert via LA+LBR rail is out of
# scope, so NY/NJ has no alternate -> falls back to split/flex offers).
ALT_HUB = {"NLRTM": "BEANR", "DEHAM": "BEANR"}

# Partner / slot-charter capacity: our own 4 vessels cannot provide weekly
# departures on every OD (realistic - carriers fill gaps with alliance slots).
# Partner slots per route-week ~= base_teu_wk * U(partner_low, partner_high).
PARTNER_SLOT_LOW = 1.00
PARTNER_SLOT_HIGH = 1.45

# ---------------------------------------------------------------------------
# Demand parameters (Section 5 of plan.md — follow exactly)
# ---------------------------------------------------------------------------
SEASONAL_PERIOD_WEEKS = 12.0
SEASONAL_AMPLITUDE = 0.30          # +/-30%
TREND_PER_QUARTER = 0.05           # +/-5% linear drift per quarter
WEEKS_PER_QUARTER = 13.0
SHOCK_MAGNITUDE_RANGE = (2.0, 5.0)  # spikes multiply, drops divide

CARGO_MIX = {"dry": 0.70, "reefer": 0.20, "hazmat": 0.10}

SEGMENT_MIX = {"flexible": 0.40, "standard": 0.30, "urgent": 0.30}

# Per-segment behaviour. elasticity is the price elasticity coefficient
# (0.5-2.0 band, correct sign applied downstream): higher relative price ->
# lower volume. wtp_mult is the mean willingness-to-pay relative to the
# market rate. quote_uplift is the carrier's product premium per segment
# (express/guaranteed-load products quote above the base spot rate), which
# preserves the urgent > standard > flexible realized-price ordering.
# lead_mean is mean days between request and requested departure.
# flex_days = max +/- departure window the segment accepts.
SEGMENTS = {
    "flexible": {"elasticity": 1.8, "wtp_mult": 1.00, "wtp_sd": 0.09,
                 "quote_uplift": 1.00, "lead_mean": 22.0, "flex_days": 7,
                 "counter_prob": 0.55},
    "standard": {"elasticity": 1.1, "wtp_mult": 1.08, "wtp_sd": 0.07,
                 "quote_uplift": 1.03, "lead_mean": 12.0, "flex_days": 2,
                 "counter_prob": 0.35},
    "urgent":   {"elasticity": 0.55, "wtp_mult": 1.38, "wtp_sd": 0.12,
                 "quote_uplift": 1.12, "lead_mean": 5.0, "flex_days": 0,
                 "counter_prob": 0.15},
}

# Booking size (TEU) mixture: (max_teu_exclusive_upper, weight) buckets.
# Most requests are 1-10 TEU; occasional large consignments up to ~250 TEU.
TEU_BUCKETS = [(1, 3, 0.34), (3, 6, 0.24), (6, 15, 0.20),
               (15, 40, 0.14), (40, 120, 0.06), (120, 250, 0.02)]
MEAN_TEU_PER_BOOKING = 9.0   # used to convert TEU demand -> booking counts

# Container gross weight: tonnes per TEU (mixed cargo ~10-14t, clip legal max)
TONNES_PER_TEU_MEAN = 11.0
TONNES_PER_TEU_SD = 3.5
TONNES_PER_TEU_MAX = 28.0

# ---------------------------------------------------------------------------
# Economics
# ---------------------------------------------------------------------------
VLSFO_USD_PER_TONNE_BASE = 600.0     # anchored to $500-700/t observed range
VLSFO_WEEKLY_VOL = 0.035             # stochastic walk volatility
VLSFO_CLIP = (380.0, 950.0)

ETS_EUR_PER_TCO2_BASE = 80.0         # EU ETS EUR65-95/tCO2 band
ETS_WEEKLY_VOL = 0.02
ETS_CLIP = (60.0, 105.0)

CO2_PER_TONNE_FUEL = 3.15            # tCO2 per tonne VLSFO (industry ~3.114-3.206)

DEMURRAGE_USD_PER_DAY = 50000.0      # delay cost scale from plan.md

# Weekly spot-rate process: mean-reverting log walk.
RATE_WEEKLY_VOL = 0.055
RATE_MEAN_REVERSION = 0.10
# Fuel cost pass-through into freight rates.
RATE_FUEL_PASSTHROUGH = 0.30

# Dynamic pricing: quotes lift above market as a route-week fills up.
QUOTE_SURGE_COEF = 0.45              # max ~+45% when week is fully sold out
QUOTE_NOISE_SD = 0.05

# ---------------------------------------------------------------------------
# Disruptions
# ---------------------------------------------------------------------------
DISRUPTION_TYPES = ["none", "storm", "canal_closure", "strike", "congestion"]

# Baseline weekly probabilities by disruption type (before scenario scaling).
DISRUPTION_BASE_PROB = {
    "storm": 0.06,
    "canal_closure": 0.004,
    "strike": 0.008,
    "congestion": 0.05,
}
