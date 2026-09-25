"""Customer booking orders — shared store between the customer site
(customers/) and the operator site (drafts/cargo-ship/).

Postgres (via server/db.py); schema owned by the Alembic migrations in
alembic/versions/, never created here. A customer "order" is one booking
request for a single cargo type — a multi-type consignment is filed as
several orders (the intake UI posts one order per container kind).

Lifecycle (status column):
    QUOTED     priced by the live simulator; offers waiting on the customer
    NO OFFER   nothing in the window clears the bid-price floor (recorded,
               so the operator still sees the demand)
    CONFIRMED  customer accepted an offer; cargo booked on a real voyage
    IN TRANSIT the vessel sailed with it (departure.confirmed)
    DELIVERED  discharged (delivery.confirmed)
    DECLINED   customer turned every offer down
    EXPIRED    the quote lapsed (timeout, or the live simulation restarted)
and, derived on read from the live clock (never stored):
    LOADING    CONFIRMED and within a day of sailing
    AT PORT    IN TRANSIT and past its ETA, awaiting discharge

No mock/seed rows: a fresh database starts empty.

Validation (POST /orders):
    origin/dest   valid port_ids AND a servable OD pair (a vessel loop covers it)
    teu           int >= 1
    weight_t      float > 0
    cargo_type    dry | reefer | hazmat
    segment       flexible | standard | urgent
    req_dep_day   float >= 0.5 — days FROM NOW (the live sim clock), which
                  is how the customer site expresses its calendar window
    flex_days     int >= 0
"""

from __future__ import annotations

import time

from pydantic import BaseModel, Field
from sqlalchemy import (JSON, Boolean, Column, Float, ForeignKey, Integer,
                        MetaData, Table, Text, delete, insert, select, text,
                        update)

from data import calibration as C

from .db import engine

CARGO_TYPES = ("dry", "reefer", "hazmat")
SEGMENTS = ("flexible", "standard", "urgent")
PORT_IDS = {row[0] for row in C.PORTS}
SERVABLE = {(o, d) for (o, d, *_rest) in C.ROUTES}
STATUSES = ("QUOTED", "NO OFFER", "CONFIRMED", "LOADING", "IN TRANSIT", "AT PORT",
            "DELIVERED", "DECLINED", "EXPIRED")

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
    Column("episode_id", Text),
    Column("request_id", Integer),
    Column("offer_id", Text),
    Column("deal_id", Text),
    Column("board_day", Float),
    Column("eta_day", Float),
    Column("discharge_port", Text),
)
offers_table = Table(
    "offers", metadata,
    Column("id", Text, primary_key=True),
    Column("order_id", Text, ForeignKey("orders.id"), nullable=False),
    Column("kind", Text, nullable=False),
    Column("action", Integer, nullable=False),
    Column("price_per_teu", Float, nullable=False),
    Column("total_usd", Float, nullable=False),
    Column("discount_pct", Float, nullable=False),
    Column("discharge_port", Text, nullable=False),
    Column("board_day", Float, nullable=False),
    Column("eta_day", Float, nullable=False),
    Column("legs", JSON, nullable=False),
    Column("summary", Text, nullable=False),
    Column("pricing", JSON),
    Column("prob", Float),
    Column("recommended", Boolean, nullable=False),
    Column("status", Text, nullable=False),
    Column("created", Float, nullable=False),
)


class OrderIn(BaseModel):
    origin: str
    dest: str
    teu: int = Field(ge=1)
    weight_t: float = Field(gt=0)
    cargo_type: str
    segment: str
    req_dep_day: float
    flex_days: int = Field(ge=0)


class AcceptIn(BaseModel):
    offer_id: str


def init_db() -> None:
    """Schema is owned by Alembic (`alembic upgrade head`, run on container
    start). This just checks the tables are reachable, so a misconfigured
    DATABASE_URL or a skipped migration fails loudly at startup rather than
    on the first request."""
    with engine.connect() as cx:
        cx.execute(select(orders_table.c.id).limit(1))
        cx.execute(select(offers_table.c.id).limit(1))


def validate(body: OrderIn) -> dict:
    """Normalise + check an order request. Raises ValueError (-> 422)."""
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
    if body.req_dep_day < 0.5:
        raise ValueError(f"req_dep_day {body.req_dep_day} must be >= 0.5 "
                         "(days from now)")
    return dict(origin=o, dest=d, teu=body.teu, weight_t=body.weight_t,
                cargo_type=body.cargo_type, segment=body.segment,
                req_dep_day=body.req_dep_day, flex_days=body.flex_days)


