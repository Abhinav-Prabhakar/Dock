"""Shared fixtures + path setup. Tests run from backend/ (pytest backend/tests)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from data.calibration import ALT_HUB  # noqa: E402
from simulator import SimConfig, Simulator  # noqa: E402
from simulator.types import (BookingRequest, CargoType, Segment,  # noqa: E402
                             VoyageOption)


@pytest.fixture
def sim() -> Simulator:
    """A reset 45-day simulator on the baseline scenario."""
    s = Simulator(SimConfig(scenario="baseline", horizon_days=45, seed=3,
                            start_week=10))
    s.reset()
    return s


def make_request(origin="CNSHA", dest="NLRTM", teu=5, weight_t=60.0,
                 cargo_type=CargoType.DRY, segment=Segment.STANDARD,
                 wtp=2500.0, market=1800.0, dep_day=20.0, flex=2) -> BookingRequest:
    return BookingRequest(
        request_id=999999, day=dep_day - 10, origin=origin, dest=dest,
        teu=teu, weight_t=weight_t, cargo_type=cargo_type, segment=segment,
        wtp_per_teu=wtp, market_rate=market, req_dep_day=dep_day,
        flex_days=flex)


def first_option(sim: Simulator, req: BookingRequest) -> VoyageOption | None:
    """Populate req.options (and alt_options) like begin_day does; return
    the closest option or None."""
    req.options = sim._options_for(req, req.dest)
    alt = ALT_HUB.get(req.dest)
    if alt:
        req.alt_dest = alt
        req.alt_options = sim._options_for(req, alt)
    return req.options[0] if req.options else None


def anchored_request(sim: Simulator, origin="CNSHA", dest="NLRTM",
                     **kw) -> BookingRequest:
    """A request whose requested departure is a real upcoming sailing, so
    `_options_for` returns candidates (mirrors how DemandStream anchors
    req_dep_day to the fleet schedule)."""
    deps = sim.sailings.get((origin, dest))
    assert deps is not None and len(deps), f"no sailings for {origin}>{dest}"
    future = deps[deps > sim.day + 2.0]
    dep_day = float(future[0]) if len(future) else float(deps[-1])
    kw.setdefault("dep_day", dep_day)
    return make_request(origin=origin, dest=dest, **kw)
