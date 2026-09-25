"""Demand-side generators: market state, bookings, weekly aggregation,
price-volume panel.

Model summary (all stochastic draws come from numpy.random.Generator; no
global random state):

* Market state per scenario: VLSFO and EU ETS weekly random walks; per-route
  spot rate follows a mean-reverting log walk around
  base_rate * price_mult * (1 + passthrough * fuel_deviation).
* Demand intensity lam[route, week] = base_teu * scenario multipliers
  * seasonal sinusoid (12-wk period, configurable amplitude/phase)
  * linear trend (fraction per quarter)
  * shock multipliers (random Poisson events + scenario-scheduled events).
* Bookings ~ Poisson(lam / mean_teu_per_booking) per route-week. Within a
  route-week, requests stream in by request_timestamp; the carrier's quote
  rises with the fill fraction (dynamic pricing), the customer accepts iff
  quote <= willingness_to_pay, and a running capacity check (partner slots +
  own lift departing that week + reefer-plug sub-capacity) rejects overflow.
  Non-accepts draw counter-offers with segment-dependent probability.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import calibration as C
from .entities import departure_calendar

ROUTE_KEYS = [(o, d) for (o, d, *_rest) in C.ROUTES]
ROUTE_BASE = np.array([r[2] for r in C.ROUTES], dtype=float)
ROUTE_RATE = np.array([r[3] for r in C.ROUTES], dtype=float)
ROUTE_LANE = [r[4] for r in C.ROUTES]
ROUTE_DIR = np.array([r[5] == "back" for r in C.ROUTES])
ROUTE_ID_OF = {f"{o}>{d}": i for i, (o, d) in enumerate(ROUTE_KEYS)}

SEG_NAMES = list(C.SEGMENTS)
SEG_PROB = np.array([C.SEGMENT_MIX[s] for s in SEG_NAMES])
SEG_ELAST = np.array([C.SEGMENTS[s]["elasticity"] for s in SEG_NAMES])
SEG_WTP_M = np.array([C.SEGMENTS[s]["wtp_mult"] for s in SEG_NAMES])
SEG_WTP_S = np.array([C.SEGMENTS[s]["wtp_sd"] for s in SEG_NAMES])
SEG_LEAD = np.array([C.SEGMENTS[s]["lead_mean"] for s in SEG_NAMES])
SEG_FLEX = np.array([C.SEGMENTS[s]["flex_days"] for s in SEG_NAMES])
SEG_CPROB = np.array([C.SEGMENTS[s]["counter_prob"] for s in SEG_NAMES])
SEG_UPLIFT = np.array([C.SEGMENTS[s]["quote_uplift"] for s in SEG_NAMES])

CARGO_NAMES = list(C.CARGO_MIX)
CARGO_PROB = np.array([C.CARGO_MIX[s] for s in CARGO_NAMES])


def _grouped_cumsum(values_sorted: np.ndarray, group_sorted: np.ndarray) -> np.ndarray:
    """Cumulative sum of `values_sorted` within each contiguous group."""
    cum = np.cumsum(values_sorted)
    grp_start = np.r_[0, np.flatnonzero(np.diff(group_sorted)) + 1]
    gid = np.searchsorted(grp_start, np.arange(len(values_sorted)),
                          side="right") - 1
    offset = np.zeros(len(values_sorted))
    pos = gid > 0
    offset[pos] = cum[grp_start[gid[pos]] - 1]
    return cum - offset


# ---------------------------------------------------------------------------
# Market state
# ---------------------------------------------------------------------------

def _random_walk(rng, n, start, vol, clip):
    """Multiplicative weekly walk with a mild pull back toward `start`."""
    x = np.empty(n)
    x[0] = start * np.exp(rng.normal(0, vol))
    eps = rng.normal(0.0, vol, size=n)
    for t in range(1, n):
        x[t] = x[t - 1] * np.exp(0.02 * np.log(start / x[t - 1]) + eps[t])
    return np.clip(x, *clip)


def market_state(rng: np.random.Generator, cfg: dict) -> dict:
    """Fuel, ETS and per-route spot-rate series for one scenario."""
    w = C.N_WEEKS
    fuel = _random_walk(rng, w, C.VLSFO_USD_PER_TONNE_BASE * cfg["fuel_mult"],
                        C.VLSFO_WEEKLY_VOL, C.VLSFO_CLIP)
    if cfg["fuel_spike_wk"] is not None:
        s, e, mult = cfg["fuel_spike_wk"]
        s, e = max(0, s), min(w, e)
        prof = np.ones(w)
        prof[s:e] = mult
        ramp_n = max(1, (e - s) // 3)
        prof[s:s + ramp_n] = np.exp(np.linspace(0, np.log(mult), ramp_n))
        fuel = np.clip(fuel * prof, *C.VLSFO_CLIP)
    ets = _random_walk(rng, w, C.ETS_EUR_PER_TCO2_BASE, C.ETS_WEEKLY_VOL,
                       C.ETS_CLIP)

    fuel_dev = fuel / C.VLSFO_USD_PER_TONNE_BASE - 1.0
    rates = np.empty((len(ROUTE_KEYS), w))
    for r in range(len(ROUTE_KEYS)):
        mu = np.log(ROUTE_RATE[r] * cfg["price_mult"]
                    * (1.0 + C.RATE_FUEL_PASSTHROUGH * fuel_dev))
        x = np.empty(w)
        x[0] = mu[0] + rng.normal(0, 0.1)
        eps = rng.normal(0, C.RATE_WEEKLY_VOL * cfg["rate_vol_mult"], w)
        for t in range(1, w):
            x[t] = x[t - 1] + C.RATE_MEAN_REVERSION * (mu[t] - x[t - 1]) + eps[t]
        rates[r] = np.exp(x)
    return {"fuel_usd_t": fuel, "ets_eur_t": ets, "rates": rates}


# ---------------------------------------------------------------------------
# Demand intensity
# ---------------------------------------------------------------------------

def demand_intensity(rng: np.random.Generator, cfg: dict):
    """Return (lam_teu[R, W], shock_flag[R, W]) for one scenario."""
    R, W = len(ROUTE_KEYS), C.N_WEEKS
    wk = np.arange(W)
    seasonal = 1.0 + cfg["seasonal_amplitude"] * np.sin(
        2 * np.pi * (wk - cfg["seasonal_phase_wk"]) / C.SEASONAL_PERIOD_WEEKS)
    trend = 1.0 + cfg["trend_per_quarter"] * wk / C.WEEKS_PER_QUARTER

    shock = np.ones((R, W))
    flag = np.zeros((R, W), dtype=bool)

    # Random Poisson shock events (spikes and drops, 2-5x band).
    n_events = rng.poisson(cfg["shock_rate_per_year"] * (W / 52.0))
    for _ in range(n_events):
        w0 = int(rng.integers(0, W - 1))
        dur = int(rng.integers(cfg["shock_duration_wk"][0],
                               cfg["shock_duration_wk"][1] + 1))
        w1 = min(W, w0 + dur)
        mag = rng.uniform(*cfg["shock_mag_range"])
        mult = mag if rng.random() < 0.5 else 1.0 / mag
        affected = rng.random(R) < 0.7
        shock[np.ix_(affected, np.arange(w0, w1))] *= mult
        flag[np.ix_(affected, np.arange(w0, w1))] = True

    # Scenario-scheduled demand spike events (lane-scoped).
    for (w0, w1, mult, lanes) in cfg["demand_spike_events"]:
        w1 = min(W, w1)
        if lanes is None:
            affected = np.ones(R, dtype=bool)
        else:
            affected = np.array([ROUTE_LANE[r] in lanes for r in range(R)])
        shock[np.ix_(affected, np.arange(w0, w1))] *= mult
        flag[np.ix_(affected, np.arange(w0, w1))] = True

    dir_mult = np.where(ROUTE_DIR, cfg["backhaul_mult"], cfg["headhaul_mult"])
    lam = (ROUTE_BASE[:, None]
           * cfg["base_demand_mult"]
           * dir_mult[:, None]
           * seasonal[None, :]
           * trend[None, :]
           * shock)
    return lam, flag


def seasonal_index(cfg: dict) -> np.ndarray:
    wk = np.arange(C.N_WEEKS)
    return 1.0 + cfg["seasonal_amplitude"] * np.sin(
        2 * np.pi * (wk - cfg["seasonal_phase_wk"]) / C.SEASONAL_PERIOD_WEEKS)


# ---------------------------------------------------------------------------
# Capacity offered per route-week
# ---------------------------------------------------------------------------

def weekly_capacity(rng: np.random.Generator, cfg: dict,
                    cal: dict) -> np.ndarray:
    """Bookable slot capacity per route-week (partner slots + own lift).

    Partner/charter slots provide a baseline weekly service (the 4-vessel
    fleet alone cannot cover every OD weekly — carriers fill gaps by buying
    alliance slots). Our vessels add a large block of capacity in weeks they
    actually depart the lane.
    """
    R, W = len(ROUTE_KEYS), C.N_WEEKS
    cap = (ROUTE_BASE[:, None]
           * rng.uniform(C.PARTNER_SLOT_LOW, C.PARTNER_SLOT_HIGH, size=(R, W))
           * (cfg["base_demand_mult"] ** 0.3))
    for r, key in enumerate(ROUTE_KEYS):
        if key not in cal:
            continue
        etd = cal[key]["etd"]
        lift = cal[key]["lift"].astype(float)
        wk_idx = ((etd - np.datetime64(C.START_DATE, "ns"))
                  .astype("timedelta64[D]").astype(int)) // 7
        ok = (wk_idx >= 0) & (wk_idx < W)
        np.add.at(cap[r], wk_idx[ok], lift[ok])
    return cap


# ---------------------------------------------------------------------------
# Bookings
# ---------------------------------------------------------------------------

def _sample_teu(rng, n):
    lo = np.array([b[0] for b in C.TEU_BUCKETS])
    hi = np.array([b[1] for b in C.TEU_BUCKETS])
    p = np.array([b[2] for b in C.TEU_BUCKETS])
    b = rng.choice(len(p), size=n, p=p / p.sum())
    return rng.integers(lo[b], hi[b])


def _assign_voyage(req_days, flex_days, entry):
    """Attach each booking to the nearest own-vessel departure within the
    acceptance window (max(flex_days, 3)); else empty string -> partner lift
    or rejected booking."""
    n = len(req_days)
    voyage_id = np.full(n, "", dtype=object)
    if entry is None or len(entry["etd"]) == 0:
        return voyage_id
    etd_days = ((entry["etd"] - np.datetime64(C.START_DATE, "ns"))
                .astype("timedelta64[D]").astype(float))
    window = np.maximum(flex_days, 3.0)
    idx = np.searchsorted(etd_days, req_days)
    inb_a = idx < len(etd_days)
    d_after = np.where(inb_a, etd_days[np.clip(idx, 0, len(etd_days) - 1)],
                       np.inf)
    gap_after = d_after - req_days
    inb_b = idx > 0
    d_before = np.where(inb_b, etd_days[np.clip(idx - 1, 0, len(etd_days) - 1)],
                        -np.inf)
    gap_before = req_days - d_before
    use_after = gap_after <= gap_before
    gap = np.where(use_after, gap_after, gap_before)
    chosen = np.where(use_after, idx, idx - 1)
    ok = (gap <= window) & (chosen >= 0) & (chosen < len(etd_days))
    voyage_id[ok] = entry["voyage_id"][np.clip(chosen[ok], 0, len(etd_days) - 1)]
    return voyage_id


def generate_bookings(rng: np.random.Generator, scenario_id: str, cfg: dict,
                      lam: np.ndarray, rates: np.ndarray,
                      cap: np.ndarray, cal: dict,
                      scale: float) -> pd.DataFrame:
    """One scenario's booking request log (~90-100k rows at scale 1.0)."""
    R, W = lam.shape
    counts = rng.poisson(np.clip(lam / C.MEAN_TEU_PER_BOOKING * scale, 0, None))
    cell = np.repeat(np.arange(R * W), counts.ravel())
    n = len(cell)
    if n == 0:
        return pd.DataFrame()
    r_idx = cell // W
    w_idx = cell % W

    # --- per-booking attributes --------------------------------------------
    shift = cfg["segment_mix_shift"]
    p_seg = SEG_PROB.copy()
    p_seg[0] = max(0.05, p_seg[0] - shift)          # flexible
    p_seg[2] = min(0.9, p_seg[2] + shift)           # urgent
    p_seg = p_seg / p_seg.sum()
    seg_idx = rng.choice(3, size=n, p=p_seg)

    cargo_idx = rng.choice(3, size=n, p=CARGO_PROB)
    teu = _sample_teu(rng, n).astype(float)
    weight = np.clip(rng.normal(C.TONNES_PER_TEU_MEAN, C.TONNES_PER_TEU_SD, n),
                     1.0, C.TONNES_PER_TEU_MAX) * teu

    dep_day = w_idx * 7.0 + rng.uniform(0, 7, n)
    lead = np.clip(rng.gamma(2.5, SEG_LEAD[seg_idx] / 2.5), 0.5, 60.0)
    flex = np.where(SEG_FLEX[seg_idx] > 0,
                    np.round(rng.uniform(0, SEG_FLEX[seg_idx], n)),
                    0).astype(int)
    req_day = dep_day - lead

    market = rates[r_idx, w_idx]
    wtp = market * SEG_WTP_M[seg_idx] * np.exp(
        rng.normal(0, SEG_WTP_S[seg_idx], n))

    # --- streaming order within (route, week) ------------------------------
    req_ts = C.START_DATE + np.round(req_day * 24).astype("timedelta64[h]")
    dep_ts = C.START_DATE + np.round(dep_day * 24).astype("timedelta64[h]")

    order = np.lexsort((req_ts.astype("datetime64[h]").astype(np.int64),
                        w_idx, r_idx))
    grp_sorted = cell[order]
    cap_rw = np.maximum(cap[r_idx, w_idx], 1.0)

    # Two-pass pricing: the carrier quotes off the *booked* load so far, not
    # raw request volume (requests that never convert don't sell capacity).
    noise = np.exp(rng.normal(0, C.QUOTE_NOISE_SD, n))

    # pass 1 — provisional quote off requested fill to discover conversions
    fill_req = np.empty(n)
    fill_req[order] = _grouped_cumsum(teu[order], grp_sorted)
    surge0 = 1.0 + C.QUOTE_SURGE_COEF * np.clip(fill_req / cap_rw - 0.55,
                                              0.0, 1.0)
    quote0 = market * SEG_UPLIFT[seg_idx] * surge0 * noise
    ok0 = quote0 <= wtp

    # pass 2 — surge on the running *accepted* fill fraction
    cum_acc0 = np.empty(n)
    cum_acc0[order] = _grouped_cumsum(
        np.where(ok0[order], teu[order], 0.0), grp_sorted)
    surge = 1.0 + C.QUOTE_SURGE_COEF * np.clip(cum_acc0 / cap_rw - 0.55,
                                               0.0, 1.0)
    quote = np.round(market * SEG_UPLIFT[seg_idx] * surge * noise, 2)
    wtp = np.round(wtp, 2)
    customer_ok = quote <= wtp

    # capacity check on accepted TEU (running total in streaming order)
    cum_acc = np.empty(n)
    cum_acc[order] = _grouped_cumsum(
        np.where(customer_ok[order], teu[order], 0.0), grp_sorted)
    cap_ok = cum_acc <= cap_rw

    # reefer plug constraint: powered slots ~9% of bookable capacity
    is_reefer = cargo_idx == 1
    cum_reef = np.empty(n)
    cum_reef[order] = _grouped_cumsum(
        np.where(customer_ok[order] & is_reefer[order], teu[order], 0.0),
        grp_sorted)
    reefer_ok = cum_reef <= cap_rw * 0.09 + 20.0

    accepted = customer_ok & cap_ok & reefer_ok
    cap_fail = customer_ok & ~accepted
    price_fail = ~customer_ok

    # --- outcomes -----------------------------------------------------------
    outcome = np.full(n, "rejected", dtype=object)
    ctype = np.full(n, "", dtype=object)
    realized = np.full(n, np.nan)
    price_nobook = np.zeros(n, dtype=bool)

    dests = np.array([ROUTE_KEYS[r][1] for r in r_idx], dtype=object)
    has_alt = np.array([d in C.ALT_HUB for d in dests])

    # price-driven fails -> segment-dependent counter-offer probability
    do_counter_p = price_fail & (rng.random(n) < SEG_CPROB[seg_idx])
    c_type_p = np.where(flex > 0, "flex_window_discount",
                        np.where(has_alt, "alternate_hub_discount",
                                 "split_consignment")).astype(object)
    counter_price = np.round(quote * (1.0 - rng.uniform(0.05, 0.20, n)), 2)
    counter_win = do_counter_p & (counter_price <= wtp)
    outcome[counter_win] = "counter_offered"
    ctype[counter_win] = c_type_p[counter_win]
    realized[counter_win] = counter_price[counter_win]
    price_nobook[price_fail & ~counter_win] = True

    # capacity fails -> split / alternate-hub counters (usually succeed:
    # the carrier finds a nearby slot, customer already accepted the price)
    do_counter_c = cap_fail & (rng.random(n) < 0.72)
    c_type_c = np.where(has_alt, "alternate_hub_discount",
                        "split_consignment").astype(object)
    outcome[do_counter_c] = "counter_offered"
    ctype[do_counter_c] = c_type_c[do_counter_c]
    realized[do_counter_c] = np.round(
        quote[do_counter_c] * (1 - rng.uniform(0.03, 0.10, do_counter_c.sum())), 2)

    outcome[accepted] = "accepted"
    realized[accepted] = quote[accepted]

    # --- own-voyage assignment ----------------------------------------------
    voyage_id = np.full(n, "", dtype=object)
    booked = outcome != "rejected"
    for r, key in enumerate(ROUTE_KEYS):
        m = (r_idx == r) & booked
        if m.any():
            voyage_id[m] = _assign_voyage(dep_day[m], flex[m], cal.get(key))

    return pd.DataFrame({
        "scenario_id": scenario_id,
        "request_timestamp": pd.to_datetime(req_ts),
        "origin_port": np.array([ROUTE_KEYS[r][0] for r in r_idx], dtype=object),
        "destination_port": dests,
        "voyage_id": voyage_id,
        "requested_departure": pd.to_datetime(dep_ts),
        "flex_window_days": flex,
        "teu": teu,
        "container_type": np.array(CARGO_NAMES, dtype=object)[cargo_idx],
        "weight_tonnes": np.round(weight, 1),
        "customer_segment": np.array(SEG_NAMES, dtype=object)[seg_idx],
        "willingness_to_pay_per_teu": wtp,
        "quoted_price_per_teu": quote,
        "lead_time_days": np.round(lead, 1),
        "outcome": outcome,
        "counter_offer_type": np.where(ctype == "", None, ctype),
        "realized_price_per_teu": np.round(realized, 2),
        "price_driven_no_book": price_nobook,
        "week_index": w_idx.astype(int),
        "market_rate_per_teu": np.round(market, 2),
    })


