"""Add workflow connector bindings for connector-backed runtime parameters.

Revision ID: 017
Revises: 016
Create Date: 2026-05-21
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "017"
down_revision: str | None = "016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "workflow_connector_bindings",
        sa.Column("workflow_id", sa.String(length=36), nullable=False),
        sa.Column("parameter_key", sa.String(length=100), nullable=False),
        sa.Column("workflow_step_index", sa.Integer(), nullable=True),
        sa.Column("connector_id", sa.String(length=36), nullable=False),
        sa.Column("source_kind", sa.String(length=50), nullable=False),
        sa.Column("job_filters", JSONB(), nullable=True),
        sa.Column("template", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workflow_id", "parameter_key", name="uq_workflow_connector_param"),
    )
    op.create_index(
        "ix_workflow_connector_bindings_workflow_id",
        "workflow_connector_bindings",
        ["workflow_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_workflow_connector_bindings_workflow_id", table_name="workflow_connector_bindings")
    op.drop_table("workflow_connector_bindings")
