"""Add webhook_triggers table for connector-to-workflow event bindings.

Revision ID: 018
Revises: 017
Create Date: 2026-05-21
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "018"
down_revision: str | None = "017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "webhook_triggers",
        sa.Column("connector_id", sa.String(length=36), nullable=False),
        sa.Column("workflow_id", sa.String(length=36), nullable=False),
        sa.Column("event_kind", sa.String(length=50), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True, server_default=sa.func.now()),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_webhook_triggers_connector_id", "webhook_triggers", ["connector_id"])
    op.create_index("ix_webhook_triggers_workflow_id", "webhook_triggers", ["workflow_id"])


def downgrade() -> None:
    op.drop_index("ix_webhook_triggers_workflow_id", table_name="webhook_triggers")
    op.drop_index("ix_webhook_triggers_connector_id", table_name="webhook_triggers")
    op.drop_table("webhook_triggers")
