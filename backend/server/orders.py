"""Customer booking orders — shared store between the customer site
(customers/) and the operator site (drafts/cargo-ship/).

Postgres (via server/db.py), table `orders` — schema owned by the Alembic
migration in alembic/versions/, not created here. A customer "order" is one
booking request for a single cargo type — a multi-type consignment is
filed as several orders (the intake UI posts one order per container kind).

No mock/seed rows: a fresh database starts with an empty table (see the
"no mock data as a fallback" project decision). Local synthetic data, if
wanted, is a separate opt-in seed script — never baked into this module or
a migration.

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

import time

from pydantic import BaseModel, Field
from sqlalchemy import (Column, Float, Integer, MetaData, Table, Text,
                        delete, insert, select, text)

from data import calibration as C

from .db import engine

CARGO_TYPES = ("dry", "reefer", "hazmat")
SEGMENTS = ("flexible", "standard", "urgent")
PORT_IDS = {row[0] for row in C.PORTS}
SERVABLE = {(o, d) for (o, d, *_rest) in C.ROUTES}

# display lifecycle for the customer dashboard — until the simulator assigns
# real voyage data, orders move through these statuses manually
STATUSES = ("PENDING REVIEW", "CONFIRMED", "LOADING",
            "IN TRANSIT", "AT PORT", "DELIVERED")

metadata = MetaData()
orders_table = Table(
    "orders", metadata,
    Column("id", Text, primary_key=True),
    Column("origin", Text, nullable=False),
    Column("dest", Text, nullable=False),
    Column("teu", Integer, nullable=False),
    Column("weight_t", Float, nullable=False),
    Column("cargo_type", Text, nullable=False),
    Column("segment", Text, nullable=False),
    Column("req_dep_day", Float, nullable=False),
    Column("flex_days", Integer, nullable=False),
    Column("status", Text, nullable=False),
    Column("created", Float, nullable=False),
    Column("vessel", Text),
    Column("voyage", Text),
    Column("eta", Text),
    Column("progress", Float),
    Column("price_usd", Float),
)
_COLS = [c.name for c in orders_table.columns]


class OrderIn(BaseModel):
    origin: str
    dest: str
    teu: int = Field(ge=1)
    weight_t: float = Field(gt=0)
    cargo_type: str
    segment: str
    req_dep_day: float
    flex_days: int = Field(ge=0)


def init_db() -> None:
    """Schema is owned by Alembic (`alembic upgrade head`, run on container
    start). This just checks the table is reachable, so a misconfigured
    DATABASE_URL or a skipped migration fails loudly at startup rather than
    on the first request."""
    with engine.connect() as cx:
        cx.execute(select(orders_table.c.id).limit(1))


def _row_to_dict(row) -> dict:
    return dict(row._mapping)


def list_orders() -> list[dict]:
    with engine.connect() as cx:
        rows = cx.execute(
            select(orders_table).order_by(orders_table.c.created.desc())
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_order(order_id: str) -> dict | None:
    with engine.connect() as cx:
        row = cx.execute(
            select(orders_table).where(orders_table.c.id == order_id)
        ).fetchone()
    return _row_to_dict(row) if row else None


def _next_id(cx) -> str:
    """BK-####-TC sequence continuing above the seeded range."""
    n = cx.execute(text(
        "SELECT MAX(CAST(REPLACE(REPLACE(id, 'BK-', ''), '-TC', '') "
        "AS INTEGER)) FROM orders")).scalar() or 2400
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

    with engine.begin() as cx:
        oid = _next_id(cx)
        rec = dict(id=oid, origin=o, dest=d, teu=body.teu,
                   weight_t=body.weight_t, cargo_type=body.cargo_type,
                   segment=body.segment, req_dep_day=body.req_dep_day,
                   flex_days=body.flex_days, status="PENDING REVIEW",
                   created=time.time(), vessel=None, voyage=None,
                   eta=None, progress=0.0, price_usd=None)
        cx.execute(insert(orders_table).values(**rec))
    return rec


def clear_orders() -> int:
    with engine.begin() as cx:
        result = cx.execute(delete(orders_table))
        return result.rowcount
