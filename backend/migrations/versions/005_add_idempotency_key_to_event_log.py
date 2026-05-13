"""add idempotency_key to event_log

Revision ID: 005
Revises: 004
Create Date: 2026-05-12
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "005"
down_revision: str | None = "004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("event_log", sa.Column("idempotency_key", sa.String(64), nullable=True, index=True))


def downgrade() -> None:
    op.drop_column("event_log", "idempotency_key")
