"""add sequence_number column and (run_id, sequence_number) + (run_id, nonce) unique constraints

Revision ID: 007
Revises: 006
Create Date: 2026-05-13
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "007"
down_revision: str | None = "006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "event_log",
        sa.Column("sequence_number", sa.Integer, nullable=False, server_default=sa.text("0")),
    )
    op.create_unique_constraint("uq_event_log_run_seq", "event_log", ["run_id", "sequence_number"])
    op.create_unique_constraint("uq_event_log_run_nonce", "event_log", ["run_id", "nonce"])


def downgrade() -> None:
    op.drop_constraint("uq_event_log_run_nonce", "event_log", type_="unique")
    op.drop_constraint("uq_event_log_run_seq", "event_log", type_="unique")
    op.drop_column("event_log", "sequence_number")
