"""add total_steps to execution_runs

Revision ID: 004
Revises: 003
Create Date: 2026-05-11
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "004"
down_revision: str | None = "003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("execution_runs", sa.Column("total_steps", sa.Integer, nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("execution_runs", "total_steps")
