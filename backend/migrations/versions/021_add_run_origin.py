"""Add origin JSONB column to execution_runs.

Revision ID: 021
Revises: 020
Create Date: 2026-05-26
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "021"
down_revision: str | None = "020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("execution_runs", sa.Column("origin", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("execution_runs", "origin")
