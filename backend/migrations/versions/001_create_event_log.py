"""create event_log table

Revision ID: 001
Revises:
Create Date: 2025-05-11
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

# Use JSONB in production (PostgreSQL), JSON in models for test compat

revision: str = "001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "event_log",
        sa.Column(
            "id", UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("run_id", UUID(as_uuid=True), nullable=True, index=True),
        sa.Column("step_id", UUID(as_uuid=True), nullable=True),
        sa.Column(
            "actor_type",
            sa.Enum("system", "human", "ai", "extension", name="actor_type_enum"),
            nullable=False,
        ),
        sa.Column(
            "event_type",
            sa.Enum(
                "click", "type", "select", "submit", "scroll", "navigate",
                "hover", "copy", "paste", "tab_change",
                "run_started", "run_paused", "run_resumed",
                "run_completed", "run_failed", "run_canceled",
                "checkpoint", "recovery_attempt", "recovery_success",
                "recovery_failure", "intervention", "ai_invocation",
                "screenshot", "dom_snapshot",
                name="event_type_enum",
            ),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "payload", JSONB, nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("page_url", sa.Text, nullable=True),
        sa.Column("page_title", sa.String(500), nullable=True),
        sa.Column("previous_hash", sa.String(64), nullable=False),
        sa.Column("hash", sa.String(64), nullable=False, unique=True),
        sa.Column("nonce", sa.String(32), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=True,
        ),
    )

    op.create_index(
        "ix_event_log_run_created", "event_log", ["run_id", "created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_event_log_run_created", table_name="event_log")
    op.drop_table("event_log")
    op.execute("DROP TYPE IF EXISTS actor_type_enum")
    op.execute("DROP TYPE IF EXISTS event_type_enum")
