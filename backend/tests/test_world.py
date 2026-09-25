"""Simulator world: determinism, decision handling, economics, disruptions."""

from __future__ import annotations

import numpy as np
import pytest

from baselines import (DynamicHeuristicPolicy, GreedyPolicy,
                       StaticRateCardPolicy)
from data import calibration as C
from simulator import SimConfig, Simulator
from simulator.types import (BookingDecision, BookingRequest, CargoType,
                             DecisionKind, FleetAction, Segment)

from conftest import anchored_request, first_option, make_request


def run_episode(policy, scenario="baseline", days=45, seed=3,
                start_week=10) -> tuple[dict, Simulator]:
    cfg = SimConfig(scenario=scenario, horizon_days=days, seed=seed,
                    start_week=start_week,
                    pricing=getattr(policy, "pricing_mode", "dynamic"))
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
        rep, _ = run_episode(DynamicHeuristicPolicy(), seed=31)
        assert rep["reject_to_counter_conv"] > 0
        stat, _ = run_episode(StaticRateCardPolicy(), seed=31)
        assert stat["countered"] == 0
