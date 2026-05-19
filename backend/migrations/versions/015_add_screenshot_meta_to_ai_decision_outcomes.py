"""Add lightweight screenshot metadata to ai_decision_outcomes.

Vision (Workstream B) forwards a base64 JPEG of the viewport to the LLM on
selected polls. The bytes are discarded after the request returns; only a
small JSONB blob (sha256, width, height, mime, byte_size, trigger, detail)
is persisted so the audit trail can prove "the AI did see an image at this
decision" without storing pixels.

Revision ID: 015
Revises: 014
Create Date: 2026-05-19
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "015"
down_revision: str | None = "014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "ai_decision_outcomes",
        sa.Column("screenshot_meta", JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("ai_decision_outcomes", "screenshot_meta")
