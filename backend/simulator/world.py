"""Simulator core — the Dock digital twin (plan.md §2.3).

Discrete daily steps over a configurable horizon (default 90 days). The
policy-facing API is deliberately thin:

    sim = Simulator(SimConfig(...))
    sim.reset()
    while not sim.done:
        for req in sim.begin_day():            # today's booking requests
            dec = policy.decide_booking(req, sim)
            sim.apply_decision(req, dec)
        if sim.day % sim.fleet_every == 0:
            for act in policy.decide_fleet(sim):
                sim.apply_fleet_action(act)
        sim.end_day()                          # vessels move, economics accrue

The simulator owns: vessel movement, port congestion/closures, storms/canal
disruptions, customer accept/decline response (quote vs. hidden WTP),
capacity + stowage feasibility, and all economics/metrics. Policies only
choose among options the sim presents as feasible.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass

import numpy as np

from data import calibration as C
from data import demand as D
from data import scenarios as SC
from pricing import BidPriceEngine
from .demand import DemandStream, servable_ods
from .fleet import PORT, SEA, VesselSpec, VesselState
from .metrics import MetricsTracker
from .types import (BookingDecision, BookingRequest, CargoType, DecisionKind,
                    FleetAction, VoyageOption)

EU_PORTS = {"NLRTM", "DEHAM", "BEANR"}
LEASE_COST_PER_TEU = 120.0        # emergency container lease, $/TEU
REPO_COST_PER_TEU = 60.0          # empty reposition handling, $/TEU
ROLL_COMP_PER_TEU = 200.0         # compensation when a booking can't load
PORT_CALL_FEE = 25000.0           # $/port call
HANDLE_PER_TEU = 12.0             # $/TEU loaded+discharged
DEMURRAGE_FREE_DAYS = 2.0
# ~2.5 sd of DemandStream's N(0,1.2) sailing-anchor jitter: req_dep_day is a
# jittered observation of a real sailing date, so the option search window
# must be symmetric around it — a strict req_dep_day - flex_days lower bound
# hides the very sailing the request was anchored to whenever the jitter is
# positive and flex_days is 0.
JITTER_TOL_D = 3.0
# leg duration multipliers by disruption type
DISRUPTION_LEG_MULT = {"storm": 1.35, "canal_closure": 1.40}
# extra destination wait days by disruption type
DISRUPTION_WAIT = {"strike": (1.5, 9.0), "congestion": (1.5, 8.0)}

SPEED_TIERS = (12.0, 14.0, 16.0, 18.0)


@dataclass
class SimConfig:
    scenario: str | dict = "baseline"
    horizon_days: int = 90
    start_week: int | None = None        # random if None
    seed: int = 0
    pricing: str = "dynamic"             # "dynamic" | "rate_card" | "bid_price"
    fleet_every: int = 3                 # days between fleet-action prompts
    fleet_actions: bool = True           # False -> booking-only curriculum
    vessel_ids: list[str] | None = None  # subset of fleet (curriculum)


class Simulator:
    def __init__(self, config: SimConfig):
        self.config = config

    # ------------------------------------------------------------------
    # Reset
    # ------------------------------------------------------------------

    def reset(self) -> None:
        cfg = self.config
        if isinstance(cfg.scenario, str):
            base = SC.SCENARIOS[cfg.scenario]
            self.scenario_name = cfg.scenario
        else:
            base = cfg.scenario
            self.scenario_name = "custom"
        self.cfg = copy.deepcopy(base)
        self.rng = np.random.default_rng(cfg.seed)
        self.metrics = MetricsTracker()
        self.day = 0.0
        self.done = False
        self.pending: list[BookingRequest] = []

        horizon_weeks = int(np.ceil((cfg.horizon_days + 21) / 7))
        max_start = max(0, C.N_WEEKS - horizon_weeks)
        self.start_week = (cfg.start_week if cfg.start_week is not None
                           else int(self.rng.integers(0, max_start + 1)))

        # vessels (optionally a subset for curriculum phases)
        allowed = set(cfg.vessel_ids) if cfg.vessel_ids else None
        loops = {k: v for k, v in C.VESSEL_LOOPS.items()
                 if allowed is None or k in allowed}
        servable = servable_ods(loops)

        dwell = {p[0]: p[8] for p in C.PORTS}
        self.vessels: dict[str, VesselState] = {}
        for (vid, name, cap, reefer, vmin, vserv, vmax, age, draft, burn) \
                in C.VESSELS:
            if allowed is not None and vid not in allowed:
                continue
            spec = VesselSpec(vid, cap, reefer, vmin, vserv, vmax,
                              0.15 * burn, (burn - 0.15 * burn) / vserv ** 3,
                              age, C.VESSEL_LOOPS[vid])
            phase = float(self.rng.uniform(0, 14))
            v = VesselState(spec, cfg.horizon_days, phase, dwell)
            v.name = name
            v.empty_aboard = 0
            self.vessels[vid] = v
        assert self.vessels, "vessel_ids produced an empty fleet"

        # sailing calendar: OD -> sorted planned departure days (drives
        # request generation — shippers book real sailings)
        self.sailings = self._build_sailings(servable)

        rng_dem = np.random.default_rng(
            self.rng.bit_generator.seed_seq.spawn(1)[0])
        self.demand = DemandStream(rng_dem, self.cfg, servable, self.sailings,
                                   self.start_week, horizon_weeks)
        self.horizon_weeks = horizon_weeks

        # bid-price engine (plan §2.5): opportunity-cost quotes + Φ for RL
        # reward shaping. Lazily attachable via attach_pricer().
        self.pricer = BidPriceEngine(self) if cfg.pricing == "bid_price" \
            else None

        # bookings awaiting loading, per vessel per call idx
        self.waiting: dict[str, dict[int, list[dict]]] = {
            vid: {} for vid in self.vessels}
        # reposition manifests: repos_out[board_call] -> [(teu, discharge_call)]
        # is loaded at departure; repos_in[discharge_call] -> [teu] credits
        # the destination port's empty inventory on arrival.
        self.repos_out: dict[str, dict[int, list[tuple[int, int]]]] = {
            vid: {} for vid in self.vessels}
        self.repos_in: dict[str, dict[int, list[int]]] = {
            vid: {} for vid in self.vessels}

        # port state
        self.port_ids = [p[0] for p in C.PORTS]
        self.base_wait = {p[0]: p[9] for p in C.PORTS}
        self.base_cong = {p[0]: p[6] for p in C.PORTS}
        self.empties = {p: 500.0 for p in self.port_ids}
        self._build_port_state()

        # route-week disruption lookup: (route_idx, week) -> (type, delay)
        self._build_disruptions()

        self._req_counter = 0

    # ------------------------------------------------------------------
    # Port congestion / closures for the horizon window
    # ------------------------------------------------------------------

    def _build_port_state(self) -> None:
        n = int(self.config.horizon_days) + 30
        self.port_wait = {}          # port -> np.ndarray[day] hours
        self.port_closed = {}        # port -> bool array
        self.port_strike = {}
        day0 = self.start_week * 7
        for p in self.port_ids:
            occ = self.base_cong[p] + self._ar1(n, 0.92, 0.05)
            occ = np.clip(occ, 0.05, 0.995)
            wait = (self.base_wait[p] * (occ / 0.6) ** 2.5
                    * self.cfg["congestion_mult"]
                    * np.exp(self.rng.normal(0, 0.2, n)))
            self.port_wait[p] = np.clip(wait, 0.5, 200.0)
            self.port_closed[p] = np.zeros(n, dtype=bool)
            self.port_strike[p] = np.zeros(n, dtype=bool)
        for (p, w0, w1) in self.cfg["port_closures"]:
            i0, i1 = w0 * 7 - day0, w1 * 7 - day0
            self.port_closed[p][max(0, i0):min(n, i1)] = True
        for (p, w0, w1) in self.cfg["port_strikes"]:
            i0, i1 = w0 * 7 - day0, w1 * 7 - day0
            self.port_strike[p][max(0, i0):min(n, i1)] = True

    def _build_disruptions(self) -> None:
        """Route-week disruption table for the horizon (stochastic storms +
        scenario-scheduled closures/strikes)."""
        R = len(D.ROUTE_KEYS)
        W = self.horizon_weeks
        self.disruption = np.full((R, W), "none", dtype=object)
        self.disruption_delay = np.zeros((R, W))
        wk = np.arange(self.start_week, self.start_week + W)
        doy = (wk % 52).astype(float) * 7.0
        for r in range(R):
            lane = D.ROUTE_LANE[r]
            if lane == "asia_europe":
                storm_p = 0.08 + 0.28 * np.exp(-((np.minimum(
                    (doy - 15) % 365, (15 - doy) % 365)) ** 2) / (2 * 45 ** 2))
            elif lane == "asia_na":
                storm_p = 0.07 + 0.30 * np.exp(-((np.minimum(
                    (doy - 20) % 365, (20 - doy) % 365)) ** 2) / (2 * 50 ** 2))
            else:
                storm_p = np.full(W, 0.06)
            storm_p = np.clip(storm_p * self.cfg["disruption_mult"], 0, 0.9)
            storms = self.rng.random(W) < storm_p * 0.55
            self.disruption[r][storms] = "storm"
            self.disruption_delay[r][storms] = self.rng.gamma(
                2.0, 1.4, storms.sum())
            o, d = D.ROUTE_KEYS[r]
            for (p, w0, w1) in self.cfg["port_strikes"]:
                if p in (o, d):
                    a, b = w0 - self.start_week, w1 - self.start_week
                    self.disruption[r][max(0, a):min(W, b)] = "strike"
            for (p, w0, w1) in self.cfg["port_closures"]:
                if p in (o, d):
                    a, b = w0 - self.start_week, w1 - self.start_week
                    self.disruption[r][max(0, a):min(W, b)] = "congestion"
            if lane == "asia_europe":
                for (w0, w1) in self.cfg["canal_closures"]:
                    a, b = w0 - self.start_week, w1 - self.start_week
                    self.disruption[r][max(0, a):min(W, b)] = "canal_closure"

    def _ar1(self, n: int, phi: float, sigma: float) -> np.ndarray:
        x = np.empty(n)
        x[0] = self.rng.normal(0, sigma)
        eps = self.rng.normal(0, sigma, n)
        for t in range(1, n):
            x[t] = phi * x[t - 1] + eps[t]
        return x

    def _build_sailings(self, servable: set[tuple[str, str]]) -> dict:
        """OD -> sorted array of planned board days across the fleet."""
        out: dict[tuple[str, str], list[float]] = {k: [] for k in servable}
        for v in self.vessels.values():
            for i, call in enumerate(v.calls):
                for j in range(i + 1, min(i + len(v.loop), len(v.calls))):
                    key = (call.port, v.calls[j].port)
                    if key[0] == key[1]:
                        continue            # loop revisits a port: not an OD
                    if key in out:
                        out[key].append(call.planned_etd)
        return {k: np.sort(np.array(v)) for k, v in out.items() if v}

    # ------------------------------------------------------------------
    # Voyage options for a request
    # ------------------------------------------------------------------

    def _options_for(self, req: BookingRequest, dest: str,
                     day_hi_extra: float = 14.0) -> list[VoyageOption]:
        """All own-fleet carriage options origin->dest departing in
        [req_dep - max(flex, JITTER_TOL_D), req_dep + max(flex, day_hi_extra)]."""
        tol = max(req.flex_days, JITTER_TOL_D)
        lo = max(req.req_dep_day - tol, self.day)
        hi = req.req_dep_day + max(req.flex_days, day_hi_extra)
        out = []
        for v in self.vessels.values():
            for call in v.upcoming_calls(req.origin, lo, hi):
                dc = v.next_call_at(call.idx, dest)
                if dc is None:
                    continue
                legs = v.legs_between(call.idx, dc.idx)
                opt = VoyageOption(
                    vessel_id=v.spec.vessel_id,
                    board_call=call.idx,
                    discharge_call=dc.idx,
                    board_day=call.planned_etd,
                    discharge_day_est=dc.planned_etd,
                    legs=legs,
                    within_flex=abs(call.planned_etd - req.req_dep_day)
                    <= tol,
                )
                opt.capacity_ok = v.has_capacity(
                    legs, req.teu, req.weight_t,
                    req.cargo_type is CargoType.REEFER)
                out.append(opt)
        out.sort(key=lambda o: abs(o.board_day - req.req_dep_day))
        return out[:4]

    def option_has_capacity(self, req: BookingRequest,
                            opt: VoyageOption, teu: float | None = None,
                            weight: float | None = None) -> bool:
        v = self.vessels[opt.vessel_id]
        return v.has_capacity(opt.legs, teu or req.teu,
                              weight or req.weight_t,
                              req.cargo_type is CargoType.REEFER)

    def feasible(self, req: BookingRequest, opt: VoyageOption,
                 teu: float | None = None, weight: float | None = None) -> bool:
        """Full feasibility: per-leg capacity AND projected stowage plan."""
        teu = req.teu if teu is None else teu
        wt = req.weight_t if weight is None else weight
        v = self.vessels[opt.vessel_id]
        if not v.has_capacity(opt.legs, teu, wt,
                              req.cargo_type is CargoType.REEFER):
            return False
        return v.stowage.can_place(int(round(teu)), opt.board_call,
                                   opt.discharge_call, wt / max(teu, 1.0),
                                   req.cargo_type)

    # ------------------------------------------------------------------
    # Pricing (replaced by the bid-price engine later — plan §2.5)
    # ------------------------------------------------------------------

    def attach_pricer(self) -> BidPriceEngine:
        """Ensure a bid-price engine exists (reward shaping under any
        pricing mode). Returns the engine."""
        if self.pricer is None:
            self.pricer = BidPriceEngine(self)
        return self.pricer

    def quote(self, req: BookingRequest, opt: VoyageOption) -> float:
        """Quoted $/TEU. rate_card = flat calibrated route rate (industry
        baseline); dynamic = market x segment uplift x fill surge;
        bid_price = opportunity-cost floor + competitiveness guard (§2.5)."""
        if self.config.pricing == "rate_card":
            for (o, d, _b, rate, _l, _dir) in C.ROUTES:
                if o == req.origin and d == req.dest:
                    return float(rate)
            return req.market_rate
        if self.config.pricing == "bid_price":
            return self.attach_pricer().quote(req, opt).price
        v = self.vessels[opt.vessel_id]
        fill = 1.0 - v.leg_cap(opt.legs[0]).teu / v.own_lift_teu
        surge = 1.0 + C.QUOTE_SURGE_COEF * np.clip(fill - 0.55, 0.0, 1.0)
        uplift = C.SEGMENTS[req.segment.value]["quote_uplift"]
        return float(req.market_rate * uplift * surge)

    # ------------------------------------------------------------------
    # Day loop
    # ------------------------------------------------------------------

    def begin_day(self) -> list[BookingRequest]:
        self.pending = []
        for req in self.demand.sample_day(self.day):
            req.options = self._options_for(req, req.dest)
            alt = C.ALT_HUB.get(req.dest)
            if alt:
                req.alt_dest = alt
                req.alt_options = self._options_for(req, alt)
            self.pending.append(req)
            self.metrics.n_requests += 1
            self.metrics.by_segment[req.segment.value]["requests"] += 1
        return self.pending

    def _customer_accepts(self, price: float, req: BookingRequest,
                          counter: bool) -> bool:
        if price > req.wtp_per_teu:
            return False
        if not counter:
            return True
        p = C.SEGMENTS[req.segment.value]["counter_prob"]
        return bool(self.rng.random() < p)

    def _book(self, req: BookingRequest, opt: VoyageOption, price: float,
              teu: float, weight: float, kind: str) -> None:
        v = self.vessels[opt.vessel_id]
        scale = teu / req.teu
        v.consume(opt.legs, teu, weight * scale,
                  req.cargo_type is CargoType.REEFER)
        v.stowage.place(int(round(teu)), opt.board_call, opt.discharge_call,
                        weight / max(teu, 1), req.cargo_type)
        self.waiting[opt.vessel_id].setdefault(opt.board_call, []).append({
            "teu": teu, "dest_call": opt.discharge_call,
            "origin": req.origin, "dest": req.dest,
        })
        self.metrics.revenue += price * teu
        self.metrics.teu_booked += teu
        self.metrics.by_segment[req.segment.value]["booked"] += 1
        self.metrics.decision_log.append({
            "request_id": req.request_id, "kind": kind, "price": price,
            "teu": teu, "vessel": opt.vessel_id,
            "board_call": opt.board_call, "discharge_call": opt.discharge_call,
        })

    def apply_decision(self, req: BookingRequest,
                       dec: BookingDecision) -> dict:
        """Policy-facing wrapper: applies the decision and tallies the
        outcome + reason code for the audit log / metrics."""
        res = self._apply_decision(req, dec)
        reason = res.get("reason") or res.get("kind") or res["outcome"]
        self.metrics.outcomes[f"{res['outcome']}:{reason}"] += 1
        return res

    def _apply_decision(self, req: BookingRequest,
                        dec: BookingDecision) -> dict:
        m = self.metrics
        if dec.kind is DecisionKind.REJECT:
            m.n_rejected += 1
            return {"outcome": "rejected", "reason": dec.note or "policy"}

        if dec.kind is DecisionKind.ALT_HUB:
            if not req.alt_options:
                m.n_rejected += 1
                return {"outcome": "rejected", "reason": "no_alt_hub"}
            opt = req.alt_options[min(dec.option_idx,
                                      len(req.alt_options) - 1)]
            price = round(self.quote(req, opt) * (1 - dec.discount_pct), 2)
            m.n_countered += 1
            if self.feasible(req, opt) \
                    and self._customer_accepts(price, req, True):
                m.n_counter_won += 1
                self._book(req, opt, price, req.teu, req.weight_t, "alt_hub")
                return {"outcome": "booked", "kind": "alt_hub", "price": price}
            m.n_rejected += 1
            return {"outcome": "counter_declined", "kind": "alt_hub"}

        if not req.options:
            m.n_rejected += 1
            return {"outcome": "rejected", "reason": "no_voyage_option"}

        if dec.kind is DecisionKind.SPLIT:
            return self._apply_split(req, dec)

        # ACCEPT / FLEX_WINDOW both pick from req.options
        idx = min(dec.option_idx, len(req.options) - 1)
        opt = req.options[idx]
        is_flex = dec.kind is DecisionKind.FLEX_WINDOW
        if dec.kind is DecisionKind.ACCEPT and not opt.within_flex:
            m.n_rejected += 1
            return {"outcome": "rejected",
                    "reason": "departure_outside_flex"}
        price = self.quote(req, opt)
        if is_flex:
            price = round(price * (1 - dec.discount_pct), 2)
            m.n_countered += 1
        if not self.feasible(req, opt):
            m.n_rejected += 1
            return {"outcome": "rejected", "reason": "infeasible"}
        if not self._customer_accepts(price, req, is_flex):
            m.n_rejected += 1
            return {"outcome": "declined" if is_flex else "price_reject",
                    "quoted": price, "wtp": round(req.wtp_per_teu, 2)}
        if is_flex:
            m.n_counter_won += 1
        else:
            m.n_accepted += 1
        self._book(req, opt, price, req.teu, req.weight_t,
                   "flex_window" if is_flex else "accept")
        return {"outcome": "booked", "kind": dec.kind.value, "price": price}

    def _apply_split(self, req: BookingRequest, dec: BookingDecision) -> dict:
        m = self.metrics
        if len(req.options) < 2:
            m.n_rejected += 1
            return {"outcome": "rejected", "reason": "no_second_option"}
        a, b = req.options[dec.option_idx], req.options[dec.second_idx]
        teu_a = max(1, int(round(req.teu * dec.split_frac)))
        teu_b = req.teu - teu_a
        w_a = req.weight_t * teu_a / req.teu
        w_b = req.weight_t - w_a
        price = round(self.quote(req, a) * (1 - dec.discount_pct), 2)
        m.n_countered += 1
        fits = (self.feasible(req, a, teu_a, w_a)
                and self.feasible(req, b, teu_b, w_b))
        if fits and self._customer_accepts(price, req, True):
            m.n_counter_won += 1
            self._book(req, a, price, teu_a, w_a, "split")
            self._book(req, b, price, teu_b, w_b, "split")
            return {"outcome": "booked", "kind": "split", "price": price}
        m.n_rejected += 1
        return {"outcome": "counter_declined", "kind": "split"}

    # ------------------------------------------------------------------
    # Fleet actions
    # ------------------------------------------------------------------

    def apply_fleet_action(self, act: FleetAction) -> dict:
        if act.kind == "set_speed" and act.vessel_id in self.vessels:
            v = self.vessels[act.vessel_id]
            v.speed_kt = float(np.clip(act.speed_kt or v.speed_kt,
                                       v.spec.min_speed_kt,
                                       v.spec.max_speed_kt))
            return {"ok": True, "speed": v.speed_kt}
        if act.kind == "reposition" and act.teu > 0:
            return self._reposition(act)
        return {"ok": False}

    def can_reposition(self, src: str, dst: str, teu: float) -> bool:
        """Feasibility check mirroring _reposition: enough empties at src and
        a capacity-clearing own voyage covering src->dst within 21 days."""
        if self.empties.get(src, 0) < teu:
            return False
        for v in self.vessels.values():
            for call in v.upcoming_calls(src, self.day, self.day + 21):
                dc = v.next_call_at(call.idx, dst)
                if dc is None:
                    continue
                legs = v.legs_between(call.idx, dc.idx)
                if v.has_capacity(legs, teu, teu * 4.0, False):
                    return True
        return False

    def _reposition(self, act: FleetAction) -> dict:
        src, dst, teu = act.port_from, act.port_to, act.teu
        if src not in self.empties or self.empties[src] < teu:
            return {"ok": False, "reason": "insufficient_empties"}
        # find the next own departure from src that reaches dst
        best = None
        for v in self.vessels.values():
            for call in v.upcoming_calls(src, self.day, self.day + 21):
                dc = v.next_call_at(call.idx, dst)
                if dc is None:
                    continue
                if best is None or call.planned_etd < best[1].planned_etd:
                    best = (v, call, dc)
        if best is None:
            return {"ok": False, "reason": "no_voyage"}
        v, call, dc = best
        legs = v.legs_between(call.idx, dc.idx)
        if not v.has_capacity(legs, teu, teu * 4.0, False):
            return {"ok": False, "reason": "capacity"}
        v.consume(legs, teu, teu * 4.0, False)
        self.empties[src] -= teu
        self.repos_out[v.spec.vessel_id].setdefault(call.idx, []).append(
            (teu, dc.idx))
        self.metrics.reposition_cost += REPO_COST_PER_TEU * teu
        self.metrics.repositioned_teu += teu
        return {"ok": True, "vessel": v.spec.vessel_id,
                "dep_day": call.planned_etd}

    # ------------------------------------------------------------------
    # End-of-day dynamics
    # ------------------------------------------------------------------

    def _route_idx(self, o: str, d: str) -> int | None:
        return D.ROUTE_ID_OF.get(f"{o}>{d}")

    def _leg_disruption(self, o: str, d: str) -> tuple[str, float]:
        r = self._route_idx(o, d)
        if r is None:
            return "none", 0.0
        w = min(int(self.day // 7), self.horizon_weeks - 1)
        return self.disruption[r][w], self.disruption_delay[r][w]

    def _depart(self, v: VesselState, call_idx: int) -> None:
        call = v.calls[call_idx]
        nxt = v.calls[call_idx + 1]
        # load waiting cargo: consume empties or lease
        loaded = 0
        for bk in self.waiting[v.spec.vessel_id].pop(call_idx, []):
            take = min(self.empties[call.port], bk["teu"])
            self.empties[call.port] -= take
            short = bk["teu"] - take
            if short > 0:
                self.metrics.leased_containers += short
                self.metrics.lease_cost += LEASE_COST_PER_TEU * short
            loaded += bk["teu"]
        v.onboard_teu += loaded
        # load repositioned empties committed for this call
        for teu, dc_idx in self.repos_out[v.spec.vessel_id].pop(call_idx, []):
            v.empty_aboard += teu
            self.repos_in[v.spec.vessel_id].setdefault(dc_idx, []).append(teu)
        self.metrics.port_fees += PORT_CALL_FEE + HANDLE_PER_TEU * loaded

        # leg duration with disruptions
        dtype, _ = self._leg_disruption(call.port, nxt.port)
        days = v.eta_days(call_idx, v.speed_kt)
        days *= DISRUPTION_LEG_MULT.get(dtype, 1.0)
        v.mode = SEA
        v.at_call_idx = call_idx
        v.sailing_to_call = call_idx + 1
        v.leg_start_day = self.day
        v.leg_end_day = self.day + days
        v.next_event_day = v.leg_end_day

    def _arrive(self, v: VesselState) -> None:
        arr_idx = v.sailing_to_call
        port = v.calls[arr_idx].port
        leg = v.calls[arr_idx - 1]
        dist = leg.leg_distance_nm

        laden = v.onboard_teu
        self.metrics.teu_nm_carried += laden * dist
        self.metrics.capacity_nm += v.own_lift_teu * dist
        self.metrics.empty_teu_nm += v.empty_aboard * dist

        # destination wait: congestion + disruption + closure
        day_i = int(min(self.day, len(self.port_wait[port]) - 1))
        wait_d = self.port_wait[port][day_i] / 24.0
        dtype, extra = self._leg_disruption(leg.port, port)
        if dtype in DISRUPTION_WAIT:
            wait_d += float(self.rng.uniform(*DISRUPTION_WAIT[dtype]))
        if self.port_closed[port][day_i]:
            reopen = day_i
            while reopen < len(self.port_closed[port]) \
                    and self.port_closed[port][reopen]:
                reopen += 1
            wait_d += max(0.5, reopen - day_i)
        if wait_d > DEMURRAGE_FREE_DAYS:
            self.metrics.demurrage_cost += C.DEMURRAGE_USD_PER_DAY \
                * (wait_d - DEMURRAGE_FREE_DAYS)

        # discharge: laden containers bound here become empties at this port
        n_out = v.stowage.discharge_through(arr_idx)
        v.onboard_teu = max(0, v.onboard_teu - n_out)
        self.empties[port] += n_out
        # repositioned empties land here
        for teu in self.repos_in[v.spec.vessel_id].pop(arr_idx, []):
            self.empties[port] += teu
            v.empty_aboard = max(0, v.empty_aboard - teu)

        self.metrics.port_fees += PORT_CALL_FEE + HANDLE_PER_TEU * n_out
        v.mode = PORT
        v.port = port
        v.at_call_idx = arr_idx
        dwell = v.port_dwell[port] + wait_d
        v.next_event_day = self.day + dwell

    def _step_vessels(self) -> None:
        for v in self.vessels.values():
            while v.next_event_day <= self.day + 1.0:
                if v.mode is SEA:
                    self._arrive(v)
                else:
                    call_idx = v.at_call_idx
                    if call_idx + 1 >= len(v.calls):
                        v.next_event_day = self.day + 2.0
                        break
                    # port closed -> departure slips a day
                    day_i = int(min(self.day, len(
                        self.port_closed[v.calls[call_idx].port]) - 1))
                    if self.port_closed[v.calls[call_idx].port][day_i]:
                        v.next_event_day += 1.0
                        continue
                    self._depart(v, call_idx)

    def _step_economics(self) -> None:
        fuel_p = self.demand.fuel_price(self.day)
        ets_p = self.demand.ets_price(self.day) * 1.08   # EUR->USD ~1.08
        for v in self.vessels.values():
            at_sea = v.mode is SEA
            fuel = v.fuel_tpd(at_sea)
            self.metrics.fuel_tonnes += fuel
            self.metrics.fuel_cost += fuel * fuel_p
            co2 = fuel * C.CO2_PER_TONNE_FUEL
            self.metrics.co2_tonnes += co2
            # EU ETS: 100% intra-EU, 50% for voyages with one EU endpoint
            if at_sea:
                a = v.calls[v.at_call_idx].port
                b = v.calls[v.sailing_to_call].port
                eu = (a in EU_PORTS) + (b in EU_PORTS)
                if eu:
                    self.metrics.carbon_cost += co2 * ets_p * (0.5 * eu)

    def end_day(self) -> None:
        self._step_vessels()
        self._step_economics()
        self.day += 1.0
        if self.day >= self.config.horizon_days:
            self.done = True

    # ------------------------------------------------------------------
    # Convenience driver
    # ------------------------------------------------------------------

    def run(self, policy) -> dict:
        self.reset()
        while not self.done:
            for req in self.begin_day():
                dec = policy.decide_booking(req, self)
                self.apply_decision(req, dec)
            if self.config.fleet_actions \
                    and int(self.day) % self.config.fleet_every == 0:
                for act in policy.decide_fleet(self):
                    self.apply_fleet_action(act)
            self.end_day()
        return self.metrics.report()
