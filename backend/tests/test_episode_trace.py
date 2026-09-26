"""``EpisodeManager._record_trace`` must find a decision's outcome (and its
on-chain deal, if any) by ``request_id`` directly, not by scanning a fixed
window of recent events — a burst of same-step day-boundary events
(departures/deliveries/day.summary) can otherwise push the decision past a
short lookback and the trace would wrongly show no outcome for a real
booking (surfaced live: decisions 4943/5031 in the integration branch).
"""

from __future__ import annotations

from server.episodes import Episode, EpisodeManager
from simulator.types import BookingRequest, CargoType, Segment


def _req(request_id: int) -> BookingRequest:
    return BookingRequest(
        request_id=request_id, day=5.0, origin="CNSHA", dest="NLRTM",
        teu=4, weight_t=40.0, cargo_type=CargoType.DRY,
        segment=Segment.STANDARD, wtp_per_teu=900.0, market_rate=800.0,
        req_dep_day=8.0, flex_days=3)


def test_record_trace_finds_outcome_and_deal_past_a_long_event_burst():
    ep = Episode(policy="ppo", scenario="baseline", seed=1,
                 horizon_days=1, speed_days_per_sec=1.0)

    # the booking decision + its on-chain deal, emitted synchronously as
    # they would be inside env.step (via Episode.emit -> _ingest -> _handle_event)
    ep._handle_event({"type": "booking.decision", "request_id": 42,
                      "outcome": "booked", "kind": "flex_window",
                      "price": 950.0, "reason": "customer_accepted",
                      "seq": 1, "hash": "h1", "prev_hash": "h0"})
    ep._handle_event({"type": "settlement.deal_registered", "request_id": 42,
                      "deal_id": "D1", "kind": "flex_window",
                      "tx_hash": "0xabc", "contract": "0xdef", "terms": {}})

    # a burst of >12 unrelated events, as would happen at a day boundary
    for i in range(20):
        ep._handle_event({"type": "day.summary", "day": float(i)})

    EpisodeManager._record_trace(ep, {}, _req(42), False, None)

    trace = ep.trace[-1]
    assert trace["outcome"]["outcome"] == "booked"
    assert trace["outcome"]["kind"] == "flex_window"
    assert trace["outcome"]["deal"]["deal_id"] == "D1"
    assert trace["outcome"]["deal"]["tx_hash"] == "0xabc"

    # consumed once, so a second decision for the same request_id (a fresh
    # booking after the first was fully resolved) doesn't inherit the outcome
    EpisodeManager._record_trace(ep, {}, _req(42), False, None)
    assert ep.trace[-1]["outcome"] is None


def test_record_trace_leaves_pending_decisions_unmatched():
    """A booking step whose outcome hasn't arrived yet (or never will, e.g.
    it was a fleet-step lookup) gets outcome=None, not a stale match."""
    ep = Episode(policy="ppo", scenario="baseline", seed=1,
                 horizon_days=1, speed_days_per_sec=1.0)
    EpisodeManager._record_trace(ep, {}, _req(7), False, None)
    assert ep.trace[-1]["outcome"] is None
