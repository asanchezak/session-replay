"""Add linkedin_applicants JSONB column to execution_runs.

Stores the per-run snapshot of applicants pushed to Odoo: id, name,
profile_url, Easy Recruit score, recommendation, status, and the Odoo
view URL. Populated by LinkedInApplicantPushService on push and by the
POST /runs/{id}/refresh-applicants endpoint.

Revision ID: 022
Revises: 021
Create Date: 2026-05-27
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "022"
down_revision: str | None = "021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "execution_runs",
        sa.Column("linkedin_applicants", JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("execution_runs", "linkedin_applicants")
