"""Add config JSONB column to workflows.

Holds per-workflow configuration that doesn't belong on individual
steps — e.g., the LinkedIn outreach message template used by the
`open_message_drafts` step. Shape today:

    {
      "message_template": "Hi {{candidate_name}}, ...",
      "message_template_updated_at": "2026-05-27T22:00:00+00:00"
    }

Revision ID: 023
Revises: 022
Create Date: 2026-05-27
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "023"
down_revision: str | None = "022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("workflows", sa.Column("config", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("workflows", "config")
