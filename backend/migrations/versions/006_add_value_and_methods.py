"""add value and methods columns to workflow_steps

Revision ID: 006
Revises: 005
Create Date: 2026-05-12
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "006"
down_revision: str | None = "005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("workflow_steps", sa.Column("value", sa.Text, nullable=True))
    op.add_column("workflow_steps", sa.Column("methods", JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("workflow_steps", "methods")
    op.drop_column("workflow_steps", "value")