def next_id() -> str:
    """BK-####-TC from a Postgres sequence (migration 0002) — atomic, so
    concurrent POSTs can't pick the same number."""
    with engine.connect() as cx:
        n = cx.execute(text("SELECT nextval('order_number_seq')")).scalar_one()
    return f"BK-{n}-TC"


def insert_quoted(order: dict, offers: list[dict],
                  status: str = "QUOTED") -> None:
    """Order + its offer menu in one transaction."""
    now = time.time()
    rec = {c.name: None for c in orders_table.columns}
    rec.update(order, status=status, created=now, progress=0.0)
    with engine.begin() as cx:
        cx.execute(insert(orders_table).values(**rec))
        for off in offers:
            cx.execute(insert(offers_table).values(
                **off, order_id=order["id"], status="open", created=now))


def update_order(order_id: str, **fields) -> None:
    with engine.begin() as cx:
        cx.execute(update(orders_table)
                   .where(orders_table.c.id == order_id).values(**fields))


def update_by_request(episode_id: str, request_id: int, **fields) -> None:
    """Event-driven updates (departure/delivery/deal) key on the sim request."""
    with engine.begin() as cx:
        cx.execute(update(orders_table)
                   .where(orders_table.c.episode_id == episode_id,
                          orders_table.c.request_id == request_id)
                   .values(**fields))


def set_offer_status(order_id: str, status: str,
                     only_id: str | None = None) -> None:
    """Close out a menu: the accepted offer -> accepted, the rest -> status."""
    with engine.begin() as cx:
        cx.execute(update(offers_table)
                   .where(offers_table.c.order_id == order_id,
                          offers_table.c.status == "open")
                   .values(status=status))
        if only_id is not None:
            cx.execute(update(offers_table)
                       .where(offers_table.c.id == only_id)
                       .values(status="accepted"))


def get_offers(order_id: str) -> list[dict]:
    with engine.connect() as cx:
        rows = cx.execute(select(offers_table)
                          .where(offers_table.c.order_id == order_id)
                          .order_by(offers_table.c.recommended.desc(),
                                    offers_table.c.total_usd)).fetchall()
    return [dict(r._mapping) for r in rows]


def _present(row: dict, live: dict | None) -> dict:
    """Add the display fields the dashboard reads (status, progress, eta)
    from the live clock. Only orders booked in the current live episode
    move; anything older keeps its stored state."""
    o = dict(row)
    here = live is not None and o.get("episode_id") == live["id"]
    b, e = o.get("board_day"), o.get("eta_day")
    if here and b is not None and e is not None:
        day = live["day"]
        if o["status"] == "CONFIRMED" and day >= b - 1.0:
            o["status"] = "LOADING"
        if o["status"] == "IN TRANSIT":
            o["progress"] = round(min(max((day - b) / max(e - b, 1e-6), 0), 1), 3)
            if day >= e:
                o["status"] = "AT PORT"
        o["eta"] = f"D+{max(0, round(e - day))}"
    if o["status"] == "DELIVERED":
        o["progress"] = 1.0
    return o


def list_orders(live: dict | None = None) -> list[dict]:
    with engine.connect() as cx:
        rows = cx.execute(
            select(orders_table).order_by(orders_table.c.created.desc())
        ).fetchall()
    return [_present(dict(r._mapping), live) for r in rows]


def get_order(order_id: str, live: dict | None = None) -> dict | None:
    with engine.connect() as cx:
        row = cx.execute(
            select(orders_table).where(orders_table.c.id == order_id)
        ).fetchone()
    return _present(dict(row._mapping), live) if row else None


def expire_open(episode_id: str | None = None) -> int:
    """Quotes that can no longer be honoured -> EXPIRED (e.g. the live
    episode they were priced against has ended)."""
    q = update(orders_table).where(orders_table.c.status == "QUOTED")
    if episode_id is not None:
        q = q.where(orders_table.c.episode_id == episode_id)
    with engine.begin() as cx:
        n = cx.execute(q.values(status="EXPIRED")).rowcount
        cx.execute(update(offers_table).where(offers_table.c.status == "open")
                   .where(offers_table.c.order_id.in_(
                       select(orders_table.c.id)
                       .where(orders_table.c.status == "EXPIRED")))
                   .values(status="expired"))
    return n


def clear_orders() -> int:
    with engine.begin() as cx:
        cx.execute(delete(offers_table))
        return cx.execute(delete(orders_table)).rowcount
