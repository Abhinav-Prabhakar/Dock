"""Simulator world: determinism, decision handling, economics, disruptions."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from baselines import (DynamicHeuristicPolicy, GreedyPolicy,
                       StaticRateCardPolicy)
from data import calibration as C
from data import demand as D
from pricing import BidPriceEngine
from simulator import SimConfig, Simulator
from simulator.types import (BookingDecision, BookingRequest, CargoType,
                             DecisionKind, FleetAction, Segment)

from conftest import (anchored_request, first_option, make_request,
                      stub_forecaster)


def run_episode(policy, scenario="baseline", days=45, seed=3,
                start_week=10, forecaster=None) -> tuple[dict, Simulator]:
    cfg = SimConfig(scenario=scenario, horizon_days=days, seed=seed,
                    start_week=start_week,
                    pricing=getattr(policy, "pricing_mode", "dynamic"),
                    forecaster=forecaster or stub_forecaster())
    sim = Simulator(cfg)
    return sim.run(policy), sim


class TestDeterminism:
    def test_same_seed_same_requests(self):
        a = Simulator(SimConfig(horizon_days=30, seed=11, start_week=10))
        b = Simulator(SimConfig(horizon_days=30, seed=11, start_week=10))
        a.reset(); b.reset()
        ra = a.begin_day(); rb = b.begin_day()
        assert len(ra) == len(rb)
        for x, y in zip(ra, rb):
            assert (x.origin, x.dest, x.teu, x.wtp_per_teu) == \
                   (y.origin, y.dest, y.teu, y.wtp_per_teu)

    def test_different_seed_differs(self):
        a = Simulator(SimConfig(horizon_days=30, seed=11, start_week=10))
        b = Simulator(SimConfig(horizon_days=30, seed=12, start_week=10))
        a.reset(); b.reset()
        ra, rb = a.begin_day(), b.begin_day()
        sig_a = [(r.origin, r.teu, r.wtp_per_teu) for r in ra]
        sig_b = [(r.origin, r.teu, r.wtp_per_teu) for r in rb]
        assert sig_a != sig_b

    def test_same_seed_same_episode_result(self):
        rep_a, _ = run_episode(GreedyPolicy(), seed=21)
        rep_b, _ = run_episode(GreedyPolicy(), seed=21)
        assert rep_a["profit_usd"] == rep_b["profit_usd"]
        assert rep_a["requests"] == rep_b["requests"]


class TestEpisodeSanity:
    def test_episode_completes_and_metrics_exist(self):
        rep, sim = run_episode(GreedyPolicy())
        assert sim.done
        assert rep["requests"] > 0
        assert rep["revenue_usd"] > 0
        assert rep["fuel_tonnes"] > 0
        # outcomes sum to total requests
        assert sum(rep["outcomes"].values()) == rep["requests"]

    def test_vessels_actually_move(self):
        _, sim = run_episode(GreedyPolicy())
        for v in sim.vessels.values():
            assert v.at_call_idx > 0          # made progress on the loop

    def test_adversarial_scenario_runs(self):
        rep, _ = run_episode(DynamicHeuristicPolicy(),
                             scenario="adversarial-perfect-storm", days=40,
                             start_week=50)
        assert rep["requests"] > 0            # survived the worst case


class TestBookingDecisions:
    def test_accept_consumes_capacity_and_books_revenue(self, sim):
        req = anchored_request(sim, wtp=1e9)   # price never declines
        opt = first_option(sim, req)
        assert opt is not None
        v = sim.vessels[opt.vessel_id]
        before = v.leg_cap(opt.legs[0]).teu
        res = sim.apply_decision(req, BookingDecision(DecisionKind.ACCEPT,
                                                      option_idx=0))
        if res["outcome"] == "booked":
            assert v.leg_cap(opt.legs[0]).teu == before - req.teu
            assert sim.metrics.revenue > 0
        else:                                # customer declined the quote
            assert res["outcome"] == "price_reject"
            assert v.leg_cap(opt.legs[0]).teu == before

    def test_reject_consumes_nothing(self, sim):
        req = anchored_request(sim)
        opt = first_option(sim, req)
        assert opt is not None
        v = sim.vessels[opt.vessel_id]
        before = v.leg_cap(opt.legs[0]).teu
        sim.apply_decision(req, BookingDecision(DecisionKind.REJECT))
        assert v.leg_cap(opt.legs[0]).teu == before
        assert sim.metrics.revenue == 0

    def test_infeasible_when_oversized(self, sim):
        req = anchored_request(sim, teu=10**6, weight_t=10**6)
        opt = first_option(sim, req)
        assert opt is not None
        res = sim.apply_decision(req, BookingDecision(DecisionKind.ACCEPT,
                                                      option_idx=0))
        assert res["outcome"] == "rejected"

    def test_alt_hub_requires_alt_options(self, sim):
        req = make_request(dest="USNYC")      # no alt hub mapping
        req.alt_options = []
        res = sim.apply_decision(req, BookingDecision(DecisionKind.ALT_HUB))
        assert res["outcome"] == "rejected"
        assert res["reason"] == "no_alt_hub"

    def test_counter_offers_can_win(self):
        # many attempts across an episode -> some counters should convert
        rep, _ = run_episode(DynamicHeuristicPolicy())
        assert rep["countered"] > 0
        assert rep["counter_win_rate"] > 0


class TestPricing:
    def test_rate_card_is_flat(self):
        cfg = SimConfig(horizon_days=30, seed=1, start_week=10,
                        pricing="rate_card")
        sim = Simulator(cfg)
        sim.reset()
        req = make_request(origin="CNSHA", dest="NLRTM")
        opt = first_option(sim, req)
        q = sim.quote(req, opt)
        assert q == 1780.0                   # calibration route rate

    def test_dynamic_quote_tracks_market(self, sim):
        req = anchored_request(sim, market=2000.0)
        opt = first_option(sim, req)
        assert opt is not None
        q = sim.quote(req, opt)
        assert 0.7 * req.market_rate < q < 3.0 * req.market_rate


class TestOptionWindow:
    """req_dep_day is a jittered observation of a real sailing date
    (DemandStream anchors it then adds N(0,1.2)), so the option search
    window must tolerate jitter in both directions — see JITTER_TOL_D."""

    def test_positive_jitter_flex0_finds_anchored_sailing(self, sim):
        # A request anchored 1-2 days AFTER a real sailing with flex_days=0
        # must still see that sailing (it is the one the customer meant).
        # Regresses on: lo = req_dep_day - flex_days.
        found = False
        for (o, d), deps in sim.sailings.items():
            future = deps[deps > sim.day + 2.0]
            if not len(future):
                continue
            dep = float(future[0])
            req = make_request(origin=o, dest=d, dep_day=dep + 1.5, flex=0)
            opts = sim._options_for(req, d)
            hit = [op for op in opts if abs(op.board_day - dep) < 1e-9]
            if hit:
                assert hit[0].within_flex
                found = True
                break
        assert found, "no OD exercised the jittered-anchor case"

    def test_no_self_pair_sailings(self, sim):
        # Loops that visit a port twice must not produce (p, p) entries.
        assert all(o != d for (o, d) in sim.sailings)


class TestBidPriceProration:
    """An OD market rate pays for the whole journey, so each leg may only
    claim its mileage share — otherwise summing leg bids over a k-leg
    itinerary counts the fare k times (see bid_price.refresh())."""

    def _ratios_by_legcount(self):
        cfg = SimConfig(scenario="baseline", horizon_days=45, seed=3,
                        start_week=10, pricing="bid_price",
                        forecaster=stub_forecaster())
        sim = Simulator(cfg)
        sim.reset()
        eng = sim.pricer
        route_rate = {(o, d): float(rate)
                      for (o, d, _b, rate, _l, _dir) in C.ROUTES}
        ratios: dict[int, list[float]] = {2: [], 3: []}
        for (o, d), deps in sim.sailings.items():
            if (o, d) not in route_rate:
                continue
            for dep in deps:
                if dep <= sim.day + 2.0:
                    continue
                req = make_request(origin=o, dest=d, dep_day=float(dep),
                                   flex=2, market=route_rate[(o, d)])
                for opt in sim._options_for(req, d):
                    if len(opt.legs) in ratios:
                        ratios[len(opt.legs)].append(
                            eng.option_bid(opt) / req.market_rate)
        return ratios

    def test_option_bid_does_not_scale_with_legs(self):
        ratios = self._ratios_by_legcount()
        assert len(ratios[2]) >= 5 and len(ratios[3]) >= 5
        med2, med3 = np.median(ratios[2]), np.median(ratios[3])
        assert med2 < 1.6 and med3 < 1.6
        # opportunity cost must not grow materially with leg count
        # (pre-proration medians were ~2.0 / ~3.0 for 2/3 legs)
        assert med3 <= med2 + 0.4


class TestForecasterContract:
    """The bid-price engine runs on the bound demand forecaster — never on
    the simulator's ground-truth intensity (technical.md §3.1)."""

    def test_bid_price_without_forecaster_raises(self):
        cfg = SimConfig(pricing="bid_price", forecaster=None,
                        forecaster_path="/nonexistent-dir",
                        scenario="baseline", horizon_days=10, seed=1,
                        start_week=10)
        with pytest.raises(RuntimeError, match="DemandForecaster|forecaster"):
            Simulator(cfg).reset()

    def test_no_oracle_demand_path(self):
        """The whole pricing surface must run without sim.demand.lam —
        lam is DemandStream's own generative state, so deleting it scopes
        this test to the pricing/obs consumers, not request sampling."""
        sim = Simulator(SimConfig(
            scenario="baseline", horizon_days=14, seed=3, start_week=10,
            pricing="bid_price", forecaster=stub_forecaster()))
        sim.reset()
        eng = sim.pricer
        assert eng is not None
        assert not hasattr(eng, "_oracle_demand")
        req = anchored_request(sim)
        opt = first_option(sim, req)
        assert opt is not None
        del sim.demand.lam
        eng.refresh()
        assert eng.leg_bid(opt.vessel_id, opt.legs[0]) > 0
        assert eng.option_bid(opt) > 0
        assert eng.quote(req, opt).price > 0
        assert eng.counter_discount(req, opt) is not None
        assert eng.network_value() >= 0
        assert eng.mean_pressure() >= 0
        ex = eng.explain(req, opt)
        assert ex["legs"] and ex["quote_per_teu"] > 0

    def test_obs_teu_tracks_requests(self, sim):
        """obs_teu accumulates realized request intensity per (route, week)
        — request counts x MEAN_TEU_PER_BOOKING, the lam-unit observation
        the forecaster is trained on."""
        per_route = np.zeros(len(D.ROUTE_KEYS))
        for _ in range(3):                  # days 0-2 all land in week 0
            reqs = sim.begin_day()
            for req in reqs:
                r = D.ROUTE_ID_OF.get(f"{req.origin}>{req.dest}")
                if r is not None:
                    per_route[r] += C.MEAN_TEU_PER_BOOKING
            np.testing.assert_array_equal(sim.obs_teu[:, 0], per_route)
            assert sim.obs_teu[:, 1:].sum() == 0.0
            assert sim.obs_teu.sum() == per_route.sum()
            sim.end_day()


