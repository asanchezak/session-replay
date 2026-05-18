"""Observability: reasoning chains, page state snapshots, recovery traces, run summaries.

Adds:
- `ai_reasoning_chains` — full AI reasoning + sequential thinking steps per decision
- `page_state_snapshots` — structured page state at key moments (before_step, on_failure, etc.)
- `recovery_attempt_traces` — full AI failure analysis per _analyze_failure() call
- `run_summaries` — aggregate metrics per run at terminal state
- `ai_decision_outcomes.thinking_steps` — structured thinking steps on the outcome record
- `ai_decision_outcomes.reasoning_chain_id` — soft FK to ai_reasoning_chains
- `ai_decision_outcomes.decision_context` — factors that influenced the decision

Revision ID: 013
Revises: 012
Create Date: 2026-05-15
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "013"
down_revision: str | None = "012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ai_reasoning_chains",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.String(36), nullable=False),
        sa.Column("step_index", sa.Integer(), nullable=False),
        sa.Column("decision_outcome_id", sa.String(36), nullable=True),
        sa.Column("decision", sa.String(20), nullable=False),
        sa.Column("thinking_steps", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("full_reasoning", sa.Text(), nullable=True),
        sa.Column("prompt_summary", sa.Text(), nullable=True),
        sa.Column("context_snapshot", JSONB(), nullable=True),
        sa.Column("invocation_type", sa.String(30), nullable=False, server_default=sa.text("'step_decision'")),
        sa.Column("model", sa.String(64), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_ai_reasoning_chains_run_id", "ai_reasoning_chains", ["run_id"])
    op.create_index("ix_ai_reasoning_chains_run_step", "ai_reasoning_chains", ["run_id", "step_index"])

    op.create_table(
        "page_state_snapshots",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.String(36), nullable=False),
        sa.Column("step_index", sa.Integer(), nullable=False),
        sa.Column("trigger", sa.String(30), nullable=False),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("title", sa.String(500), nullable=True),
        sa.Column("visible_text_excerpt", sa.Text(), nullable=True),
        sa.Column("element_count", sa.Integer(), nullable=True),
        sa.Column("blocking_type", sa.String(30), nullable=True),
        sa.Column("is_blocking", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("visible_elements", JSONB(), nullable=True),
        sa.Column("dom_snippet_hash", sa.String(64), nullable=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_page_state_snapshots_run_id", "page_state_snapshots", ["run_id"])
    op.create_index("ix_page_state_snapshots_run_step", "page_state_snapshots", ["run_id", "step_index"])

    op.create_table(
        "recovery_attempt_traces",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.String(36), nullable=False),
        sa.Column("step_index", sa.Integer(), nullable=False),
        sa.Column("attempt_number", sa.Integer(), nullable=False),
        sa.Column("trigger", sa.String(20), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("likely_cause", sa.Text(), nullable=True),
        sa.Column("analysis_text", sa.Text(), nullable=True),
        sa.Column("suggested_action", sa.String(30), nullable=True),
        sa.Column("suggested_value", sa.Text(), nullable=True),
        sa.Column("suggested_selectors", JSONB(), nullable=True),
        sa.Column("should_retry", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("should_skip", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("outcome", sa.String(20), nullable=True),
        sa.Column("ai_invoked", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("model", sa.String(64), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_recovery_attempt_traces_run_id", "recovery_attempt_traces", ["run_id"])
    op.create_index("ix_recovery_attempt_traces_run_step", "recovery_attempt_traces", ["run_id", "step_index"])

    op.create_table(
        "run_summaries",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.String(36), nullable=False),
        sa.Column("workflow_id", sa.String(36), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("total_steps", sa.Integer(), nullable=False),
        sa.Column("steps_completed", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("steps_skipped", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("steps_healed", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("steps_failed", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("adapt_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("retry_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("pause_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("supervisor_resumes", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("ai_invocations", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("total_ai_latency_ms", sa.Integer(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.Column("error_summary", sa.Text(), nullable=True),
        sa.Column("goal_progress_final", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id", name="uq_run_summaries_run_id"),
    )
    op.create_index("ix_run_summaries_run_id", "run_summaries", ["run_id"])
    op.create_index("ix_run_summaries_workflow_id", "run_summaries", ["workflow_id"])

    # Extend ai_decision_outcomes with observability columns
    op.add_column("ai_decision_outcomes", sa.Column("thinking_steps", JSONB(), nullable=True))
    op.add_column("ai_decision_outcomes", sa.Column("reasoning_chain_id", sa.String(36), nullable=True))
    op.add_column("ai_decision_outcomes", sa.Column("decision_context", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("ai_decision_outcomes", "decision_context")
    op.drop_column("ai_decision_outcomes", "reasoning_chain_id")
    op.drop_column("ai_decision_outcomes", "thinking_steps")

    op.drop_index("ix_run_summaries_workflow_id", "run_summaries")
    op.drop_index("ix_run_summaries_run_id", "run_summaries")
    op.drop_table("run_summaries")

    op.drop_index("ix_recovery_attempt_traces_run_step", "recovery_attempt_traces")
    op.drop_index("ix_recovery_attempt_traces_run_id", "recovery_attempt_traces")
    op.drop_table("recovery_attempt_traces")

    op.drop_index("ix_page_state_snapshots_run_step", "page_state_snapshots")
    op.drop_index("ix_page_state_snapshots_run_id", "page_state_snapshots")
    op.drop_table("page_state_snapshots")

    op.drop_index("ix_ai_reasoning_chains_run_step", "ai_reasoning_chains")
    op.drop_index("ix_ai_reasoning_chains_run_id", "ai_reasoning_chains")
    op.drop_table("ai_reasoning_chains")
