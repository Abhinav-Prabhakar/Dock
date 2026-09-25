"""Shared fixtures + path setup. Tests run from backend/ (pytest backend/tests)."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import numpy as np
import pytest

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

# --- Postgres for API tests -------------------------------------------------
# Tests never touch the dev database: they use '<name>_test' on the same
# server, rebuilt from the migrations every run. Set before anything imports
# server.db (which builds its engine from DATABASE_URL at import time).
_DB = urlsplit(os.environ.get(
    "DATABASE_URL", "postgresql+psycopg://dock:dockpw@localhost:5432/dock"))
_TEST_DB = _DB.path.lstrip("/")
if not _TEST_DB.endswith("_test"):
    _TEST_DB += "_test"
os.environ["DATABASE_URL"] = urlunsplit(_DB._replace(path=f"/{_TEST_DB}"))

# Episode ledgers go to a throwaway dir — backend/runs/ledger is tracked in git.
import tempfile  # noqa: E402
os.environ["DOCK_LEDGER_DIR"] = tempfile.mkdtemp(prefix="dock-ledger-")


@pytest.fixture(scope="session")
def migrated_db():
    """A fresh `<name>_test` database at `alembic head`. Walks the migrations
    down to base and back up each run, so a broken downgrade/upgrade fails
    here, not on someone's machine. No Postgres -> skip with instructions,
    unless DOCK_REQUIRE_DB=1 (CI), where it's a hard failure."""
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, text
    from sqlalchemy.exc import OperationalError

    admin = create_engine(urlunsplit(_DB._replace(path="/postgres")),
                          isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as cx:
            if not cx.execute(text("SELECT 1 FROM pg_database WHERE datname = :n"),
                              {"n": _TEST_DB}).scalar():
                cx.execute(text(f'CREATE DATABASE "{_TEST_DB}"'))
    except OperationalError as e:
        if os.environ.get("DOCK_REQUIRE_DB") == "1":
            raise
        pytest.skip(f"Postgres not reachable ({type(e).__name__}) — "
                    "start it with `docker compose up -d db`")
    finally:
        admin.dispose()

    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
    yield

from data.calibration import ALT_HUB  # noqa: E402
from simulator import SimConfig, Simulator  # noqa: E402
from simulator.types import (BookingRequest, CargoType, Segment,  # noqa: E402
                             VoyageOption)


class StubBoundForecaster:
    """Bound-forecaster test double (NOT the real model): flat demand,
    deterministic, and never touches the simulator's ground truth."""

    def daily(self, r, lo, hi):
        return 300.0

    def next_week(self):
        return np.full(18, 400.0)


class StubForecaster:
    """DemandForecaster test double: `bind` matches the real signature
    (Simulator calls it with start_week/horizon_weeks/observed/now kwargs)."""

    def bind(self, start_week, horizon_weeks, observed=None, now=None):
        return StubBoundForecaster()


def stub_forecaster() -> StubForecaster:
    """Fresh stub for non-fixture call sites."""
    return StubForecaster()


@pytest.fixture
def forecaster() -> StubForecaster:
    return StubForecaster()


@pytest.fixture
def sim() -> Simulator:
    """A reset 45-day simulator on the baseline scenario (stub forecaster
    keeps attach_pricer working under the default "dynamic" pricing)."""
    s = Simulator(SimConfig(scenario="baseline", horizon_days=45, seed=3,
                            start_week=10, forecaster=StubForecaster()))
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
