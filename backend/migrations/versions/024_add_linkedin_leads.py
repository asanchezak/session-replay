"""Add linkedin_leads JSONB column to execution_runs.

Stores the per-run snapshot of leads pushed to Odoo for the lightweight
lead-sourcing flow (origin.event_kind == "linkedin_lead_search"): id, name,
headline, profile_url, status, and the Odoo view URL. Populated by
LinkedInLeadPushService on push.

Revision ID: 024
Revises: 023
Create Date: 2026-05-29
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "024"
down_revision: str | None = "023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "execution_runs",
        sa.Column("linkedin_leads", JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("execution_runs", "linkedin_leads")
