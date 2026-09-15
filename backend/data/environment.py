"""Physical-world generators: port congestion, route weather/disruption,
vessel telemetry, maintenance events.

Congestion and weather are generated per scenario (scenario schedules drive
strikes/closures). Vessel telemetry and maintenance describe the single
physical fleet and are generated once (the vessels are shared infrastructure;
scenario-specific commercial outcomes live in the demand datasets).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import calibration as C
from .demand import ROUTE_KEYS, ROUTE_LANE

PORT_IDS = [p[0] for p in C.PORTS]
PORT_BASE_CONG = {p[0]: p[6] for p in C.PORTS}
PORT_BERTHS = {p[0]: p[4] for p in C.PORTS}
PORT_DAILY_CAP = {p[0]: p[5] for p in C.PORTS}
PORT_BASE_WAIT = {p[0]: p[9] for p in C.PORTS}

DAYS = pd.date_range(pd.Timestamp(C.START_DATE),
                     periods=C.N_DAYS, freq="D")
WEEKS = pd.date_range(pd.Timestamp(C.START_DATE),
                      periods=C.N_WEEKS, freq="7D")


def _ar1(rng, n, phi, sigma):
    x = np.empty(n)
    x[0] = rng.normal(0, sigma)
    eps = rng.normal(0, sigma, n)
    for t in range(1, n):
        x[t] = phi * x[t - 1] + eps[t]
    return x


# ---------------------------------------------------------------------------
# Port congestion daily
# ---------------------------------------------------------------------------

def port_congestion_daily(rng: np.random.Generator, scenario_id: str,
                          cfg: dict) -> pd.DataFrame:
    """Port x day congestion panel for one scenario.

    wait_hours model: base_wait * (occupancy/0.6)^2.5 * event multiplier,
    clipped to [0.5, 200] — reproduces "hours normally, multi-day during
    LA/LB-2021-style events".
    """
    records = []
    day_of_year = np.arange(C.N_DAYS)
    for port in PORT_IDS:
        occ = (PORT_BASE_CONG[port]
               + _ar1(rng, C.N_DAYS, 0.92, 0.05)
               + 0.06 * np.sin(2 * np.pi * day_of_year / 365.0))
        occ = np.clip(occ, 0.05, 0.995)

        # event masks
        closure = np.zeros(C.N_DAYS, dtype=bool)
        strike = np.zeros(C.N_DAYS, dtype=bool)
        for (p, w0, w1) in cfg["port_closures"]:
            if p == port:
                closure[w0 * 7:min(C.N_DAYS, w1 * 7)] = True
        for (p, w0, w1) in cfg["port_strikes"]:
            if p == port:
                strike[w0 * 7:min(C.N_DAYS, w1 * 7)] = True

        # random congestion events: weekly bernoulli expanded to daily
        wk_evt = rng.random(C.N_WEEKS) < (
            C.DISRUPTION_BASE_PROB["congestion"] * cfg["disruption_mult"])
        wk_of_day = np.minimum(day_of_year // 7, C.N_WEEKS - 1)
        rand_evt = wk_evt[wk_of_day]

        event_mult = np.ones(C.N_DAYS)
        event_mult[rand_evt] = rng.uniform(2.0, 4.0, rand_evt.sum())
        event_mult[strike] = rng.uniform(3.0, 5.0, strike.sum())
        event_mult[closure] = rng.uniform(5.0, 9.0, closure.sum())

        occ_eff = np.clip(occ + 0.25 * strike + 0.4 * closure
                          + 0.15 * rand_evt, 0, 0.999)
        berth_occ = np.round(occ_eff * 100, 1)

        arrivals = rng.poisson(
            np.clip(PORT_BERTHS[port] * occ_eff / 1.6, 0.5, None)
            * np.where(closure, 0.15, np.where(strike, 0.4, 1.0)))

        wait = (PORT_BASE_WAIT[port] * (occ_eff / 0.6) ** 2.5
                * event_mult * cfg["congestion_mult"]
                * np.exp(rng.normal(0, 0.2, C.N_DAYS)))
        wait = np.clip(wait, 0.5, 200.0)

        queue = np.clip(np.round(
            (occ_eff - 0.55) * PORT_BERTHS[port] * 2.2
            * np.where(closure, 2.5, np.where(strike, 1.8, 1.0))
            + rng.normal(0, 1.5, C.N_DAYS)), 0, None).astype(int)

        weather = np.clip(0.25 + 0.2 * np.sin(2 * np.pi
                          * (day_of_year - 40) / 365.0)
                          + _ar1(rng, C.N_DAYS, 0.9, 0.12), 0, 1)

        disruption = np.full(C.N_DAYS, "none", dtype=object)
        disruption[rand_evt] = "congestion"
        disruption[strike] = "strike"
        disruption[closure] = "port_closure"

        records.append(pd.DataFrame({
            "scenario_id": scenario_id,
            "port_id": port,
            "date": DAYS,
            "vessel_arrivals": arrivals,
            "berth_occupancy_pct": berth_occ,
            "avg_wait_hours": np.round(wait, 1),
            "queue_length": queue,
            "weather_severity": np.round(weather, 3),
            "disruption_event": disruption,
        }))
    return pd.concat(records, ignore_index=True)


# ---------------------------------------------------------------------------
# Route weather / disruption weekly
# ---------------------------------------------------------------------------

def _circ_gauss(doy: np.ndarray, center: float, width: float) -> np.ndarray:
    """Gaussian bump on a circular day-of-year axis."""
    d = np.minimum((doy - center) % 365.0, (center - doy) % 365.0)
    return np.exp(-(d ** 2) / (2 * width ** 2))


def _storm_prob(route_lane: str, wk: np.ndarray, rng, mult: float) -> np.ndarray:
    """Seasonal storm probability by ocean region."""
    doy = (wk % 52).astype(float) * 7.0
    if route_lane == "asia_europe":
        # N. Atlantic winter storms (Dec-Feb) + Indian Ocean monsoon (Jun-Sep)
        p = (0.08 + 0.28 * _circ_gauss(doy, 15.0, 45.0)
             + 0.12 * ((doy > 155) & (doy < 270)))
    elif route_lane == "asia_na":
        # N. Pacific winter storms + W. Pacific typhoon season (Jul-Oct)
        p = (0.07 + 0.30 * _circ_gauss(doy, 20.0, 50.0)
             + 0.14 * ((doy > 185) & (doy < 300)))
    else:
        p = 0.05 + 0.10 * _circ_gauss(doy, 20.0, 50.0)
    return np.clip(p * mult + rng.normal(0, 0.02, len(wk)), 0.01, 0.9)


def weather_route_weekly(rng: np.random.Generator, scenario_id: str,
                         cfg: dict) -> pd.DataFrame:
    """Route x week weather and disruption panel."""
    wk = np.arange(C.N_WEEKS)
    records = []
    for r, (o, d) in enumerate(ROUTE_KEYS):
        lane = ROUTE_LANE[r]
        storm_p = _storm_prob(lane, wk, rng, cfg["disruption_mult"])
        wave_mean = np.round(1.1 + 3.4 * storm_p
                             + rng.normal(0, 0.25, C.N_WEEKS), 2)
        wave_mean = np.clip(wave_mean, 0.3, None)
        wave_max = np.round(wave_mean * rng.uniform(1.8, 2.6, C.N_WEEKS), 2)
        wind = np.round(np.clip(10 + 28 * storm_p
                                + rng.normal(0, 4, C.N_WEEKS), 4, None), 1)

        dtype = np.full(C.N_WEEKS, "none", dtype=object)
        # stochastic storm flag
        storm_evt = rng.random(C.N_WEEKS) < storm_p * 0.55
        dtype[storm_evt] = "storm"
        # random strikes at origin/dest affect the route
        strike_p = C.DISRUPTION_BASE_PROB["strike"] * cfg["disruption_mult"]
        strike_evt = rng.random(C.N_WEEKS) < strike_p
        dtype[strike_evt & (dtype == "none")] = "strike"
        cong_p = C.DISRUPTION_BASE_PROB["congestion"] * cfg["disruption_mult"]
        cong_evt = rng.random(C.N_WEEKS) < cong_p
        dtype[cong_evt & (dtype == "none")] = "congestion"

        # scenario-scheduled events
        for (p, w0, w1) in cfg["port_strikes"]:
            if p in (o, d):
                dtype[w0:min(C.N_WEEKS, w1)] = "strike"
        for (p, w0, w1) in cfg["port_closures"]:
            if p in (o, d):
                dtype[w0:min(C.N_WEEKS, w1)] = "congestion"
        for (w0, w1) in cfg["canal_closures"]:
            if lane == "asia_europe":
                dtype[w0:min(C.N_WEEKS, w1)] = "canal_closure"

        delay_prob = np.clip(0.04 + 0.55 * storm_p
                             + 0.45 * (dtype != "none"), 0, 0.98)
        delay = np.zeros(C.N_WEEKS)
        storm_rows = dtype == "storm"
        delay[storm_rows] = rng.gamma(2.0, 1.4, storm_rows.sum())
        delay[dtype == "strike"] = rng.uniform(2, 9, (dtype == "strike").sum())
        delay[dtype == "congestion"] = rng.uniform(1.5, 8,
                                                 (dtype == "congestion").sum())
        delay[dtype == "canal_closure"] = rng.uniform(
            7, 14, (dtype == "canal_closure").sum())  # Cape reroute ~+10d
        delay *= (rng.random(C.N_WEEKS) < delay_prob)
        delay = np.round(delay, 1)

        records.append(pd.DataFrame({
            "scenario_id": scenario_id,
            "week_index": wk,
            "origin_port": o,
            "destination_port": d,
            "storm_probability": np.round(storm_p, 3),
            "wave_height_mean_m": wave_mean,
            "wave_height_max_m": wave_max,
            "wind_speed_kt": wind,
            "delay_probability": np.round(delay_prob, 3),
            "disruption_type": dtype,
            "realized_delay_days": delay,
        }))
    return pd.concat(records, ignore_index=True)


# ---------------------------------------------------------------------------
# Vessel telemetry daily (single physical fleet, not per scenario)
# ---------------------------------------------------------------------------

def _sea_mask(voyages: pd.DataFrame, vessel_id: str) -> np.ndarray:
    """Boolean [N_DAYS]: True when the vessel is at sea."""
    mask = np.zeros(C.N_DAYS, dtype=bool)
    v = voyages[voyages["vessel_id"] == vessel_id]
    for leg in v.itertuples():
        i0 = max(0, int((leg.etd - DAYS[0]).days))
        i1 = min(C.N_DAYS, int((leg.eta - DAYS[0]).days) + 1)
        if i1 > i0:
            mask[i0:i1] = True
    return mask


def vessel_telemetry_daily(rng: np.random.Generator, vessels: pd.DataFrame,
                           voyages: pd.DataFrame,
                           maintenance: pd.DataFrame) -> pd.DataFrame:
    records = []
    for v in vessels.itertuples():
        sea = _sea_mask(voyages, v.vessel_id)
        # drydock days from maintenance table force in-port
        mnt = maintenance[maintenance["vessel_id"] == v.vessel_id]
        for e in mnt.itertuples():
            i0 = max(0, (e.date - DAYS[0]).days)
            i1 = min(C.N_DAYS, i0 + int(np.ceil(e.downtime_days)))
            sea[i0:i1] = False

        # ~18% of sea days are slow-steamed at ~14kt (fuel/carbon trade-off)
        slow = sea & (rng.random(C.N_DAYS) < 0.18)
        speed = np.where(sea,
                         v.service_speed_kt + rng.normal(0, 0.5, C.N_DAYS), 0.0)
        speed = np.where(slow, 14.0 + rng.normal(0, 0.4, C.N_DAYS), speed)
        speed = np.round(np.clip(speed, 0, v.max_speed_kt), 2)

        engine_hours = np.where(sea, 24.0,
                                rng.uniform(2.0, 6.0, C.N_DAYS))
        fuel = np.where(
            sea,
            (v.fuel_a_tpd + v.fuel_b_tpd * speed ** 3)
            * np.exp(rng.normal(0, 0.04, C.N_DAYS)),
            rng.uniform(3.0, 6.5, C.N_DAYS))
        fuel = np.round(np.clip(fuel, 0, None), 2)
        co2 = np.round(fuel * C.CO2_PER_TONNE_FUEL, 2)

        vibration = np.round(np.clip(
            0.6 + 0.045 * speed + rng.normal(0, 0.12, C.N_DAYS)
            + (v.age_years / 20) * 0.4, 0.2, None), 3)
        exhaust_temp = np.where(
            sea, 330 + 5.5 * (speed - 12) + rng.normal(0, 8, C.N_DAYS),
            rng.normal(180, 15, C.N_DAYS))

        records.append(pd.DataFrame({
            "vessel_id": v.vessel_id,
            "date": DAYS,
            "engine_hours": np.round(engine_hours, 1),
            "mean_speed_kt": speed,
            "fuel_consumed_tonnes": fuel,
            "co2_tonnes": co2,
            "vibration_rms": vibration,
            "exhaust_temp_c": np.round(exhaust_temp, 1),
            "at_sea": sea,
        }))
    return pd.concat(records, ignore_index=True)


# ---------------------------------------------------------------------------
# Vessel maintenance events
# ---------------------------------------------------------------------------

COMPONENTS = ["main_engine", "aux_engine", "turbocharger", "fuel_pump",
              "cooling_system", "electrical", "propeller_shaft", "boiler",
              "steering_gear", "hatch_cover"]


def vessel_maintenance_events(rng: np.random.Generator,
                              vessels: pd.DataFrame) -> pd.DataFrame:
    """Event log with a classifier label.

    failure_within_30d = 1 iff another *unscheduled* event occurs for the
    same vessel within 30 days after this event's date (i.e. this row marks
    the onset of a degradation cascade). Scheduled drydocks/surveys are
    interleaved; unscheduled rate scales with vessel age.
    """
    rows = []
    for v in vessels.itertuples():
        evts = []  # (day_offset, type, component, downtime, cost)
        # scheduled: one drydock per vessel inside the 2-yr window (~30-mo
        # cycle -> most vessels drydock once) + annual surveys
        dd_day = int(rng.integers(120, C.N_DAYS - 40))
        evts.append((dd_day, "scheduled", "drydock",
                     round(float(rng.uniform(12, 21)), 1),
                     round(float(rng.lognormal(np.log(9e5), 0.4)), 0)))
        for yr in (0, 1):
            sv_day = int(np.clip(yr * 365 + rng.integers(60, 300),
                                 0, C.N_DAYS - 1))
            evts.append((sv_day, "scheduled", "annual_survey",
                         round(float(rng.uniform(1.5, 4)), 1),
                         round(float(rng.lognormal(np.log(6e4), 0.4)), 0)))
        # unscheduled: Poisson count, rate grows with age (~3/yr new vessel,
        # ~5.5/yr for the oldest — minor machinery incidents, not casualties)
        lam = 3.0 * (1.0 + (v.age_years - 3) / 17.0) * (C.N_DAYS / 365.0)
        for _ in range(rng.poisson(lam)):
            day = int(rng.integers(0, C.N_DAYS - 1))
            comp = COMPONENTS[rng.integers(0, len(COMPONENTS))]
            evts.append((day, "unscheduled", comp,
                         round(float(np.clip(rng.gamma(2.0, 1.8), 0.5, 14)), 1),
                         round(float(rng.lognormal(np.log(1.4e5), 0.7)), 0)))
        evts.sort(key=lambda e: e[0])
        unsched_days = np.array([e[0] for e in evts
                                 if e[1] == "unscheduled"])
        for (day, etype, comp, down, cost) in evts:
            fut = unsched_days[(unsched_days > day) & (unsched_days <= day + 30)]
            rows.append({
                "vessel_id": v.vessel_id,
                "date": DAYS[0] + pd.Timedelta(days=int(day)),
                "event_type": etype,
                "component": comp,
                "downtime_days": down,
                "cost_usd": cost,
                # label: an unscheduled failure follows within 30 days
                "failure_within_30d": bool(len(fut) > 0),
            })
    df = pd.DataFrame(rows)
    df["failure_within_30d"] = df["failure_within_30d"].astype(bool)
    return df.sort_values(["vessel_id", "date"]).reset_index(drop=True)
