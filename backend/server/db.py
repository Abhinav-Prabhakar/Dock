"""Postgres connection — one small module shared by orders.py and (later)
episode/event/deal persistence.

DATABASE_URL (env var) selects the database, e.g.
    postgresql+psycopg://dock:dockpw@db:5432/dock        (compose, service name "db")
    postgresql+psycopg://dock:dockpw@localhost:5432/dock (running the API on the host)

Falls back to a local default so `alembic` and the app still have
*something* to point at outside Docker; nothing here creates the database
itself — `db/init/` (docker-compose) creates it, and `alembic upgrade head`
creates the schema. No table DDL happens at import time.
"""

from __future__ import annotations

import os

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql+psycopg://dock:dockpw@localhost:5432/dock")

# pool_pre_ping: episode threads and request handlers share this engine
# across a long-lived process; a dropped connection (db container restart)
# should be retried, not raised.
engine = create_engine(DATABASE_URL, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)


def get_session() -> Session:
    """One session per call site; caller is responsible for closing it
    (use as a context manager: `with get_session() as s:`)."""
    return SessionLocal()
