"""customer quotes: offers table + order links to the live simulation

A customer order is now priced by the live simulator: POST /orders returns
an offer menu (accept / flex window / alt hub / split, from the same action
rules the policy uses), the customer accepts one or declines, and the
booking then moves through the voyage like any simulated consignment.

orders gains:
  episode_id, request_id   which live episode / sim request it belongs to
  offer_id, deal_id        the accepted offer and its settlement deal
  board_day, eta_day       absolute sim days of the booked voyage
  discharge_port           differs from dest when an alt-hub offer is taken

offers: one row per priced option shown to the customer.

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-25
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def _order_cols() -> list[sa.Column]:
    # fresh Column objects per call: a Column can only be attached once
    return [
        sa.Column("episode_id", sa.Text, nullable=True),
        sa.Column("request_id", sa.Integer, nullable=True),
        sa.Column("offer_id", sa.Text, nullable=True),
        sa.Column("deal_id", sa.Text, nullable=True),
        sa.Column("board_day", sa.Float, nullable=True),
        sa.Column("eta_day", sa.Float, nullable=True),
        sa.Column("discharge_port", sa.Text, nullable=True),
    ]


def upgrade() -> None:
    for col in _order_cols():
        op.add_column("orders", col)
    op.create_index("ix_orders_episode_request", "orders",
                    ["episode_id", "request_id"])

    op.create_table(
        "offers",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("order_id", sa.Text,
                  sa.ForeignKey("orders.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("kind", sa.Text, nullable=False),       # accept|flex_window|alt_hub|split
        sa.Column("action", sa.Integer, nullable=False),  # policy action index
        sa.Column("price_per_teu", sa.Float, nullable=False),
        sa.Column("total_usd", sa.Float, nullable=False),
        sa.Column("discount_pct", sa.Float, nullable=False, server_default="0"),
        sa.Column("discharge_port", sa.Text, nullable=False),
        sa.Column("board_day", sa.Float, nullable=False),
        sa.Column("eta_day", sa.Float, nullable=False),
        sa.Column("legs", sa.JSON, nullable=False),        # [{vessel_id, teu, board_day, eta_day}]
        sa.Column("summary", sa.Text, nullable=False),     # one-line human explanation
        sa.Column("pricing", sa.JSON, nullable=True),      # bid-price floor, market, reason code
        sa.Column("prob", sa.Float, nullable=True),        # policy probability of this action
        sa.Column("recommended", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("status", sa.Text, nullable=False, server_default="open"),  # open|accepted|declined|expired
        sa.Column("created", sa.Float, nullable=False),
    )
    op.create_index("ix_offers_order", "offers", ["order_id"])


def downgrade() -> None:
    op.drop_index("ix_offers_order", table_name="offers")
    op.drop_table("offers")
    op.drop_index("ix_orders_episode_request", table_name="orders")
    for col in reversed(_order_cols()):
        op.drop_column("orders", col.name)
