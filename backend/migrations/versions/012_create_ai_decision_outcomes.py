"""Phase 4 + 5: telemetry & learning columns.

Adds:
- `ai_decision_outcomes` — per-decision telemetry (decision, confidence, outcome, latency, model)
- `workflow_steps.selector_stability_score` + `heal_count` — Phase 5 selector learning
- `workflow_parameters.validation_count` + `success_count` + `last_validated_at` — Phase 5 parameter learning
- `execution_runs.goal_progress` — Phase 6 goal-first cursor (added now for forward-compat)

Revision ID: 012
Revises: 011
Create Date: 2026-05-14
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "012"
down_revision: str | None = "011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ai_decision_outcomes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.String(36), nullable=False),
        sa.Column("step_index", sa.Integer(), nullable=False),
        sa.Column("decision", sa.String(20), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("actual_outcome", sa.String(20), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("model", sa.String(64), nullable=True),
        sa.Column("prompt_hash", sa.String(64), nullable=True),
        sa.Column("reasoning", sa.Text(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_ai_decision_outcomes_run_id", "ai_decision_outcomes", ["run_id"])

    # Phase 5: learning columns on existing tables
    op.add_column("workflow_steps", sa.Column("selector_stability_score", sa.Float(), nullable=True))
    op.add_column("workflow_steps", sa.Column("heal_count", sa.Integer(), nullable=False, server_default=sa.text("0")))
    op.add_column("workflow_parameters", sa.Column("validation_count", sa.Integer(), nullable=False, server_default=sa.text("0")))
    op.add_column("workflow_parameters", sa.Column("success_count", sa.Integer(), nullable=False, server_default=sa.text("0")))
    op.add_column("workflow_parameters", sa.Column("last_validated_at", sa.DateTime(timezone=True), nullable=True))

    # Phase 6 forward-compat: goal_progress is the new cursor structure.
    # Added as nullable so old runs keep working without it.
    op.add_column("execution_runs", sa.Column("goal_progress", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("execution_runs", "goal_progress")
    op.drop_column("workflow_parameters", "last_validated_at")
    op.drop_column("workflow_parameters", "success_count")
    op.drop_column("workflow_parameters", "validation_count")
    op.drop_column("workflow_steps", "heal_count")
    op.drop_column("workflow_steps", "selector_stability_score")
    op.drop_index("ix_ai_decision_outcomes_run_id", "ai_decision_outcomes")
    op.drop_table("ai_decision_outcomes")
