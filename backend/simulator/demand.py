"""Online demand for the simulator.

Reuses the batch generator's market_state / demand_intensity processes (the
full 104-week series is drawn once per episode, then the episode window is
sliced out — identical distribution to the offline training data).

Only origin-destination pairs that the own fleet can actually serve emit
booking requests; the rest of world demand is served by partner carriers and
never reaches us.
"""

from __future__ import annotations

import numpy as np

from data import calibration as C
from data import demand as D
from .types import BookingRequest, CargoType, Segment

SEG_NAMES = list(C.SEGMENTS)
SEG_PROB = np.array([C.SEGMENT_MIX[s] for s in SEG_NAMES])


def servable_ods(vessel_loops: dict[str, list[str]]) -> set[tuple[str, str]]:
    """OD pairs the fleet can carry: o appears before d somewhere in the
    repeating call stream of a single vessel's loop (wrapping allowed)."""
    pairs: set[tuple[str, str]] = set()
    for loop in vessel_loops.values():
        k = len(loop)
        for i in range(k):
            for j in range(i + 1, i + k):
                pairs.add((loop[i % k], loop[j % k]))
    return pairs


class DemandStream:
    """Yields stochastic booking requests day by day for one episode."""

    def __init__(self, rng: np.random.Generator, cfg: dict,
                 servable: set[tuple[str, str]],
                 sailings: dict[tuple[str, str], np.ndarray],
                 start_week: int, horizon_weeks: int):
        self.rng = rng
        self.cfg = cfg
        self.sailings = sailings

        rng_m, rng_d = (np.random.default_rng(s)
                        for s in rng.bit_generator.seed_seq.spawn(2))
        mkt = D.market_state(rng_m, cfg)
        lam_full, _flag = D.demand_intensity(rng_d, cfg)

        w0 = start_week
        w1 = start_week + horizon_weeks
        self.start_week = w0
        self.horizon_weeks = horizon_weeks
        self.lam = lam_full[:, w0:w1]                      # TEU/week per route
        self.rates = mkt["rates"][:, w0:w1]
        self.fuel = mkt["fuel_usd_t"][w0:w1]
        self.ets = mkt["ets_eur_t"][w0:w1]

        # restrict to servable ODs
        self.route_idx = np.array([
            r for r, key in enumerate(D.ROUTE_KEYS) if key in servable])
        self.next_request_id = 0

    def week_of(self, day: float) -> int:
        return min(int(day // 7), self.horizon_weeks - 1)

    def market_rate(self, route_key: tuple[str, str], day: float) -> float:
        r = D.ROUTE_ID_OF[f"{route_key[0]}>{route_key[1]}"]
        return float(self.rates[r, self.week_of(day)])

    def fuel_price(self, day: float) -> float:
        return float(self.fuel[self.week_of(day)])

    def ets_price(self, day: float) -> float:
        return float(self.ets[self.week_of(day)])

    def sample_day(self, day: float) -> list[BookingRequest]:
        """Draw today's booking requests on servable routes."""
        w = self.week_of(day)
        out: list[BookingRequest] = []
        for r in self.route_idx:
            lam_day = self.lam[r, w] / 7.0 / C.MEAN_TEU_PER_BOOKING
            n = self.rng.poisson(lam_day)
            if n == 0:
                continue
            o, d = D.ROUTE_KEYS[r]
            seg_i = self.rng.choice(3, size=n, p=SEG_PROB)
            cargo_i = self.rng.choice(3, size=n, p=list(C.CARGO_MIX.values()))
            lo = np.array([bk[0] for bk in C.TEU_BUCKETS])
            hi = np.array([bk[1] for bk in C.TEU_BUCKETS])
            bp = np.array([bk[2] for bk in C.TEU_BUCKETS])
            bucket = self.rng.choice(len(bp), size=n, p=bp)
            teu = self.rng.integers(lo[bucket], hi[bucket])
            mkt = self.rates[r, w]
            # shippers book actual sailings: requested departure clusters near
            # real upcoming departures on this OD, with small jitter
            deps = self.sailings.get((o, d))
            future = deps[(deps > day + 0.5) & (deps < day + 49.0)] \
                if deps is not None else np.empty(0)
            for k in range(n):
                s = SEG_NAMES[seg_i[k]]
                sp = C.SEGMENTS[s]
                wtp = mkt * sp["wtp_mult"] * np.exp(
                    self.rng.normal(0, sp["wtp_sd"]))
                if len(future):
                    req_dep = float(self.rng.choice(future)
                                    + self.rng.normal(0, 1.2))
                else:
                    req_dep = float(day) + float(np.clip(
                        self.rng.gamma(2.5, sp["lead_mean"] / 2.5),
                        0.5, 30.0))
                flex = int(round(self.rng.uniform(0, sp["flex_days"]))) \
                    if sp["flex_days"] else 0
                req = BookingRequest(
                    request_id=self.next_request_id,
                    day=float(day) + self.rng.random(),
                    origin=o, dest=d,
                    teu=int(teu[k]),
                    weight_t=float(np.clip(
                        self.rng.normal(C.TONNES_PER_TEU_MEAN,
                                        C.TONNES_PER_TEU_SD),
                        1.0, C.TONNES_PER_TEU_MAX) * teu[k]),
                    cargo_type=CargoType(list(C.CARGO_MIX)[cargo_i[k]]),
                    segment=Segment(s),
                    wtp_per_teu=float(wtp),
                    market_rate=float(mkt),
                    req_dep_day=max(float(day) + 0.5, req_dep),
                    flex_days=flex,
                )
                self.next_request_id += 1
                out.append(req)
        return out
