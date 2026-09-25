"""orders table

Moves the customer `orders` store off SQLite (backend/data/dock.db) onto
Postgres. Same columns as the SQLite schema in server/orders.py — no
seed rows: per the "no mock data as a fallback" decision, a fresh
database starts with an empty table. Local synthetic data is a separate,
opt-in seed step, never part of a migration.

Revision ID: 0001
Revises:
Create Date: 2026-09-25
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "orders",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("origin", sa.Text, nullable=False),
        sa.Column("dest", sa.Text, nullable=False),
        sa.Column("teu", sa.Integer, nullable=False),
        sa.Column("weight_t", sa.Float, nullable=False),
        sa.Column("cargo_type", sa.Text, nullable=False),
        sa.Column("segment", sa.Text, nullable=False),
        sa.Column("req_dep_day", sa.Float, nullable=False),
        sa.Column("flex_days", sa.Integer, nullable=False),
        sa.Column("status", sa.Text, nullable=False,
                  server_default="PENDING REVIEW"),
        sa.Column("created", sa.Float, nullable=False),
        sa.Column("vessel", sa.Text, nullable=True),
        sa.Column("voyage", sa.Text, nullable=True),
        sa.Column("eta", sa.Text, nullable=True),
        sa.Column("progress", sa.Float, nullable=True),
        sa.Column("price_usd", sa.Float, nullable=True),
    )
    op.create_index("ix_orders_created", "orders", ["created"])


def downgrade() -> None:
    op.drop_index("ix_orders_created", table_name="orders")
    op.drop_table("orders")
