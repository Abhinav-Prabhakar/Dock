"""order id sequence

Order ids (BK-####-TC) were computed as MAX(existing)+1 in application code,
so two concurrent POST /orders could read the same MAX and collide on the
primary key (one of them 500s). A Postgres sequence hands out numbers
atomically. It starts above any id already in the table so existing rows are
never reused.

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-25
"""
from __future__ import annotations

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE SEQUENCE IF NOT EXISTS order_number_seq START 2401")
    # continue after whatever is already there (2400 = the historic floor)
    op.execute("""
        SELECT setval('order_number_seq', GREATEST(2400, COALESCE(
            (SELECT MAX(CAST(REPLACE(REPLACE(id, 'BK-', ''), '-TC', '') AS INTEGER))
             FROM orders WHERE id ~ '^BK-[0-9]+-TC$'), 2400)))
    """)


def downgrade() -> None:
    op.execute("DROP SEQUENCE IF EXISTS order_number_seq")
