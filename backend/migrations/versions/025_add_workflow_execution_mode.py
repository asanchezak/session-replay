"""Add execution_mode column to workflows.

Per-workflow daemon execution mode:
  - "hardcoded": a bespoke daemon flow (the lead/applicant steps-0-5 preamble)
  - "generic":   the plan-interpreter drives the recorded steps

Existing rows backfill to "hardcoded" (server_default) so current production
behavior is unchanged; new ORM-inserted workflows default to "generic" (the
model default). Surfaced as a dashboard badge and threaded into run.origin so
the daemon decides per run.

Revision ID: 025
Revises: 024
Create Date: 2026-06-02
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "025"
down_revision: str | None = "024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "workflows",
        sa.Column(
            "execution_mode",
            sa.String(length=20),
            nullable=False,
            server_default="hardcoded",
        ),
    )


def downgrade() -> None:
    op.drop_column("workflows", "execution_mode")
