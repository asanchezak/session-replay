"""Add AI-centric runtime fields for semantic completion and extraction memory.

Revision ID: 014
Revises: 013
Create Date: 2026-05-15
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "014"
down_revision: str | None = "013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "execution_runs",
        sa.Column(
            "extracted_data",
            JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column(
        "workflow_analyses",
        sa.Column("goal_predicate", JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("workflow_analyses", "goal_predicate")
    op.drop_column("execution_runs", "extracted_data")
