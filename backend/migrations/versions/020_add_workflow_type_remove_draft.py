"""Add workflow_type column; migrate draft→active; promote cf827aa1 to system.

Revision ID: 020
Revises: 019
Create Date: 2026-05-22
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "020"
down_revision: str | None = "019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SYSTEM_WORKFLOW_ID = "cf827aa1-3bfb-484d-94fd-ae27d35567d3"


def upgrade() -> None:
    op.add_column("workflows", sa.Column("workflow_type", sa.String(20), nullable=False, server_default="user"))
    op.create_index("ix_workflows_workflow_type", "workflows", ["workflow_type"])

    conn = op.get_bind()
    # Convert any lingering draft workflows to active
    conn.execute(sa.text("UPDATE workflows SET status = 'active' WHERE status = 'draft'"))
    # Promote the canonical system workflow
    conn.execute(sa.text(
        f"UPDATE workflows SET workflow_type = 'system' WHERE id = '{SYSTEM_WORKFLOW_ID}'"
    ))


def downgrade() -> None:
    op.drop_index("ix_workflows_workflow_type", table_name="workflows")
    op.drop_column("workflows", "workflow_type")