# ---------------------------------------------------------------------------
# Weekly route aggregation
# ---------------------------------------------------------------------------

def route_weekly(bookings: pd.DataFrame, lam: np.ndarray, flag: np.ndarray,
                 cap: np.ndarray, cfg: dict, scenario_id: str) -> pd.DataFrame:
    """Dense route x week aggregation for one scenario (includes zero weeks)."""
    R, W = lam.shape
    seas = seasonal_index(cfg)

    b = bookings
    carried = np.where(b["outcome"].to_numpy() != "rejected",
                       b["teu"].to_numpy(), 0.0)
    b = b.assign(_carried=carried)
    agg = (b.groupby(["week_index", "origin_port", "destination_port"],
                     observed=True)
            .agg(n_bookings=("teu", "size"),
                 teu_demanded=("teu", "sum"),
                 teu_carried=("_carried", "sum"),
                 avg_realized_price=("realized_price_per_teu", "mean"))
            .reset_index())

    # dense grid R x W
    grid_r = np.repeat(np.arange(R), W)
    grid_w = np.tile(np.arange(W), R)
    grid = pd.DataFrame({
        "week_index": grid_w,
        "origin_port": [ROUTE_KEYS[r][0] for r in grid_r],
        "destination_port": [ROUTE_KEYS[r][1] for r in grid_r],
    })
    df = grid.merge(agg, how="left",
                    on=["week_index", "origin_port", "destination_port"])
    r_idx = np.array([ROUTE_ID_OF[f"{o}>{d}"] for o, d in
                      zip(df["origin_port"], df["destination_port"])])
    w_idx = df["week_index"].to_numpy()
    df["n_bookings"] = df["n_bookings"].fillna(0).astype(int)
    df["teu_demanded"] = df["teu_demanded"].fillna(0.0)
    df["teu_carried"] = df["teu_carried"].fillna(0.0)
    df["capacity_offered_teu"] = np.round(cap[r_idx, w_idx], 0)
    # utilisation is a fill metric -> clip at 1.0 (counter-offered cargo that
    # overflowed onto alternate arrangements still counts in teu_carried, so
    # the raw ratio can exceed 1; >1 has no meaning as a fill rate)
    df["utilization"] = np.where(
        df["capacity_offered_teu"] > 0,
        np.clip(df["teu_carried"] / df["capacity_offered_teu"], 0.0, 1.0),
        np.nan)
    df["seasonality_index"] = np.round(seas[w_idx], 4)
    df["shock_flag"] = flag[r_idx, w_idx]
    df["scenario_id"] = scenario_id
    df["week_start"] = pd.to_datetime(
        C.START_DATE + (w_idx * 7).astype("timedelta64[D]"))
    return df[["scenario_id", "week_index", "week_start", "origin_port",
               "destination_port", "n_bookings", "teu_demanded",
               "teu_carried", "avg_realized_price", "capacity_offered_teu",
               "utilization", "seasonality_index", "shock_flag"]]


