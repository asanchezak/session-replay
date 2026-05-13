"""add foreign keys to workflow_steps/execution_runs and create connector_configs table

Revision ID: 008
Revises: 007
Create Date: 2026-05-13
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "008"
down_revision: str | None = "007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_foreign_key(
        "fk_workflow_steps_workflow_id",
        "workflow_steps",
        "workflows",
        ["workflow_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_execution_runs_workflow_id",
        "execution_runs",
        "workflows",
        ["workflow_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_table(
        "connector_configs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("connector_type", sa.String(50), nullable=False),
        sa.Column("config", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=True,
        ),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("connector_configs")
    op.drop_constraint("fk_execution_runs_workflow_id", "execution_runs", type_="foreignkey")
    op.drop_constraint("fk_workflow_steps_workflow_id", "workflow_steps", type_="foreignkey")
