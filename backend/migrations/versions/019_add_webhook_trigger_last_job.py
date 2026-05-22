"""Add last_job_payload and last_fired_at to webhook_triggers.

Revision ID: 019
Revises: 018
Create Date: 2026-05-22
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "019"
down_revision: str | None = "018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("webhook_triggers", sa.Column("last_job_payload", JSONB(), nullable=True))
    op.add_column("webhook_triggers", sa.Column("last_fired_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("webhook_triggers", "last_fired_at")
    op.drop_column("webhook_triggers", "last_job_payload")
