"""Bid-price (opportunity-cost) pricing engine — plan.md §2.5.

For every bookable leg of every vessel the engine estimates the *shadow
price* of one TEU of capacity: the market-clearing rate at which expected
remaining demand for that leg would exactly consume its remaining slots.

    E_leg = expected contested TEU demand before the leg departs
    K_leg = remaining bookable TEU on the leg (live capacity)
    p*    = mkt_leg * (E_leg / K_leg) ** (1 / elasticity)   isoelastic clear
    bid   = clip(p*, MARGINAL_COST, GUARD_HI * mkt_leg)

A booking's opportunity cost is the sum of bid prices over the legs it
occupies; quotes are floored at that cost and capped by a competitiveness
guard relative to the spot market. Counter-offer discounts are bid-price
differentials between the requested and alternative voyages (plan §2.8).

The engine also exposes ``network_value()`` — Φ(s) = Σ bid_leg × K_leg —
the total network value implied by current bid prices, used for
potential-based reward shaping (plan §3.5, Ng et al. 1999: potential-based
shaping leaves the optimal policy unchanged).

Demand expectations come from a required ``demand_fn`` — the trained
supervised forecaster in ``models/demand.py``, bound to the episode via
``DemandForecaster.bind`` and wired in by ``Simulator``. There is no
oracle path: the engine never reads the simulator's ground-truth demand.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from math import erfc, log, sqrt

import numpy as np

from data import calibration as C
from data import demand as D

# market routes departing each port: port -> [(dest, route_idx)]
ROUTES_FROM: dict[str, list[tuple[str, int]]] = {}
for _r, (_o, _d) in enumerate(D.ROUTE_KEYS):
    ROUTES_FROM.setdefault(_o, []).append((_d, _r))

MEAN_ROUTE_RATE = float(D.ROUTE_RATE.mean())

# Days ahead a booking request can anchor to a sailing — mirrors
# DemandStream.sample_day's `deps < day + 49` draw window.
DRAW_WINDOW_D = 49.0

# Customer willingness-to-pay distribution: a segment mixture of
# lognormals — wtp/market ~ exp(N(log wtp_mult_s, wtp_sd_s)) — taken from
# calibration (the fitted models/wtp.py recovers these same parameters).
_SQRT2 = sqrt(2.0)
_SEG_W = [C.SEGMENT_MIX[s] for s in C.SEGMENTS]
_SEG_MU = [log(C.SEGMENTS[s]["wtp_mult"]) for s in C.SEGMENTS]
_SEG_SD = [C.SEGMENTS[s]["wtp_sd"] for s in C.SEGMENTS]
_SEG_PARAM = {s: (log(C.SEGMENTS[s]["wtp_mult"]), C.SEGMENTS[s]["wtp_sd"])
              for s in C.SEGMENTS}


def wtp_survival(rel_price: float) -> float:
    """P(wtp >= price) at price = rel_price x market, under the segment
    mixture. Monotone decreasing; ~1 at rel 0.7, ~0 at rel 1.8."""
    if rel_price <= 0:
        return 1.0
    lr = log(rel_price)
    return float(sum(
        w * 0.5 * erfc((lr - mu) / (sd * _SQRT2))
        for w, mu, sd in zip(_SEG_W, _SEG_MU, _SEG_SD)))


def wtp_survival_seg(segment: str, rel_price: float) -> float:
    """P(wtp >= price) within a single customer segment."""
    if rel_price <= 0:
        return 1.0
    mu, sd = _SEG_PARAM[segment]
    return 0.5 * erfc((log(rel_price) - mu) / (sd * _SQRT2))


@dataclass
class LegQuote:
    """Per-leg bid-price decomposition for reason-coded offers (§4.5)."""
    leg_idx: int
    dep_day: float
    remaining_teu: float
    expected_teu: float
    pressure: float
    market_rate: float
    bid_price: float


@dataclass
class QuoteResult:
    price: float                 # $/TEU to quote
    bid_price: float             # opportunity-cost floor $/TEU (sum of legs)
    market_rate: float
    reason: str                  # reason code
    legs: list[LegQuote] = field(default_factory=list)


class BidPriceEngine:
    """Shadow-price pricing over the simulator's live fleet state.

    Cheap enough to refresh every sim-day: per refresh it computes, per
    vessel, the expected contested demand E and demand-weighted market rate
    for each future leg. The E/K -> price transform then runs on live
    capacity, so quotes respond to intraday bookings without a rebuild.
    """

    MARGINAL_COST = 60.0         # handling both ends + incremental, $/TEU
    GUARD_HI = 1.50              # bid-price cap: value of scarce capacity
    GUARD_LO = 0.80              # never quote below 0.8x spot market
    QUOTE_GUARD = 1.45           # posted-quote cap vs market — clearing
                                 # prices already live inside the WTP
                                 # support, this only catches extremes

    def __init__(self, sim, elasticity: float = 1.2, demand_fn=None):
        self.sim = sim
        self.elasticity = float(elasticity)
        # demand_fn(route_idx, day_lo, day_hi) -> expected TEU of requests
        if demand_fn is None:
            raise ValueError(
                "BidPriceEngine requires demand_fn — pass a bound "
                "DemandForecaster.daily (see models/demand.py; Simulator "
                "wires it automatically). The oracle demand path was "
                "removed.")
        self.demand_fn = demand_fn
        self._cache_day = -1.0
        self._E: dict[tuple[str, int], float] = {}
        self._mkt: dict[tuple[str, int], float] = {}

    def _n_deps(self, o: str, d: str, t: float) -> int:
        """Own-fleet departures on OD choosable on day t: (t, t+49d]."""
        deps = self.sim.sailings.get((o, d))
        if deps is None:
            return 1
        lo = np.searchsorted(deps, t + 0.5, side="right")
        hi = np.searchsorted(deps, t + DRAW_WINDOW_D, side="right")
        return max(int(hi - lo), 1)

    # ------------------------------------------------------------------
    # Per-day refresh: expected contested demand + market rate per leg
    # ------------------------------------------------------------------

    def refresh(self) -> None:
        day = self.sim.day
        if day == self._cache_day:
            return
        self._cache_day = day
        self._E.clear()
        self._mkt.clear()

        for v in self.sim.vessels.values():
            vid = v.spec.vessel_id
            n_calls = len(v.calls)
            leg_E = np.zeros(n_calls)
            leg_Em = np.zeros(n_calls)        # E x prorated rate accumulator
            for i, call in enumerate(v.calls):
                dep_i = call.planned_etd
                if dep_i < day + 0.5:
                    continue                    # boarding call already gone
                for d, r in ROUTES_FROM.get(call.port, []):
                    dc = v.next_call_at(i, d)
                    if dc is None:
                        continue
                    j = dc.idx                 # discharge call index
                    # arrival days on which this voyage is a draw candidate:
                    # t in (dep_i - 49, dep_i) clipped to [day, horizon]
                    lo = max(day, dep_i - DRAW_WINDOW_D)
                    hi = dep_i
                    if hi <= lo:
                        continue
                    e_i = self.demand_fn(r, lo, hi) \
                        / self._n_deps(call.port, d, (lo + hi) / 2.0)
                    if e_i <= 0:
                        continue
                    # current-week spot rate: the honest martingale
                    # forecast of a mean-reverting rate process — reading
                    # rates at the leg's future departure week would leak
                    # ground truth
                    rate = float(self.sim.demand.rates[
                        r, self.sim.demand.week_of(self.sim.day)])
                    # An OD rate pays for the WHOLE journey, so each leg it
                    # traverses may only claim its distance share of it —
                    # otherwise summing leg bids over a k-leg itinerary
                    # counts the fare k times (straight-mileage proration,
                    # as used for interline revenue splits).
                    nm = [v.calls[l].leg_distance_nm for l in range(i, j)]
                    total_nm = sum(nm) or 1.0
                    for leg_l, leg_nm in zip(range(i, j), nm):
                        leg_E[leg_l] += e_i
                        leg_Em[leg_l] += e_i * rate * (leg_nm / total_nm)
            for leg in range(n_calls - 1):
                if v.calls[leg].planned_etd < day + 0.5:
                    continue                    # leg already sailed
                e, em = leg_E[leg], leg_Em[leg]
                self._E[(vid, leg)] = e
                self._mkt[(vid, leg)] = (em / e) if e > 1e-9 \
                    else self._fallback_rate(leg, v)

    def _fallback_rate(self, leg: int, v) -> float:
        """Market rate for a leg with no expected contested demand."""
        o, d = v.calls[leg].port, v.calls[leg + 1].port
        r = D.ROUTE_ID_OF.get(f"{o}>{d}")
        if r is not None:
            w = min(int(self.sim.day // 7), self.sim.demand.horizon_weeks - 1)
            return float(self.sim.demand.rates[r, w])
        w = min(int(self.sim.day // 7), self.sim.demand.horizon_weeks - 1)
        return float(self.sim.demand.rates[:, w].mean())

    # ------------------------------------------------------------------
    # Bid prices
    # ------------------------------------------------------------------

    def _marginal_value_rel(self, e: float, k: float) -> float:
        """Expected revenue of one more slot on a leg, in market-rate units:
            max_r  r * min(1, E * SF(r) / K)
        the best posted relative price times the probability that marginal
        slot actually sells. Thick demand (E>>K) -> approaches the clearing
        price; thin demand -> the revenue-optimal price discounted by the
        odds it sells at all; E=0 -> 0 (a slot nobody wants is worthless).
        """
        if e <= 0 or k <= 0:
            return 0.0
        best = 0.0
        for i in range(36):
            r = 0.30 + (2.00 - 0.30) * i / 35.0
            v = r * min(1.0, e * wtp_survival(r) / k)
            if v > best:
                best = v
        return best

    def leg_bid(self, vessel_id: str, leg_idx: int) -> float:
        """Opportunity cost of one TEU of capacity on this leg, $/TEU."""
        self.refresh()
        v = self.sim.vessels[vessel_id]
        if leg_idx >= len(v.calls) - 1 \
                or v.calls[leg_idx].planned_etd < self.sim.day + 0.5:
            return 0.0                          # sailed / nonexistent leg
        e = self._E.get((vessel_id, leg_idx), 0.0)
        mkt = self._mkt.get((vessel_id, leg_idx), MEAN_ROUTE_RATE)
        k = v.leg_cap(leg_idx).teu
        if k <= 0:
            return mkt * self.GUARD_HI          # sold out -> top of guard
        p_bid = mkt * self._marginal_value_rel(e, k)
        return float(np.clip(p_bid, self.MARGINAL_COST,
                             self.GUARD_HI * mkt))

    def leg_quote(self, vessel_id: str, leg_idx: int) -> LegQuote:
        self.refresh()
        v = self.sim.vessels[vessel_id]
        k = max(v.leg_cap(leg_idx).teu, 0.0)
        e = self._E.get((vessel_id, leg_idx), 0.0)
        mkt = self._mkt.get((vessel_id, leg_idx), MEAN_ROUTE_RATE)
        return LegQuote(leg_idx=leg_idx,
                        dep_day=float(v.calls[leg_idx].planned_etd),
                        remaining_teu=round(k, 1),
                        expected_teu=round(e, 1),
                        pressure=round(e / max(k, 1.0), 3),
                        market_rate=round(mkt, 2),
                        bid_price=round(
                            self.leg_bid(vessel_id, leg_idx), 2))

    def option_bid(self, opt) -> float:
        """$/TEU opportunity cost of an itinerary = sum over its legs."""
        return float(sum(self.leg_bid(opt.vessel_id, leg)
                         for leg in opt.legs))

    # ------------------------------------------------------------------
    # Quotes and counter-offer differentials
    # ------------------------------------------------------------------

    def _optimal_rel_price(self, segment: str, rel_cost: float) -> float:
        """Revenue-optimal relative price for one segment given an
        opportunity cost: argmax_r  SF_seg(r) * (r - rel_cost).

        Customers are one-shot take-it-or-leave-it, so the optimum is the
        classic monopoly markup over the marginal cost — not the clearing
        price (posting the clearing price discards all sub-threshold
        demand without recapture). Solved on a fixed grid; the segment's
        product uplift bounds the price from below (carrier premium).
        """
        uplift = C.SEGMENTS[segment]["quote_uplift"]
        lo = max(self.GUARD_LO, uplift, rel_cost)
        if lo >= self.QUOTE_GUARD:
            return self.QUOTE_GUARD      # opportunity cost exceeds every
                                         # postable price -> signal reject
        best_r, best_g = lo, 0.0
        for i in range(41):
            r = lo + (self.QUOTE_GUARD - lo) * i / 40.0
            g = wtp_survival_seg(segment, r) * (r - rel_cost)
            if g > best_g:
                best_g, best_r = g, r
        return best_r

    def quote(self, req, opt) -> QuoteResult:
        """Quoted $/TEU: profit-maximizing price over the bid floor,
        i.e. argmax_p P(wtp_seg >= p) * (p - opportunity_cost)."""
        self.refresh()
        legs = [self.leg_quote(opt.vessel_id, l) for l in opt.legs]
        bid = float(sum(l.bid_price for l in legs))
        mkt = float(req.market_rate)
        rel = self._optimal_rel_price(req.segment.value, bid / mkt)
        price = float(np.clip(rel * mkt,
                              max(self.MARGINAL_COST, self.GUARD_LO * mkt),
                              self.QUOTE_GUARD * mkt))
        if price >= self.QUOTE_GUARD * mkt - 1e-6:
            reason = "competitiveness_guard"
        elif bid > mkt * C.SEGMENTS[req.segment.value]["quote_uplift"]:
            reason = "bid_price_floor"
        else:
            reason = "market_uplift"
        return QuoteResult(price=round(price, 2), bid_price=round(bid, 2),
                           market_rate=round(mkt, 2), reason=reason,
                           legs=legs)

    def counter_discount(self, req, opt_alt, opt_req=None) -> tuple[float, str]:
        """Discount fraction justified by the bid-price differential between
        the requested voyage and a cheaper alternative (flex window, alt hub).
        Returns (discount_pct, reason)."""
        ref = opt_req if opt_req is not None else \
            (req.options[0] if req.options else None)
        if ref is None:
            return 0.0, "no_reference_option"
        bp_alt = self.option_bid(opt_alt)
        bp_req = self.option_bid(ref)
        if bp_req <= 0 or bp_alt >= bp_req:
            return 0.0, "no_cheaper_capacity"
        disc = float(np.clip(1.0 - bp_alt / bp_req, 0.0, 0.30))
        return disc, (f"alt option bid ${bp_alt:.0f}/TEU vs requested "
                      f"${bp_req:.0f}/TEU -> -{disc * 100:.0f}%")

    def explain(self, req, opt) -> dict:
        """Structured, reason-coded justification for an offer (§4.5)."""
        q = self.quote(req, opt)
        return {
            "engine": "bid_price",
            "quote_per_teu": q.price,
            "bid_price_per_teu": q.bid_price,
            "market_rate_per_teu": q.market_rate,
            "reason": q.reason,
            "legs": [vars(l) for l in q.legs],
            "text": (f"Bid price {opt.vessel_id} legs {list(opt.legs)}: "
                     f"${q.bid_price:.0f}/TEU opportunity cost "
                     f"(remaining capacity vs forecast demand); "
                     f"market ${q.market_rate:.0f}/TEU; "
                     f"quote ${q.price:.0f}/TEU [{q.reason}]."),
        }

    # ------------------------------------------------------------------
    # Potential function for reward shaping (plan §3.5)
    # ------------------------------------------------------------------

    def network_value(self) -> float:
        """Φ(s) = Σ_legs bid_leg × remaining_teu_leg over bookable legs."""
        self.refresh()
        total = 0.0
        for vid, v in self.sim.vessels.items():
            for leg in range(len(v.calls) - 1):
                if v.calls[leg].planned_etd < self.sim.day + 0.5:
                    continue
                k = v.leg_cap(leg).teu
                if k > 0:
                    total += self.leg_bid(vid, leg) * k
        return float(total)

    def mean_pressure(self) -> float:
        """Mean E/K (expected demand over remaining slots) across bookable
        legs — a scalar scarcity signal for the observation vector."""
        self.refresh()
        vals = []
        for vid, v in self.sim.vessels.items():
            for leg in range(len(v.calls) - 1):
                if v.calls[leg].planned_etd < self.sim.day + 0.5:
                    continue
                k = v.leg_cap(leg).teu
                if k > 0:
                    vals.append(self._E.get((vid, leg), 0.0) / k)
        return float(np.mean(vals)) if vals else 0.0
