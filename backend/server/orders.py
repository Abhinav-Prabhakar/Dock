"""Customer booking orders — shared store between the customer site
(customers/) and the operator site (drafts/cargo-ship).

Plain SQLite (stdlib sqlite3), one table, at backend/data/dock.db.
A customer "order" is one booking request for a single cargo type —
a multi-type consignment is filed as several orders (the intake UI
posts one order per container kind).

Public surface (wired into routes.py):
    GET    /orders         -> [order] newest first
    GET    /orders/{id}    -> order
    POST   /orders         -> 201 order  (validated below)
    DELETE /orders         -> 204        (demo reset — wipes the table)

POST validation:
    origin/dest        valid port_ids AND a servable OD pair (C.ROUTES —
                       one vessel loop must cover it)
    teu                int >= 1
    weight_t           float > 0
    cargo_type         dry | reefer | hazmat
    segment            flexible | standard | urgent
    req_dep_day        float >= current sim day + 0.5
    flex_days          int >= 0
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from pydantic import BaseModel, Field

from data import calibration as C

BACKEND = Path(__file__).resolve().parent.parent
DB_PATH = BACKEND / "data" / "dock.db"

CARGO_TYPES = ("dry", "reefer", "hazmat")
SEGMENTS = ("flexible", "standard", "urgent")
PORT_IDS = {row[0] for row in C.PORTS}
SERVABLE = {(o, d) for (o, d, *_rest) in C.ROUTES}

# display lifecycle for the customer dashboard — until the simulator assigns
# real voyage data, orders move through these statuses manually
STATUSES = ("PENDING REVIEW", "CONFIRMED", "LOADING",
            "IN TRANSIT", "AT PORT", "DELIVERED")

SCHEMA = """
CREATE TABLE IF NOT EXISTS orders (
    id          TEXT PRIMARY KEY,
    origin      TEXT NOT NULL,
    dest        TEXT NOT NULL,
    teu         INTEGER NOT NULL,
    weight_t    REAL NOT NULL,
    cargo_type  TEXT NOT NULL,
    segment     TEXT NOT NULL,
    req_dep_day REAL NOT NULL,
    flex_days   INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'PENDING REVIEW',
    created     REAL NOT NULL,
    vessel      TEXT,
    voyage      TEXT,
    eta         TEXT,
    progress    REAL,
    price_usd   REAL
);
"""

# --- seed: the sample set from the ledger dashboard, re-keyed to real ports
# and the booking-request schema (one cargo_type per order) ---------------
_SEED = [
    dict(id="BK-2481-TC", origin="CNSHA", dest="USLAX", teu=20, weight_t=224.0,
         cargo_type="dry", segment="standard", req_dep_day=8.0, flex_days=3,
         status="CONFIRMED", vessel="Pacific Aurora", voyage="ML-114E",
         progress=0.0, price_usd=4820.0),
    dict(id="BK-2477-QH", origin="CNSHA", dest="NLRTM", teu=25, weight_t=271.0,
         cargo_type="dry", segment="standard", req_dep_day=6.0, flex_days=4,
         status="IN TRANSIT", vessel="Pacific Aurora", voyage="ML-108W",
         progress=0.62, price_usd=5910.0),
    dict(id="BK-2474-BM", origin="KRPUS", dest="USLAX", teu=16, weight_t=192.0,
         cargo_type="reefer", segment="urgent", req_dep_day=4.0, flex_days=0,
         status="IN TRANSIT", vessel="Meridian Star", voyage="ML-097W",
         progress=0.41, price_usd=5380.0),
    dict(id="BK-2469-RD", origin="SGSIN", dest="NLRTM", teu=13, weight_t=145.0,
         cargo_type="dry", segment="flexible", req_dep_day=2.0, flex_days=6,
         status="AT PORT", vessel="Coral Empress", voyage="ML-121N",
         progress=0.96, price_usd=6140.0),
    dict(id="BK-2466-JF", origin="CNSHA", dest="SGSIN", teu=9, weight_t=104.0,
         cargo_type="dry", segment="standard", req_dep_day=3.0, flex_days=2,
         status="LOADING", vessel="Pacific Aurora", voyage="ML-132E",
         progress=0.04, price_usd=4470.0),
    dict(id="BK-2460-NV", origin="CNSHA", dest="NLRTM", teu=28, weight_t=310.0,
         cargo_type="dry", segment="flexible", req_dep_day=-20.0, flex_days=5,
         status="DELIVERED", vessel="Pacific Aurora", voyage="ML-089W",
         progress=1.0, price_usd=7250.0),
    dict(id="BK-2456-GT", origin="SGSIN", dest="BEANR", teu=7, weight_t=88.0,
         cargo_type="hazmat", segment="urgent", req_dep_day=5.0, flex_days=0,
         status="PENDING REVIEW", vessel="Coral Empress", voyage="ML-141W",
         progress=0.0, price_usd=3990.0),
    dict(id="BK-2451-KP", origin="KRPUS", dest="USLAX", teu=13, weight_t=160.0,
         cargo_type="reefer", segment="standard", req_dep_day=-45.0, flex_days=3,
         status="DELIVERED", vessel="Meridian Star", voyage="ML-076W",
         progress=1.0, price_usd=4680.0),
    dict(id="BK-2485-WA", origin="CNSHA", dest="SGSIN", teu=2, weight_t=21.0,
         cargo_type="reefer", segment="flexible", req_dep_day=12.0, flex_days=5,
         status="PENDING REVIEW", vessel="Pacific Aurora", voyage="ML-144E",
         progress=0.0, price_usd=1150.0),
]

_COLS = ("id", "origin", "dest", "teu", "weight_t", "cargo_type", "segment",
         "req_dep_day", "flex_days", "status", "created", "vessel", "voyage",
         "eta", "progress", "price_usd")


class OrderIn(BaseModel):
    origin: str
    dest: str
    teu: int = Field(ge=1)
    weight_t: float = Field(gt=0)
    cargo_type: str
    segment: str
    req_dep_day: float
    flex_days: int = Field(ge=0)


def _conn() -> sqlite3.Connection:
    cx = sqlite3.connect(DB_PATH)
    cx.row_factory = sqlite3.Row
    return cx


def init_db() -> None:
    """Create the table; seed the sample set only when the table is first
    created — DELETE /orders + a restart must not silently reseed."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _conn() as cx:
        fresh = cx.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='orders'"
        ).fetchone() is None
        cx.execute(SCHEMA)
        if not fresh:
            return
        now = time.time()
        for i, o in enumerate(_SEED):
            row = dict(o, created=now - (len(_SEED) - i) * 86400,
                       eta=o.get("eta"))
            cx.execute(
                f"INSERT INTO orders ({', '.join(_COLS)}) "
                f"VALUES ({', '.join('?' * len(_COLS))})",
                [row.get(c) for c in _COLS])
        cx.commit()


