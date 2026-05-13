"""create artifacts table

Revision ID: 009
Revises: 008
Create Date: 2026-05-13
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "009"
down_revision: str | None = "008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "artifacts",
        sa.Column(
            "id", UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("run_id", sa.String(36), nullable=False, index=True),
        sa.Column("step_index", sa.Integer, nullable=True),
        sa.Column("artifact_type", sa.String(20), nullable=False),
        sa.Column("file_path", sa.String(500), nullable=False),
        sa.Column("mime_type", sa.String(100), nullable=False),
        sa.Column("file_size", sa.Integer, nullable=False, server_default=sa.text("0")),
        sa.Column("metadata", JSONB, nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=True,
        ),
    )

    op.create_index("ix_artifacts_run_id_created", "artifacts", ["run_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_artifacts_run_id_created", table_name="artifacts")
    op.drop_table("artifacts")
