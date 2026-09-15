"""Event bus + request_id propagation through the cargo pipeline.

The settlement layer subscribes to ``sim.events`` and must be able to link
every delivered consignment back to a real departure and the booking
decision that created it — via ``request_id``.
"""

from __future__ import annotations

import pytest

from baselines import DynamicHeuristicPolicy
from simulator import SimConfig, Simulator

from conftest import stub_forecaster


@pytest.fixture
def sim() -> Simulator:
    s = Simulator(SimConfig(scenario="baseline", horizon_days=45, seed=3,
                            start_week=10, forecaster=stub_forecaster()))
    s.reset()
    return s


def test_full_episode_event_linkage(sim):
    """booking.decision -> departure.confirmed -> delivery.confirmed all
    carry the same request_id, in that order."""
    evts: list[dict] = []
    sim.events.append(evts.append)
    sim.run(DynamicHeuristicPolicy())

    decisions = [e for e in evts if e["type"] == "booking.decision"]
    departures = [e for e in evts if e["type"] == "departure.confirmed"]
    deliveries = [e for e in evts if e["type"] == "delivery.confirmed"]

    assert decisions, "no booking.decision events emitted"
    assert departures, "no departure.confirmed events emitted"
    assert deliveries, "no delivery.confirmed events emitted"

    # linkage: every delivered request_id was previously seen departing
    # and previously decided upon — in event order.
    for i, e in enumerate(evts):
        if e["type"] != "delivery.confirmed":
            continue
        rid = e["request_id"]
        prior = evts[:i]
        assert any(p["type"] == "departure.confirmed"
                   and p["request_id"] == rid for p in prior), \
            f"delivered request {rid} never departed"
        assert any(p["type"] == "booking.decision"
                   and p["request_id"] == rid for p in prior), \
            f"delivered request {rid} has no booking.decision"

    # and every departed booking traces back to a booked decision
    booked_rids = {e["request_id"] for e in decisions
                   if e["outcome"] == "booked"}
    for e in departures:
        assert e["request_id"] in booked_rids


def test_day_summary_events(sim):
    evts: list[dict] = []
    sim.events.append(evts.append)
    sim.run(DynamicHeuristicPolicy())
    summaries = [e for e in evts if e["type"] == "day.summary"]
    assert len(summaries) == sim.config.horizon_days
    last = summaries[-1]
    assert last["day"] == float(sim.config.horizon_days)
    assert last["cum_revenue"] == pytest.approx(sim.metrics.revenue)
    assert last["teu_booked"] == pytest.approx(sim.metrics.teu_booked)


def test_waiting_entries_carry_request_id(sim):
    pol = DynamicHeuristicPolicy()
    for _ in range(10):
        for req in sim.begin_day():
            sim.apply_decision(req, pol.decide_booking(req, sim))
        sim.end_day()
    entries = [bk for by_call in sim.waiting.values()
               for lst in by_call.values() for bk in lst]
    assert entries, "no bookings waiting after 10 days"
    for bk in entries:
        assert "request_id" in bk
        assert bk["kind"] in ("accept", "flex_window", "alt_hub", "split")


def test_no_subscribers_runs_clean(sim):
    """Emit is a no-op with an empty subscriber list — full episode runs."""
    assert sim.events == []
    rep = sim.run(DynamicHeuristicPolicy())
    assert rep["requests"] > 0
    assert sim.done


def test_emit_sets_day(sim):
    evts: list[dict] = []
    sim.events.append(evts.append)
    sim.day = 12.5
    sim.emit("custom.ping", foo=1)
    assert evts == [{"type": "custom.ping", "day": 12.5, "foo": 1}]
    # empty subscriber list -> silent no-op
    sim.events.clear()
    sim.emit("custom.ping", foo=2)
    assert len(evts) == 1


def test_aboard_bookkeeping(sim):
    """Aboard cargo drains on delivery; anything still aboard at horizon
    end is bound for a call the vessel has not reached yet."""
    evts: list[dict] = []
    sim.events.append(evts.append)
    sim.run(DynamicHeuristicPolicy())

    # splits share a request_id, so compare event counts, not membership
    from collections import Counter
    dep_count = Counter(e["request_id"] for e in evts
                        if e["type"] == "departure.confirmed")
    del_count = Counter(e["request_id"] for e in evts
                        if e["type"] == "delivery.confirmed")
    remaining = 0
    for vid, by_dest in sim.aboard.items():
        v = sim.vessels[vid]
        for dest_call, bks in by_dest.items():
            assert bks, "empty aboard list left behind"
            assert dest_call < len(v.calls)
            # vessel has not arrived at dest_call yet (PORT or SEA mode
            # both leave at_call_idx at the last reached/departed call)
            assert dest_call > v.at_call_idx
            for bk in bks:
                remaining += 1
                # still-aboard cargo departed but is not fully delivered
                assert dep_count[bk["request_id"]] \
                    > del_count[bk["request_id"]]
    # sanity: cargo that departed mostly delivers within a 45-day horizon
    assert del_count or sum(dep_count.values()) == 0
    assert remaining <= sum(dep_count.values()) - sum(del_count.values())