def list_orders() -> list[dict]:
    with _conn() as cx:
        rows = cx.execute(
            "SELECT * FROM orders ORDER BY created DESC").fetchall()
    return [dict(r) for r in rows]


def get_order(order_id: str) -> dict | None:
    with _conn() as cx:
        r = cx.execute("SELECT * FROM orders WHERE id = ?",
                       (order_id,)).fetchone()
    return dict(r) if r else None


def _next_id(cx) -> str:
    """BK-####-TC sequence continuing above the seeded range."""
    n = cx.execute(
        "SELECT MAX(CAST(REPLACE(REPLACE(id, 'BK-', ''), '-TC', '') "
        "AS INTEGER)) FROM orders").fetchone()[0] or 2400
    return f"BK-{n + 1}-TC"


def create_order(body: OrderIn, sim_day: float = 0.0) -> dict:
    o, d = body.origin.upper(), body.dest.upper()
    if o not in PORT_IDS:
        raise ValueError(f"unknown origin port '{body.origin}'")
    if d not in PORT_IDS:
        raise ValueError(f"unknown destination port '{body.dest}'")
    if (o, d) not in SERVABLE:
        raise ValueError(
            f"no servable OD pair {o} -> {d} (no vessel loop covers it)")
    if body.cargo_type not in CARGO_TYPES:
        raise ValueError(f"cargo_type must be one of {CARGO_TYPES}")
    if body.segment not in SEGMENTS:
        raise ValueError(f"segment must be one of {SEGMENTS}")
    if body.req_dep_day < sim_day + 0.5:
        raise ValueError(
            f"req_dep_day {body.req_dep_day} must be >= {sim_day + 0.5} "
            f"(current sim day {sim_day} + 0.5)")

    with _conn() as cx:
        oid = _next_id(cx)
        rec = dict(id=oid, origin=o, dest=d, teu=body.teu,
                   weight_t=body.weight_t, cargo_type=body.cargo_type,
                   segment=body.segment, req_dep_day=body.req_dep_day,
                   flex_days=body.flex_days, status="PENDING REVIEW",
                   created=time.time(), vessel=None, voyage=None,
                   eta=None, progress=0.0, price_usd=None)
        cx.execute(
            f"INSERT INTO orders ({', '.join(_COLS)}) "
            f"VALUES ({', '.join('?' * len(_COLS))})",
            [rec[c] for c in _COLS])
        cx.commit()
    return rec


def clear_orders() -> int:
    with _conn() as cx:
        n = cx.execute("DELETE FROM orders").rowcount
        cx.commit()
    return n
