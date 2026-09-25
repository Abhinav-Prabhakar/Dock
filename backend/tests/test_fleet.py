"""Vessel schedule + per-leg capacity ledger tests."""

from __future__ import annotations

import numpy as np

from data import calibration as C
from simulator.fleet import VesselSpec, VesselState


def make_vessel(vid="VES1", horizon=120.0, phase=0.0) -> VesselState:
    row = next(v for v in C.VESSELS if v[0] == vid)
    (_vid, name, cap, reefer, vmin, vserv, vmax, age, draft, burn) = row
    spec = VesselSpec(vid, cap, reefer, vmin, vserv, vmax,
                      0.15 * burn, (burn - 0.15 * burn) / vserv ** 3,
                      age, C.VESSEL_LOOPS[vid])
    dwell = {p[0]: p[8] for p in C.PORTS}
    return VesselState(spec, horizon, phase, dwell)


class TestSchedule:
    def test_calls_cover_horizon(self):
        v = make_vessel(horizon=120.0)
        assert v.calls[-1].planned_etd > 120.0
        assert len(v.calls) > 5

    def test_call_ports_follow_loop(self):
        v = make_vessel()
        loop = v.loop
        for i, call in enumerate(v.calls):
            assert call.port == loop[i % len(loop)]

    def test_leg_distance_matches_calibration(self):
        v = make_vessel("VES1")
        c = v.calls[0]
        assert c.port == "CNSHA"
        assert c.leg_distance_nm == C.DISTANCES_NM[("CNSHA", "SGSIN")]

    def test_eta_days(self):
        v = make_vessel("VES1")
        expected = v.calls[0].leg_distance_nm / (v.spec.service_speed_kt * 24)
        assert v.eta_days(0, v.spec.service_speed_kt) == expected
        # slower speed -> longer leg
        assert v.eta_days(0, 12.0) > v.eta_days(0, 16.0)


class TestCapacity:
    def test_leg_cap_initialized_to_own_lift(self):
        v = make_vessel("VES4")                    # 2500 TEU
        cap = v.leg_cap(3)
        expected = 2500 * C.OWN_LIFT_SHARE * (1 - C.STOWAGE_BUFFER)
        assert cap.teu == expected

    def test_consume_and_has_capacity(self):
        v = make_vessel()
        legs = v.legs_between(0, 2)
        assert v.has_capacity(legs, 100, 500, False)
        v.consume(legs, 100, 500, False)
        assert v.leg_cap(0).teu == v.own_lift_teu - 100
        # both legs consumed
        assert v.leg_cap(1).teu == v.own_lift_teu - 100
        assert not v.has_capacity(legs, v.own_lift_teu, 1e6, False)

    def test_reefer_subcapacity(self):
        v = make_vessel()
        legs = v.legs_between(0, 1)
        reefer_cap = v.leg_cap(legs[0]).reefer
        assert v.has_capacity(legs, reefer_cap, reefer_cap * 10.0, True)
        v.consume(legs, reefer_cap, reefer_cap * 10.0, True)
        assert not v.has_capacity(legs, 1, 10, True)
        assert v.has_capacity(legs, 1, 10, False)   # dry still fine


class TestQueries:
    def test_upcoming_calls_window(self):
        v = make_vessel()
        calls = v.upcoming_calls("CNSHA", 0, 40)
        assert calls and all(c.port == "CNSHA" for c in calls)
        assert all(0 <= c.planned_etd <= 40 for c in calls)

    def test_next_call_at(self):
        v = make_vessel("VES1")
        dep = v.calls[0]                            # CNSHA
        dc = v.next_call_at(0, "NLRTM")
        assert dc is not None and dc.idx > 0
        assert dc.port == "NLRTM"
        # no such port on this loop
        assert v.next_call_at(0, "USLAX") is None
