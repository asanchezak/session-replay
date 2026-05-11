"""create workflows, workflow_steps, and execution_runs tables

Revision ID: 002
Revises: 001
Create Date: 2025-05-11
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

# Use JSONB in production, JSON in models for test compat

revision: str = "002"
down_revision: str | None = "001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "workflows",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("prompt", sa.Text, nullable=True),
        sa.Column("target_url", sa.Text, nullable=True),
        sa.Column("created_by", sa.String(100), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="draft", index=True),
        sa.Column("version", sa.Integer, nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
    )
    op.create_table(
        "workflow_steps",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("workflow_id", sa.String(36), nullable=False, index=True),
        sa.Column("step_index", sa.Integer, nullable=False),
        sa.Column("action_type", sa.String(30), nullable=False),
        sa.Column("intent", sa.Text, nullable=True),
        sa.Column("selector_chain", JSONB, nullable=True),
        sa.Column("accessibility_metadata", JSONB, nullable=True),
        sa.Column("text_anchors", JSONB, nullable=True),
        sa.Column("dom_context", JSONB, nullable=True),
        sa.Column("success_condition", JSONB, nullable=True),
        sa.Column("failure_condition", JSONB, nullable=True),
        sa.Column("ai_hint", sa.Text, nullable=True),
        sa.Column("checkpoint", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
    )
    op.create_table(
        "execution_runs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("workflow_id", sa.String(36), nullable=False, index=True),
        sa.Column("workflow_snapshot", JSONB, nullable=True),
        sa.Column("user_id", sa.String(100), nullable=True),
        sa.Column("browser_session_id", sa.String(100), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="idle", index=True),
        sa.Column("current_step_index", sa.Integer, nullable=False, server_default="0"),
        sa.Column("pause_reason", sa.Text, nullable=True),
        sa.Column("error_summary", sa.Text, nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("execution_runs")
    op.drop_table("workflow_steps")
    op.drop_table("workflows")