class TestNegotiation:
    """DynamicHeuristicPolicy's counter-offer layer (technical.md §1.3):
    proactive bid-justified discounts on accept, blocker-ordered counters
    on reject — SPLIT only ever last."""

    def _out_of_flex_reject(self, sim) -> BookingRequest:
        """A request greedy must reject (in-flex option 'full') while a
        feasible out-of-flex option and a second option exist — the case
        where the old code led with SPLIT."""
        for (o, d), deps in sim.sailings.items():
            for dep in deps:
                for shift in (0.0, 2.0, 4.0, 6.0, 8.0, 10.0):
                    req = make_request(origin=o, dest=d,
                                       dep_day=float(dep) + shift, flex=0)
                    opts = sim._options_for(req, d)
                    inflex = [op for op in opts if op.within_flex]
                    oof = [op for op in opts
                           if not op.within_flex and sim.feasible(req, op)]
                    if len(opts) >= 2 and inflex and oof:
                        for op in inflex:
                            op.capacity_ok = False      # sailed full
                        req.options = opts
                        return req
        pytest.fail("no OD produced the reject-counter case")

    def test_reject_counter_is_flex_not_split(self, sim):
        req = self._out_of_flex_reject(sim)
        dec = DynamicHeuristicPolicy().decide_booking(req, sim)
        assert dec.kind is DecisionKind.FLEX_WINDOW
        assert not req.options[dec.option_idx].within_flex
        assert dec.discount_pct > 0

    def test_reject_counter_works_without_engine(self, sim):
        # engine unavailable -> fixed discount tier, still never SPLIT first
        req = self._out_of_flex_reject(sim)
        pol = DynamicHeuristicPolicy()
        pol._engine = lambda s: None
        dec = pol.decide_booking(req, sim)
        assert dec.kind is DecisionKind.FLEX_WINDOW
        assert dec.discount_pct == pol.flex_discount

    def test_proactive_counter_fires_on_ev_gain(self, sim):
        # Full-price quote deep in the WTP tail + a materially cheaper-bid
        # alternative -> offer the discounted counter instead of ACCEPT.
        req = anchored_request(sim, origin="NLRTM", dest="SGSIN",
                               segment=Segment.FLEXIBLE, market=1000.0)
        req.options = sim._options_for(req, req.dest)
        assert len(req.options) >= 2
        sim.quote = lambda r, o: 1400.0 if o is req.options[0] else 1350.0
        eng = SimpleNamespace(
            counter_discount=lambda r, a, ref=None: (0.25, "stub"))
        dec = DynamicHeuristicPolicy()._maybe_counter(
            req, sim, BookingDecision(DecisionKind.ACCEPT, option_idx=0), eng)
        assert dec.kind is DecisionKind.FLEX_WINDOW
        assert dec.option_idx != 0
        assert dec.discount_pct == 0.25

    def test_proactive_counter_keeps_safe_accept(self, sim):
        # Same cheaper-bid alternative, but the quote is at market: the
        # accept is near-certain, so wagering it on counter_prob is -EV.
        req = anchored_request(sim, origin="NLRTM", dest="SGSIN",
                               segment=Segment.FLEXIBLE, market=1000.0)
        req.options = sim._options_for(req, req.dest)
        sim.quote = lambda r, o: 1000.0
        eng = SimpleNamespace(
            counter_discount=lambda r, a, ref=None: (0.25, "stub"))
        accept = BookingDecision(DecisionKind.ACCEPT, option_idx=0)
        dec = DynamicHeuristicPolicy()._maybe_counter(req, sim, accept, eng)
        assert dec is accept


