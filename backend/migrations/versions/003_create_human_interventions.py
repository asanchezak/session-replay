"""create human_interventions table

Revision ID: 003
Revises: 002
Create Date: 2026-05-11
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "003"
down_revision: str | None = "002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "human_interventions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("run_id", sa.String(36), nullable=False, index=True),
        sa.Column("trigger_reason", sa.String(100), nullable=False),
        sa.Column("page_url", sa.Text, nullable=True),
        sa.Column("checkpoint_event_id", sa.String(36), nullable=True),
        sa.Column("resolution_notes", sa.Text, nullable=True),
        sa.Column("user_action", sa.String(50), nullable=True),
        sa.Column("paused_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("human_interventions")