# ---------------------------------------------------------------------------
# Price-volume panel (elasticity training data)
# ---------------------------------------------------------------------------

PROBE_MULTS = np.array([0.80, 0.90, 1.00, 1.10, 1.25])


def price_volume_panel(rng: np.random.Generator, scenario_id: str,
                       lam: np.ndarray, rates: np.ndarray) -> pd.DataFrame:
    """Randomized price probes around the market rate -> realized volume.

    volume = lam_segment * (price/market)^(-elasticity) * lognormal noise.
    Probes give the elasticity model clean off-market price variation that a
    pure observational booking log cannot identify.
    """
    R, W = lam.shape
    n_seg, n_probe = 3, len(PROBE_MULTS)
    vols = np.empty((n_seg * n_probe, R, W))
    k = 0
    for s in range(n_seg):
        for pm in PROBE_MULTS:
            noise = np.exp(rng.normal(0, 0.15, size=(R, W)))
            vols[k] = lam * SEG_PROB[s] * (pm ** -SEG_ELAST[s]) * noise
            k += 1
    n_blocks = n_seg * n_probe
    r_all = np.tile(np.repeat(np.arange(R), W), n_blocks)
    w_all = np.tile(np.arange(W), R * n_blocks)
    s_all = np.repeat(np.arange(n_seg), n_probe * R * W)
    p_all = np.tile(np.repeat(np.arange(n_probe), R * W), n_seg)
    v_all = vols.reshape(-1)
    # deterministic expected volume at the market rate, per row
    base_all = np.concatenate(
        [(lam * SEG_PROB[s]).ravel()
         for s in range(n_seg) for _ in PROBE_MULTS])
    market = rates[r_all, w_all]
    price = np.round(market * PROBE_MULTS[p_all], 2)
    return pd.DataFrame({
        "scenario_id": scenario_id,
        "week_index": w_all.astype(int),
        "origin_port": np.array([ROUTE_KEYS[r][0] for r in r_all], dtype=object),
        "destination_port": np.array([ROUTE_KEYS[r][1] for r in r_all],
                                     dtype=object),
        "customer_segment": np.array(SEG_NAMES, dtype=object)[s_all],
        "market_rate_per_teu": np.round(market, 2),
        "price_per_teu": price,
        "relative_price": np.round(price / market, 4),
        "baseline_volume_teu": np.round(base_all, 1),
        "realized_volume_teu": np.round(v_all, 1),
        "elasticity_true": SEG_ELAST[s_all],
    })