class TestFleetActions:
    def test_set_speed_clamps(self, sim):
        sim.apply_fleet_action(FleetAction(kind="set_speed", vessel_id="VES1",
                                           speed_kt=99.0))
        assert sim.vessels["VES1"].speed_kt == sim.vessels[
            "VES1"].spec.max_speed_kt

    def test_reposition_moves_empties(self, sim):
        # find a real (src -> dst) pair the fleet covers departing within 21d
        pair = None
        for v in sim.vessels.values():
            for call in v.calls:
                if call.planned_etd > sim.day + 21:
                    break
                dc = None
                for j in range(call.idx + 1, len(v.calls)):
                    if v.calls[j].port != call.port:
                        dc = v.calls[j]
                        break
                if dc is not None:
                    pair = (call.port, dc.port)
                    break
            if pair:
                break
        assert pair is not None
        src, dst = pair
        sim.empties[src] = 1000.0
        res = sim.apply_fleet_action(FleetAction(
            kind="reposition", port_from=src, port_to=dst, teu=100))
        assert res["ok"]
        assert sim.empties[src] == 900.0
        assert sim.metrics.reposition_cost > 0

    def test_reposition_rejects_insufficient(self, sim):
        sim.empties["DEHAM"] = 10.0
        res = sim.apply_fleet_action(FleetAction(
            kind="reposition", port_from="DEHAM", port_to="CNSHA", teu=500))
        assert not res["ok"]


class TestPolicyComparison:
    """The core demo claim: dynamic policies beat the static baseline."""

    def test_heuristic_beats_static_profit(self):
        static_rep, _ = run_episode(StaticRateCardPolicy(), seed=31)
        heur_rep, _ = run_episode(DynamicHeuristicPolicy(), seed=31)
        assert heur_rep["profit_usd"] > static_rep["profit_usd"]

    def test_heuristic_converts_rejections(self):
        # counter conversion is rarer now that in-flex options are found
        # reliably (JITTER_TOL_D) — capacity is the binding constraint — but
        # it must still happen; the static baseline never counters at all.
        assert any(
            run_episode(DynamicHeuristicPolicy(), seed=s)[0]
            ["reject_to_counter_conv"] > 0
            for s in (3, 11, 31))
        stat, _ = run_episode(StaticRateCardPolicy(), seed=31)
        assert stat["countered"] == 0
