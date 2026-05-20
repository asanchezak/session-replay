"""Add rolling OpenAI message list to execution_runs.

Workstream C wires the agent loop to OpenAI's tool-use (function-calling)
mode. Across polls the model expects a running conversation history with
prior tool_use/tool_result blocks; this JSONB column persists that history
per run so workers can serve subsequent polls without re-fetching context
from scratch.

The list is trimmed to the last N=20 messages with image blocks stripped
from non-current turns by services.agent_conversation. Worst case ~30KB
of text per run.

Revision ID: 016
Revises: 015
Create Date: 2026-05-19
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "016"
down_revision: str | None = "015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "execution_runs",
        sa.Column(
            "ai_conversation",
            JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("execution_runs", "ai_conversation")
